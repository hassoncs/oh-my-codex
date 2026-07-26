import { AsyncLocalStorage } from 'node:async_hooks';
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

interface WorkflowStateLockTestConfig {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  processIsAlive?: (pid: number) => boolean;
  hook?: (stage: 'contended' | 'before-stale-rename') => void | Promise<void>;
}

let testConfig: WorkflowStateLockTestConfig = {};
const lockContext = new AsyncLocalStorage<Map<string, { active: boolean }>>();

export function setWorkflowStateLockTestConfig(config: WorkflowStateLockTestConfig = {}): void {
  testConfig = config;
}

function ownerToken(): string {
  return `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
}

async function readOwner(path: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<LockOwner>;
    if (
      typeof parsed.token !== 'string'
      || !Number.isInteger(parsed.pid)
      || typeof parsed.heartbeat_at !== 'string'
    ) {
      return null;
    }
    return parsed as LockOwner;
  } catch {
    return null;
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
  await writeFile(tempPath, JSON.stringify(owner), 'utf-8');
  await rename(tempPath, path);
}

async function recoverStaleLock(lockDir: string, ownerPath: string, contenderToken: string): Promise<boolean> {
  const observedStat = await stat(lockDir).catch(() => null);
  const staleMs = testConfig.staleMs ?? DEFAULT_LOCK_STALE_MS;
  if (!observedStat || Date.now() - observedStat.mtimeMs <= staleMs) return false;

  const observedOwner = await readOwner(ownerPath);
  const heartbeatAt = observedOwner ? Date.parse(observedOwner.heartbeat_at) : Number.NaN;
  if (Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt <= staleMs) return false;
  if (observedOwner && processIsAlive(observedOwner.pid)) return false;

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
  const movedOwner = await readOwner(join(quarantineDir, 'owner'));
  const sameOwner = !observedOwner || movedOwner?.token === observedOwner.token;
  if (
    !movedStat
    || movedStat.dev !== observedStat.dev
    || movedStat.ino !== observedStat.ino
    || !sameOwner
  ) {
    await rename(quarantineDir, lockDir).catch(() => {});
    throw new Error(`workflow_state_lock_takeover_race:${lockDir}`);
  }

  await rm(quarantineDir, { recursive: true, force: true });
  return true;
}

export async function withWorkflowStateLock<T>(
  baseStateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const normalizedBaseStateDir = resolve(baseStateDir);
  if (lockContext.getStore()?.get(normalizedBaseStateDir)?.active) return fn();

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

  const heartbeat = setInterval(() => {
    void writeOwner(ownerPath, {
      token,
      pid: process.pid,
      heartbeat_at: new Date().toISOString(),
    }).catch(() => {});
  }, heartbeatMs);
  heartbeat.unref();

  try {
    const marker = { active: true };
    const active = new Map(lockContext.getStore() ?? []);
    active.set(normalizedBaseStateDir, marker);
    return await lockContext.run(active, async () => {
      try {
        await recoverWorkflowStateTransaction(normalizedBaseStateDir);
        return await fn();
      } finally {
        marker.active = false;
      }
    });
  } finally {
    clearInterval(heartbeat);
    const currentOwner = await readOwner(ownerPath);
    if (currentOwner?.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}
