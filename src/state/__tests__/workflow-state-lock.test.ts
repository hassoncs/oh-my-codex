import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  withWorkflowStateLock as withProductionWorkflowStateLock,
  type WorkflowStateLockDependencies,
  type WorkflowStateLockLease,
} from '../workflow-state-lock.js';
import {
  withWorkflowStateTransaction as withProductionWorkflowStateTransaction,
  type WorkflowStateTransactionDependencies,
  type WorkflowStateTransactionLease,
} from '../workflow-state-transaction.js';

const CHILD_NODE_ARGS = import.meta.url.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
const PRIOR_LOCK_TOKEN = 'prior-lock';
const PRIOR_LOCK_GENERATION = '00000000-0000-4000-8000-000000000001';
let lockDependencies: WorkflowStateLockDependencies = {};
let transactionDependencies: WorkflowStateTransactionDependencies = {};

function configureWorkflowStateLockFaults(
  dependencies: WorkflowStateLockDependencies = {},
): void {
  lockDependencies = dependencies;
}

function configureWorkflowStateTransactionFaults(
  dependencies: WorkflowStateTransactionDependencies = {},
): void {
  transactionDependencies = dependencies;
}

function withWorkflowStateLock<T>(
  baseStateDir: string,
  fn: (lease: WorkflowStateLockLease) => Promise<T>,
  lease?: WorkflowStateLockLease,
): Promise<T> {
  return withProductionWorkflowStateLock(baseStateDir, dirname(dirname(baseStateDir)), fn, lease, {
    ...lockDependencies,
    transaction: transactionDependencies,
  });
}

function withWorkflowStateTransaction<T>(
  baseStateDir: string,
  cwd: string,
  sessionId: string | undefined,
  fn: (lease: WorkflowStateTransactionLease) => Promise<T>,
  extraPaths: string[] = [],
  options: {
    lockLease?: WorkflowStateLockLease;
    transactionLease?: WorkflowStateTransactionLease;
  } = {},
): Promise<T> {
  return withProductionWorkflowStateTransaction(
    baseStateDir,
    cwd,
    sessionId,
    fn,
    extraPaths,
    { ...options, dependencies: transactionDependencies },
  );
}

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

function persistedTransactionV4(
  entries: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    ...persistedTransaction(entries),
    version: 4,
  };
}

