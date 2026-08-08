import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SUPERVISION_STATUS_SCHEMA, buildSupervisionStatus } from '../supervision-status.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-supervision-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function seedLane(cwd: string, options: { origin?: string } = {}): Promise<void> {
  const stateDir = join(cwd, '.omx', 'state');
  const ultragoalDir = join(cwd, '.omx', 'ultragoal');
  const teamDir = join(cwd, '.omx', 'team', 'execute-g006-runtime-a784b8fd', 'worktrees');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(stateDir, 'sessions', 'sess-1'), { recursive: true });
  await mkdir(ultragoalDir, { recursive: true });
  await mkdir(teamDir, { recursive: true });
  await mkdir(join(teamDir, 'worker-1'), { recursive: true });

  await writeFile(join(stateDir, 'run-state.json'), JSON.stringify({ current_phase: 'team-exec', active: true }));
  await writeFile(join(stateDir, 'ultragoal-state.json'), JSON.stringify({ active: true, current_phase: 'execute' }));
  await writeFile(join(stateDir, 'sessions', 'sess-1', 'team-state.json'), JSON.stringify({ active: true, current_phase: 'team-exec' }));
  // A long-lived tree accumulates finished sessions; the default view drops them.
  await mkdir(join(stateDir, 'sessions', 'sess-old'), { recursive: true });
  await writeFile(join(stateDir, 'sessions', 'sess-old', 'ralplan-state.json'), JSON.stringify({ active: false, current_phase: 'complete' }));
  await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
    active: true,
    team_name: 'execute-g006-runtime-a784b8fd',
    current_phase: 'team-exec',
    task_description: 'execute g006',
    agent_count: 2,
    started_at: '2026-07-26T17:24:06.681Z',
  }));

  const brief = '# Supervision test brief\n';
  const briefHash = sha256(brief);
  const runId = `run-20260726T000000Z-${briefHash.slice(0, 8)}`;
  const plan = {
    version: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T01:00:00.000Z',
    runId,
    briefHash,
    origin: { worktreePath: options.origin ?? cwd, createdAt: '2026-07-26T00:00:00.000Z' },
    briefPath: '.omx/ultragoal/brief.md',
    goalsPath: '.omx/ultragoal/goals.json',
    ledgerPath: '.omx/ultragoal/ledger.jsonl',
    activeGoalId: 'G002-second',
    goals: [
      { id: 'G001-first', title: 'First', status: 'complete', attempt: 1, updatedAt: '2026-07-26T00:30:00.000Z' },
      { id: 'G002-second', title: 'Second', status: 'in_progress', attempt: 1, updatedAt: '2026-07-26T01:00:00.000Z' },
      { id: 'G003-third', title: 'Third', status: 'pending', attempt: 0, updatedAt: '2026-07-26T00:00:00.000Z' },
    ],
  };
  const goals = `${JSON.stringify(plan)}\n`;
  const ledger = [
    JSON.stringify({ ts: '2026-07-26T00:00:00.000Z', event: 'plan_created', message: '3 goal(s)' }),
    JSON.stringify({ ts: '2026-07-26T00:30:00.000Z', event: 'goal_completed', goalId: 'G001-first', status: 'complete' }),
    JSON.stringify({ ts: '2026-07-26T01:00:00.000Z', event: 'goal_started', goalId: 'G002-second' }),
    '',
  ].join('\n');
  const runDir = join(ultragoalDir, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  for (const [file, value] of [['brief.md', brief], ['goals.json', goals], ['ledger.jsonl', ledger]] as const) {
    await writeFile(join(ultragoalDir, file), value);
    await writeFile(join(runDir, file), value);
  }
  await writeFile(join(ultragoalDir, 'active-run.json'), `${JSON.stringify({
    version: 1,
    runId,
    briefHash,
    updatedAt: plan.updatedAt,
    origin: plan.origin,
    files: {
      brief: sha256(brief),
      goals: sha256(goals),
      ledger: sha256(ledger),
    },
  })}\n`);
}

