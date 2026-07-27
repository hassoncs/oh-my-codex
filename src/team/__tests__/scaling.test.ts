import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, readdir, rename } from 'fs/promises';
import { dirname, join, relative } from 'path';
import { tmpdir } from 'os';
import { existsSync, readFileSync } from 'fs';
import {
  initTeamState,
  createTask,
  readTask,
  readTeamConfig,
  saveTeamConfig,
  readWorkerStatus,
  writeWorkerStatus,
  withScalingLock,
  setWriteAtomicRenameForTests,
  resetWriteAtomicRenameForTests,
  DEFAULT_MAX_WORKERS,
} from '../state.js';
import { isScalingEnabled, scaleUp, scaleDown } from '../scaling.js';
import { executeTeamApiOperation } from '../api-interop.js';
import { resolveCanonicalTeamStateRoot } from '../state-root.js';
import {
  resolvePersistedApprovedTeamExecutionContinuityState,
  writePersistedApprovedTeamExecutionBinding,
} from '../approved-execution.js';

delete process.env.OMX_TEAM_STATE_ROOT;

async function initCommittedGitRepo(cwd: string): Promise<void> {
  execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'OMX Test'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'omx@example.com'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-worktree-repo-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function computeGitBlobSha1(content: string): string {
  const buffer = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buffer.length}\0`, 'utf-8');
  return createHash('sha1').update(header).update(buffer).digest('hex');
}

function canonicalContextPackRelativePath(slug: string): string {
  return `.omx/context/context-20260507T120000Z-${slug}.json`;
}

function buildContextPackOutcome(relativePackPath: string): string {
  return [
    '## Context Pack Outcome',
    '',
    `- pack: created \`${relativePackPath}\``,
  ].join('\n');
}


function workerStartupScriptPath(cwd: string, teamName: string, workerName: string): string {
  return join(cwd, '.omx', 'state', 'team', teamName, 'runtime', `${workerName}-startup.sh`);
}

type ContextPackRole = 'scope' | 'build' | 'verify';

type ScaleUpApprovedBindingState =
  | 'missing'
  | 'malformed'
  | 'stale'
  | 'ambiguous'
  | 'missing-baseline'
  | 'plan-only'
  | 'incomplete'
  | 'invalid'
  | 'ready';

type ScaleUpObservedOutcome = 'generic' | 'blocked' | 'approved';

type ScaleUpCount = 1 | 2 | 3;

type BlockedScaleUpApprovedBindingState = Exclude<
  ScaleUpApprovedBindingState,
  'missing' | 'plan-only' | 'incomplete' | 'invalid' | 'ready'
>;

const BLOCKED_SCALE_UP_APPROVED_BINDING_STATES: readonly BlockedScaleUpApprovedBindingState[] = [
  'malformed',
  'stale',
  'ambiguous',
  'missing-baseline',
];

const SCALE_UP_STATE_TEAM_SUFFIX: Record<ScaleUpApprovedBindingState, string> = {
  missing: 'miss',
  malformed: 'mal',
  stale: 'stale',
  ambiguous: 'amb',
  'missing-baseline': 'mbase',
  'plan-only': 'ponly',
  incomplete: 'inc',
  invalid: 'inv',
  ready: 'ready',
};

const SCALE_UP_APPROVED_BINDING_STATES: readonly ScaleUpApprovedBindingState[] = [
  'missing',
  ...BLOCKED_SCALE_UP_APPROVED_BINDING_STATES,
  'plan-only',
  'incomplete',
  'invalid',
  'ready',
];

const SCALE_UP_COUNTS: readonly ScaleUpCount[] = [1, 2, 3];

function assertNeverScaleUpState(state: never): never {
  throw new Error(`unexpected scale-up approved binding state: ${state}`);
}

function expectedScaleUpOutcome(state: ScaleUpApprovedBindingState): ScaleUpObservedOutcome {
  if (state === 'missing') {
    return 'generic';
  }
  return BLOCKED_SCALE_UP_APPROVED_BINDING_STATES.includes(state as BlockedScaleUpApprovedBindingState)
    ? 'blocked'
    : 'approved';
}

function forbiddenScaleUpOutcomes(
  state: ScaleUpApprovedBindingState,
): readonly ScaleUpObservedOutcome[] {
  switch (state) {
    case 'missing':
      return ['blocked', 'approved'];
    case 'plan-only':
    case 'incomplete':
    case 'invalid':
    case 'ready':
      return ['blocked', 'generic'];
    case 'malformed':
    case 'stale':
    case 'ambiguous':
    case 'missing-baseline':
      return ['generic', 'approved'];
    default:
      return assertNeverScaleUpState(state);
  }
}

function buildScaleUpScenarioTasks(
  state: ScaleUpApprovedBindingState,
  count: ScaleUpCount,
): Array<{ subject: string; description: string; owner: string }> {
  return Array.from({ length: count }, (_, index) => {
    const workerIndex = index + 2;
    return {
      subject: `Implement ${state} follow-up ${workerIndex}/${count}`,
      description: `Implement ${state} follow-up ${workerIndex}/${count}`,
      owner: `worker-${workerIndex}`,
    };
  });
}

