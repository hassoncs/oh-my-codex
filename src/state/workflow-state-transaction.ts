import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getStateFilePath, getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';
import type { WorkflowStateLockLease } from './workflow-state-lock.js';

const WORKFLOW_STATE_TRANSACTION_FILE = '.workflow-state-transaction.json';

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
  version: 2;
  transaction_id: string;
  lock_token: string;
  files: PersistedWorkflowStateTransactionEntry[];
}

interface WorkflowStateTransactionTestConfig {
  hook?: (
    stage: 'before-file-sync' | 'before-directory-sync' | 'before-journal-delete',
    path: string,
  ) => void | Promise<void>;
}

export interface WorkflowStateTransactionLease {
  readonly journalPath: string;
  readonly transactionId: string;
}

export interface WorkflowStateMutationAuthority {
  lockLease: WorkflowStateLockLease;
  transactionLease: WorkflowStateTransactionLease;
}

let testConfig: WorkflowStateTransactionTestConfig = {};
const activeLeases = new WeakSet<object>();
const activeTransactions = new Map<string, WorkflowStateTransactionLease>();

export function setWorkflowStateTransactionTestConfig(
  config: WorkflowStateTransactionTestConfig = {},
): void {
  testConfig = config;
}

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
    record.version !== 2
    || typeof record.transaction_id !== 'string'
    || !/^[0-9a-f-]{36}$/.test(record.transaction_id)
    || typeof record.lock_token !== 'string'
    || record.lock_token.length === 0
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
): Promise<void> {
  const path = transactionPath(baseStateDir);
  const persisted: PersistedWorkflowStateTransaction = {
    version: 2,
    transaction_id: transactionId,
    lock_token: lockToken,
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
      await testConfig.hook?.('before-file-sync', path);
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
    await testConfig.hook?.('before-directory-sync', path);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeWorkflowStateTransaction(baseStateDir: string): Promise<void> {
  const path = transactionPath(baseStateDir);
  await testConfig.hook?.('before-journal-delete', path);
  await rm(path, { force: true });
  await syncDirectory(baseStateDir);
}

async function assertWorkflowStateTransactionOwned(
  baseStateDir: string,
  transactionId: string,
  lockToken: string,
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
  ) {
    throw new Error(`workflow_state_transaction_displaced:${transactionId}`);
  }
}

async function syncWorkflowStatePaths(snapshot: WorkflowStateSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    try {
      const handle = await open(file.path, 'r');
      try {
        await testConfig.hook?.('before-file-sync', file.path);
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

export async function recoverWorkflowStateTransaction(baseStateDir: string): Promise<boolean> {
  const path = transactionPath(baseStateDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let persisted: unknown;
  try {
    persisted = JSON.parse(raw);
  } catch {
    throw new Error('workflow_state_transaction_corrupt:json');
  }
  const snapshot = snapshotFromPersisted(baseStateDir, persisted);
  await restoreWorkflowStateSnapshot(snapshot);
  await removeWorkflowStateTransaction(baseStateDir);
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
      await assertWorkflowStateTransactionOwned(baseStateDir, transactionId, options.lockLease.token);
      await syncWorkflowStatePaths(snapshot);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(baseStateDir, transactionId, options.lockLease.token);
      await removeWorkflowStateTransaction(baseStateDir);
      return result;
    } catch (error) {
      try {
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(baseStateDir, transactionId, options.lockLease.token);
        await restoreWorkflowStateSnapshot(snapshot);
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(baseStateDir, transactionId, options.lockLease.token);
        await removeWorkflowStateTransaction(baseStateDir);
      } catch (rollbackError) {
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