describe('omx supervision status', () => {
  it('renders phase, run namespace, per-goal status, teams and last checkpoint from state files', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const status = await buildSupervisionStatus(cwd, { now: new Date('2026-07-26T02:00:00.000Z'), allModes: true });

      assert.equal(status.schema, SUPERVISION_STATUS_SCHEMA);
      assert.equal(status.worktreePath, cwd);
      assert.equal(status.omxPresent, true);
      assert.equal(status.phase, 'team-exec');

      assert.match(status.ultragoal?.runId ?? '', /^run-20260726T000000Z-/);
      assert.equal(status.ultragoal?.origin.inherited, false);
      assert.equal(status.ultragoal?.activeGoalId, 'G002-second');
      assert.deepEqual(status.ultragoal?.counts, { complete: 1, in_progress: 1, pending: 1 });
      assert.equal(status.ultragoal?.goals.length, 3);
      assert.equal(status.ultragoal?.lastCheckpoint?.goalId, 'G001-first');
      assert.equal(status.ultragoal?.lastLedgerEntry?.event, 'goal_started');
      assert.ok(status.ultragoal?.paths.runDir?.includes(join('runs', 'run-20260726T000000Z-')));

      const team = status.teams.find((candidate) => candidate.name === 'execute-g006-runtime-a784b8fd');
      assert.equal(team?.active, true);
      assert.equal(team?.agentCount, 2);
      assert.deepEqual(team?.workerWorktrees, ['worker-1']);

      // Session-scoped state files are visible to an outside reader too.
      assert.ok(status.modes.some((mode) => mode.mode === 'team' && mode.sessionId === 'sess-1'));
      assert.ok(status.modes.some((mode) => mode.mode === 'ultragoal' && mode.sessionId === null && mode.active));

      // Default omits inactive/historical session state: a supervisor polling
      // this surface should not pay for every session the tree ever held.
      const lean = await buildSupervisionStatus(cwd);
      assert.ok(lean.modes.every((mode) => mode.active));
      assert.ok(lean.modes.length < status.modes.length);
      assert.equal(lean.phase, 'team-exec');
    });
  });

  it('reports an inherited registry instead of refusing to answer', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd, { origin: '/some/other/worktree' });
      const status = await buildSupervisionStatus(cwd);
      assert.equal(status.ultragoal?.origin.inherited, true);
      assert.equal(status.ultragoal?.origin.worktreePath, '/some/other/worktree');
    });
  });

  it('answers for a tree with no .omx at all', async () => {
    await withTempRepo(async (cwd) => {
      const status = await buildSupervisionStatus(cwd);
      assert.equal(status.omxPresent, false);
      assert.equal(status.ultragoal, null);
      assert.deepEqual(status.teams, []);
      assert.deepEqual(status.modes, []);
    });
  });

  it('flags a malformed goal registry rather than throwing', async () => {
    await withTempRepo(async (cwd) => {
      await mkdir(join(cwd, '.omx', 'ultragoal'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), '{bad json');
      const status = await buildSupervisionStatus(cwd);
      assert.equal(status.ultragoal?.error, 'malformed goal registry');
    });
  });

  it('reports a malformed persistent transaction journal as corruption', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      await writeFile(join(cwd, '.omx', 'ultragoal', '.run-transaction.json'), '{"version":1}\n');

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'invalid ultragoal transaction journal');
    });
  });

  it('reports a valid first-create journal before flat goals exist', async () => {
    await withTempRepo(async (cwd) => {
      const dir = join(cwd, '.omx', 'ultragoal');
      await mkdir(dir, { recursive: true });
      const brief = '# First create\n';
      const briefHash = sha256(brief);
      const runId = `run-20260801T190000Z-${briefHash.slice(0, 8)}`;
      const updatedAt = '2026-08-01T19:00:00.000Z';
      const goals = `${JSON.stringify({
        version: 1,
        createdAt: updatedAt,
        updatedAt,
        runId,
        briefHash,
        origin: { worktreePath: cwd, createdAt: updatedAt },
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        goals: [],
      })}\n`;
      const ledger = '';
      await writeFile(join(dir, '.run-transaction.json'), `${JSON.stringify({
        version: 1,
        mode: 'create',
        runId,
        pointer: {
          version: 1,
          runId,
          briefHash,
          updatedAt,
          origin: { worktreePath: cwd, createdAt: updatedAt },
        },
        files: {
          brief: sha256(brief),
          goals: sha256(goals),
          ledger: sha256(ledger),
        },
        before: {
          run: { brief: null, goals: null, ledger: null },
          projection: { brief: null, goals: null, ledger: null },
          pointerSha256: null,
        },
      })}\n`);

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'ultragoal registry transaction in progress');
    });
  });

  it('does not classify a journal retirement race as corruption', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const journalPath = join(cwd, '.omx', 'ultragoal', '.ledger-transaction.json');
      const runId = String((await buildSupervisionStatus(cwd)).ultragoal?.runId);
      await writeFile(journalPath, `${JSON.stringify({
        version: 1,
        runId,
        line: `${JSON.stringify({ ts: '2026-08-01T19:01:00.000Z', event: 'checkpoint' })}\n`,
        baseSha256: 'a'.repeat(64),
        nextSha256: 'b'.repeat(64),
      })}\n`);

      const removal = rm(journalPath, { force: true });
      const status = await buildSupervisionStatus(cwd);
      await removal;

      assert.notEqual(status.ultragoal?.error, 'invalid ultragoal transaction journal');
    });
  });

  it('reports a symlinked transaction journal as corruption', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const dir = join(cwd, '.omx', 'ultragoal');
      const target = join(cwd, 'run-transaction-target.json');
      await writeFile(target, `${JSON.stringify({
        version: 1,
        mode: 'update',
        runId: 'run-20260726T000000Z-abcd1234',
        pointer: {
          version: 1,
          runId: 'run-20260726T000000Z-abcd1234',
          briefHash: 'a'.repeat(64),
          updatedAt: '2026-07-26T01:00:00.000Z',
          origin: { worktreePath: cwd, createdAt: '2026-07-26T00:00:00.000Z' },
        },
        files: { brief: 'b'.repeat(64), goals: 'c'.repeat(64), ledger: 'd'.repeat(64) },
        before: {
          run: { brief: null, goals: null, ledger: null },
          projection: { brief: null, goals: null, ledger: null },
          pointerSha256: null,
        },
      })}\n`);
      await symlink(target, join(dir, '.run-transaction.json'));

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'invalid ultragoal transaction journal');
    });
  });

  it('reports a symlinked flat projection as unsafe', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const goalsPath = join(cwd, '.omx', 'ultragoal', 'goals.json');
      const target = join(cwd, 'goals-target.json');
      await writeFile(target, await readFile(goalsPath));
      await rm(goalsPath);
      await symlink(target, goalsPath);

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'unsafe ultragoal registry object');
    });
  });

  it('rejects a valid pointer for a different run than the flat and canonical plan', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const pointerPath = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      const pointer = JSON.parse(await readFile(pointerPath, 'utf-8')) as Record<string, unknown>;
      pointer.runId = 'run-20260801T190500Z-deadbeef';
      await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'invalid ultragoal active-run pointer authority');
    });
  });

  it('does not treat a missing empty ledger projection as valid empty bytes', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const dir = join(cwd, '.omx', 'ultragoal');
      const pointerPath = join(dir, 'active-run.json');
      const pointer = JSON.parse(await readFile(pointerPath, 'utf-8')) as {
        runId: string;
        files: { ledger: string };
      };
      await writeFile(join(dir, 'ledger.jsonl'), '');
      await writeFile(join(dir, 'runs', pointer.runId, 'ledger.jsonl'), '');
      pointer.files.ledger = sha256('');
      await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);
      await rm(join(dir, 'ledger.jsonl'));

      const status = await buildSupervisionStatus(cwd);

      assert.equal(status.ultragoal?.error, 'missing active ultragoal projection');
    });
  });
});