async function writeContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
  roles: readonly ContextPackRole[],
): Promise<void> {
  const contextDir = join(cwd, '.omx', 'context');
  const packPath = join(cwd, canonicalContextPackRelativePath(slug));
  const prdContent = await readFile(prdPath, 'utf-8');
  const testSpecContent = await readFile(testSpecPath, 'utf-8');
  await mkdir(contextDir, { recursive: true });
  await writeFile(packPath, JSON.stringify({
    slug,
    basis: {
      prd: {
        path: relative(cwd, prdPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(prdContent),
      },
      testSpecs: [{
        path: relative(cwd, testSpecPath).replaceAll('\\', '/'),
        sha1: computeGitBlobSha1(testSpecContent),
      }],
    },
    entries: roles.map((role, index) => ({
      path: `src/${role}-${index}.ts`,
      roles: [role],
    })),
  }, null, 2));
}

async function writeReadyContextPack(
  cwd: string,
  slug: string,
  prdPath: string,
  testSpecPath: string,
): Promise<void> {
  await writeContextPack(cwd, slug, prdPath, testSpecPath, ['scope', 'build', 'verify']);
}

async function writeSuccessfulScaleUpTmuxStub(
  fakeBinDir: string,
  tmuxLogPath: string,
): Promise<void> {
  const tmuxStubPath = join(fakeBinDir, 'tmux');
  await writeFile(
    tmuxStubPath,
    [
      '#!/bin/sh',
      'set -eu',
      `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
      'case "${1:-}" in',
      '  -V)',
      '    echo "tmux 3.2a"',
      '    ;;',
      '  split-window)',
      '    echo "%31"',
      '    ;;',
      '  list-panes)',
      '    echo "42424"',
      '    ;;',
      '  send-keys)',
      '    ;;',
      '  capture-pane)',
      '    echo ""',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(tmuxStubPath, 0o755);
  await writeFile(tmuxLogPath, '');
}

async function configureScaleUpTeamForDirectDispatch(teamName: string, cwd: string): Promise<void> {
  const config = await readTeamConfig(teamName, cwd);
  assert.ok(config);
  if (!config) {
    throw new Error(`missing team config for ${teamName}`);
  }
  config.tmux_session = `omx-team-${teamName}`;
  config.leader_pane_id = '%11';
  config.workers[0]!.pane_id = '%21';
  await saveTeamConfig(config, cwd);

  const manifestPath = join(cwd, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
  if (!existsSync(manifestPath)) {
    await mkdir(join(cwd, '.omx', 'state', 'team', teamName), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify({ version: 2, policy: {} }, null, 2)}\n`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
  manifest.policy = {
    ...(manifest.policy ?? {}),
    dispatch_mode: 'transport_direct',
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function readScaleUpTmuxLogCommands(tmuxLogPath: string): Promise<string[]> {
  const content = await readFile(tmuxLogPath, 'utf-8');
  const trimmed = content.trim();
  return trimmed === '' ? [] : trimmed.split('\n');
}

async function readScaleUpTaskPayloads(teamName: string, cwd: string): Promise<string[]> {
  const tasksDir = join(cwd, '.omx', 'state', 'team', teamName, 'tasks');
  if (!existsSync(tasksDir)) {
    return [];
  }
  const taskFiles = (await readdir(tasksDir)).filter((entry) => entry.endsWith('.json')).sort();
  return await Promise.all(taskFiles.map((entry) => readFile(join(tasksDir, entry), 'utf-8')));
}

async function readExpectedScaleUpApprovedBindingError(
  teamName: string,
  cwd: string,
): Promise<string | null> {
  const continuity = await resolvePersistedApprovedTeamExecutionContinuityState(teamName, cwd);
  if (continuity.status === 'missing') {
    return null;
  }
  if (continuity.status === 'malformed') {
    return `approved_execution_binding_malformed:${teamName}`;
  }
  if (continuity.status === 'ambiguous') {
    return `approved_execution_binding_ambiguous:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  if (continuity.status === 'stale') {
    return `approved_execution_binding_stale:${continuity.binding.prd_path}:${continuity.binding.task}`;
  }
  return null;
}

async function prepareScaleUpApprovedBindingState(
  teamName: string,
  cwd: string,
  state: Exclude<ScaleUpApprovedBindingState, 'missing'>,
): Promise<void> {
  if (state === 'malformed') {
    await writeFile(
      join(cwd, '.omx', 'state', 'team', teamName, 'approved-execution.json'),
      '{"prd_path":42}\n',
    );
    return;
  }

  const plansDir = join(cwd, '.omx', 'plans');
  const approvedTask = `Execute ${state} scale-up handoff`;
  const prdPath = join(plansDir, `prd-${state}.md`);
  const testSpecPath = join(plansDir, `test-spec-${state}.md`);
  await mkdir(plansDir, { recursive: true });

  if (state === 'stale') {
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
      command: `omx team 1:executor "${approvedTask}"`,
    });
    return;
  }

  if (state === 'ambiguous') {
    await writeFile(
      prdPath,
      [
        '# Approved plan',
        '',
        `Launch via omx team 1:executor "${approvedTask}"`,
        `Launch via omx team 2:writer "${approvedTask}"`,
      ].join('\n'),
    );
    await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
      prd_path: prdPath,
      task: approvedTask,
    });
    return;
  }

  const prdLines = ['# Approved plan', ''];
  if (state === 'incomplete' || state === 'invalid' || state === 'ready') {
    prdLines.push(buildContextPackOutcome(canonicalContextPackRelativePath(state)), '');
  }
  prdLines.push(`Launch via omx team 1:executor "${approvedTask}"`);
  await writeFile(prdPath, prdLines.join('\n'));

  if (state !== 'missing-baseline') {
    await writeFile(testSpecPath, `# ${state} test spec\n`);
  }

  if (state === 'incomplete') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope']);
  }
  if (state === 'invalid') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
    await writeFile(testSpecPath, '# invalid drifted test spec\n');
  }
  if (state === 'ready') {
    await writeContextPack(cwd, state, prdPath, testSpecPath, ['scope', 'build', 'verify']);
  }

  await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
    prd_path: prdPath,
    task: approvedTask,
    command: `omx team 1:executor "${approvedTask}"`,
  });
}

// ── isScalingEnabled ──────────────────────────────────────────────────────────

describe('isScalingEnabled', () => {
  it('returns false when env var is not set', () => {
    assert.equal(isScalingEnabled({}), false);
  });

  it('returns false when env var is empty string', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '' }), false);
  });

  it('returns false when env var is "0"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '0' }), false);
  });

  it('returns false when env var is "false"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'false' }), false);
  });

  it('returns false when env var is "no"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'no' }), false);
  });

  it('returns true when env var is "1"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '1' }), true);
  });

  it('returns true when env var is "true"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'true' }), true);
  });

  it('returns true when env var is "yes"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'yes' }), true);
  });

  it('returns true when env var is "on"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'on' }), true);
  });

  it('returns true when env var is "enabled"', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'enabled' }), true);
  });

  it('returns true case-insensitively', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'TRUE' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'Yes' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: 'ON' }), true);
  });

  it('returns true with leading/trailing whitespace', () => {
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: '  1  ' }), true);
    assert.equal(isScalingEnabled({ OMX_TEAM_SCALING_ENABLED: ' true ' }), true);
  });
});

// ── WorkerStatus draining state ───────────────────────────────────────────────

