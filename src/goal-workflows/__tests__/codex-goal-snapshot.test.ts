import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CodexGoalSnapshotError,
  parseCodexGoalSnapshot,
  readCodexGoalSnapshotInput,
  reconcileCodexGoalSnapshot,
} from '../codex-goal-snapshot.js';

describe('codex goal snapshot reconciliation', () => {
  it('normalizes get_goal JSON shape', () => {
    const snapshot = parseCodexGoalSnapshot({
      goal: {
        threadId: '019fbae5-b750-7ab2-875f-e36bcdeb3981',
        objective: 'Ship the feature',
        status: 'completed',
        token_budget: 1000,
      },
      remainingTokens: 25,
    });

    assert.equal(snapshot.available, true);
    assert.equal(snapshot.threadId, '019fbae5-b750-7ab2-875f-e36bcdeb3981');
    assert.equal(snapshot.objective, 'Ship the feature');
    assert.equal(snapshot.status, 'complete');
    assert.equal(snapshot.tokenBudget, 1000);
    assert.equal(snapshot.remainingTokens, 25);
  });

  it('classifies get_goal SQL schema/context errors as unavailable without weakening normal goal snapshots', () => {
    const unavailable = parseCodexGoalSnapshot({
      error: 'SQL error: no such table: thread_goals',
    });

    assert.equal(unavailable.available, false);
    assert.equal(unavailable.unavailableReason, 'db_schema_context_error');
    assert.match(unavailable.errorMessage ?? '', /thread_goals/);

    const normal = parseCodexGoalSnapshot({
      goal: { objective: 'Ship despite noisy wrapper metadata', status: 'active' },
      error: 'stale wrapper warning that must not override an available goal',
    });
    assert.equal(normal.available, true);
    assert.equal(normal.objective, 'Ship despite noisy wrapper metadata');
    assert.equal(normal.unavailableReason, undefined);
  });

  it('accepts compatible root identity fields but rejects conflicting snapshot envelopes', () => {
    const compatible = parseCodexGoalSnapshot({
      threadId: 'same-thread',
      objective: 'Same objective',
      status: 'running',
      goal: {
        threadId: 'same-thread',
        objective: 'Same objective',
        status: 'active',
      },
    });
    assert.equal(compatible.threadId, 'same-thread');
    assert.equal(compatible.status, 'active');

    assert.throws(
      () => parseCodexGoalSnapshot({
        threadId: 'root-thread',
        goal: { threadId: 'nested-thread', objective: 'Same objective', status: 'active' },
      }),
      /Conflicting nested and root threadId/,
    );
    assert.throws(
      () => parseCodexGoalSnapshot({
        objective: 'Root objective',
        goal: { threadId: 'same-thread', objective: 'Nested objective', status: 'active' },
      }),
      /Conflicting nested and root objective/,
    );
    assert.throws(
      () => parseCodexGoalSnapshot({
        status: 'complete',
        goal: { threadId: 'same-thread', objective: 'Same objective', status: 'active' },
      }),
      /Conflicting nested and root status/,
    );
  });

  it('reports absent snapshots as warnings unless required', () => {
    const optional = reconcileCodexGoalSnapshot(null, { expectedObjective: 'Ship' });
    assert.equal(optional.ok, true);
    assert.match(optional.warnings.join('\n'), /call get_goal/);

    const required = reconcileCodexGoalSnapshot(null, { expectedObjective: 'Ship', requireSnapshot: true });
    assert.equal(required.ok, false);
    assert.match(required.errors.join('\n'), /call get_goal/);
  });

  it('treats get_goal null as no active goal without permitting completion', () => {
    const required = reconcileCodexGoalSnapshot(
      parseCodexGoalSnapshot({ goal: null }),
      { expectedObjective: 'Ship', requireSnapshot: true, requireComplete: true },
    );

    assert.equal(required.ok, false);
    assert.match(required.errors.join('\n'), /no active goal\/null/);
    assert.match(required.errors.join('\n'), /call create_goal/);
    assert.match(required.errors.join('\n'), /do not mark complete from OMX state alone/);
  });

  it('keeps required reconciliation strict when get_goal is unavailable', () => {
    const result = reconcileCodexGoalSnapshot(
      parseCodexGoalSnapshot({ error: 'SqliteError: no such table: thread_goals' }),
      { expectedObjective: 'Ship', requireSnapshot: true, requireComplete: true },
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /DB\/schema\/context error/);
    assert.match(result.errors.join('\n'), /no such table: thread_goals/);
  });

  it('detects objective mismatches and incomplete completion proof', () => {
    const mismatch = reconcileCodexGoalSnapshot(
      parseCodexGoalSnapshot({ goal: { objective: 'Different', status: 'active' } }),
      { expectedObjective: 'Expected', requireSnapshot: true, requireComplete: true },
    );

    assert.equal(mismatch.ok, false);
    assert.match(mismatch.errors.join('\n'), /objective mismatch/);
    assert.match(mismatch.errors.join('\n'), /not complete/);
  });

  it('accepts compatible complete proof', () => {
    const result = reconcileCodexGoalSnapshot(
      parseCodexGoalSnapshot({ goal: { objective: 'Expected objective', status: 'complete' } }),
      { expectedObjective: 'Expected objective', requireSnapshot: true, requireComplete: true },
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
  });

  it('requires the bound thread identity when requested', () => {
    const result = reconcileCodexGoalSnapshot(
      parseCodexGoalSnapshot({
        goal: { threadId: 'wrong-thread', objective: 'Expected objective', status: 'active' },
      }),
      {
        expectedObjective: 'Expected objective',
        expectedThreadId: 'expected-thread',
        requireSnapshot: true,
      },
    );

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /threadId mismatch/);
  });

  it('reads inline JSON and path input but rejects malformed sources', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-codex-goal-snapshot-'));
    try {
      const fromJson = await readCodexGoalSnapshotInput('{"goal":{"objective":"A","status":"active"}}', cwd);
      assert.equal(fromJson?.objective, 'A');

      await writeFile(join(cwd, 'goal.json'), '{"goal":{"objective":"B","status":"complete"}}');
      const fromPath = await readCodexGoalSnapshotInput('goal.json', cwd);
      assert.equal(fromPath?.objective, 'B');

      await writeFile(join(cwd, 'goal.json'), JSON.stringify({
        threadId: 'root-thread',
        goal: { threadId: 'nested-thread', objective: 'B', status: 'active' },
      }));
      await assert.rejects(
        () => readCodexGoalSnapshotInput('goal.json', cwd),
        /Conflicting nested and root threadId/,
      );
      await assert.rejects(
        () => readCodexGoalSnapshotInput('{not-json}', cwd),
        CodexGoalSnapshotError,
      );
      await assert.rejects(
        () => readCodexGoalSnapshotInput('missing.json', cwd),
        /neither valid JSON nor a readable path/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
