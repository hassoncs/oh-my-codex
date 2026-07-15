import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

const {
  activateOwnedChildLease,
  assertDistProcessTreeAuthority,
  isOwnedChildLeaseActive,
  isOwnedLockActive,
  isProcessGroupAlive,
  prepareOwnedChildLease,
  releaseOwnedChildLease,
} = await import(
  pathToFileURL(join(process.cwd(), 'src', 'scripts', 'dist-lock.js')).href
);
const buildScript = join(process.cwd(), 'src', 'scripts', 'build.js');
const childLeaseModule = pathToFileURL(join(process.cwd(), 'src', 'scripts', 'dist-lock-child-lease.js')).href;
const compiledRunner = join(process.cwd(), 'dist', 'scripts', 'run-test-files.js');
const fastTest = join(process.cwd(), 'dist', 'runtime', '__tests__', 'run-outcome.test.js');

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentProcessStartIdentity(): string {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf-8', timeout: 1_000, windowsHide: true })
    : spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf-8', timeout: 1_000 });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim());
  return result.stdout.trim();
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error('timed out waiting for dist lock probe state');
}

async function waitForChildLease(lockRoot: string, prefix: string): Promise<{ path: string; pid: number }> {
  return waitFor(async () => {
    for (const name of await readdir(lockRoot)) {
      if (!name.startsWith(prefix) || !name.includes('.child.')) continue;
      const path = join(lockRoot, name);
      try {
        const lease = JSON.parse(await readFile(path, 'utf-8')) as { pid?: unknown };
        const pid = typeof lease.pid === 'number' ? lease.pid : 0;
        if (pid > 0 && isProcessAlive(pid)) return { path, pid };
      } catch {
        // Lease bootstrap may be replacing the pre-created record.
      }
    }
    return undefined;
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
}

async function waitForExitResult(
  child: ReturnType<typeof spawn>,
  timeoutMs = 3_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit, rejectTimeout) => {
    const timer = setTimeout(
      () => rejectTimeout(new Error('timed out waiting for runner signal exit')),
      timeoutMs,
    );
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolveExit({ status, signal });
    });
  });
}

async function killProcessGroup(pid: number): Promise<void> {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL');
  } catch {
    // Process may have completed before cleanup.
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
}

function runBuildProbe(lockRoot: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [buildScript, '--lock-probe'], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      OMX_DIST_LOCK_ROOT: lockRoot,
      OMX_DIST_LOCK_TIMEOUT_MS: '200',
      OMX_DIST_READER_LOCK: '',
      ...env,
    },
  });
}

async function runBuildProbeAsync(lockRoot: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [buildScript, '--lock-probe'], {
      stdio: 'ignore',
      env: {
        ...process.env,
        OMX_DIST_LOCK_ROOT: lockRoot,
        OMX_DIST_LOCK_TIMEOUT_MS: '2000',
        OMX_DIST_READER_LOCK: '',
      },
    });
    child.on('error', rejectRun);
    child.on('exit', (status, signal) => {
      if (status === 0) resolveRun();
      else rejectRun(new Error(`build probe exited status=${status ?? 'null'} signal=${signal ?? 'none'}`));
    });
  });
}

