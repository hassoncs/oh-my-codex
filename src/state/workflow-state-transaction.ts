import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getBaseStateDir } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';
import type { WorkflowStateLockLease } from './workflow-state-lock.js';

const WORKFLOW_STATE_TRANSACTION_FILE = '.workflow-state-transaction.json';
export const WORKFLOW_STATE_RECOVERY_OWNER_FILE = '.workflow-state-recovery-owner.json';

export interface WorkflowStateSnapshot {
  files: Array<{ path: string; content: Buffer | null }>;
}

interface PersistedWorkflowStateTransactionEntry {
  scope?: 'state' | 'context';
  path: string;
  content_base64: string | null;
  byte_length: number | null;
  sha256: string | null;
}

interface PersistedWorkflowStateTransaction {
  version: 3 | 4 | 5;
  transaction_id: string;
  context_root_sha256?: string;
  lock_token: string;
  lock_generation: string;
  files: PersistedWorkflowStateTransactionEntry[];
}

interface PersistedWorkflowStateRecoveryOwner {
  version: 1;
  lock_token: string;
  lock_generation: string;
}

export interface WorkflowStateTransactionDependencies {
  hook?: (
    stage: 'before-file-sync' | 'before-directory-sync' | 'before-journal-delete',
    path: string,
  ) => void | Promise<void>;
}

export interface WorkflowStateTransactionLease {
  readonly journalPath: string;
  readonly transactionId: string;
  capturePath(path: string): Promise<void>;
}

export interface WorkflowStateMutationAuthority {
  lockLease: WorkflowStateLockLease;
  transactionLease: WorkflowStateTransactionLease;
}

const activeLeases = new WeakSet<object>();
const activeTransactions = new Map<string, WorkflowStateTransactionLease | symbol>();

export async function captureWorkflowStateSnapshot(
  cwd: string,
  sessionId?: string,
  extraPaths: string[] = [],
  baseStateDir: string = getBaseStateDir(cwd),
): Promise<WorkflowStateSnapshot> {
  const normalizedBaseStateDir = resolve(baseStateDir);
  const paths = [
    ...TRACKED_WORKFLOW_MODES.flatMap((mode) => [
      join(normalizedBaseStateDir, `${mode}-state.json`),
      ...(sessionId ? [join(normalizedBaseStateDir, 'sessions', sessionId, `${mode}-state.json`)] : []),
    ]),
    join(normalizedBaseStateDir, 'run-state.json'),
    ...(sessionId ? [join(normalizedBaseStateDir, 'sessions', sessionId, 'run-state.json')] : []),
    join(normalizedBaseStateDir, 'skill-active-state.json'),
    ...(sessionId ? [join(normalizedBaseStateDir, 'sessions', sessionId, 'skill-active-state.json')] : []),
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

export async function restoreWorkflowStateSnapshot(
  snapshot: WorkflowStateSnapshot,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  for (const file of snapshot.files) {
    if (file.content === null) {
      await rm(file.path, { force: true });
      await syncDirectory(dirname(file.path));
      continue;
    }
    await writeDurableFile(file.path, file.content, dependencies);
  }
}

function transactionPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_TRANSACTION_FILE);
}

function recoveryOwnerPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_RECOVERY_OWNER_FILE);
}

function relativeStateTransactionPath(baseStateDir: string, path: string): string {
  const resolvedPath = resolve(path);
  const normalized = relative(resolve(baseStateDir), resolvedPath);
  if (
    normalized
    && !isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) return normalized;
  throw new Error(`workflow_state_transaction_invalid:path:${path}`);
}

function contextRootForCwd(cwd: string): string {
  return join(resolve(cwd), '.omx', 'context');
}

