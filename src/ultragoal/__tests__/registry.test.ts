import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
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
});
