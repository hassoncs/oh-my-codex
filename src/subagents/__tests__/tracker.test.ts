import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSubagentResumeLedger,
  createSubagentTrackingState,
  hasVerifiedNativeSubagentLineage,
  recordSubagentTurn,
  recordSubagentTurnForSession,
  readSubagentTrackingState,
  selectReusableSubagentEntry,
  subagentTrackingPath,
  summarizeSubagentSession,
} from '../tracker.js';

async function runTrackerWriter(cwd: string, input: Record<string, unknown>): Promise<void> {
  const trackerModule = new URL('../tracker.js', import.meta.url).href;
  const source = [
    `import { recordSubagentTurnForSession } from ${JSON.stringify(trackerModule)};`,
    `await recordSubagentTurnForSession(${JSON.stringify(cwd)}, ${JSON.stringify(input)});`,
  ].join('\n');
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: 'ignore' });
    child.on('error', rejectRun);
    child.on('exit', (status, signal) => {
      if (status === 0) resolveRun();
      else rejectRun(new Error(`tracker writer exited status=${status ?? 'null'} signal=${signal ?? 'none'}`));
    });
  });
}

function currentProcessStartIdentity(): string {
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf-8', timeout: 1_000, windowsHide: true })
    : spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf-8', timeout: 1_000 });
  assert.equal(result.status, 0);
  assert.ok(result.stdout.trim());
  return result.stdout.trim();
}

