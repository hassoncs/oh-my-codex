import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getBaseStateDir } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';
import type { WorkflowStateLockLease } from './workflow-state-lock.js';

const WORKFLOW_STATE_TRANSACTION_FILE = '.workflow-state-transaction.json';
export const WORKFLOW_STATE_RECOVERY_OWNER_FILE = '.workflow-state-recovery-owner.json';

export interface WorkflowStateSnapshot {
  files: Array<{
    scope: 'state' | 'context';
    root: string;
    path: string;
    content: Buffer | null;
  }>;
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
  realpath?: (path: string) => Promise<string>;
  rm?: (path: string, options?: { force?: boolean }) => Promise<void>;
}

export interface WorkflowStateTransactionLease {
  readonly baseStateDir: string;
  readonly contextRoot: string;
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
const OUTSIDE_STATE_TRANSACTION_ROOT = Symbol('outside-state-transaction-root');

async function missingOnly<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function captureWorkflowStateSnapshot(
  cwd: string,
  sessionId?: string,
  extraPaths: string[] = [],
  baseStateDir: string = getBaseStateDir(cwd),
  stateRootAlias: string = baseStateDir,
  contextRoot: string = contextRootForCwd(cwd),
  contextRootAlias: string = contextRoot,
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
    files: await Promise.all([...new Set(paths)].map(async (path) => {
      const captured = await persistedEntryPath(
        normalizedBaseStateDir,
        contextRoot,
        resolve(path),
        stateRootAlias,
        contextRootAlias,
      );
      return {
        scope: captured.scope,
        root: captured.scope === 'state' ? normalizedBaseStateDir : dirname(captured.absolutePath),
        path: captured.absolutePath,
        content: await readFile(captured.absolutePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }),
      };
    })),
  };
}

async function safeSnapshotPath(
  file: WorkflowStateSnapshot['files'][number],
): Promise<string> {
  if (file.scope === 'state') {
    return (await safeStateTransactionPath(file.root, file.path)).absolutePath;
  }
  return safeContextTransactionPath(file.root, file.path);
}

export async function restoreWorkflowStateSnapshot(
  snapshot: WorkflowStateSnapshot,
  dependencies: WorkflowStateTransactionDependencies = {},
): Promise<void> {
  for (const file of snapshot.files) {
    const path = await safeSnapshotPath(file);
    if (file.content === null) {
      await rm(path, { force: true });
      await syncDirectory(dirname(path));
      continue;
    }
    await writeDurableFile(path, file.content, dependencies, () => safeSnapshotPath(file));
  }
}

function transactionPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_TRANSACTION_FILE);
}

function recoveryOwnerPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_RECOVERY_OWNER_FILE);
}

function relativeStateTransactionPath(baseStateDir: string, path: string): string {
  const normalized = relative(resolve(baseStateDir), resolve(path));
  if (
    normalized
    && !isAbsolute(normalized)
    && normalized !== '..'
    && !normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) return normalized;
  throw OUTSIDE_STATE_TRANSACTION_ROOT;
}

async function canonicalStateTransactionRoot(baseStateDir: string): Promise<string> {
  const normalizedRoot = resolve(baseStateDir);
  const rootStat = await lstat(normalizedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`workflow_state_transaction_invalid:state_root:${baseStateDir}`);
  }
  return realpath(normalizedRoot);
}

async function assertRequestedStateTransactionRoot(
  requestedRoot: string,
  canonicalRoot: string,
  dependencies: WorkflowStateTransactionDependencies,
): Promise<void> {
  const currentRoot = await missingOnly(
    () => (dependencies.realpath ?? realpath)(resolve(requestedRoot)),
  );
  if (currentRoot !== canonicalRoot) {
    throw new Error(`workflow_state_transaction_root_changed:${requestedRoot}`);
  }
}

