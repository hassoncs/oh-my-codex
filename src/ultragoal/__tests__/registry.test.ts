import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUltragoalGoal,
  adoptUltragoalRun,
  createUltragoalPlan,
  readUltragoalPlan,
  UltragoalRegistryConflictError,
  type UltragoalPlan,
} from '../artifacts.js';
import {
  computeUltragoalBriefHash,
  isInheritedOrigin,
  legacyRunIdForPlan,
  readActiveRunPointer,
  ultragoalRunDir,
} from '../registry.js';
import { readUltragoalState } from '../../hud/state.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-registry-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const BRIEF_A = '# Brief A\n\n- Goal one thing\n- Goal another thing\n';
const BRIEF_B = '# Brief B\n\n- Something entirely different\n- And a second unrelated story\n';

async function seedStaleFlatRegistry(cwd: string, overrides: Partial<UltragoalPlan> = {}): Promise<void> {
  const dir = join(cwd, '.omx', 'ultragoal');
  await mkdir(dir, { recursive: true });
  const plan: UltragoalPlan = {
    version: 1,
    createdAt: '2026-07-12T09:26:58.842Z',
    updatedAt: '2026-07-12T09:26:58.842Z',
    briefPath: '.omx/ultragoal/brief.md',
    goalsPath: '.omx/ultragoal/goals.json',
    ledgerPath: '.omx/ultragoal/ledger.jsonl',
    codexGoalMode: 'aggregate',
    goals: [
      {
        id: 'G001-legacy-governance',
        title: 'Legacy governance goal',
        objective: 'A goal from a completely unrelated earlier run.',
        status: 'pending',
        attempt: 0,
        createdAt: '2026-07-12T09:26:58.842Z',
        updatedAt: '2026-07-12T09:26:58.842Z',
      },
    ],
    ...overrides,
  };
  await writeFile(join(dir, 'goals.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(join(dir, 'brief.md'), '# Legacy brief\n');
  await writeFile(join(dir, 'ledger.jsonl'), '');
}

describe('ultragoal run namespacing', () => {
  it('creates a namespaced run directory and an active-run pointer', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      assert.ok(plan.runId, 'plan carries a runId');
      assert.equal(plan.briefHash, computeUltragoalBriefHash(BRIEF_A));
      assert.equal(plan.origin?.worktreePath, cwd);

      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      assert.ok(existsSync(join(runDir, 'goals.json')), 'canonical run goals.json exists');
      assert.ok(existsSync(join(runDir, 'brief.md')), 'canonical run brief exists');

      const pointer = await readActiveRunPointer(cwd);
      assert.equal(pointer?.runId, plan.runId);

      // The flat file remains the active-run projection every reader consumes.
      const projected = JSON.parse(await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'));
      assert.equal(projected.runId, plan.runId);
    });
  });

  it('refuses a new run when a pre-namespacing registry already occupies the tree', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      await assert.rejects(
        () => createUltragoalPlan(cwd, { brief: BRIEF_A }),
        (error: unknown) => {
          assert.ok(error instanceof UltragoalRegistryConflictError);
          assert.equal(error.reason, 'unnamespaced_legacy_registry');
          assert.match(error.message, /--archive-existing/);
          assert.match(error.message, /--adopt-existing/);
          assert.match(error.message, /--new-namespace/);
          return true;
        },
      );
    });
  });

  it('refuses a new run when the existing registry came from a different brief', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      await assert.rejects(
        () => createUltragoalPlan(cwd, { brief: BRIEF_B }),
        (error: unknown) => {
          assert.ok(error instanceof UltragoalRegistryConflictError);
          assert.equal(error.reason, 'brief_mismatch');
          return true;
        },
      );
    });
  });

  it('resumes the same run when the same brief starts again in the same tree', async () => {
    await withTempRepo(async (cwd) => {
      const first = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const second = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      assert.equal(second.runId, first.runId);
      assert.equal(second.goals.length, first.goals.length);
    });
  });

  it('--archive-existing preserves the previous registry under runs/ and starts a fresh namespace', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A, archiveExisting: true });
      assert.ok(plan.runId);
      assert.ok(!plan.goals.some((goal) => goal.id === 'G001-legacy-governance'), 'new run does not inherit legacy goals');

      const archivedDir = ultragoalRunDir(cwd, legacyRunIdForPlan({
        createdAt: '2026-07-12T09:26:58.842Z',
        goals: [{ id: 'G001-legacy-governance' }],
      }));
      assert.ok(existsSync(join(archivedDir, 'goals.json')), 'legacy registry archived, not destroyed');
      const archived = JSON.parse(await readFile(join(archivedDir, 'goals.json'), 'utf-8'));
      assert.equal(archived.goals[0].id, 'G001-legacy-governance');
    });
  });

  it('--new-namespace preserves the previous registry instead of destroying it', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      await writeFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), `${JSON.stringify({ ts: 'x', event: 'plan_created' })}\n`);

      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A, newNamespace: true });
      assert.ok(plan.runId);
      assert.ok(!plan.goals.some((goal) => goal.id === 'G001-legacy-governance'));

      // Creating a run truncates the flat ledger and overwrites the flat plan;
      // a pre-namespacing registry has no run directory behind those files.
      const archivedDir = ultragoalRunDir(cwd, legacyRunIdForPlan({
        createdAt: '2026-07-12T09:26:58.842Z',
        goals: [{ id: 'G001-legacy-governance' }],
      }));
      const archived = JSON.parse(await readFile(join(archivedDir, 'goals.json'), 'utf-8'));
      assert.equal(archived.goals[0].id, 'G001-legacy-governance');
      assert.match(await readFile(join(archivedDir, 'ledger.jsonl'), 'utf-8'), /plan_created/);
    });
  });

  it('--new-namespace leaves an existing namespaced run intact', async () => {
    await withTempRepo(async (cwd) => {
      const first = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const second = await createUltragoalPlan(cwd, { brief: BRIEF_B, newNamespace: true });

      assert.notEqual(second.runId, first.runId);
      const priorRun = JSON.parse(await readFile(join(ultragoalRunDir(cwd, first.runId as string), 'goals.json'), 'utf-8'));
      assert.equal(priorRun.runId, first.runId);
      assert.equal((await readActiveRunPointer(cwd))?.runId, second.runId);
    });
  });

  it('--new-namespace preserves a same-second run with the same brief', async () => {
    await withTempRepo(async (cwd) => {
      const now = new Date('2026-08-01T13:38:12.000Z');
      const first = await createUltragoalPlan(cwd, { brief: BRIEF_A, now });
      const firstDir = ultragoalRunDir(cwd, first.runId as string);
      const firstGoals = await readFile(join(firstDir, 'goals.json'), 'utf-8');
      const firstLedger = await readFile(join(firstDir, 'ledger.jsonl'), 'utf-8');

      const second = await createUltragoalPlan(cwd, {
        brief: BRIEF_A,
        goals: [{ title: 'Replacement', objective: 'Start a distinct replacement run.' }],
        newNamespace: true,
        now,
      });

      assert.equal(second.runId, `${first.runId}-2`);
      assert.equal(await readFile(join(firstDir, 'goals.json'), 'utf-8'), firstGoals);
      assert.equal(await readFile(join(firstDir, 'ledger.jsonl'), 'utf-8'), firstLedger);
      assert.equal(
        await readFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), 'utf-8'),
        await readFile(join(ultragoalRunDir(cwd, second.runId as string), 'ledger.jsonl'), 'utf-8'),
      );
    });
  });

  it('--adopt-existing continues the existing registry as this run', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A, adoptExisting: true });
      assert.equal(plan.goals[0].id, 'G001-legacy-governance');
      assert.ok(plan.runId, 'adopted registry gains a run namespace');
      const pointer = await readActiveRunPointer(cwd);
      assert.equal(pointer?.runId, plan.runId);
    });
  });
});

