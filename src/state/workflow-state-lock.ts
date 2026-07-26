import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { recoverWorkflowStateTransaction } from './workflow-state-transaction.js';

const DEFAULT_LOCK_STALE_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_HEARTBEAT_MS = 1_000;

interface LockOwner {
  token: string;
  pid: number;
  heartbeat_at: string;
}

type LockOwnerReadResult =
  | { kind: 'ok'; owner: LockOwner }
  | { kind: 'missing' | 'invalid' };

interface WorkflowStateLockTestConfig {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  processIsAlive?: (pid: number) => boolean;
  hook?: (
    stage: 'contended' | 'before-stale-rename' | 'before-owner-write',
  ) => void | Promise<void>;
}

let testConfig: WorkflowStateLockTestConfig = {};
const activeLeases = new WeakSet<object>();

export interface WorkflowStateLockLease {
  readonly baseStateDir: string;
  readonly token: string;
  assertOwned(): Promise<void>;
}

export function setWorkflowStateLockTestConfig(config: WorkflowStateLockTestConfig = {}): void {
  testConfig = config;
}

function ownerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function readOwner(path: string): Promise<LockOwnerReadResult> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<LockOwner>;
    if (
      typeof parsed.token !== 'string'
      || !Number.isInteger(parsed.pid)
      || typeof parsed.heartbeat_at !== 'string'
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'ok', owner: parsed as LockOwner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid' };
  }
}

