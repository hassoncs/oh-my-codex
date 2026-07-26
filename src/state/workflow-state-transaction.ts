import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getStateFilePath, getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';
import type { WorkflowStateLockLease } from './workflow-state-lock.js';
import { getWorkflowStateTransactionFaults } from '../testing/state-fault-injection.js';

const WORKFLOW_STATE_TRANSACTION_FILE = '.workflow-state-transaction.json';
export const WORKFLOW_STATE_RECOVERY_OWNER_FILE = '.workflow-state-recovery-owner.json';

export interface WorkflowStateSnapshot {
  files: Array<{ path: string; content: Buffer | null }>;
}

interface PersistedWorkflowStateTransactionEntry {
  path: string;
  content_base64: string | null;
  byte_length: number | null;
  sha256: string | null;
}

interface PersistedWorkflowStateTransaction {
  version: 3;
  transaction_id: string;
  lock_token: string;
  lock_generation: string;
  files: PersistedWorkflowStateTransactionEntry[];
}

interface PersistedWorkflowStateRecoveryOwner {
  version: 1;
  lock_token: string;
  lock_generation: string;
}

export interface WorkflowStateTransactionLease {
  readonly journalPath: string;
  readonly transactionId: string;
}

export interface WorkflowStateMutationAuthority {
  lockLease: WorkflowStateLockLease;
  transactionLease: WorkflowStateTransactionLease;
}

const activeLeases = new WeakSet<object>();
const activeTransactions = new Map<string, WorkflowStateTransactionLease>();

export async function captureWorkflowStateSnapshot(
  cwd: string,
  sessionId?: string,
  extraPaths: string[] = [],
): Promise<WorkflowStateSnapshot> {
  const paths = [
    ...TRACKED_WORKFLOW_MODES.flatMap((mode) => [
      getStatePath(mode, cwd),
      ...(sessionId ? [getStatePath(mode, cwd, sessionId)] : []),
    ]),
    getStateFilePath('run-state.json', cwd),
    ...(sessionId ? [getStateFilePath('run-state.json', cwd, sessionId)] : []),
    getStateFilePath('skill-active-state.json', cwd),
    ...(sessionId ? [getStateFilePath('skill-active-state.json', cwd, sessionId)] : []),
    ...extraPaths,
  ];
  return {
    files: await Promise.all([...new Set(paths)].map(async (path) => ({
      path,
      content: await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
    }))),
  };
}

export async function restoreWorkflowStateSnapshot(snapshot: WorkflowStateSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    if (file.content === null) {
      await rm(file.path, { force: true });
      await syncDirectory(dirname(file.path));
      continue;
    }
    await writeDurableFile(file.path, file.content);
  }
}

function transactionPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_TRANSACTION_FILE);
}

function recoveryOwnerPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_RECOVERY_OWNER_FILE);
}

function relativeTransactionPath(baseStateDir: string, path: string): string {
  const normalized = relative(resolve(baseStateDir), resolve(path));
  if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`workflow_state_transaction_invalid:path:${path}`);
  }
  return normalized;
}

function snapshotFromPersisted(
  baseStateDir: string,
  persisted: unknown,
): WorkflowStateSnapshot {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error('workflow_state_transaction_invalid:schema');
  }
  const record = persisted as Partial<PersistedWorkflowStateTransaction>;
  if (
    record.version !== 3
    || typeof record.transaction_id !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.transaction_id)
    || typeof record.lock_token !== 'string'
    || record.lock_token.length === 0
    || typeof record.lock_generation !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.lock_generation)
    || !Array.isArray(record.files)
  ) {
    throw new Error('workflow_state_transaction_invalid:version');
  }

  return {
    files: record.files.map((file) => {
      if (
        !file
        || typeof file.path !== 'string'
        || !Object.prototype.hasOwnProperty.call(file, 'content_base64')
        || !Object.prototype.hasOwnProperty.call(file, 'byte_length')
        || !Object.prototype.hasOwnProperty.call(file, 'sha256')
      ) {
        throw new Error('workflow_state_transaction_invalid:entry');
      }
      const path = resolve(baseStateDir, file.path);
      relativeTransactionPath(baseStateDir, path);
      if (file.content_base64 === null) {
        if (file.byte_length !== null || file.sha256 !== null) {
          throw new Error('workflow_state_transaction_invalid:null_entry');
        }
        return { path, content: null };
      }
      if (
        typeof file.content_base64 !== 'string'
        || !Number.isSafeInteger(file.byte_length)
        || (file.byte_length ?? -1) < 0
        || typeof file.sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        throw new Error('workflow_state_transaction_invalid:entry_metadata');
      }
      const content = decodeCanonicalBase64(file.content_base64);
      if (content.length !== file.byte_length) {
        throw new Error('workflow_state_transaction_invalid:length');
      }
      if (sha256(content) !== file.sha256) {
        throw new Error('workflow_state_transaction_invalid:digest');
      }
      return {
        path,
        content,
      };
    }),
  };
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeCanonicalBase64(value: string): Buffer {
  if (
    value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error('workflow_state_transaction_invalid:base64');
  }
  const content = Buffer.from(value, 'base64');
  if (content.toString('base64') !== value) {
    throw new Error('workflow_state_transaction_invalid:base64');
  }
  return content;
}