async function safeStateTransactionPath(
  baseStateDir: string,
  path: string,
): Promise<{ absolutePath: string; relativePath: string }> {
  const normalizedRoot = resolve(baseStateDir);
  const canonicalRoot = await canonicalStateTransactionRoot(normalizedRoot);
  let relativePath: string;
  try {
    relativePath = relativeStateTransactionPath(normalizedRoot, path);
  } catch (error) {
    if (error !== OUTSIDE_STATE_TRANSACTION_ROOT) throw error;
    relativePath = relativeStateTransactionPath(canonicalRoot, path);
  }

  let currentPath = canonicalRoot;
  const parts = relativePath.split(/[\\/]/);
  for (const [index, part] of parts.entries()) {
    currentPath = join(currentPath, part);
    const pathStat = await lstat(currentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!pathStat) break;
    if (pathStat.isSymbolicLink() || (index < parts.length - 1 && !pathStat.isDirectory())) {
      throw new Error(`workflow_state_transaction_invalid:state_path:${path}`);
    }
  }
  return { absolutePath: resolve(canonicalRoot, relativePath), relativePath };
}

function contextRootForCwd(cwd: string): string {
  return join(resolve(cwd), '.omx', 'context');
}

async function canonicalContextRoot(contextRoot: string): Promise<string> {
  const cwd = dirname(dirname(resolve(contextRoot)));
  return join(await realpath(cwd), '.omx', 'context');
}

async function assertRequestedContextTransactionRoot(
  requestedCwd: string,
  canonicalRoot: string,
  dependencies: WorkflowStateTransactionDependencies,
): Promise<void> {
  const currentRoot = await missingOnly(async () => {
    const cwd = dirname(dirname(resolve(contextRootForCwd(requestedCwd))));
    return join(await (dependencies.realpath ?? realpath)(cwd), '.omx', 'context');
  });
  if (currentRoot !== canonicalRoot) {
    throw new Error(`workflow_state_transaction_context_root_changed:${requestedCwd}`);
  }
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

function isValidContextTransactionRelativePath(path: string): boolean {
  return Boolean(
    path
    && !isAbsolute(path)
    && path !== '..'
    && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !path.includes('/')
    && !path.includes('\\')
    && /^[a-z0-9-]+-\d{8}T\d{6}Z(?:-\d+)?\.md$/.test(path)
  );
}

function validateContextTransactionRelativePath(path: string): string {
  if (!isValidContextTransactionRelativePath(path)) {
    throw new Error(`workflow_state_transaction_invalid:context_path:${path}`);
  }
  return path;
}

function relativeContextTransactionPath(contextRoot: string, path: string): string {
  return validateContextTransactionRelativePath(relative(resolve(contextRoot), resolve(path)));
}

async function safeContextTransactionPath(contextRoot: string, path: string): Promise<string> {
  const canonicalRoot = await canonicalContextRoot(contextRoot);
  await assertSafeContextRoot(canonicalRoot);
  const resolvedPath = resolve(path);
  const lexicalRelative = relative(resolve(contextRoot), resolvedPath);
  const canonicalRelative = relative(canonicalRoot, resolvedPath);
  const relativePath = [lexicalRelative, canonicalRelative]
    .find(isValidContextTransactionRelativePath);
  if (!relativePath) {
    throw new Error(`workflow_state_transaction_invalid:context_path:${path}`);
  }
  const absolutePath = resolve(canonicalRoot, relativePath);
  const pathStat = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pathStat?.isSymbolicLink()) {
    throw new Error(`workflow_state_transaction_invalid:context_path:${path}`);
  }
  return absolutePath;
}

