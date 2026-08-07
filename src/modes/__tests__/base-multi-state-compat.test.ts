import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModeState, startMode } from '../base.js';

describe('modes/base multi-state compatibility', () => {
  it('allows the approved team + ralph overlap across root and session scopes', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-team-ralph-'));
    try {
      await startMode('team', 'coordinate execution', 5, wd);
      await writeFile(
        join(wd, '.omx', 'state', 'session.json'),
        JSON.stringify({ session_id: 'sess-team-ralph' }),
      );

      await startMode('ralph', 'complete the approved plan', 5, wd);

      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), true);
      assert.equal(
        existsSync(join(wd, '.omx', 'state', 'sessions', 'sess-team-ralph', 'ralph-state.json')),
        true,
      );
      assert.equal((await readModeState('team', wd))?.active, true);
      assert.equal((await readModeState('ralph', wd))?.active, true);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects a team started from an autopilot phase that owns no story, with actionable guidance', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-team-'));
    try {
      await startMode('autopilot', 'run solo automation', 5, wd);

      // Autopilot + team is a legal overlap, but only from the ultragoal/team
      // phase. A fresh autopilot has no story yet, so the runtime precondition
      // refuses and must name the exact way forward.
      await assert.rejects(
        () => startMode('team', 'attempt invalid overlap', 5, wd),
        (error: Error) => {
          assert.match(error.message, /nested_autopilot_team_requires_active_ultragoal_child/);
          assert.match(error.message, /deep-interview -> ralplan -> ultragoal/);
          assert.match(error.message, /omx state clear .*"mode":"autopilot"/);
          return true;
        },
      );

      const autopilotState = JSON.parse(
        await readFile(join(wd, '.omx', 'state', 'autopilot-state.json'), 'utf-8'),
      ) as { active?: boolean };
      assert.equal(autopilotState.active, true);
      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });

  it('rejects the public nested-team option without active Autopilot child context', async () => {
    const wd = await mkdtemp(join(tmpdir(), 'omx-mode-autopilot-team-context-'));
    try {
      await startMode('autopilot', 'run reviewed automation', 5, wd);
      const autopilotPath = join(wd, '.omx', 'state', 'autopilot-state.json');
      const autopilotState = JSON.parse(await readFile(autopilotPath, 'utf-8')) as Record<string, unknown>;
      await writeFile(
        autopilotPath,
        JSON.stringify({ ...autopilotState, current_phase: 'code-review' }, null, 2),
      );

      await assert.rejects(
        () => startMode('team', 'bypass nested context', 5, wd, { allowNestedAutopilotTeam: true }),
        /nested_autopilot_team_requires_active_ultragoal_child/,
      );
      assert.equal(existsSync(join(wd, '.omx', 'state', 'team-state.json')), false);
    } finally {
      await rm(wd, { recursive: true, force: true });
    }
  });
});
