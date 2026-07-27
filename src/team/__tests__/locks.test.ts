import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withWorkerStatusLock } from '../state/locks.js';

describe('worker-scoped stale lock recovery', () => {
  it('does not steal an aged lock from a live owner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-lock-live-owner-'));
    const teamName = 'lock-live-owner';
    const workerName = 'worker-1';
    const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
    const lockDir = join(teamRoot, 'workers', workerName, '.lock.status');
    const deps = {
      teamDir: () => teamRoot,
      taskClaimLockDir: () => join(teamRoot, 'claims', 'task-1.lock'),
      mailboxLockDir: () => join(teamRoot, 'mailbox', `.lock-${workerName}`),
      workerStatusLockDir: () => lockDir,
    };
    let active = 0;
    let maxActive = 0;
    let secondEntered = false;
    let releaseFirst: (() => void) | undefined;
    let signalFirstEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => {
      signalFirstEntered = resolve;
    });

    try {
      await mkdir(teamRoot, { recursive: true });
      const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = withWorkerStatusLock(teamName, workerName, cwd, 10, deps, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        signalFirstEntered?.();
        await firstReleased;
        active -= 1;
      });
      await firstEntered;

      const second = withWorkerStatusLock(teamName, workerName, cwd, 10, deps, async () => {
        secondEntered = true;
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.equal(secondEntered, false);
      assert.equal(active, 1);
      releaseFirst?.();
      await Promise.all([first, second]);
      assert.equal(maxActive, 1);
      assert.equal(secondEntered, true);
    } finally {
      releaseFirst?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('restores an ABA replacement owner without overlapping critical sections', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-lock-aba-'));
    const teamName = 'lock-aba';
    const workerName = 'worker-1';
    const teamRoot = join(cwd, '.omx', 'state', 'team', teamName);
    const lockDir = join(teamRoot, 'workers', workerName, '.lock.status');
    const baseDeps = {
      teamDir: () => teamRoot,
      taskClaimLockDir: () => join(teamRoot, 'claims', 'task-1.lock'),
      mailboxLockDir: () => join(teamRoot, 'mailbox', `.lock-${workerName}`),
      workerStatusLockDir: () => lockDir,
    };

    let active = 0;
    let maxActive = 0;
    let contenderEntered = false;
    let releaseReplacement: (() => void) | undefined;
    let replacementOwner = '';
    let replacementRun: Promise<void> | undefined;
    let signalReplacementEntered: (() => void) | undefined;
    const replacementEntered = new Promise<void>((resolve) => {
      signalReplacementEntered = resolve;
    });
    let signalRenameFinished: (() => void) | undefined;
    const renameFinished = new Promise<void>((resolve) => {
      signalRenameFinished = resolve;
    });

    try {
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, 'owner'), '999999.stale-owner', 'utf8');
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(lockDir, staleTime, staleTime);

      let intercepted = false;
      const contender = withWorkerStatusLock(teamName, workerName, cwd, 10, {
        ...baseDeps,
        renameLockDir: async (from, to) => {
          if (intercepted) {
            await rename(from, to);
            return;
          }
          intercepted = true;
          await rm(from, { recursive: true, force: true });
          const replacementReleased = new Promise<void>((resolve) => {
            releaseReplacement = resolve;
          });
          replacementRun = withWorkerStatusLock(teamName, workerName, cwd, 10, baseDeps, async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            replacementOwner = (await readFile(join(lockDir, 'owner'), 'utf8')).trim();
            signalReplacementEntered?.();
            await replacementReleased;
            active -= 1;
          });
          await replacementEntered;
          await rename(from, to);
          signalRenameFinished?.();
        },
      }, async () => {
        contenderEntered = true;
        active += 1;
        maxActive = Math.max(maxActive, active);
        active -= 1;
      });

      await renameFinished;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          if ((await readFile(join(lockDir, 'owner'), 'utf8')).trim() === replacementOwner) break;
        } catch {
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      assert.equal((await readFile(join(lockDir, 'owner'), 'utf8')).trim(), replacementOwner);
      assert.equal(active, 1);
      assert.equal(contenderEntered, false);
      releaseReplacement?.();
      await Promise.all([replacementRun, contender]);
      assert.equal(maxActive, 1);
      assert.equal(contenderEntered, true);
    } finally {
      releaseReplacement?.();
      await replacementRun?.catch(() => {});
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