async function persistedEntryPath(
  baseStateDir: string,
  contextRoot: string,
  path: string,
  stateRootAlias: string = baseStateDir,
  contextRootAlias: string = contextRoot,
): Promise<{
  scope: 'state' | 'context';
  path: string;
  absolutePath: string;
}> {
  try {
    let stateCandidate = path;
    try {
      const relativePath = relativeStateTransactionPath(stateRootAlias, path);
      stateCandidate = resolve(baseStateDir, relativePath);
    } catch (error) {
      if (error !== OUTSIDE_STATE_TRANSACTION_ROOT) throw error;
    }
    const statePath = await safeStateTransactionPath(baseStateDir, stateCandidate);
    return { scope: 'state', path: statePath.relativePath, absolutePath: statePath.absolutePath };
  } catch (error) {
    if (error !== OUTSIDE_STATE_TRANSACTION_ROOT) throw error;
    let contextCandidate = path;
    try {
      const relativePath = relativeContextTransactionPath(contextRootAlias, path);
      contextCandidate = resolve(contextRoot, relativePath);
    } catch {
      // Canonical context paths bypass alias translation.
    }
    const absolutePath = await safeContextTransactionPath(contextRoot, contextCandidate);
    return {
      scope: 'context',
      path: relativeContextTransactionPath(await canonicalContextRoot(contextRoot), absolutePath),
      absolutePath,
    };
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
      || record.context_root_sha256 !== sha256(Buffer.from(await canonicalContextRoot(contextRoot), 'utf-8'))
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
      let scope: 'state' | 'context';
      let root: string;
      let path: string;
      if (record.version === 5 && file.scope === 'context') {
        scope = 'context';
        path = await safeContextTransactionPath(contextRoot, resolve(contextRoot, file.path));
        root = dirname(path);
      } else {
        scope = 'state';
        root = resolve(baseStateDir);
        try {
          path = (await safeStateTransactionPath(baseStateDir, resolve(baseStateDir, file.path))).absolutePath;
        } catch (error) {
          if (error === OUTSIDE_STATE_TRANSACTION_ROOT) {
            throw new Error(`workflow_state_transaction_invalid:path:${file.path}`);
          }
          throw error;
        }
      }
      if (file.content_base64 === null) {
        if (file.byte_length !== null || file.sha256 !== null) {
          throw new Error('workflow_state_transaction_invalid:null_entry');
        }
        return { scope, root, path, content: null };
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
        scope,
        root,
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
  contextRoot: string,
  snapshot: WorkflowStateSnapshot,
  transactionId: string,
  lockToken: string,
  lockGeneration: string,
  dependencies: WorkflowStateTransactionDependencies,
): Promise<void> {
  const path = transactionPath(baseStateDir);
  const files = await Promise.all(snapshot.files.map(async (file) => {
    const entry = await persistedEntryPath(baseStateDir, contextRoot, file.path);
    return {
      scope: entry.scope,
      path: entry.path,
      content_base64: file.content?.toString('base64') ?? null,
      byte_length: file.content?.length ?? null,
      sha256: file.content ? sha256(file.content) : null,
    };
  }));
  const persisted: PersistedWorkflowStateTransaction = {
    version: 5,
    transaction_id: transactionId,
    lock_token: lockToken,
    lock_generation: lockGeneration,
    context_root_sha256: files.some((file) => file.scope === 'context')
      ? sha256(Buffer.from(await canonicalContextRoot(contextRoot), 'utf-8'))
      : undefined,
    files,
  };
  await writeDurableFile(
    path,
    Buffer.from(JSON.stringify(persisted), 'utf-8'),
    dependencies,
    async () => (await safeStateTransactionPath(baseStateDir, path)).absolutePath,
  );
}

async function writeDurableFile(
  path: string,
  content: Buffer,
  dependencies: WorkflowStateTransactionDependencies = {},
  validatePath?: () => Promise<string>,
): Promise<void> {
  const safePath = await validatePath?.() ?? path;
  const parentDir = dirname(safePath);
  const tempPath = `${safePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await mkdir(parentDir, { recursive: true });
  await validatePath?.();
  try {
    const handle = await open(tempPath, 'w');
    try {
      await handle.writeFile(content);
      await dependencies.hook?.('before-file-sync', path);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await validatePath?.();
    await rename(tempPath, safePath);
    await syncDirectory(parentDir, dependencies);
  } catch (error) {
    try {
      await (dependencies.rm ?? rm)(tempPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `workflow_state_transaction_temp_cleanup_failed:${String(error)}`,
      );
    }
    throw error;
  }
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
  const safePath = (await safeStateTransactionPath(baseStateDir, path)).absolutePath;
  await dependencies.hook?.('before-journal-delete', path);
  await safeStateTransactionPath(baseStateDir, path);
  await rm(safePath, { force: true });
  await syncDirectory(dirname(safePath), dependencies);
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
    const safePath = (await safeStateTransactionPath(baseStateDir, path)).absolutePath;
    parsed = JSON.parse(await readFile(safePath, 'utf-8'));
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
    const path = await safeSnapshotPath(file);
    try {
      const handle = await open(path, 'r');
      try {
        await dependencies.hook?.('before-file-sync', path);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await syncDirectory(dirname(path), dependencies);
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
  const safePath = (await safeStateTransactionPath(baseStateDir, path)).absolutePath;
  const safeQuarantinePath = (await safeStateTransactionPath(baseStateDir, quarantinePath)).absolutePath;
  await rename(safePath, safeQuarantinePath);
  await syncDirectory(dirname(safePath), dependencies);
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
  const safePath = (await safeStateTransactionPath(baseStateDir, path)).absolutePath;
  const ownerPath = recoveryOwnerPath(baseStateDir);
  const safeOwnerPath = (await safeStateTransactionPath(baseStateDir, ownerPath)).absolutePath;
  let raw: string;
  try {
    raw = await readFile(safePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(safeOwnerPath, { force: true });
      await syncDirectory(dirname(safeOwnerPath), dependencies);
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
  const recoveryOwnerRaw = await readFile(safeOwnerPath, 'utf-8').catch(
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
  await safeStateTransactionPath(baseStateDir, ownerPath);
  await rm(safeOwnerPath, { force: true });
  await syncDirectory(dirname(safeOwnerPath), dependencies);
  return true;
}

export async function withWorkflowStateTransaction<T>(
  baseStateDirInput: string,
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
  const dependencies = options.dependencies ?? {};
  const requestedBaseStateDir = await canonicalStateTransactionRoot(baseStateDirInput);
  const transactionContextRootAlias = contextRootForCwd(cwd);
  const transactionContextRoot = await canonicalContextRoot(transactionContextRootAlias);
  if (options.lockLease && options.lockLease.baseStateDir !== requestedBaseStateDir) {
    throw new Error(`workflow_state_transaction_lock_root_mismatch:${baseStateDirInput}`);
  }
  const transactionBaseStateDir = options.lockLease?.baseStateDir ?? requestedBaseStateDir;
  const path = transactionPath(transactionBaseStateDir);
  if (options.transactionLease) {
    if (
      !activeLeases.has(options.transactionLease)
      || activeTransactions.get(path) !== options.transactionLease
      || options.transactionLease.journalPath !== path
      || options.transactionLease.contextRoot !== transactionContextRoot
    ) {
      throw new Error(`workflow_state_transaction_invalid_lease:${transactionBaseStateDir}`);
    }
    return fn(options.transactionLease);
  }
  if (!options.lockLease) throw new Error(`workflow_state_transaction_lock_required:${transactionBaseStateDir}`);
  if (activeTransactions.has(path)) {
    throw new Error(`workflow_state_transaction_contended:${transactionBaseStateDir}`);
  }
  const reservation = Symbol(path);
  activeTransactions.set(path, reservation);

  try {
    await options.lockLease.assertOwned();
    await assertRequestedStateTransactionRoot(
      baseStateDirInput,
      transactionBaseStateDir,
      dependencies,
    );
    await assertRequestedContextTransactionRoot(
      cwd,
      transactionContextRoot,
      dependencies,
    );

    const snapshot = await captureWorkflowStateSnapshot(
      cwd,
      sessionId,
      extraPaths,
      transactionBaseStateDir,
      baseStateDirInput,
      transactionContextRoot,
      transactionContextRootAlias,
    );
    const transactionId = randomUUID();
    try {
      await writeWorkflowStateTransaction(
        transactionBaseStateDir,
        transactionContextRoot,
        snapshot,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
        dependencies,
      );
    } catch (error) {
      try {
        await removeWorkflowStateTransaction(transactionBaseStateDir, dependencies);
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
    let captureTail = Promise.resolve();
    let capturesOpen = true;
    const acquiredLease: WorkflowStateTransactionLease = Object.freeze({
      baseStateDir: transactionBaseStateDir,
      contextRoot: transactionContextRoot,
      journalPath: path,
      transactionId,
      capturePath: (capturedPath: string) => {
        if (!capturesOpen) {
          return Promise.reject(new Error(`workflow_state_transaction_closed_lease:${transactionBaseStateDir}`));
        }
        const capture = captureTail.then(async () => {
          await options.lockLease!.assertOwned();
          await assertRequestedStateTransactionRoot(
            baseStateDirInput,
            transactionBaseStateDir,
            dependencies,
          );
          await assertRequestedContextTransactionRoot(
            cwd,
            transactionContextRoot,
            dependencies,
          );
          const captured = await persistedEntryPath(
            transactionBaseStateDir,
            transactionContextRoot,
            resolve(capturedPath),
            baseStateDirInput,
            transactionContextRootAlias,
          );
          if (snapshot.files.some((file) => resolve(file.path) === captured.absolutePath)) return;
          snapshot.files.push({
            scope: captured.scope,
            root: captured.scope === 'state' ? resolve(transactionBaseStateDir) : dirname(captured.absolutePath),
            path: captured.absolutePath,
            content: await readFile(captured.absolutePath).catch((error: NodeJS.ErrnoException) => {
              if (error.code === 'ENOENT') return null;
              throw error;
            }),
          });
          await writeWorkflowStateTransaction(
            transactionBaseStateDir,
            transactionContextRoot,
            snapshot,
            transactionId,
            options.lockLease!.token,
            options.lockLease!.generation,
            dependencies,
          );
        });
        captureTail = capture;
        return capture;
      },
    });
    activeLeases.add(acquiredLease);
    activeTransactions.set(path, acquiredLease);

    try {
      let callbackError: unknown;
      let callbackFailed = false;
      let result!: T;
      try {
        result = await fn(acquiredLease);
      } catch (error) {
        callbackError = error;
        callbackFailed = true;
      }
      capturesOpen = false;
      try {
        await captureTail;
      } catch (captureError) {
        if (callbackFailed) {
          throw new AggregateError(
            [callbackError, captureError],
            `workflow_state_transaction_capture_failed:${String(callbackError)}`,
          );
        }
        throw captureError;
      }
      try {
        await assertRequestedStateTransactionRoot(
          baseStateDirInput,
          transactionBaseStateDir,
          dependencies,
        );
        await assertRequestedContextTransactionRoot(
          cwd,
          transactionContextRoot,
          dependencies,
        );
      } catch (rootError) {
        if (callbackFailed) {
          throw new AggregateError(
            [callbackError, rootError],
            `workflow_state_transaction_root_changed:${baseStateDirInput}`,
          );
        }
        throw rootError;
      }
      if (callbackFailed) throw callbackError;
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        transactionBaseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await syncWorkflowStatePaths(snapshot, dependencies);
      await options.lockLease.assertOwned();
      await assertWorkflowStateTransactionOwned(
        transactionBaseStateDir,
        transactionId,
        options.lockLease.token,
        options.lockLease.generation,
      );
      await removeWorkflowStateTransaction(transactionBaseStateDir, dependencies);
      return result;
    } catch (error) {
      try {
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(
          transactionBaseStateDir,
          transactionId,
          options.lockLease.token,
          options.lockLease.generation,
        );
        await restoreWorkflowStateSnapshot(snapshot, dependencies);
        await options.lockLease.assertOwned();
        await assertWorkflowStateTransactionOwned(
          transactionBaseStateDir,
          transactionId,
          options.lockLease.token,
          options.lockLease.generation,
        );
        await removeWorkflowStateTransaction(transactionBaseStateDir, dependencies);
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
