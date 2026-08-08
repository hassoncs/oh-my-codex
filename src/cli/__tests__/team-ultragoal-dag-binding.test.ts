import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTeamArgs } from '../team.js';

/**
 * A team launched inside a leader-owned ultragoal run inherits that run's plan
 * DAG. The whole safety of that is the binding: the run's own recorded
 * `planSlug`, never "the newest plan in .omx/plans". `.omx/plans` accumulates, so
 * "newest" is routinely another task's file scope.
 */
function repoWithPlan(planSlug: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omx-ug-dag-'));
  mkdirSync(join(cwd, '.omx', 'plans'), { recursive: true });
  mkdirSync(join(cwd, '.omx', 'ultragoal'), { recursive: true });
  writeFileSync(join(cwd, '.omx', 'plans', `prd-${planSlug}.md`), '# Plan\n');
  writeFileSync(join(cwd, '.omx', 'plans', `test-spec-${planSlug}.md`), '# Tests\n');
  writeFileSync(join(cwd, '.omx', 'plans', `team-dag-${planSlug}.json`), JSON.stringify({
    schema_version: 1,
    nodes: [{ id: 'one', subject: 'Adjust alpha', description: 'Alpha', filePaths: ['src/a.ts'] }],
  }));
  return cwd;
}

function writeUltragoalRun(cwd: string, run: Record<string, unknown>): void {
  writeFileSync(join(cwd, '.omx', 'ultragoal', 'goals.json'), JSON.stringify({
    version: 1,
    activeGoalId: 'G001',
    goals: [{ id: 'G001', title: 'Story', objective: 'Do it', status: 'in_progress' }],
    ...run,
  }));
}

describe('team DAG handoff under a leader-owned ultragoal run', () => {
  it('inherits the plan DAG when the run is bound to that exact plan', () => {
    const cwd = repoWithPlan('demo');
    writeUltragoalRun(cwd, { planSlug: 'demo' });
    const parsed = parseTeamArgs(['build the thing'], cwd);
    assert.equal(parsed.allowRepoAwareDagHandoff, true);
    assert.equal(parsed.dagFallbackReason, undefined);
  });

  it('refuses a plan the run was never bound to, and says so', () => {
    const cwd = repoWithPlan('unrelated');
    writeUltragoalRun(cwd, { planSlug: 'demo' });
    const parsed = parseTeamArgs(['build the thing'], cwd);
    assert.equal(parsed.allowRepoAwareDagHandoff, false);
    assert.match(parsed.dagFallbackReason ?? '', /^ultragoal_bound_plan_mismatch:demo!=unrelated$/);
  });

  it('refuses when the run recorded no plan at all', () => {
    const cwd = repoWithPlan('demo');
    writeUltragoalRun(cwd, {});
    const parsed = parseTeamArgs(['build the thing'], cwd);
    assert.equal(parsed.allowRepoAwareDagHandoff, false);
    assert.equal(parsed.dagFallbackReason, 'ultragoal_run_has_no_bound_plan');
  });

  it('refuses when the active goal is not in progress', () => {
    const cwd = repoWithPlan('demo');
    writeFileSync(join(cwd, '.omx', 'ultragoal', 'goals.json'), JSON.stringify({
      version: 1,
      planSlug: 'demo',
      activeGoalId: 'G001',
      goals: [{ id: 'G001', title: 'Story', objective: 'Do it', status: 'complete' }],
    }));
    const parsed = parseTeamArgs(['build the thing'], cwd);
    assert.equal(parsed.allowRepoAwareDagHandoff, false);
    assert.equal(parsed.dagFallbackReason, 'ultragoal_context_completed');
  });

  it('leaves a team outside any ultragoal run on the pre-existing gate', () => {
    const cwd = repoWithPlan('demo');
    const parsed = parseTeamArgs(['build the thing'], cwd);
    assert.equal(parsed.allowRepoAwareDagHandoff, false);
    // No ultragoal-specific reason: the generic approved-launch fallback still owns
    // this case, and overwriting its reason would misreport why the DAG was skipped.
    assert.equal(parsed.dagFallbackReason, undefined);
  });
});