async function writeWorkflowStateTransaction(
  baseStateDir: string,
  snapshot: WorkflowStateSnapshot,
  transactionId: string,
  lockToken: string,
  lockGeneration: string,
): Promise<void> {
  const path = transactionPath(baseStateDir);
  const persisted: PersistedWorkflowStateTransaction = {
    version: 3,
    transaction_id: transactionId,
    lock_token: lockToken,
    lock_generation: lockGeneration,
    files: snapshot.files.map((file) => ({
      path: relativeTransactionPath(baseStateDir, file.path),
      content_base64: file.content?.toString('base64') ?? null,
      byte_length: file.content?.length ?? null,
      sha256: file.content ? sha256(file.content) : null,
    })),
  };
  await writeDurableFile(path, Buffer.from(JSON.stringify(persisted), 'utf-8'));
}

async function writeDurableFile(path: string, content: Buffer): Promise<void> {
  const parentDir = dirname(path);
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(parentDir, { recursive: true });
  const handle = await open(tempPath, 'w');
  try {
    try {
      await handle.writeFile(content);
      await getWorkflowStateTransactionFaults().hook?.('before-file-sync', path);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await rename(tempPath, path);
  await syncDirectory(parentDir);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent !== path) await syncDirectory(parent);
    return;
  }
  try {
    await getWorkflowStateTransactionFaults().hook?.('before-directory-sync', path);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeWorkflowStateTransaction(baseStateDir: string): Promise<void> {
  const path = transactionPath(baseStateDir);
  await getWorkflowStateTransactionFaults().hook?.('before-journal-delete', path);
  await rm(path, { force: true });
  await syncDirectory(baseStateDir);
}

async function assertWorkflowStateTransactionOwned(
  baseStateDir: string,
  transactionId: string,
  lockToken: string,
  lockGeneration: string,
): Promise<void> {
  const path = transactionPath(baseStateDir);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf-8'));
  } catch (error) {
    throw new Error(`workflow_state_transaction_displaced:${String(error)}`);
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as { transaction_id?: unknown }).transaction_id !== transactionId
    || (parsed as { lock_token?: unknown }).lock_token !== lockToken
    || (parsed as { lock_generation?: unknown }).lock_generation !== lockGeneration
  ) {
    throw new Error(`workflow_state_transaction_displaced:${transactionId}`);
  }
}

async function syncWorkflowStatePaths(snapshot: WorkflowStateSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    try {
      const handle = await open(file.path, 'r');
      try {
        await getWorkflowStateTransactionFaults().hook?.('before-file-sync', file.path);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await syncDirectory(dirname(file.path));
  }
}

function parseRecoveryOwner(raw: string): PersistedWorkflowStateRecoveryOwner | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || typeof (parsed as { lock_token?: unknown }).lock_token !== 'string'
    || typeof (parsed as { lock_generation?: unknown }).lock_generation !== 'string'
    || !/^[0-9a-f-]{36}$/.test((parsed as { lock_generation: string }).lock_generation)
  ) {
    return null;
  }
  return parsed as PersistedWorkflowStateRecoveryOwner;
}

function transactionOwner(persisted: unknown): PersistedWorkflowStateRecoveryOwner | null {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return null;
  const lockToken = (persisted as { lock_token?: unknown }).lock_token;
  const lockGeneration = (persisted as { lock_generation?: unknown }).lock_generation;
  if (
    typeof lockToken !== 'string'
    || lockToken.length === 0
    || typeof lockGeneration !== 'string'
    || !/^[0-9a-f-]{36}$/.test(lockGeneration)
  ) {
    return null;
  }
  return {
    version: 1,
    lock_token: lockToken,
    lock_generation: lockGeneration,
  };
}

async function quarantineWorkflowStateTransaction(
  baseStateDir: string,
  reason: 'foreign' | 'ownerless',
): Promise<string> {
  const path = transactionPath(baseStateDir);
  const quarantinePath = `${path}.${reason}.${Date.now()}.${randomUUID()}.rejected`;
  await rename(path, quarantinePath);
  await syncDirectory(baseStateDir);
  return quarantinePath;
}

