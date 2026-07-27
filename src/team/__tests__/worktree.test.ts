import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseWorktreeMode,
  planWorktreeTarget,
  ensureWorktree,
  rollbackProvisionedWorktrees,
} from '../worktree.js';

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'omx-worktree-test-'));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'ignore' });
  await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

function branchExists(repoRoot: string, branch: string): boolean {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('worktree parser', () => {
  it('parses detached mode from --worktree', () => {
    const parsed = parseWorktreeMode(['--worktree', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, ['--yolo']);
  });

  it('parses named mode from --worktree=name', () => {
    const parsed = parseWorktreeMode(['--worktree=feature/foo', 'task']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feature/foo' });
    assert.deepEqual(parsed.remainingArgs, ['task']);
  });

  it('keeps args unchanged when worktree flag is absent', () => {
    const parsed = parseWorktreeMode(['team', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['team', '2:executor', 'task']);
  });

  it('keeps team args flag-free so the CLI can apply automatic default worktrees', () => {
    const parsed = parseWorktreeMode(['ralph', '2:executor', 'task']);
    assert.deepEqual(parsed.mode, { enabled: false });
    assert.deepEqual(parsed.remainingArgs, ['ralph', '2:executor', 'task']);
  });

  // Regression tests for issue #203: branch name passed as separate arg must not
  // leak into the Codex shell as input.
  it('parses named branch from --worktree <name> (space-separated)', () => {
    const parsed = parseWorktreeMode(['--worktree', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'my-branch' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('parses named branch from -w <name> (space-separated)', () => {
    const parsed = parseWorktreeMode(['-w', 'my-branch']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'my-branch' });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('does not leak branch name into remainingArgs when --worktree <name> is used with trailing args', () => {
    const parsed = parseWorktreeMode(['--worktree', 'feat/issue-203', '--yolo']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: false, name: 'feat/issue-203' });
    assert.deepEqual(parsed.remainingArgs, ['--yolo']);
  });

  it('treats --worktree at end of args as detached', () => {
    const parsed = parseWorktreeMode(['--worktree']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });

  it('treats -w at end of args as detached', () => {
    const parsed = parseWorktreeMode(['-w']);
    assert.deepEqual(parsed.mode, { enabled: true, detached: true, name: null });
    assert.deepEqual(parsed.remainingArgs, []);
  });
});

describe('worktree planning', () => {
  it('plans dedicated autoresearch branch and path naming', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'autoresearch' as never,
        mode: { enabled: true, detached: false, name: 'demo-mission' },
        worktreeTag: '20260314T000000Z',
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      assert.equal(planned.branchName, 'autoresearch/demo-mission/20260314t000000z');
      assert.match(planned.worktreePath.replace(/\\/g, '/'), /\.omx\/worktrees\/autoresearch-demo-mission-20260314t000000z$/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('worktree ensure + rollback', () => {
  it('creates and reuses detached worktree idempotently', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(existsSync(created.worktreePath), true);

      const reused = ensureWorktree(planned);
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rejects reusing a dirty worktree', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;

      await writeFile(join(created.worktreePath, 'DIRTY.txt'), 'dirty\n', 'utf-8');
      assert.throws(() => ensureWorktree(planned), /worktree_dirty/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('recreates a detached worktree when git worktree list still contains a missing stale path', async () => {
    const repo = await initRepo();
    try {
      const planned = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(planned.enabled, true);
      if (!planned.enabled) return;

      const created = ensureWorktree(planned);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;

      await rm(created.worktreePath, { recursive: true, force: true });
      assert.equal(existsSync(created.worktreePath), false);

      const recreated = ensureWorktree(planned);
      assert.equal(recreated.enabled, true);
      if (!recreated.enabled) return;
      assert.equal(recreated.created, true);
      assert.equal(recreated.reused, false);
      assert.equal(existsSync(recreated.worktreePath), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates per-worker named branch and blocks branch-in-use collisions', async () => {
    const repo = await initRepo();
    try {
      const workerPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'team',
        mode: { enabled: true, detached: false, name: 'feat' },
        teamName: 'alpha',
        workerName: 'worker-1',
      });
      assert.equal(workerPlan.enabled, true);
      if (!workerPlan.enabled) return;

      const created = ensureWorktree(workerPlan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);
      assert.equal(created.createdBranch, true);
      assert.equal(branchExists(repo, 'feat/worker-1'), true);

      const conflictingLaunchPlan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feat/worker-1' },
      });
      assert.equal(conflictingLaunchPlan.enabled, true);
      if (!conflictingLaunchPlan.enabled) return;

      assert.throws(() => ensureWorktree(conflictingLaunchPlan), /branch_in_use/);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('reuses existing worktree when target path already exists as a valid alias', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/reuse-alias' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      const reused = ensureWorktree({ ...plan, worktreePath: aliasPath });
      assert.equal(reused.enabled, true);
      if (!reused.enabled) return;
      assert.equal(reused.reused, true);
      assert.equal(reused.created, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves mismatch safety when existing alias points to a different branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/mismatch-source' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const created = ensureWorktree(plan);
      assert.equal(created.enabled, true);
      if (!created.enabled) return;
      assert.equal(created.created, true);

      const aliasPath = `${created.worktreePath}-alias`;
      await symlink(created.worktreePath, aliasPath);

      assert.throws(
        () => ensureWorktree({ ...plan, worktreePath: aliasPath, branchName: 'feature/other-branch' }),
        /worktree_target_mismatch/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollback removes newly created worktree and branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/rollback' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/rollback'), true);

      await rollbackProvisionedWorktrees([ensured]);
      assert.equal(existsSync(ensured.worktreePath), false);
      assert.equal(branchExists(repo, 'feature/rollback'), false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('rollbackProvisionedWorktrees with skipBranchDeletion preserves branches', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/ralph-keep' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;

      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);

      await rollbackProvisionedWorktrees([ensured], { skipBranchDeletion: true });
      assert.equal(existsSync(ensured.worktreePath), false);
      // Branch is preserved when skipBranchDeletion is true (ralph policy)
      assert.equal(branchExists(repo, 'feature/ralph-keep'), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('captures dirty tracked work without moving the worker branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/dirty-tracked' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'README.md'), 'dirty tracked\n');

      const [outcome] = await rollbackProvisionedWorktrees([ensured], { salvageContext: 'dirty-tracked' });
      assert.equal(outcome?.removed, false);
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.match(outcome?.preservedRef ?? '', /^refs\/heads\/salvage\//);
      assert.equal(
        execFileSync('git', ['show', `${outcome?.preservedRef}:README.md`], { cwd: repo, encoding: 'utf-8' }),
        'dirty tracked\n',
      );
      assert.equal(
        execFileSync('git', ['rev-parse', 'feature/dirty-tracked'], { cwd: repo, encoding: 'utf-8' }).trim(),
        ensured.baseRef,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves staged, unstaged, and untracked state while creating a recovery ref', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/staged-untracked' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'README.md'), 'staged bytes\n');
      execFileSync('git', ['add', 'README.md'], { cwd: ensured.worktreePath, stdio: 'ignore' });
      await writeFile(join(ensured.worktreePath, 'README.md'), 'unstaged bytes\n');
      await writeFile(join(ensured.worktreePath, 'untracked.txt'), 'untracked bytes\n');
      const statusBefore = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: ensured.worktreePath,
        encoding: 'utf-8',
      });
      const stagedBefore = execFileSync('git', ['diff', '--cached'], {
        cwd: ensured.worktreePath,
        encoding: 'utf-8',
      });
      const unstagedBefore = execFileSync('git', ['diff'], {
        cwd: ensured.worktreePath,
        encoding: 'utf-8',
      });

      const [outcome] = await rollbackProvisionedWorktrees([ensured], { salvageContext: 'staged-untracked' });
      assert.equal(outcome?.removed, false);
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(
        execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
          cwd: ensured.worktreePath,
          encoding: 'utf-8',
        }),
        statusBefore,
      );
      assert.equal(
        execFileSync('git', ['diff', '--cached'], { cwd: ensured.worktreePath, encoding: 'utf-8' }),
        stagedBefore,
      );
      assert.equal(
        execFileSync('git', ['diff'], { cwd: ensured.worktreePath, encoding: 'utf-8' }),
        unstagedBefore,
      );
      assert.equal(
        execFileSync('git', ['show', `${outcome?.preservedRef}:README.md`], { cwd: repo, encoding: 'utf-8' }),
        'unstaged bytes\n',
      );
      assert.equal(
        execFileSync('git', ['show', `${outcome?.preservedRef}:untracked.txt`], { cwd: repo, encoding: 'utf-8' }),
        'untracked bytes\n',
      );
      assert.equal(
        execFileSync('git', ['rev-parse', 'feature/staged-untracked'], { cwd: repo, encoding: 'utf-8' }).trim(),
        ensured.baseRef,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('preserves a worktree containing ignored bytes that cannot enter a salvage commit', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/ignored-bytes' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      const excludePath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: ensured.worktreePath,
        encoding: 'utf-8',
      }).trim();
      await writeFile(excludePath, 'ignored.bin\n');
      await writeFile(join(ensured.worktreePath, 'ignored.bin'), 'ignored bytes\n');

      const [outcome] = await rollbackProvisionedWorktrees([ensured], { salvageContext: 'ignored-bytes' });
      assert.equal(outcome?.removed, false);
      assert.equal(outcome?.preservedRef, null);
      assert.equal(await readFile(join(ensured.worktreePath, 'ignored.bin'), 'utf-8'), 'ignored bytes\n');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('retains a clean advanced named branch', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/advanced-named' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'named.txt'), 'named commit\n');
      execFileSync('git', ['add', 'named.txt'], { cwd: ensured.worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker named commit'], { cwd: ensured.worktreePath, stdio: 'ignore' });
      const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ensured.worktreePath, encoding: 'utf-8' }).trim();

      const [outcome] = await rollbackProvisionedWorktrees([ensured]);
      assert.equal(outcome?.removed, false);
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(outcome?.preservedRef, 'refs/heads/feature/advanced-named');
      assert.equal(branchExists(repo, 'feature/advanced-named'), true);
      assert.equal(execFileSync('git', ['rev-parse', 'feature/advanced-named'], { cwd: repo, encoding: 'utf-8' }).trim(), workerHead);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('creates a salvage ref for a clean advanced detached worktree', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'detached.txt'), 'detached commit\n');
      execFileSync('git', ['add', 'detached.txt'], { cwd: ensured.worktreePath, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'worker detached commit'], { cwd: ensured.worktreePath, stdio: 'ignore' });
      const workerHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ensured.worktreePath, encoding: 'utf-8' }).trim();

      const [outcome] = await rollbackProvisionedWorktrees([ensured], { salvageContext: 'advanced-detached' });
      assert.equal(outcome?.removed, false);
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.match(outcome?.preservedRef ?? '', /^refs\/heads\/salvage\//);
      assert.equal(execFileSync('git', ['rev-parse', outcome?.preservedRef ?? ''], { cwd: repo, encoding: 'utf-8' }).trim(), workerHead);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('captures dirty detached bytes in a salvage ref', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: true, name: null },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'dirty-detached.txt'), 'dirty detached\n');

      const [outcome] = await rollbackProvisionedWorktrees([ensured], { salvageContext: 'dirty-detached' });
      assert.equal(outcome?.removed, false);
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(
        execFileSync('git', ['show', `${outcome?.preservedRef}:dirty-detached.txt`], { cwd: repo, encoding: 'utf-8' }),
        'dirty detached\n',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('leaves worktree and branch intact when salvage ref creation fails', async () => {
    const repo = await initRepo();
    try {
      const plan = planWorktreeTarget({
        cwd: repo,
        scope: 'launch',
        mode: { enabled: true, detached: false, name: 'feature/preserve-failure' },
      });
      assert.equal(plan.enabled, true);
      if (!plan.enabled) return;
      const ensured = ensureWorktree(plan);
      assert.equal(ensured.enabled, true);
      if (!ensured.enabled) return;
      await writeFile(join(ensured.worktreePath, 'must-survive.txt'), 'survive\n');
      await writeFile(join(repo, '.git', 'refs', 'heads', 'salvage'), 'blocks salvage directory\n');

      await assert.rejects(
        () => rollbackProvisionedWorktrees([ensured], { salvageContext: 'preserve-failure' }),
        /worktree_rollback_failed:preserve:/,
      );
      assert.equal(existsSync(ensured.worktreePath), true);
      assert.equal(await readFile(join(ensured.worktreePath, 'must-survive.txt'), 'utf-8'), 'survive\n');
      assert.equal(branchExists(repo, 'feature/preserve-failure'), true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
