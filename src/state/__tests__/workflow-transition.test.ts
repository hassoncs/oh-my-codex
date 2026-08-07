import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildWorkflowTransitionMessage,
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  findBlockingWorkflowModes,
  readActiveWorkflowModes,
} from '../workflow-transition.js';
import {
  preflightWorkflowTransition,
  reconcileWorkflowTransition,
} from '../workflow-transition-reconcile.js';
import { readModeState, startMode } from '../../modes/base.js';
import { getBaseStateDir } from '../../mcp/state-paths.js';

const STATE_ENV_KEYS = [
  'OMX_ROOT',
  'OMX_STATE_ROOT',
  'OMX_TEAM_STATE_ROOT',
  'OMX_SESSION_ID',
  'CODEX_SESSION_ID',
  'SESSION_ID',
] as const;

async function withIsolatedStateEnv(fn: () => Promise<void>): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const key of STATE_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    await fn();
  } finally {
    for (const key of STATE_ENV_KEYS) {
      const value = previous.get(key);
      if (typeof value === 'string') process.env[key] = value;
      else delete process.env[key];
    }
  }
}

describe('workflow transition rules', () => {
  it('allows the approved overlap matrix and denies unsupported combinations', () => {
    const cases: Array<{
      current: string[];
      requested: 'team' | 'ralph' | 'ultrawork' | 'autopilot' | 'autoresearch' | 'ultragoal' | 'ultraqa';
      allowed: boolean;
      resulting: string[];
    }> = [
      { current: [], requested: 'team', allowed: true, resulting: ['team'] },
      { current: ['team'], requested: 'ralph', allowed: true, resulting: ['team', 'ralph'] },
      { current: ['ralph'], requested: 'team', allowed: true, resulting: ['ralph', 'team'] },
      { current: ['team'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'team', allowed: true, resulting: ['ultrawork', 'team'] },
      { current: ['ralph'], requested: 'ultrawork', allowed: true, resulting: ['ralph', 'ultrawork'] },
      { current: ['ultrawork'], requested: 'ralph', allowed: true, resulting: ['ultrawork', 'ralph'] },
      { current: ['autopilot'], requested: 'team', allowed: true, resulting: ['autopilot', 'team'] },
      { current: ['team'], requested: 'autopilot', allowed: true, resulting: ['team', 'autopilot'] },
      { current: ['ultragoal'], requested: 'team', allowed: true, resulting: ['ultragoal', 'team'] },
      { current: ['team'], requested: 'ultragoal', allowed: true, resulting: ['team', 'ultragoal'] },
      { current: ['autopilot', 'ultragoal'], requested: 'team', allowed: true, resulting: ['autopilot', 'ultragoal', 'team'] },
      { current: ['autoresearch'], requested: 'ralph', allowed: false, resulting: ['autoresearch'] },
      { current: ['autoresearch'], requested: 'team', allowed: false, resulting: ['autoresearch'] },
      { current: ['ultragoal'], requested: 'ralph', allowed: false, resulting: ['ultragoal'] },
      { current: ['team'], requested: 'ultraqa', allowed: false, resulting: ['team'] },
      { current: ['team', 'ralph'], requested: 'ultrawork', allowed: true, resulting: ['team', 'ralph', 'ultrawork'] },
      { current: ['team', 'ultrawork'], requested: 'ralph', allowed: true, resulting: ['team', 'ultrawork', 'ralph'] },
    ];

    for (const testCase of cases) {
      const decision = evaluateWorkflowTransition(testCase.current, testCase.requested);
      assert.equal(decision.allowed, testCase.allowed, `${testCase.current.join(',')} -> ${testCase.requested}`);
      assert.deepEqual(decision.resultingModes, testCase.resulting, `${testCase.current.join(',')} -> ${testCase.requested}`);
    }
  });

  it('allows autopilot + team with or without the nested-team caller option', () => {
    const standalone = evaluateWorkflowTransition(['autopilot'], 'team');
    const nested = evaluateWorkflowTransition(
      ['autopilot'],
      'team',
      { allowNestedAutopilotTeam: true },
    );

    for (const decision of [standalone, nested]) {
      assert.equal(decision.allowed, true);
      assert.equal(decision.kind, 'overlap');
      assert.deepEqual(decision.resultingModes, ['autopilot', 'team']);
    }
  });

  it('derives autopilot coexistence from its declared child phases', () => {
    for (const child of ['deep-interview', 'ralplan', 'ultragoal', 'team', 'ralph', 'ultraqa'] as const) {
      const decision = evaluateWorkflowTransition(['autopilot'], child);
      assert.equal(decision.allowed, true, `autopilot + ${child}`);
      assert.equal(decision.kind, 'overlap', `autopilot + ${child}`);
      assert.deepEqual(decision.resultingModes, ['autopilot', child], `autopilot + ${child}`);
    }
    // autoresearch is not an autopilot child phase and stays standalone.
    assert.equal(evaluateWorkflowTransition(['autopilot'], 'autoresearch').allowed, false);
  });

  it('hosts a team inside an active ultragoal story in either activation order', () => {
    const teamUnderStory = evaluateWorkflowTransition(['ultragoal'], 'team');
    const storyAroundTeam = evaluateWorkflowTransition(['team'], 'ultragoal');

    assert.equal(teamUnderStory.kind, 'overlap');
    assert.deepEqual(teamUnderStory.resultingModes, ['ultragoal', 'team']);
    assert.equal(storyAroundTeam.kind, 'overlap');
    assert.deepEqual(storyAroundTeam.resultingModes, ['team', 'ultragoal']);
  });

  it('reports the modes that actually block a denied transition', () => {
    assert.deepEqual(findBlockingWorkflowModes(['autoresearch'], 'team'), ['autoresearch']);
    // ralplan auto-completes into team, so it never blocks it.
    assert.deepEqual(findBlockingWorkflowModes(['ralplan'], 'team'), []);
    // ultragoal hosts team, so it never blocks it either.
    assert.deepEqual(findBlockingWorkflowModes(['ultragoal'], 'team'), []);
    assert.deepEqual(findBlockingWorkflowModes(['team', 'ultragoal'], 'ralplan'), ['team', 'ultragoal']);
  });

  it('builds actionable denial guidance that names the blocking mode by name', () => {
    const error = buildWorkflowTransitionError(['autoresearch'], 'team', 'start');
    assert.match(error, /Cannot start team: autoresearch is already active\./);
    assert.match(error, /Unsupported workflow overlap: autoresearch \+ team\./);
    assert.match(error, /Current state is unchanged\./);
    assert.match(error, /`omx state clear --input '{"mode":"autoresearch"}' --json`/);
    assert.match(error, /explicit MCP compatibility is enabled/);
    // The unactionable placeholder form must never reach a caller that has a
    // known blocking mode.
    assert.doesNotMatch(error, /"mode":"<mode>"/);
  });

  it('names every blocking mode when several are active', () => {
    const error = buildWorkflowTransitionError(['team', 'ultragoal'], 'ralplan', 'start');
    assert.match(error, /`omx state clear --input '{"mode":"team"}' --json`/);
    assert.match(error, /`omx state clear --input '{"mode":"ultragoal"}' --json`/);
    assert.doesNotMatch(error, /"mode":"<mode>"/);
  });

  it('returns auto-complete decisions for allowlisted forward transitions', () => {
    const interviewToRalplan = evaluateWorkflowTransition(['deep-interview'], 'ralplan');
    assert.equal(interviewToRalplan.allowed, true);
    assert.equal(interviewToRalplan.kind, 'auto-complete');
    assert.deepEqual(interviewToRalplan.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToRalplan.resultingModes, ['ralplan']);
    assert.equal(interviewToRalplan.transitionMessage, 'mode transiting: deep-interview -> ralplan');

    const interviewToAutoresearch = evaluateWorkflowTransition(['deep-interview'], 'autoresearch');
    assert.equal(interviewToAutoresearch.allowed, true);
    assert.equal(interviewToAutoresearch.kind, 'auto-complete');
    assert.deepEqual(interviewToAutoresearch.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToAutoresearch.resultingModes, ['autoresearch']);
    assert.equal(interviewToAutoresearch.transitionMessage, 'mode transiting: deep-interview -> autoresearch');

    const interviewToUltragoal = evaluateWorkflowTransition(['deep-interview'], 'ultragoal');
    assert.equal(interviewToUltragoal.allowed, true);
    assert.equal(interviewToUltragoal.kind, 'auto-complete');
    assert.deepEqual(interviewToUltragoal.autoCompleteModes, ['deep-interview']);
    assert.deepEqual(interviewToUltragoal.resultingModes, ['ultragoal']);
    assert.equal(interviewToUltragoal.transitionMessage, 'mode transiting: deep-interview -> ultragoal');

    const ralplanToRalph = evaluateWorkflowTransition(['ralplan', 'ultrawork'], 'ralph');
    assert.equal(ralplanToRalph.allowed, true);
    assert.equal(ralplanToRalph.kind, 'auto-complete');
    assert.deepEqual(ralplanToRalph.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToRalph.resultingModes, ['ultrawork', 'ralph']);

    const ralplanToUltragoal = evaluateWorkflowTransition(['ralplan'], 'ultragoal');
    assert.equal(ralplanToUltragoal.allowed, true);
    assert.equal(ralplanToUltragoal.kind, 'auto-complete');
    assert.deepEqual(ralplanToUltragoal.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToUltragoal.resultingModes, ['ultragoal']);
    assert.equal(ralplanToUltragoal.transitionMessage, 'mode transiting: ralplan -> ultragoal');

    const ralplanToAutoresearch = evaluateWorkflowTransition(['ralplan'], 'autoresearch');
    assert.equal(ralplanToAutoresearch.allowed, true);
    assert.equal(ralplanToAutoresearch.kind, 'auto-complete');
    assert.deepEqual(ralplanToAutoresearch.autoCompleteModes, ['ralplan']);
    assert.deepEqual(ralplanToAutoresearch.resultingModes, ['autoresearch']);
  });

  it('builds rollback denial guidance for execution-to-planning transitions', () => {
    const error = buildWorkflowTransitionError(['ralph'], 'ralplan', 'start');
    assert.match(error, /ralplan is a planning workflow and cannot roll back over active execution work \(ralph\)\./);
    assert.match(error, /`omx state clear --input '{"mode":"ralph"}' --json`/);
    assert.doesNotMatch(error, /"mode":"<mode>"/);
  });


  it('does not auto-complete Autopilot when starting ralplan as a child-stage name', () => {
    const decision = evaluateWorkflowTransition(['autopilot'], 'ralplan');
    assert.equal(decision.allowed, true);
    assert.equal(decision.kind, 'overlap');
    assert.equal(decision.denialReason, undefined);
    assert.deepEqual(decision.autoCompleteModes, []);
    assert.deepEqual(decision.resultingModes, ['autopilot', 'ralplan']);
  });

  it('formats transition audit messages', () => {
    assert.equal(
      buildWorkflowTransitionMessage('ralplan', 'ralph'),
      'mode transiting: ralplan -> ralph',
    );
  });

  it('ignores stale root workflow state for session-scoped active decisions', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-active-scope-'));
      try {
        const stateDir = join(await realpath(wd), '.omx', 'state');
        const sessionDir = join(stateDir, 'sessions', 'sess-current');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(stateDir, 'ralph-state.json'),
          JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
          'utf-8',
        );
        await writeFile(
          join(stateDir, 'session.json'),
          JSON.stringify({ session_id: 'sess-current', cwd: wd }, null, 2),
          'utf-8',
        );

        assert.deepEqual(await readActiveWorkflowModes(wd, 'sess-current'), []);
        assert.deepEqual(await readActiveWorkflowModes(wd), []);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('does not auto-complete stale root workflow state during a session transition', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-scope-'));
      try {
        const stateDir = join(wd, '.omx', 'state');
        const sessionDir = join(stateDir, 'sessions', 'sess-current');
        const rootRalphPath = join(stateDir, 'ralph-state.json');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          rootRalphPath,
          JSON.stringify({ active: true, mode: 'ralph', current_phase: 'executing' }, null, 2),
          'utf-8',
        );

        const transition = await reconcileWorkflowTransition(wd, 'ralplan', {
          action: 'start',
          sessionId: 'sess-current',
          source: 'test',
        });

        assert.equal(transition.decision.allowed, true);
        assert.deepEqual(transition.decision.currentModes, []);
        assert.deepEqual(transition.completedPaths, []);

        const rootRalph = JSON.parse(await readFile(rootRalphPath, 'utf-8')) as { active?: unknown };
        assert.equal(rootRalph.active, true);
        assert.equal(existsSync(join(sessionDir, 'ralph-state.json')), false);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('derives active session modes from authoritative detail when canonical skill state is absent', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-detail-only-'));
      try {
        const sessionId = 'sess-detail-only';
        const sessionDir = join(wd, '.omx', 'state', 'sessions', sessionId);
        const ralplanPath = join(sessionDir, 'ralplan-state.json');
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          ralplanPath,
          JSON.stringify({ active: true, mode: 'ralplan', current_phase: 'review' }, null, 2),
          'utf-8',
        );

        const transition = await reconcileWorkflowTransition(wd, 'team', {
          action: 'start',
          sessionId,
          source: 'test',
        });

        assert.equal(transition.decision.allowed, true);
        assert.deepEqual(transition.decision.currentModes, ['ralplan']);
        assert.deepEqual(transition.completedPaths, [ralplanPath]);

        const ralplan = JSON.parse(await readFile(ralplanPath, 'utf-8')) as { active?: unknown };
        assert.equal(ralplan.active, false);
        const projection = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active?: unknown };
        assert.equal(projection.active, false);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('restores a missing root projection mirror from authoritative session state', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-session-mirror-'));
      try {
        const sessionId = 'sess-mirror';
        const stateDir = join(wd, '.omx', 'state');
        const sessionDir = join(stateDir, 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultragoal' }, null, 2),
        );
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            version: 1,
            active: true,
            skill: 'autopilot',
            phase: 'ultragoal',
            session_id: sessionId,
            active_skills: [{
              skill: 'autopilot',
              phase: 'ultragoal',
              active: true,
              session_id: sessionId,
            }],
          }, null, 2),
        );

        const preflight = await preflightWorkflowTransition(wd, 'autopilot', {
          action: 'start',
          sessionId,
        });

        assert.deepEqual(preflight.currentModes, ['autopilot']);
        const rootProjection = JSON.parse(
          await readFile(join(stateDir, 'skill-active-state.json'), 'utf-8'),
        ) as { active_skills?: Array<{ skill?: unknown; session_id?: unknown }> };
        assert.deepEqual(
          rootProjection.active_skills?.map((entry) => ({
            skill: entry.skill,
            session_id: entry.session_id,
          })),
          [{ skill: 'autopilot', session_id: sessionId }],
        );
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('repairs a session projection carrying a foreign session id', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-foreign-session-'));
      try {
        const sessionId = 'sess-current';
        const foreignSessionId = 'sess-foreign';
        const stateDir = join(wd, '.omx', 'state');
        const sessionDir = join(stateDir, 'sessions', sessionId);
        const projection = (projectionSessionId: string) => ({
          version: 1,
          active: true,
          skill: 'autopilot',
          phase: 'ultragoal',
          session_id: projectionSessionId,
          active_skills: [{
            skill: 'autopilot',
            phase: 'ultragoal',
            active: true,
            session_id: projectionSessionId,
          }],
        });
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'autopilot-state.json'),
          JSON.stringify({ active: true, mode: 'autopilot', current_phase: 'ultragoal' }, null, 2),
        );
        await writeFile(
          join(stateDir, 'skill-active-state.json'),
          JSON.stringify(projection(sessionId), null, 2),
        );
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify(projection(foreignSessionId), null, 2),
        );

        const preflight = await preflightWorkflowTransition(wd, 'autopilot', {
          action: 'start',
          sessionId,
        });

        assert.deepEqual(preflight.currentModes, ['autopilot']);
        const sessionProjection = JSON.parse(
          await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8'),
        ) as {
          session_id?: unknown;
          active_skills?: Array<{ session_id?: unknown }>;
        };
        assert.equal(sessionProjection.session_id, sessionId);
        assert.deepEqual(
          sessionProjection.active_skills?.map((entry) => entry.session_id),
          [sessionId],
        );
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('co-locates auto-completed mode detail and canonical skill state under an explicit base state dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-base-dir-'));
    try {
      const wd = join(root, 'source');
      const baseStateDir = join(root, 'boxed-state');
      const sessionId = 'sess-transition-base-dir';
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(
        join(sessionDir, 'deep-interview-state.json'),
        JSON.stringify({
          active: true,
          mode: 'deep-interview',
          current_phase: 'interviewing',
          deep_interview_gate: {
            status: 'complete',
            rationale: 'Requirements have been clarified and handed to ralplan.',
          },
          input_lock: {
            active: true,
            owner: 'handoff-question',
          },
          approval_lock: {
            status: 'pending',
            reviewer: 'user',
          },
        }, null, 2),
        'utf-8',
      );
      await writeFile(
        join(sessionDir, 'skill-active-state.json'),
        JSON.stringify({
          version: 1,
          active: true,
          skill: 'deep-interview',
          phase: 'interviewing',
          active_skills: [
            {
              skill: 'deep-interview',
              phase: 'interviewing',
              active: true,
              session_id: sessionId,
            },
          ],
        }, null, 2),
        'utf-8',
      );

      const transition = await reconcileWorkflowTransition(wd, 'ralplan', {
        action: 'start',
        sessionId,
        source: 'test',
        baseStateDir,
      });

      const boxedModePath = join(sessionDir, 'deep-interview-state.json');
      assert.equal(transition.decision.allowed, true);
      assert.deepEqual(transition.completedPaths, [boxedModePath]);

      const boxedMode = JSON.parse(await readFile(boxedModePath, 'utf-8')) as Record<string, unknown>;
      assert.equal(boxedMode.active, false);
      assert.equal(boxedMode.current_phase, 'completed');
      const boxedInputLock = boxedMode.input_lock as Record<string, unknown>;
      const boxedApprovalLock = boxedMode.approval_lock as Record<string, unknown>;
      assert.equal(boxedInputLock.active, false);
      assert.equal(boxedInputLock.status, 'released');
      assert.equal(boxedApprovalLock.active, false);
      assert.equal(boxedApprovalLock.status, 'released');

      const boxedSkill = JSON.parse(await readFile(join(sessionDir, 'skill-active-state.json'), 'utf-8')) as Record<string, unknown>;
      assert.equal(boxedSkill.active, false);

      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', sessionId, 'deep-interview-state.json')), false);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'sessions', sessionId, 'skill-active-state.json')), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('denies deep-interview to ralplan reconciliation when only handoff-cleared question evidence exists', async () => {
    await withIsolatedStateEnv(async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-workflow-reconcile-ralplan-gate-deny-'));
      try {
        const wd = join(root, 'source');
        const baseStateDir = join(root, 'boxed-state');
        const sessionId = 'sess-transition-gate-deny';
        const sessionDir = join(baseStateDir, 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(
          join(sessionDir, 'deep-interview-state.json'),
          JSON.stringify({
            active: true,
            mode: 'deep-interview',
            current_phase: 'interviewing',
            question_enforcement: {
              obligation_id: 'obligation-cleared',
              source: 'omx-question',
              status: 'cleared',
              lifecycle_outcome: 'askuserQuestion',
              requested_at: '2026-05-28T00:00:00.000Z',
              cleared_at: '2026-05-28T00:01:00.000Z',
              clear_reason: 'handoff',
            },
          }, null, 2),
          'utf-8',
        );
        await writeFile(
          join(sessionDir, 'skill-active-state.json'),
          JSON.stringify({
            version: 1,
            active: true,
            skill: 'deep-interview',
            phase: 'interviewing',
            active_skills: [
              {
                skill: 'deep-interview',
                phase: 'interviewing',
                active: true,
                session_id: sessionId,
              },
            ],
          }, null, 2),
          'utf-8',
        );

        await assert.rejects(
          reconcileWorkflowTransition(wd, 'ralplan', {
            action: 'start',
            sessionId,
            source: 'test',
            baseStateDir,
          }),
          /cleared deep-interview question obligations with handoff\/error are not completion evidence/i,
        );

        const boxedMode = JSON.parse(await readFile(join(sessionDir, 'deep-interview-state.json'), 'utf-8')) as Record<string, unknown>;
        assert.equal(boxedMode.active, true);
        assert.equal(boxedMode.current_phase, 'interviewing');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('binds dry-run transitions to action, cwd, session, and state root', async () => {
    await withIsolatedStateEnv(async () => {
      const root = await mkdtemp(join(tmpdir(), 'omx-workflow-preflight-binding-'));
      try {
        const wd = join(root, 'source');
        const otherWd = join(root, 'other-source');
        const baseStateDir = join(root, 'state');
        const otherStateDir = join(root, 'other-state');
        await mkdir(wd, { recursive: true });
        await mkdir(otherWd, { recursive: true });
        const preflight = await preflightWorkflowTransition(wd, 'team', {
          action: 'start',
          baseStateDir,
          currentModes: [],
        });

        await assert.rejects(
          reconcileWorkflowTransition(wd, 'team', {
            action: 'activate',
            baseStateDir,
            preflight,
          }),
          /workflow_transition_preflight_action_mismatch/,
        );
        await assert.rejects(
          reconcileWorkflowTransition(otherWd, 'team', {
            action: 'start',
            baseStateDir,
            preflight,
          }),
          /workflow_transition_preflight_cwd_mismatch/,
        );
        await assert.rejects(
          reconcileWorkflowTransition(wd, 'team', {
            action: 'start',
            sessionId: 'other-session',
            baseStateDir,
            preflight,
          }),
          /workflow_transition_preflight_session_mismatch/,
        );
        await assert.rejects(
          reconcileWorkflowTransition(wd, 'team', {
            action: 'start',
            baseStateDir: otherStateDir,
            preflight,
          }),
          /workflow_transition_preflight_state_root_mismatch/,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  it('rejects a stale preflight before writing requested workflow state', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-preflight-drift-'));
      try {
        const preflight = await preflightWorkflowTransition(wd, 'team', {
          action: 'start',
          baseStateDir: getBaseStateDir(wd),
        });
        await startMode('autopilot', 'concurrent parent', 5, wd);

        const stateDir = join(wd, '.omx', 'state');
        const canonicalPath = join(stateDir, 'skill-active-state.json');
        const runStatePath = join(stateDir, 'run-state.json');
        const canonicalBefore = await readFile(canonicalPath, 'utf-8');
        const runStateBefore = await readFile(runStatePath, 'utf-8');

        await assert.rejects(
          () => startMode('team', 'stale preflight team', 5, wd, {
            allowNestedAutopilotTeam: preflight.currentModes.includes('autopilot'),
            preflightTransition: preflight,
          }),
          /workflow_transition_preflight_state_drift/,
        );

        assert.equal(await readModeState('team', wd), null);
        assert.equal(await readFile(canonicalPath, 'utf-8'), canonicalBefore);
        assert.equal(await readFile(runStatePath, 'utf-8'), runStateBefore);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('restores exact mode, canonical, and run-state bytes when startMode canonical sync fails', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-workflow-start-rollback-'));
      try {
        const stateDir = join(await realpath(wd), '.omx', 'state');
        const sessionId = 'sess-start-rollback';
        const sessionDir = join(stateDir, 'sessions', sessionId);
        await mkdir(sessionDir, { recursive: true });
        await writeFile(join(stateDir, 'session.json'), JSON.stringify({ session_id: sessionId }, null, 2));
        const priorFiles = new Map<string, string>([
          [join(sessionDir, 'team-state.json'), '{"active":false,"mode":"team","current_phase":"old"}'],
          [join(sessionDir, 'run-state.json'), '{"version":1,"mode":"old","active":false,"outcome":"finish","updated_at":"old"}'],
          [join(stateDir, 'skill-active-state.json'), '{"version":1,"active":false,"skill":"old","active_skills":[]}'],
          [join(sessionDir, 'skill-active-state.json'), '{"version":1,"active":false,"skill":"old-session","active_skills":[]}'],
        ]);
        for (const [path, content] of priorFiles) {
          await writeFile(path, content);
        }
        const sessionCanonicalPath = join(sessionDir, 'skill-active-state.json');
        await assert.rejects(
          () => startMode('team', 'must roll back', 5, wd, {
            writeSkillActiveFile: (async (path: unknown, data: unknown, options?: unknown) => {
              if (String(path) === sessionCanonicalPath) {
                throw Object.assign(new Error('simulated canonical EIO'), { code: 'EIO' });
              }
              await writeFile(String(path), data as string, options as BufferEncoding);
            }) as typeof writeFile,
          }),
          /simulated canonical EIO/,
        );

        for (const [path, content] of priorFiles) {
          assert.equal(await readFile(path, 'utf-8'), content);
        }
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

});