function persistedTransactionV5(
  entries: Record<string, unknown>[],
  contextRoot: string,
): Record<string, unknown> {
  return {
    ...persistedTransaction(entries),
    version: 5,
    context_root_sha256: createHash('sha256')
      .update(join(realpathSync(dirname(dirname(resolve(contextRoot)))), '.omx', 'context'))
      .digest('hex'),
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

function canonicalStatePath(baseStateDir: string, name: string): string {
  return join(realpathSync(baseStateDir), name);
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
          await withWorkflowStateLock(${JSON.stringify(baseStateDir)}, ${JSON.stringify(cwd)}, (lockLease) =>
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

  it('recovers keyword-owned context from a different workflow lock entrypoint', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-context-recovery-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const contextPath = join(cwd, '.omx', 'context', 'handoff-20260727T000000Z.md');
      const markerPath = join(cwd, 'crashed');
      await mkdir(dirname(contextPath), { recursive: true });
      await writeFile(contextPath, 'before');

      const lockUrl = new URL('../workflow-state-lock.js', import.meta.url).href;
      const transactionUrl = new URL('../workflow-state-transaction.js', import.meta.url).href;
      const script = `
        const { writeFile } = await import('node:fs/promises');
        const { withWorkflowStateLock } = await import(${JSON.stringify(lockUrl)});
        const { withWorkflowStateTransaction } = await import(${JSON.stringify(transactionUrl)});
        await withWorkflowStateLock(
          ${JSON.stringify(baseStateDir)},
          ${JSON.stringify(cwd)},
          (lockLease) => withWorkflowStateTransaction(
            ${JSON.stringify(baseStateDir)},
            ${JSON.stringify(cwd)},
            undefined,
            async (transactionLease) => {
              await transactionLease.capturePath(${JSON.stringify(contextPath)});
              await writeFile(${JSON.stringify(contextPath)}, 'mutated');
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
      assert.equal(await readFile(contextPath, 'utf-8'), 'mutated');

      configureWorkflowStateLockFaults({
        staleMs: 0,
        timeoutMs: 1_000,
        retryMs: 1,
        processIsAlive: () => false,
      });
      await withWorkflowStateLock(baseStateDir, async () => {});

      assert.equal(await readFile(contextPath, 'utf-8'), 'before');
      assert.equal(existsSync(join(baseStateDir, '.workflow-state-transaction.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers a process killed before atomic lock publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-lock-publish-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const lockDir = join(baseStateDir, '.workflow-state.lock');
      const markerPath = join(cwd, 'before-publish');
      const lockUrl = new URL('../workflow-state-lock.js', import.meta.url).href;
      const script = `
        const { writeFile } = await import('node:fs/promises');
        const { withWorkflowStateLock } = await import(${JSON.stringify(lockUrl)});
        await withWorkflowStateLock(
          ${JSON.stringify(baseStateDir)},
          ${JSON.stringify(cwd)},
          async () => {},
          undefined,
          {
            hook: async (stage) => {
              if (stage !== 'before-lock-publish') return;
              await writeFile(${JSON.stringify(markerPath)}, 'ready');
              await new Promise(() => {});
            },
          },
        );
      `;
      const child = spawn(process.execPath, [...CHILD_NODE_ARGS, '--input-type=module', '--eval', script], {
        stdio: 'ignore',
      });
      const childClosed = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      for (let attempt = 0; attempt < 200 && !existsSync(markerPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(existsSync(markerPath), true);
      assert.equal(existsSync(lockDir), false);
      assert.equal(
        (await readdir(baseStateDir)).some((entry) => entry.startsWith('.workflow-state.lock.pending.')),
        true,
      );

      child.kill('SIGKILL');
      await childClosed;

      await withWorkflowStateLock(baseStateDir, async () => {});
      assert.equal(existsSync(lockDir), false);
      assert.equal(
        (await readdir(baseStateDir)).some((entry) => entry.startsWith('.workflow-state.lock.pending.')),
        false,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not roll back concurrently written non-workflow state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-unowned-state-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const hudPath = join(baseStateDir, 'hud-state.json');
      const notifyPath = join(baseStateDir, 'notify-fallback-state.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(hudPath, '{"value":"before"}');
      await writeFile(notifyPath, '{"value":"before"}');

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, (lockLease) =>
          withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {
              await writeFile(hudPath, '{"value":"concurrent"}');
              await writeFile(notifyPath, '{"value":"concurrent"}');
              throw new Error('workflow mutation failed');
            },
            [],
            { lockLease },
          )),
        /workflow mutation failed/,
      );

      assert.equal(await readFile(hudPath, 'utf-8'), '{"value":"concurrent"}');
      assert.equal(await readFile(notifyPath, 'utf-8'), '{"value":"concurrent"}');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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

  it('rejects forged context recovery paths outside the trusted project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-context-scope-'));
    try {
      const cwd = join(root, 'project-a');
      const sibling = join(root, 'project-b');
      const baseStateDir = join(cwd, '.omx', 'state');
      const siblingContextDir = join(sibling, '.omx', 'context');
      const targetPath = join(siblingContextDir, 'target-20260727T000000Z.md');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await mkdir(siblingContextDir, { recursive: true });
      await writeFile(targetPath, 'sibling-owned');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransactionV5([{
          ...persistedEntry(targetPath, null),
          scope: 'context',
        }], join(cwd, '.omx', 'context'))),
      );
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner()),
      );

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_invalid:absolute_path/,
      );

      assert.equal(await readFile(targetPath, 'utf-8'), 'sibling-owned');
      assert.equal(existsSync(journalPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects legacy v4 context recovery without project provenance', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-context-v4-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const contextDir = join(cwd, '.omx', 'context');
      const contextName = 'task-20260727T000000Z.md';
      const targetPath = join(contextDir, contextName);
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await mkdir(contextDir, { recursive: true });
      await writeFile(targetPath, 'mutated');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransactionV4([{
          ...persistedEntry(contextName, Buffer.from('before')),
          scope: 'context',
        }])),
      );
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner()),
      );

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_invalid:context_provenance/,
      );

      assert.equal(await readFile(targetPath, 'utf-8'), 'mutated');
      assert.equal(existsSync(journalPath), true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects shared-state context recovery from a different project cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-context-provenance-'));
    try {
      const leaderCwd = join(root, 'leader');
      const workerCwd = join(root, 'worker');
      const baseStateDir = join(leaderCwd, '.omx', 'state');
      const workerContextDir = join(workerCwd, '.omx', 'context');
      const contextName = 'task-20260727T000000Z.md';
      const workerPath = join(workerContextDir, contextName);
      const leaderPath = join(leaderCwd, '.omx', 'context', contextName);
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const recoveryOwnerFile = join(baseStateDir, '.workflow-state-recovery-owner.json');
      await mkdir(baseStateDir, { recursive: true });
      await mkdir(workerContextDir, { recursive: true });
      await writeFile(workerPath, 'mutated-worker');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransactionV5([{
          ...persistedEntry(contextName, Buffer.from('before-worker')),
          scope: 'context',
        }], workerContextDir)),
      );
      await writeFile(recoveryOwnerFile, JSON.stringify(persistedRecoveryOwner()));

      await assert.rejects(
        () => withProductionWorkflowStateLock(
          baseStateDir,
          leaderCwd,
          async () => {},
          undefined,
          { ...lockDependencies, transaction: transactionDependencies },
        ),
        /workflow_state_transaction_invalid:context_provenance/,
      );

      assert.equal(await readFile(workerPath, 'utf-8'), 'mutated-worker');
      assert.equal(existsSync(leaderPath), false);
      assert.equal(existsSync(journalPath), true);
      assert.equal(existsSync(recoveryOwnerFile), true);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state.lock')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
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
      const canonicalBaseStateDir = realpathSync(baseStateDir);
      let mutated = false;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (mutated && stage === 'before-directory-sync' && path === canonicalBaseStateDir) {
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

  it('recovers every concurrently captured path after a forced stale-write order', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-concurrent-capture-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const firstPath = join(baseStateDir, 'first.json');
      const secondPath = join(baseStateDir, 'second.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(firstPath, 'first-before');
      await writeFile(secondPath, 'second-before');
      const canonicalJournalPath = canonicalStatePath(baseStateDir, '.workflow-state-transaction.json');
      const canonicalFirstPath = canonicalStatePath(baseStateDir, 'first.json');

      let journalWrites = 0;
      let failRollback = false;
      let firstCaptureStarted!: () => void;
      const firstCaptureReady = new Promise<void>((resolve) => {
        firstCaptureStarted = resolve;
      });
      let secondCaptureFinished!: () => void;
      const secondCaptureDone = new Promise<void>((resolve) => {
        secondCaptureFinished = resolve;
      });
      configureWorkflowStateTransactionFaults({
        hook: async (stage, path) => {
          if (stage === 'before-file-sync' && path === canonicalJournalPath && journalWrites++ === 1) {
            firstCaptureStarted();
            await Promise.race([
              secondCaptureDone,
              new Promise<void>((resolve) => setTimeout(resolve, 50)),
            ]);
          }
          if (failRollback && stage === 'before-file-sync' && path === canonicalFirstPath) {
            throw new Error('rollback_sync_failed');
          }
        },
      });

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, (lockLease) =>
          withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async (transactionLease) => {
              const firstCapture = transactionLease.capturePath(firstPath);
              await firstCaptureReady;
              const secondCapture = transactionLease.capturePath(secondPath)
                .finally(secondCaptureFinished);
              await Promise.all([firstCapture, secondCapture]);
              await writeFile(firstPath, 'first-after');
              await writeFile(secondPath, 'second-after');
              failRollback = true;
              throw new Error('simulated_crash');
            },
            [],
            { lockLease },
          )),
        /workflow_state_transaction_rollback_failed/,
      );
      assert.equal(existsSync(journalPath), true);

      configureWorkflowStateTransactionFaults();
      await withWorkflowStateLock(baseStateDir, async () => {});
      assert.equal(await readFile(firstPath, 'utf-8'), 'first-before');
      assert.equal(await readFile(secondPath, 'utf-8'), 'second-before');
      assert.equal(existsSync(journalPath), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('waits for an unawaited capture before committing the transaction', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-detached-capture-'));
    let releaseCapture: (() => void) | undefined;
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const capturedPath = join(baseStateDir, 'captured.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(capturedPath, 'before');
      const canonicalJournalPath = canonicalStatePath(baseStateDir, '.workflow-state-transaction.json');
      const captureBlocked = new Promise<void>((resolve) => {
        releaseCapture = resolve;
      });
      let captureStarted!: () => void;
      const captureReady = new Promise<void>((resolve) => {
        captureStarted = resolve;
      });
      let journalWrites = 0;
      configureWorkflowStateTransactionFaults({
        hook: async (stage, path) => {
          if (stage !== 'before-file-sync' || path !== canonicalJournalPath || journalWrites++ !== 1) return;
          captureStarted();
          await captureBlocked;
        },
      });

      let capture!: Promise<void>;
      let settled = false;
      const transaction = withWorkflowStateLock(baseStateDir, (lockLease) =>
        withWorkflowStateTransaction(
          baseStateDir,
          cwd,
          undefined,
          async (transactionLease) => {
            capture = transactionLease.capturePath(capturedPath);
            await captureReady;
          },
          [],
          { lockLease },
        ));
      void transaction.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await captureReady;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(settled, false);
      assert.equal(existsSync(journalPath), true);

      if (!releaseCapture) throw new Error('capture release callback missing');
      releaseCapture();
      await Promise.all([transaction, capture]);
      assert.equal(existsSync(journalPath), false);
    } finally {
      releaseCapture?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects context recovery after a project symlink retarget', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-context-retarget-'));
    try {
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      const linkedCwd = join(root, 'current');
      const baseStateDir = join(root, 'shared-state');
      const contextName = 'task-20260727T000000Z.md';
      const contextA = join(projectA, '.omx', 'context', contextName);
      const contextB = join(projectB, '.omx', 'context', contextName);
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(dirname(contextA), { recursive: true });
      await mkdir(dirname(contextB), { recursive: true });
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(contextA, 'mutated-a');
      await writeFile(contextB, 'mutated-b');
      await symlink(projectA, linkedCwd, 'dir');
      let failRollback = false;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (failRollback && stage === 'before-file-sync' && path.endsWith(contextName)) {
            throw new Error('rollback_sync_failed');
          }
        },
      });

      await assert.rejects(
        () => withProductionWorkflowStateLock(
          baseStateDir,
          linkedCwd,
          (lockLease) => withWorkflowStateTransaction(
            baseStateDir,
            linkedCwd,
            undefined,
            async (transactionLease) => {
              await transactionLease.capturePath(join(linkedCwd, '.omx', 'context', contextName));
              failRollback = true;
              throw new Error('simulated_crash');
            },
            [],
            { lockLease },
          ),
          undefined,
          { ...lockDependencies, transaction: transactionDependencies },
        ),
        /workflow_state_transaction_rollback_failed/,
      );
      assert.equal(existsSync(journalPath), true);

      await rm(linkedCwd);
      await symlink(projectB, linkedCwd, 'dir');
      configureWorkflowStateTransactionFaults();
      await assert.rejects(
        () => withProductionWorkflowStateLock(
          baseStateDir,
          linkedCwd,
          async () => {},
          undefined,
          { ...lockDependencies, transaction: transactionDependencies },
        ),
        /workflow_state_transaction_invalid:context_provenance/,
      );
      assert.equal(await readFile(contextA, 'utf-8'), 'mutated-a');
      assert.equal(await readFile(contextB, 'utf-8'), 'mutated-b');
      assert.equal(existsSync(journalPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('binds state paths and journal identity to each canonical root across symlink retargets', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-state-root-retarget-'));
    try {
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      const linkedCwd = join(root, 'current');
      const stateA = join(projectA, '.omx', 'state');
      const stateB = join(projectB, '.omx', 'state');
      const teamA = join(stateA, 'team-state.json');
      const teamB = join(stateB, 'team-state.json');
      const baseStateDir = join(linkedCwd, '.omx', 'state');
      await mkdir(stateA, { recursive: true });
      await mkdir(stateB, { recursive: true });
      await writeFile(teamA, 'before-a');
      await writeFile(teamB, 'before-b');
      await symlink(projectA, linkedCwd, 'dir');

      let journalA = '';
      await withProductionWorkflowStateLock(
        baseStateDir,
        linkedCwd,
        (lockLease) => withWorkflowStateTransaction(
          baseStateDir,
          linkedCwd,
          undefined,
          async (transactionLease) => {
            journalA = transactionLease.journalPath;
            await transactionLease.capturePath(join(baseStateDir, 'team-state.json'));
            await writeFile(join(baseStateDir, 'team-state.json'), 'committed-a');
          },
          [],
          { lockLease },
        ),
        undefined,
        { ...lockDependencies, transaction: transactionDependencies },
      );
      assert.equal(journalA, join(realpathSync(stateA), '.workflow-state-transaction.json'));

      await rm(linkedCwd);
      await symlink(projectB, linkedCwd, 'dir');
      let journalB = '';
      await withProductionWorkflowStateLock(
        baseStateDir,
        linkedCwd,
        (lockLease) => withWorkflowStateTransaction(
          baseStateDir,
          linkedCwd,
          undefined,
          async (transactionLease) => {
            journalB = transactionLease.journalPath;
            await transactionLease.capturePath(join(baseStateDir, 'team-state.json'));
            await writeFile(join(baseStateDir, 'team-state.json'), 'committed-b');
          },
          [],
          { lockLease },
        ),
        undefined,
        { ...lockDependencies, transaction: transactionDependencies },
      );

      assert.equal(journalB, join(realpathSync(stateB), '.workflow-state-transaction.json'));
      assert.notEqual(journalA, journalB);
      assert.equal(await readFile(teamA, 'utf-8'), 'committed-a');
      assert.equal(await readFile(teamB, 'utf-8'), 'committed-b');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps lock, journal, and recovery on one canonical root during in-flight alias retarget', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-inflight-root-retarget-'));
    try {
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      const linkedCwd = join(root, 'current');
      const stateA = join(projectA, '.omx', 'state');
      const stateB = join(projectB, '.omx', 'state');
      const teamA = join(stateA, 'team-state.json');
      const teamB = join(stateB, 'team-state.json');
      const baseStateDir = join(linkedCwd, '.omx', 'state');
      await mkdir(stateA, { recursive: true });
      await mkdir(stateB, { recursive: true });
      await writeFile(teamA, 'before-a');
      await writeFile(teamB, 'before-b');
      await symlink(projectA, linkedCwd, 'dir');

      await assert.rejects(
        () => withProductionWorkflowStateLock(
          baseStateDir,
          linkedCwd,
          (lockLease) => withWorkflowStateTransaction(
            baseStateDir,
            linkedCwd,
            undefined,
            async (transactionLease) => {
              const canonicalTeamPath = join(transactionLease.baseStateDir, 'team-state.json');
              await transactionLease.capturePath(canonicalTeamPath);
              await writeFile(canonicalTeamPath, 'mutated-a-before-retarget');
              await rm(linkedCwd);
              await symlink(projectB, linkedCwd, 'dir');
              await transactionLease.capturePath(join(baseStateDir, 'team-state.json'));
              await writeFile(canonicalTeamPath, 'mutated-a-after-retarget');
            },
            [],
            { lockLease },
          ),
          undefined,
          { ...lockDependencies, transaction: transactionDependencies },
        ),
        /workflow_state_transaction_root_changed/,
      );

      assert.equal(await readFile(teamA, 'utf-8'), 'before-a');
      assert.equal(await readFile(teamB, 'utf-8'), 'before-b');
      for (const stateRoot of [stateA, stateB]) {
        assert.equal(existsSync(join(stateRoot, '.workflow-state.lock')), false);
        assert.equal(existsSync(join(stateRoot, '.workflow-state-transaction.json')), false);
        assert.equal(existsSync(join(stateRoot, '.workflow-state-recovery-owner.json')), false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects context capture after the project alias retargets', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-context-inflight-retarget-'));
    try {
      const projectA = join(root, 'project-a');
      const projectB = join(root, 'project-b');
      const linkedCwd = join(root, 'current');
      const baseStateDir = join(root, 'state');
      const contextName = 'autopilot-task-20260727T000000Z.md';
      await mkdir(projectA, { recursive: true });
      await mkdir(projectB, { recursive: true });
      await mkdir(baseStateDir, { recursive: true });
      await symlink(projectA, linkedCwd, 'dir');

      await assert.rejects(
        () => withProductionWorkflowStateLock(
          baseStateDir,
          linkedCwd,
          (lockLease) => withWorkflowStateTransaction(
            baseStateDir,
            linkedCwd,
            undefined,
            async (transactionLease) => {
              await rm(linkedCwd);
              await symlink(projectB, linkedCwd, 'dir');
              const contextPath = join(transactionLease.contextRoot, contextName);
              await transactionLease.capturePath(contextPath);
              await writeFile(contextPath, 'escaped');
            },
            [],
            { lockLease },
          ),
          undefined,
          { ...lockDependencies, transaction: transactionDependencies },
        ),
        /workflow_state_transaction_context_root_changed/,
      );

      assert.equal(existsSync(join(projectA, '.omx', 'context', contextName)), false);
      assert.equal(existsSync(join(projectB, '.omx', 'context', contextName)), false);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state.lock')), false);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state-transaction.json')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects recovery through a symlinked sessions directory', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-symlinked-sessions-'));
    try {
      const cwd = join(root, 'project');
      const baseStateDir = join(cwd, '.omx', 'state');
      const outsideSessionDir = join(root, 'outside', 'session-a');
      const outsidePath = join(outsideSessionDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await mkdir(outsideSessionDir, { recursive: true });
      await symlink(join(root, 'outside'), join(baseStateDir, 'sessions'), 'dir');
      await writeFile(outsidePath, 'outside-mutated');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransaction([
          persistedEntry('sessions/session-a/team-state.json', Buffer.from('before')),
        ])),
      );
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner()),
      );

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_invalid:state_path/,
      );
      assert.equal(await readFile(outsidePath, 'utf-8'), 'outside-mutated');
      assert.equal(existsSync(journalPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects recovery through a symlinked session subdirectory', {
    skip: process.platform === 'win32',
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-symlinked-session-'));
    try {
      const cwd = join(root, 'project');
      const baseStateDir = join(cwd, '.omx', 'state');
      const sessionsDir = join(baseStateDir, 'sessions');
      const outsideDir = join(root, 'outside');
      const outsidePath = join(outsideDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(sessionsDir, { recursive: true });
      await mkdir(outsideDir, { recursive: true });
      await symlink(outsideDir, join(sessionsDir, 'session-a'), 'dir');
      await writeFile(outsidePath, 'outside-mutated');
      await writeFile(
        journalPath,
        JSON.stringify(persistedTransaction([
          persistedEntry('sessions/session-a/team-state.json', Buffer.from('before')),
        ])),
      );
      await writeFile(
        join(baseStateDir, '.workflow-state-recovery-owner.json'),
        JSON.stringify(persistedRecoveryOwner()),
      );

      await assert.rejects(
        () => withWorkflowStateLock(baseStateDir, async () => {}),
        /workflow_state_transaction_invalid:state_path/,
      );
      assert.equal(await readFile(outsidePath, 'utf-8'), 'outside-mutated');
      assert.equal(existsSync(journalPath), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates a journal deletion failure after rolling state back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-journal-delete-failure-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const teamPath = join(baseStateDir, 'team-state.json');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      await mkdir(baseStateDir, { recursive: true });
      await writeFile(teamPath, 'before');
      const canonicalJournalPath = canonicalStatePath(baseStateDir, '.workflow-state-transaction.json');
      let failDelete = true;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (failDelete && stage === 'before-journal-delete' && path === canonicalJournalPath) {
            failDelete = false;
            throw new Error('journal_delete_failed');
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
            },
            [],
            { lockLease },
          )),
        /journal_delete_failed/,
      );
      assert.equal(await readFile(teamPath, 'utf-8'), 'before');
      assert.equal(existsSync(journalPath), false);
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

  it('releases reservation and journal after transaction initialization fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-init-failure-'));
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      await mkdir(baseStateDir, { recursive: true });
      const canonicalBaseStateDir = realpathSync(baseStateDir);
      let failInitialDirectorySync = true;
      let secondEntered = false;
      await withWorkflowStateLock(baseStateDir, async (lockLease) => {
        configureWorkflowStateTransactionFaults({
          hook: (stage, path) => {
            if (!failInitialDirectorySync || stage !== 'before-directory-sync' || path !== canonicalBaseStateDir) return;
            failInitialDirectorySync = false;
            throw new Error('initialization_sync_failed');
          },
        });
        await assert.rejects(
          () => withWorkflowStateTransaction(
            baseStateDir,
            cwd,
            undefined,
            async () => {},
            [],
            { lockLease },
          ),
          /initialization_sync_failed/,
        );
        await withWorkflowStateTransaction(
          baseStateDir,
          cwd,
          undefined,
          async () => {
            secondEntered = true;
          },
          [],
          { lockLease },
        );
      });

      assert.equal(secondEntered, true);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state-transaction.json')), false);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state-recovery-owner.json')), false);
      assert.equal(existsSync(join(baseStateDir, '.workflow-state.lock')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('admits only one same-lease transaction before durable journal creation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-workflow-transaction-reservation-'));
    let releaseJournalWrite: (() => void) | undefined;
    try {
      const baseStateDir = join(cwd, '.omx', 'state');
      const journalPath = join(baseStateDir, '.workflow-state-transaction.json');
      const recoveryOwnerPath = join(baseStateDir, '.workflow-state-recovery-owner.json');
      const lockPath = join(baseStateDir, '.workflow-state.lock');
      await mkdir(baseStateDir, { recursive: true });
      const canonicalJournalPath = canonicalStatePath(baseStateDir, '.workflow-state-transaction.json');
      const journalWriteBlocked = new Promise<void>((resolve) => {
        releaseJournalWrite = resolve;
      });
      let journalWriteEntered!: () => void;
      const journalWriteStarted = new Promise<void>((resolve) => {
        journalWriteEntered = resolve;
      });
      let journalWrites = 0;
      configureWorkflowStateTransactionFaults({
        hook: async (stage, path) => {
          if (stage !== 'before-file-sync' || path !== canonicalJournalPath || journalWrites++ > 0) return;
          journalWriteEntered();
          await journalWriteBlocked;
        },
      });

      await withWorkflowStateLock(baseStateDir, async (lockLease) => {
        const first = withWorkflowStateTransaction(
          baseStateDir,
          cwd,
          undefined,
          async () => {},
          [],
          { lockLease },
        );
        await journalWriteStarted;
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
        releaseJournalWrite?.();
        await first;
      });

      assert.equal(journalWrites, 1);
      assert.equal(existsSync(journalPath), false);
      assert.equal(existsSync(recoveryOwnerPath), false);
      assert.equal(existsSync(lockPath), false);
    } finally {
      releaseJournalWrite?.();
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
      const canonicalTeamPath = canonicalStatePath(baseStateDir, 'team-state.json');
      let failRollbackSync = false;
      let failRecoveryOwnerWrite = false;
      configureWorkflowStateTransactionFaults({
        hook: (stage, path) => {
          if (failRollbackSync && stage === 'before-file-sync' && path === canonicalTeamPath) {
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