describe('subagents/tracker', () => {
  it('tracks leader and subagent threads per session and computes active windows', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'ralph',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-2',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:01:00.000Z',
      mode: 'ralph',
    });

    const active = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(active, {
      sessionId: 'sess-1',
      leaderThreadId: 'leader-thread',
      allThreadIds: ['leader-thread', 'sub-thread-1', 'sub-thread-2'],
      allSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      activeSubagentThreadIds: ['sub-thread-1', 'sub-thread-2'],
      savedSubagents: [
        { agentId: 'sub-thread-1', threadId: 'sub-thread-1', role: 'ralph', laneId: 'ralph', status: 'available' },
        { agentId: 'sub-thread-2', threadId: 'sub-thread-2', role: 'ralph', laneId: 'ralph', status: 'available' },
      ],
      updatedAt: '2026-03-17T00:01:00.000Z',
    });

    const drained = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:03:30.000Z',
      activeWindowMs: 60_000,
    });
    assert.deepEqual(drained?.activeSubagentThreadIds, []);
  });

  it('can record an explicitly spawned subagent as subagent even when it is the first seen thread', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-critic',
      timestamp: '2026-05-28T18:01:49.547Z',
      mode: 'critic',
      kind: 'subagent',
    });

    const summary = summarizeSubagentSession(state, 'sess-ralplan', {
      now: '2026-05-28T18:02:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-critic']?.kind, 'subagent');
    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-architect', 'thread-critic']);
  });

  it('keeps an explicitly spawned first-seen subagent as subagent after a generic follow-up turn', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      turnId: 'turn-after-session-start',
      timestamp: '2026-05-28T18:00:05.000Z',
      mode: 'architect',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.turn_count, 2);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.last_turn_id, 'turn-after-session-start');
  });

  it('does not promote existing subagent evidence when the same thread later acts as a parent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T18:00:10.000Z',
      mode: 'architect',
      kind: 'leader',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
  });

  it('does not promote a known subagent when it becomes an immediate parent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-architect',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-researcher',
      timestamp: '2026-05-28T18:00:10.000Z',
      mode: 'researcher',
      kind: 'subagent',
      leaderThreadId: 'thread-architect',
    });

    const summary = summarizeSubagentSession(state, 'sess-ralplan', {
      now: '2026-05-28T18:00:11.000Z',
      activeWindowMs: 120_000,
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, undefined);
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-architect']?.kind, 'subagent');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-researcher']?.kind, 'subagent');
    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-architect', 'thread-researcher']);
  });

  it('does not downgrade a known leader when later native metadata claims the same thread as subagent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-leader',
      timestamp: '2026-05-28T17:59:40.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-ralplan',
      threadId: 'thread-leader',
      timestamp: '2026-05-28T17:59:43.270Z',
      mode: 'architect',
      kind: 'subagent',
    });

    assert.equal(state.sessions['sess-ralplan']?.leader_thread_id, 'thread-leader');
    assert.equal(state.sessions['sess-ralplan']?.threads['thread-leader']?.kind, 'leader');
  });

  it('excludes a corrupt leader thread from trusted subagent summaries even when kind is subagent', () => {
    const state = createSubagentTrackingState();
    state.sessions['sess-corrupt'] = {
      session_id: 'sess-corrupt',
      leader_thread_id: 'thread-leader',
      updated_at: '2026-05-28T19:04:17.000Z',
      threads: {
        'thread-leader': {
          thread_id: 'thread-leader',
          kind: 'subagent',
          first_seen_at: '2026-05-28T19:04:17.000Z',
          last_seen_at: '2026-05-28T19:04:17.000Z',
          turn_count: 2,
        },
        'thread-child': {
          thread_id: 'thread-child',
          kind: 'subagent',
          first_seen_at: '2026-05-28T19:04:18.000Z',
          last_seen_at: '2026-05-28T19:04:18.000Z',
          turn_count: 1,
        },
      },
    };

    const summary = summarizeSubagentSession(state, 'sess-corrupt', {
      now: '2026-05-28T19:04:19.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.allSubagentThreadIds, ['thread-child']);
    assert.deepEqual(summary?.activeSubagentThreadIds, ['thread-child']);
  });

  it('reconciles completed subagent threads before reporting active wait state', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:00:45.000Z',
      mode: 'architect',
      completed: true,
      completionSource: 'notify-fallback-watcher',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.allSubagentThreadIds, ['sub-thread-1']);
    assert.deepEqual(summary?.activeSubagentThreadIds, []);
    assert.equal(
      state.sessions['sess-1']?.threads['sub-thread-1']?.completion_source,
      'notify-fallback-watcher',
    );
  });

  it('preserves explicit unavailable and closed status in summaries even when threads are still recent', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-unavailable',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
      status: 'unavailable',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-closed',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:00:45.000Z',
      mode: 'critic',
      status: 'closed',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-1', {
      now: '2026-03-17T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.activeSubagentThreadIds, []);
    assert.deepEqual(summary?.savedSubagents, [
      { agentId: 'sub-thread-closed', threadId: 'sub-thread-closed', role: 'critic', laneId: 'critic', status: 'closed' },
      { agentId: 'sub-thread-unavailable', threadId: 'sub-thread-unavailable', role: 'architect', laneId: 'architect', status: 'unavailable' },
    ]);
    assert.deepEqual(ledger?.activeSubagentThreadIds, []);
  });

  it('reactivates a notify-fallback-completed subagent thread after a later non-complete turn', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'leader-thread',
      turnId: 'turn-1',
      timestamp: '2026-03-17T00:00:00.000Z',
      mode: 'ralplan',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-2',
      timestamp: '2026-03-17T00:00:30.000Z',
      mode: 'architect',
      completed: true,
      completionSource: 'notify-fallback-watcher',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-1',
      threadId: 'sub-thread-1',
      turnId: 'turn-3',
      timestamp: '2026-03-17T00:01:00.000Z',
      mode: 'architect',
    });

    const summary = summarizeSubagentSession(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 120_000,
    });
    const ledger = buildSubagentResumeLedger(state, 'sess-1', {
      now: '2026-03-17T00:01:15.000Z',
      activeWindowMs: 120_000,
    });
    const thread = state.sessions['sess-1']?.threads['sub-thread-1'];

    assert.deepEqual(summary?.activeSubagentThreadIds, ['sub-thread-1']);
    assert.deepEqual(summary?.savedSubagents, [
      { agentId: 'sub-thread-1', threadId: 'sub-thread-1', role: 'architect', laneId: 'architect', status: 'available' },
    ]);
    assert.deepEqual(ledger?.activeSubagentThreadIds, ['sub-thread-1']);
    assert.equal(ledger?.savedSubagents[0]?.status, 'available');
    assert.equal(thread?.status, undefined);
    assert.equal(thread?.completed_at, undefined);
    assert.equal(thread?.last_completed_turn_id, undefined);
    assert.equal(thread?.completion_source, undefined);
    assert.equal(thread?.last_turn_id, 'turn-3');
  });

  it('enriches a native-first turn with fallback completion without double-counting it', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'subagent-1',
      turnId: 'turn-1',
      timestamp: '2026-07-15T01:00:00.000Z',
      kind: 'subagent',
      role: 'architect',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'subagent-1',
      turnId: 'turn-1',
      timestamp: '2026-07-15T01:00:01.000Z',
      kind: 'subagent',
      role: 'architect',
      completed: true,
      completionSource: 'notify-fallback-watcher',
    });

    const thread = state.sessions['session-1']?.threads['subagent-1'];
    assert.equal(thread?.turn_count, 1);
    assert.equal(thread?.completed_at, '2026-07-15T01:00:01.000Z');
    assert.equal(thread?.last_completed_turn_id, 'turn-1');
  });

  it('replaces a stale session leader only when authoritative identity requests it', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'stale-leader',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'current-leader',
      kind: 'leader',
      replaceLeader: true,
    });

    assert.equal(state.sessions['session-1']?.leader_thread_id, 'current-leader');
    assert.equal(state.sessions['session-1']?.threads['current-leader']?.kind, 'leader');
    assert.equal(state.sessions['session-1']?.threads['stale-leader']?.kind, 'leader');
  });

  it('reclassifies a stale leader when authoritative subagent provenance arrives', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'stale-leader',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'current-leader',
      kind: 'leader',
      replaceLeader: true,
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'stale-leader',
      kind: 'subagent',
      leaderThreadId: 'current-leader',
      parentThreadId: 'current-leader',
      depth: 1,
      threadSource: 'subagent',
    });

    assert.equal(state.sessions['session-1']?.leader_thread_id, 'current-leader');
    assert.equal(state.sessions['session-1']?.threads['current-leader']?.kind, 'leader');
    assert.equal(state.sessions['session-1']?.threads['stale-leader']?.kind, 'subagent');
  });

  it('requires recursive native provenance before trusting nested lineage', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'leader',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'parent',
      kind: 'subagent',
      leaderThreadId: 'leader',
      threadSource: 'subagent',
      parentThreadId: 'leader',
      depth: 1,
    });
    state = recordSubagentTurn(state, {
      sessionId: 'session-1',
      threadId: 'nested',
      kind: 'subagent',
      leaderThreadId: 'leader',
      threadSource: 'subagent',
      parentThreadId: 'parent',
      depth: 2,
    });

    const session = state.sessions['session-1'];
    assert.equal(hasVerifiedNativeSubagentLineage(session, 'nested'), true);
    if (session?.threads.parent) delete session.threads.parent.thread_source;
    assert.equal(hasVerifiedNativeSubagentLineage(session, 'nested'), false);
  });

  it('serializes concurrent cross-process writers without losing threads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-concurrent-'));
    try {
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'session-1',
        threadId: 'leader',
        kind: 'leader',
      });
      const threadIds = Array.from({ length: 16 }, (_, index) => `child-${index}`);
      await Promise.all(threadIds.map((threadId, index) => runTrackerWriter(cwd, {
        sessionId: 'session-1',
        threadId,
        turnId: `turn-${threadId}`,
        kind: 'subagent',
        leaderThreadId: 'leader',
        threadSource: 'subagent',
        parentThreadId: 'leader',
        depth: 1,
      })));

      const tracking = JSON.parse(await readFile(subagentTrackingPath(cwd), 'utf-8'));
      assert.deepEqual(
        threadIds.filter((threadId) => tracking.sessions?.['session-1']?.threads?.[threadId]).sort(),
        threadIds.sort(),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('keeps same-turn fallback and native writes idempotent across processes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-same-turn-'));
    try {
      const nativeInput = {
        sessionId: 'session-1',
        threadId: 'architect',
        turnId: 'turn-1',
        kind: 'subagent',
        leaderThreadId: 'leader',
        role: 'architect',
      };
      const fallbackInput = {
        ...nativeInput,
        threadSource: 'subagent',
        parentThreadId: 'leader',
        depth: 1,
        completed: true,
        completionSource: 'notify-fallback-watcher',
      };
      await recordSubagentTurnForSession(cwd, {
        sessionId: 'session-1',
        threadId: 'leader',
        kind: 'leader',
      });
      await Promise.all(Array.from({ length: 20 }, (_, index) => (
        runTrackerWriter(cwd, index % 2 === 0 ? nativeInput : fallbackInput)
      )));

      const thread = (await readSubagentTrackingState(cwd)).sessions['session-1']?.threads.architect;
      assert.equal(thread?.turn_count, 1);
      assert.equal(thread?.role, 'architect');
      assert.equal(thread?.thread_source, 'subagent');
      assert.equal(thread?.parent_thread_id, 'leader');
      assert.equal(thread?.depth, 1);
      assert.equal(thread?.last_completed_turn_id, 'turn-1');
      assert.equal(thread?.completion_source, 'notify-fallback-watcher');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('recovers dead-owner locks and atomically replaces malformed state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-stale-lock-'));
    try {
      const path = subagentTrackingPath(cwd);
      const lockPath = `${path}.lock`;
      const recoveryDir = `${lockPath}.recovery`;
      await mkdir(join(cwd, '.omx', 'state'), { recursive: true });
      await writeFile(lockPath, JSON.stringify({
        pid: process.pid,
        process_start_identity: 'reused-process',
        token: 'stale',
      }));
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(
        join(recoveryDir, 'candidate-00000000000000000000-stale'),
        JSON.stringify({ pid: process.pid, process_start_identity: 'reused-process' }),
      );
      const agedCandidate = join(recoveryDir, 'candidate-00000000000000000001-aged');
      await writeFile(agedCandidate, JSON.stringify({ pid: process.pid }));
      const agedAt = new Date(Date.now() - 10_000);
      await utimes(agedCandidate, agedAt, agedAt);
      await writeFile(path, '{malformed');

      const threadIds = Array.from({ length: 12 }, (_, index) => `recovered-${index}`);
      await Promise.all(threadIds.map((threadId, index) => runTrackerWriter(cwd, {
        sessionId: 'session-1',
        threadId,
        kind: index === 0 ? 'leader' : 'subagent',
      })));

      const tracking = JSON.parse(await readFile(path, 'utf-8'));
      assert.deepEqual(
        threadIds.filter((threadId) => tracking.sessions?.['session-1']?.threads?.[threadId]).sort(),
        threadIds.sort(),
      );
      assert.equal((await readdir(join(cwd, '.omx', 'state'))).some((name) => name.includes('.tmp.')), false);
      assert.deepEqual(await readdir(recoveryDir), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('does not evict an aged identity-verified live recovery candidate', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-subagent-tracker-live-reaper-'));
    try {
      const path = subagentTrackingPath(cwd);
      const lockPath = `${path}.lock`;
      const recoveryDir = `${lockPath}.recovery`;
      const liveCandidate = join(recoveryDir, 'candidate-00000000000000000000-live');
      await mkdir(recoveryDir, { recursive: true });
      await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1_000_000, token: 'stale' }));
      await writeFile(liveCandidate, JSON.stringify({
        pid: process.pid,
        process_start_identity: currentProcessStartIdentity(),
      }));
      const agedAt = new Date(Date.now() - 10_000);
      await utimes(liveCandidate, agedAt, agedAt);

      const writer = runTrackerWriter(cwd, {
        sessionId: 'session-1',
        threadId: 'leader',
        kind: 'leader',
      });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      assert.equal(existsSync(liveCandidate), true);
      await rm(liveCandidate, { force: true });
      await writer;
      const tracking = await readSubagentTrackingState(cwd);
      assert.equal(tracking.sessions['session-1']?.leader_thread_id, 'leader');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records role and lane metadata for restart resume/reuse summaries', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-executor',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'executor',
      role: 'executor',
      laneId: 'implementation-fix',
      scope: 'runtime hook guard',
      agentNickname: 'worker-1',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
    });

    const summary = summarizeSubagentSession(state, 'sess-conductor', {
      now: '2026-06-29T00:01:00.000Z',
      activeWindowMs: 120_000,
    });

    assert.deepEqual(summary?.savedSubagents, [
      {
        agentId: 'thread-executor',
        threadId: 'thread-executor',
        role: 'executor',
        laneId: 'implementation-fix',
        scope: 'runtime hook guard',
        agentNickname: 'worker-1',
        status: 'available',
      },
    ]);
    assert.equal(state.sessions['sess-conductor']?.threads['thread-executor']?.role, 'executor');
    assert.equal(state.sessions['sess-conductor']?.threads['thread-executor']?.lane_id, 'implementation-fix');
  });

  it('builds a reusable ledger that preserves unavailable status and handoff summaries', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-architect',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'architect',
      role: 'architect',
      laneId: 'plan-review',
      scope: 'runtime hook guard',
      agentNickname: 'reviewer-1',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      lastHandoffSummary: 'architect reviewed v1 and requested reuse of the same lane',
      status: 'available',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-critic',
      timestamp: '2026-06-29T00:01:00.000Z',
      mode: 'critic',
      role: 'critic',
      laneId: 'risk-review',
      scope: 'runtime hook guard',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      lastHandoffSummary: 'critic paused pending planner response',
      status: 'unavailable',
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-conductor', {
      now: '2026-06-29T00:01:30.000Z',
      activeWindowMs: 120_000,
    });

    assert.ok(ledger);
    assert.deepEqual(ledger?.resumeTargets.map((entry) => entry.agentId), ['thread-architect', 'thread-critic']);
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-architect')?.status, 'available');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-architect')?.lastHandoffSummary, 'architect reviewed v1 and requested reuse of the same lane');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-critic')?.status, 'unavailable');
    assert.equal(ledger?.savedSubagents.find((entry) => entry.agentId === 'thread-critic')?.lastHandoffSummary, 'critic paused pending planner response');
    assert.deepEqual(
      selectReusableSubagentEntry(ledger?.resumeTargets ?? [], {
        role: 'architect',
        laneId: 'plan-review',
        scope: 'runtime hook guard',
      })?.agentId,
      'thread-architect',
    );
    assert.equal(
      selectReusableSubagentEntry([
        {
          agentId: 'thread-executor',
          threadId: 'thread-executor',
          role: 'executor',
          laneId: 'plan-review',
          scope: 'runtime hook guard',
          status: 'available',
          lastSeenAt: '2026-06-29T00:01:25.000Z',
        },
        {
          agentId: 'thread-architect',
          threadId: 'thread-architect',
          role: 'architect',
          laneId: 'plan-review',
          scope: 'runtime hook guard',
          status: 'closed',
          lastSeenAt: '2026-06-29T00:01:20.000Z',
        },
      ], {
        role: 'architect',
        laneId: 'plan-review',
        scope: 'runtime hook guard',
      })?.agentId,
      'thread-architect',
    );
    assert.equal(
      selectReusableSubagentEntry([
        {
          agentId: 'thread-critic',
          threadId: 'thread-critic',
          role: 'critic',
          laneId: 'risk-review',
          scope: 'runtime hook guard',
          status: 'unavailable',
        },
      ], {
        role: 'critic',
        laneId: 'risk-review',
        scope: 'runtime hook guard',
      }),
      null,
    );
    assert.equal(
      selectReusableSubagentEntry([
        {
          agentId: 'thread-executor',
          threadId: 'thread-executor',
          role: 'executor',
          laneId: 'plan-review',
          scope: 'runtime hook guard',
          status: 'available',
        },
      ], {
        role: 'architect',
        laneId: 'plan-review',
        scope: 'runtime hook guard',
      }),
      null,
    );
    assert.deepEqual(ledger?.unavailableSubagents.map((entry) => entry.agentId), ['thread-critic']);
  });

  it('preserves explicit closed ledger status so older available lanes win reuse selection', () => {
    let state = createSubagentTrackingState();
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-leader',
      timestamp: '2026-06-29T00:00:00.000Z',
      mode: 'ralph',
      kind: 'leader',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-available-older',
      timestamp: '2026-06-29T00:00:30.000Z',
      mode: 'executor',
      role: 'executor',
      laneId: 'implementation-fix',
      scope: 'conductor reuse ledger',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      status: 'available',
    });
    state = recordSubagentTurn(state, {
      sessionId: 'sess-conductor',
      threadId: 'thread-closed-recent',
      timestamp: '2026-06-29T00:01:30.000Z',
      mode: 'executor',
      role: 'executor',
      laneId: 'implementation-fix',
      scope: 'conductor reuse ledger',
      kind: 'subagent',
      leaderThreadId: 'thread-leader',
      status: 'closed',
    });

    const ledger = buildSubagentResumeLedger(state, 'sess-conductor', {
      now: '2026-06-29T00:01:45.000Z',
      activeWindowMs: 120_000,
    });

    assert.ok(ledger);
    assert.equal(ledger.savedSubagents.find((entry) => entry.agentId === 'thread-closed-recent')?.status, 'closed');
    assert.deepEqual(ledger.resumeTargets.map((entry) => entry.agentId), [
      'thread-available-older',
      'thread-closed-recent',
    ]);
    assert.equal(
      selectReusableSubagentEntry(ledger.resumeTargets, {
        role: 'executor',
        laneId: 'implementation-fix',
        scope: 'conductor reuse ledger',
      })?.agentId,
      'thread-available-older',
    );
  });

});
