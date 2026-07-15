#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  activateOwnedChildLease,
  assertDistProcessTreeAuthority,
  isOwnedChildLeaseActive,
  isOwnedLockActive,
  isProcessAlive,
  isProcessGroupAlive,
  prepareOwnedChildLease,
  recoverStaleOwnedLock,
  releaseOwnedChildLease,
  releaseOwnedLock,
  resolveDistLockConfig,
  tryCreateOwnedLock,
} from './dist-lock.js';

const cwd = process.cwd();
const { lockRoot, buildLock, readerPrefix, timeoutMs } = resolveDistLockConfig(cwd);
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
const lockProbe = process.argv.includes('--lock-probe');
const childLockProbe = process.argv.includes('--child-lock-probe');
const childIdentityFailureProbe = process.argv.includes('--child-identity-failure-probe');
let activeBuildChild = null;
let shutdownExitCode = 0;
let shutdownKillTimer;

function sleep(ms) {
  Atomics.wait(waitBuffer, 0, 0, ms);
}

function activeReaderLocks() {
  const active = [];
  for (const name of readdirSync(lockRoot)) {
    if (!name.startsWith(readerPrefix)) continue;
    if (!/^\d+-\d+$/.test(name.slice(readerPrefix.length))) continue;
    const path = join(lockRoot, name);
    if (isOwnedLockActive(path)) {
      active.push(path);
      continue;
    }
    if (!recoverStaleOwnedLock(path) && existsSync(path)) active.push(path);
  }
  return active;
}

function signalBuildChild(signal) {
  if (!activeBuildChild) return;
  try {
    if (process.platform !== 'win32' && activeBuildChild.pid) process.kill(-activeBuildChild.pid, signal);
    else activeBuildChild.kill(signal);
  } catch {
    try {
      activeBuildChild.kill(signal);
    } catch {
      // Child already exited.
    }
  }
}

async function drainBuildChildGroup(token, requireActiveLease = true) {
  if (!activeBuildChild?.pid) return true;
  const childGroupIsAlive = () => process.platform === 'win32'
    ? isProcessAlive(activeBuildChild.pid)
    : isProcessGroupAlive(activeBuildChild.pid);
  if (requireActiveLease && !isOwnedChildLeaseActive(buildLock, token)) return true;
  signalBuildChild('SIGTERM');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!childGroupIsAlive()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  signalBuildChild('SIGKILL');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!childGroupIsAlive()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  return false;
}

function requestShutdown(signal, exitCode) {
  if (shutdownExitCode) return;
  shutdownExitCode = exitCode;
  signalBuildChild(signal);
  shutdownKillTimer = setTimeout(() => signalBuildChild('SIGKILL'), 1_000);
  shutdownKillTimer.unref();
}

process.on('SIGINT', () => requestShutdown('SIGINT', 130));
process.on('SIGTERM', () => requestShutdown('SIGTERM', 143));

function acquireBuildLock(token) {
  const deadline = Date.now() + timeoutMs;
  let waitingLogged = false;
  while (true) {
    if (shutdownExitCode) throw new Error('build_interrupted');
    if (tryCreateOwnedLock(buildLock, {
      pid: process.pid,
      token,
      started_at: new Date().toISOString(),
    })) return;
    if (recoverStaleOwnedLock(buildLock)) continue;
    if (Date.now() >= deadline) throw new Error(`dist_build_lock_timeout:writer:${buildLock}`);
    if (!waitingLogged) {
      console.error('[build] waiting for another build');
      waitingLogged = true;
    }
    sleep(100);
  }
}

function waitForReaders() {
  const deadline = Date.now() + timeoutMs;
  let waitingLogged = false;
  while (true) {
    if (shutdownExitCode) throw new Error('build_interrupted');
    const readers = activeReaderLocks();
    if (readers.length === 0) return;
    if (Date.now() >= deadline) throw new Error(`dist_build_lock_timeout:readers=${readers.length}:${lockRoot}`);
    if (!waitingLogged) {
      console.error(`[build] waiting for ${readers.length} compiled test reader(s)`);
      waitingLogged = true;
    }
    sleep(100);
  }
}

async function runBuildChild(token) {
  const leasePath = prepareOwnedChildLease(buildLock, token);
  const leaseModule = pathToFileURL(join(cwd, 'src', 'scripts', 'dist-lock-child-lease.js')).href;
  const childArgs = childLockProbe || childIdentityFailureProbe
    ? ['--import', leaseModule, '--eval', `setTimeout(() => {}, ${Number(process.env.OMX_DIST_LOCK_CHILD_PROBE_MS) || 5_000})`]
    : ['--import', leaseModule, join(cwd, 'node_modules', 'typescript', 'bin', 'tsc')];

  try {
    const child = spawn(process.execPath, childArgs, {
      cwd,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        OMX_DIST_CHILD_LEASE: leasePath,
        OMX_DIST_CHILD_LEASE_TOKEN: token,
      },
    });
    activeBuildChild = child;
    if (!child.pid) throw new Error('dist_build_child_pid_missing');
    if (childIdentityFailureProbe) console.error(`[build] child-identity-failure-probe pid=${child.pid}`);
    try {
      activateOwnedChildLease(
        buildLock,
        token,
        child.pid,
        process.platform === 'win32' ? 0 : child.pid,
        childIdentityFailureProbe ? () => null : undefined,
      );
    } catch (error) {
      if (!(await drainBuildChildGroup(token, false))) throw new Error('dist_build_child_group_live');
      releaseOwnedChildLease(buildLock, token);
      throw error;
    }
    const result = await new Promise((resolveRun, rejectRun) => {
      child.on('error', rejectRun);
      child.on('exit', (status, signal) => resolveRun({ status, signal }));
    });
    if (shutdownKillTimer) clearTimeout(shutdownKillTimer);
    if (!(await drainBuildChildGroup(token))) throw new Error('dist_build_child_group_live');
    if (shutdownExitCode) throw new Error('build_interrupted');
    if (result.status !== 0) {
      throw new Error(`typescript_build_failed:status=${result.status ?? 'unknown'}:signal=${result.signal ?? 'none'}`);
    }
  } finally {
    activeBuildChild = null;
    if (!isOwnedChildLeaseActive(buildLock, token)) releaseOwnedChildLease(buildLock, token);
  }
}

async function main() {
  assertDistProcessTreeAuthority();
  mkdirSync(lockRoot, { recursive: true });
  const inheritedReaderLock = process.env.OMX_DIST_READER_LOCK?.trim();
  if (inheritedReaderLock && existsSync(inheritedReaderLock)) {
    throw new Error(`dist_build_reentrant_reader_lock:${inheritedReaderLock}`);
  }

  const token = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  acquireBuildLock(token);
  try {
    waitForReaders();
    if (lockProbe) return;

    if (!childLockProbe && !childIdentityFailureProbe) rmSync(join(cwd, 'dist'), { recursive: true, force: true });
    await runBuildChild(token);
    if (childLockProbe || childIdentityFailureProbe) return;
    chmodSync(join(cwd, 'dist', 'cli', 'omx.js'), 0o755);
  } finally {
    releaseOwnedLock(buildLock, token);
  }
}

try {
  await main();
} catch (error) {
  if (!shutdownExitCode) console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = shutdownExitCode || 2;
}