describe('ultragoal registries inherited by CoW clones', () => {
  it('detects a registry whose origin is another worktree', () => {
    assert.equal(isInheritedOrigin({ worktreePath: '/a', createdAt: 'x' }, '/b'), true);
    assert.equal(isInheritedOrigin({ worktreePath: '/a', createdAt: 'x' }, '/a'), false);
    assert.equal(
      isInheritedOrigin({ worktreePath: '/a', createdAt: 'x', adoptedWorktreePaths: ['/b'] }, '/b'),
      false,
    );
    // Pre-namespacing plans carry no origin and stay readable.
    assert.equal(isInheritedOrigin(undefined, '/b'), false);
  });

  it('refuses to read an inherited registry and does not count its goals in the HUD', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd, {
        runId: 'run-20260712T092658Z-deadbeef',
        briefHash: 'deadbeefdeadbeef',
        origin: { worktreePath: '/some/other/worktree', createdAt: '2026-07-12T09:26:58.842Z' },
      });

      await assert.rejects(
        () => readUltragoalPlan(cwd),
        (error: unknown) => {
          assert.ok(error instanceof UltragoalRegistryConflictError);
          assert.equal(error.reason, 'inherited_worktree');
          return true;
        },
      );

      // Shutdown gates read HUD state; an inherited registry must not gate this tree.
      assert.equal(await readUltragoalState(cwd), null);
    });
  });

  it('treats a git-tracked registry as delivered, not inherited', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd, {
        runId: 'run-20260712T092658Z-deadbeef',
        briefHash: 'deadbeefdeadbeef',
        origin: { worktreePath: '/some/other/worktree', createdAt: '2026-07-12T09:26:58.842Z' },
      });
      // A repo that commits .omx/ultragoal/goals.json bakes an absolute origin
      // path into the commit; every fresh worktree would otherwise refuse forever.
      const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });
      git('init', '-q');
      git('config', 'user.email', 'test@example.com');
      git('config', 'user.name', 'test');
      git('add', '.omx/ultragoal/goals.json');
      git('commit', '-q', '-m', 'track registry');

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.runId, 'run-20260712T092658Z-deadbeef');
      assert.ok(await readUltragoalState(cwd), 'HUD still counts a git-delivered registry');
    });
  });

  it('adopt-run takes explicit ownership of an inherited registry', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd, {
        runId: 'run-20260712T092658Z-deadbeef',
        briefHash: 'deadbeefdeadbeef',
        origin: { worktreePath: '/some/other/worktree', createdAt: '2026-07-12T09:26:58.842Z' },
      });

      const adopted = await adoptUltragoalRun(cwd);
      assert.deepEqual(adopted.origin?.adoptedWorktreePaths, [cwd]);

      const reread = await readUltragoalPlan(cwd);
      assert.equal(reread.runId, 'run-20260712T092658Z-deadbeef');
      const hud = await readUltragoalState(cwd);
      assert.ok(hud, 'adopted registry is visible to the HUD again');
    });
  });

  it('adopt-run normalizes a namespaced legacy run and restores byte-identical ledger projections', async () => {
    await withTempRepo(async (cwd) => {
      const runId = 'legacy-b4108a96';
      const createdAt = '2026-07-29T12:21:00.000Z';
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, runId);
      const plan: UltragoalPlan = {
        version: 1,
        createdAt,
        updatedAt: createdAt,
        runId,
        briefHash: 'fca15e24895b9216',
        origin: { worktreePath: '/prior/tree', createdAt },
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        codexGoalMode: 'aggregate',
        activeGoalId: 'G002-active',
        goals: [
          {
            id: 'G001-complete',
            title: 'Complete',
            objective: 'Preserve completed work.',
            status: 'completed' as never,
            attempt: 1,
            createdAt,
            updatedAt: createdAt,
            completedAt: createdAt,
          },
          {
            id: 'G002-active',
            title: 'Active',
            objective: 'Continue active work.',
            status: 'in_progress',
            attempt: 1,
            createdAt,
            updatedAt: createdAt,
            startedAt: createdAt,
          },
        ],
      };
      const historical = `${JSON.stringify({ ts: createdAt, event: 'goal_completed', goalId: 'G001-complete', status: 'completed' })}\n`;
      const projected = `${historical}${JSON.stringify({ ts: createdAt, event: 'plan_created', message: 'legacy run adopted' })}\n`;

      await mkdir(runDir, { recursive: true });
      await writeFile(join(dir, 'goals.json'), `${JSON.stringify(plan, null, 2)}\n`);
      await writeFile(join(runDir, 'goals.json'), `${JSON.stringify(plan, null, 2)}\n`);
      await writeFile(join(dir, 'ledger.jsonl'), projected);
      await writeFile(join(runDir, 'ledger.jsonl'), projected.slice(historical.length));
      await chmod(join(dir, 'ledger.jsonl'), 0o600);
      await chmod(join(runDir, 'ledger.jsonl'), 0o600);
      await writeFile(join(dir, 'active-run.json'), `${JSON.stringify({
        version: 1,
        runId,
        briefHash: plan.briefHash,
        updatedAt: createdAt,
        origin: plan.origin,
      }, null, 2)}\n`);

      const adopted = await adoptUltragoalRun(cwd, { now: new Date('2026-08-01T13:07:45.705Z') });
      const flatGoals = await readFile(join(dir, 'goals.json'), 'utf-8');
      const runGoals = await readFile(join(runDir, 'goals.json'), 'utf-8');
      const flatLedger = await readFile(join(dir, 'ledger.jsonl'), 'utf-8');
      const runLedger = await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');

      assert.equal(adopted.goals[0]?.status, 'complete');
      assert.equal(flatGoals, runGoals);
      assert.equal(flatLedger, runLedger);
      assert.equal((await stat(join(dir, 'ledger.jsonl'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(runDir, 'ledger.jsonl'))).mode & 0o777, 0o600);
      assert.ok(flatLedger.startsWith(projected));
      assert.match(flatLedger, /"event":"plan_migrated"/);
      assert.match(flatLedger, /"event":"plan_created"/);
    });
  });

  it('recovers an interrupted ledger append without duplicating or losing the event', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      const flatPath = join(dir, 'ledger.jsonl');
      const runPath = join(runDir, 'ledger.jsonl');
      const base = await readFile(runPath, 'utf-8');
      assert.equal(await readFile(flatPath, 'utf-8'), base);
      const line = `${JSON.stringify({ ts: '2026-08-01T13:30:00.000Z', event: 'plan_migrated', message: 'recover exactly once' })}\n`;
      const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');

      await writeFile(runPath, `${base}${line}`);
      await writeFile(join(dir, '.ledger-transaction.json'), `${JSON.stringify({
        version: 1,
        runId: plan.runId,
        line,
        baseSha256: digest(base),
        nextSha256: digest(`${base}${line}`),
      }, null, 2)}\n`, { mode: 0o600 });

      await readUltragoalPlan(cwd);

      const flat = await readFile(flatPath, 'utf-8');
      const run = await readFile(runPath, 'utf-8');
      assert.equal(flat, run);
      assert.equal(flat.split('recover exactly once').length - 1, 1);
      assert.equal(existsSync(join(dir, '.ledger-transaction.json')), false);
    });
  });

  it('serializes concurrent mutations without losing ledger entries', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });

      await Promise.all([
        addUltragoalGoal(cwd, { title: 'Concurrent A', objective: 'Preserve mutation A.' }),
        addUltragoalGoal(cwd, { title: 'Concurrent B', objective: 'Preserve mutation B.' }),
      ]);

      const reread = await readUltragoalPlan(cwd);
      assert.ok(reread.goals.some((goal) => goal.title === 'Concurrent A'));
      assert.ok(reread.goals.some((goal) => goal.title === 'Concurrent B'));
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      const flat = await readFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), 'utf-8');
      const run = await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');
      assert.equal(flat, run);
      assert.equal(flat.match(/"event":"goal_added"/g)?.length, 2);
    });
  });

  it('fails closed before adoption when a containing ledger is malformed', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      const goalsPath = join(dir, 'goals.json');
      const runGoalsPath = join(runDir, 'goals.json');
      const stored = JSON.parse(await readFile(goalsPath, 'utf-8')) as UltragoalPlan;
      stored.goals[0]!.status = 'completed' as never;
      const goalsBefore = `${JSON.stringify(stored, null, 2)}\n`;
      await writeFile(goalsPath, goalsBefore);
      await writeFile(runGoalsPath, goalsBefore);
      const runLedger = await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');
      await writeFile(join(dir, 'ledger.jsonl'), `${runLedger}{"ts":`);

      await assert.rejects(
        () => adoptUltragoalRun(cwd),
        /Invalid ultragoal ledger/,
      );

      assert.equal(await readFile(goalsPath, 'utf-8'), goalsBefore);
      assert.equal(await readFile(runGoalsPath, 'utf-8'), goalsBefore);
    });
  });
});