function processIsAlive(pid: number): boolean {
  if (testConfig.processIsAlive) return testConfig.processIsAlive(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeOwner(path: string, owner: LockOwner): Promise<void> {
  const tempPath = `${path}.${owner.token}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await testConfig.hook?.('before-owner-write');
  await writeFile(tempPath, JSON.stringify(owner), 'utf-8');
  await rename(tempPath, path);
}

async function recoverStaleLock(lockDir: string, ownerPath: string, contenderToken: string): Promise<boolean> {
  const observedStat = await stat(lockDir).catch(() => null);
  const staleMs = testConfig.staleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!observedStat || Date.now() - observedStat.mtimeMs <= staleMs) return false;

  const observedOwnerResult = await readOwner(ownerPath);
  if (observedOwnerResult.kind !== 'ok') return false;
  const observedOwner = observedOwnerResult.owner;
  const heartbeatAt = Date.parse(observedOwner.heartbeat_at);
  if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= staleMs) return false;
  if (processIsAlive(observedOwner.pid)) return false;

  const confirmedStat = await stat(lockDir).catch(() => null);
  if (
    !confirmedStat
    || confirmedStat.dev !== observedStat.dev
    || confirmedStat.ino !== observedStat.ino
    || confirmedStat.mtimeMs !== observedStat.mtimeMs
  ) {
    return false;
  }

  await testConfig.hook?.('before-stale-rename');
  const quarantineDir = `${lockDir}.stale.${contenderToken}`;
  try {
    await rename(lockDir, quarantineDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const movedStat = await stat(quarantineDir).catch(() => null);
  const movedOwnerResult = await readOwner(join(quarantineDir, 'owner'));
  const movedOwner = movedOwnerResult.kind === 'ok' ? movedOwnerResult.owner : null;
  const sameOwner = Boolean(
    movedOwner
    && movedOwner.token === observedOwner.token
    && movedOwner.pid === observedOwner.pid
    && movedOwner.heartbeat_at === observedOwner.heartbeat_at
  );
  const movedHeartbeatAt = movedOwner ? Date.parse(movedOwner.heartbeat_at) : Number.NaN;
  const movedOwnerIsFresh = Number.isFinite(movedHeartbeatAt) && Date.now() - movedHeartbeatAt <= staleMs;
  if (
    !movedStat
    || movedStat.dev !== observedStat.dev
    || movedStat.ino !== observedStat.ino
    || movedStat.mtimeMs !== observedStat.mtimeMs
    || !sameOwner
    || movedOwnerIsFresh
    || Boolean(movedOwner && processIsAlive(movedOwner.pid))
  ) {
    await rename(quarantineDir, lockDir).catch(() => {});
    throw new Error(`workflow_state_lock_takeover_race:${lockDir}`);
  }

  await rm(quarantineDir, { recursive: true, force: true });
  return true;
}

export async function withWorkflowStateLock<T>(
  baseStateDir: string,
  fn: (lease: WorkflowStateLockLease) => Promise<T>,
  lease?: WorkflowStateLockLease,
): Promise<T> {
  const normalizedBaseStateDir = resolve(baseStateDir);
  if (lease) {
    if (!activeLeases.has(lease) || lease.baseStateDir !== normalizedBaseStateDir) {
      throw new Error(`workflow_state_lock_invalid_lease:${baseStateDir}`);
    }
    return fn(lease);
  }

  const lockDir = join(normalizedBaseStateDir, '.workflow-state.lock');
  const ownerPath = join(lockDir, 'owner');
  const token = ownerToken();
  const timeoutMs = testConfig.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = testConfig.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const heartbeatMs = testConfig.heartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS;
  const deadline = Date.now() + timeoutMs;
  await mkdir(normalizedBaseStateDir, { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      await writeOwner(ownerPath, {
        token,
        pid: process.pid,
        heartbeat_at: new Date().toISOString(),
      });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      await testConfig.hook?.('contended');
      if (await recoverStaleLock(lockDir, ownerPath, token)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`workflow_state_lock_timeout:${baseStateDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }

  let heartbeatError: unknown;
  let heartbeatWrite: Promise<void> | null = null;
  const refreshHeartbeat = (): void => {
    if (heartbeatWrite || heartbeatError) return;
    heartbeatWrite = writeOwner(ownerPath, {
      token,
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
    }).catch((error) => {
      heartbeatError = error;
    }).finally(() => {
      heartbeatWrite = null;
    });
  };
  const heartbeat = setInterval(() => {
    refreshHeartbeat();
  }, heartbeatMs);
  heartbeat.unref();

  const acquiredLease: WorkflowStateLockLease = Object.freeze({
    baseStateDir: normalizedBaseStateDir,
    token,
    assertOwned: async () => {
      if (!activeLeases.has(acquiredLease)) {
        throw new Error(`workflow_state_lock_inactive_lease:${baseStateDir}`);
      }
      if (heartbeatError) {
        throw new Error(`workflow_state_lock_heartbeat_failed:${String(heartbeatError)}`);
      }
      if (heartbeatWrite) await heartbeatWrite;
      if (heartbeatError) {
        throw new Error(`workflow_state_lock_heartbeat_failed:${String(heartbeatError)}`);
      }
      const currentOwner = await readOwner(ownerPath);
      if (currentOwner.kind !== 'ok' || currentOwner.owner.token !== token) {
        throw new Error(`workflow_state_lock_ownership_lost:${baseStateDir}`);
      }
    },
  });
  activeLeases.add(acquiredLease);
  let operationError: unknown;
  try {
    await recoverWorkflowStateTransaction(normalizedBaseStateDir);
    const result = await fn(acquiredLease);
    await acquiredLease.assertOwned();
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    activeLeases.delete(acquiredLease);
    clearInterval(heartbeat);
    if (heartbeatWrite) await heartbeatWrite;
    const currentOwner = await readOwner(ownerPath);
    if (currentOwner.kind === 'ok' && currentOwner.owner.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
    if (heartbeatError) {
      const failure = new Error(`workflow_state_lock_heartbeat_failed:${String(heartbeatError)}`);
      if (operationError) {
        throw new AggregateError(
          [operationError, failure],
          `workflow_state_lock_operation_and_heartbeat_failed:${String(operationError)}`,
        );
      }
      throw failure;
    }
  }
}
