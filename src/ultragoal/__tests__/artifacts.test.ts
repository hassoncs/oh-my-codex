import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addUltragoalGoal,
  buildCodexGoalInstruction,
  checkpointUltragoal,
  createUltragoalPlan,
  isFinalRunCompletionCandidate,
  isUltragoalDone,
  readUltragoalPlan,
  reconcileUltragoalRootGoal,
  recordFinalReviewBlockers,
  steerUltragoal,
  startNextUltragoal,
  summarizeUltragoalPlan,
  ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE,
  validateUltragoalSteeringProposal,
  type UltragoalCodexRootBinding,
  type UltragoalLedgerEntry,
  type UltragoalLedgerAncestry,
  type UltragoalPlan,
  type UltragoalRootGoalReconciliation,
  type UltragoalSteeringProposal,
} from '../artifacts.js';
import { legacyRunIdForPlan, ultragoalRunDir } from '../registry.js';
import { LEADER_CONDUCTOR_BLOCK, buildUnsupportedNativeSubagentGuidance } from '../../leader/contract.js';
import { steeringFixtures, type SteeringFixtureProposal } from './steering-fixtures.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

async function createRootReconciliationTamperFixture(cwd: string, withBefore = false) {
  const created = await createUltragoalPlan(cwd, {
    brief: 'brief',
    goals: [
      { title: 'First', objective: 'Complete first milestone with tests.' },
      { title: 'Second', objective: 'Keep the durable run unfinished.' },
    ],
    now: new Date('2026-08-02T03:00:00.000Z'),
  });
  const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
  const runDir = ultragoalRunDir(cwd, created.runId!);
  const namespacedPlanPath = join(runDir, 'goals.json');
  const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
  const namespacedLedgerPath = join(runDir, 'ledger.jsonl');
  const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First';
  const legacyPlan = {
    ...created,
    codexObjective: legacyObjective,
    rootGoalId: 'legacy-root',
    codexThreadId: 'legacy-thread',
    goals: created.goals.map((goal, index) => (
      index === 0 ? { ...goal, status: 'completed' } : goal
    )),
  };
  const legacyPlanRaw = `${JSON.stringify(legacyPlan, null, 2)}\n`;
  await writeFile(flatPlanPath, legacyPlanRaw);
  await writeFile(namespacedPlanPath, legacyPlanRaw);

  const namespacedBefore = await readFile(namespacedLedgerPath, 'utf-8');
  const flatBefore = `{"ts":"2026-08-01T23:59:00.000Z","event":"preserved_prefix","message":"legacy"}\n${namespacedBefore}`;
  await writeFile(flatLedgerPath, flatBefore);
  const firstSnapshot = {
    goal: {
      threadId: 'successor',
      objective: 'Current successor',
      status: 'active',
    },
  };
  await reconcileUltragoalRootGoal(cwd, {
    codexGoal: firstSnapshot,
    evidence: 'Bind full immutable recovery envelope.',
    expectedRevision: 0,
    expectedFlatLedgerDigest: sha256(flatBefore),
    expectedNamespacedLedgerDigest: sha256(namespacedBefore),
    now: new Date('2026-08-02T03:01:00.000Z'),
  });

  const snapshot = withBefore
    ? {
      goal: {
        threadId: 'next-successor',
        objective: 'Next current successor',
        status: 'active',
      },
    }
    : firstSnapshot;
  if (withBefore) {
    await reconcileUltragoalRootGoal(cwd, {
      codexGoal: snapshot,
      evidence: 'Advance the live successor binding.',
      expectedRevision: 1,
      expectedCurrentThreadId: 'successor',
      now: new Date('2026-08-02T03:02:00.000Z'),
    });
  }

  return {
    created,
    flatPlanPath,
    namespacedPlanPath,
    flatLedgerPath,
    namespacedLedgerPath,
    snapshot,
  };
}

type MutableRootTransition = {
  transitionVersion: number;
  beforePlanDigest: string;
  ledgerAncestry: UltragoalLedgerAncestry;
  normalization?: NonNullable<UltragoalRootGoalReconciliation['normalization']>;
  legacyBefore?: NonNullable<UltragoalRootGoalReconciliation['legacyBefore']>;
  snapshotDigest: string;
  evidence: string;
  evidenceDigest: string;
  reconciledAt?: string;
  ts?: string;
  before?: UltragoalCodexRootBinding;
  after: UltragoalCodexRootBinding;
};

const ROOT_TRANSITION_TAMPER_CASES = [
  ['transition version', false],
  ['predecessor plan digest', false],
  ['ledger relation', false],
  ['selected ledger digest', false],
  ['run anchor digest', false],
  ['run anchor line', false],
  ['normalization', false],
  ['legacy predecessor', false],
  ['snapshot digest', false],
  ['evidence digest', false],
  ['timestamp', false],
  ['before binding', true],
  ['after binding', false],
] as const;

function tamperRootTransitionField(target: MutableRootTransition, field: string): void {
  switch (field) {
    case 'transition version':
      target.transitionVersion += 1;
      return;
    case 'predecessor plan digest':
      target.beforePlanDigest = 'f'.repeat(64);
      return;
    case 'ledger relation':
      target.ledgerAncestry.relation = 'flat_has_namespaced_prefix';
      return;
    case 'selected ledger digest':
      target.ledgerAncestry.selectedDigest = 'f'.repeat(64);
      return;
    case 'run anchor digest':
      target.ledgerAncestry.runAnchorDigest = 'f'.repeat(64);
      return;
    case 'run anchor line':
      target.ledgerAncestry.runAnchorLine = Number(target.ledgerAncestry.runAnchorLine) + 1;
      return;
    case 'normalization':
      target.normalization!.migratedStatuses += 1;
      return;
    case 'legacy predecessor':
      target.legacyBefore!.rootGoalId = 'forged-legacy-root';
      return;
    case 'snapshot digest':
      target.snapshotDigest = 'f'.repeat(64);
      return;
    case 'evidence digest':
      target.evidence = `${target.evidence} forged`;
      target.evidenceDigest = sha256(JSON.stringify(target.evidence));
      return;
    case 'timestamp':
      if (target.reconciledAt) target.reconciledAt = '2026-08-02T03:09:00.000Z';
      if (target.ts) target.ts = '2026-08-02T03:09:00.000Z';
      return;
    case 'before binding':
      target.before!.threadId = 'forged-before';
      return;
    case 'after binding':
      target.after.objective = 'Forged successor objective';
      target.snapshotDigest = sha256(JSON.stringify({
        threadId: target.after.threadId,
        objective: target.after.objective,
        status: 'active',
      }));
      return;
    default:
      assert.fail(`Unknown root transition tamper field: ${field}`);
  }
}

