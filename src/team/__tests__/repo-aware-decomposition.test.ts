import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildRepoAwareTeamExecutionPlan } from '../repo-aware-decomposition.js';

function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'omx-dag-'));
  mkdirSync(join(cwd, '.omx', 'plans'), { recursive: true });
  mkdirSync(join(cwd, 'src', 'team'), { recursive: true });
  writeFileSync(join(cwd, 'src', 'team', 'runtime.ts'), '');
  writeFileSync(join(cwd, '.omx', 'plans', 'prd-demo.md'), '# Demo\n');
  writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'), '# Tests\n');
  return cwd;
}

const legacy = () => ({
  workerCount: 3,
  tasks: [{ subject: 'legacy', description: 'legacy', owner: 'worker-1', role: 'team-executor' }],
});

describe('buildRepoAwareTeamExecutionPlan', () => {
  it('falls back to legacy text decomposition when no DAG exists', () => {
    const cwd = repo();
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix tests', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('imports DAG sidecar, reduces implicit worker count, and preserves symbolic dependencies for runtime remap', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'impl', lane: 'implementation', role: 'executor', subject: 'Implement runtime', description: 'Change runtime', filePaths: ['src/team/runtime.ts'], requires_code_change: true },
        { id: 'tests', lane: 'verification', role: 'test-engineer', subject: 'Test runtime', description: 'Cover runtime', depends_on: ['impl'] },
      ],
      worker_policy: { requested_count: 3, count_source: 'plan-suggested' },
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.decomposition_source, 'dag_sidecar');
    assert.equal(plan.workerCount, 2);
    assert.equal(plan.tasks.length, 2);
    assert.deepEqual(plan.tasks[1].blocked_by, undefined);
    assert.deepEqual(plan.tasks[1].depends_on, undefined);
    assert.deepEqual(plan.tasks[1].symbolic_depends_on, ['impl']);
    assert.equal(plan.metadata?.node_id_to_task_id, undefined);
    assert.deepEqual(plan.metadata?.node_dependencies?.tests, ['impl']);
    assert.match(plan.tasks[0].description, /File scope: src\/team\/runtime.ts/);
  });


  it('does not import a stale DAG sidecar unless the approved launch gate opts in', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale sidecar', description: 'Must not override normal startup' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'dag_handoff_not_approved_for_invocation');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('preserves explicit lifecycle fallback reasons when DAG handoff is disabled upstream', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale sidecar', description: 'Must not override lifecycle-rejected startup' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
      dagFallbackReason: 'context_pack_not_followup_ready:invalid',
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'context_pack_not_followup_ready:invalid');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });

  it('requires a matching approved test spec before importing an opted-in DAG sidecar', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'), '');
    writeFileSync(join(cwd, '.omx', 'plans', 'test-spec-other.md'), '# Other tests\n');
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement', description: 'Implement from DAG' }],
    }));
    unlinkSync(join(cwd, '.omx', 'plans', 'test-spec-demo.md'));

    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.decomposition_source, 'legacy_text');
    assert.equal(plan.metadata?.fallback_reason, 'missing_matching_test_spec');
    assert.equal(plan.tasks[0].subject, 'legacy');
  });



  it('carries approved repository context summary only when the launch gate supplies it', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement', description: 'Implement from DAG' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
      allowDagHandoff: true,
      approvedRepositoryContextSummary: {
        sourcePath: join(cwd, '.omx', 'plans', 'repo-context-demo.md'),
        content: 'Approved context: runtime lives in src/team/runtime.ts',
        truncated: false,
      },
    });

    assert.equal(plan.metadata?.approved_context_summary?.content, 'Approved context: runtime lives in src/team/runtime.ts');
  });

  it('does not consume ambient repository context summary without an approved launch match', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'stale', subject: 'Stale', description: 'Stale DAG' }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix unrelated tests',
      workerCount: 3,
      agentType: 'executor',
      explicitAgentType: false,
      explicitWorkerCount: false,
      cwd,
      buildLegacyPlan: legacy,
    });

    assert.equal(plan.metadata?.approved_context_summary, undefined);
    assert.equal(plan.metadata?.fallback_reason, 'dag_handoff_not_approved_for_invocation');
  });

  it('honors CLI-explicit worker count beyond ready lanes', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'impl', subject: 'Implement one lane', description: 'Do it' }],
      worker_policy: { requested_count: 1, count_source: 'plan-suggested' },
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 4, agentType: 'executor', explicitAgentType: true, explicitWorkerCount: true, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.workerCount, 4);
    assert.equal(plan.metadata?.worker_count_source, 'cli-explicit');
  });

  it('counts ready nodes with overlapping file scopes as one lane', () => {
    // a.ts <- shared -> b.ts: a transitive chain, so all three nodes are one lane.
    // Grouping by whole-path-set equality reported three, which is three workers
    // editing two files.
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'one', subject: 'Adjust alpha', description: 'Alpha', filePaths: ['src/a.ts'] },
        { id: 'two', subject: 'Adjust alpha and beta', description: 'Both', filePaths: ['src/a.ts', 'src/b.ts'] },
        { id: 'three', subject: 'Adjust beta', description: 'Beta', filePaths: ['src/b.ts'] },
      ],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.ready_lane_count, 1);
    assert.equal(plan.workerCount, 1);
  });

  it('still fans out across ready nodes whose file scopes are disjoint', () => {
    // The guard on the test above: collapsing every scoped plan to one lane would
    // satisfy it and destroy fan-out entirely.
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [
        { id: 'one', subject: 'Adjust alpha', description: 'Alpha', filePaths: ['src/a.ts'] },
        { id: 'two', subject: 'Adjust beta', description: 'Beta', filePaths: ['src/b.ts'] },
        { id: 'three', subject: 'Adjust gamma', description: 'Gamma', filePaths: ['src/c.ts'] },
      ],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.metadata?.ready_lane_count, 3);
    assert.equal(plan.workerCount, 3);
  });

  it('raises a notice whenever lanes came from the task text rather than a plan', () => {
    const cwd = repo();
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'fix tests', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy,
    });
    assert.equal(plan.decompositionNotice?.code, 'team_lanes_not_plan_derived');
    assert.match(plan.decompositionNotice!.message, /dag_handoff_not_approved_for_invocation/);
    assert.match(plan.decompositionNotice!.message, /ralplan/);
  });

  it('raises no notice when lanes came from the plan', () => {
    const cwd = repo();
    writeFileSync(join(cwd, '.omx', 'plans', 'team-dag-demo.json'), JSON.stringify({
      schema_version: 1,
      nodes: [{ id: 'one', subject: 'Adjust alpha', description: 'Alpha', filePaths: ['src/a.ts'] }],
    }));
    const plan = buildRepoAwareTeamExecutionPlan({
      task: 'team', workerCount: 3, agentType: 'executor', explicitAgentType: false, explicitWorkerCount: false, cwd, buildLegacyPlan: legacy, allowDagHandoff: true,
    });
    assert.equal(plan.decompositionNotice, undefined);
  });
});