describe('WorkerStatus draining state', () => {
  it('writeWorkerStatus writes draining status and readWorkerStatus reads it back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-drain-'));
    try {
      await initTeamState('drain-test', 'task', 'executor', 2, cwd);
      const drainingStatus = {
        state: 'draining' as const,
        reason: 'scale_down requested',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus('drain-test', 'worker-1', drainingStatus, cwd);
      const status = await readWorkerStatus('drain-test', 'worker-1', cwd);
      assert.equal(status.state, 'draining');
      assert.equal(status.reason, 'scale_down requested');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readWorkerStatus returns unknown for non-existent worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-nw-'));
    try {
      await initTeamState('nw-test', 'task', 'executor', 1, cwd);
      const status = await readWorkerStatus('nw-test', 'worker-99', cwd);
      assert.equal(status.state, 'unknown');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── Monotonic worker index counter ────────────────────────────────────────────

describe('Monotonic worker index counter', () => {
  it('initTeamState sets next_worker_index to workerCount + 1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-idx-'));
    try {
      const cfg = await initTeamState('idx-test', 'task', 'executor', 3, cwd);
      assert.equal(cfg.next_worker_index, 4);

      // Verify on disk
      const diskCfg = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'idx-test', 'config.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(diskCfg.next_worker_index, 4);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('next_worker_index is present in manifest.v2.json', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-manif-'));
    try {
      await initTeamState('manif-test', 'task', 'executor', 2, cwd);
      const manifest = JSON.parse(
        readFileSync(join(cwd, '.omx', 'state', 'team', 'manif-test', 'manifest.v2.json'), 'utf8'),
      ) as { next_worker_index?: number };
      assert.equal(manifest.next_worker_index, 3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('readTeamConfig preserves next_worker_index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-read-'));
    try {
      await initTeamState('read-test', 'task', 'executor', 5, cwd);
      const config = await readTeamConfig('read-test', cwd);
      assert.ok(config);
      assert.equal(config.next_worker_index, 6);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── File-based scaling lock ───────────────────────────────────────────────────

describe('withScalingLock', () => {
  it('acquires and releases lock for successful operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-'));
    try {
      await initTeamState('lock-test', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', 'team', 'lock-test', '.lock.scaling');

      const result = await withScalingLock('lock-test', cwd, async () => {
        // Lock should exist during execution
        assert.equal(existsSync(lockDir), true);
        return 42;
      });

      assert.equal(result, 42);
      // Lock should be released after execution
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('releases lock even when function throws', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-err-'));
    try {
      await initTeamState('lock-err', 'task', 'executor', 1, cwd);
      const lockDir = join(cwd, '.omx', 'state', 'team', 'lock-err', '.lock.scaling');

      await assert.rejects(
        withScalingLock('lock-err', cwd, async () => {
          throw new Error('test error');
        }),
        { message: 'test error' },
      );

      // Lock should be released after error
      assert.equal(existsSync(lockDir), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes concurrent operations', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-lock-con-'));
    try {
      await initTeamState('lock-con', 'task', 'executor', 1, cwd);
      const order: number[] = [];

      // Launch two operations concurrently - second should wait for first
      const op1 = withScalingLock('lock-con', cwd, async () => {
        order.push(1);
        await new Promise(r => setTimeout(r, 100));
        order.push(2);
        return 'first';
      });

      // Small delay to ensure op1 acquires lock first
      await new Promise(r => setTimeout(r, 10));

      const op2 = withScalingLock('lock-con', cwd, async () => {
        order.push(3);
        return 'second';
      });

      const [r1, r2] = await Promise.all([op1, op2]);
      assert.equal(r1, 'first');
      assert.equal(r2, 'second');
      // First operation should complete (1, 2) before second starts (3)
      assert.deepEqual(order, [1, 2, 3]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

// ── scaleUp / scaleDown error cases ──────────────────────────────────────────

describe('scaleUp', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleUp('test', 1, 'executor', [], '/tmp', {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error for invalid count', async () => {
    const result = await scaleUp(
      'test', 0, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error for negative count', async () => {
    const result = await scaleUp(
      'test', -1, 'executor', [], '/tmp',
      { OMX_TEAM_SCALING_ENABLED: '1' },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /count must be a positive integer/);
    }
  });

  it('returns error when tmux is not available', async () => {
    // Temporarily remove PATH so tmux binary is not found
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    try {
      const result = await scaleUp(
        'test', 1, 'executor', [], '/tmp',
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /tmux is not available/);
      }
    } finally {
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
    }
  });


  it('persists scaled-up task roles in canonical task state and inbox ids', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-role-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '\%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    echo "42424"',
          '    ;;',
          '  send-keys)',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-role', 'task', 'executor', 1, cwd);
      await createTask('scale-up-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-role';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-role',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const createdTask = await readTask('scale-up-role', '2', cwd);
      assert.equal(createdTask?.role, 'writer');
      assert.equal(createdTask?.owner, 'worker-2');

      const workerIdentity = JSON.parse(await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'identity.json'), 'utf-8')) as { role?: string };
      assert.equal(workerIdentity.role, 'writer');

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-role', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.match(inbox, /Task 2/);
      assert.match(inbox, /Role: writer/);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-role'
      )));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('rolls back a scaled worker pane when team owner tagging fails', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-owner-tag-rollback-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  set-option)',
          '    case "$*" in',
          '      *"@omx_team_pane_owner_id"*)',
          '        echo "owner tag failed" >&2',
          '        exit 1',
          '        ;;',
          '    esac',
          '    ;;',
          '  list-panes)',
          '    echo "42424"',
          '    ;;',
          '  kill-pane|send-keys|capture-pane)',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-up-owner-tag-rollback', 'task', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch('scale-up-owner-tag-rollback', cwd);

      const result = await scaleUp(
        'scale-up-owner-tag-rollback',
        1,
        'executor',
        [{ subject: 'new work', description: 'new work', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /Failed to tag tmux pane for worker-2/);

      const config = await readTeamConfig('scale-up-owner-tag-rollback', cwd);
      assert.equal(config?.workers.length, 1);
      assert.equal(await readTask('scale-up-owner-tag-rollback', '1', cwd), null);

      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.ok(tmuxCommands.some((command) => (
        command === 'set-option -p -t %31 @omx_team_pane_owner_id team:scale-up-owner-tag-rollback'
      )));
      assert.ok(tmuxCommands.some((command) => command === 'kill-pane -t %31'));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects persisted leader-owned Ultragoal context into scaled worker inboxes', async () => {
    const teamName = 'scale-up-ultragoal-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-ultragoal-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'ultragoal scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      const teamStateRoot = resolveCanonicalTeamStateRoot(cwd);
      await mkdir(join(teamStateRoot, 'team', teamName), { recursive: true });
      await writeFile(
        join(teamStateRoot, 'team', teamName, 'ultragoal-context.json'),
        `${JSON.stringify({
          kind: 'leader_owned_ultragoal_context',
          goalsPath: '.omx/ultragoal/goals.json',
          ledgerPath: '.omx/ultragoal/ledger.jsonl',
          activeGoalId: 'G001-team-runtime-bridge',
          activeGoalTitle: 'Team runtime bridge',
          codexGoalMode: 'aggregate',
          checkpointPolicy: 'fresh_leader_get_goal_required',
        })}\n`,
      );

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement ultragoal follow-up', description: 'Implement ultragoal follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inboxStateRoot = result.addedWorkers[0]?.team_state_root ?? resolveCanonicalTeamStateRoot(cwd);
      const inbox = await readFile(
        join(inboxStateRoot, 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement ultragoal follow-up/);
      assert.match(inbox, /### Leader-owned Ultragoal context/);
      assert.match(inbox, /G001-team-runtime-bridge/);
      assert.match(inbox, /workers do not own Ultragoal goal state/i);
      assert.match(inbox, /omx ultragoal checkpoint --goal-id G001-team-runtime-bridge/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('keeps scale-up on the generic path when no approved binding is persisted', async () => {
    const teamName = 'scale-up-no-approved-binding';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-no-approved-binding-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'generic scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement generic follow-up', description: 'Implement generic follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement generic follow-up/);
      assert.doesNotMatch(inbox, /## Approved Handoff Context/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context on scale-up when the persisted binding is baseline-ready without context-pack metadata', async () => {
    const teamName = 'scale-up-plan-only';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-plan-only-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'plan-only scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);
      await prepareScaleUpApprovedBindingState(teamName, cwd, 'plan-only');

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement plan-only follow-up', description: 'Implement plan-only follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /Implement plan-only follow-up/);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('injects approved handoff context into scaled worker inboxes when the persisted binding stays ready', async () => {
    const teamName = 'scale-up-approved-context';
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-approved-context-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const previousPath = process.env.PATH;
    const approvedTask = 'Execute approved issue 1410 plan';

    try {
      await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState(teamName, 'approved scale-up test', 'executor', 1, cwd);
      await configureScaleUpTeamForDirectDispatch(teamName, cwd);

      const plansDir = join(cwd, '.omx', 'plans');
      await mkdir(plansDir, { recursive: true });
      const prdPath = join(plansDir, 'prd-issue-1410.md');
      const testSpecPath = join(plansDir, 'test-spec-issue-1410.md');
      await writeFile(
        prdPath,
        [
          '# Approved plan',
          '',
          buildContextPackOutcome(canonicalContextPackRelativePath('issue-1410')),
          '',
          `Launch via omx team 1:executor "${approvedTask}"`,
        ].join('\n'),
      );
      await writeFile(testSpecPath, '# Test spec\n');
      await writeReadyContextPack(cwd, 'issue-1410', prdPath, testSpecPath);
      await writeFile(
        join(plansDir, 'repo-context-issue-1410.md'),
        'Read the approved repository slice first.\n',
      );
      await writePersistedApprovedTeamExecutionBinding(teamName, cwd, {
        prd_path: prdPath,
        task: approvedTask,
        command: `omx team 1:executor "${approvedTask}"`,
      });

      assert.equal(await readExpectedScaleUpApprovedBindingError(teamName, cwd), null);

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(
        join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md'),
        'utf-8',
      );
      const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
      assert.match(inbox, /## Approved Handoff Context/);
      assert.ok(inbox.includes(`Approved plan: ${prdPath}`));
      assert.ok(inbox.includes(`Test specs: ${testSpecPath}`));
      assert.match(inbox, /Approved repository context summary source: .*repo-context-issue-1410\.md/);
      assert.match(inbox, /Read the approved repository slice first\./);
      assert.match(inbox, /Use the approved plan and matching test specs as the execution baseline/);
      assert.doesNotMatch(inbox, /Approved context pack|Build refs|Verify refs|Scope refs|query the canonical pack|Context pack index/);
      assert.ok(tmuxCommands.some((command) => command.startsWith('split-window ')));
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('proves the approved-binding scale-up model across generated state/count scenarios, including forbidden counterfactuals', async () => {
    for (const state of SCALE_UP_APPROVED_BINDING_STATES) {
      for (const count of SCALE_UP_COUNTS) {
        const teamName = `su-model-${SCALE_UP_STATE_TEAM_SUFFIX[state]}-${count}`;
        const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-`));
        const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-model-${state}-${count}-bin-`));
        const tmuxLogPath = join(fakeBinDir, 'tmux.log');
        const previousPath = process.env.PATH;

        try {
          await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
          process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

          await initTeamState(teamName, `approved ${state} scale-up model`, 'executor', 1, cwd);
          await configureScaleUpTeamForDirectDispatch(teamName, cwd);

          if (state !== 'missing') {
            await prepareScaleUpApprovedBindingState(teamName, cwd, state);
          }

          const expectedOutcome = expectedScaleUpOutcome(state);
          const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
          const tasks = buildScaleUpScenarioTasks(state, count);

          const result = await scaleUp(
            teamName,
            count,
            'executor',
            tasks,
            cwd,
            { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
          );
          const tmuxCommands = await readScaleUpTmuxLogCommands(tmuxLogPath);
          const splitWindowCommands = tmuxCommands.filter((command) => command.startsWith('split-window '));
          const inboxes = await Promise.all(tasks.map(async (task) => {
            const inboxPath = join(
              cwd,
              '.omx',
              'state',
              'team',
              teamName,
              'workers',
              task.owner,
              'inbox.md',
            );
            return existsSync(inboxPath)
              ? await readFile(inboxPath, 'utf-8')
              : null;
          }));
          const approvedInboxCount = inboxes.filter((inbox) =>
            typeof inbox === 'string' && inbox.includes('## Approved Handoff Context')
          ).length;
          assert.ok(
            approvedInboxCount === 0 || approvedInboxCount === tasks.length,
            `expected approved handoff context presence to stay consistent across all scaled workers (state=${state} count=${count})`,
          );
          const observedOutcome: ScaleUpObservedOutcome = !result.ok
            ? 'blocked'
            : approvedInboxCount === tasks.length
              ? 'approved'
              : 'generic';
          const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);

          assert.equal(observedOutcome, expectedOutcome, `state=${state} count=${count}`);
          assert.equal(
            forbiddenScaleUpOutcomes(state).includes(observedOutcome),
            false,
            `state=${state} count=${count} produced forbidden counterfactual outcome ${observedOutcome}`,
          );
          if (expectedOutcome === 'blocked') {
            assert.equal(result.ok, false);
            if (result.ok) {
              throw new Error(`expected blocked scale-up outcome for ${state} count=${count}`);
            }
            assert.equal(result.error, expectedError);
            assert.deepEqual(tmuxCommands, ['-V']);
            assert.deepEqual(splitWindowCommands, []);
            assert.ok(inboxes.every((inbox) => inbox === null));
            assert.equal(
              taskPayloads.some((payload) => tasks.some((task) => payload.includes(task.subject))),
              false,
            );

            const config = await readTeamConfig(teamName, cwd);
            assert.ok(config);
            if (!config) {
              throw new Error(`missing team config for ${teamName}`);
            }
            assert.equal(config.workers.length, 1);
            assert.equal(config.worker_count, 1);
            assert.equal(config.next_worker_index, 2);
            continue;
          }

          assert.equal(result.ok, true);
          if (!result.ok) {
            throw new Error(`expected successful scale-up outcome for ${state} count=${count}`);
          }
          assert.equal(result.newWorkerCount, 1 + count);
          assert.equal(result.nextWorkerIndex, 2 + count);
          assert.equal(splitWindowCommands.length, count);
          assert.equal(expectedError, null);
          assert.ok(inboxes.every((inbox): inbox is string => typeof inbox === 'string'));

          for (const [index, inbox] of inboxes.entries()) {
            const task = tasks[index]!;
            assert.ok(inbox.includes(task.subject), `expected inbox to include task subject ${task.subject}`);
          }
          assert.equal(
            taskPayloads.filter((payload) => tasks.some((task) => payload.includes(task.subject))).length,
            count,
          );
          if (expectedOutcome === 'approved') {
            assert.ok(inboxes.every((inbox) => inbox.includes('## Approved Handoff Context')));
          } else {
            assert.ok(inboxes.every((inbox) => !inbox.includes('## Approved Handoff Context')));
          }
        } finally {
          if (typeof previousPath === 'string') process.env.PATH = previousPath;
          else delete process.env.PATH;
          await rm(cwd, { recursive: true, force: true });
          await rm(fakeBinDir, { recursive: true, force: true });
        }
      }
    }
  });

  for (const state of BLOCKED_SCALE_UP_APPROVED_BINDING_STATES) {
    it(`fails closed before worker launch when the persisted approved binding is ${state}`, async () => {
      const teamName = `su-block-${SCALE_UP_STATE_TEAM_SUFFIX[state]}`;
      const cwd = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-`));
      const fakeBinDir = await mkdtemp(join(tmpdir(), `omx-scale-up-approved-${state}-bin-`));
      const tmuxLogPath = join(fakeBinDir, 'tmux.log');
      const previousPath = process.env.PATH;

      try {
        await writeSuccessfulScaleUpTmuxStub(fakeBinDir, tmuxLogPath);
        process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

        await initTeamState(teamName, `approved ${state} scale-up test`, 'executor', 1, cwd);
        await configureScaleUpTeamForDirectDispatch(teamName, cwd);
        await prepareScaleUpApprovedBindingState(teamName, cwd, state);

        const expectedError = await readExpectedScaleUpApprovedBindingError(teamName, cwd);
        assert.ok(expectedError);

        const result = await scaleUp(
          teamName,
          1,
          'executor',
          [{ subject: 'Implement approved follow-up', description: 'Implement approved follow-up', owner: 'worker-2' }],
          cwd,
          { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
        );
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.error, expectedError);

        const config = await readTeamConfig(teamName, cwd);
        assert.ok(config);
        if (!config) return;
        assert.equal(config.workers.length, 1);
        assert.equal(config.worker_count, 1);
        assert.equal(config.next_worker_index, 2);

        const taskPayloads = await readScaleUpTaskPayloads(teamName, cwd);
        assert.equal(
          taskPayloads.some((payload) => payload.includes('Implement approved follow-up')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'identity.json')),
          false,
        );
        assert.equal(
          existsSync(join(cwd, '.omx', 'state', 'team', teamName, 'workers', 'worker-2', 'inbox.md')),
          false,
        );
        assert.deepEqual(await readScaleUpTmuxLogCommands(tmuxLogPath), ['-V']);
      } finally {
        if (typeof previousPath === 'string') process.env.PATH = previousPath;
        else delete process.env.PATH;
        await rm(cwd, { recursive: true, force: true });
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    });
  }


  it('uses project-scoped CODEX_HOME for scaled worker reasoning and model defaults', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-project-reasoning-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    const previousStandardModel = process.env.OMX_DEFAULT_STANDARD_MODEL;
    const previousFrontierModel = process.env.OMX_DEFAULT_FRONTIER_MODEL;
    const previousCodeHome = process.env.CODEX_HOME;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%31"',
          '    ;;',
          '  list-panes)',
          '    echo "42424"',
          '    ;;',
          '  send-keys)',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;
      delete process.env.CODEX_HOME;
      delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      delete process.env.OMX_DEFAULT_FRONTIER_MODEL;

      await mkdir(join(cwd, '.omx'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'setup-scope.json'), JSON.stringify({ scope: 'project' }));
      await mkdir(join(cwd, '.codex'), { recursive: true });
      await writeFile(join(cwd, '.codex', '.omx-config.json'), JSON.stringify({
        env: {
          OMX_DEFAULT_STANDARD_MODEL: 'project-standard-model',
        },
        agentReasoning: {
          writer: 'xhigh',
        },
      }));
      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('scale-up-project-reasoning', 'task', 'executor', 1, cwd);
      await createTask('scale-up-project-reasoning', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('scale-up-project-reasoning', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-project-reasoning';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-project-reasoning',
        1,
        'executor',
        [{ subject: 'document routing report only', description: 'document routing report only', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      const startupScript = await readFile(
        workerStartupScriptPath(cwd, 'scale-up-project-reasoning', 'worker-2'),
        'utf-8',
      );
      assert.match(tmuxLog, /worker-2-startup\.sh/);
      assert.match(startupScript, /CODEX_HOME=.*\.codex/);
      assert.match(startupScript, /model_reasoning_effort="xhigh"/);
      assert.match(startupScript, /--model/);
      assert.match(startupScript, /project-standard-model/);

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'scale-up-project-reasoning', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(workerAgents, /resolved_model: project-standard-model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousStandardModel === 'string') process.env.OMX_DEFAULT_STANDARD_MODEL = previousStandardModel;
      else delete process.env.OMX_DEFAULT_STANDARD_MODEL;
      if (typeof previousFrontierModel === 'string') process.env.OMX_DEFAULT_FRONTIER_MODEL = previousFrontierModel;
      else delete process.env.OMX_DEFAULT_FRONTIER_MODEL;
      if (typeof previousCodeHome === 'string') process.env.CODEX_HOME = previousCodeHome;
      else delete process.env.CODEX_HOME;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });


  it('removes generated worktree-root AGENTS when scale-up rolls back', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-rollback-worktree-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  send-keys)
    exit 1
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('rollback-worktree', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('rollback-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-rollback-worktree';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'rollback-worktree', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'rollback-worktree',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /scale_up_dispatch_failed:worker-2/);

      const workerRootAgents = join(cwd, '.omx', 'team', 'rollback-worktree', 'worktrees', 'worker-2', 'AGENTS.md');
      assert.equal(await readFile(workerRootAgents, 'utf-8'), '# Root project instructions\n');
      const backupPath = join(cwd, '.git', 'worktrees', 'worker-2', 'omx', 'root-agents-backup.json');
      assert.equal(existsSync(backupPath), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('uses canonical root AGENTS bootstrap for scaled worktree workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-canonical-root-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
	case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('canonical-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('canonical-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-canonical-root';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'canonical-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'canonical-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const inbox = await readFile(join(cwd, '.omx', 'state', 'team', 'canonical-root', 'workers', 'worker-2', 'inbox.md'), 'utf-8');
      assert.doesNotMatch(inbox, /## Your Specialization/);
      assert.match(inbox, /\*\*Role:\*\* writer/);

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'canonical-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.match(rootAgents, /exact gpt-5\.6-terra model/);
      assert.match(rootAgents, /strict execution order: inspect -> plan -> act -> verify/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up when the final worker model is gpt-5.6-sol', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-frontier-role-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'test-engineer.md'), '<identity>Test Engineer</identity>');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'frontier-role'), { recursive: true });
      await writeFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'worker-agents.md'), '# Base worker instructions\n');

      await initTeamState('frontier-role', 'task', 'executor', 1, cwd);
      await createTask('frontier-role', {
        subject: 'existing task',
        description: 'already persisted',
        status: 'pending',
        owner: 'worker-1',
      }, cwd);

      const config = await readTeamConfig('frontier-role', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-frontier-role';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'frontier-role', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'frontier-role',
        1,
        'executor',
        [{ subject: 'test routing report only', description: 'test routing report only', owner: 'worker-2', role: 'test-engineer' }],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const workerAgents = await readFile(join(cwd, '.omx', 'state', 'team', 'frontier-role', 'workers', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(workerAgents, /You are operating as the \*\*test-engineer\*\* role/);
      assert.match(workerAgents, /<identity>Test Engineer<\/identity>/);
      assert.doesNotMatch(workerAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('does not apply mini guidance during scale-up for gpt-5.6-terra-tuned overrides', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-mini-tuned-bin-'));
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await mkdir(join(cwd, '.codex', 'prompts'), { recursive: true });
      await writeFile(join(cwd, '.codex', 'prompts', 'writer.md'), '<identity>You are Writer.</identity>');
      await writeFile(join(cwd, 'AGENTS.md'), '# Root project instructions\n');
      await initCommittedGitRepo(cwd);
      await initTeamState('mini-tuned-root', 'task', 'executor', 1, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const config = await readTeamConfig('mini-tuned-root', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-mini-tuned-root';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'mini-tuned-root', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'mini-tuned-root',
        1,
        'executor',
        [{ subject: 'write docs', description: 'write docs', owner: 'worker-2', role: 'writer' }],
        cwd,
        {
          OMX_TEAM_SCALING_ENABLED: '1',
          OMX_TEAM_SKIP_READY_WAIT: '1',
          OMX_TEAM_WORKER_LAUNCH_ARGS: '--model gpt-5.6-terra-tuned',
        },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const rootAgents = await readFile(join(cwd, '.omx', 'team', 'mini-tuned-root', 'worktrees', 'worker-2', 'AGENTS.md'), 'utf-8');
      assert.match(rootAgents, /You are operating as the \*\*writer\*\* role/);
      assert.match(rootAgents, /<identity>You are Writer\.<\/identity>/);
      assert.doesNotMatch(rootAgents, /exact gpt-5\.6-terra model/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves leader/HUD layout by avoiding tiled relayout during scale-up', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-layout-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  -V)
    echo "tmux 3.2a"
    ;;
  split-window)
    echo "%31"
    ;;
  list-panes)
    echo "42424"
    ;;
  capture-pane)
    echo ""
    ;;
esac
exit 0
`,
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('scale-up-layout', 'task', 'executor', 1, cwd);

      const config = await readTeamConfig('scale-up-layout', cwd);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = 'omx-team-scale-up-layout';
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, cwd);

      const manifestPath = join(cwd, '.omx', 'state', 'team', 'scale-up-layout', 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        'scale-up-layout',
        1,
        'executor',
        [],
        cwd,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.match(tmuxLog, /split-window -v -t %21/);
      assert.doesNotMatch(tmuxLog, /select-layout .*tiled/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions detached worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-detached-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%41"',
          '    ;;',
          '  show-option)',
          '    echo "team:scale-up-detached-worktree"',
          '    ;;',
          '  list-panes)',
          '    echo "45454"',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-detached-worktree';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: true, name: null },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: true, name: null });
      assert.ok(worker?.worktree_path, 'scaled worker should have detached worktree path');
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, true);
      assert.equal(worker?.worktree_created, true);
      assert.equal(
        worker?.worktree_base_ref,
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim(),
      );
      const workerPath = worker?.worktree_path as string;
      assert.equal(existsSync(workerPath), true);
      assert.throws(
        () => execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: workerPath, stdio: 'pipe' }),
      );

      const workerOutput = join(workerPath, 'worker-output.txt');
      await writeFile(workerOutput, 'preserve me\n');
      await writeWorkerStatus(teamName, 'worker-2', {
        state: 'working',
        current_task_id: 'scale-down-preserve',
        updated_at: '2026-07-27T00:00:00.000Z',
      }, repo);
      await writeFile(tmuxLogPath, '');
      const preserved = await scaleDown(
        teamName,
        repo,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(preserved.ok, false);
      if (preserved.ok) return;
      assert.match(preserved.error, /scale_down_worktree_preserved/);
      assert.equal(existsSync(workerOutput), true);
      assert.ok((await readTeamConfig(teamName, repo))?.workers.some((entry) => entry.name === 'worker-2'));
      assert.equal((await readWorkerStatus(teamName, 'worker-2', repo)).state, 'working');
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane -t %41/);

      await rm(workerOutput);
      const removed = await scaleDown(
        teamName,
        repo,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(removed.ok, true);
      assert.equal(existsSync(workerPath), false);
      assert.equal((await readTeamConfig(teamName, repo))?.workers.some((entry) => entry.name === 'worker-2'), false);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('provisions named worktrees for scaled-up workers from persisted team worktree mode', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-up-named-bin-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;

    try {
      await writeFile(
        tmuxStubPath,
        [
          '#!/bin/sh',
          'set -eu',
          `printf '%s\n' "$*" >> "${tmuxLogPath}"`,
          'case "${1:-}" in',
          '  -V)',
          '    echo "tmux 3.2a"',
          '    ;;',
          '  split-window)',
          '    echo "%42"',
          '    ;;',
          '  list-panes)',
          '    echo "46464"',
          '    ;;',
          '  capture-pane)',
          '    echo ""',
          '    ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
      );
      await chmod(tmuxStubPath, 0o755);
      await writeFile(tmuxLogPath, '');
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const teamName = 'scale-up-named-worktree';
      const branchBase = 'feature/team-scale';
      await mkdir(join(repo, '.omx', 'state', 'team', teamName), { recursive: true });
      await writeFile(join(repo, '.omx', 'state', 'team', teamName, 'worker-agents.md'), '# Base worker instructions\n');
      await initTeamState(
        teamName,
        'task',
        'executor',
        1,
        repo,
        DEFAULT_MAX_WORKERS,
        process.env,
        {
          leader_cwd: repo,
          team_state_root: join(repo, '.omx', 'state'),
          workspace_mode: 'worktree',
          worktree_mode: { enabled: true, detached: false, name: branchBase },
        },
      );

      const config = await readTeamConfig(teamName, repo);
      assert.ok(config);
      if (!config) return;
      config.tmux_session = `omx-team-${teamName}`;
      config.leader_pane_id = '%11';
      config.workers[0]!.pane_id = '%21';
      await saveTeamConfig(config, repo);

      const manifestPath = join(repo, '.omx', 'state', 'team', teamName, 'manifest.v2.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as { policy?: Record<string, unknown> };
      manifest.policy = {
        ...(manifest.policy ?? {}),
        dispatch_mode: 'transport_direct',
      };
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

      const result = await scaleUp(
        teamName,
        1,
        'executor',
        [],
        repo,
        { OMX_TEAM_SCALING_ENABLED: '1', OMX_TEAM_SKIP_READY_WAIT: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      const updated = await readTeamConfig(teamName, repo);
      const worker = updated?.workers.find((entry) => entry.name === 'worker-2');
      assert.deepEqual(updated?.worktree_mode, { enabled: true, detached: false, name: branchBase });
      assert.equal(worker?.worktree_branch, `${branchBase}/worker-2`);
      assert.equal(worker?.working_dir, worker?.worktree_path);
      assert.equal(worker?.worktree_detached, false);
      assert.equal(worker?.worktree_created, true);
      assert.equal(existsSync(worker?.worktree_path as string), true);
      assert.equal(
        execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: worker?.worktree_path, encoding: 'utf-8' }).trim(),
        `${branchBase}/worker-2`,
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});

describe('scaleDown', () => {
  it('rejects when scaling is disabled', async () => {
    await assert.rejects(
      scaleDown('test', '/tmp', {}, {}),
      /Dynamic scaling is disabled/,
    );
  });

  it('returns error when team not found', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-nf-'));
    try {
      const result = await scaleDown(
        'nonexistent', cwd, {},
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('fails before teardown when detached worktree baseline is missing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-baseline-missing-'));
    try {
      await initTeamState('baseline-missing', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('baseline-missing', cwd);
      assert.ok(config);
      if (!config) return;
      const workerPath = join(cwd, 'worker-2');
      await mkdir(workerPath);
      Object.assign(config.workers[1]!, {
        worktree_created: true,
        worktree_detached: true,
        worktree_repo_root: cwd,
        worktree_path: workerPath,
      });
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'baseline-missing',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error, 'scale_down_worktree_baseline_missing:worker-2');
      assert.equal(existsSync(workerPath), true);
      assert.ok((await readTeamConfig('baseline-missing', cwd))?.workers.some((worker) => worker.name === 'worker-2'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when trying to remove all workers', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-all-'));
    try {
      await initTeamState('all-test', 'task', 'executor', 1, cwd);
      const result = await scaleDown(
        'all-test', cwd,
        { workerNames: ['worker-1'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /at least 1 must remain/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error for worker not in team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-miss-'));
    try {
      await initTeamState('miss-test', 'task', 'executor', 2, cwd);
      const result = await scaleDown(
        'miss-test', cwd,
        { workerNames: ['worker-99'] },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Worker worker-99 not found/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns error when not enough idle workers and force=false', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-busy-'));
    try {
      await initTeamState('busy-test', 'task', 'executor', 2, cwd);
      // Write working status for both workers
      await writeWorkerStatus('busy-test', 'worker-1', {
        state: 'working',
        current_task_id: 't-1',
        updated_at: new Date().toISOString(),
      }, cwd);
      await writeWorkerStatus('busy-test', 'worker-2', {
        state: 'working',
        current_task_id: 't-2',
        updated_at: new Date().toISOString(),
      }, cwd);
      const result = await scaleDown(
        'busy-test', cwd,
        { count: 1 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error, /Not enough idle workers/);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('serializes timeout restoration against a worker completion write', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-status-race-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-status-race-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const workerThreeStatusPath = join(cwd, '.omx', 'state', 'team', 'status-race', 'workers', 'worker-3', 'status.json');
    const previousPath = process.env.PATH;
    const previousInternalWorker = process.env.OMX_TEAM_INTERNAL_WORKER;
    const previousWorker = process.env.OMX_TEAM_WORKER;
    let releaseRestore: (() => void) | undefined;
    try {
      await initTeamState('status-race', 'task', 'executor', 3, cwd);
      const config = await readTeamConfig('status-race', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%22';
      config.workers[2]!.pane_id = '%23';
      await saveTeamConfig(config, cwd);
      for (const workerName of ['worker-2', 'worker-3']) {
        await writeWorkerStatus('status-race', workerName, {
          state: 'working',
          current_task_id: `task-${workerName}`,
          updated_at: new Date().toISOString(),
        }, cwd);
      }

      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option)
    echo "${config.tmux_pane_owner_id}"
    ;;
  list-panes)
    printf '%%22 0\\n%%23 0\\n'
    ;;
esac
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      let pauseRestore = false;
      let signalRestoreCompared: (() => void) | undefined;
      const restoreCompared = new Promise<void>((resolve) => {
        signalRestoreCompared = resolve;
      });
      const restoreReleased = new Promise<void>((resolve) => {
        releaseRestore = resolve;
      });
      setWriteAtomicRenameForTests(async (from, to) => {
        if (pauseRestore && to === workerThreeStatusPath) {
          pauseRestore = false;
          signalRestoreCompared?.();
          await restoreReleased;
        }
        await rename(from, to);
      });

      const prepareRace = (async () => {
        const deadline = Date.now() + 1_000;
        while (true) {
          const [workerTwo, workerThree] = await Promise.all([
            readWorkerStatus('status-race', 'worker-2', cwd),
            readWorkerStatus('status-race', 'worker-3', cwd),
          ]);
          if (workerTwo.state === 'draining' && workerThree.state === 'draining') break;
          if (Date.now() >= deadline) throw new Error('workers never entered draining state');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await writeWorkerStatus('status-race', 'worker-2', {
          state: 'done',
          updated_at: new Date().toISOString(),
        }, cwd);
        pauseRestore = true;
      })();
      const scaleDownResult = scaleDown(
        'status-race',
        cwd,
        { workerNames: ['worker-2', 'worker-3'], drainTimeoutMs: 100 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      await prepareRace;
      await restoreCompared;

      process.env.OMX_TEAM_INTERNAL_WORKER = 'status-race/worker-3';
      delete process.env.OMX_TEAM_WORKER;
      const completedWrite = executeTeamApiOperation('write-worker-status', {
        team_name: 'status-race',
        worker: 'worker-3',
        state: 'done',
      }, cwd);
      if (!releaseRestore) throw new Error('restore release barrier missing');
      const release = releaseRestore;
      releaseRestore = undefined;
      release();
      const [result, completionResult] = await Promise.all([scaleDownResult, completedWrite]);

      assert.deepEqual(result, { ok: false, error: 'scale_down_drain_timeout:worker-3' });
      assert.equal(completionResult.ok, true);
      assert.equal((await readWorkerStatus('status-race', 'worker-2', cwd)).state, 'done');
      assert.equal((await readWorkerStatus('status-race', 'worker-3', cwd)).state, 'done');
      assert.equal((await readTeamConfig('status-race', cwd))?.workers.length, 3);
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane/);
    } finally {
      releaseRestore?.();
      resetWriteAtomicRenameForTests();
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      if (typeof previousInternalWorker === 'string') process.env.OMX_TEAM_INTERNAL_WORKER = previousInternalWorker;
      else delete process.env.OMX_TEAM_INTERNAL_WORKER;
      if (typeof previousWorker === 'string') process.env.OMX_TEAM_WORKER = previousWorker;
      else delete process.env.OMX_TEAM_WORKER;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves a busy worker after non-force drain timeout and force still tears it down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-drain-timeout-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-drain-timeout-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await initTeamState('drain-timeout', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('drain-timeout', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%22';
      await saveTeamConfig(config, cwd);
      await writeWorkerStatus('drain-timeout', 'worker-2', {
        state: 'working',
        current_task_id: 't-2',
        updated_at: new Date().toISOString(),
      }, cwd);

      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option)
    echo "${config.tmux_pane_owner_id}"
    ;;
  list-panes)
    echo "%22 0"
    ;;
esac
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      const timedOut = await scaleDown(
        'drain-timeout',
        cwd,
        { workerNames: ['worker-2'], drainTimeoutMs: 0 },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.deepEqual(timedOut, { ok: false, error: 'scale_down_drain_timeout:worker-2' });
      assert.equal((await readTeamConfig('drain-timeout', cwd))?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.equal((await readWorkerStatus('drain-timeout', 'worker-2', cwd)).state, 'working');
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane -t %22/);

      const forced = await scaleDown(
        'drain-timeout',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(forced.ok, true);
      assert.equal((await readTeamConfig('drain-timeout', cwd))?.workers.some((worker) => worker.name === 'worker-2'), false);
      assert.match(await readFile(tmuxLogPath, 'utf-8'), /kill-pane -t %22/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});


describe('scaleDown worktree AGENTS cleanup', () => {
  it('removes generated worktree-root AGENTS during scale-down', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-worktree-agents-'));
    try {
      await initTeamState('scale-down-worktree', 'task', 'executor', 2, cwd, undefined, process.env, {
        workspace_mode: 'worktree',
        leader_cwd: cwd,
        team_state_root: join(cwd, '.omx', 'state'),
      });

      const worktree = join(cwd, '.omx', 'team', 'scale-down-worktree', 'worktrees', 'worker-2');
      await mkdir(worktree, { recursive: true });
      await writeFile(join(worktree, 'AGENTS.md'), '# Tracked root instructions\n', 'utf8');
      await mkdir(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2'), { recursive: true });
      await writeFile(
        join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json'),
        JSON.stringify({
          existed: true,
          tracked: false,
          previousContent: '# Tracked root instructions\n',
          ownershipToken: 'test-owner',
          generatedContent: '# Generated runtime instructions\n',
        }, null, 2),
        'utf8',
      );
      await writeFile(join(worktree, 'AGENTS.md'), '# Generated runtime instructions\n', 'utf8');

      const config = await readTeamConfig('scale-down-worktree', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.worktree_path = worktree;
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'scale-down-worktree',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;

      assert.equal(await readFile(join(worktree, 'AGENTS.md'), 'utf-8'), '# Tracked root instructions\n');
      assert.equal(existsSync(join(cwd, '.omx', 'state', 'team', 'scale-down-worktree', 'workers', 'worker-2', 'root-agents-backup.json')), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('scaleDown teardown hardening', () => {
  it('treats a typed missing pane as an already terminated worker', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-dead-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-dead-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "\${1:-}" = "show-option" ]; then
  echo "can't find pane: %404" >&2
  exit 2
fi
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('dead-pane', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('dead-pane', cwd);
      assert.ok(config);
      if (!config) return;

      config.workers[1]!.pane_id = '%404';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'dead-pane',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.deepEqual(result.removedWorkers, ['worker-2']);

      const updated = await readTeamConfig('dead-pane', cwd);
      assert.ok(updated);
      assert.equal(updated?.workers.some((worker) => worker.name === 'worker-2'), false);
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when pane ownership cannot be read for a live target', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-owner-read-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-owner-read-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "\${1:-}" = "show-option" ]; then
  echo "owner read failed" >&2
  exit 2
fi
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('owner-read', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('owner-read', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%22';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'owner-read',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /^scale_down_pane_owner_read_failed:worker-2:%22:/);
      assert.equal((await readTeamConfig('owner-read', cwd))?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('fails closed when pane belongs to another team', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-foreign-pane-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-foreign-pane-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "\${1:-}" = "show-option" ]; then
  echo "team:another-team"
fi
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('foreign-pane', 'task', 'executor', 2, cwd);
      const config = await readTeamConfig('foreign-pane', cwd);
      assert.ok(config);
      if (!config) return;
      config.workers[1]!.pane_id = '%22';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'foreign-pane',
        cwd,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error, 'scale_down_pane_owner_mismatch:worker-2:%22');
      assert.equal((await readTeamConfig('foreign-pane', cwd))?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('checkpoints hidden AGENTS edits before preserving dirty worktree ownership', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-hidden-agents-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(join(repo, 'AGENTS.md'), '# Original instructions\n');
      execFileSync('git', ['add', 'AGENTS.md'], { cwd: repo, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add agents'], { cwd: repo, stdio: 'pipe' });
      const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      const worktreePath = join(repo, 'worker-2');
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd: repo, stdio: 'pipe' });
      execFileSync('git', ['update-index', '--skip-worktree', 'AGENTS.md'], { cwd: worktreePath, stdio: 'pipe' });
      await writeFile(join(worktreePath, 'AGENTS.md'), '# Worker-owned edit\n');
      const backupPath = execFileSync(
        'git',
        ['rev-parse', '--git-path', 'omx/root-agents-backup.json'],
        { cwd: worktreePath, encoding: 'utf-8' },
      ).trim();
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, JSON.stringify({
        existed: true,
        tracked: true,
        previousContent: '# Original instructions\n',
        skipWorktreeApplied: true,
      }));

      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "\${1:-}" = "show-option" ]; then
  echo "team:hidden-agents"
fi
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('hidden-agents', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('hidden-agents', repo);
      assert.ok(config);
      if (!config) return;
      Object.assign(config.workers[1]!, {
        pane_id: '%22',
        worktree_created: true,
        worktree_detached: true,
        worktree_repo_root: repo,
        worktree_path: worktreePath,
        worktree_base_ref: baseRef,
      });
      await saveTeamConfig(config, repo);
      await writeWorkerStatus('hidden-agents', 'worker-2', {
        state: 'working',
        current_task_id: 'hidden-agents-edit',
        updated_at: '2026-07-27T00:00:00.000Z',
      }, repo);

      const result = await scaleDown(
        'hidden-agents',
        repo,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /^scale_down_worktree_preserved:/);
      assert.equal(await readFile(join(worktreePath, 'AGENTS.md'), 'utf-8'), '# Worker-owned edit\n');
      assert.match(
        execFileSync('git', ['ls-files', '-v', '--', 'AGENTS.md'], { cwd: worktreePath, encoding: 'utf-8' }),
        /^S /,
      );
      assert.equal((await readTeamConfig('hidden-agents', repo))?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.equal((await readWorkerStatus('hidden-agents', 'worker-2', repo)).state, 'working');
      assert.doesNotMatch(await readFile(tmuxLogPath, 'utf-8'), /kill-pane/);
      const salvageRef = execFileSync(
        'git',
        [
          'for-each-ref',
          '--sort=-creatordate',
          '--count=1',
          '--format=%(refname)',
          'refs/heads/salvage/team-scale-down-hidden-agents-worker-2-*',
        ],
        { cwd: repo, encoding: 'utf-8' },
      ).trim();
      assert.ok(salvageRef);
      assert.equal(
        execFileSync('git', ['show', `${salvageRef}:AGENTS.md`], { cwd: repo, encoding: 'utf-8' }),
        '# Worker-owned edit\n',
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('preserves worker writes that race after the first worktree check', async () => {
    const repo = await initRepo();
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-race-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
      const worktreePath = join(repo, 'worker-2');
      const racedFile = join(worktreePath, 'after-preflight.txt');
      execFileSync('git', ['worktree', 'add', '--detach', worktreePath, baseRef], { cwd: repo, stdio: 'pipe' });

      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
case "\${1:-}" in
  show-option)
    echo "team:post-preflight-race"
    ;;
  kill-pane)
    printf 'late worker edit\\n' > "${racedFile}"
    ;;
esac
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('post-preflight-race', 'task', 'executor', 2, repo);
      const config = await readTeamConfig('post-preflight-race', repo);
      assert.ok(config);
      if (!config) return;
      Object.assign(config.workers[1]!, {
        pane_id: '%22',
        worktree_created: true,
        worktree_detached: true,
        worktree_repo_root: repo,
        worktree_path: worktreePath,
        worktree_base_ref: baseRef,
      });
      await saveTeamConfig(config, repo);

      const result = await scaleDown(
        'post-preflight-race',
        repo,
        { workerNames: ['worker-2'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.match(result.error, /^scale_down_worktree_preserved_after_quiesce:/);
      assert.equal(await readFile(racedFile, 'utf-8'), 'late worker edit\n');
      assert.equal((await readTeamConfig('post-preflight-race', repo))?.workers.some((worker) => worker.name === 'worker-2'), true);
      assert.equal((await readWorkerStatus('post-preflight-race', 'worker-2', repo)).state, 'failed');
      assert.match(await readFile(tmuxLogPath, 'utf-8'), /kill-pane -t %22/);
      const salvageRef = execFileSync(
        'git',
        [
          'for-each-ref',
          '--sort=-creatordate',
          '--count=1',
          '--format=%(refname)',
          'refs/heads/salvage/team-scale-down-post-preflight-race-worker-2-*',
        ],
        { cwd: repo, encoding: 'utf-8' },
      ).trim();
      assert.ok(salvageRef);
      assert.equal(
        execFileSync('git', ['show', `${salvageRef}:after-preflight.txt`], { cwd: repo, encoding: 'utf-8' }),
        'late worker edit\n',
      );
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(repo, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  it('scaleDown never targets leader or hud panes during teardown', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'omx-scale-down-exclusions-'));
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'omx-scale-down-fake-tmux-'));
    const tmuxLogPath = join(fakeBinDir, 'tmux.log');
    const tmuxStubPath = join(fakeBinDir, 'tmux');
    const previousPath = process.env.PATH;
    try {
      await writeFile(
        tmuxStubPath,
        `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "${tmuxLogPath}"
if [ "\${1:-}" = "show-option" ]; then
  echo "team:exclusions"
fi
exit 0
`,
      );
      await writeFile(tmuxLogPath, '');
      await chmod(tmuxStubPath, 0o755);
      process.env.PATH = `${fakeBinDir}:${previousPath ?? ''}`;

      await initTeamState('exclusions', 'task', 'executor', 4, cwd);
      const config = await readTeamConfig('exclusions', cwd);
      assert.ok(config);
      if (!config) return;
      config.leader_pane_id = '%11';
      config.hud_pane_id = '%12';
      config.workers[0]!.pane_id = '%11';
      config.workers[1]!.pane_id = '%12';
      config.workers[2]!.pane_id = '%13';
      config.workers[3]!.pane_id = '%14';
      await saveTeamConfig(config, cwd);

      const result = await scaleDown(
        'exclusions',
        cwd,
        { workerNames: ['worker-1', 'worker-2', 'worker-3'], force: true },
        { OMX_TEAM_SCALING_ENABLED: '1' },
      );
      assert.equal(result.ok, true);

      const tmuxLog = await readFile(tmuxLogPath, 'utf-8');
      assert.doesNotMatch(tmuxLog, /kill-pane -t %11/);
      assert.doesNotMatch(tmuxLog, /kill-pane -t %12/);
      assert.match(tmuxLog, /kill-pane -t %13/);
    } finally {
      if (typeof previousPath === 'string') process.env.PATH = previousPath;
      else delete process.env.PATH;
      await rm(cwd, { recursive: true, force: true });
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });
});
