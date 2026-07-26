import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  setWorkflowStateLockTestConfig,
  withWorkflowStateLock,
} from '../workflow-state-lock.js';

afterEach(() => {
  setWorkflowStateLockTestConfig();
});

describe('workflow state lock', () => {
  it('never steals a stale-looking lock from a live owner', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-live-'));
    try {
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const ownerPath = join(lockDir, 'owner');
      await mkdir(lockDir);
      await writeFile(ownerPath, JSON.stringify({
        token: 'live-owner',
        pid: process.pid,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      setWorkflowStateLockTestConfig({
        staleMs: 0,
        timeoutMs: 20,
        retryMs: 1,
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_lock_timeout/,
      );

      const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as { token: string };
      assert.equal(owner.token, 'live-owner');
    } finally {
      await rm(baseStateDir, { recursive: true, force: true });
    }
  });

  it('restores a fresh replacement lock when stale takeover identity changes before rename', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-race-'));
    try {
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const ownerPath = join(lockDir, 'owner');
      await mkdir(lockDir);
      await writeFile(ownerPath, JSON.stringify({
        token: 'stale-owner',
        pid: 999_999,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      let replaced = false;
      setWorkflowStateLockTestConfig({
        staleMs: 0,
        timeoutMs: 20,
        retryMs: 1,
        processIsAlive: () => false,
        hook: async (stage) => {
          if (stage !== 'before-stale-rename' || replaced) return;
          replaced = true;
          await rm(lockDir, { recursive: true, force: true });
          await mkdir(lockDir);
          await writeFile(ownerPath, JSON.stringify({
            token: 'fresh-owner',
            pid: process.pid,
            heartbeat_at: new Date().toISOString(),
          }));
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_lock_takeover_race/,
      );

      const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as { token: string };
      assert.equal(owner.token, 'fresh-owner');
    } finally {
      await rm(baseStateDir, { recursive: true, force: true });
    }
  });
});
