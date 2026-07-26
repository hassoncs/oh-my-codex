import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {

  classifyReviewBlockerEvidence,
  createUltragoalPlan,
  recordFinalReviewBlockers,
  startNextUltragoal,
} from '../artifacts.js';

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-blocker-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

const BRIEF = '# Brief\n\n- Only story: repair the runtime and prove it\n';

function activeCodexGoal(objective: string): unknown {
  return { objective, status: 'active' };
}

async function seedSingleStoryRun(cwd: string): Promise<{ goalId: string; objective: string }> {
  const plan = await createUltragoalPlan(cwd, { brief: BRIEF });
  const started = await startNextUltragoal(cwd);
  const goalId = started.goal?.id as string;
  return { goalId, objective: plan.codexObjective as string };
}

describe('review blocker classification', () => {
  it('treats stale-evidence findings as a re-capture, not a substantive block', () => {
    assert.equal(classifyReviewBlockerEvidence('BLOCK: evidence is stale versus the repaired state'), 'evidence_stale');
    assert.equal(classifyReviewBlockerEvidence('proof is one commit behind the fix'), 'evidence_stale');
    assert.equal(classifyReviewBlockerEvidence('please re-capture evidence after the repair'), 'evidence_stale');
  });

  it('keeps genuinely substantive findings substantive', () => {
    assert.equal(classifyReviewBlockerEvidence('BLOCK: the retry path has a regression'), 'substantive');
    assert.equal(classifyReviewBlockerEvidence('stale evidence, and also a bug in the lock release'), 'substantive');
    assert.equal(classifyReviewBlockerEvidence('missing test for the failure branch'), 'substantive');
  });
});

describe('recordFinalReviewBlockers', () => {
  it('appends an evidence re-capture story and leaves the goal in progress for stale evidence', async () => {
    await withTempRepo(async (cwd) => {
      const { goalId, objective } = await seedSingleStoryRun(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId,
        title: 'Re-capture parity evidence',
        objective: 'Re-run the parity capture against the repaired state and attach fresh output.',
        evidence: 'BLOCK: evidence is stale — proof is one commit behind the repaired state.',
        codexGoal: activeCodexGoal(objective),
      });

      assert.equal(result.blockedGoal.status, 'in_progress', 'no review-block round-trip');
      assert.equal(result.blockedGoal.reviewBlockerResolution, undefined);
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(result.addedGoal.resolvesReviewBlockedGoalId, undefined);
      assert.equal(result.plan.goals.length, 2);
    });
  });

  it('still blocks the goal for substantive findings', async () => {
    await withTempRepo(async (cwd) => {
      const { goalId, objective } = await seedSingleStoryRun(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId,
        title: 'Fix the regression',
        objective: 'Repair the retry path and re-review.',
        evidence: 'BLOCK: the retry path has a regression under contention.',
        codexGoal: activeCodexGoal(objective),
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.blockedGoal.reviewBlockerResolution?.resolverGoalId, result.addedGoal.id);
    });
  });

  it('honours an explicit blocker class over the heuristic', async () => {
    await withTempRepo(async (cwd) => {
      const { goalId, objective } = await seedSingleStoryRun(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId,
        title: 'Re-capture evidence',
        objective: 'Re-capture the proof.',
        evidence: 'BLOCK: reviewer wants fresher output.',
        blockerClass: 'evidence_stale',
        codexGoal: activeCodexGoal(objective),
      });
      assert.equal(result.blockedGoal.status, 'in_progress');
    });
  });
});

