import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  setWorkflowStateLockTestConfig,
  withWorkflowStateLock,
} from '../workflow-state-lock.js';

const CHILD_NODE_ARGS = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];

afterEach(() => {
  setWorkflowStateLockTestConfig();
});

describe('workflow state lock', () => {
  for (const stage of ['before-mutation', 'after-mutation'] as const) {
    it(`recovers a durable workflow transaction after process death ${stage}`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), `omx-workflow-transaction-${stage}-`));
      try {
        const baseStateDir = join(cwd, '.omx', 'state');
        const teamPath = join(baseStateDir, 'team-state.json');
        const canonicalPath = join(baseStateDir, 'skill-active-state.json');
        const markerPath = join(cwd, 'crashed');
        const teamBefore = '{"active":false,"mode":"team","current_phase":"prior"}';
        const canonicalBefore = '{"version":1,"active":false,"active_skills":[]}';
        await mkdir(baseStateDir, { recursive: true });
        await writeFile(teamPath, teamBefore);
        await writeFile(canonicalPath, canonicalBefore);

        const lockUrl = new URL('../workflow-state-lock.js', import.meta.url).href;
        const transactionUrl = new URL('../workflow-state-transaction.js', import.meta.url).href;
        const script = `
          const { writeFile } = await import('node:fs/promises');
          const { withWorkflowStateLock } = await import(${JSON.stringify(lockUrl)});
          const { withWorkflowStateTransaction } = await import(${JSON.stringify(transactionUrl)});
          await withWorkflowStateLock(${JSON.stringify(baseStateDir)}, () =>
            withWorkflowStateTransaction(
              ${JSON.stringify(baseStateDir)},
              ${JSON.stringify(cwd)},
              undefined,
              async () => {
                if (${JSON.stringify(stage === 'after-mutation')}) {
                  await writeFile(${JSON.stringify(teamPath)}, '{"active":true,"mode":"team","current_phase":"running"}');
                  await writeFile(${JSON.stringify(canonicalPath)}, '{"version":1,"active":true,"active_skills":[{"skill":"team"}]}');
                }
                await writeFile(${JSON.stringify(markerPath)}, 'ready');
                process.kill(process.pid, 'SIGKILL');
              },
            ),
          );
        `;
        const child = spawn(process.execPath, [...CHILD_NODE_ARGS, '--input-type=module', '--eval', script], {
          stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('close', () => resolve());
        });
        assert.equal(existsSync(markerPath), true);

        setWorkflowStateLockTestConfig({
          staleMs: 0,
          timeoutMs: 1_000,
          retryMs: 1,
          processIsAlive: () => false,
        });
        await withWorkflowStateLock(baseStateDir, async () => {
          assert.equal(await readFile(teamPath, 'utf-8'), teamBefore);
          assert.equal(await readFile(canonicalPath, 'utf-8'), canonicalBefore);
        });
        assert.equal(existsSync(join(baseStateDir, '.workflow-state-transaction.json')), false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

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
