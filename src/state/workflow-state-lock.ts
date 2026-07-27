import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  recoverWorkflowStateTransactionUnderLock,
  WORKFLOW_STATE_RECOVERY_OWNER_FILE,
  type WorkflowStateTransactionDependencies,
} from './workflow-state-transaction.js';

const DEFAULT_LOCK_STALE_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_HEARTBEAT_MS = 1_000;

interface LockOwner {
  token: string;
  generation: string;
  pid: number;
  heartbeat_at: string;
  recovery_required?: boolean;
  recovery_owner?: {
    token: string;
    generation: string;
  };
}

type LockOwnerReadResult =
  | { kind: 'ok'; owner: LockOwner }
  | { kind: 'missing' | 'invalid' };

export interface WorkflowStateLockDependencies {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  processIsAlive?: (pid: number) => boolean;
  hook?: (
    stage:
      | 'contended'
      | 'before-lock-publish'
      | 'before-stale-rename'
      | 'after-stale-rename'
      | 'before-owner-write',
  ) => void | Promise<void>;
  readFile?: (path: string, encoding: 'utf-8') => Promise<string>;
  realpath?: (path: string) => Promise<string>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  rm?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>;
  stat?: (path: string) => Promise<Stats>;
  transaction?: WorkflowStateTransactionDependencies;
}

const activeLeases = new WeakSet<object>();

export interface WorkflowStateLockLease {
  readonly baseStateDir: string;
  readonly token: string;
  readonly generation: string;
  assertOwned(): Promise<void>;
  markRecoveryRequired(): Promise<void>;
}

function ownerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function missingOnly<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readOwner(
  path: string,
  dependencies: WorkflowStateLockDependencies,
): Promise<LockOwnerReadResult> {
  let raw: string;
  try {
    raw = await (dependencies.readFile ?? readFile)(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (
      typeof parsed.token !== 'string'
      || typeof parsed.generation !== 'string'
      || !/^[0-9a-f-]{36}$/.test(parsed.generation)
      || !Number.isInteger(parsed.pid)
      || typeof parsed.heartbeat_at !== 'string'
      || (
        parsed.recovery_owner !== undefined
        && (
          !parsed.recovery_owner
          || typeof parsed.recovery_owner !== 'object'
          || typeof parsed.recovery_owner.token !== 'string'
          || typeof parsed.recovery_owner.generation !== 'string'
          || !/^[0-9a-f-]{36}$/.test(parsed.recovery_owner.generation)
        )
      )
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'ok', owner: parsed as LockOwner };
  } catch {
    return { kind: 'invalid' };
  }
}

function processIsAlive(pid: number, dependencies: WorkflowStateLockDependencies): boolean {
  const processIsAliveOverride = dependencies.processIsAlive;
  if (processIsAliveOverride) return processIsAliveOverride(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableJson(path: string, value: unknown): Promise<void> {
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(JSON.stringify(value), 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  await syncDirectory(dirname(path));
}

async function writeOwner(
  path: string,
  owner: LockOwner,
  dependencies: WorkflowStateLockDependencies,
): Promise<void> {
  const tempPath = `${path}.${owner.token}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await dependencies.hook?.('before-owner-write');
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  await syncDirectory(dirname(path));
}

async function recoverOrphanedPendingLocks(
  baseStateDir: string,
  lockDir: string,
  dependencies: WorkflowStateLockDependencies,
): Promise<void> {
  const pendingPrefix = `${lockDir.slice(baseStateDir.length + 1)}.pending.`;
  const staleMs = dependencies.staleMs ?? DEFAULT_LOCK_STALE_MS;
  let removed = false;
  for (const entry of await readdir(baseStateDir)) {
    if (!entry.startsWith(pendingPrefix)) continue;
    const pendingDir = join(baseStateDir, entry);
    const owner = await readOwner(join(pendingDir, 'owner'), dependencies);
    if (owner.kind === 'ok') {
      if (processIsAlive(owner.owner.pid, dependencies)) continue;
    } else {
      const pendingStat = await missingOnly(() => (dependencies.stat ?? stat)(pendingDir));
      if (!pendingStat || Date.now() - pendingStat.mtimeMs <= staleMs) continue;
    }
    await rm(pendingDir, { recursive: true, force: true });
    removed = true;
  }
  if (removed) await syncDirectory(baseStateDir);
}

async function publishOwnerLock(
  baseStateDir: string,
  lockDir: string,
  owner: LockOwner,
  dependencies: WorkflowStateLockDependencies,
): Promise<boolean> {
  const pendingDir = `${lockDir}.pending.${owner.token}.${owner.generation}`;
  await mkdir(pendingDir);
  let operationError: unknown;
  let operationFailed = false;
  try {
    await writeOwner(join(pendingDir, 'owner'), owner, dependencies);
    await syncDirectory(pendingDir);
    await dependencies.hook?.('before-lock-publish');
    if (await missingOnly(() => (dependencies.stat ?? stat)(lockDir))) return false;
    try {
      await (dependencies.rename ?? rename)(pendingDir, lockDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') return false;
      throw error;
    }
    await syncDirectory(baseStateDir);
    return true;
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      await (dependencies.rm ?? rm)(pendingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      if (operationFailed) {
        throw new AggregateError(
          [operationError, cleanupError],
          `workflow_state_lock_publish_cleanup_failed:${String(operationError)}`,
        );
      }
      throw cleanupError;
    }
  }
}

async function readRecoveryOwner(baseStateDir: string): Promise<LockOwner['recovery_owner']> {
  let raw: string;
  try {
    raw = await readFile(join(baseStateDir, WORKFLOW_STATE_RECOVERY_OWNER_FILE), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let parsed: {
    version?: unknown;
    lock_token?: unknown;
    lock_generation?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`workflow_state_recovery_owner_invalid:${baseStateDir}`);
  }
  if (
    parsed.version !== 1
    || typeof parsed.lock_token !== 'string'
    || typeof parsed.lock_generation !== 'string'
    || !/^[0-9a-f-]{36}$/.test(parsed.lock_generation)
  ) {
    throw new Error(`workflow_state_recovery_owner_invalid:${baseStateDir}`);
  }
  return {
    token: parsed.lock_token,
    generation: parsed.lock_generation,
  };
}

async function writeRecoveryOwner(
  baseStateDir: string,
  owner: NonNullable<LockOwner['recovery_owner']>,
): Promise<void> {
  await writeDurableJson(join(baseStateDir, WORKFLOW_STATE_RECOVERY_OWNER_FILE), {
    version: 1,
    lock_token: owner.token,
    lock_generation: owner.generation,
  });
}

async function recoverOrphanedTakeoverProvenance(
  baseStateDir: string,
  lockDir: string,
  dependencies: WorkflowStateLockDependencies,
): Promise<LockOwner['recovery_owner']> {
  if (await missingOnly(() => (dependencies.stat ?? stat)(lockDir))) {
    return readRecoveryOwner(baseStateDir);
  }
  const persisted = await readRecoveryOwner(baseStateDir);
  const quarantinePrefix = '.workflow-state.lock.stale.';
  const candidates = await Promise.all(
    (await readdir(baseStateDir))
      .filter((entry) => entry.startsWith(quarantinePrefix))
      .map(async (entry) => {
        const quarantineDir = join(baseStateDir, entry);
        const owner = await readOwner(join(quarantineDir, 'owner'), dependencies);
        if (owner.kind !== 'ok') return null;
        return {
          quarantineDir,
          recoveryOwner: owner.owner.recovery_owner ?? {
            token: owner.owner.token,
            generation: owner.owner.generation,
          },
        };
      }),
  );
  const valid = candidates.filter((candidate) => candidate !== null);
  if (valid.length === 0) return persisted;
  const identities = new Set(
    valid.map(({ recoveryOwner }) => `${recoveryOwner.token}\0${recoveryOwner.generation}`),
  );
  if (persisted) identities.add(`${persisted.token}\0${persisted.generation}`);
  if (identities.size !== 1) {
    throw new Error(`workflow_state_lock_recovery_provenance_ambiguous:${baseStateDir}`);
  }
  const recoveryOwner = persisted ?? valid[0]!.recoveryOwner;
  if (!persisted) await writeRecoveryOwner(baseStateDir, recoveryOwner);
  for (const { quarantineDir } of valid) {
    await (dependencies.rm ?? rm)(quarantineDir, { recursive: true, force: true });
  }
  await syncDirectory(baseStateDir);
  return recoveryOwner;
}

async function recoverStaleLock(
  baseStateDir: string,
  lockDir: string,
  ownerPath: string,
  contenderToken: string,
  dependencies: WorkflowStateLockDependencies,
): Promise<LockOwner['recovery_owner']> {
  const observedStat = await missingOnly(() => (dependencies.stat ?? stat)(lockDir));
  if (!observedStat) return undefined;
  const observedOwnerResult = await readOwner(ownerPath, dependencies);
  if (observedOwnerResult.kind !== 'ok') return undefined;
  const observedOwner = observedOwnerResult.owner;
  const persistedRecoveryOwner = await readRecoveryOwner(baseStateDir);
  const markerRequiresRecovery = Boolean(
    persistedRecoveryOwner
    && persistedRecoveryOwner.token === observedOwner.token
    && persistedRecoveryOwner.generation === observedOwner.generation
  );
  const recoveryRequired = observedOwner.recovery_required === true || markerRequiresRecovery;
  const staleMs = dependencies.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const heartbeatAt = Date.parse(observedOwner.heartbeat_at);
  if (!recoveryRequired) {
    if (Date.now() - observedStat.mtimeMs <= staleMs) return undefined;
    if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= staleMs) return undefined;
    if (processIsAlive(observedOwner.pid, dependencies)) return undefined;
  }

  const confirmedStat = await missingOnly(() => (dependencies.stat ?? stat)(lockDir));
  if (
    !confirmedStat
    || confirmedStat.dev !== observedStat.dev
    || confirmedStat.ino !== observedStat.ino
    || confirmedStat.mtimeMs !== observedStat.mtimeMs
  ) {
    return undefined;
  }

  await dependencies.hook?.('before-stale-rename');
  const quarantineDir = `${lockDir}.stale.${contenderToken}`;
  try {
    await (dependencies.rename ?? rename)(lockDir, quarantineDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  await dependencies.hook?.('after-stale-rename');

  const movedStat = await missingOnly(() => (dependencies.stat ?? stat)(quarantineDir));
  const movedOwnerResult = await readOwner(join(quarantineDir, 'owner'), dependencies);
  const movedOwner = movedOwnerResult.kind === 'ok' ? movedOwnerResult.owner : null;
  const sameOwner = Boolean(
    movedOwner
    && movedOwner.token === observedOwner.token
    && movedOwner.generation === observedOwner.generation
    && movedOwner.pid === observedOwner.pid
    && movedOwner.heartbeat_at === observedOwner.heartbeat_at
    && movedOwner.recovery_required === observedOwner.recovery_required
    && movedOwner.recovery_owner?.token === observedOwner.recovery_owner?.token
    && movedOwner.recovery_owner?.generation === observedOwner.recovery_owner?.generation
  );
  const movedHeartbeatAt = movedOwner ? Date.parse(movedOwner.heartbeat_at) : Number.NaN;
  const movedOwnerIsFresh = Number.isFinite(movedHeartbeatAt) && Date.now() - movedHeartbeatAt <= staleMs;
  if (
    !movedStat
    || movedStat.dev !== observedStat.dev
    || movedStat.ino !== observedStat.ino
    || movedStat.mtimeMs !== observedStat.mtimeMs
    || !sameOwner
    || (
      !recoveryRequired
      && (movedOwnerIsFresh || Boolean(movedOwner && processIsAlive(movedOwner.pid, dependencies)))
    )
  ) {
    const raceError = new Error(`workflow_state_lock_takeover_race:${lockDir}`);
    try {
      await (dependencies.rename ?? rename)(quarantineDir, lockDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [raceError, cleanupError],
        `workflow_state_lock_takeover_restore_failed:${lockDir}`,
      );
    }
    throw raceError;
  }

  const recoveryOwner = observedOwner.recovery_owner ?? {
    token: observedOwner.token,
    generation: observedOwner.generation,
  };
  await writeRecoveryOwner(baseStateDir, recoveryOwner);
  await (dependencies.rm ?? rm)(quarantineDir, { recursive: true, force: true });
  await syncDirectory(baseStateDir);
  return recoveryOwner;
}

export async function withWorkflowStateLock<T>(
  baseStateDir: string,
  trustedCwd: string,
  fn: (lease: WorkflowStateLockLease) => Promise<T>,
  lease?: WorkflowStateLockLease,
  dependencies: WorkflowStateLockDependencies = {},
): Promise<T> {
  const requestedBaseStateDir = resolve(baseStateDir);
  if (lease) {
    const canonicalBaseStateDir = await missingOnly(
      () => (dependencies.realpath ?? realpath)(requestedBaseStateDir),
    );
    if (!activeLeases.has(lease) || lease.baseStateDir !== canonicalBaseStateDir) {
      throw new Error(`workflow_state_lock_invalid_lease:${baseStateDir}`);
    }
    return fn(lease);
  }

  await mkdir(requestedBaseStateDir, { recursive: true });
  const normalizedBaseStateDir = await realpath(requestedBaseStateDir);
  const lockDir = join(normalizedBaseStateDir, '.workflow-state.lock');
  const ownerPath = join(lockDir, 'owner');
  const token = ownerToken();
  const generation = randomUUID();
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = dependencies.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const heartbeatMs = dependencies.heartbeatMs ?? DEFAULT_LOCK_HEARTBEAT_MS;
  const deadline = Date.now() + timeoutMs;
  await recoverOrphanedPendingLocks(normalizedBaseStateDir, lockDir, dependencies);
  let recoveryOwner = await recoverOrphanedTakeoverProvenance(
    normalizedBaseStateDir,
    lockDir,
    dependencies,
  );
  let recoveryRequired = false;

  while (true) {
    try {
      const published = await publishOwnerLock(normalizedBaseStateDir, lockDir, {
        token,
        generation,
        pid: process.pid,
        heartbeat_at: new Date().toISOString(),
        ...(recoveryOwner ? { recovery_owner: recoveryOwner } : {}),
      }, dependencies);
      if (published) break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
    await dependencies.hook?.('contended');
    const recoveredOwner = await recoverStaleLock(
      normalizedBaseStateDir,
      lockDir,
      ownerPath,
      token,
      dependencies,
    );
    if (recoveredOwner) {
      recoveryOwner = recoveredOwner;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`workflow_state_lock_timeout:${baseStateDir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }

  let heartbeatError: unknown;
  let heartbeatWrite: Promise<void> | null = null;
  const refreshHeartbeat = (): void => {
    if (heartbeatWrite || heartbeatError) return;
    heartbeatWrite = writeOwner(ownerPath, {
      token,
      generation,
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
      ...(recoveryRequired ? { recovery_required: true } : {}),
      ...(recoveryOwner ? { recovery_owner: recoveryOwner } : {}),
    }, dependencies).catch((error) => {
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
    generation,
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
      const currentOwner = await readOwner(ownerPath, dependencies);
      if (
        currentOwner.kind !== 'ok'
        || currentOwner.owner.token !== token
        || currentOwner.owner.generation !== generation
      ) {
        throw new Error(`workflow_state_lock_ownership_lost:${baseStateDir}`);
      }
    },
    markRecoveryRequired: async () => {
      if (!activeLeases.has(acquiredLease)) {
        throw new Error(`workflow_state_lock_inactive_lease:${baseStateDir}`);
      }
      recoveryRequired = true;
      recoveryOwner = { token, generation };
      await writeRecoveryOwner(normalizedBaseStateDir, recoveryOwner);
      await writeOwner(ownerPath, {
        token,
        generation,
        pid: process.pid,
        heartbeat_at: new Date().toISOString(),
        recovery_required: true,
        recovery_owner: recoveryOwner,
      }, dependencies);
    },
  });
  activeLeases.add(acquiredLease);
  let operationError: unknown;
  try {
    const hadRecoveryOwner = recoveryOwner !== undefined;
    await recoverWorkflowStateTransactionUnderLock(
      normalizedBaseStateDir,
      trustedCwd,
      acquiredLease,
      dependencies.transaction,
    );
    recoveryOwner = undefined;
    if (hadRecoveryOwner) {
      await writeOwner(ownerPath, {
        token,
        generation,
        pid: process.pid,
        heartbeat_at: new Date().toISOString(),
      }, dependencies);
    }
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
    const currentOwner = await readOwner(ownerPath, dependencies);
    if (
      !recoveryRequired
      && currentOwner.kind === 'ok'
      && currentOwner.owner.token === token
      && currentOwner.owner.generation === generation
    ) {
      await rm(lockDir, { recursive: true, force: true });
      await syncDirectory(normalizedBaseStateDir);
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
