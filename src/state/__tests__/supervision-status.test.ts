import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SUPERVISION_STATUS_SCHEMA, buildSupervisionStatus } from '../supervision-status.js';

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
  await writeFile(join(stateDir, 'team-state.json'), JSON.stringify({
    active: true,
    team_name: 'execute-g006-runtime-a784b8fd',
    current_phase: 'team-exec',
    task_description: 'execute g006',
    agent_count: 2,
    started_at: '2026-07-26T17:24:06.681Z',
  }));

  await writeFile(join(ultragoalDir, 'goals.json'), JSON.stringify({
    version: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T01:00:00.000Z',
    runId: 'run-20260726T000000Z-abcd1234',
    briefHash: 'abcd1234abcd1234',
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
  }));
  await writeFile(join(ultragoalDir, 'ledger.jsonl'), [
    JSON.stringify({ ts: '2026-07-26T00:00:00.000Z', event: 'plan_created', message: '3 goal(s)' }),
    JSON.stringify({ ts: '2026-07-26T00:30:00.000Z', event: 'goal_completed', goalId: 'G001-first', status: 'complete' }),
    JSON.stringify({ ts: '2026-07-26T01:00:00.000Z', event: 'goal_started', goalId: 'G002-second' }),
    '',
  ].join('\n'));
}

describe('omx supervision status', () => {
  it('renders phase, run namespace, per-goal status, teams and last checkpoint from state files', async () => {
    await withTempRepo(async (cwd) => {
      await seedLane(cwd);
      const status = await buildSupervisionStatus(cwd, new Date('2026-07-26T02:00:00.000Z'));

      assert.equal(status.schema, SUPERVISION_STATUS_SCHEMA);
      assert.equal(status.worktreePath, cwd);
      assert.equal(status.omxPresent, true);
      assert.equal(status.phase, 'team-exec');

      assert.equal(status.ultragoal?.runId, 'run-20260726T000000Z-abcd1234');
      assert.equal(status.ultragoal?.origin.inherited, false);
      assert.equal(status.ultragoal?.activeGoalId, 'G002-second');
      assert.deepEqual(status.ultragoal?.counts, { complete: 1, in_progress: 1, pending: 1 });
      assert.equal(status.ultragoal?.goals.length, 3);
      assert.equal(status.ultragoal?.lastCheckpoint?.goalId, 'G001-first');
      assert.equal(status.ultragoal?.lastLedgerEntry?.event, 'goal_started');
      assert.ok(status.ultragoal?.paths.runDir?.endsWith(join('runs', 'run-20260726T000000Z-abcd1234')));

      const team = status.teams.find((candidate) => candidate.name === 'execute-g006-runtime-a784b8fd');
      assert.equal(team?.active, true);
      assert.equal(team?.agentCount, 2);
      assert.deepEqual(team?.workerWorktrees, ['worker-1']);

      // Session-scoped state files are visible to an outside reader too.
      assert.ok(status.modes.some((mode) => mode.mode === 'team' && mode.sessionId === 'sess-1'));
      assert.ok(status.modes.some((mode) => mode.mode === 'ultragoal' && mode.sessionId === null && mode.active));
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
});
