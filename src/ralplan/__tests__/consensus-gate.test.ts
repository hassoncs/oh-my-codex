import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getBaseStateDir } from '../../state/paths.js';
import { subagentTrackingPath } from '../../subagents/tracker.js';
import { buildRalplanConsensusGateForCwd, buildRalplanConsensusGateFromSources } from '../consensus-gate.js';

describe('ralplan consensus gate state roots', () => {

  it('rejects invalid complete consensus even when it appears after a valid source', () => {
    const validConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:00:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:05:00.000Z',
        },
      },
    };
    const invalidConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'iterate',
          completed_at: '2026-06-12T10:10:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:15:00.000Z',
        },
      },
    };

    const gate = buildRalplanConsensusGateFromSources([
      { source: 'older-valid-source', value: validConsensus },
      { source: 'later-invalid-source', value: invalidConsensus },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'later-invalid-source');
    assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(gate.blockedDetails?.join(' ') ?? '', /architect.*verdict=iterate/i);
  });


  it('rejects malformed complete consensus even when it appears after a valid source', () => {
    const validConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['architect-review', 'critic-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:00:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:05:00.000Z',
        },
      },
    };
    const malformedConsensus = {
      ralplan_consensus_gate: {
        complete: true,
        sequence: ['critic-review', 'architect-review'],
        ralplan_architect_review: {
          agent_role: 'architect',
          verdict: 'approve',
          completed_at: '2026-06-12T10:10:00.000Z',
        },
        ralplan_critic_review: {
          agent_role: 'critic',
          verdict: 'approve',
          completed_at: '2026-06-12T10:15:00.000Z',
        },
      },
    };

    const gate = buildRalplanConsensusGateFromSources([
      { source: 'older-valid-source', value: validConsensus },
      { source: 'later-malformed-source', value: malformedConsensus },
    ]);

    assert.equal(gate.complete, false);
    assert.equal(gate.source, 'later-malformed-source');
    assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
    assert.match(gate.blockedDetails?.join(' ') ?? '', /sequence is not architect-review then critic-review/i);
  });

  it('rejects approvals without observable Architect-before-Critic order', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'orderless-consensus',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      },
    }]);

    assert.equal(gate.complete, false);
    assert.match(gate.blockedDetails?.join(' ') ?? '', /parseable sequential order evidence/i);
  });

  it('rejects equal Architect and Critic order evidence', () => {
    const gate = buildRalplanConsensusGateFromSources([{
      source: 'equal-order-consensus',
      value: {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-12T10:00:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-12T10:00:00.000Z',
          },
        },
      },
    }]);

    assert.equal(gate.complete, false);
    assert.match(gate.blockedDetails?.join(' ') ?? '', /lacks strict order/i);
  });

  it('lets fresh ordered direct consensus displace stale no-order invalid direct consensus', () => {
    const gate = buildRalplanConsensusGateFromSources([
      {
        source: 'stale-invalid-no-order',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'iterate',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
            },
          },
        },
      },
      {
        source: 'fresh-valid-with-order',
        value: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      },
    ]);

    assert.equal(gate.complete, true);
    assert.equal(gate.source, 'fresh-valid-with-order');
    assert.equal(gate.blockedReason, null);
  });

  it('ignores ambient root consensus unless the ambient session is bound to this cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-'));
    const ambientRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-ambient-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    try {
      process.env.OMX_ROOT = ambientRoot;
      delete process.env.OMX_STATE_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      const ambientStateDir = getBaseStateDir(cwd);
      await mkdir(ambientStateDir, { recursive: true });
      await writeFile(join(ambientStateDir, 'ralplan-state.json'), JSON.stringify({
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: { agent_role: 'architect', verdict: 'approve' },
          ralplan_critic_review: { agent_role: 'critic', verdict: 'approve' },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd);

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(ambientRoot, { recursive: true, force: true });
    }
  });

  it('reads tracker-backed consensus evidence from OMX_STATE_ROOT instead of cwd/.omx/state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-cwd-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-state-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-boxed-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const baseStateDir = getBaseStateDir(cwd);
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(baseStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      await writeFile(subagentTrackingPath(cwd), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-11T16:30:00.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'leader',
                first_seen_at: '2026-06-11T16:29:00.000Z',
                last_seen_at: '2026-06-11T16:29:00.000Z',
                turn_count: 1,
              },
              'thread-architect': {
                thread_id: 'thread-architect',
                kind: 'subagent',
                role: 'architect',
                thread_source: 'subagent',
                parent_thread_id: 'thread-leader',
                depth: 1,
                first_seen_at: '2026-06-11T16:29:30.000Z',
                last_seen_at: '2026-06-11T16:29:30.000Z',
                completed_at: '2026-06-11T16:29:30.000Z',
                last_completed_turn_id: 'turn-architect-1',
                turn_count: 1,
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                role: 'critic',
                thread_source: 'subagent',
                parent_thread_id: 'thread-leader',
                depth: 1,
                first_seen_at: '2026-06-11T16:30:00.000Z',
                last_seen_at: '2026-06-11T16:30:00.000Z',
                completed_at: '2026-06-11T16:30:00.000Z',
                last_completed_turn_id: 'turn-critic-1',
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));
      await writeFile(join(sessionDir, 'autopilot-state.json'), JSON.stringify({
        current_phase: 'ralplan',
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
              completed_turn_id: 'turn-architect-1',
              artifact_path: '.omx/plans/architect.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-11T16:29:30.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              completed_turn_id: 'turn-critic-1',
              artifact_path: '.omx/plans/critic.md',
              tracker_path: '.omx/state/subagent-tracking.json',
              completed_at: '2026-06-11T16:30:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
      assert.match(String(gate.source), new RegExp(`${boxedRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

      const trackerPath = subagentTrackingPath(cwd);
      const unverifiedTracker = JSON.parse(await readFile(trackerPath, 'utf-8'));
      delete unverifiedTracker.sessions[sessionId].threads['thread-architect'].depth;
      await writeFile(trackerPath, JSON.stringify(unverifiedTracker, null, 2));
      const unverifiedGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(unverifiedGate.complete, false);
      assert.match(unverifiedGate.blockedDetails?.join(' ') ?? '', /architect.*verified native lineage/i);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('ranks tracker-invalid native evidence by freshness before older valid evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-lag-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-runtime-lag-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const runtimeStateDir = getBaseStateDir(cwd);
      const runtimeSessionDir = join(runtimeStateDir, 'sessions', sessionId);
      const workspaceStateDir = join(cwd, '.omx', 'state');
      const workspaceSessionDir = join(workspaceStateDir, 'sessions', sessionId);
      await mkdir(runtimeSessionDir, { recursive: true });
      await mkdir(workspaceSessionDir, { recursive: true });
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      const laggingTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:31:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:29:30.000Z', last_seen_at: '2026-07-07T04:29:30.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:30:30.000Z', last_seen_at: '2026-07-07T04:30:30.000Z', turn_count: 1 },
            },
          },
        },
      };
      const completedTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:33:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-parent': { thread_id: 'thread-parent', kind: 'subagent', thread_source: 'subagent', parent_thread_id: 'thread-leader', depth: 1, first_seen_at: '2026-07-07T04:29:30.000Z', last_seen_at: '2026-07-07T04:29:30.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', role: 'architect', thread_source: 'subagent', parent_thread_id: 'thread-leader', depth: 1, first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', completed_at: '2026-07-07T04:30:00.000Z', last_completed_turn_id: 'turn-architect-cycle-2', completion_source: 'notify-fallback-watcher', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', role: 'critic', thread_source: 'subagent', parent_thread_id: 'thread-leader', depth: 1, first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', completed_at: '2026-07-07T04:31:00.000Z', last_completed_turn_id: 'turn-critic-cycle-2', completion_source: 'notify-fallback-watcher', turn_count: 1 },
            },
          },
        },
      };
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(laggingTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(runtimeSessionDir, 'ralplan-state.json'), JSON.stringify({
        active: false,
        current_phase: 'complete',
        planning_complete: true,
        latest_plan_path: '.omx/plans/prd-clickstack-otel-consumer-20260707T043000Z.md',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-architect',
            completed_turn_id: 'turn-architect-cycle-2',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:30:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-critic',
            completed_turn_id: 'turn-critic-cycle-2',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:31:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);

      completedTracker.sessions[sessionId].threads['thread-architect'].last_completed_turn_id = 'turn-architect-cycle-1';
      completedTracker.sessions[sessionId].threads['thread-critic'].last_completed_turn_id = 'turn-critic-cycle-1';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const olderValid = {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            review_cycle: 1,
            session_id: sessionId,
            thread_id: 'thread-architect',
            completed_turn_id: 'turn-architect-cycle-1',
            completed_at: '2026-07-07T04:30:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            review_cycle: 1,
            session_id: sessionId,
            thread_id: 'thread-critic',
            completed_turn_id: 'turn-critic-cycle-1',
            completed_at: '2026-07-07T04:31:00.000Z',
          },
        },
      };
      const newerInvalid = {
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            review_cycle: 2,
            session_id: sessionId,
            thread_id: 'thread-architect',
            completed_turn_id: 'turn-architect-cycle-2',
            completed_at: '2026-07-07T04:32:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            review_cycle: 2,
            session_id: sessionId,
            thread_id: 'thread-critic',
            completed_turn_id: 'turn-critic-cycle-2',
            completed_at: '2026-07-07T04:33:00.000Z',
          },
        },
      };
      const newerInvalidGate = buildRalplanConsensusGateFromSources([
        { source: 'older-tracker-valid', value: olderValid },
        { source: 'newer-tracker-invalid', value: newerInvalid },
      ], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(newerInvalidGate.complete, false);
      assert.equal(newerInvalidGate.source, 'newer-tracker-invalid');
      assert.match(newerInvalidGate.blockedDetails?.join(' ') ?? '', /completed_turn_id=turn-architect-cycle-2 does not match tracker last_completed_turn_id=turn-architect-cycle-1/);

      completedTracker.sessions[sessionId].threads['thread-architect'].last_completed_turn_id = 'turn-architect-cycle-2';
      completedTracker.sessions[sessionId].threads['thread-critic'].last_completed_turn_id = 'turn-critic-cycle-2';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const newerValidGate = buildRalplanConsensusGateFromSources([
        { source: 'older-tracker-valid', value: olderValid },
        { source: 'newer-tracker-valid', value: newerInvalid },
      ], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(newerValidGate.complete, true);
      assert.equal(newerValidGate.source, 'newer-tracker-valid');

      completedTracker.sessions[sessionId].threads['thread-architect'].last_completed_turn_id = 'turn-architect-cycle-1';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const staleCompletionGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(staleCompletionGate.complete, false);
      assert.match(staleCompletionGate.blockedDetails?.join(' ') ?? '', /completed_turn_id=turn-architect-cycle-2 does not match tracker last_completed_turn_id=turn-architect-cycle-1/);

      completedTracker.sessions[sessionId].threads['thread-architect'].last_completed_turn_id = 'turn-architect-cycle-2';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));

      completedTracker.sessions[sessionId].threads['thread-architect'].role = 'critic';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const wrongRoleGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(wrongRoleGate.complete, false);
      assert.match(wrongRoleGate.blockedDetails?.join(' ') ?? '', /architect.*role=critic/);

      completedTracker.sessions[sessionId].threads['thread-architect'].role = 'architect';
      completedTracker.sessions[sessionId].threads['thread-architect'].parent_thread_id = 'foreign-leader';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const wrongParentGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(wrongParentGate.complete, false);
      assert.match(wrongParentGate.blockedDetails?.join(' ') ?? '', /architect.*lacks verified native lineage/);

      completedTracker.sessions[sessionId].threads['thread-architect'].parent_thread_id = 'thread-leader';
      completedTracker.sessions[sessionId].threads['thread-architect'].parent_thread_id = 'thread-parent';
      completedTracker.sessions[sessionId].threads['thread-architect'].depth = 2;
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const nestedParentGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(nestedParentGate.complete, true);

      completedTracker.sessions[sessionId].threads['thread-parent'].thread_source = '';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const untrustedNestedParentGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(untrustedNestedParentGate.complete, false);
      assert.match(untrustedNestedParentGate.blockedDetails?.join(' ') ?? '', /architect.*lacks verified native lineage/);

      completedTracker.sessions[sessionId].threads['thread-parent'].thread_source = 'subagent';
      completedTracker.sessions[sessionId].threads['thread-architect'].parent_thread_id = 'thread-leader';
      completedTracker.sessions[sessionId].threads['thread-architect'].depth = 1;
      completedTracker.sessions[sessionId].threads['thread-architect'].completed_at = '2026-07-07T04:32:00.000Z';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const reversedTrackerOrderGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(reversedTrackerOrderGate.complete, false);
      assert.match(reversedTrackerOrderGate.blockedDetails?.join(' ') ?? '', /critic tracker thread did not complete strictly after architect/i);

      completedTracker.sessions[sessionId].threads['thread-architect'].completed_at = '2026-07-07T04:31:00.000Z';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      const equalTrackerOrderGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(equalTrackerOrderGate.complete, false);
      assert.match(equalTrackerOrderGate.blockedDetails?.join(' ') ?? '', /critic tracker thread did not complete strictly after architect/i);

      completedTracker.sessions[sessionId].threads['thread-architect'].completed_at = '2026-07-07T04:30:00.000Z';
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(completedTracker, null, 2));
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'current-native-leader',
        cwd,
      }, null, 2));
      const staleLeaderGate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(staleLeaderGate.complete, false);
      assert.match(staleLeaderGate.blockedDetails?.join(' ') ?? '', /tracker leader thread-leader does not match current native leader current-native-leader/);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('selects the freshest parseable tracker replica before matching completion identity', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-replica-cwd-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-replica-runtime-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-replica-freshness';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const runtimeStateDir = getBaseStateDir(cwd);
      const runtimeTrackerPath = subagentTrackingPath(cwd);
      const workspaceStateDir = join(cwd, '.omx', 'state');
      const workspaceTrackerPath = join(workspaceStateDir, 'subagent-tracking.json');
      await mkdir(runtimeStateDir, { recursive: true });
      await mkdir(workspaceStateDir, { recursive: true });
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));

      function tracker(
        architectTurnId: string,
        criticTurnId: string,
        architectCompletedAt: string,
        criticCompletedAt: string,
        inProgress = false,
        currentTurnIds?: { architect: string; critic: string },
      ): Record<string, unknown> {
        return {
          schemaVersion: 1,
          sessions: {
            [sessionId]: {
              session_id: sessionId,
              leader_thread_id: 'thread-leader',
              updated_at: criticCompletedAt,
              threads: {
                'thread-leader': {
                  thread_id: 'thread-leader',
                  kind: 'leader',
                  first_seen_at: '2026-07-07T00:00:00.000Z',
                  last_seen_at: '2026-07-07T00:00:00.000Z',
                  turn_count: 1,
                },
                'thread-architect': {
                  thread_id: 'thread-architect',
                  kind: 'subagent',
                  role: 'architect',
                  thread_source: 'subagent',
                  parent_thread_id: 'thread-leader',
                  depth: 1,
                  first_seen_at: architectCompletedAt,
                  last_seen_at: architectCompletedAt,
                  last_turn_id: currentTurnIds?.architect ?? architectTurnId,
                  ...(inProgress ? {} : {
                    completed_at: architectCompletedAt,
                    last_completed_turn_id: architectTurnId,
                  }),
                  turn_count: 1,
                },
                'thread-critic': {
                  thread_id: 'thread-critic',
                  kind: 'subagent',
                  role: 'critic',
                  thread_source: 'subagent',
                  parent_thread_id: 'thread-leader',
                  depth: 1,
                  first_seen_at: criticCompletedAt,
                  last_seen_at: criticCompletedAt,
                  last_turn_id: currentTurnIds?.critic ?? criticTurnId,
                  ...(inProgress ? {} : {
                    completed_at: criticCompletedAt,
                    last_completed_turn_id: criticTurnId,
                  }),
                  turn_count: 1,
                },
              },
            },
          },
        };
      }

      function reviewEvidence(architectTurnId: string, criticTurnId: string): Record<string, unknown> {
        return {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-architect',
              completed_turn_id: architectTurnId,
              completed_at: '2026-07-07T00:05:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              provenance_kind: 'native_subagent',
              verdict: 'approve',
              session_id: sessionId,
              thread_id: 'thread-critic',
              completed_turn_id: criticTurnId,
              completed_at: '2026-07-07T00:06:00.000Z',
            },
          },
        };
      }

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-2',
        'turn-critic-2',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
        true,
      ), null, 2));
      await writeFile(workspaceTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:01:00.000Z',
        '2026-07-07T00:02:00.000Z',
      ), null, 2));

      const staleFallbackGate = buildRalplanConsensusGateFromSources([{
        source: 'stale-workspace-review',
        value: reviewEvidence('turn-architect-1', 'turn-critic-1'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(staleFallbackGate.complete, false);
      assert.match(staleFallbackGate.blockedDetails?.join(' ') ?? '', /architect tracker thread thread-architect is not completed/);
      assert.equal(staleFallbackGate.diagnostic?.architect.tracker_path, runtimeTrackerPath);
      assert.equal(staleFallbackGate.diagnostic?.architect.tracker_last_turn_id, 'turn-architect-2');
      assert.equal(staleFallbackGate.diagnostic?.architect.tracker_has_current_turn, true);

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
        false,
        { architect: 'turn-architect-2', critic: 'turn-critic-2' },
      ), null, 2));
      const retainedCompletionGate = buildRalplanConsensusGateFromSources([{
        source: 'retained-old-completion',
        value: reviewEvidence('turn-architect-1', 'turn-critic-1'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(retainedCompletionGate.complete, false);
      assert.match(retainedCompletionGate.blockedDetails?.join(' ') ?? '', /current last_turn_id=turn-architect-2 after last_completed_turn_id=turn-architect-1/);
      assert.equal(retainedCompletionGate.diagnostic?.architect.tracker_has_current_turn, true);

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
      ), null, 2));
      const completedSameTurnGate = buildRalplanConsensusGateFromSources([{
        source: 'same-turn-completion',
        value: reviewEvidence('turn-architect-1', 'turn-critic-1'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(completedSameTurnGate.complete, true);
      assert.equal(completedSameTurnGate.source, 'same-turn-completion');

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-2',
        'turn-critic-2',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
      ), null, 2));
      await writeFile(workspaceTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
      ), null, 2));
      const expectedTieGate = buildRalplanConsensusGateFromSources([{
        source: 'equal-time-stale-workspace-review',
        value: reviewEvidence('turn-architect-1', 'turn-critic-1'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(expectedTieGate.complete, false);
      assert.match(expectedTieGate.blockedDetails?.join(' ') ?? '', /completed_turn_id=turn-architect-1 does not match tracker last_completed_turn_id=turn-architect-2/);
      assert.equal(expectedTieGate.diagnostic?.architect.tracker_path, runtimeTrackerPath);

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
      ), null, 2));
      await writeFile(workspaceTrackerPath, JSON.stringify(tracker(
        'turn-architect-2',
        'turn-critic-2',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
        true,
      ), null, 2));
      const currentTurnTieGate = buildRalplanConsensusGateFromSources([{
        source: 'equal-time-current-workspace-review',
        value: reviewEvidence('turn-architect-1', 'turn-critic-1'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(currentTurnTieGate.complete, false);
      assert.match(currentTurnTieGate.blockedDetails?.join(' ') ?? '', /architect tracker thread thread-architect is not completed/);
      assert.equal(currentTurnTieGate.diagnostic?.architect.tracker_path, workspaceTrackerPath);
      assert.equal(currentTurnTieGate.diagnostic?.architect.tracker_has_current_turn, true);

      await writeFile(runtimeTrackerPath, JSON.stringify(tracker(
        'turn-architect-1',
        'turn-critic-1',
        '2026-07-07T00:01:00.000Z',
        '2026-07-07T00:02:00.000Z',
      ), null, 2));
      await writeFile(workspaceTrackerPath, JSON.stringify(tracker(
        'turn-architect-2',
        'turn-critic-2',
        '2026-07-07T00:03:00.000Z',
        '2026-07-07T00:04:00.000Z',
      ), null, 2));

      const workspaceNewerGate = buildRalplanConsensusGateFromSources([{
        source: 'fresh-workspace-review',
        value: reviewEvidence('turn-architect-2', 'turn-critic-2'),
      }], {
        cwd,
        sessionId,
        requireNativeSubagents: true,
      });
      assert.equal(workspaceNewerGate.complete, true);
      assert.equal(workspaceNewerGate.source, 'fresh-workspace-review');
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('rejects runtime tracker lag when workspace tracker also lacks completion evidence', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-lag-incomplete-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-runtime-incomplete-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-runtime-lag-incomplete-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const runtimeStateDir = getBaseStateDir(cwd);
      const runtimeSessionDir = join(runtimeStateDir, 'sessions', sessionId);
      const workspaceStateDir = join(cwd, '.omx', 'state');
      await mkdir(runtimeSessionDir, { recursive: true });
      await mkdir(workspaceStateDir, { recursive: true });
      await writeFile(join(runtimeStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      const incompleteTracker = {
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-07-07T04:31:00.000Z',
            threads: {
              'thread-leader': { thread_id: 'thread-leader', kind: 'leader', first_seen_at: '2026-07-07T04:29:00.000Z', last_seen_at: '2026-07-07T04:29:00.000Z', turn_count: 1 },
              'thread-architect': { thread_id: 'thread-architect', kind: 'subagent', first_seen_at: '2026-07-07T04:30:00.000Z', last_seen_at: '2026-07-07T04:30:00.000Z', turn_count: 1 },
              'thread-critic': { thread_id: 'thread-critic', kind: 'subagent', first_seen_at: '2026-07-07T04:31:00.000Z', last_seen_at: '2026-07-07T04:31:00.000Z', turn_count: 1 },
            },
          },
        },
      };
      await writeFile(subagentTrackingPath(cwd), JSON.stringify(incompleteTracker, null, 2));
      await writeFile(join(workspaceStateDir, 'subagent-tracking.json'), JSON.stringify(incompleteTracker, null, 2));
      await writeFile(join(runtimeSessionDir, 'ralplan-state.json'), JSON.stringify({
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-architect',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:30:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            session_id: sessionId,
            thread_id: 'thread-critic',
            tracker_path: '.omx/state/subagent-tracking.json',
            completed_at: '2026-07-07T04:31:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        sessionId,
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'native_subagent_consensus_evidence_missing');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /thread-architect is not completed/);
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('accepts session-scoped tracker-backed reviews without an explicit sessionId option', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-discovered-session-'));
    const boxedRoot = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-discovered-root-'));
    const previousOmxRoot = process.env.OMX_ROOT;
    const previousOmxStateRoot = process.env.OMX_STATE_ROOT;
    const previousOmxTeamStateRoot = process.env.OMX_TEAM_STATE_ROOT;
    const sessionId = 'sess-discovered-consensus';
    try {
      delete process.env.OMX_ROOT;
      delete process.env.OMX_TEAM_STATE_ROOT;
      process.env.OMX_STATE_ROOT = boxedRoot;
      const baseStateDir = getBaseStateDir(cwd);
      const sessionDir = join(baseStateDir, 'sessions', sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(baseStateDir, 'session.json'), JSON.stringify({
        session_id: sessionId,
        native_session_id: 'thread-leader',
        cwd,
      }, null, 2));
      await writeFile(subagentTrackingPath(cwd), JSON.stringify({
        schemaVersion: 1,
        sessions: {
          [sessionId]: {
            session_id: sessionId,
            leader_thread_id: 'thread-leader',
            updated_at: '2026-06-12T10:03:00.000Z',
            threads: {
              'thread-leader': {
                thread_id: 'thread-leader',
                kind: 'leader',
                first_seen_at: '2026-06-12T09:59:00.000Z',
                last_seen_at: '2026-06-12T09:59:00.000Z',
                turn_count: 1,
              },
              'thread-architect': {
                thread_id: 'thread-architect',
                kind: 'subagent',
                role: 'architect',
                thread_source: 'subagent',
                parent_thread_id: 'thread-leader',
                depth: 1,
                first_seen_at: '2026-06-12T10:02:00.000Z',
                last_seen_at: '2026-06-12T10:02:00.000Z',
                completed_at: '2026-06-12T10:02:00.000Z',
                last_completed_turn_id: 'turn-architect-1',
                turn_count: 1,
              },
              'thread-critic': {
                thread_id: 'thread-critic',
                kind: 'subagent',
                role: 'critic',
                thread_source: 'subagent',
                parent_thread_id: 'thread-leader',
                depth: 1,
                first_seen_at: '2026-06-12T10:03:00.000Z',
                last_seen_at: '2026-06-12T10:03:00.000Z',
                completed_at: '2026-06-12T10:03:00.000Z',
                last_completed_turn_id: 'turn-critic-1',
                turn_count: 1,
              },
            },
          },
        },
      }, null, 2));
      await writeFile(join(sessionDir, 'ralplan-state.json'), JSON.stringify({
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            thread_id: 'thread-architect',
            completed_turn_id: 'turn-architect-1',
            completed_at: '2026-06-12T10:02:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            provenance_kind: 'native_subagent',
            verdict: 'approve',
            thread_id: 'thread-critic',
            completed_turn_id: 'turn-critic-1',
            completed_at: '2026-06-12T10:03:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        requireNativeSubagents: true,
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
      assert.match(String(gate.source), new RegExp(`${sessionId}/ralplan-state\\.json$`));
    } finally {
      if (typeof previousOmxRoot === 'string') process.env.OMX_ROOT = previousOmxRoot;
      else delete process.env.OMX_ROOT;
      if (typeof previousOmxStateRoot === 'string') process.env.OMX_STATE_ROOT = previousOmxStateRoot;
      else delete process.env.OMX_STATE_ROOT;
      if (typeof previousOmxTeamStateRoot === 'string') process.env.OMX_TEAM_STATE_ROOT = previousOmxTeamStateRoot;
      else delete process.env.OMX_TEAM_STATE_ROOT;
      await rm(cwd, { recursive: true, force: true });
      await rm(boxedRoot, { recursive: true, force: true });
    }
  });

  it('rejects stale top-level handoff consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          handoff_artifacts: {
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                completed_at: '2026-06-11T16:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                completed_at: '2026-06-11T16:05:00.000Z',
              },
            },
          },
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale local ralplan state consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-local-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-11T16:00:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-11T16:05:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('ignores stale invalid local ralplan state consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-invalid-local-state-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        ralplan_consensus_gate: {
          complete: true,
          sequence: ['architect-review', 'critic-review'],
          ralplan_architect_review: {
            agent_role: 'architect',
            verdict: 'iterate',
            completed_at: '2026-06-11T16:00:00.000Z',
          },
          ralplan_critic_review: {
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-11T16:05:00.000Z',
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
      assert.equal(gate.source, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves ordered invalid direct consensus in a return-to-ralplan cycle without review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-ordered-invalid-return-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'iterate',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.source, 'stage-context-artifacts');
      assert.equal(gate.blockedReason, 'non_approving_ralplan_consensus_review');
      assert.match(gate.blockedDetails?.join(' ') ?? '', /architect.*verdict=iterate/i);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects local nested handoff consensus when only the local container review_cycle advances', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-container-only-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts local nested handoff consensus when both reviews carry the advanced review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-review-fresh-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        handoff_artifacts: {
          ralplan_consensus_gate: {
            complete: true,
            sequence: ['architect-review', 'critic-review'],
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              review_cycle: 2,
              completed_at: '2026-06-12T10:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              review_cycle: 2,
              completed_at: '2026-06-12T10:05:00.000Z',
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects local state.handoff_artifacts consensus when only the local container review_cycle advances', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-state-container-only-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        review_cycle: 2,
        state: {
          handoff_artifacts: {
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                completed_at: '2026-06-12T10:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                completed_at: '2026-06-12T10:05:00.000Z',
              },
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('accepts local state.handoff_artifacts consensus when nested state and both reviews carry the advanced review_cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-local-state-review-fresh-'));
    try {
      const stateDir = join(cwd, '.omx', 'state');
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, 'ralplan-state.json'), JSON.stringify({
        current_phase: 'complete',
        state: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
          handoff_artifacts: {
            review_cycle: 2,
            ralplan_consensus_gate: {
              complete: true,
              sequence: ['architect-review', 'critic-review'],
              ralplan_architect_review: {
                agent_role: 'architect',
                verdict: 'approve',
                review_cycle: 2,
                completed_at: '2026-06-12T10:00:00.000Z',
              },
              ralplan_critic_review: {
                agent_role: 'critic',
                verdict: 'approve',
                review_cycle: 2,
                completed_at: '2026-06-12T10:05:00.000Z',
              },
            },
          },
        },
      }, null, 2));

      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_cycle: 1,
        },
      });

      assert.equal(gate.complete, true);
      assert.equal(gate.blockedReason, null);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale review history consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-history-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          review_history: [{
            ralplan_architect_review: {
              agent_role: 'architect',
              verdict: 'approve',
              completed_at: '2026-06-11T16:00:00.000Z',
            },
            ralplan_critic_review: {
              agent_role: 'critic',
              verdict: 'approve',
              completed_at: '2026-06-11T16:05:00.000Z',
            },
          }],
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('rejects stale review array consensus during a return-to-ralplan cycle', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-ralplan-consensus-stale-arrays-'));
    try {
      const gate = buildRalplanConsensusGateForCwd(cwd, {
        artifacts: {
          current_phase: 'ralplan',
          return_to_ralplan_reason: 'Code review requested changes.',
          architectReviews: [{
            agent_role: 'architect',
            verdict: 'approve',
            completed_at: '2026-06-11T16:00:00.000Z',
          }],
          criticReviews: [{
            agent_role: 'critic',
            verdict: 'approve',
            completed_at: '2026-06-11T16:05:00.000Z',
          }],
        },
      });

      assert.equal(gate.complete, false);
      assert.equal(gate.blockedReason, 'missing_sequential_architect_then_critic_approval');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