describe('compiled dist reader/writer lock', () => {
  it('fails loud when process-tree authority is unavailable', () => {
    assert.throws(
      () => assertDistProcessTreeAuthority('win32'),
      /dist_process_tree_authority_unsupported:win32/,
    );
    assert.throws(
      () => assertDistProcessTreeAuthority(process.platform, null),
      /dist_process_identity_unavailable/,
    );
    if (process.platform !== 'win32') assert.doesNotThrow(() => assertDistProcessTreeAuthority());
  });

  it('kills the child and releases authority when child identity is unavailable', { skip: process.platform === 'win32' }, async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-child-identity-'));
    try {
      const result = spawnSync(process.execPath, [buildScript, '--child-identity-failure-probe'], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '2000',
          OMX_DIST_LOCK_CHILD_PROBE_MS: '5000',
          OMX_DIST_READER_LOCK: '',
        },
      });
      const childPid = Number(result.stderr.match(/child-identity-failure-probe pid=(\d+)/)?.[1] ?? 0);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /dist_child_process_identity_unavailable/);
      assert.ok(childPid > 0);
      assert.equal(isProcessAlive(childPid), false);
      assert.deepEqual(await readdir(lockRoot), []);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('rejects a live reused process group without recorded child identity', { skip: process.platform === 'win32' }, async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-reused-child-group-'));
    const lockPath = join(lockRoot, 'dist-build.lock');
    const token = 'missing-child-identity';
    const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 5000)'], {
      detached: true,
      stdio: 'ignore',
    });
    try {
      assert.ok(child.pid);
      const leasePath = prepareOwnedChildLease(lockPath, token);
      assert.throws(
        () => activateOwnedChildLease(lockPath, token, process.pid + 1_000_000, child.pid, () => null),
        /dist_child_process_identity_unavailable/,
      );
      assert.equal(isOwnedChildLeaseActive(lockPath, token), false);

      await writeFile(leasePath, JSON.stringify({
        pid: child.pid,
        process_group_id: child.pid,
        token,
        started_at: new Date().toISOString(),
      }));
      assert.equal(isOwnedChildLeaseActive(lockPath, token), false);
    } finally {
      if (child.pid) await killProcessGroup(child.pid);
      releaseOwnedChildLease(lockPath, token);
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('keeps orphan group authority through a matching sentinel and rejects an unrelated orphan group', { skip: process.platform === 'win32' }, async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-orphan-sentinel-'));
    const lockPath = join(lockRoot, 'dist-build.lock');
    const leasePath = prepareOwnedChildLease(lockPath, 'orphan-sentinel');
    const descendantReady = join(lockRoot, 'descendant-ready');
    const unrelatedReady = join(lockRoot, 'unrelated-ready');
    let leader: ReturnType<typeof spawn> | undefined;
    let unrelatedLeader: ReturnType<typeof spawn> | undefined;
    try {
      leader = spawn(process.execPath, [
        '--import',
        childLeaseModule,
        '--eval',
        "const { spawn } = await import('node:child_process'); const { writeFileSync } = await import('node:fs'); const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' }); writeFileSync(process.env.DIST_DESCENDANT_READY, String(child.pid)); child.unref();",
      ], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          OMX_DIST_CHILD_LEASE: leasePath,
          OMX_DIST_CHILD_LEASE_TOKEN: 'orphan-sentinel',
          DIST_DESCENDANT_READY: descendantReady,
        },
      });
      assert.ok(leader.pid);
      activateOwnedChildLease(lockPath, 'orphan-sentinel', leader.pid, leader.pid);
      await waitFor(async () => (existsSync(descendantReady) ? true : undefined));
      await waitForExit(leader);
      const originalLease = JSON.parse(await readFile(leasePath, 'utf-8'));

      assert.equal(isProcessGroupAlive(leader.pid), true);
      assert.equal(isOwnedChildLeaseActive(lockPath, 'orphan-sentinel'), true);

      await waitFor(
        async () => (isOwnedChildLeaseActive(lockPath, 'orphan-sentinel') ? undefined : true),
        5_000,
      );
      assert.equal(isProcessGroupAlive(leader.pid), false);

      unrelatedLeader = spawn(process.execPath, [
        '--eval',
        "const { spawn } = await import('node:child_process'); const { writeFileSync } = await import('node:fs'); const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 1500)'], { stdio: 'ignore' }); writeFileSync(process.env.DIST_DESCENDANT_READY, String(child.pid)); child.unref();",
      ], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          DIST_DESCENDANT_READY: unrelatedReady,
        },
      });
      assert.ok(unrelatedLeader.pid);
      await waitFor(async () => (existsSync(unrelatedReady) ? true : undefined));
      await waitForExit(unrelatedLeader);
      await writeFile(leasePath, JSON.stringify({
        ...originalLease,
        pid: unrelatedLeader.pid,
        process_group_id: unrelatedLeader.pid,
      }));

      assert.equal(isProcessGroupAlive(unrelatedLeader.pid), true);
      assert.equal(isOwnedChildLeaseActive(lockPath, 'orphan-sentinel'), false);
    } finally {
      if (leader?.pid) await killProcessGroup(leader.pid);
      if (unrelatedLeader?.pid) await killProcessGroup(unrelatedLeader.pid);
      releaseOwnedChildLease(lockPath, 'orphan-sentinel');
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('fails loud instead of deadlocking on a child build under a reader', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-reentrant-'));
    try {
      const readerLock = join(lockRoot, `dist-reader-${process.pid}-reentrant`);
      await writeFile(readerLock, '{}');
      const result = runBuildProbe(lockRoot, { OMX_DIST_READER_LOCK: readerLock });

      assert.equal(result.status, 2);
      assert.match(result.stderr, /dist_build_reentrant_reader_lock/);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('bounds writer waits while a live compiled reader remains', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-reader-wait-'));
    try {
      await writeFile(
        join(lockRoot, `dist-reader-${process.pid}-${Date.now()}`),
        JSON.stringify({ pid: process.pid, token: 'live-reader' }),
      );
      const result = runBuildProbe(lockRoot);

      assert.equal(result.status, 2);
      assert.match(result.stderr, /dist_build_lock_timeout:readers=1/);
      assert.equal(existsSync(join(lockRoot, 'dist-build.lock')), false);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('reaps a dead compiled reader before acquiring the writer lock', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-stale-reader-'));
    try {
      const staleReader = join(lockRoot, `dist-reader-${process.pid + 1_000_000}-${Date.now()}`);
      await writeFile(staleReader, JSON.stringify({ pid: process.pid + 1_000_000, token: 'stale-reader' }));
      const result = runBuildProbe(lockRoot);

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(staleReader), false);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('recovers a dead writer but times out on a live writer', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-writer-'));
    const buildLock = join(lockRoot, 'dist-build.lock');
    try {
      await writeFile(buildLock, JSON.stringify({ pid: process.pid + 1_000_000, token: 'stale' }));
      const recovered = spawnSync(process.execPath, [compiledRunner, fastTest], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '500',
          OMX_DIST_READER_LOCK: '',
        },
      });
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);

      await writeFile(buildLock, JSON.stringify({
        pid: process.pid,
        process_start_identity: 'reused-process',
        token: 'reused-writer',
      }));
      const reused = spawnSync(process.execPath, [compiledRunner, fastTest], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '500',
          OMX_DIST_READER_LOCK: '',
        },
      });
      assert.equal(reused.status, 0, reused.stderr || reused.stdout);

      await writeFile(buildLock, JSON.stringify({ pid: process.pid, token: 'live' }));
      const blocked = spawnSync(process.execPath, [compiledRunner, fastTest], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '200',
          OMX_DIST_READER_LOCK: '',
        },
      });
      assert.equal(blocked.status, 2);
      assert.match(blocked.stderr, /dist_reader_lock_timeout/);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('serializes concurrent stale-writer recovery without deleting the replacement', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-two-reapers-'));
    const buildLock = join(lockRoot, 'dist-build.lock');
    const recoveryDir = `${buildLock}.recovery`;
    try {
      await writeFile(
        buildLock,
        JSON.stringify({ pid: process.pid + 1_000_000, token: 'stale' }),
      );
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(
        join(recoveryDir, 'candidate-00000000000000000000-stale'),
        JSON.stringify({ pid: process.pid, process_start_identity: 'reused-process' }),
      );
      const agedCandidate = join(recoveryDir, 'candidate-00000000000000000001-aged');
      await writeFile(agedCandidate, JSON.stringify({ pid: process.pid }));
      const agedAt = new Date(Date.now() - 10_000);
      await utimes(agedCandidate, agedAt, agedAt);
      await Promise.all([runBuildProbeAsync(lockRoot), runBuildProbeAsync(lockRoot)]);
      assert.equal(existsSync(buildLock), false);
      assert.deepEqual(await readdir(recoveryDir), []);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('does not evict an aged identity-verified live recovery candidate', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-live-reaper-'));
    const buildLock = join(lockRoot, 'dist-build.lock');
    const recoveryDir = `${buildLock}.recovery`;
    const liveCandidate = join(recoveryDir, 'candidate-00000000000000000000-live');
    try {
      await writeFile(buildLock, JSON.stringify({ pid: process.pid + 1_000_000, token: 'stale' }));
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(liveCandidate, JSON.stringify({
        pid: process.pid,
        process_start_identity: currentProcessStartIdentity(),
      }));
      const agedAt = new Date(Date.now() - 10_000);
      await utimes(liveCandidate, agedAt, agedAt);

      const probe = runBuildProbeAsync(lockRoot);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(existsSync(liveCandidate), true);
      await rm(liveCandidate, { force: true });
      await probe;
      assert.equal(existsSync(buildLock), false);
    } finally {
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('keeps a writer lock authoritative after its wrapper dies while the compiler group lives', { skip: process.platform === 'win32' }, async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-orphan-writer-'));
    let wrapper: ReturnType<typeof spawn> | undefined;
    let compilerPid = 0;
    try {
      wrapper = spawn(process.execPath, [buildScript, '--child-lock-probe'], {
        stdio: 'ignore',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '2000',
          OMX_DIST_LOCK_CHILD_PROBE_MS: '1000',
          OMX_DIST_READER_LOCK: '',
        },
      });
      compilerPid = (await waitForChildLease(lockRoot, 'dist-build.lock.child.')).pid;
      wrapper.kill('SIGKILL');
      await waitForExit(wrapper);

      const blocked = spawnSync(process.execPath, [compiledRunner, fastTest], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '200',
          OMX_DIST_READER_LOCK: '',
        },
      });
      assert.equal(blocked.status, 2);
      assert.match(blocked.stderr, /dist_reader_lock_timeout/);

      await waitFor(async () => (isProcessAlive(compilerPid) ? undefined : true), 5_000);
      compilerPid = 0;
      const recovered = spawnSync(process.execPath, [compiledRunner, fastTest], {
        encoding: 'utf-8',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '1000',
          OMX_DIST_READER_LOCK: '',
        },
      });
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    } finally {
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      if (compilerPid) await killProcessGroup(compilerPid);
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('keeps a reader lock authoritative after its wrapper dies while the test group lives', { skip: process.platform === 'win32' }, async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-orphan-reader-'));
    const longTest = join(lockRoot, 'long-lived.test.js');
    const childReady = join(lockRoot, 'test-child-ready');
    let wrapper: ReturnType<typeof spawn> | undefined;
    let testPid = 0;
    try {
      await writeFile(
        longTest,
        "import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport test from 'node:test';\ntest('hold', async () => {\n  spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 1200)'], { stdio: 'ignore' });\n  writeFileSync(process.env.DIST_TEST_CHILD_READY, 'ready');\n  await new Promise((resolve) => setTimeout(resolve, 1200));\n});\n",
      );
      wrapper = spawn(process.execPath, [compiledRunner, longTest], {
        stdio: 'ignore',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '2000',
          OMX_DIST_READER_LOCK: '',
          DIST_TEST_CHILD_READY: childReady,
        },
      });
      const lease = await waitForChildLease(lockRoot, 'dist-reader-');
      await waitFor(async () => (existsSync(childReady) ? true : undefined));
      testPid = lease.pid;
      wrapper.kill('SIGKILL');
      await waitForExit(wrapper);
      const readerLock = lease.path.slice(0, lease.path.indexOf('.child.'));
      const leaseAfterWrapperExit = existsSync(lease.path) ? await readFile(lease.path, 'utf-8') : 'missing';
      assert.equal(
        isOwnedLockActive(readerLock),
        true,
        `reader=${existsSync(readerLock)} lease=${leaseAfterWrapperExit}`,
      );

      const blocked = runBuildProbe(lockRoot);
      assert.equal(blocked.status, 2);
      assert.match(blocked.stderr, /dist_build_lock_timeout:readers=1/);

      await waitFor(async () => (isProcessAlive(testPid) ? undefined : true), 5_000);
      testPid = 0;
      const recovered = runBuildProbe(lockRoot);
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    } finally {
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      if (testPid) await killProcessGroup(testPid);
      await rm(lockRoot, { recursive: true, force: true });
    }
  });

  it('kills and waits for the active test child before releasing on SIGTERM', async () => {
    const lockRoot = await mkdtemp(join(tmpdir(), 'omx-dist-lock-runner-signal-'));
    const longTest = join(lockRoot, 'signal-hold.test.js');
    let wrapper: ReturnType<typeof spawn> | undefined;
    try {
      await writeFile(
        longTest,
        "import test from 'node:test';\ntest('hold', async () => new Promise((resolve) => setTimeout(resolve, 5000)));\n",
      );
      wrapper = spawn(process.execPath, [compiledRunner, longTest], {
        stdio: 'ignore',
        env: {
          ...process.env,
          OMX_DIST_LOCK_ROOT: lockRoot,
          OMX_DIST_LOCK_TIMEOUT_MS: '2000',
          OMX_DIST_READER_LOCK: '',
        },
      });
      await waitForChildLease(lockRoot, 'dist-reader-');
      wrapper.kill('SIGTERM');
      const result = await waitForExitResult(wrapper);
      assert.deepEqual(result, { status: 143, signal: null });
      assert.equal(
        (await readdir(lockRoot)).some((name) => /^dist-reader-\d+-\d+(?:\.child\.)?/.test(name)),
        false,
      );
    } finally {
      if (wrapper && wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill('SIGKILL');
      await rm(lockRoot, { recursive: true, force: true });
    }
  });
});