export async function recoverWorkflowStateTransactionUnderLock(
  baseStateDir: string,
  lockLease: WorkflowStateLockLease,
): Promise<boolean> {
  await lockLease.assertOwned();
  const path = transactionPath(baseStateDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(recoveryOwnerPath(baseStateDir), { force: true });
      await syncDirectory(baseStateDir);
      return false;
    }
    throw error;
  }
  let persisted: unknown;
  try {
    persisted = JSON.parse(raw);
  } catch {
    throw new Error('workflow_state_transaction_corrupt:json');
  }
  const owner = transactionOwner(persisted);
  if (!owner) {
    await lockLease.assertOwned();
    const quarantinePath = await quarantineWorkflowStateTransaction(baseStateDir, 'ownerless');
    throw new Error(`workflow_state_transaction_recovery_rejected:ownerless:${quarantinePath}`);
  }
  const recoveryOwnerRaw = await readFile(recoveryOwnerPath(baseStateDir), 'utf-8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    },
  );
  const recoveryOwner = recoveryOwnerRaw ? parseRecoveryOwner(recoveryOwnerRaw) : null;
  if (
    !recoveryOwner
    || recoveryOwner.lock_token !== owner.lock_token
    || recoveryOwner.lock_generation !== owner.lock_generation
  ) {
    await lockLease.assertOwned();
    const quarantinePath = await quarantineWorkflowStateTransaction(baseStateDir, 'foreign');
    throw new Error(`workflow_state_transaction_recovery_rejected:foreign:${quarantinePath}`);
  }
  const snapshot = snapshotFromPersisted(baseStateDir, persisted);
  await lockLease.assertOwned();
  await restoreWorkflowStateSnapshot(snapshot);
  await lockLease.assertOwned();
  await removeWorkflowStateTransaction(baseStateDir);
  await rm(recoveryOwnerPath(baseStateDir), { force: true });
  await syncDirectory(baseStateDir);
  return true;
}

export async function withWorkflowStateTransaction<T>(
  baseStateDir: string,
  cwd: string,
  sessionId: string | undefined,
  fn: (lease: WorkflowStateTransactionLease) => Promise<T>,
  extraPaths: string[] = [],
  options: {
    lockLease?: WorkflowStateLockLease;
    transactionLease?: WorkflowStateTransactionLease;
  } = {},
): Promise<T> {
  const path = transactionPath(baseStateDir);
  if (options.transactionLease) {
    if (
      !activeLeases.has(options.transactionLease)
      || activeTransactions.get(path) !== options.transactionLease
      || options.transactionLease.journalPath !== path
    ) {
      throw new Error(`workflow_state_transaction_invalid_lease:${baseStateDir}`);
    }
    return fn(options.transactionLease);
  }
  if (!options.lockLease) throw new Error(`workflow_state_transaction_lock_required:${baseStateDir}`);
  if (activeTransactions.has(path)) {
    throw new Error(`workflow_state_transaction_contended:${baseStateDir}`);
  }
  await options.lockLease.assertOwned();

  const snapshot = await captureWorkflowStateSnapshot(cwd, sessionId, extraPaths);
  const transactionId = randomUUID();
  await writeWorkflowStateTransaction(
    baseStateDir,
    snapshot,
    transactionId,
    options.lockLease.token,
    options.lockLease.generation,
  );
  const acquiredLease: WorkflowStateTransactionLease = Object.freeze({
    journalPath: path,
    transactionId,
  });
  activeLeases.add(acquiredLease);
  activeTransactions.set(path, acquiredLease);

  try {
    try {
      const result = await fn(acquiredLease);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        baseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await syncWorkflowStatePaths(snapshot);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        baseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await removeWorkflowStateTransaction(baseStateDir);
      return result;
    } catch (error) {
      try {
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(
          baseStateDir,
          transactionId,
          options.lockLease.token,
          options.lockLease.generation,
        );
        await restoreWorkflowStateSnapshot(snapshot);
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(
          baseStateDir,
          transactionId,
          options.lockLease.token,
          options.lockLease.generation,
        );
        await removeWorkflowStateTransaction(baseStateDir);
      } catch (rollbackError) {
        try {
          await options.lockLease.markRecoveryRequired();
        } catch (provenanceError) {
          throw new AggregateError(
            [error, rollbackError, provenanceError],
            `workflow_state_transaction_recovery_provenance_failed:${String(error)}`,
          );
        }
        throw new AggregateError(
          [error, rollbackError],
          `workflow_state_transaction_rollback_failed:${String(error)}`,
        );
      }
      throw error;
    }
  } finally {
    activeLeases.delete(acquiredLease);
    if (activeTransactions.get(path) === acquiredLease) activeTransactions.delete(path);
  }
}
