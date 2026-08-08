import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  archiveFlatRegistry,
  computeUltragoalBriefHash,
  isInheritedOrigin,
  legacyRunIdForPlan,
  readActiveRunPointer,
  ultragoalRunDir,
  writeActiveRunPointer,
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
const sha256 = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');

async function optionalDigest(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function transactionBefore(cwd: string, runId: string): Promise<{
  run: { brief: string | null; goals: string | null; ledger: string | null };
  projection: { brief: string | null; goals: string | null; ledger: string | null };
  pointerSha256: string | null;
}> {
  const dir = join(cwd, '.omx', 'ultragoal');
  const runDir = ultragoalRunDir(cwd, runId);
  return {
    run: {
      brief: await optionalDigest(join(runDir, 'brief.md')),
      goals: await optionalDigest(join(runDir, 'goals.json')),
      ledger: await optionalDigest(join(runDir, 'ledger.jsonl')),
    },
    projection: {
      brief: await optionalDigest(join(dir, 'brief.md')),
      goals: await optionalDigest(join(dir, 'goals.json')),
      ledger: await optionalDigest(join(dir, 'ledger.jsonl')),
    },
    pointerSha256: await optionalDigest(join(dir, 'active-run.json')),
  };
}

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

async function writeStagedUpdateTransaction(
  cwd: string,
  plan: UltragoalPlan,
  options: {
    brief?: string;
    goals?: unknown;
    ledger?: string;
    pointer?: {
      version: 1;
      runId: string;
      briefHash: string;
      updatedAt: string;
      origin: NonNullable<UltragoalPlan['origin']>;
    };
  } = {},
): Promise<{ journalPath: string; stageDir: string }> {
  const runId = plan.runId as string;
  const dir = join(cwd, '.omx', 'ultragoal');
  const runDir = ultragoalRunDir(cwd, runId);
  const stageDir = join(dir, `.run-stage-${runId}`);
  const brief = options.brief ?? await readFile(join(runDir, 'brief.md'), 'utf-8');
  const goals = `${JSON.stringify(options.goals ?? plan, null, 2)}\n`;
  const ledger = options.ledger ?? await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');
  const pointer = options.pointer ?? {
    version: 1,
    runId,
    briefHash: plan.briefHash as string,
    updatedAt: plan.updatedAt,
    origin: plan.origin as NonNullable<UltragoalPlan['origin']>,
  };

  await mkdir(stageDir, { recursive: true });
  await writeFile(join(stageDir, 'brief.md'), brief);
  await writeFile(join(stageDir, 'goals.json'), goals);
  await writeFile(join(stageDir, 'ledger.jsonl'), ledger, { mode: 0o600 });
  const journalPath = join(dir, '.run-transaction.json');
  await writeFile(journalPath, `${JSON.stringify({
    version: 1,
    mode: 'update',
    runId,
    pointer,
    files: {
      brief: sha256(brief),
      goals: sha256(goals),
      ledger: sha256(ledger),
    },
    before: await transactionBefore(cwd, runId),
  }, null, 2)}\n`, { mode: 0o600 });
  return { journalPath, stageDir };
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
      assert.deepEqual(pointer?.files, {
        brief: sha256(await readFile(join(runDir, 'brief.md'), 'utf-8')),
        goals: sha256(await readFile(join(runDir, 'goals.json'), 'utf-8')),
        ledger: sha256(await readFile(join(runDir, 'ledger.jsonl'), 'utf-8')),
      });

      // The flat file remains the active-run projection every reader consumes.
      const projected = JSON.parse(await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'));
      assert.equal(projected.runId, plan.runId);
    });
  });

  it('refuses a pre-existing symlink at the staged run directory', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const now = new Date('2026-08-01T13:38:00.000Z');
      const runId = `run-20260801T133800Z-${computeUltragoalBriefHash(BRIEF_A).slice(0, 8)}`;
      const dir = join(cwd, '.omx', 'ultragoal');
      const stageDir = join(dir, `.run-stage-${runId}`);
      const externalDir = join(cwd, 'external-stage-target');
      const marker = join(externalDir, 'preserve.txt');
      await mkdir(dir, { recursive: true });
      await mkdir(externalDir);
      await writeFile(marker, 'preserve\n');
      await symlink(externalDir, stageDir);

      await assert.rejects(
        createUltragoalPlan(cwd, { brief: BRIEF_A, now }),
        /Refusing unsafe ultragoal directory/,
      );

      assert.equal((await lstat(stageDir)).isSymbolicLink(), true);
      assert.equal(await readFile(marker, 'utf-8'), 'preserve\n');
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

  it('finishes a matching partial legacy archive without overwriting history', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const plan = JSON.parse(
        await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'),
      ) as UltragoalPlan;
      const runId = legacyRunIdForPlan(plan);
      const runDir = ultragoalRunDir(cwd, runId);
      await mkdir(runDir, { recursive: true });
      await writeFile(
        join(runDir, 'goals.json'),
        await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json')),
      );

      await archiveFlatRegistry(cwd, runId);

      assert.equal(
        await readFile(join(runDir, 'brief.md'), 'utf-8'),
        await readFile(join(cwd, '.omx', 'ultragoal', 'brief.md'), 'utf-8'),
      );
      assert.equal(
        await readFile(join(runDir, 'ledger.jsonl'), 'utf-8'),
        await readFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), 'utf-8'),
      );
      assert.equal(
        (await readdir(join(cwd, '.omx', 'ultragoal', 'runs')))
          .some((entry) => entry.startsWith(`.archive-stage-${runId}`)),
        false,
      );
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
        briefHash: computeUltragoalBriefHash('# Legacy brief\n').slice(0, 16),
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
        briefHash: computeUltragoalBriefHash('# Legacy brief\n').slice(0, 16),
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
        briefHash: computeUltragoalBriefHash('# Legacy brief\n').slice(0, 16),
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
      const brief = 'legacy adopted brief\n';
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, runId);
      const plan: UltragoalPlan = {
        version: 1,
        createdAt,
        updatedAt: createdAt,
        runId,
        briefHash: computeUltragoalBriefHash(brief).slice(0, 16),
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
      await writeFile(join(dir, 'brief.md'), brief);
      await writeFile(join(runDir, 'brief.md'), brief);
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
      await writeFile(join(dir, '.mutation.lock'), JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T13:29:59.000Z',
        ownerToken: 'crashed-writer',
      }));

      await readUltragoalPlan(cwd);

      const flat = await readFile(flatPath, 'utf-8');
      const run = await readFile(runPath, 'utf-8');
      assert.equal(flat, run);
      assert.equal(flat.split('recover exactly once').length - 1, 1);
      assert.equal(existsSync(join(dir, '.ledger-transaction.json')), false);
      assert.equal(existsSync(join(dir, '.mutation.lock')), false);
    });
  });

  it('recovers a staged namespace transition without rewriting the archived run', async () => {
    await withTempRepo(async (cwd) => {
      const first = await createUltragoalPlan(cwd, {
        brief: BRIEF_A,
        now: new Date('2026-08-01T13:38:12.000Z'),
      });
      const dir = join(cwd, '.omx', 'ultragoal');
      const firstRunDir = ultragoalRunDir(cwd, first.runId as string);
      const firstFiles = {
        brief: await readFile(join(firstRunDir, 'brief.md'), 'utf-8'),
        goals: await readFile(join(firstRunDir, 'goals.json'), 'utf-8'),
        ledger: await readFile(join(firstRunDir, 'ledger.jsonl'), 'utf-8'),
      };
      const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');
      const nextBriefHash = computeUltragoalBriefHash(BRIEF_B);
      const nextRunId = `run-20260801T133813Z-${nextBriefHash.slice(0, 8)}`;
      const nextCreatedAt = '2026-08-01T13:38:13.000Z';
      const nextPlan: UltragoalPlan = {
        ...first,
        createdAt: nextCreatedAt,
        updatedAt: nextCreatedAt,
        runId: nextRunId,
        briefHash: nextBriefHash,
        origin: { worktreePath: cwd, createdAt: nextCreatedAt },
        activeGoalId: undefined,
        goals: [{
          id: 'G001-replacement',
          title: 'Replacement',
          objective: 'Recover the staged namespace transition.',
          status: 'pending',
          attempt: 0,
          createdAt: nextCreatedAt,
          updatedAt: nextCreatedAt,
        }],
      };
      const nextFiles = {
        brief: BRIEF_B,
        goals: `${JSON.stringify(nextPlan, null, 2)}\n`,
        ledger: `${JSON.stringify({
          ts: nextCreatedAt,
          event: 'plan_created',
          message: `1 goal(s) created in run ${nextRunId}`,
        })}\n`,
      };
      const stageDir = join(dir, `.run-stage-${nextRunId}`);
      await mkdir(stageDir, { recursive: true });
      await writeFile(join(stageDir, 'brief.md'), nextFiles.brief);
      await writeFile(join(stageDir, 'goals.json'), nextFiles.goals);
      await writeFile(join(stageDir, 'ledger.jsonl'), nextFiles.ledger, { mode: 0o600 });
      await writeFile(join(dir, '.run-transaction.json'), `${JSON.stringify({
        version: 1,
        runId: nextRunId,
        pointer: {
          version: 1,
          runId: nextRunId,
          briefHash: nextBriefHash,
          updatedAt: nextCreatedAt,
          origin: nextPlan.origin,
        },
        files: {
          brief: digest(nextFiles.brief),
          goals: digest(nextFiles.goals),
          ledger: digest(nextFiles.ledger),
        },
        before: await transactionBefore(cwd, nextRunId),
        archive: {
          runId: first.runId,
          files: {
            brief: digest(firstFiles.brief),
            goals: digest(firstFiles.goals),
            ledger: digest(firstFiles.ledger),
          },
        },
      }, null, 2)}\n`, { mode: 0o600 });

      // Crash after partially replacing the flat projection but before pointer commit.
      await writeFile(join(dir, 'brief.md'), nextFiles.brief);
      await writeFile(join(dir, '.mutation.lock'), JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T13:38:13.100Z',
        ownerToken: 'crashed-run-writer',
      }));

      const recovered = await readUltragoalPlan(cwd);
      const nextRunDir = ultragoalRunDir(cwd, nextRunId);
      assert.equal(recovered.runId, nextRunId);
      assert.equal((await readActiveRunPointer(cwd))?.runId, nextRunId);
      assert.equal(await readFile(join(dir, 'brief.md'), 'utf-8'), nextFiles.brief);
      assert.equal(await readFile(join(dir, 'goals.json'), 'utf-8'), nextFiles.goals);
      assert.equal(await readFile(join(dir, 'ledger.jsonl'), 'utf-8'), nextFiles.ledger);
      assert.equal(await readFile(join(nextRunDir, 'goals.json'), 'utf-8'), nextFiles.goals);
      assert.equal(await readFile(join(firstRunDir, 'brief.md'), 'utf-8'), firstFiles.brief);
      assert.equal(await readFile(join(firstRunDir, 'goals.json'), 'utf-8'), firstFiles.goals);
      assert.equal(await readFile(join(firstRunDir, 'ledger.jsonl'), 'utf-8'), firstFiles.ledger);
      assert.equal(existsSync(join(dir, '.run-transaction.json')), false);
      assert.equal(existsSync(join(dir, '.mutation.lock')), false);
    });
  });

  it('recovers an interrupted ordinary mutation as one goals and ledger state', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: BRIEF_A,
        now: new Date('2026-08-01T13:39:00.000Z'),
      });
      const runId = plan.runId as string;
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, runId);
      const brief = await readFile(join(runDir, 'brief.md'), 'utf-8');
      const baseLedger = await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');
      const updatedAt = '2026-08-01T13:39:01.000Z';
      const nextPlan: UltragoalPlan = {
        ...plan,
        updatedAt,
        goals: [
          ...plan.goals,
          {
            id: 'G003-recovered-mutation',
            title: 'Recovered mutation',
            objective: 'Recover goals and audit together.',
            status: 'pending',
            attempt: 0,
            createdAt: updatedAt,
            updatedAt,
          },
        ],
      };
      const goals = `${JSON.stringify(nextPlan, null, 2)}\n`;
      const ledger = `${baseLedger}${JSON.stringify({
        ts: updatedAt,
        event: 'goal_added',
        goalId: 'G003-recovered-mutation',
        status: 'pending',
        message: 'Recovered mutation',
      })}\n`;
      const stageDir = join(dir, `.run-stage-${runId}`);
      const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');
      const transaction = {
        version: 1,
        mode: 'update',
        runId,
        pointer: {
          version: 1,
          runId,
          briefHash: plan.briefHash,
          updatedAt,
          origin: plan.origin,
        },
        files: {
          brief: digest(brief),
          goals: digest(goals),
          ledger: digest(ledger),
        },
        before: await transactionBefore(cwd, runId),
      };

      await mkdir(stageDir, { recursive: true });
      await writeFile(join(stageDir, 'brief.md'), brief);
      await writeFile(join(stageDir, 'goals.json'), goals);
      await writeFile(join(stageDir, 'ledger.jsonl'), ledger, { mode: 0o600 });
      await writeFile(join(dir, '.run-transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`, { mode: 0o600 });

      // Crash after canonical goals advance but before canonical ledger and flat projection.
      await writeFile(join(runDir, 'goals.json'), goals);
      await writeFile(join(dir, '.mutation.lock'), JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T13:39:01.100Z',
        ownerToken: 'crashed-update-writer',
      }));

      const recovered = await readUltragoalPlan(cwd);
      assert.ok(recovered.goals.some((goal) => goal.id === 'G003-recovered-mutation'));
      assert.equal(await readFile(join(runDir, 'goals.json'), 'utf-8'), goals);
      assert.equal(await readFile(join(dir, 'goals.json'), 'utf-8'), goals);
      assert.equal(await readFile(join(runDir, 'ledger.jsonl'), 'utf-8'), ledger);
      assert.equal(await readFile(join(dir, 'ledger.jsonl'), 'utf-8'), ledger);
      assert.equal(existsSync(join(dir, '.run-transaction.json')), false);
      assert.equal(existsSync(stageDir), false);

      // Crash after stage cleanup but before journal removal still converges.
      await writeFile(join(dir, '.run-transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`, { mode: 0o600 });
      await writeFile(join(dir, '.mutation.lock'), JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T13:39:01.200Z',
        ownerToken: 'crashed-terminal-update-writer',
      }));
      await readUltragoalPlan(cwd);
      assert.equal(existsSync(join(dir, '.run-transaction.json')), false);
    });
  });

  it('refuses recovery after unrelated canonical divergence from the recorded prior state', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan);
      const canonicalGoals = join(ultragoalRunDir(cwd, plan.runId as string), 'goals.json');
      await writeFile(canonicalGoals, `${JSON.stringify({ unrelated: true })}\n`);

      await assert.rejects(
        readUltragoalPlan(cwd),
        /divergent canonical run .* goals/,
      );
      assert.equal(existsSync(journalPath), true);
    });
  });

  it('rejects run transactions without complete run and archive digests', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: BRIEF_A,
        now: new Date('2026-08-01T13:41:00.000Z'),
      });
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      const files = {
        brief: await readFile(join(runDir, 'brief.md'), 'utf-8'),
        goals: await readFile(join(runDir, 'goals.json'), 'utf-8'),
        ledger: await readFile(join(runDir, 'ledger.jsonl'), 'utf-8'),
      };
      const digest = (value: string) => createHash('sha256').update(value, 'utf-8').digest('hex');
      const pointer = await readActiveRunPointer(cwd);
      assert.ok(pointer);

      const transactionPath = join(dir, '.run-transaction.json');
      const baseTransaction = {
        version: 1,
        runId: plan.runId,
        pointer,
        files: {
          brief: digest(files.brief),
          goals: digest(files.goals),
          ledger: digest(files.ledger),
        },
        before: await transactionBefore(cwd, plan.runId as string),
      };

      await writeFile(transactionPath, `${JSON.stringify({ ...baseTransaction, files: {} }, null, 2)}\n`);
      await assert.rejects(
        readUltragoalPlan(cwd),
        /Invalid ultragoal run transaction/,
      );

      await writeFile(transactionPath, `${JSON.stringify({
        ...baseTransaction,
        archive: { runId: plan.runId, files: {} },
      }, null, 2)}\n`);
      await assert.rejects(
        readUltragoalPlan(cwd),
        /Invalid ultragoal run transaction/,
      );
      assert.equal(existsSync(transactionPath), true);
    });
  });

  it('preserves a malformed staged plan and its journal for explicit repair', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const malformed = {
        ...plan,
        goals: [{ ...plan.goals[0], objective: undefined }],
      };
      const { journalPath, stageDir } = await writeStagedUpdateTransaction(cwd, plan, { goals: malformed });

      await assert.rejects(readUltragoalPlan(cwd), /Invalid ultragoal plan/);

      assert.equal(existsSync(journalPath), true);
      assert.equal(existsSync(stageDir), true);
    });
  });

  it('rejects a staged brief whose hash does not match the pointer', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan, { brief: BRIEF_B });

      await assert.rejects(readUltragoalPlan(cwd), /run transaction identity mismatch/);

      assert.equal(existsSync(journalPath), true);
    });
  });

  it('rejects staged plan and pointer timestamp divergence', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan, {
        pointer: {
          version: 1,
          runId: plan.runId as string,
          briefHash: plan.briefHash as string,
          updatedAt: '2026-08-01T13:45:00.000Z',
          origin: plan.origin as NonNullable<UltragoalPlan['origin']>,
        },
      });

      await assert.rejects(readUltragoalPlan(cwd), /run transaction identity mismatch/);

      assert.equal(existsSync(journalPath), true);
    });
  });

  it('rejects staged plan and pointer origin divergence', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan, {
        pointer: {
          version: 1,
          runId: plan.runId as string,
          briefHash: plan.briefHash as string,
          updatedAt: plan.updatedAt,
          origin: {
            worktreePath: '/different/tree',
            createdAt: plan.origin?.createdAt as string,
          },
        },
      });

      await assert.rejects(readUltragoalPlan(cwd), /run transaction identity mismatch/);

      assert.equal(existsSync(journalPath), true);
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

  it('releases the advisory mutation guard when its holder crashes', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const guardPath = join(cwd, '.omx', 'ultragoal', '.mutation.guard');
      const holderScript = [
        'process.stdout.write("LOCKED\\n");',
        'process.stdin.resume();',
      ].join('');
      const child = process.platform === 'darwin'
        ? spawn('/usr/bin/lockf', ['-k', '-t', '0', guardPath, process.execPath, '-e', holderScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
          })
        : spawn('flock', ['-n', guardPath, process.execPath, '-e', holderScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout.setEncoding('utf-8');
        child.stdout.on('data', (chunk: string) => {
          if (chunk.includes('LOCKED')) resolve();
        });
      });

      let settled = false;
      const reading = readUltragoalPlan(cwd).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(settled, false);

      child.kill('SIGKILL');
      const reread = await reading;
      assert.equal(reread.runId, plan.runId);
    });
  });

  it('promotes a pre-namespacing goal mutation into one canonical run state', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);

      const { plan } = await addUltragoalGoal(cwd, {
        title: 'Canonical mutation',
        objective: 'Promote goals and ledger together.',
        now: new Date('2026-08-01T13:46:00.000Z'),
      });

      assert.match(plan.runId as string, /^legacy-/);
      assert.match(plan.briefHash as string, /^[a-f0-9]{64}$/);
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      assert.equal(
        await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'),
        await readFile(join(runDir, 'goals.json'), 'utf-8'),
      );
      const flatLedger = await readFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), 'utf-8');
      assert.equal(flatLedger, await readFile(join(runDir, 'ledger.jsonl'), 'utf-8'));
      assert.match(flatLedger, /"event":"goal_added"/);
      assert.equal(existsSync(join(cwd, '.omx', 'ultragoal', '.run-transaction.json')), false);
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

  it('refuses explicit adoption when flat goals diverge from canonical goals', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const runGoalsPath = join(ultragoalRunDir(cwd, plan.runId as string), 'goals.json');
      const canonicalGoals = await readFile(runGoalsPath, 'utf-8');
      const flat = JSON.parse(canonicalGoals) as UltragoalPlan;
      flat.goals[0]!.status = 'complete';
      await writeFile(join(dir, 'goals.json'), `${JSON.stringify(flat, null, 2)}\n`);

      await assert.rejects(
        () => adoptUltragoalRun(cwd),
        /Refusing to use divergent flat and canonical ultragoal goals/,
      );
      assert.equal(await readFile(runGoalsPath, 'utf-8'), canonicalGoals);
    });
  });

  it('refuses a new namespace when the flat ledger diverges from its canonical archive', async () => {
    await withTempRepo(async (cwd) => {
      const first = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const runDir = ultragoalRunDir(cwd, first.runId as string);
      const canonicalLedger = await readFile(join(runDir, 'ledger.jsonl'), 'utf-8');
      await writeFile(
        join(dir, 'ledger.jsonl'),
        `${canonicalLedger}${JSON.stringify({ ts: '2026-08-01T13:42:00.000Z', event: 'unexpected_flat_only' })}\n`,
      );

      await assert.rejects(
        () => createUltragoalPlan(cwd, { brief: BRIEF_B, newNamespace: true }),
        /Refusing to archive divergent flat and canonical ultragoal run/,
      );
      assert.equal(await readFile(join(runDir, 'ledger.jsonl'), 'utf-8'), canonicalLedger);
      assert.equal((await readActiveRunPointer(cwd))?.runId, first.runId);
    });
  });

  it('rejects a symlink occupying an existing canonical archive file', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const plan = JSON.parse(
        await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'),
      ) as UltragoalPlan;
      const runDir = ultragoalRunDir(cwd, legacyRunIdForPlan(plan));
      const target = join(cwd, 'symlink-target.json');
      await mkdir(runDir, { recursive: true });
      await writeFile(target, 'do not overwrite\n');
      await symlink(target, join(runDir, 'goals.json'));

      await assert.rejects(archiveFlatRegistry(cwd, legacyRunIdForPlan(plan)), /Refusing unsafe ultragoal archive file/);

      assert.equal(await readFile(target, 'utf-8'), 'do not overwrite\n');
    });
  });

  it('rejects a hard link occupying an existing canonical archive file', async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const plan = JSON.parse(
        await readFile(join(cwd, '.omx', 'ultragoal', 'goals.json'), 'utf-8'),
      ) as UltragoalPlan;
      const runDir = ultragoalRunDir(cwd, legacyRunIdForPlan(plan));
      const target = join(cwd, 'hardlink-target.json');
      await mkdir(runDir, { recursive: true });
      await writeFile(target, 'do not overwrite\n');
      await link(target, join(runDir, 'goals.json'));

      await assert.rejects(archiveFlatRegistry(cwd, legacyRunIdForPlan(plan)), /Refusing unsafe ultragoal archive file/);

      assert.equal(await readFile(target, 'utf-8'), 'do not overwrite\n');
      assert.equal((await stat(target)).nlink, 2);
    });
  });

  it('rejects a symlink occupying the canonical runs directory', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const dir = join(cwd, '.omx', 'ultragoal');
      const external = join(cwd, 'external-runs');
      await mkdir(external);
      await symlink(external, join(dir, 'runs'));

      const plan = JSON.parse(await readFile(join(dir, 'goals.json'), 'utf-8')) as UltragoalPlan;
      await assert.rejects(
        archiveFlatRegistry(cwd, legacyRunIdForPlan(plan)),
        /Refusing unsafe ultragoal archive directory/,
      );
      assert.equal(existsSync(join(external, legacyRunIdForPlan(plan))), false);
    });
  });

  it('rejects a symlink occupying a canonical run directory', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await seedStaleFlatRegistry(cwd);
      const dir = join(cwd, '.omx', 'ultragoal');
      const plan = JSON.parse(await readFile(join(dir, 'goals.json'), 'utf-8')) as UltragoalPlan;
      const runId = legacyRunIdForPlan(plan);
      const external = join(cwd, 'external-run');
      await mkdir(join(dir, 'runs'));
      await mkdir(external);
      await symlink(external, ultragoalRunDir(cwd, runId));

      await assert.rejects(
        archiveFlatRegistry(cwd, runId),
        /Refusing unsafe ultragoal archive directory/,
      );
      assert.equal(existsSync(join(external, 'goals.json')), false);
    });
  });

  it('does not reclaim a live legacy mutation lock', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1300)'], { stdio: 'ignore' });
      try {
        assert.ok(child.pid);
        await writeFile(join(dir, '.mutation.lock'), JSON.stringify({
          pid: child.pid,
          createdAt: new Date().toISOString(),
        }));
        const startedAt = Date.now();

        const reread = await readUltragoalPlan(cwd);

        assert.equal(reread.runId, plan.runId);
        assert.ok(Date.now() - startedAt >= 1_100, 'reader waited for the live legacy owner to exit');
        assert.equal(existsSync(join(dir, '.mutation.lock')), false);
      } finally {
        child.kill();
      }
    });
  });

  it('reclaims a legacy PID-only lock when the PID belongs to a newer process', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const lockPath = join(cwd, '.omx', 'ultragoal', '.mutation.lock');
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        createdAt: '1970-01-01T00:00:00.000Z',
      }));

      const reread = await readUltragoalPlan(cwd);

      assert.equal(reread.runId, plan.runId);
      assert.equal(existsSync(lockPath), false);
    });
  });

  it('rejects a symlink substituted for the mutation lock', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const lockPath = join(cwd, '.omx', 'ultragoal', '.mutation.lock');
      const target = join(cwd, 'mutation-lock-target.json');
      await writeFile(target, JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T17:30:00.000Z',
        ownerToken: 'external-owner',
      }));
      await symlink(target, lockPath);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal mutation lock/);
      assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
    });
  });

  it('releases the advisory guard after malformed lock metadata blocks acquisition', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const lockPath = join(cwd, '.omx', 'ultragoal', '.mutation.lock');
      await writeFile(lockPath, '{"invalid":true}\n');

      await assert.rejects(readUltragoalPlan(cwd), /Refusing malformed ultragoal mutation lock/);
      await rm(lockPath);

      const reread = await readUltragoalPlan(cwd);

      assert.equal(reread.runId, plan.runId);
    });
  });

  it('reclaims a crashed mutation lock publication candidate', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const lockPath = join(cwd, '.omx', 'ultragoal', '.mutation.lock');
      const ownerToken = 'crashed-publication';
      const candidatePath = `${lockPath}.${ownerToken}.candidate`;
      await writeFile(candidatePath, JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T17:30:00.000Z',
        ownerToken,
      }));
      await link(candidatePath, lockPath);

      const reread = await readUltragoalPlan(cwd);

      assert.equal(reread.runId, plan.runId);
      assert.equal(existsSync(lockPath), false);
      assert.equal(existsSync(candidatePath), false);
    });
  });

  it('rejects an unmatched hard link substituted for the mutation lock', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const lockPath = join(cwd, '.omx', 'ultragoal', '.mutation.lock');
      const target = join(cwd, 'mutation-lock-target.json');
      await writeFile(target, JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        createdAt: '2026-08-01T17:30:00.000Z',
        ownerToken: 'external-owner',
      }));
      await link(target, lockPath);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal mutation lock/);
      assert.equal((await lstat(lockPath)).nlink, 2);
    });
  });

  it('rejects a symlink substituted for an active canonical run file', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const canonical = join(ultragoalRunDir(cwd, plan.runId as string), 'goals.json');
      const target = join(cwd, 'canonical-symlink-target.json');
      await writeFile(target, await readFile(canonical));
      await rm(canonical);
      await symlink(target, canonical);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe canonical ultragoal run file/);
    });
  });

  it('rejects a symlink substituted for the active goals projection', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const goals = join(cwd, '.omx', 'ultragoal', 'goals.json');
      const target = join(cwd, 'active-goals-target.json');
      await writeFile(target, await readFile(goals));
      await rm(goals);
      await symlink(target, goals);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe active ultragoal projection/);
    });
  });

  it('rejects a symlink substituted for the active run pointer', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const pointer = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      const target = join(cwd, 'active-run-target.json');
      await writeFile(target, await readFile(pointer));
      await rm(pointer);
      await symlink(target, pointer);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal active-run pointer/);
    });
  });

  it('rejects a malformed active run pointer instead of treating it as absent', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const pointer = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      await writeFile(pointer, `${JSON.stringify({ version: 1, runId: 'weak' })}\n`);

      await assert.rejects(readUltragoalPlan(cwd), /Invalid ultragoal active-run pointer/);
    });
  });

  it('rejects a valid pointer for run B over run A canonical and projection bytes', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const pointerPath = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      const pointer = JSON.parse(await readFile(pointerPath, 'utf-8')) as Record<string, unknown>;
      pointer.runId = 'run-20260801T190000Z-deadbeef';
      await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

      await assert.rejects(
        readUltragoalPlan(cwd),
        /without matching active-run pointer authority/,
      );
    });
  });

  it('migrates a matching legacy active run pointer hash to full SHA-256', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const pointerPath = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      const pointer = JSON.parse(await readFile(pointerPath, 'utf-8')) as Record<string, unknown>;
      pointer.briefHash = String(pointer.briefHash).slice(0, 16);
      await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

      const reread = await readUltragoalPlan(cwd);
      const migrated = JSON.parse(await readFile(pointerPath, 'utf-8')) as Record<string, unknown>;
      const ledger = await readFile(join(cwd, '.omx', 'ultragoal', 'ledger.jsonl'), 'utf-8');

      assert.equal(reread.runId, plan.runId);
      assert.equal(migrated.briefHash, computeUltragoalBriefHash(BRIEF_A));
      assert.match(ledger, /Expanded legacy truncated active-run brief hash to full SHA-256/);
    });
  });

  it('refuses to replace a symlinked active run pointer during adoption', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const pointerPath = join(cwd, '.omx', 'ultragoal', 'active-run.json');
      const target = join(cwd, 'adoption-pointer-target.json');
      await writeFile(target, await readFile(pointerPath));
      await rm(pointerPath);
      await symlink(target, pointerPath);

      await assert.rejects(adoptUltragoalRun(cwd), /Refusing unsafe ultragoal active-run pointer/);
      assert.equal((await lstat(pointerPath)).isSymbolicLink(), true);
    });
  });

  it('refuses atomic pointer replacement over an unsafe destination and leaves no temporary file', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const pointerPath = join(dir, 'active-run.json');
      const pointer = await readActiveRunPointer(cwd);
      assert.ok(pointer);
      const target = join(cwd, 'unsafe-pointer-target.json');
      const targetBytes = await readFile(pointerPath, 'utf-8');
      await writeFile(target, targetBytes);
      await rm(pointerPath);
      await symlink(target, pointerPath);

      await assert.rejects(
        writeActiveRunPointer(cwd, pointer),
        /Refusing unsafe ultragoal active-run pointer/,
      );

      assert.equal((await lstat(pointerPath)).isSymbolicLink(), true);
      assert.equal(await readFile(target, 'utf-8'), targetBytes);
      assert.equal(
        (await readdir(dir)).some((entry) => entry.startsWith('active-run.json.') && entry.endsWith('.tmp')),
        false,
      );
    });
  });

  it('rejects a symlink substituted for an active canonical run directory', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const runDir = ultragoalRunDir(cwd, plan.runId as string);
      const external = join(cwd, 'canonical-run-target');
      await rename(runDir, external);
      await symlink(external, runDir);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal directory/);
    });
  });

  it('rejects a symlink substituted for a staged run file', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath, stageDir } = await writeStagedUpdateTransaction(cwd, plan);
      const stagedGoals = join(stageDir, 'goals.json');
      const target = join(cwd, 'staged-symlink-target.json');
      await writeFile(target, await readFile(stagedGoals));
      await rm(stagedGoals);
      await symlink(target, stagedGoals);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe staged run file/);
      assert.equal(existsSync(journalPath), true);
      assert.equal(await readFile(target, 'utf-8'), `${JSON.stringify(plan, null, 2)}\n`);
    });
  });

  it('rejects a symlink substituted for a staged run directory', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath, stageDir } = await writeStagedUpdateTransaction(cwd, plan);
      const target = join(cwd, 'staged-run-target');
      await rename(stageDir, target);
      await symlink(target, stageDir);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal directory/);
      assert.equal(existsSync(journalPath), true);
    });
  });

  it('rejects a symlink substituted for the canonical runs directory during recovery', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan);
      const runsDir = join(cwd, '.omx', 'ultragoal', 'runs');
      const external = join(cwd, 'canonical-runs-target');
      await rename(runsDir, external);
      await symlink(external, runsDir);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal directory/);
      assert.equal(existsSync(journalPath), true);
      assert.equal((await lstat(runsDir)).isSymbolicLink(), true);
    });
  });

  it('rejects a symlink substituted for the run transaction journal', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const { journalPath } = await writeStagedUpdateTransaction(cwd, plan);
      const target = join(cwd, 'run-transaction-target.json');
      await rename(journalPath, target);
      await symlink(target, journalPath);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal run transaction journal/);
      assert.equal((await lstat(journalPath)).isSymbolicLink(), true);
    });
  });

  it('rejects a symlink substituted for the ledger transaction journal', { skip: process.platform === 'win32' }, async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const dir = join(cwd, '.omx', 'ultragoal');
      const ledger = await readFile(join(dir, 'ledger.jsonl'), 'utf-8');
      const line = `${JSON.stringify({ ts: '2026-08-01T17:00:00.000Z', event: 'checkpoint' })}\n`;
      const journalPath = join(dir, '.ledger-transaction.json');
      const target = join(cwd, 'ledger-transaction-target.json');
      await writeFile(target, `${JSON.stringify({
        version: 1,
        runId: plan.runId,
        line,
        baseSha256: sha256(ledger),
        nextSha256: sha256(`${ledger}${line}`),
      }, null, 2)}\n`);
      await symlink(target, journalPath);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe ultragoal ledger transaction journal/);
      assert.equal((await lstat(journalPath)).isSymbolicLink(), true);
    });
  });

  it('rejects symlinked flat projections on same-brief create', { skip: process.platform === 'win32' }, async () => {
    for (const file of ['brief.md', 'goals.json', 'ledger.jsonl']) {
      await withTempRepo(async (cwd) => {
        await createUltragoalPlan(cwd, { brief: BRIEF_A });
        const projection = join(cwd, '.omx', 'ultragoal', file);
        const target = join(cwd, `flat-${file.replace('.', '-')}`);
        await writeFile(target, await readFile(projection));
        await rm(projection);
        await symlink(target, projection);

        await assert.rejects(
          createUltragoalPlan(cwd, { brief: BRIEF_A }),
          /Refusing unsafe (?:active ultragoal projection|ultragoal ledger)/,
        );
      });
    }
  });

  it('rejects a hard link substituted for an active canonical run file', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const canonical = join(ultragoalRunDir(cwd, plan.runId as string), 'goals.json');
      const target = join(cwd, 'canonical-hardlink-target.json');
      await writeFile(target, await readFile(canonical));
      await rm(canonical);
      await link(target, canonical);

      await assert.rejects(readUltragoalPlan(cwd), /Refusing unsafe canonical ultragoal run file/);
      assert.equal((await stat(target)).nlink, 2);
    });
  });

  it('rejects post-commit canonical divergence against the active pointer digests', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, { brief: BRIEF_A });
      const canonicalLedger = join(ultragoalRunDir(cwd, plan.runId as string), 'ledger.jsonl');
      await writeFile(
        canonicalLedger,
        `${await readFile(canonicalLedger, 'utf-8')}${JSON.stringify({ ts: '2026-08-01T16:00:00.000Z', event: 'forged' })}\n`,
      );

      await assert.rejects(readUltragoalPlan(cwd), /divergent committed run .* ledger/);
    });
  });
});
