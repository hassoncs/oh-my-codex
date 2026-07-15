import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const RECOVERY_ELECTION_DELAY_MS = 10;
const RECOVERY_CANDIDATE_MAX_MS = 5_000;
const recoveryWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleep(ms) {
  Atomics.wait(recoveryWaitBuffer, 0, 0, ms);
}

export function parsePositiveMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveDistLockConfig(cwd, env = process.env) {
  const lockRootValue = env.OMX_DIST_LOCK_ROOT?.trim();
  const lockRoot = lockRootValue
    ? (isAbsolute(lockRootValue) ? lockRootValue : resolve(cwd, lockRootValue))
    : join(cwd, '.omx', 'test-locks');
  return {
    lockRoot,
    buildLock: join(lockRoot, 'dist-build.lock'),
    readerPrefix: 'dist-reader-',
    timeoutMs: parsePositiveMs(env.OMX_DIST_LOCK_TIMEOUT_MS, 5 * 60_000),
  };
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processStartIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = process.platform === 'win32'
    ? spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`],
        { encoding: 'utf-8', timeout: 1_000, windowsHide: true },
      )
    : spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 1_000,
      });
  const identity = result.status === 0 ? result.stdout.trim() : '';
  return identity || null;
}

function observedProcessGroupId(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {
    encoding: 'utf-8',
    timeout: 1_000,
  });
  const value = result.status === 0 ? Number(result.stdout.trim()) : 0;
  return Number.isInteger(value) && value > 0 ? value : null;
}

const CURRENT_PROCESS_START_IDENTITY = processStartIdentity(process.pid);

function recordedProcessIsAlive(owner, path, legacyMaxAgeMs) {
  const pid = Number.isInteger(owner?.pid) ? owner.pid : 0;
  if (pid <= 0) return isFreshUnownedPath(path, legacyMaxAgeMs);
  if (!isProcessAlive(pid)) return false;
  const recordedIdentity = typeof owner?.process_start_identity === 'string'
    ? owner.process_start_identity
    : '';
  if (!recordedIdentity) return isFreshUnownedPath(path, legacyMaxAgeMs);
  return processStartIdentity(pid) === recordedIdentity;
}

export function assertDistProcessTreeAuthority(
  platform = process.platform,
  processStartIdentity = CURRENT_PROCESS_START_IDENTITY,
) {
  if (platform === 'win32') throw new Error('dist_process_tree_authority_unsupported:win32');
  if (!processStartIdentity) {
    throw new Error(`dist_process_identity_unavailable:${platform}`);
  }
}

export function isProcessGroupAlive(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) return false;
  if (process.platform === 'win32') return isProcessAlive(processGroupId);
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function processGroupMembers(processGroupId) {
  if (!Number.isInteger(processGroupId) || processGroupId <= 0 || process.platform === 'win32') return null;
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    detached: true,
    encoding: 'utf-8',
    timeout: 1_000,
  });
  if (result.status !== 0) return null;
  return result.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, pgid]) => Number.isInteger(pid) && pid > 0 && pgid === processGroupId)
    .map(([pid]) => pid);
}

function readOwner(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8'));
  } catch {
    return null;
  }
}

function safeLeaseToken(token) {
  return token.replace(/[^A-Za-z0-9._-]/g, '_');
}

export function ownedChildLeasePath(lockPath, token) {
  return `${lockPath}.child.${safeLeaseToken(token)}`;
}

export function prepareOwnedChildLease(lockPath, token) {
  const leasePath = ownedChildLeasePath(lockPath, token);
  writeFileSync(leasePath, JSON.stringify({
    pid: 0,
    token,
    created_at: new Date().toISOString(),
  }), { flag: 'wx', mode: 0o600 });
  return leasePath;
}

export function activateOwnedChildLease(
  lockPath,
  token,
  pid,
  processGroupId = 0,
  observeProcessStartIdentity = processStartIdentity,
) {
  const leasePath = ownedChildLeasePath(lockPath, token);
  const current = readOwner(leasePath);
  if (current?.token !== token) throw new Error(`dist_child_lease_token_mismatch:${leasePath}`);
  const childStartIdentity = observeProcessStartIdentity(pid)?.trim();
  if (!childStartIdentity) throw new Error(`dist_child_process_identity_unavailable:${pid}`);
  writeFileSync(leasePath, JSON.stringify({
    pid,
    ...(processGroupId > 0 ? { process_group_id: processGroupId } : {}),
    process_start_identity: childStartIdentity,
    token,
    started_at: new Date().toISOString(),
  }), { mode: 0o600 });
  return leasePath;
}

export function registerOwnedChildLeaseSentinel(leasePath, token, pid) {
  const current = readOwner(leasePath);
  if (current?.token !== token) throw new Error(`dist_child_lease_token_mismatch:${leasePath}`);
  const processGroupIdValue = Number.isInteger(current?.process_group_id)
    ? current.process_group_id
    : 0;
  const sentinelStartIdentity = processStartIdentity(pid);
  if (!sentinelStartIdentity) throw new Error(`dist_child_sentinel_identity_unavailable:${pid}`);
  if (observedProcessGroupId(pid) !== processGroupIdValue) {
    throw new Error(`dist_child_sentinel_group_mismatch:${pid}:${processGroupIdValue}`);
  }
  writeFileSync(leasePath, JSON.stringify({
    ...current,
    sentinel_pid: pid,
    sentinel_start_identity: sentinelStartIdentity,
    sentinel_registered_at: new Date().toISOString(),
  }), { mode: 0o600 });
}

export function releaseOwnedChildLease(lockPath, token) {
  rmSync(ownedChildLeasePath(lockPath, token), { force: true });
}

function isFreshUnownedPath(path, unownedStaleMs) {
  try {
    return Date.now() - statSync(path).mtimeMs <= unownedStaleMs;
  } catch {
    return false;
  }
}

function isChildLeaseLive(lockPath, token, unownedStaleMs) {
  const leasePath = ownedChildLeasePath(lockPath, token);
  if (!existsSync(leasePath)) return false;
  const lease = readOwner(leasePath);
  const leasePid = Number.isInteger(lease?.pid) ? lease.pid : 0;
  const processGroupId = Number.isInteger(lease?.process_group_id) ? lease.process_group_id : 0;
  const recordedIdentity = typeof lease?.process_start_identity === 'string'
    ? lease.process_start_identity
    : '';
  if (!recordedIdentity) return false;
  if (processGroupId > 0) {
    if (!isProcessGroupAlive(processGroupId)) return false;
    const currentLeaderIdentity = processStartIdentity(processGroupId);
    if (currentLeaderIdentity) return currentLeaderIdentity === recordedIdentity;
    const sentinelPid = Number.isInteger(lease?.sentinel_pid) ? lease.sentinel_pid : 0;
    const sentinelIdentity = typeof lease?.sentinel_start_identity === 'string'
      ? lease.sentinel_start_identity
      : '';
    return sentinelPid > 0
      && Boolean(sentinelIdentity)
      && processStartIdentity(sentinelPid) === sentinelIdentity
      && observedProcessGroupId(sentinelPid) === processGroupId;
  }
  if (leasePid <= 0) return false;
  return recordedProcessIsAlive(lease, leasePath, unownedStaleMs);
}

export function isOwnedChildLeaseActive(lockPath, token, unownedStaleMs = 60_000) {
  return isChildLeaseLive(lockPath, token, unownedStaleMs);
}

export function isOwnedLockActive(lockPath, unownedStaleMs = 60_000) {
  if (!existsSync(lockPath)) return false;
  const owner = readOwner(lockPath);
  if (recordedProcessIsAlive(owner, lockPath, unownedStaleMs)) return true;
  const token = typeof owner?.token === 'string' ? owner.token : '';
  if (token && isChildLeaseLive(lockPath, token, unownedStaleMs)) return true;
  return false;
}

export function tryCreateOwnedLock(lockPath, owner) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const candidatePath = `${lockPath}.candidate.${process.pid}.${randomUUID()}`;
  const recordedOwner = {
    ...owner,
    ...(owner?.pid === process.pid && CURRENT_PROCESS_START_IDENTITY
      ? { process_start_identity: CURRENT_PROCESS_START_IDENTITY }
      : {}),
  };
  writeFileSync(candidatePath, JSON.stringify(recordedOwner), { mode: 0o600 });
  try {
    linkSync(candidatePath, lockPath);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    rmSync(candidatePath, { force: true });
  }
}

export function releaseOwnedLock(lockPath, token) {
  const owner = readOwner(lockPath);
  if (owner?.token !== token) return false;
  if (isOwnedChildLeaseActive(lockPath, token)) return false;
  rmSync(lockPath, { force: true });
  releaseOwnedChildLease(lockPath, token);
  return true;
}

export function recoverStaleOwnedLock(lockPath, unownedStaleMs = 60_000) {
  const recoveryDir = `${lockPath}.recovery`;
  const candidateName = `candidate-${process.hrtime.bigint().toString().padStart(20, '0')}-${process.pid}-${randomUUID()}`;
  const candidatePath = join(recoveryDir, candidateName);
  mkdirSync(recoveryDir, { recursive: true });
  writeFileSync(candidatePath, JSON.stringify({
    pid: process.pid,
    ...(CURRENT_PROCESS_START_IDENTITY ? { process_start_identity: CURRENT_PROCESS_START_IDENTITY } : {}),
    created_at: new Date().toISOString(),
  }), { flag: 'wx', mode: 0o600 });

  try {
    sleep(RECOVERY_ELECTION_DELAY_MS);
    const activeCandidates = [];
    for (const name of readdirSync(recoveryDir)) {
      if (!name.startsWith('candidate-')) continue;
      const path = join(recoveryDir, name);
      const owner = readOwner(path);
      const staleCandidate = !recordedProcessIsAlive(owner, path, RECOVERY_CANDIDATE_MAX_MS);
      if (staleCandidate) rmSync(path, { force: true });
      else activeCandidates.push(name);
    }
    activeCandidates.sort();
    if (activeCandidates[0] !== candidateName) return false;

    if (!existsSync(lockPath)) return true;
    const owner = readOwner(lockPath);
    if (isOwnedLockActive(lockPath, unownedStaleMs)) return false;
    rmSync(lockPath, { force: true });
    if (typeof owner?.token === 'string') releaseOwnedChildLease(lockPath, owner.token);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  } finally {
    rmSync(candidatePath, { force: true });
  }
}
