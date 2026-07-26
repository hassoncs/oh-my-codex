import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModeState } from '../../modes/base.js';
import { queueRalplanBriefAddendum, runRalplanConsensus, type RalplanBriefAddendum } from '../runtime.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-budget-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function writePlanningArtifacts(cwd: string): Promise<string> {
  const plansDir = join(cwd, '.omx', 'plans');
  await mkdir(plansDir, { recursive: true });
  const prdPath = join(plansDir, 'prd-budget.md');
  await writeFile(prdPath, '# plan\n');
  await writeFile(join(plansDir, 'test-spec-budget.md'), '# tests\n');
  return prdPath;
}

/** An architect that never approves — the runaway-review shape. */
function neverApprovingExecutor(cwd: string, onRound?: (ctx: { briefAddenda?: RalplanBriefAddendum[] }) => void) {
  return {
    async draft(ctx: { briefAddenda?: RalplanBriefAddendum[] }) {
      onRound?.(ctx);
      return { summary: 'draft', planPath: await writePlanningArtifacts(cwd) };
    },
    async architectReview() {
      return { verdict: 'iterate' as const, summary: 'still not convinced' };
    },
    async criticReview() {
      return { verdict: 'approve' as const, summary: 'critic-ok' };
    },
  };
}

describe('ralplan review budget stop-loss', () => {
  it('emits needs_user_decision instead of another round when the round budget is spent', async () => {
    await withTempRepo(async (cwd) => {
      const result = await runRalplanConsensus(neverApprovingExecutor(cwd), {
        task: 'runaway review',
        cwd,
        maxIterations: 2,
      });

      assert.equal(result.status, 'needs_user_decision');
      assert.equal(result.phase, 'needs_user_decision');
      assert.equal(result.reviewBudget?.exhausted, 'iterations');
      assert.equal(result.reviewBudget?.iterationsUsed, 2);
      assert.match(result.requiredUserDecision ?? '', /all 2 review rounds/);
      assert.equal(result.error, undefined);

      const state = await readModeState('ralplan', cwd);
      assert.equal(state?.active, false);
      assert.equal(state?.current_phase, 'needs_user_decision');
      assert.match(String(state?.status_message ?? ''), /Status: needs_user_decision/);
      assert.match(String(state?.status_message ?? ''), /do not start another review round/);
    });
  });

  it('stops on the wall-clock budget even when rounds remain', async () => {
    await withTempRepo(async (cwd) => {
      let nowMs = 0;
      const result = await runRalplanConsensus(neverApprovingExecutor(cwd), {
        task: 'slow review',
        cwd,
        maxIterations: 50,
        maxWallClockMs: 1_000,
        now: () => {
          nowMs += 400;
          return nowMs;
        },
      });

      assert.equal(result.status, 'needs_user_decision');
      assert.equal(result.reviewBudget?.exhausted, 'wall_clock');
      assert.ok((result.reviewBudget?.iterationsUsed ?? 0) < 50, 'stopped well before the round limit');
      assert.match(result.requiredUserDecision ?? '', /review budget/);
    });
  });

  it('runs to consensus normally when the budget is not exhausted', async () => {
    await withTempRepo(async (cwd) => {
      const result = await runRalplanConsensus({
        async draft() {
          return { summary: 'draft', planPath: await writePlanningArtifacts(cwd) };
        },
        async architectReview() {
          return { verdict: 'approve' as const, summary: 'architect-ok' };
        },
        async criticReview() {
          return { verdict: 'approve' as const, summary: 'critic-ok' };
        },
      }, { task: 'happy path', cwd, maxIterations: 3, maxWallClockMs: 60_000 });

      assert.equal(result.status, 'completed');
      assert.equal(result.phase, 'complete');
    });
  });
});

describe('ralplan mid-gate brief addenda', () => {
  it('batches every queued addendum into one re-review round', async () => {
    await withTempRepo(async (cwd) => {
      const rounds: Array<RalplanBriefAddendum[] | undefined> = [];
      let queued = false;

      await runRalplanConsensus({
        async draft(ctx) {
          rounds.push(ctx.briefAddenda);
          if (!queued) {
            queued = true;
            // Three addenda arrive mid-gate; they must cost ONE re-review, not three.
            await queueRalplanBriefAddendum(cwd, { text: 'addendum one', source: 'user_prompt_submit' });
            await queueRalplanBriefAddendum(cwd, { text: 'addendum two', source: 'user_prompt_submit' });
            await queueRalplanBriefAddendum(cwd, { text: 'addendum three', source: 'finding' });
          }
          return { summary: 'draft', planPath: await writePlanningArtifacts(cwd) };
        },
        async architectReview() {
          return { verdict: 'iterate' as const, summary: 'architect' };
        },
        async criticReview() {
          return { verdict: 'approve' as const, summary: 'critic-ok' };
        },
      }, { task: 'addenda batching', cwd, maxIterations: 2 });

      assert.equal(rounds.length, 2, 'exactly one re-review round followed the addenda');
      assert.deepEqual(rounds[0], []);
      assert.deepEqual(rounds[1]?.map((entry) => entry.text), ['addendum one', 'addendum two', 'addendum three']);

      const state = await readModeState('ralplan', cwd);
      assert.deepEqual(state?.pending_brief_addenda, [], 'queue drained');
    });
  });
});
