import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightTeamModeStart } from '../team.js';
import { readModeState, startMode, updateModeState } from '../../modes/base.js';

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

async function writeActiveUltragoal(cwd: string): Promise<void> {
  const dir = join(cwd, '.omx', 'ultragoal');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'goals.json'), JSON.stringify({
    activeGoalId: 'G001-nested-team',
    codexGoalMode: 'aggregate',
    goals: [{
      id: 'G001-nested-team',
      title: 'Nested Team execution',
      status: 'in_progress',
    }],
  }, null, 2));
}

describe('team mode compatibility preflight', () => {
  it('allows validated Team only inside an active Autopilot Ultragoal child', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-team-autopilot-nested-'));
      try {
        await startMode('autopilot', 'run strict lifecycle', 5, wd);
        await updateModeState('autopilot', { current_phase: 'ultragoal' }, wd);
        await writeActiveUltragoal(wd);

        assert.equal(await preflightTeamModeStart(wd), true);
        await startMode('team', 'run nested story', 5, wd, {
          allowNestedAutopilotTeam: true,
        });

        assert.equal((await readModeState('autopilot', wd))?.active, true);
        assert.equal((await readModeState('team', wd))?.active, true);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });

  it('rejects nested Team before runtime mutation when child or Ultragoal context is invalid', async () => {
    await withIsolatedStateEnv(async () => {
      const wd = await mkdtemp(join(tmpdir(), 'omx-team-autopilot-invalid-'));
      try {
        await startMode('autopilot', 'run strict lifecycle', 5, wd);
        await updateModeState('autopilot', { current_phase: 'code-review' }, wd);
        await writeActiveUltragoal(wd);

        await assert.rejects(
          () => preflightTeamModeStart(wd),
          /nested_autopilot_team_requires_active_ultragoal_child/,
        );

        await updateModeState('autopilot', { current_phase: 'ultragoal' }, wd);
        await rm(join(wd, '.omx', 'ultragoal'), { recursive: true, force: true });
        await assert.rejects(
          () => preflightTeamModeStart(wd),
          /invalid_ultragoal_team_context:missing/,
        );
        assert.equal(await readModeState('team', wd), null);
      } finally {
        await rm(wd, { recursive: true, force: true });
      }
    });
  });
});
