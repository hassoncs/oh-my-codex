import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_STALE_MS = 120_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;

function ownerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function recoverStaleLock(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs <= LOCK_STALE_MS) return false;
    await rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function withWorkflowStateLock<T>(
  baseStateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(baseStateDir, '.workflow-state.lock');
  const ownerPath = join(lockDir, 'owner');
  const token = ownerToken();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  await mkdir(baseStateDir, { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      await writeFile(ownerPath, token, 'utf-8');
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      if (await recoverStaleLock(lockDir)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`workflow_state_lock_timeout:${baseStateDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  try {
    return await fn();
  } finally {
    const currentOwner = await readFile(ownerPath, 'utf-8').catch(() => '');
    if (currentOwner.trim() === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}
