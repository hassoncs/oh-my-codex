import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { withWorkflowStateLock } from '../workflow-state-lock.js';
import { withWorkflowStateTransaction } from '../workflow-state-transaction.js';
import {
  configureWorkflowStateLockFaults,
  configureWorkflowStateTransactionFaults,
} from '../../testing/state-fault-injection.js';

const CHILD_NODE_ARGS = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
const PRIOR_LOCK_TOKEN = 'prior-lock';
const PRIOR_LOCK_GENERATION = '00000000-0000-4000-8000-000000000001';

afterEach(() => {
  configureWorkflowStateLockFaults();
  configureWorkflowStateTransactionFaults();
});

function persistedEntry(
  path: string,
  content: Buffer | null,
): Record<string, unknown> {
  return {
    path,
    content_base64: content?.toString('base64') ?? null,
    byte_length: content?.length ?? null,
    sha256: content
      ? createHash('sha256').update(content).digest('hex')
      : null,
  };
}

function persistedTransaction(
  entries: Record<string, unknown>[],
  owner: { token: string; generation: string } = {
    token: PRIOR_LOCK_TOKEN,
    generation: PRIOR_LOCK_GENERATION,
  },
): Record<string, unknown> {
  return {
    version: 3,
    transaction_id: '00000000-0000-4000-8000-000000000000',
    lock_token: owner.token,
    lock_generation: owner.generation,
    files: entries,
  };
}

