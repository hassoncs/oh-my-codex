import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { getStateFilePath, getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';

const WORKFLOW_STATE_TRANSACTION_FILE = '.workflow-state-transaction.json';

export interface WorkflowStateSnapshot {
  files: Array<{ path: string; content: Buffer | null }>;
}

interface PersistedWorkflowStateTransaction {
  version: 1;
  files: Array<{ path: string; content: string | null }>;
}

const transactionContext = new AsyncLocalStorage<Map<string, { active: boolean }>>();

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
      continue;
    }
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
  }
}

function transactionPath(baseStateDir: string): string {
  return join(resolve(baseStateDir), WORKFLOW_STATE_TRANSACTION_FILE);
}

function relativeTransactionPath(baseStateDir: string, path: string): string {
  const normalized = relative(resolve(baseStateDir), resolve(path));
  if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`workflow_state_transaction_path_outside_root:${path}`);
  }
  return normalized;
}

function snapshotFromPersisted(
  baseStateDir: string,
  persisted: PersistedWorkflowStateTransaction,
): WorkflowStateSnapshot {
  if (persisted.version !== 1 || !Array.isArray(persisted.files)) {
    throw new Error('workflow_state_transaction_invalid');
  }
  return {
    files: persisted.files.map((file) => {
      if (
        !file
        || typeof file.path !== 'string'
        || (file.content !== null && typeof file.content !== 'string')
      ) {
        throw new Error('workflow_state_transaction_invalid');
      }
      const path = resolve(baseStateDir, file.path);
      relativeTransactionPath(baseStateDir, path);
      return {
        path,
        content: file.content === null ? null : Buffer.from(file.content, 'base64'),
      };
    }),
  };
}

async function writeWorkflowStateTransaction(
  baseStateDir: string,
  snapshot: WorkflowStateSnapshot,
): Promise<void> {
  const path = transactionPath(baseStateDir);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const persisted: PersistedWorkflowStateTransaction = {
    version: 1,
    files: snapshot.files.map((file) => ({
      path: relativeTransactionPath(baseStateDir, file.path),
      content: file.content?.toString('base64') ?? null,
    })),
  };
  await mkdir(baseStateDir, { recursive: true });
  const handle = await open(tempPath, 'w');
  try {
    await handle.writeFile(JSON.stringify(persisted), 'utf-8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, path);
  await syncDirectory(baseStateDir);
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

async function removeWorkflowStateTransaction(baseStateDir: string): Promise<void> {
  await rm(transactionPath(baseStateDir), { force: true });
  await syncDirectory(baseStateDir);
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
  const snapshot = snapshotFromPersisted(
    baseStateDir,
    JSON.parse(raw) as PersistedWorkflowStateTransaction,
  );
  await restoreWorkflowStateSnapshot(snapshot);
  await removeWorkflowStateTransaction(baseStateDir);
  return true;
}

export async function withWorkflowStateTransaction<T>(
  baseStateDir: string,
  cwd: string,
  sessionId: string | undefined,
  fn: () => Promise<T>,
  extraPaths: string[] = [],
): Promise<T> {
  const path = transactionPath(baseStateDir);
  if (transactionContext.getStore()?.get(path)?.active) return fn();

  const snapshot = await captureWorkflowStateSnapshot(cwd, sessionId, extraPaths);
  await writeWorkflowStateTransaction(baseStateDir, snapshot);
  const marker = { active: true };
  const active = new Map(transactionContext.getStore() ?? []);
  active.set(path, marker);

  return transactionContext.run(active, async () => {
    try {
      const result = await fn();
      await removeWorkflowStateTransaction(baseStateDir);
      return result;
    } catch (error) {
      try {
        await restoreWorkflowStateSnapshot(snapshot);
        await removeWorkflowStateTransaction(baseStateDir);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `workflow_state_transaction_rollback_failed:${String(error)}`,
        );
      }
      throw error;
    } finally {
      marker.active = false;
    }
  });
}