async function assertSafeContextRoot(contextRoot: string): Promise<void> {
  const omxDir = dirname(contextRoot);
  const omxStat = await lstat(omxDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (omxStat?.isSymbolicLink()) {
    throw new Error(`workflow_state_transaction_invalid:context_root:${contextRoot}`);
  }
  const contextStat = await lstat(contextRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (contextStat && (!contextStat.isDirectory() || contextStat.isSymbolicLink())) {
    throw new Error(`workflow_state_transaction_invalid:context_root:${contextRoot}`);
  }
}

function validateContextTransactionRelativePath(path: string): string {
  const normalized = path;
  if (
    !normalized
    || isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || normalized.includes('/')
    || normalized.includes('\\')
    || !/^[a-z0-9-]+-\d{8}T\d{6}Z(?:-\d+)?\.md$/.test(normalized)
  ) {
    throw new Error(`workflow_state_transaction_invalid:context_path:${path}`);
  }
  return normalized;
}

function relativeContextTransactionPath(contextRoot: string, path: string): string {
  return validateContextTransactionRelativePath(relative(resolve(contextRoot), resolve(path)));
}

async function persistedEntryPath(
  baseStateDir: string,
  contextRoot: string,
  path: string,
): Promise<Pick<PersistedWorkflowStateTransactionEntry, 'scope' | 'path'>> {
  try {
    return { scope: 'state', path: relativeStateTransactionPath(baseStateDir, path) };
  } catch {
    await assertSafeContextRoot(contextRoot);
    return { scope: 'context', path: relativeContextTransactionPath(contextRoot, path) };
  }
}

async function snapshotFromPersisted(
  baseStateDir: string,
  persisted: unknown,
  trustedCwd: string,
): Promise<WorkflowStateSnapshot> {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) {
    throw new Error('workflow_state_transaction_invalid:schema');
  }
  const record = persisted as Partial<PersistedWorkflowStateTransaction>;
  if (
    (record.version !== 3 && record.version !== 4 && record.version !== 5)
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

  const contextRoot = contextRootForCwd(trustedCwd);
  const hasContextEntries = record.files.some((file) => file?.scope === 'context');
  if (record.version === 4 && hasContextEntries) {
    throw new Error('workflow_state_transaction_invalid:context_provenance');
  }
  if (
    record.version === 5
    && hasContextEntries
    && (
      typeof record.context_root_sha256 !== 'string'
      || record.context_root_sha256 !== sha256(Buffer.from(resolve(contextRoot), 'utf-8'))
    )
  ) {
    throw new Error('workflow_state_transaction_invalid:context_provenance');
  }
  return {
    files: await Promise.all(record.files.map(async (file) => {
      if (
        !file
        || typeof file.path !== 'string'
        || !Object.prototype.hasOwnProperty.call(file, 'content_base64')
        || !Object.prototype.hasOwnProperty.call(file, 'byte_length')
        || !Object.prototype.hasOwnProperty.call(file, 'sha256')
      ) {
        throw new Error('workflow_state_transaction_invalid:entry');
      }
      if (record.version !== 3 && file.scope !== 'state' && file.scope !== 'context') {
        throw new Error('workflow_state_transaction_invalid:entry_scope');
      }
      if (isAbsolute(file.path)) {
        throw new Error('workflow_state_transaction_invalid:absolute_path');
      }
      let path: string;
      if (record.version === 5 && file.scope === 'context') {
        await assertSafeContextRoot(contextRoot);
        path = resolve(contextRoot, validateContextTransactionRelativePath(file.path));
      } else {
        path = resolve(baseStateDir, file.path);
        relativeStateTransactionPath(baseStateDir, path);
      }
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
    })),
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
  cwd: string,
  snapshot: WorkflowStateSnapshot,
  transactionId: string,
  lockToken: string,
  lockGeneration: string,
  dependencies: WorkflowStateTransactionDependencies,
): Promise<void> {
  const path = transactionPath(baseStateDir);
  const contextRoot = contextRootForCwd(cwd);
  const files = await Promise.all(snapshot.files.map(async (file) => ({
    ...await persistedEntryPath(baseStateDir, contextRoot, file.path),
    content_base64: file.content?.toString('base64') ?? null,
    byte_length: file.content?.length ?? null,
    sha256: file.content ? sha256(file.content) : null,
  })));
  const persisted: PersistedWorkflowStateTransaction = {
    version: 5,
    transaction_id: transactionId,
    lock_token: lockToken,
    lock_generation: lockGeneration,
    context_root_sha256: files.some((file) => file.scope === 'context')
      ? sha256(Buffer.from(resolve(contextRoot), 'utf-8'))
      : undefined,
    files,
  };
  await writeDurableFile(path, Buffer.from(JSON.stringify(persisted), 'utf-8'), dependencies);
}

async function writeDurableFile(
  path: string,
  content: Buffer,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  const parentDir = dirname(path);
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(parentDir, { recursive: true });
  const handle = await open(tempPath, 'w');
  try {
    try {
      await handle.writeFile(content);
      await dependencies.hook?.('before-file-sync', path);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await rename(tempPath, path);
  await syncDirectory(parentDir, dependencies);
}

async function syncDirectory(
  path: string,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent !== path) await syncDirectory(parent, dependencies);
    return;
  }
  try {
    await dependencies.hook?.('before-directory-sync', path);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeWorkflowStateTransaction(
  baseStateDir: string,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  const path = transactionPath(baseStateDir);
  await dependencies.hook?.('before-journal-delete', path);
  await rm(path, { force: true });
  await syncDirectory(baseStateDir, dependencies);
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

async function syncWorkflowStatePaths(
  snapshot: WorkflowStateSnapshot,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  for (const file of snapshot.files) {
    try {
      const handle = await open(file.path, 'r');
      try {
        await dependencies.hook?.('before-file-sync', file.path);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await syncDirectory(dirname(file.path), dependencies);
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
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<string> {
  const path = transactionPath(baseStateDir);
  const quarantinePath = `${path}.${reason}.${Date.now()}.${randomUUID()}.rejected`;
  await rename(path, quarantinePath);
  await syncDirectory(baseStateDir, dependencies);
  return quarantinePath;
}

export async function recoverWorkflowStateTransactionUnderLock(
  baseStateDir: string,
  trustedCwd: string,
  lockLease: WorkflowStateLockLease,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<boolean> {
  await lockLease.assertOwned();
  const path = transactionPath(baseStateDir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(recoveryOwnerPath(baseStateDir), { force: true });
      await syncDirectory(baseStateDir, dependencies);
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
    const quarantinePath = await quarantineWorkflowStateTransaction(baseStateDir, 'ownerless', dependencies);
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
    const quarantinePath = await quarantineWorkflowStateTransaction(baseStateDir, 'foreign', dependencies);
    throw new Error(`workflow_state_transaction_recovery_rejected:foreign:${quarantinePath}`);
  }
  const snapshot = await snapshotFromPersisted(baseStateDir, persisted, trustedCwd);
  await lockLease.assertOwned();
  await restoreWorkflowStateSnapshot(snapshot, dependencies);
  await lockLease.assertOwned();
  await removeWorkflowStateTransaction(baseStateDir, dependencies);
  await rm(recoveryOwnerPath(baseStateDir), { force: true });
  await syncDirectory(baseStateDir, dependencies);
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
    dependencies?: WorkflowStateTransactionDependencies;
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
  const reservation = Symbol(path);
  activeTransactions.set(path, reservation);

  try {
    await options.lockLease.assertOwned();

    const snapshot = await captureWorkflowStateSnapshot(cwd, sessionId, extraPaths, baseStateDir);
    const transactionId = randomUUID();
    try {
      await writeWorkflowStateTransaction(
        baseStateDir,
        cwd,
        snapshot,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
        options.dependencies ?? {},
      );
    } catch (error) {
      try {
        await removeWorkflowStateTransaction(baseStateDir, options.dependencies);
      } catch (cleanupError) {
        try {
          await options.lockLease.markRecoveryRequired();
        } catch (provenanceError) {
          throw new AggregateError(
            [error, cleanupError, provenanceError],
            `workflow_state_transaction_initialization_recovery_provenance_failed:${String(error)}`,
          );
        }
        throw new AggregateError(
          [error, cleanupError],
          `workflow_state_transaction_initialization_cleanup_failed:${String(error)}`,
        );
      }
      throw error;
    }
    const acquiredLease: WorkflowStateTransactionLease = Object.freeze({
      journalPath: path,
      transactionId,
      capturePath: async (capturedPath: string) => {
        await options.lockLease!.assertOwned();
        const normalizedPath = resolve(capturedPath);
        await persistedEntryPath(baseStateDir, contextRootForCwd(cwd), normalizedPath);
        if (snapshot.files.some((file) => resolve(file.path) === normalizedPath)) return;
        snapshot.files.push({
          path: normalizedPath,
          content: await readFile(normalizedPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          }),
        });
        await writeWorkflowStateTransaction(
          baseStateDir,
          cwd,
          snapshot,
          transactionId,
          options.lockLease!.token,
          options.lockLease!.generation,
          options.dependencies ?? {},
        );
      },
    });
    activeLeases.add(acquiredLease);
    activeTransactions.set(path, acquiredLease);

    try {
      const result = await fn(acquiredLease);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        baseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await syncWorkflowStatePaths(snapshot, options.dependencies);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        baseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await removeWorkflowStateTransaction(baseStateDir, options.dependencies);
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
        await restoreWorkflowStateSnapshot(snapshot, options.dependencies);
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(
          baseStateDir,
          transactionId,
          options.lockLease.token,
          options.lockLease.generation,
        );
        await removeWorkflowStateTransaction(baseStateDir, options.dependencies);
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
    } finally {
      activeLeases.delete(acquiredLease);
      if (activeTransactions.get(path) === acquiredLease) activeTransactions.delete(path);
    }
  } finally {
    if (activeTransactions.get(path) === reservation) activeTransactions.delete(path);
  }
}