function persistedRecoveryOwner(
  owner: { token: string; generation: string } = {
    token: PRIOR_LOCK_TOKEN,
    generation: PRIOR_LOCK_GENERATION,
  },
): Record<string, unknown> {
  return {
    version: 1,
    lock_token: owner.token,
    lock_generation: owner.generation,
  };
}

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
          await withWorkflowStateLock(${JSON.stringify(baseStateDir)}, (lockLease) =>
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
              [],
              { lockLease },
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

        configureWorkflowStateLockFaults({
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

  it('rolls back callback failures before deleting the journal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-callback-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'before');

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, (lockLease) =>
          withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {
              await writeFile(teamPath, 'after');
              throw new Error('callback_failed');
            },
            [],
            { lockLease },
          )),
        /callback_failed/,
      );

      assert.equal(await readFile(teamPath, 'utf-8'), 'before');
      assert.equal(existsSync(join(baseStateDir, '.workflow-state-transaction.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('retains malformed or corrupt journals without mutating state', async () => {
    const cases: Array<{ name: string; journal: string; owner?: Record<string, unknown> }> = [
      { name: 'json', journal: '{' },
      {
        name: 'path',
        journal: JSON.stringify(persistedTransaction([persistedEntry('../outside', null)])),
        owner: persistedRecoveryOwner(),
      },
      {
        name: 'base64',
        journal: JSON.stringify(persistedTransaction([{
          ...persistedEntry('team-state.json', Buffer.from('before')),
          content_base64: 'AA=A',
        }])),
        owner: persistedRecoveryOwner(),
      },
      {
        name: 'length',
        journal: JSON.stringify(persistedTransaction([{
          ...persistedEntry('team-state.json', Buffer.from('before')),
          byte_length: 99,
        }])),
        owner: persistedRecoveryOwner(),
      },
      {
        name: 'digest',
        journal: JSON.stringify(persistedTransaction([{
          ...persistedEntry('team-state.json', Buffer.from('before')),
          sha256: '0'.repeat(64),
        }])),
        owner: persistedRecoveryOwner(),
      },
    ];

    for (const testCase of cases) {
      const cwd = await mkdtemp(join(tmpdir(), `omx-workflow-journal-${testCase.name}-`));
      try {
        const baseStateDir = join(cwd, '.omx', 'state');
        const teamPath = join(baseStateDir, 'team-state.json');
        const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
        await mkdir(baseStateDir, { recursive: true });
        await writeFile(teamPath, 'current');
        await writeFile(journalPath, testCase.journal);
        if (testCase.owner) {
          await writeFile(
            join(baseStateDir, '.workflow-state-recovery-owner.json'),
            JSON.stringify(testCase.owner),
          );
        }

        await assert.rejects(
          () => withWorkflowStateLock(baseStateDir, async () => {}),
          /workflow_state_transaction_(?:corrupt|invalid)/,
          testCase.name,
        );
        assert.equal(await readFile(teamPath, 'utf-8'), 'current', testCase.name);
        assert.equal(await readFile(journalPath, 'utf-8'), testCase.journal, testCase.name);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it('retains journal when rollback durability fails, then recovers on next lock', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-sync-failure-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'before');
      let mutated = false;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (mutated && stage === 'before-directory-sync' && path === baseStateDir) {
            throw new Error('directory_sync_failed');
          }
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, (lockLease) =>
          withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {
              await writeFile(teamPath, 'after');
              mutated = true;
            },
            [],
            { lockLease },
          )),
        /workflow_state_transaction_rollback_failed/,
      );
      assert.equal(existsSync(journalPath), true);
      assert.equal(
        existsSync(join(baseStateDir, '.workflow-state-recovery-owner.json')),
        true,
      );

      configureWorkflowStateTransactionFaults();
      await withWorkflowStateLock(baseStateDir, async () => {});
      assert.equal(await readFile(teamPath, 'utf-8'), 'before');
      assert.equal(existsSync(journalPath), false);
      assert.equal(
        existsSync(join(baseStateDir, '.workflow-state-recovery-owner.json')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('requires explicit transaction capability for nested or detached mutation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-capability-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      await withWorkflowStateLock(baseStateDir, (lockLease) =>
        withWorkflowStateTransaction(
          baseStateDir,
          cwd,
          undefined,
          async (transactionLease) => {
            await assert.rejects(
              () => withWorkflowStateTransaction(
                baseStateDir,
                cwd,
                undefined,
                async () => {},
                [],
                { lockLease },
              ),
              /workflow_state_transaction_contended/,
            );
            await withWorkflowStateTransaction(
              baseStateDir,
              cwd,
              undefined,
              async () => {},
              [],
              { transactionLease },
            );
          },
          [],
          { lockLease },
        ));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('quarantines a journal displaced by another lock token without rolling it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-fence-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'before');

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, (lockLease) =>
          withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {
              await writeFile(teamPath, 'after');
              const journal = JSON.parse(await readFile(journalPath, 'utf-8')) as {
                lock_token: string;
              };
              journal.lock_token = 'replacement-lock';
              await writeFile(journalPath, JSON.stringify(journal));
            },
            [],
            { lockLease },
          )),
        /workflow_state_transaction_rollback_failed/,
      );
      assert.equal(await readFile(teamPath, 'utf-8'), 'after');
      assert.equal(existsSync(journalPath), true);

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_recovery_rejected:foreign/,
      );
      assert.equal(await readFile(teamPath, 'utf-8'), 'after');
      assert.equal(existsSync(journalPath), false);
      assert.equal(
        (await readdir(baseStateDir))
          .some((entry) => entry.includes('.foreign.') && entry.endsWith('.rejected')),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('quarantines an ownerless journal without mutating current state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-ownerless-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'current');
      await writeFile(journalPath, JSON.stringify({
        version: 3,
        transaction_id: '00000000-0000-4000-8000-000000000000',
        files: [persistedEntry('team-state.json', Buffer.from('older'))],
      }));

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_recovery_rejected:ownerless/,
      );
      assert.equal(await readFile(teamPath, 'utf-8'), 'current');
      assert.equal(existsSync(journalPath), false);
      assert.equal(
        (await readdir(baseStateDir))
          .some((entry) => entry.includes('.ownerless.') && entry.endsWith('.rejected')),
        true,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects a stale generation after a newer same-token commit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-stale-generation-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const token = 'reused-token';
      const staleGeneration = '00000000-0000-4000-8000-000000000020';
      const newerGeneration = '00000000-0000-4000-8000-000000000021';
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'newer-commit');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransaction(
          [persistedEntry('team-state.json', Buffer.from('older-snapshot'))],
          { token, generation: staleGeneration },
        )),
      );
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner({ token, generation: newerGeneration })),
      );

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_recovery_rejected:foreign/,
      );
      assert.equal(await readFile(teamPath, 'utf-8'), 'newer-commit');
      assert.equal(existsSync(journalPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers takeover provenance after interruption between stale rename and marker write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-takeover-provenance-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const teamPath = join(baseStateDir, 'team-state.json');
      const owner = {
        token: 'interrupted-owner',
        generation: '00000000-0000-4000-8000-000000000030',
      };
      await mkdir(lockDir, { recursive: true });
      await writeFile(join(lockDir, 'owner'), JSON.stringify({
        ...owner,
        pid: 999_999,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      await writeFile(teamPath, 'mutated');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransaction(
          [persistedEntry('team-state.json', Buffer.from('before'))],
          owner,
        )),
      );
      configureWorkflowStateLockFaults({
        staleMs: 0,
        timeoutMs: 1_000,
        retryMs: 1,
        processIsAlive: () => false,
        hook: (stage) => {
          if (stage === 'after-stale-rename') throw new Error('takeover_interrupted');
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /takeover_interrupted/,
      );
      assert.equal(existsSync(lockDir), false);
      assert.equal(
        (await readdir(baseStateDir)).some((entry) => entry.startsWith('.workflow-state.lock.stale.')),
        true,
      );

      configureWorkflowStateLockFaults();
      await withWorkflowStateLock(baseStateDir, async () => {});
      assert.equal(await readFile(teamPath, 'utf-8'), 'before');
      assert.equal(existsSync(journalPath), false);
      assert.equal(
        (await readdir(baseStateDir)).some((entry) => entry.startsWith('.workflow-state.lock.stale.')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('cleans takeover quarantine after interruption between marker write and quarantine removal', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-takeover-cleanup-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const quarantineDir = join(baseStateDir, '.workflow-state.lock.stale.interrupted-contender');
      const owner = {
        token: 'interrupted-owner',
        generation: '00000000-0000-4000-8000-000000000031',
      };
      await mkdir(quarantineDir, { recursive: true });
      await writeFile(join(quarantineDir, 'owner'), JSON.stringify({
        ...owner,
        pid: 999_999,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner(owner)),
      );

      await withWorkflowStateLock(baseStateDir, async () => {});

      assert.equal(existsSync(quarantineDir), false);
      assert.equal(
        existsSync(join(baseStateDir, '.workflow-state-recovery-owner.json')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('takes over immediately when recovery marker survives owner flag write failure', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-recovery-owner-gap-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'before');
      let failRollbackSync = false;
      let failRecoveryOwnerWrite = false;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (failRollbackSync && stage === 'before-file-sync' && path === teamPath) {
            failRollbackSync = false;
            throw new Error('rollback_sync_failed');
          }
        },
      });
      configureWorkflowStateLockFaults({
        hook: (stage) => {
          if (failRecoveryOwnerWrite && stage === 'before-owner-write') {
            failRecoveryOwnerWrite = false;
            throw new Error('recovery_owner_write_failed');
          }
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async (lockLease) => {
          await withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {
              await writeFile(teamPath, 'mutated');
              failRollbackSync = true;
              failRecoveryOwnerWrite = true;
              throw new Error('mutation_failed');
            },
            [],
            { lockLease },
          );
        }),
        /workflow_state_transaction_recovery_provenance_failed/,
      );
      assert.equal(
        existsSync(join(baseStateDir, '.workflow-state-recovery-owner.json')),
        true,
      );

      configureWorkflowStateLockFaults({
        timeoutMs: 1_000,
        retryMs: 1,
      });
      configureWorkflowStateTransactionFaults();
      await withWorkflowStateLock(baseStateDir, async () => {});
      assert.equal(await readFile(teamPath, 'utf-8'), 'before');
      assert.equal(existsSync(join(baseStateDir, '.workflow-state.lock')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('makes detached lock descendants contend until the owner exits', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-detached-'));
    try {
      configureWorkflowStateLockFaults({ timeoutMs: 1_000, retryMs: 1 });
      let descendantEntered = false;
      let descendant!: Promise<void>;
      await withWorkflowStateLock(baseStateDir, async () => {
        descendant = withWorkflowStateLock(baseStateDir, async () => {
          descendantEntered = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(descendantEntered, false);
      });
      await descendant;
      assert.equal(descendantEntered, true);
    } finally {
      await rm(baseStateDir, { recursive: true, force: true });
    }
  });

  it('never steals a stale-looking lock from a live owner', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-live-'));
    try {
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const ownerPath = join(lockDir, 'owner');
      await mkdir(lockDir);
      await writeFile(ownerPath, JSON.stringify({
        token: 'live-owner',
        generation: '00000000-0000-4000-8000-000000000010',
        pid: process.pid,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      configureWorkflowStateLockFaults({
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

  for (const ownerState of ['missing', 'invalid'] as const) {
    it(`treats ${ownerState} stale lock ownership as unknown`, async () => {
      const baseStateDir = await mkdtemp(join(tmpdir(), `omx-workflow-lock-${ownerState}-`));
      try {
        const lockDir = join(baseStateDir, '.workflow-state.lock');
        await mkdir(lockDir);
        if (ownerState === 'invalid') {
          await writeFile(join(lockDir, 'owner'), '{');
        }
        await utimes(lockDir, new Date(0), new Date(0));
        configureWorkflowStateLockFaults({
          staleMs: 0,
          timeoutMs: 20,
          retryMs: 1,
          processIsAlive: () => false,
        });

        await assert.rejects(
          () => withWorkflowStateLock(baseStateDir, async () => {}),
          /workflow_state_lock_timeout/,
        );
        assert.equal(existsSync(lockDir), true);
      } finally {
        await rm(baseStateDir, { recursive: true, force: true });
      }
    });
  }

  it('aborts stale takeover when the same owner token refreshes before rename', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-refreshed-'));
    try {
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const ownerPath = join(lockDir, 'owner');
      await mkdir(lockDir);
      await writeFile(ownerPath, JSON.stringify({
        token: 'same-owner',
        generation: '00000000-0000-4000-8000-000000000011',
        pid: 999_999,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      let refreshed = false;
      configureWorkflowStateLockFaults({
        staleMs: 0,
        timeoutMs: 20,
        retryMs: 1,
        processIsAlive: () => false,
        hook: async (stage) => {
          if (stage !== 'before-stale-rename' || refreshed) return;
          refreshed = true;
          await writeFile(ownerPath, JSON.stringify({
            token: 'same-owner',
            generation: '00000000-0000-4000-8000-000000000011',
            pid: 999_999,
            heartbeat_at: new Date().toISOString(),
          }));
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_lock_takeover_race/,
      );
      const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as { heartbeat_at: string };
      assert.notEqual(owner.heartbeat_at, new Date(0).toISOString());
    } finally {
      await rm(baseStateDir, { recursive: true, force: true });
    }
  });

  it('fails loud when heartbeat persistence fails', async () => {
    const baseStateDir = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-heartbeat-'));
    try {
      let ownerWrites = 0;
      configureWorkflowStateLockFaults({
        heartbeatMs: 1,
        hook: (stage) => {
          if (stage !== 'before-owner-write') return;
          ownerWrites += 1;
          if (ownerWrites > 1) throw new Error('heartbeat_write_failed');
        },
      });
      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }),
        /workflow_state_lock_heartbeat_failed/,
      );
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
        generation: '00000000-0000-4000-8000-000000000012',
        pid: 999_999,
        heartbeat_at: new Date(0).toISOString(),
      }));
      await utimes(lockDir, new Date(0), new Date(0));
      let replaced = false;
      configureWorkflowStateLockFaults({
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
            generation: '00000000-0000-4000-8000-000000000013',
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
