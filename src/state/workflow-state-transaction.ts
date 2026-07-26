import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { getStateFilePath, getStatePath } from '../mcp/state-paths.js';
import { TRACKED_WORKFLOW_MODES } from './workflow-transition.js';

export interface WorkflowStateSnapshot {
  files: Array<{ path: string; content: Buffer | null }>;
}

export async function captureWorkflowStateSnapshot(
  cwd: string,
  sessionId?: string,
): Promise<WorkflowStateSnapshot> {
  const paths = [
    ...TRACKED_WORKFLOW_MODES.map((mode) => getStatePath(mode, cwd, sessionId)),
    getStateFilePath('run-state.json', cwd, sessionId),
    getStateFilePath('skill-active-state.json', cwd),
    getStateFilePath('skill-active-state.json', cwd, sessionId),
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
