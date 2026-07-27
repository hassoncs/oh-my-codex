import { existsSync } from 'fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

interface TeamPathDeps {
  teamDir: (teamName: string, cwd: string) => string;
  taskClaimLockDir: (teamName: string, taskId: string, cwd: string) => string;
  mailboxLockDir: (teamName: string, workerName: string, cwd: string) => string;
  renameLockDir?: (from: string, to: string) => Promise<void>;
}

interface WorkerStatusPathDeps extends TeamPathDeps {
  workerStatusLockDir: (teamName: string, workerName: string, cwd: string) => string;
}

const LOCK_OWNER_RETRY_MS = 25;

function lockOwnerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

interface LockSnapshot {
  dev: number;
  ino: number;
  mtimeMs: number;
  owner: string | null;
}

async function readLockSnapshot(lockDir: string): Promise<LockSnapshot | null> {
  try {
    const before = await stat(lockDir);
    let owner: string | null = null;
    try {
      owner = (await readFile(join(lockDir, 'owner'), 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const after = await stat(lockDir);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) return null;
    return { dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function lockOwnerIsAlive(owner: string | null): boolean {
  const match = owner?.match(/^(\d+)\./);
  if (!match) return false;
  const pid = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeMs === right.mtimeMs
    && left.owner === right.owner;
}

async function maybeRecoverStaleLock(
  lockDir: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
): Promise<boolean> {
  const observed = await readLockSnapshot(lockDir);
  if (!observed || Date.now() - observed.mtimeMs <= lockStaleMs || lockOwnerIsAlive(observed.owner)) return false;

  const quarantineDir = `${lockDir}.stale-${lockOwnerToken()}`;
  try {
    await (deps.renameLockDir ?? rename)(lockDir, quarantineDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const quarantined = await readLockSnapshot(quarantineDir);
  if (!quarantined || !sameLockSnapshot(observed, quarantined)) {
    try {
      await rename(quarantineDir, lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`Lock recovery conflict for ${lockDir}; preserved replacement at ${quarantineDir}`);
      }
      throw error;
    }
    return false;
  }

  await rm(quarantineDir, { recursive: true, force: true });
  return true;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withScalingLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  const lockDir = join(deps.teamDir(teamName, cwd), '.lock.scaling');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 10_000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs, deps)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring scaling lock for team ${teamName}`);
      }
      await sleep(50);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withTeamLock<T>(
  teamName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  // On-disk name is compatibility ABI with older installed createTask writers.
  const lockDir = join(deps.teamDir(teamName, cwd), '.lock.create-task');
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs, deps)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring team lifecycle lock for ${teamName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withTaskClaimLock<T>(
  teamName: string,
  taskId: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const lockDir = deps.taskClaimLockDir(teamName, taskId, cwd);
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      await mkdir(lockDir);
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs, deps)) continue;
      if (Date.now() > deadline) return { ok: false };
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    try {
      await writeFile(ownerPath, ownerToken, 'utf8');
    } catch (error) {
      await rm(lockDir, { recursive: true, force: true });
      throw error;
    }
    return { ok: true, value: await fn() };
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

async function withWorkerScopedLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  lockDir: string,
  lockKind: string,
  fn: () => Promise<T>,
): Promise<T> {
  const root = deps.teamDir(teamName, cwd);
  if (!existsSync(root)) {
    throw new Error(`Team ${teamName} not found`);
  }
  const ownerPath = join(lockDir, 'owner');
  const ownerToken = lockOwnerToken();
  const deadline = Date.now() + 5000;
  await mkdir(dirname(lockDir), { recursive: true });
  while (true) {
    try {
      await mkdir(lockDir, { recursive: false });
      try {
        await writeFile(ownerPath, ownerToken, 'utf8');
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true });
        throw error;
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw error;
      if (await maybeRecoverStaleLock(lockDir, lockStaleMs, deps)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out acquiring ${lockKind} lock for ${teamName}/${workerName}`);
      }
      await sleep(LOCK_OWNER_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      const currentOwner = await readFile(ownerPath, 'utf8');
      if (currentOwner.trim() === ownerToken) {
        await rm(lockDir, { recursive: true, force: true });
      }
    } catch {
    }
  }
}

export async function withMailboxLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  lockStaleMs: number,
  deps: TeamPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  return withWorkerScopedLock(
    teamName,
    workerName,
    cwd,
    lockStaleMs,
    deps,
    deps.mailboxLockDir(teamName, workerName, cwd),
    'mailbox',
    fn,
  );
}

export async function withWorkerStatusLock<T>(
  teamName: string,
  workerName: string,
  cwd: string,
  lockStaleMs: number,
  deps: WorkerStatusPathDeps,
  fn: () => Promise<T>,
): Promise<T> {
  return withWorkerScopedLock(
    teamName,
    workerName,
    cwd,
    lockStaleMs,
    deps,
    deps.workerStatusLockDir(teamName, workerName, cwd),
    'worker status',
    fn,
  );
}