async function withTempRepo<T>(run: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-ultragoal-'));
  try {
    return await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function cleanQualityGate(): object {
  return {
    aiSlopCleaner: { status: 'passed', evidence: 'ai-slop-cleaner ran on changed files' },
    verification: { status: 'passed', commands: ['npm test'], evidence: 'tests passed after cleaner' },
    codeReview: {
      recommendation: 'APPROVE',
      architectStatus: 'CLEAR',
      evidence: '$code-review approved with CLEAR architecture',
      independentReview: {
        codeReviewer: { agentRole: 'code-reviewer', evidence: 'code-reviewer subagent returned APPROVE' },
        architect: { agentRole: 'architect', evidence: 'architect subagent returned CLEAR' },
      },
    },
    architectureInvariantGate: {
      status: 'passed',
      sourceArtifacts: ['.omx/ultragoal/brief.md', '.omx/ultragoal/goals.json'],
      invariants: [],
      evidence: 'architect verified no additional architecture invariants were declared in the brief',
    },

  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function writeFixturePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
  await writeFile(join(cwd, '.omx/ultragoal/brief.md'), 'G001-core-steering-model fixture for .omx/ultragoal steering behavior.\n');
  await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), '');
}

function asChildGoals(after: unknown): Array<{ title: string; objective: string }> | undefined {
  if (!Array.isArray(after)) return undefined;
  return after.map((item) => {
    assert.equal(typeof item, 'object');
    assert.notEqual(item, null);
    const candidate = item as { title?: unknown; objective?: unknown };
    assert.equal(typeof candidate.title, 'string');
    assert.equal(typeof candidate.objective, 'string');
    return { title: String(candidate.title), objective: String(candidate.objective) };
  });
}

function toSteeringProposal(proposal: SteeringFixtureProposal): UltragoalSteeringProposal {
  const common = {
    kind: proposal.kind,
    source: proposal.source,
    targetGoalIds: proposal.targetGoalIds,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    idempotencyKey: proposal.idempotencyKey,
  };
  switch (proposal.kind) {
    case 'add_subgoal':
      return { ...common, title: proposal.title, objective: proposal.objective };
    case 'split_subgoal':
      return { ...common, childGoals: asChildGoals(proposal.after) };
    case 'reorder_pending':
      assert.ok(Array.isArray(proposal.after));
      return { ...common, pendingOrder: proposal.after as string[] };
    case 'revise_pending_wording':
      return {
        ...common,
        objective: proposal.objective,
        directiveText: proposal.forbidden ? 'attempt to skip verification, weaken quality gates, and auto-complete protected aggregate state' : undefined,
        revisedTitle: proposal.title,
        revisedObjective: proposal.objective,
      };
    case 'annotate_ledger':
      return common;
    case 'mark_blocked_superseded': {
      const childGoals = asChildGoals(proposal.after);
      return {
        ...common,
        childGoals,
        blockedReason: childGoals ? undefined : 'Evidence-backed blocker has no safe replacement yet.',
      };
    }
  }
}

describe('ultragoal artifacts', () => {
  it('backfills aggregate completion from a fully resolved superseded plan', () => {
    const timestamp = '2026-07-11T00:00:00.000Z';
    const plan: UltragoalPlan = {
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      briefPath: '.omx/ultragoal/brief.md',
      goalsPath: '.omx/ultragoal/goals.json',
      ledgerPath: '.omx/ultragoal/ledger.jsonl',
      codexGoalMode: 'aggregate',
      goals: [
        { id: 'G019', title: 'Original', objective: 'Original work.', status: 'failed', steeringStatus: 'superseded', supersededBy: ['G021'], attempt: 1, createdAt: timestamp, updatedAt: timestamp },
        { id: 'G021', title: 'Replacement', objective: 'Replacement work.', status: 'complete', attempt: 1, createdAt: timestamp, updatedAt: timestamp },
      ],
    };

    const summary = summarizeUltragoalPlan(plan);
    assert.equal(summary.artifactComplete, true);
    assert.equal(summary.aggregateComplete, true);
    assert.equal(summary.aggregateCompletionRecorded, false);
  });

  it('creates brief, goals, and ledger artifacts from a brief', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Build the CLI\n- Add tests\n- Write docs',
        now: new Date('2026-05-04T10:00:00Z'),
      });

      assert.equal(plan.goals.length, 3);
      assert.equal(plan.codexGoalMode, 'aggregate');
      assert.equal(plan.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.doesNotMatch(plan.codexObjective ?? '', /G001-build-the-cli/);
      assert.equal(plan.goals[0]?.id, 'G001-build-the-cli');
      assert.equal(plan.goals[0]?.status, 'pending');
      assert.equal(await readFile(join(cwd, '.omx/ultragoal/brief.md'), 'utf-8'), '- Build the CLI\n- Add tests\n- Write docs\n');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"plan_created"/);
    });
  });

  it('derives story goals without queuing nested criteria or plain-label checklist items', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: [
          '### Stories',
          '  1. Ship parser fix',
          '     - Preserve parent story objective detail',
          '  2. Add coverage',
          '',
          'Acceptance criteria:',
          '  - Parent stories only',
          '',
          'Verification checklist:',
          '  1. Run tests',
          '  2. Run lint',
        ].join('\n'),
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
      assert.match(plan.goals[0]?.objective ?? '', /Preserve parent story objective detail/);
      assert.doesNotMatch(plan.goals[1]?.objective ?? '', /Run tests|Run lint|Parent stories only/);
    });
  });

  it('does not fall back to checklist bullets when a brief has only non-story sections', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '### Verification checklist:\n- Run tests\n- Run lint\n\nAcceptance criteria:\n- Parent stories only',
      });

      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.title, '### Verification checklist:');
      assert.doesNotMatch(plan.goals[0]?.id ?? '', /run-tests|run-lint|parent-stories/);
    });
  });

  it('does not atomize RALPLAN review and consensus sections into pseudo-goals', async () => {
    await withTempRepo(async (cwd) => {
      const brief = [
        '# Approved RALPLAN handoff',
        '',
        'Review artifact:',
        '- G104 verdict: APPROVE after evidence review',
        '- Review artifact: .gjc/plans/ralplan/run/review.md',
        '- Critic review: verification is concrete',
        '',
        'Consensus status:',
        '- Planner consensus: approved',
        '- Architect review: CLEAR',
        '- Implementation notes remain advisory until converted to compact goals',
        '',
        'Verification checklist:',
        '- Run targeted tests',
        '- Run build checks',
      ].join('\n');

      const plan = await createUltragoalPlan(cwd, { brief });

      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.title, '# Approved RALPLAN handoff');
      assert.doesNotMatch(plan.goals[0]?.id ?? '', /g104|verdict|review-artifact|consensus-status/);
    });
  });

  it('fails closed for broad implicit plan-like markdown without compact stories', async () => {
    await withTempRepo(async (cwd) => {
      const broadBrief = [
        '# RALPLAN approved handoff',
        'Consensus status: approved for execution.',
        ...Array.from({ length: 21 }, (_, index) => `- Review or handoff detail ${index + 1}`),
      ].join('\n');

      await assert.rejects(
        () => createUltragoalPlan(cwd, { brief: broadBrief }),
        /Refusing to derive 21 implicit ultragoal goals.*--goal "Title::Objective".*### Stories\/### Goals/s,
      );
    });
  });

  it('keeps later sibling stories after an indented plain-label note', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n   Notes:\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  it('prefers story-section goals over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n### Stories\n  1. Ship parser fix\n  2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  it('prefers indented markdown story headings over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n  ### Stories\n    1. Ship parser fix\n    2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  it('keeps sibling stories after an indented ATX note heading', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n   ### Notes\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  it('keeps sibling stories after a blank before an indented ATX note heading', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '1. Story A\n\n   ### Notes\n   - Keep as detail\n2. Story B',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Story A', 'Story B']);
      assert.match(plan.goals[0]?.objective ?? '', /Keep as detail/);
    });
  });

  it('resumes unlabeled top-level story bullets after a non-story section break', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'Acceptance criteria:\n- keep API stable\n\n- Ship parser fix\n- Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  it('deduplicates derived list goals', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Ship parser fix\n- Ship parser fix\n- Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  it('recognizes singular story headings when choosing goals over preface bullets', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: '- Context\n\n### Story\n  1. Ship parser fix\n  2. Add coverage',
      });

      assert.deepEqual(plan.goals.map((goal) => goal.title), ['Ship parser fix', 'Add coverage']);
    });
  });

  it('starts one story at a time and emits an aggregate Codex goal handoff by default', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const started = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:01:00Z') });
      assert.equal(started.goal?.id, 'G001-first');
      assert.equal(started.goal?.status, 'in_progress');
      assert.equal(started.plan.activeGoalId, 'G001-first');

      const resumed = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:02:00Z') });
      assert.equal(resumed.goal?.id, 'G001-first');
      assert.equal(resumed.resumed, true);

      const instruction = buildCodexGoalInstruction(started.goal!, started.plan);
      assert.match(instruction, /call get_goal/i);
      assert.match(instruction, /call create_goal/i);
      assert.match(instruction, /Codex goal = the whole ultragoal run/i);
      assert.match(instruction, /same aggregate objective as active/i);
      assert.match(instruction, /do not call update_goal yet/i);
      assert.match(instruction, /--codex-goal-json/);
      assert.match(instruction, /Complete the durable ultragoal plan/);
      assert.match(instruction, /including later accepted\/appended stories/);
      assert.match(instruction, /\.omx\/ultragoal\/ledger\.jsonl/);
      assert.match(instruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));
      assert.match(instruction, /Complete first milestone/);
      assert.match(instruction, /does not call \/goal clear/);
      assert.match(instruction, /manually run \/goal clear/);
      assert.doesNotMatch(instruction, /fresh (?:Codex )?(?:thread|session)s?/i);
      assert.doesNotMatch(instruction, /\.\.\/\.\.\/codex/);
      assert.doesNotMatch(instruction, /`codex\s+goal\b/i);
    });
  });

  it('emits final-story handoffs that block missing independent review before update_goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const aggregateInstruction = buildCodexGoalInstruction(started.goal!, started.plan);

      assert.match(aggregateInstruction, /independentReview evidence from both code-reviewer and architect subagents/);
      assert.match(aggregateInstruction, /independent delegation is unavailable\/skipped\/failed, do not call update_goal/);
      assert.match(aggregateInstruction, /APPROVE \+ CLEAR \+ independent code-reviewer and architect subagent evidence/);
      assert.match(aggregateInstruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));

      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
        force: true,
      });
      const perStory = await startNextUltragoal(cwd);
      const perStoryInstruction = buildCodexGoalInstruction(perStory.goal!, perStory.plan);

      assert.match(perStoryInstruction, /independentReview evidence from both code-reviewer and architect subagents/);
      assert.match(perStoryInstruction, /independent delegation is unavailable\/skipped\/failed, do not call update_goal/);
      assert.match(perStoryInstruction, /APPROVE \+ CLEAR \+ independent code-reviewer and architect subagent evidence/);
      assert.match(perStoryInstruction, new RegExp(escapeRegExp(LEADER_CONDUCTOR_BLOCK)));

      const nativeSubagentSupport = {
        status: 'unsupported' as const,
        reason: 'native_subagents_unsupported' as const,
        source: 'persisted_support_blocker' as const,
        evidenceSummary: 'native subagents are disabled in this runtime',
      };
      const unsupportedInstruction = buildCodexGoalInstruction(perStory.goal!, perStory.plan, { nativeSubagentSupport });
      assert.doesNotMatch(unsupportedInstruction, /Conductor mode contract:/);
      assert.match(unsupportedInstruction, new RegExp(escapeRegExp(buildUnsupportedNativeSubagentGuidance(nativeSubagentSupport))));
      assert.match(unsupportedInstruction, /record-review-blockers/);
      assert.match(unsupportedInstruction, /non-clean blocker/);
      assert.match(unsupportedInstruction, /Native independent review unavailable/);
    });
  });

  it('checkpoints success, advances, and supports failed-goal retry', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'premature aggregate completion',
          codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        }),
        /expected active/,
      );
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'unit tests passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G002-second');

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: second.goal!.id,
          status: 'complete',
          evidence: 'not final yet',
          codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
        }),
        /not complete/,
      );

      await checkpointUltragoal(cwd, { goalId: second.goal!.id, status: 'failed', evidence: 'blocked' });
      const noPending = await startNextUltragoal(cwd);
      assert.equal(noPending.goal, null);
      assert.equal(noPending.done, false);

      const retry = await startNextUltragoal(cwd, { retryFailed: true });
      assert.equal(retry.goal?.id, 'G002-second');
      assert.equal(retry.goal?.status, 'in_progress');
      assert.equal(retry.goal?.attempt, 2);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.evidence, 'unit tests passed');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_completed"/);
      assert.match(ledger, /"event":"goal_failed"/);
      assert.match(ledger, /"event":"goal_retried"/);
    });
  });


  it('reconciles completed task-scoped Codex proof to finish exploded aggregate ultragoal bookkeeping', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Codex immutable completed goal snapshots and OMX ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: Array.from({ length: 136 }, (_, index) => ({
          title: `Micro goal ${index + 1}`,
          objective: `Synthetic bookkeeping slice ${index + 1}.`,
        })),
      });

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G001-micro-goal-1');

      const reconciled = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-micro-goal-1; validation complete; reviews clean.',
        codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
        now: new Date('2026-05-04T10:04:00Z'),
      });

      assert.equal(reconciled.goals.length, 136);
      assert.equal(reconciled.goals.filter((candidate) => candidate.status === 'complete').length, 1);
      assert.equal(reconciled.goals[0]?.status, 'complete');
      assert.equal(reconciled.goals[0]?.completedAt, '2026-05-04T10:04:00.000Z');
      assert.match(reconciled.goals[0]?.evidence ?? '', /planned work done/);
      assert.equal(reconciled.goals[0]?.failureReason, undefined);
      assert.equal(reconciled.activeGoalId, undefined);
      assert.equal(reconciled.aggregateCompletion?.status, 'complete');
      assert.match(reconciled.aggregateCompletion?.evidence ?? '', /planned work done/);
      assert.equal(isUltragoalDone(reconciled), true);

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal, null);
      assert.equal(next.done, true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /checkpointed active microgoal row was reconciled to complete/);
      assert.equal((ledger.match(/"event":"aggregate_completed"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"goal_completed"/g) ?? []).length, 1);
    });
  });

  it('fails closed for task-scoped aggregate completion without plan mapping or evidence', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Implement the reconciler fix described in the approved ultragoal brief.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: 'Unrelated completed task', status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /objective mismatch/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: 'Audit .omx/ultragoal/goals.json for a different unrelated task', status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /objective mismatch/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'done',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation requires .*active in-progress/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G001-first; validation complete; reviews clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
        }),
        /quality-gate-json|quality gate/i,
      );
    });
  });

  it('fails closed for task-scoped aggregate completion on a non-active microgoal id', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix the mismatch between Codex immutable completed goal snapshots and OMX ultragoal checkpoint reconciliation.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [
          { title: 'First', objective: 'Synthetic slice 1.' },
          { title: 'Second', objective: 'Synthetic slice 2.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G001-first');
      assert.equal(first.plan.activeGoalId, 'G001-first');

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: 'G002-second',
          status: 'complete',
          evidence: 'Actual planned work done for .omx/ultragoal/goals.json G002-second; validation complete; reviews clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation requires .*active in-progress/,
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.activeGoalId, 'G001-first');
      assert.equal(plan.aggregateCompletion, undefined);
      assert.equal(plan.goals.find((goal) => goal.id === 'G001-first')?.status, 'in_progress');
      assert.equal(plan.goals.find((goal) => goal.id === 'G002-second')?.status, 'pending');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"aggregate_completed"/g) ?? []).length, 0);
    });
  });

  it('requires aggregate Codex goal completion only for the final story', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const aggregateObjective = first.plan.codexObjective!;
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'first audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const second = await startNextUltragoal(cwd);
      await checkpointUltragoal(cwd, {
        goalId: second.goal!.id,
        status: 'complete',
        evidence: 'final audit passed',
        codexGoal: { goal: { objective: aggregateObjective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.every((goal) => goal.status === 'complete'), true);
      assert.equal(plan.activeGoalId, undefined);
    });
  });

  it('treats existing v1 plans without mode metadata as legacy per-story plans', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });
      delete created.codexGoalMode;
      delete created.codexObjective;
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(created, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const instruction = buildCodexGoalInstruction(first.goal!, first.plan);
      assert.match(instruction, /Ultragoal active-goal handoff/);
      assert.match(instruction, /Codex goal context/);
      assert.doesNotMatch(instruction, /fresh (?:Codex )?(?:thread|session)s?/i);

      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy per-story audit passed',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.status, 'complete');
    });
  });

  it('appends goals without changing the stored aggregate objective', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone.' }],
      });
      const objective = plan.codexObjective;
      assert.equal(objective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      const added = await addUltragoalGoal(cwd, {
        title: 'Resolve final code-review blockers',
        objective: 'Fix review blockers and rerun final gates.',
        evidence: 'review findings',
      });

      assert.equal(added.goal.id, 'G002-resolve-final-code-review-blockers');
      assert.equal(added.goal.status, 'pending');
      assert.equal(added.plan.codexObjective, objective);
      assert.doesNotMatch(added.plan.codexObjective ?? '', /G002-resolve-final-code-review-blockers/);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_added"/);
    });
  });
  it('adopts flat legacy status registries without rewriting protected state or ledger history', async () => {
    await withTempRepo(async (cwd) => {
      const createdAt = '2026-05-04T10:00:00.000Z';
      const activeStartedAt = '2026-05-04T10:01:00.000Z';
      const activeUpdatedAt = '2026-05-04T10:02:00.000Z';
      const historicalLedger = '{"ts":"2026-05-04T10:00:30.000Z","event":"goal_started","goalId":"G002-active","status":"in_progress"}\n';
      await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
      await writeFile(join(cwd, '.omx/ultragoal/brief.md'), 'legacy migration brief\n');
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify({
        version: 1,
        createdAt,
        updatedAt: activeUpdatedAt,
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        activeGoalId: 'G002-active',
        goals: [
          {
            id: 'G001-complete',
            title: 'Completed goal',
            objective: 'Preserve completed legacy work.',
            status: 'completed',
            attempt: 1,
            createdAt,
            updatedAt: createdAt,
            completedAt: '2026-05-04T10:00:30.000Z',
            evidence: 'legacy completion evidence',
          },
          {
            id: 'G002-active',
            title: 'Active goal',
            objective: 'Resume active legacy work.',
            status: 'in_progress',
            attempt: 2,
            createdAt,
            updatedAt: activeUpdatedAt,
            startedAt: activeStartedAt,
            evidence: 'active evidence',
          },
          {
            id: 'G003-pending',
            title: 'Pending goal',
            objective: 'Keep pending legacy work queued.',
            status: 'pending',
            attempt: 0,
            createdAt,
            updatedAt: createdAt,
          },
        ],
      }, null, 2)}\n`);
      await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), historicalLedger);

      const adopted = await createUltragoalPlan(cwd, {
        brief: 'legacy migration brief',
        adoptExisting: true,
        now: new Date('2026-05-04T10:03:00.000Z'),
      });
      const completed = adopted.goals.find((goal) => goal.id === 'G001-complete');
      const active = adopted.goals.find((goal) => goal.id === 'G002-active');
      const pending = adopted.goals.find((goal) => goal.id === 'G003-pending');

      assert.equal(completed?.status, 'complete');
      assert.equal(completed?.completedAt, '2026-05-04T10:00:30.000Z');
      assert.equal(completed?.evidence, 'legacy completion evidence');
      assert.equal(completed?.updatedAt, createdAt);
      assert.equal(completed?.attempt, 1);
      assert.equal(active?.attempt, 2);
      assert.equal(pending?.attempt, 0);
      assert.equal(active?.status, 'in_progress');
      assert.equal(active?.startedAt, activeStartedAt);
      assert.equal(active?.updatedAt, activeUpdatedAt);
      assert.equal(active?.evidence, 'active evidence');
      assert.equal(pending?.status, 'pending');
      assert.equal(adopted.activeGoalId, 'G002-active');
      assert.match(adopted.runId ?? '', /^legacy-/);

      const summary = summarizeUltragoalPlan(adopted);
      assert.equal(summary.total, 3);
      assert.equal(summary.complete, 1);
      assert.equal(summary.activeGoalId, 'G002-active');
      assert.equal(isUltragoalDone(adopted), false);

      const resumed = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:04:00.000Z') });
      assert.equal(resumed.goal?.id, 'G002-active');
      assert.equal(resumed.resumed, true);
      assert.equal(resumed.done, false);
      assert.equal(isFinalRunCompletionCandidate(resumed.plan, resumed.goal!), false);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal(ledger.slice(0, historicalLedger.length), historicalLedger);
      assert.match(ledger.slice(historicalLedger.length), /"event":"plan_created"/);
    });
  });

  it('archives a flat completed legacy registry with canonical status before starting a new namespace', async () => {
    await withTempRepo(async (cwd) => {
      const createdAt = '2026-05-04T10:00:00.000Z';
      const completedAt = '2026-05-04T10:00:30.000Z';
      const historicalLedger = '{"ts":"2026-05-04T10:00:15.000Z","event":"goal_started","goalId":"G001-complete","status":"in_progress"}\n';
      const legacyPlan = {
        version: 1,
        createdAt,
        updatedAt: completedAt,
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        goals: [{
          id: 'G001-complete',
          title: 'Completed legacy goal',
          objective: 'Preserve completed legacy work.',
          status: 'completed',
          attempt: 1,
          createdAt,
          updatedAt: completedAt,
          completedAt,
          evidence: 'legacy completion evidence',
        }],
      };
      await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
      await writeFile(join(cwd, '.omx/ultragoal/brief.md'), 'legacy migration brief\n');
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(legacyPlan, null, 2)}\n`);
      await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), historicalLedger);

      const fresh = await createUltragoalPlan(cwd, {
        brief: 'fresh namespace brief',
        goals: [{ title: 'Fresh goal', objective: 'Start independent new work.' }],
        newNamespace: true,
        now: new Date('2026-05-04T10:03:00.000Z'),
      });
      const archivedDir = ultragoalRunDir(cwd, legacyRunIdForPlan(legacyPlan));
      const archived = JSON.parse(await readFile(join(archivedDir, 'goals.json'), 'utf-8')) as UltragoalPlan;
      const archivedLedger = await readFile(join(archivedDir, 'ledger.jsonl'), 'utf-8');

      assert.equal(archived.goals[0]?.status, 'complete');
      assert.equal(archived.goals[0]?.completedAt, completedAt);
      assert.equal(archived.goals[0]?.evidence, 'legacy completion evidence');
      assert.equal(archived.goals[0]?.createdAt, createdAt);
      assert.equal(archived.goals[0]?.updatedAt, completedAt);
      assert.equal(archivedLedger.slice(0, historicalLedger.length), historicalLedger);
      assert.match(archivedLedger.slice(historicalLedger.length), /"event":"plan_migrated"/);
      assert.equal(fresh.goals[0]?.status, 'pending');
      assert.notEqual(fresh.runId, archived.runId);
    });
  });

  it('migrates legacy enumerated aggregate objectives to the pointer contract', async () => {
    await withTempRepo(async (cwd) => {
      await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
      const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First; G002-second Second';
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify({
        version: 1,
        createdAt: '2026-05-04T10:00:00.000Z',
        updatedAt: '2026-05-04T10:00:00.000Z',
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        codexGoalMode: 'aggregate',
        codexObjective: legacyObjective,
        goals: [
          { id: 'G001-first', title: 'First', objective: 'Complete first.', status: 'pending', attempt: 0, createdAt: '2026-05-04T10:00:00.000Z', updatedAt: '2026-05-04T10:00:00.000Z' },
          { id: 'G002-second', title: 'Second', objective: 'Complete second.', status: 'pending', attempt: 0, createdAt: '2026-05-04T10:00:00.000Z', updatedAt: '2026-05-04T10:00:00.000Z' },
        ],
      }, null, 2)}\n`);
      await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), '');

      const plan = await readUltragoalPlan(cwd);

      assert.equal(plan.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.deepEqual(plan.codexObjectiveAliases, [legacyObjective]);
      assert.doesNotMatch(plan.codexObjective ?? '', /G001-first/);
      const persisted = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as UltragoalPlan;
      assert.equal(persisted.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.deepEqual(persisted.codexObjectiveAliases, [legacyObjective]);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"aggregate_objective_migrated"/);
      assert.match(ledger, /legacy enumerated aggregate Codex objective/);
    });
  });

  it('accepts migrated legacy aggregate objective aliases for active Codex snapshots', async () => {
    await withTempRepo(async (cwd) => {
      const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First; G002-second Second';
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first.' },
          { title: 'Second', objective: 'Complete second.' },
        ],
      });
      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const legacyPlan = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      legacyPlan.codexObjective = legacyObjective;
      await writeFile(planPath, `${JSON.stringify(legacyPlan, null, 2)}\n`);

      const first = await startNextUltragoal(cwd);
      const checkpointed = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'legacy active Codex objective alias still represents the migrated aggregate run.',
        codexGoal: { goal: { objective: legacyObjective, status: 'active' } },
      });

      assert.equal(checkpointed.goals[0]?.status, 'complete');
      assert.equal(checkpointed.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      assert.deepEqual(checkpointed.codexObjectiveAliases, [legacyObjective]);
    });
  });

  it('reconciles an explicit active successor Codex goal once across flat and namespaced state', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
        now: new Date('2026-08-02T03:00:00.000Z'),
      });
      const previousObjective = created.codexObjective;
      const ledgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      const runLedgerBefore = await readFile(namespacedLedgerPath, 'utf-8');
      const legacyPrefix = '{"ts":"2026-07-01T00:00:00.000Z","event":"goal_reset","message":"preserved legacy history"}\n\n';
      await writeFile(ledgerPath, `${legacyPrefix}${runLedgerBefore}`);
      const ledgerBefore = await readFile(ledgerPath, 'utf-8');
      const snapshot = {
        goal: {
          threadId: '019fbae5-b750-7ab2-875f-e36bcdeb3981',
          objective: 'Complete the reset aggregate goal with consuming proof.',
          status: 'active',
        },
      };

      const reconciled = await reconcileUltragoalRootGoal(cwd, {
        codexGoal: snapshot,
        evidence: 'Chris explicitly reset the active aggregate goal while preserving the durable run.',
        expectedRevision: 0,
        expectedFlatLedgerDigest: sha256(ledgerBefore),
        expectedNamespacedLedgerDigest: sha256(runLedgerBefore),
        now: new Date('2026-08-02T03:01:00.000Z'),
      });

      assert.equal(reconciled.deduped, false);
      assert.deepEqual(reconciled.after, {
        threadId: snapshot.goal.threadId,
        objective: snapshot.goal.objective,
        revision: 1,
      });
      assert.deepEqual(reconciled.plan.codexRootBinding, reconciled.after);
      assert.equal(reconciled.plan.codexObjective, previousObjective);
      assert.equal(reconciled.plan.codexObjectiveAliases, undefined);
      const handoff = buildCodexGoalInstruction(reconciled.plan.goals[0]!, reconciled.plan);
      assert.match(handoff, new RegExp(escapeRegExp(snapshot.goal.objective)));
      assert.doesNotMatch(handoff, new RegExp(escapeRegExp(previousObjective!)));
      const flat = JSON.parse(await readFile(join(cwd, '.omx/ultragoal/goals.json'), 'utf-8')) as UltragoalPlan;
      const namespaced = JSON.parse(await readFile(join(ultragoalRunDir(cwd, created.runId!), 'goals.json'), 'utf-8')) as UltragoalPlan;
      assert.deepEqual(flat, namespaced);

      const ledgerAfter = await readFile(ledgerPath, 'utf-8');
      assert.equal(ledgerAfter.slice(0, ledgerBefore.length), ledgerBefore);
      assert.equal(await readFile(namespacedLedgerPath, 'utf-8'), ledgerAfter);
      assert.equal((ledgerAfter.match(/"event":"root_goal_reconciled"/g) ?? []).length, 1);
      assert.match(ledgerAfter, new RegExp(snapshot.goal.threadId));
      const rootEntry = ledgerAfter
        .trimEnd()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as UltragoalLedgerEntry)
        .find((entry) => entry.event === 'root_goal_reconciled');
      const receipt = reconciled.plan.rootGoalReconciliation!;
      assert.ok(rootEntry);
      assert.deepEqual({
        transitionVersion: rootEntry.transitionVersion,
        beforePlanDigest: rootEntry.beforePlanDigest,
        ledgerAncestry: rootEntry.ledgerAncestry,
        normalization: rootEntry.normalization,
        legacyBefore: rootEntry.legacyBefore,
        before: rootEntry.before,
        after: rootEntry.after,
        snapshotDigest: rootEntry.snapshotDigest,
        evidenceDigest: rootEntry.evidenceDigest,
        reconciledAt: rootEntry.ts,
      }, {
        transitionVersion: receipt.transitionVersion,
        beforePlanDigest: receipt.beforePlanDigest,
        ledgerAncestry: receipt.ledgerAncestry,
        normalization: receipt.normalization,
        legacyBefore: receipt.legacyBefore,
        before: receipt.before,
        after: receipt.after,
        snapshotDigest: receipt.snapshotDigest,
        evidenceDigest: receipt.evidenceDigest,
        reconciledAt: receipt.reconciledAt,
      });

      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify(created, null, 2)}\n`);
      await writeFile(ledgerPath, ledgerBefore);
      const replayed = await reconcileUltragoalRootGoal(cwd, {
        codexGoal: snapshot,
        evidence: 'Exact retry after an interrupted caller response.',
        expectedRevision: 0,
        now: new Date('2026-08-02T03:02:00.000Z'),
      });
      assert.equal(replayed.deduped, true);
      assert.equal(replayed.eventId, reconciled.eventId);
      assert.deepEqual(replayed.plan, reconciled.plan);
      assert.deepEqual(replayed.repairedProjections.sort(), ['flat goals', 'flat ledger']);
      assert.equal(await readFile(ledgerPath, 'utf-8'), ledgerAfter);
    });
  });

  it('rejects unsafe root goal reconciliation snapshots without mutating the plan', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const planPath = join(cwd, '.omx/ultragoal/goals.json');

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { objective: 'Missing identity', status: 'active' } },
          evidence: 'Must fail.',
          expectedRevision: 0,
        }),
        /threadId/,
      );
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Completed successor', status: 'complete' } },
          evidence: 'Must fail.',
          expectedRevision: 0,
        }),
        /must be active/,
      );

      await reconcileUltragoalRootGoal(cwd, {
        codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
        evidence: 'Valid explicit successor.',
        expectedRevision: 0,
      });
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Drifted objective', status: 'active' } },
          evidence: 'Must fail.',
          expectedRevision: 1,
          expectedCurrentThreadId: 'successor',
        }),
        /objective drift/,
      );

      const persisted = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      assert.deepEqual(persisted.codexRootBinding, {
        threadId: 'successor',
        objective: 'Current successor',
        revision: 1,
      });
      assert.equal(persisted.goals[0]?.id, created.goals[0]?.id);

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: created.goals[0]!.id,
          status: 'complete',
          evidence: 'Must fail.',
          codexGoal: {
            goal: {
              threadId: 'successor',
              objective: created.codexObjective,
              status: 'active',
            },
          },
        }),
        /objective mismatch/,
      );
    });
  });

  it('rejects legacy completed aggregate runs before normalizing or binding them', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
      const legacyCompletePlan = {
        ...created,
        goals: created.goals.map((goal) => ({ ...goal, status: 'completed' })),
      };
      const raw = `${JSON.stringify(legacyCompletePlan, null, 2)}\n`;
      await writeFile(flatPlanPath, raw);
      await writeFile(namespacedPlanPath, raw);
      const before = await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8'),
        readFile(join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl'), 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
          evidence: 'Completed legacy runs must remain terminal.',
          expectedRevision: 0,
        }),
        /run is complete/,
      );
      assert.deepEqual(await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8'),
        readFile(join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl'), 'utf-8'),
      ]), before);
    });
  });

  it('fails loud instead of repairing corrupt root goal reconciliation ledger state', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const snapshot = {
        goal: {
          threadId: 'successor',
          objective: 'Current successor',
          status: 'active',
        },
      };
      await reconcileUltragoalRootGoal(cwd, {
        codexGoal: snapshot,
        evidence: 'Valid explicit successor.',
        expectedRevision: 0,
      });

      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      const flatLedger = await readFile(flatLedgerPath, 'utf-8');
      await writeFile(flatLedgerPath, flatLedger.slice(0, -1));
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Exact retry.',
          expectedRevision: 0,
        }),
        /truncated Ultragoal ledger/,
      );

      await writeFile(flatLedgerPath, flatLedger);
      const namespacedEntries = (await readFile(namespacedLedgerPath, 'utf-8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const reconciliation = namespacedEntries.find((entry) => entry.event === 'root_goal_reconciled');
      assert.ok(reconciliation);
      reconciliation.message = 'Conflicting authored event.';
      await writeFile(namespacedLedgerPath, `${namespacedEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Exact retry.',
          expectedRevision: 0,
        }),
        /Conflicting root goal reconciliation transition/,
      );

      await writeFile(flatLedgerPath, '{"ts":"2026-08-02T00:00:00.000Z","event":"flat_only","message":"flat"}\n');
      await writeFile(namespacedLedgerPath, '{"ts":"2026-08-02T00:00:00.000Z","event":"run_only","message":"run"}\n');
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Exact retry.',
          expectedRevision: 0,
        }),
        /divergent Ultragoal ledgers/,
      );
    });
  });

  it('does not bind a root goal before divergent ledgers fail validation', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      await writeFile(flatLedgerPath, '{"ts":"2026-08-02T00:00:00.000Z","event":"flat_only","message":"flat"}\n');
      await writeFile(namespacedLedgerPath, '{"ts":"2026-08-02T00:00:00.000Z","event":"run_only","message":"run"}\n');
      const flatLedger = await readFile(flatLedgerPath, 'utf-8');
      const namespacedLedger = await readFile(namespacedLedgerPath, 'utf-8');
      const before = await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(flatLedgerPath, 'utf-8'),
        readFile(namespacedLedgerPath, 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
          evidence: 'Must fail without binding.',
          expectedRevision: 0,
          expectedFlatLedgerDigest: sha256(flatLedger),
          expectedNamespacedLedgerDigest: sha256(namespacedLedger),
        }),
        /divergent Ultragoal ledgers/,
      );

      assert.deepEqual(await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(flatLedgerPath, 'utf-8'),
        readFile(namespacedLedgerPath, 'utf-8'),
      ]), before);
    });
  });

  it('preserves an exact 53/7 legacy ledger ancestry while adding one v1 root event', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
        now: new Date('2026-08-02T03:00:00.000Z'),
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const runDir = ultragoalRunDir(cwd, created.runId!);
      const namespacedPlanPath = join(runDir, 'goals.json');
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(runDir, 'ledger.jsonl');
      const legacyPlan = {
        ...created,
        codexObjective: 'Complete Enterprise GenUI Multiplayer G001-G013 end to end.',
        rootGoalId: 'obsolete-root',
        codexThreadId: 'obsolete-root',
      };
      const legacyPlanRaw = `${JSON.stringify(legacyPlan, null, 2)}\n`;
      await writeFile(flatPlanPath, legacyPlanRaw);
      await writeFile(namespacedPlanPath, legacyPlanRaw);

      const prefixEntries = Array.from({ length: 46 }, (_, index) => JSON.stringify({
        ts: `2026-08-01T00:${String(index).padStart(2, '0')}:00.000Z`,
        event: 'goal_checkpoint',
        message: `preserved flat history ${index + 1}`,
      }));
      const runEntries = [
        {
          ts: '2026-08-01T12:00:00.000Z',
          event: 'plan_created',
          message: `adopted existing ultragoal registry as run ${created.runId} (1 goal(s))`,
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          ts: `2026-08-01T13:0${index}:00.000Z`,
          event: 'goal_checkpoint',
          message: `preserved run history ${index + 1}`,
        })),
        {
          ts: '2026-08-02T02:30:28.000Z',
          event: 'root_goal_reconciled',
          runId: created.runId,
          rootGoalId: 'obsolete-root',
          codexThreadId: 'obsolete-root',
          message: 'Historical unversioned successor reconciliation.',
          evidence: 'Preserve this historical event byte-for-byte.',
        },
      ].map((entry) => JSON.stringify(entry));
      const namespacedBefore = `${runEntries.join('\n')}\n`;
      const flatBefore = `${prefixEntries.join('\n')}\n${namespacedBefore}`;
      assert.equal(flatBefore.trimEnd().split('\n').length, 53);
      assert.equal(namespacedBefore.trimEnd().split('\n').length, 7);
      await writeFile(flatLedgerPath, flatBefore);
      await writeFile(namespacedLedgerPath, namespacedBefore);

      const result = await reconcileUltragoalRootGoal(cwd, {
        codexGoal: {
          goal: {
            threadId: '019fbae5-b750-7ab2-875f-e36bcdeb3981',
            objective: 'Complete Enterprise GenUI Multiplayer G001-G013 end to end.',
            status: 'active',
          },
        },
        evidence: 'Chris reset the live root while preserving the 53/7 durable history.',
        expectedRevision: 0,
        expectedFlatLedgerDigest: sha256(flatBefore),
        expectedNamespacedLedgerDigest: sha256(namespacedBefore),
        now: new Date('2026-08-02T03:01:00.000Z'),
      });

      const after = await readFile(flatLedgerPath, 'utf-8');
      assert.equal(after.slice(0, flatBefore.length), flatBefore);
      assert.equal(await readFile(namespacedLedgerPath, 'utf-8'), after);
      assert.equal((after.match(/"event":"root_goal_reconciled"/g) ?? []).length, 2);
      assert.equal((after.match(/"eventVersion":1/g) ?? []).length, 1);
      assert.equal(result.plan.rootGoalReconciliation?.ledgerAncestry.relation, 'flat_has_namespaced_suffix');
      assert.ok(result.plan.rootGoalReconciliation?.ledgerAncestry.runAnchorDigest);
      assert.equal(result.plan.rootGoalReconciliation?.ledgerAncestry.runAnchorLine, 47);
      assert.equal((result.plan as UltragoalPlan & { rootGoalId?: string }).rootGoalId, undefined);
      assert.equal((result.plan as UltragoalPlan & { codexThreadId?: string }).codexThreadId, undefined);
    });
  });

  it('rejects wrong hashes and unanchored prefix/suffix ledgers without mutation', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      const namespacedLedger = await readFile(namespacedLedgerPath, 'utf-8');
      const flatLedger = `{"ts":"2026-08-01T00:00:00.000Z","event":"goal_checkpoint","message":"prefix"}\n${namespacedLedger}`;
      await writeFile(flatLedgerPath, flatLedger);
      const before = await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(flatLedgerPath, 'utf-8'),
        readFile(namespacedLedgerPath, 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
          evidence: 'Wrong digest must fail.',
          expectedRevision: 0,
          expectedFlatLedgerDigest: '0'.repeat(64),
          expectedNamespacedLedgerDigest: sha256(namespacedLedger),
        }),
        /ancestry digest mismatch/,
      );
      await writeFile(namespacedLedgerPath, '{"ts":"2026-08-01T00:00:00.000Z","event":"goal_checkpoint","message":"no run anchor"}\n');
      const unanchored = await readFile(namespacedLedgerPath, 'utf-8');
      const unanchoredFlat = `{"ts":"2026-08-01T00:00:00.000Z","event":"goal_checkpoint","message":"prefix"}\n${unanchored}`;
      await writeFile(flatLedgerPath, unanchoredFlat);
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
          evidence: 'Unanchored history must fail.',
          expectedRevision: 0,
          expectedFlatLedgerDigest: sha256(unanchoredFlat),
          expectedNamespacedLedgerDigest: sha256(unanchored),
        }),
        /without a plan_created anchor/,
      );

      assert.deepEqual(await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
      ]), before.slice(0, 2));
    });
  });

  it('repairs one missing ledger but rejects two absent histories', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      const namespacedBefore = await readFile(namespacedLedgerPath, 'utf-8');
      await rm(flatLedgerPath);

      await reconcileUltragoalRootGoal(cwd, {
        codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
        evidence: 'Repair the missing flat projection from canonical run history.',
        expectedRevision: 0,
      });
      assert.match(await readFile(flatLedgerPath, 'utf-8'), /"event":"root_goal_reconciled"/);
      assert.equal(await readFile(flatLedgerPath, 'utf-8'), await readFile(namespacedLedgerPath, 'utf-8'));

      const second = await createUltragoalPlan(cwd, {
        brief: 'different brief',
        goals: [{ title: 'Second', objective: 'Complete second milestone with tests.' }],
        newNamespace: true,
      });
      await rm(join(cwd, '.omx/ultragoal/ledger.jsonl'));
      await rm(join(ultragoalRunDir(cwd, second.runId!), 'ledger.jsonl'));
      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'second-successor', objective: 'Second successor', status: 'active' } },
          evidence: 'No durable history must fail.',
          expectedRevision: 0,
        }),
        /neither ledger contains valid history/,
      );
      assert.ok(namespacedBefore);
    });
  });

  it('rejects malformed JSONL values and malformed legacy root events', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      for (const malformed of [
        'true\n',
        '{"ts":"2026-08-02T00:00:00.000Z","event":"root_goal_reconciled","runId":"run","message":"missing fields"}\n',
      ]) {
        await writeFile(flatLedgerPath, malformed);
        await assert.rejects(
          () => reconcileUltragoalRootGoal(cwd, {
            codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
            evidence: 'Malformed history must fail.',
            expectedRevision: 0,
          }),
          /invalid ledger entry|Malformed legacy root goal reconciliation/,
        );
      }
      assert.match(await readFile(namespacedLedgerPath, 'utf-8'), /"event":"plan_created"/);
    });
  });

  it('recovers a stale mutation lock and serializes identical and competing successors', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      await writeFile(
        join(cwd, '.omx/ultragoal/.mutation.lock'),
        JSON.stringify({ pid: 99999999, token: 'stale-owner', created_at: '2026-08-01T00:00:00.000Z' }),
      );
      const snapshot = { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } };
      const [first, second] = await Promise.all([
        reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'First identical caller.',
          expectedRevision: 0,
        }),
        reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Second identical caller.',
          expectedRevision: 0,
        }),
      ]);
      assert.equal([first, second].filter((result) => result.deduped).length, 1);
      assert.equal(first.eventId, second.eventId);
      assert.equal(existsSync(join(cwd, '.omx/ultragoal/.mutation.lock')), false);

      const outcomes = await Promise.allSettled([
        reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'next-a', objective: 'Next A', status: 'active' } },
          evidence: 'Competing successor A.',
          expectedRevision: 1,
          expectedCurrentThreadId: 'successor',
        }),
        reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'next-b', objective: 'Next B', status: 'active' } },
          evidence: 'Competing successor B.',
          expectedRevision: 1,
          expectedCurrentThreadId: 'successor',
        }),
      ]);
      assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"eventVersion":1/g) ?? []).length, 2);
    });
  });

  it('rejects forged committed receipts without repairing any projection', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const snapshot = { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } };
      await reconcileUltragoalRootGoal(cwd, {
        codexGoal: snapshot,
        evidence: 'Valid first reconciliation.',
        expectedRevision: 0,
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
      const canonical = JSON.parse(await readFile(namespacedPlanPath, 'utf-8')) as UltragoalPlan;
      canonical.rootGoalReconciliation!.eventId = '0'.repeat(64);
      await writeFile(namespacedPlanPath, `${JSON.stringify(canonical, null, 2)}\n`);
      const before = await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8'),
        readFile(join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl'), 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Forged receipt must fail.',
          expectedRevision: 0,
        }),
        /event id mismatch/,
      );
      assert.deepEqual(await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8'),
        readFile(join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl'), 'utf-8'),
      ]), before);
    });
  });

  it('rejects identical pre-event history tampering and broken reconciliation revision chains', async () => {
    await withTempRepo(async (cwd) => {
      const fixture = await createRootReconciliationTamperFixture(cwd);
      for (const path of [fixture.flatLedgerPath, fixture.namespacedLedgerPath]) {
        const raw = await readFile(path, 'utf-8');
        assert.match(raw, /"message":"legacy"/);
        await writeFile(path, raw.replace('"message":"legacy"', '"message":"forged"'));
      }
      const before = await Promise.all([
        readFile(fixture.flatLedgerPath, 'utf-8'),
        readFile(fixture.namespacedLedgerPath, 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: fixture.snapshot,
          evidence: 'Identical predecessor tampering must fail.',
          expectedRevision: 0,
        }),
        /ledger ancestry digest mismatch/,
      );
      assert.deepEqual(await Promise.all([
        readFile(fixture.flatLedgerPath, 'utf-8'),
        readFile(fixture.namespacedLedgerPath, 'utf-8'),
      ]), before);
    });

    await withTempRepo(async (cwd) => {
      const fixture = await createRootReconciliationTamperFixture(cwd, true);
      for (const path of [fixture.flatLedgerPath, fixture.namespacedLedgerPath]) {
        const entries = (await readFile(path, 'utf-8'))
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line) as UltragoalLedgerEntry)
          .filter((entry) => !(
            entry.event === 'root_goal_reconciled'
            && entry.eventVersion === 1
            && entry.revision === 1
          ));
        await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
      }

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: fixture.snapshot,
          evidence: 'A missing predecessor revision must fail.',
          expectedRevision: 1,
        }),
        /Non-contiguous root goal reconciliation revision/,
      );
    });
  });

  it('dedupes a later-revision retry that repeats its predecessor thread guard', async () => {
    await withTempRepo(async (cwd) => {
      const fixture = await createRootReconciliationTamperFixture(cwd, true);
      const replayed = await reconcileUltragoalRootGoal(cwd, {
        codexGoal: fixture.snapshot,
        evidence: 'Retry the committed second revision after losing the response.',
        expectedRevision: 1,
        expectedCurrentThreadId: 'successor',
      });

      assert.equal(replayed.deduped, true);
      assert.equal(replayed.before?.threadId, 'successor');
      assert.equal(replayed.after.threadId, 'next-successor');
      assert.equal(replayed.after.revision, 2);
    });
  });

  it('integrity-binds every immutable plan recovery field', async () => {
    for (const [field, withBefore] of ROOT_TRANSITION_TAMPER_CASES) {
      await withTempRepo(async (cwd) => {
        const fixture = await createRootReconciliationTamperFixture(cwd, withBefore);
        const plan = JSON.parse(
          await readFile(fixture.namespacedPlanPath, 'utf-8'),
        ) as UltragoalPlan;
        const receipt = plan.rootGoalReconciliation!;
        tamperRootTransitionField(receipt as MutableRootTransition, field);
        if (field === 'after binding') plan.codexRootBinding = receipt.after;
        await writeFile(fixture.namespacedPlanPath, `${JSON.stringify(plan, null, 2)}\n`);

        await assert.rejects(
          () => reconcileUltragoalRootGoal(cwd, {
            codexGoal: fixture.snapshot,
            evidence: `Reject forged ${field}.`,
            expectedRevision: withBefore ? 1 : 0,
          }),
          /reconciliation/i,
          field,
        );
      });
    }
  });

  it('integrity-binds every immutable ledger recovery field', async () => {
    for (const [field, withBefore] of ROOT_TRANSITION_TAMPER_CASES) {
      await withTempRepo(async (cwd) => {
        const fixture = await createRootReconciliationTamperFixture(cwd, withBefore);
        for (const path of [fixture.flatLedgerPath, fixture.namespacedLedgerPath]) {
          const entries = (await readFile(path, 'utf-8'))
            .trimEnd()
            .split('\n')
            .map((line) => JSON.parse(line) as UltragoalLedgerEntry);
          const entry = entries
            .filter((candidate) => candidate.event === 'root_goal_reconciled' && candidate.eventVersion === 1)
            .at(-1)!;
          tamperRootTransitionField(entry as MutableRootTransition, field);
          await writeFile(path, `${entries.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`);
        }

        await assert.rejects(
          () => reconcileUltragoalRootGoal(cwd, {
            codexGoal: fixture.snapshot,
            evidence: `Reject forged ledger ${field}.`,
            expectedRevision: withBefore ? 1 : 0,
          }),
          /root goal reconciliation/i,
          field,
        );
      });
    }
  });

  it('replays each durable projection boundary without duplicating the root event', async () => {
    for (const boundary of ['canonical-plan', 'both-plans', 'namespaced-ledger'] as const) {
      await withTempRepo(async (cwd) => {
        const created = await createUltragoalPlan(cwd, {
          brief: 'brief',
          goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
        });
        const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
        const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
        const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
        const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
        const predecessorPlan = await readFile(namespacedPlanPath, 'utf-8');
        const predecessorLedger = await readFile(namespacedLedgerPath, 'utf-8');
        const snapshot = { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } };
        await reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: 'Commit a reconciliation for boundary replay.',
          expectedRevision: 0,
        });
        const committedPlan = await readFile(namespacedPlanPath, 'utf-8');
        const committedLedger = await readFile(namespacedLedgerPath, 'utf-8');

        if (boundary === 'canonical-plan') {
          await writeFile(flatPlanPath, predecessorPlan);
          await writeFile(namespacedLedgerPath, predecessorLedger);
          await writeFile(flatLedgerPath, predecessorLedger);
        } else if (boundary === 'both-plans') {
          await writeFile(namespacedLedgerPath, predecessorLedger);
          await writeFile(flatLedgerPath, predecessorLedger);
        } else {
          await writeFile(flatLedgerPath, predecessorLedger);
        }

        const replayed = await reconcileUltragoalRootGoal(cwd, {
          codexGoal: snapshot,
          evidence: `Replay after ${boundary}.`,
          expectedRevision: 0,
        });
        assert.equal(replayed.deduped, true, boundary);
        assert.equal(await readFile(flatPlanPath, 'utf-8'), committedPlan, boundary);
        assert.equal(await readFile(namespacedPlanPath, 'utf-8'), committedPlan, boundary);
        assert.equal(await readFile(flatLedgerPath, 'utf-8'), committedLedger, boundary);
        assert.equal(await readFile(namespacedLedgerPath, 'utf-8'), committedLedger, boundary);
        assert.equal((committedLedger.match(/"eventVersion":1/g) ?? []).length, 1, boundary);
      });
    }
  });

  it('serializes legacy read migrations and records each migration once', async () => {
    await withTempRepo(async (cwd) => {
      await mkdir(join(cwd, '.omx/ultragoal'), { recursive: true });
      const legacyObjective = 'Complete all ultragoal stories in .omx/ultragoal/goals.json: G001-first First';
      await writeFile(join(cwd, '.omx/ultragoal/goals.json'), `${JSON.stringify({
        version: 1,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        briefPath: '.omx/ultragoal/brief.md',
        goalsPath: '.omx/ultragoal/goals.json',
        ledgerPath: '.omx/ultragoal/ledger.jsonl',
        codexGoalMode: 'aggregate',
        codexObjective: legacyObjective,
        goals: [{
          id: 'G001-first',
          title: 'First',
          objective: 'Complete first.',
          status: 'completed',
          attempt: 1,
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        }],
      }, null, 2)}\n`);
      await writeFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), '');

      const [first, second] = await Promise.all([
        readUltragoalPlan(cwd),
        readUltragoalPlan(cwd),
      ]);
      assert.deepEqual(first, second);
      assert.equal(first.goals[0]?.status, 'complete');
      assert.equal(first.codexObjective, ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"plan_migrated"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"aggregate_objective_migrated"/g) ?? []).length, 1);
    });
  });

  it('rejects an unrelated flat plan before writing reconciliation artifacts', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const flatPlanPath = join(cwd, '.omx/ultragoal/goals.json');
      const namespacedPlanPath = join(ultragoalRunDir(cwd, created.runId!), 'goals.json');
      const flatLedgerPath = join(cwd, '.omx/ultragoal/ledger.jsonl');
      const namespacedLedgerPath = join(ultragoalRunDir(cwd, created.runId!), 'ledger.jsonl');
      const unrelated = { ...created, runId: 'unrelated-run' };
      await writeFile(flatPlanPath, `${JSON.stringify(unrelated, null, 2)}\n`);
      const before = await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(flatLedgerPath, 'utf-8'),
        readFile(namespacedLedgerPath, 'utf-8'),
      ]);

      await assert.rejects(
        () => reconcileUltragoalRootGoal(cwd, {
          codexGoal: { goal: { threadId: 'successor', objective: 'Current successor', status: 'active' } },
          evidence: 'Wrong-run flat plan must fail.',
          expectedRevision: 0,
        }),
        /Flat Ultragoal plan is neither/,
      );
      assert.deepEqual(await Promise.all([
        readFile(flatPlanPath, 'utf-8'),
        readFile(namespacedPlanPath, 'utf-8'),
        readFile(flatLedgerPath, 'utf-8'),
        readFile(namespacedLedgerPath, 'utf-8'),
      ]), before);
    });
  });

  it('applies steering idempotently and keeps split replacements schedulable', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'Core steering model', objective: 'Implement bounded dynamic steering.' },
          { title: 'CLI bridge', objective: 'Expose structured steering through the CLI.' },
          { title: 'Hook bridge', objective: 'Bridge explicit steering directives.' },
        ],
      });

      const firstSteer = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-core-steering-model'],
        childGoals: [
          { title: 'Core steering schema', objective: 'Add steering proposal and audit schema.' },
          { title: 'Core steering scheduler semantics', objective: 'Make superseded and blocked metadata affect scheduling and completion.' },
        ],
        evidence: 'Implementation findings show schema and scheduler invariants should be isolated.',
        rationale: 'Splitting reduces coupling without deleting or weakening the original goal.',
        idempotencyKey: 'steering-idempotency-check',
      });

      assert.equal(firstSteer.accepted, true);
      assert.equal(firstSteer.deduped, false);
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G001-core-steering-model')?.steeringStatus, 'superseded');
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G004-core-steering-schema')?.supersedes?.[0], 'G001-core-steering-model');
      assert.equal(firstSteer.plan.goals.find((goal) => goal.id === 'G005-core-steering-scheduler-semantics')?.supersedes?.[0], 'G001-core-steering-model');
      assert.equal(firstSteer.plan.goals.filter((goal) => goal.steeringStatus === 'superseded').length, 1);
      assert.equal(isUltragoalDone(firstSteer.plan), false);

      const started = await startNextUltragoal(cwd);
      assert.equal(started.goal?.id, 'G004-core-steering-schema');
      assert.equal(started.goal?.status, 'in_progress');
      assert.equal(started.resumed, false);

      const secondSteer = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-core-steering-model'],
        childGoals: [
          { title: 'Core steering schema', objective: 'Add steering proposal and audit schema.' },
          { title: 'Core steering scheduler semantics', objective: 'Make superseded and blocked metadata affect scheduling and completion.' },
        ],
        evidence: 'Implementation findings show schema and scheduler invariants should be isolated.',
        rationale: 'Splitting reduces coupling without deleting or weakening the original goal.',
        idempotencyKey: 'steering-idempotency-check',
      });

      assert.equal(secondSteer.accepted, true);
      assert.equal(secondSteer.deduped, true);
      assert.equal(secondSteer.plan.goals.filter((goal) => goal.id === 'G004-core-steering-schema').length, 1);
      assert.equal(secondSteer.plan.goals.filter((goal) => goal.id === 'G005-core-steering-scheduler-semantics').length, 1);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
    });
  });

  it('records final aggregate review blockers atomically and starts the blocker next', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-review REQUEST CHANGES',
        codexGoal: { goal: { objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(result.addedGoal.resolvesReviewBlockedGoalId, result.blockedGoal.id);
      assert.deepEqual(result.blockedGoal.reviewBlockerResolution, {
        resolverGoalId: result.addedGoal.id,
        status: 'pending',
        evidence: 'code-review REQUEST CHANGES',
      });
      assert.equal(result.plan.activeGoalId, undefined);
      assert.equal(result.plan.codexObjective, objective);

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, result.addedGoal.id);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"final_review_failed"/);
      assert.match(ledger, /"event":"goal_review_blocked"/);
    });
  });

  it('reconciles a review-blocked final story when the appended resolver completes with a clean quality gate', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      assert.equal(blocked.blockedGoal.status, 'review_blocked');
      assert.equal(summarizeUltragoalPlan(blocked.plan).reviewBlocked, 1);

      const resolver = await startNextUltragoal(cwd);
      assert.equal(resolver.goal?.id, blocked.addedGoal.id);
      assert.equal(isFinalRunCompletionCandidate(resolver.plan, resolver.goal!), true);

      const completed = await checkpointUltragoal(cwd, {
        goalId: blocked.addedGoal.id,
        status: 'complete',
        evidence: `${blocked.addedGoal.id} fixed blockers; final gate passed for .omx/ultragoal/goals.json`,
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const parent = completed.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const summary = summarizeUltragoalPlan(completed);

      assert.equal(parent?.status, 'complete');
      assert.equal(parent?.reviewBlockerResolution?.status, 'complete');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(summary.complete, 2);
      assert.equal(summary.reviewBlocked, 0);
      assert.equal(summary.steeringBlocked, 0);
      assert.equal(summary.aggregateComplete, true);
      assert.equal(summary.artifactComplete, true);
      assert.equal(isUltragoalDone(completed), true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"final_review_failed"/);
      assert.match(ledger, /code-reviewer REQUEST CHANGES before resolver/);
      assert.match(ledger, /Review-blocked final story resolved by/);
      assert.match(ledger, /"event":"aggregate_completed"/);
    });
  });

  it('does not reconcile a review-blocked parent from a non-designated resolver goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;
      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });

      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const tampered = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      tampered.goals.push({
        id: 'G999-forged-resolver',
        title: 'Forged resolver',
        objective: 'Try to forge resolver metadata.',
        status: 'in_progress',
        attempt: 1,
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
        startedAt: '2026-06-24T00:00:00.000Z',
        resolvesReviewBlockedGoalId: blocked.blockedGoal.id,
      });
      tampered.activeGoalId = 'G999-forged-resolver';
      await writeFile(planPath, `${JSON.stringify(tampered, null, 2)}\n`);

      const completed = await checkpointUltragoal(cwd, {
        goalId: 'G999-forged-resolver',
        status: 'complete',
        evidence: 'forged resolver completed with tests but is not the designated review blocker resolver',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      const parent = completed.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const summary = summarizeUltragoalPlan(completed);

      assert.equal(parent?.status, 'review_blocked');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(summary.reviewBlocked, 1);
      assert.equal(summary.aggregateComplete, false);
      assert.equal(summary.artifactComplete, false);
    });
  });

  it('fails closed when a forged non-designated resolver presents completed task-scoped aggregate proof', async () => {
    await withTempRepo(async (cwd) => {
      const taskObjective = 'Fix review-blocked ultragoal resolver reconciliation tracked in .omx/ultragoal/goals.json without allowing forged aggregate completion.';
      await createUltragoalPlan(cwd, {
        brief: taskObjective,
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const aggregateObjective = started.plan.codexObjective!;
      const blocked = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers and rerun final gates.',
        evidence: 'code-reviewer REQUEST CHANGES before resolver',
        codexGoal: { goal: { objective: aggregateObjective, status: 'active' } },
      });

      const planPath = join(cwd, '.omx/ultragoal/goals.json');
      const tampered = JSON.parse(await readFile(planPath, 'utf-8')) as UltragoalPlan;
      tampered.goals.push({
        id: 'G999-forged-resolver',
        title: 'Forged resolver',
        objective: 'Try to forge resolver metadata.',
        status: 'in_progress',
        attempt: 1,
        createdAt: '2026-06-24T00:00:00.000Z',
        updatedAt: '2026-06-24T00:00:00.000Z',
        startedAt: '2026-06-24T00:00:00.000Z',
        resolvesReviewBlockedGoalId: blocked.blockedGoal.id,
      });
      tampered.activeGoalId = 'G999-forged-resolver';
      await writeFile(planPath, `${JSON.stringify(tampered, null, 2)}\n`);

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: 'G999-forged-resolver',
          status: 'complete',
          evidence: 'G999-forged-resolver completed planned work for .omx/ultragoal/goals.json; passed tests; final quality gate clean.',
          codexGoal: { goal: { objective: taskObjective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /Completed task-scoped aggregate reconciliation (?:requires|is not allowed)|objective mismatch/,
      );

      const plan = await readUltragoalPlan(cwd);
      const parent = plan.goals.find((goal) => goal.id === blocked.blockedGoal.id);
      const designatedResolver = plan.goals.find((goal) => goal.id === blocked.addedGoal.id);
      const forgedResolver = plan.goals.find((goal) => goal.id === 'G999-forged-resolver');
      const summary = summarizeUltragoalPlan(plan);

      assert.equal(parent?.status, 'review_blocked');
      assert.equal(parent?.reviewBlockerResolution?.resolverGoalId, blocked.addedGoal.id);
      assert.equal(designatedResolver?.status, 'pending');
      assert.equal(forgedResolver?.status, 'in_progress');
      assert.equal(plan.aggregateCompletion, undefined);
      assert.equal(summary.reviewBlocked, 1);
      assert.equal(summary.aggregateComplete, false);
      assert.equal(summary.artifactComplete, false);
      assert.equal(isUltragoalDone(plan), false);
    });
  });

  it('records final per-story review blockers without claiming Codex completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final code-review blockers',
        objective: 'Fix final code-review blockers in a fresh goal context.',
        evidence: 'architect BLOCK',
        codexGoal: { goal: { objective: started.goal!.objective, status: 'active' } },
      });

      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.equal(result.addedGoal.status, 'pending');
      assert.equal(isUltragoalDone(result.plan), false);
    });
  });

  it('requires structured final quality gate evidence for clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
        }),
        /quality-gate-json|quality gate/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: { recommendation: 'COMMENT', architectStatus: 'CLEAR', evidence: 'not clean' },
          },
        }),
        /APPROVE/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            aiSlopCleaner: { status: 'not_applicable', evidence: 'skipped cleaner' },
          },
        }),
        /aiSlopCleaner\.status="passed"/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'same execution lane self-reviewed and approved without spawning review subagents',
            },
          },
        }),
        /independent review unavailable|self-approving/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'native independent review unavailable',
            },
            nativeSubagentSupport: {
              status: 'unsupported',
              reason: 'native_subagents_unsupported',
              source: 'persisted_support_blocker',
              evidenceSummary: 'native subagents are disabled in this runtime',
            },
          },
        }),
        /independent review unavailable|self-approving/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'authoring lane claimed it was merge-ready',
              independentReview: {
                codeReviewer: { agentRole: 'executor', evidence: 'authoring lane approved its own change' },
                architect: { agentRole: 'architect', evidence: 'architect subagent returned CLEAR' },
              },
            },
          },
        }),
        /independent code-reviewer subagent|self-review/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            codeReview: {
              recommendation: 'APPROVE',
              architectStatus: 'CLEAR',
              evidence: 'code-review path skipped architect delegation',
              independentReview: {
                codeReviewer: { agentRole: 'code-reviewer', evidence: 'code-reviewer subagent returned APPROVE' },
              },
            },
          },
        }),
        /missing codeReview\.independentReview\.architect/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"qualityGate"/);
      assert.match(ledger, /"aiSlopCleaner"/);
      assert.match(ledger, /"codeReview"/);
    });
  });

  it('requires final architecture invariant proof from the brief before clean completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: [
          'Ship the integration safely.',
          '',
          '## Architecture Invariants',
          '- Preserve the existing parser boundary.',
          '- Do not introduce a second scheduler.',
        ].join('\n'),
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: cleanQualityGate(),
        }),
        /missing proof for required invariant from \.omx\/ultragoal\/brief\.md: Preserve the existing parser boundary/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: started.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: {
          ...cleanQualityGate(),
          architectureInvariantGate: {
            status: 'passed',
            sourceArtifacts: ['.omx/ultragoal/brief.md', '.omx/ultragoal/goals.json'],
            evidence: 'all declared invariants have implementation, test, and review proof',
            invariants: [
              {
                invariant: 'Preserve the existing parser boundary.',
                source: '.omx/ultragoal/brief.md#architecture-invariants',
                status: 'proved',
                implementationEvidence: 'parser changes stayed inside src/parser without scheduler coupling',
                testEvidence: 'parser boundary regression test passed',
                reviewEvidence: 'architect review confirmed parser boundary remained intact',
              },
              {
                invariant: 'Do not introduce a second scheduler.',
                source: '.omx/ultragoal/brief.md#architecture-invariants',
                status: 'proved',
                implementationEvidence: 'implementation reused the existing scheduler entrypoint',
                testEvidence: 'scheduler singleton regression passed',
                reviewEvidence: 'architect review confirmed no duplicate scheduler path',
              },
            ],
          },
        },
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
    });
  });

  it('requires final architecture invariant proof from accepted steering annotations', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'Ship the integration safely without a brief invariant section.',
        goals: [
          { title: 'Audit steering invariant', objective: 'Accept steering invariant annotation.' },
          { title: 'Final', objective: 'Complete final milestone.' },
        ],
      });
      const first = await startNextUltragoal(cwd);
      await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'finding',
        evidence: 'Reviewer finding. Architecture invariant: Ledger entries remain append-only',
        rationale: 'Non-negotiable architecture invariant: Ledger entries remain append-only',
      });
      await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'complete',
        evidence: 'steering invariant accepted for final gate coverage',
        codexGoal: { goal: { objective: first.plan.codexObjective!, status: 'active' } },
        allowActiveFinalCodexGoal: true,
      });
      const final = await startNextUltragoal(cwd);
      const objective = final.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: final.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/ledger.jsonl'],
              invariants: [],
              evidence: 'architect verified no additional architecture invariants were declared in the brief',
            },
          },
        }),
        /missing proof for required invariant from \.omx\/ultragoal\/ledger\.jsonl: Ledger entries remain append-only/i,
      );

      await checkpointUltragoal(cwd, {
        goalId: final.goal!.id,
        status: 'complete',
        evidence: 'final gates passed',
        codexGoal: { goal: { objective, status: 'complete' } },
        qualityGate: {
          ...cleanQualityGate(),
          architectureInvariantGate: {
            status: 'passed',
            sourceArtifacts: ['.omx/ultragoal/ledger.jsonl'],
            evidence: 'accepted steering invariant has implementation, test, and review proof',
            invariants: [
              {
                invariant: 'Ledger entries remain append-only',
                source: '.omx/ultragoal/ledger.jsonl#steering-3-inline-architecture-invariant',
                status: 'proved',
                implementationEvidence: 'appendLedger only appends JSONL records',
                testEvidence: 'ledger append-only regression passed',
                reviewEvidence: 'architect review confirmed ledger mutation remains append-only',
              },
            ],
          },
        },
      });

      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), true);
    });
  });

  it('rejects decorative architecture invariant provenance labels that omit source artifacts', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: [
          'Ship the integration safely.',
          '',
          '## Architecture Invariants',
          '- Preserve the existing parser boundary.',
        ].join('\n'),
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['review-note: claims brief coverage'],
              evidence: 'decorative label claims the invariant came from the brief',
              invariants: [
                {
                  invariant: 'Preserve the existing parser boundary.',
                  source: 'review-note: brief architecture invariant',
                  status: 'proved',
                  implementationEvidence: 'parser boundary preserved',
                  testEvidence: 'parser boundary test passed',
                  reviewEvidence: 'architect review confirmed parser boundary',
                },
              ],
            },
          },
        }),
        /sourceArtifacts must include required invariant source artifact: \.omx\/ultragoal\/brief\.md/i,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/brief.md'],
              evidence: 'source artifact is listed but record source is decorative',
              invariants: [
                {
                  invariant: 'Preserve the existing parser boundary.',
                  source: 'review-note: brief architecture invariant',
                  status: 'proved',
                  implementationEvidence: 'parser boundary preserved',
                  testEvidence: 'parser boundary test passed',
                  reviewEvidence: 'architect review confirmed parser boundary',
                },
              ],
            },
          },
        }),
        /source must reference one of architectureInvariantGate\.sourceArtifacts|decorative provenance labels/i,
      );
    });
  });

  it('blocks final completion when architecture invariants are unproved or carry blockers', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: '## Domain Invariants\n- Ledger entries remain append-only.',
        goals: [{ title: 'Final', objective: 'Complete final milestone.' }],
      });
      const started = await startNextUltragoal(cwd);
      const objective = started.plan.codexObjective!;

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: started.goal!.id,
          status: 'complete',
          evidence: 'tests passed',
          codexGoal: { goal: { objective, status: 'complete' } },
          qualityGate: {
            ...cleanQualityGate(),
            architectureInvariantGate: {
              status: 'passed',
              sourceArtifacts: ['.omx/ultragoal/brief.md'],
              evidence: 'invariant audit found unresolved blocker',
              invariants: [
                {
                  invariant: 'Ledger entries remain append-only.',
                  source: '.omx/ultragoal/brief.md#domain-invariants',
                  status: 'blocked',
                  implementationEvidence: 'mutation path still rewrites prior entries',
                  testEvidence: 'append-only regression not written',
                  reviewEvidence: 'architect BLOCK',
                  blockers: ['existing migration rewrites ledger history'],
                },
              ],
            },
          },
        }),
        /not proved|blocker-resolution work/i,
      );

      const result = await recordFinalReviewBlockers(cwd, {
        goalId: started.goal!.id,
        title: 'Resolve final architecture invariant blockers',
        objective: 'Prove ledger append-only behavior and rerun final quality gates.',
        evidence: 'architectureInvariantGate found unproved invariant: Ledger entries remain append-only.',
        codexGoal: { goal: { objective, status: 'active' } },
      });
      assert.equal(result.blockedGoal.status, 'review_blocked');
      assert.match(result.addedGoal.objective, /ledger append-only/i);
    });
  });

  it('records a completed legacy Codex-goal blocker without failing the active ultragoal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const blocked = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'completed aggregate Codex goal blocks create_goal',
        codexGoal: { goal: { objective: 'achieve all goals on this repo ultragoal status', status: 'complete' } },
        now: new Date('2026-05-04T10:03:00Z'),
      });

      assert.equal(blocked.activeGoalId, first.goal!.id);
      assert.equal(blocked.goals[0]?.status, 'in_progress');
      assert.equal(blocked.goals[0]?.failureReason, undefined);
      assert.equal(blocked.goals[0]?.failedAt, undefined);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /completed aggregate Codex goal blocks create_goal/);
    });
  });

  it('accepts core steering mutations and writes structured audit entries', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const added = await steerUltragoal(cwd, {
        kind: 'add_subgoal',
        source: 'cli',
        evidence: 'Code review found missing migration coverage.',
        rationale: 'Add a bounded follow-up without weakening the aggregate objective.',
        title: 'Add migration regression test',
        objective: 'Add migration regression coverage and keep all existing quality gates.',
        idempotencyKey: 'add-migration-test',
      }, { now: new Date('2026-05-04T10:10:00Z') });
      assert.equal(added.accepted, true);
      assert.equal(added.plan.goals.at(-1)?.id, 'G003-add-migration-regression-test');
      assert.equal((added.audit.before as UltragoalPlan).goals.length, 2);
      assert.equal((added.audit.after as { id?: string }).id, 'G003-add-migration-regression-test');

      const split = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G002-second'],
        evidence: 'Implementation evidence shows the second milestone has two independent safety checks.',
        rationale: 'Split the pending work into narrower goals while preserving verification burden.',
        childGoals: [
          { title: 'Second parser coverage', objective: 'Complete parser coverage for the second milestone with tests.' },
          { title: 'Second CLI coverage', objective: 'Complete CLI coverage for the second milestone with tests.' },
        ],
      }, { now: new Date('2026-05-04T10:11:00Z') });
      assert.equal(split.accepted, true);
      const superseded = split.plan.goals.find((goal) => goal.id === 'G002-second');
      assert.equal(superseded?.steeringStatus, 'superseded');
      assert.deepEqual(superseded?.supersededBy, ['G004-second-parser-coverage', 'G005-second-cli-coverage']);
      assert.equal(split.plan.goals.find((goal) => goal.id === 'G004-second-parser-coverage')?.supersedes?.[0], 'G002-second');

      const revised = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G003-add-migration-regression-test'],
        evidence: 'Prompt-submit clarified the regression target after the goal was added.',
        rationale: 'Clarify wording only; do not change acceptance or verification gates.',
        revisedTitle: 'Add ledger migration regression test',
        revisedObjective: 'Add ledger migration regression coverage and keep all existing quality gates.',
        promptSignature: 'prompt-1',
      }, { now: new Date('2026-05-04T10:12:00Z') });
      assert.equal(revised.accepted, true);
      assert.equal(revised.plan.goals.find((goal) => goal.id === 'G003-add-migration-regression-test')?.title, 'Add ledger migration regression test');

      const reordered = await steerUltragoal(cwd, {
        kind: 'reorder_pending',
        source: 'cli',
        evidence: 'Dependency analysis shows parser coverage should run before the original first milestone.',
        rationale: 'Reorder pending stories only; status and quality gates are unchanged.',
        pendingOrder: ['G004-second-parser-coverage', 'G001-first'],
      }, { now: new Date('2026-05-04T10:13:00Z') });
      assert.equal(reordered.accepted, true);
      const next = await startNextUltragoal(cwd, { now: new Date('2026-05-04T10:14:00Z') });
      assert.equal(next.goal?.id, 'G004-second-parser-coverage');

      const annotated = await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'finding',
        evidence: 'A reviewer recorded why parser coverage was scheduled first.',
        rationale: 'Audit-only annotation; no plan fields should change.',
      }, { now: new Date('2026-05-04T10:15:00Z') });
      assert.equal(annotated.accepted, true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 5);
      assert.match(ledger, /"kind":"add_subgoal"/);
      assert.match(ledger, /"kind":"split_subgoal"/);
      assert.match(ledger, /"kind":"annotate_ledger"/);
      assert.match(ledger, /"invariant":/);
    });
  });

  it('rejects weakening steering and records rejected audit evidence', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const invariant = validateUltragoalSteeringProposal(plan, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G001-first'],
        evidence: 'User asked to skip tests.',
        rationale: 'Skip verification and mark complete faster.',
        revisedObjective: 'Complete first milestone but skip tests and review.',
      });
      assert.equal(invariant.accepted, false);
      assert.equal(invariant.noEasierCompletion, false);

      const rejected = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'user_prompt_submit',
        targetGoalIds: ['G001-first'],
        evidence: 'User asked to skip tests.',
        rationale: 'Skip verification and mark complete faster.',
        revisedObjective: 'Complete first milestone but skip tests and review.',
      });
      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /weaken completion|quality gates|tests|reviews/);

      const unchanged = await readUltragoalPlan(cwd);
      assert.equal(unchanged.goals[0]?.objective, 'Complete first milestone with tests.');
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
    });
  });

  it('rejects unknown steering mutation kinds before audit acceptance', async () => {
    await withTempRepo(async (cwd) => {
      const plan = await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const proposal = {
        kind: 'make_goal_easier',
        source: 'cli',
        evidence: 'A stale proposal path supplied a non-allowlisted mutation kind.',
        rationale: 'The core validator must fail closed even if the CLI parser is bypassed.',
      } as unknown as Parameters<typeof validateUltragoalSteeringProposal>[1];

      const invariant = validateUltragoalSteeringProposal(plan, proposal);
      assert.equal(invariant.accepted, false);
      assert.match(invariant.rejectedReasons.join('\n'), /Invalid steering mutation kind/);

      const rejected = await steerUltragoal(cwd, proposal);
      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /Invalid steering mutation kind/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
      assert.doesNotMatch(ledger, /"event":"steering_accepted"/);
    });
  });

  it('dedupes steering by ledger idempotency key without duplicating child goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });
      const proposal = {
        kind: 'add_subgoal' as const,
        source: 'user_prompt_submit' as const,
        evidence: 'Prompt-submit requested a bounded regression goal.',
        rationale: 'Add scoped regression work while preserving the end goal.',
        title: 'Add regression',
        objective: 'Add regression coverage with the same verification gates.',
        idempotencyKey: 'same-prompt-signature',
      };

      const first = await steerUltragoal(cwd, proposal);
      const firstPlan = await readUltragoalPlan(cwd);
      const second = await steerUltragoal(cwd, proposal);
      const secondPlan = await readUltragoalPlan(cwd);
      assert.equal(first.accepted, true);
      assert.equal(first.deduped, false);
      assert.equal(second.accepted, true);
      assert.equal(second.deduped, true);
      assert.equal(second.plan.goals.filter((goal) => goal.title === 'Add regression').length, 1);
      assert.deepEqual(secondPlan, firstPlan);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 0);
      assert.equal((ledger.match(/same-prompt-signature/g) ?? []).length, 1);
    });
  });

  it('skips superseded and blocked goals for scheduling while blocked goals prevent completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
          { title: 'Third', objective: 'Complete third milestone with tests.' },
        ],
      });
      await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'External API access is unavailable.',
        rationale: 'Block unschedulable work without claiming completion.',
        blockedReason: 'Waiting on external API access.',
      });
      await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G002-second'],
        evidence: 'Second milestone is better represented as replacement child work.',
        rationale: 'Supersede with a replacement goal that preserves the acceptance criteria.',
        childGoals: [{ title: 'Replacement second', objective: 'Complete replacement second milestone with tests.' }],
      });

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, 'G004-replacement-second');
      const plan = await readUltragoalPlan(cwd);
      assert.equal(isUltragoalDone(plan), false);
      const summary = summarizeUltragoalPlan(plan);
      assert.equal(summary.steeringBlocked, 1);
      assert.equal(summary.superseded, 1);
    });
  });

  it('clears the active goal when mark_blocked_superseded supersedes the running goal', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const started = await startNextUltragoal(cwd);
      assert.equal(started.goal?.id, 'G001-first');

      const result = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'The active goal should be split into narrower replacement work.',
        rationale: 'Supersede the active goal and keep the audit trail durable.',
        childGoals: [
          { title: 'Replacement first part A', objective: 'Complete replacement first part A with tests.' },
          { title: 'Replacement first part B', objective: 'Complete replacement first part B with tests.' },
        ],
      });

      assert.equal(result.accepted, true);
      assert.equal(result.plan.activeGoalId, undefined);
      assert.equal(result.plan.goals.find((goal) => goal.id === 'G001-first')?.steeringStatus, 'superseded');
      assert.deepEqual(
        result.plan.goals.filter((goal) => goal.supersedes?.includes('G001-first')).map((goal) => goal.status),
        ['pending', 'pending'],
      );
      const summary = summarizeUltragoalPlan(result.plan);
      assert.equal(summary.superseded, 1);
      assert.equal(summary.steeringBlocked, 0);
      assert.equal(isUltragoalDone(result.plan), false);
    });
  });

  it('rejects malformed steering invariants and records a single rejection audit', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone with tests.' },
          { title: 'Second', objective: 'Complete second milestone with tests.' },
        ],
      });

      const plan = await readUltragoalPlan(cwd);
      const invariant = validateUltragoalSteeringProposal(plan, {
        kind: 'reorder_pending',
        source: 'user_prompt_submit',
        evidence: 'Order request from prompt submit.',
        rationale: 'Exercise duplicate pending-order validation.',
        pendingOrder: ['G001-first', 'G001-first'],
      });
      assert.equal(invariant.accepted, false);
      assert.equal(invariant.structuralInvariantAccepted, false);
      assert.match(invariant.rejectedReasons.join(' | '), /duplicate goal id/);

      const rejected = await steerUltragoal(cwd, {
        kind: 'reorder_pending',
        source: 'user_prompt_submit',
        evidence: 'Order request from prompt submit.',
        rationale: 'Exercise duplicate pending-order validation.',
        pendingOrder: ['G001-first', 'G001-first'],
      });

      assert.equal(rejected.accepted, false);
      assert.equal(rejected.deduped, false);
      assert.match(rejected.rejectedReasons.join(' | '), /duplicate goal id/);
      assert.deepEqual(await readUltragoalPlan(cwd), plan);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 1);
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 0);
    });
  });

  it('rejects invalid steering source and malformed superseded replacement children with audit evidence', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [{ title: 'First', objective: 'Complete first milestone with tests.' }],
      });

      const invalidSource = await steerUltragoal(cwd, {
        kind: 'annotate_ledger',
        source: 'forged' as never,
        evidence: 'Invalid source must not be accepted.',
        rationale: 'Runtime validation should protect JSON callers.',
      });
      assert.equal(invalidSource.accepted, false);
      assert.match(invalidSource.rejectedReasons.join(' | '), /Invalid steering source/);

      const malformedReplacement = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child is malformed.',
        rationale: 'Malformed children should be rejected and audited instead of throwing.',
        childGoals: [{ title: '', objective: 'Replacement objective.' }],
      });
      assert.equal(malformedReplacement.accepted, false);
      assert.match(malformedReplacement.rejectedReasons.join(' | '), /replacement children require title and objective/);

      const nullReplacement = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child is null.',
        rationale: 'Malformed JSON children should reject without throwing.',
        childGoals: [null] as never,
      });
      assert.equal(nullReplacement.accepted, false);
      assert.match(nullReplacement.rejectedReasons.join(' | '), /replacement children require title and objective/);

      const weakenedSplitChild = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalId: 'G001-first',
        evidence: 'Split child attempted to weaken tests.',
        rationale: 'Replacement objectives must preserve verification.',
        childGoals: [
          { title: 'Shortcut child', objective: 'Skip tests and remove verification for faster completion.' },
        ],
      });
      assert.equal(weakenedSplitChild.accepted, false);
      assert.match(weakenedSplitChild.rejectedReasons.join(' | '), /must not weaken completion/);
      assert.equal(weakenedSplitChild.audit.invariant.noEasierCompletion, false);

      const weakenedSupersedeChild = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-first'],
        evidence: 'Replacement child attempted to weaken review.',
        rationale: 'Replacement objectives must preserve quality gates.',
        childGoals: [
          { title: 'Shortcut replacement', objective: 'Bypass review and omit quality gate evidence.' },
        ],
      });
      assert.equal(weakenedSupersedeChild.accepted, false);
      assert.match(weakenedSupersedeChild.rejectedReasons.join(' | '), /must not weaken completion/);
      assert.equal(weakenedSupersedeChild.audit.invariant.noEasierCompletion, false);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.length, 1);
      assert.equal(plan.goals[0]?.steeringStatus, undefined);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_rejected"/g) ?? []).length, 5);
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 0);
    });
  });

  it('replays the G001-core-steering-model fixture matrix against .omx/ultragoal steering behavior', async () => {
    for (const fixture of steeringFixtures) {
      await withTempRepo(async (cwd) => {
        await writeFixturePlan(cwd, fixture.before as UltragoalPlan);

        const result = await steerUltragoal(cwd, toSteeringProposal(fixture.proposal), {
          now: new Date('2026-05-19T04:20:00.000Z'),
        });

        assert.equal(result.accepted, fixture.expected.accepted, fixture.case);
        assert.equal(result.audit.kind, fixture.expected.mutationKind, fixture.case);
        assert.equal(result.audit.evidence, fixture.proposal.evidence, fixture.case);
        assert.equal(result.audit.rationale, fixture.proposal.rationale, fixture.case);
        assert.equal(result.audit.before !== undefined, true, fixture.case);
        assert.equal(isUltragoalDone(result.plan), fixture.expected.isDoneAfterMutation, fixture.case);

        const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
        assert.match(ledger, new RegExp(`"event":"${fixture.expected.ledgerEvent}"`), fixture.case);
        assert.match(ledger, new RegExp(`"kind":"${fixture.expected.mutationKind}"`), fixture.case);

        if (!fixture.expected.accepted) {
          assert.equal(result.deduped, false, fixture.case);
          assert.equal(result.audit.invariant.noEasierCompletion, false, fixture.case);
          assert.match(result.rejectedReasons.join(' | '), /weaken completion|quality gates|tests|reviews/i, fixture.case);
          assert.ok(fixture.proposal.forbidden?.codexObjective, fixture.case);
          assert.ok(fixture.proposal.forbidden?.aggregateCompletion, fixture.case);
          assert.deepEqual(await readUltragoalPlan(cwd), JSON.parse(JSON.stringify(fixture.before)), fixture.case);
          return;
        }

        const summary = summarizeUltragoalPlan(result.plan);
        if (fixture.expected.summaryDelta?.superseded !== undefined) {
          assert.equal(summary.superseded, fixture.expected.summaryDelta.superseded, fixture.case);
        }
        if (fixture.expected.summaryDelta?.steeringBlocked !== undefined) {
          const beforeBlocked = fixture.before.goals.filter((goal) => goal.steeringStatus === 'blocked').length;
          assert.equal(summary.steeringBlocked, beforeBlocked + fixture.expected.summaryDelta.steeringBlocked, fixture.case);
        }

        if (fixture.case === 'split') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'superseded');
          assert.deepEqual(parent?.supersededBy, ['G004-core-steering-schema', 'G005-core-steering-scheduler-semantics']);
        }
        if (fixture.case === 'blocked-with-replacement') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'superseded');
          assert.deepEqual(parent?.supersededBy, ['G004-core-steering-replacement']);
        }
        if (fixture.case === 'blocked-without-replacement') {
          const parent = result.plan.goals.find((goal) => goal.id === 'G001-core-steering-model');
          assert.equal(parent?.steeringStatus, 'blocked');
          assert.equal(isUltragoalDone(result.plan), false);
        }
        if (fixture.case === 'revise') {
          const revised = result.plan.goals.find((goal) => goal.id === 'G002-cli-bridge');
          assert.equal(revised?.title, fixture.proposal.title);
          assert.equal(revised?.objective, fixture.proposal.objective);
          assert.equal(revised?.status, 'pending');
        }
        if (fixture.case === 'annotate') {
          assert.deepEqual(result.plan.goals, fixture.before.goals, fixture.case);
        }

        const next = await startNextUltragoal(cwd, { now: new Date('2026-05-19T04:21:00.000Z') });
        assert.equal(next.goal?.id, fixture.expected.scheduleStartsGoalId, fixture.case);
        if (fixture.expected.finalCandidateForGoalId) {
          assert.equal(next.goal?.id, fixture.expected.finalCandidateForGoalId, fixture.case);
        }
      });
    }
  });

  it('guides different completed legacy snapshots to blocked checkpoints and available goal contexts', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but wrong Codex snapshot',
          codexGoal: { goal: { objective: 'Completed legacy objective', status: 'complete' } },
        }),
        (error: unknown) => {
          assert.match(String(error), /objective mismatch/);
          assert.match(String(error), /--status blocked/);
          assert.match(String(error), /Codex goal context/);
          assert.doesNotMatch(String(error), /fresh (?:Codex )?(?:thread|session)s?/i);
          return true;
        },
      );
    });
  });

  it('guides unavailable get_goal DB/schema errors to auditable blocked recovery instead of completion', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'complete',
          evidence: 'audit passed but Codex get_goal was unavailable',
          codexGoal: { error: 'SqliteError: no such table: thread_goals' },
          qualityGate: cleanQualityGate(),
        }),
        (error: unknown) => {
          assert.match(String(error), /DB\/schema\/context error/);
          assert.match(String(error), /--status blocked/);
          assert.match(String(error), /unavailable get_goal error JSON or path/);
          assert.match(String(error), /strict completion reconciliation/);
          return true;
        },
      );

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.equal(plan.goals[0]?.completedAt, undefined);
    });
  });

  it('records unavailable get_goal DB/schema errors as non-terminal blocked audit checkpoints', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const plan = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence: 'get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context',
        codexGoal: { error: 'SQLITE_ERROR: no such table: thread_goals' },
      });

      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.match(plan.goals[0]?.failureReason ?? '', /get_goal unavailable/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /no such table: thread_goals/);
      assert.match(ledger, /strict completion reconciliation is deferred/);
    });
  });

  it('records a safe blocker when the aggregate Codex goal is already complete while a microgoal remains in progress', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'aggregate',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
          { title: 'Second', objective: 'Complete second milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      const evidence = 'aggregate Codex goal already complete and unreconcilable while repo-native .omx/ultragoal/goals.json still has an in-progress microgoal; stop the recovery loop';
      const plan = await checkpointUltragoal(cwd, {
        goalId: first.goal!.id,
        status: 'blocked',
        evidence,
        codexGoal: { goal: { objective: ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE, status: 'complete' } },
      });

      assert.equal(plan.goals[0]?.status, 'in_progress');
      assert.equal(plan.activeGoalId, first.goal!.id);
      assert.match(plan.goals[0]?.failureReason ?? '', /aggregate Codex goal already complete/);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"goal_blocked"/);
      assert.match(ledger, /safe-recovery blocker/);
      assert.match(ledger, /impossible checkpoint loop/);
    });
  });

  it('rejects blocked checkpoints for active or same-objective Codex goals', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'brief',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'First', objective: 'Complete first milestone.' },
        ],
      });

      const first = await startNextUltragoal(cwd);
      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'active wrong goal',
          codexGoal: { goal: { objective: 'Different active work', status: 'active' } },
        }),
        /strict objective mismatch protection remains required/,
      );

      await assert.rejects(
        () => checkpointUltragoal(cwd, {
          goalId: first.goal!.id,
          status: 'blocked',
          evidence: 'same complete goal',
          codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
        }),
        /different completed legacy Codex goal/,
      );
    });
  });

  it('steers a split pending goal through superseded lifecycle without weakening completion gates', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model .omx/ultragoal split lifecycle coverage',
        codexGoalMode: 'per_story',
        goals: [{ title: 'Original', objective: 'Implement the original broad steering objective.' }],
      });

      const split = await steerUltragoal(cwd, {
        kind: 'split_subgoal',
        source: 'finding',
        targetGoalIds: ['G001-original'],
        evidence: 'G001-core-steering-model review found .omx/ultragoal needs smaller replacement children.',
        rationale: 'Split preserves the original objective while scheduling verifiable child goals.',
        after: {
          children: [
            { title: 'Child A', objective: 'Implement child A steering support.' },
            { title: 'Child B', objective: 'Implement child B steering support.' },
          ],
        },
        idempotencyKey: 'split-g001-core-steering-model',
        now: new Date('2026-05-19T04:20:00Z'),
      });

      assert.equal(split.accepted, true);
      assert.equal(split.plan.goals[0]?.steeringStatus, 'superseded');
      assert.deepEqual(split.plan.goals[0]?.supersededBy, ['G002-child-a', 'G003-child-b']);
      assert.equal(split.plan.goals.some((goal) => goal.id === 'G001-original'), true);

      const first = await startNextUltragoal(cwd);
      assert.equal(first.goal?.id, 'G002-child-a');
      assert.equal(isUltragoalDone(first.plan), false);

      await checkpointUltragoal(cwd, {
        goalId: 'G002-child-a',
        status: 'complete',
        evidence: 'child A tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: first.goal!.objective, status: 'complete' } },
      });
      const second = await startNextUltragoal(cwd);
      assert.equal(second.goal?.id, 'G003-child-b');
      assert.equal(isFinalRunCompletionCandidate(second.plan, second.goal!), true);

      const done = await checkpointUltragoal(cwd, {
        goalId: 'G003-child-b',
        status: 'complete',
        evidence: 'child B tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: second.goal!.objective, status: 'complete' } },
        qualityGate: cleanQualityGate(),
      });
      assert.equal(isUltragoalDone(done), true);

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_accepted"/);
      assert.match(ledger, /split-g001-core-steering-model/);
    });
  });

  it('skips blocked-without-replacement steering while keeping completion blocked', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model .omx/ultragoal blocked lifecycle coverage',
        codexGoalMode: 'per_story',
        goals: [
          { title: 'Blocked', objective: 'Investigate blocked steering dependency.' },
          { title: 'Next', objective: 'Continue independent steering work.' },
        ],
      });

      const blocked = await steerUltragoal(cwd, {
        kind: 'mark_blocked_superseded',
        source: 'finding',
        targetGoalIds: ['G001-blocked'],
        evidence: 'G001-core-steering-model evidence names .omx/ultragoal blocker without replacement.',
        rationale: 'Avoid retry churn while preserving the unresolved blocker for final completion.',
      });
      assert.equal(blocked.accepted, true);
      assert.equal(blocked.plan.goals[0]?.steeringStatus, 'blocked');

      const next = await startNextUltragoal(cwd);
      assert.equal(next.goal?.id, 'G002-next');
      assert.equal(isFinalRunCompletionCandidate(next.plan, next.goal!), false);

      const afterNext = await checkpointUltragoal(cwd, {
        goalId: 'G002-next',
        status: 'complete',
        evidence: 'independent tests passed for .omx/ultragoal G001-core-steering-model',
        codexGoal: { goal: { objective: next.goal!.objective, status: 'complete' } },
      });
      assert.equal(isUltragoalDone(afterNext), false);

      const none = await startNextUltragoal(cwd);
      assert.equal(none.goal, null);
      assert.equal(none.done, false);
    });
  });

  it('rejects protected steering payloads and records a rejected audit without mutation', async () => {
    await withTempRepo(async (cwd) => {
      const created = await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model protected .omx/ultragoal invariants',
        goals: [{ title: 'First', objective: 'Keep original objective.' }],
      });

      const rejected = await steerUltragoal(cwd, {
        kind: 'revise_pending_wording',
        source: 'cli',
        targetGoalIds: ['G001-first'],
        evidence: 'attempt references .omx/ultragoal G001-core-steering-model',
        rationale: 'malicious protected edit should be rejected',
        after: { objective: 'new wording', codexObjective: 'weakened end goal' } as never,
      });

      assert.equal(rejected.accepted, false);
      assert.match(rejected.rejectedReasons.join('\n'), /protected objective/);
      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.codexObjective, created.codexObjective);
      assert.equal(plan.goals[0]?.objective, 'Keep original objective.');

      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.match(ledger, /"event":"steering_rejected"/);
    });
  });

  it('dedupes accepted steering by idempotency key', async () => {
    await withTempRepo(async (cwd) => {
      await createUltragoalPlan(cwd, {
        brief: 'G001-core-steering-model idempotent .omx/ultragoal audit',
        goals: [{ title: 'First', objective: 'First objective.' }],
      });
      const proposal = {
        kind: 'add_subgoal' as const,
        source: 'user_prompt_submit' as const,
        title: 'Follow-up',
        objective: 'Follow-up objective.',
        evidence: 'prompt-submit evidence for .omx/ultragoal G001-core-steering-model',
        rationale: 'bounded explicit directive requires one follow-up only',
        idempotencyKey: 'same-prompt-submit',
      };

      const first = await steerUltragoal(cwd, proposal);
      const second = await steerUltragoal(cwd, proposal);
      assert.equal(first.accepted, true);
      assert.equal(second.accepted, true);
      assert.equal(second.deduped, true);

      const plan = await readUltragoalPlan(cwd);
      assert.equal(plan.goals.filter((goal) => goal.title === 'Follow-up').length, 1);
      const ledger = await readFile(join(cwd, '.omx/ultragoal/ledger.jsonl'), 'utf-8');
      assert.equal((ledger.match(/"event":"steering_accepted"/g) ?? []).length, 1);
    });
  });

});
