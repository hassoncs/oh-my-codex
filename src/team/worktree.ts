import { execFile as execFileCb, execFileSync, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { promisify } from 'util';
import {
  assertCurrentTaskBranchAvailable,
  upsertCurrentTaskBaseline,
} from './current-task-baseline.js';

const execFilePromise = promisify(execFileCb);

export type WorktreeMode =
  | { enabled: false }
  | { enabled: true; detached: true; name: null }
  | { enabled: true; detached: false; name: string };

export interface ParsedWorktreeMode {
  mode: WorktreeMode;
  remainingArgs: string[];
}

export interface WorktreePlanInput {
  cwd: string;
  scope: 'launch' | 'team' | 'autoresearch';
  mode: WorktreeMode;
  teamName?: string;
  workerName?: string;
  worktreeTag?: string;
}

export interface PlannedWorktreeTarget {
  enabled: true;
  scope: 'launch' | 'team' | 'autoresearch';
  repoRoot: string;
  worktreePath: string;
  detached: boolean;
  baseRef: string;
  branchName: string | null;
}

export interface EnsureWorktreeResult {
  enabled: true;
  repoRoot: string;
  worktreePath: string;
  baseRef?: string;
  detached: boolean;
  branchName: string | null;
  created: boolean;
  reused: boolean;
  createdBranch: boolean;
  provisioningToken?: string;
  /** True when the worktree had uncommitted changes at launch time. */
  dirty?: boolean;
}

export interface EnsureWorktreeOptions {
  allowDirtyReuse?: boolean;
}

export interface WorktreeCreateIntent {
  repoRoot: string;
  worktreePath: string;
  baseRef: string;
  detached: boolean;
  branchName: string | null;
  createdBranch: boolean;
  provisioningToken: string;
}

interface PreparedWorktreeCreate {
  kind: 'create';
  plan: PlannedWorktreeTarget;
  branchAlreadyExisted: boolean;
  addArgs: string[];
}

interface GitWorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
  detached: boolean;
  lockReason: string | null;
}

const PROVISIONING_REASON_PREFIX = 'omx-provision:';
const BRANCH_IN_USE_PATTERN = /already checked out|already used by worktree|is already checked out/i;

export function isGitRepository(cwd: string): boolean {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  return result.status === 0;
}

function sanitizePathToken(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'default';
}

function readGit(repoRoot: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    const stderr = typeof err.stderr === 'string'
      ? err.stderr.trim()
      : err.stderr instanceof Buffer
        ? err.stderr.toString('utf-8').trim()
        : '';
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

function validateBranchName(repoRoot: string, branchName: string): void {
  const result = spawnSync('git', ['check-ref-format', '--branch', branchName], {
    cwd: repoRoot,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `invalid_worktree_branch:${branchName}`);
}

function branchExists(repoRoot: string, branchName: string): boolean {
  const result = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return result.status === 0;
}

export function isWorktreeDirty(worktreePath: string): boolean {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `worktree_status_failed:${worktreePath}`);
  }
  return (result.stdout || '').trim() !== '';
}

export function readWorkspaceStatusLines(cwd: string): string[] {
  const result = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `workspace_status_failed:${cwd}`);
  }
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export function assertCleanLeaderWorkspaceForWorkerWorktrees(cwd: string): void {
  const lines = readWorkspaceStatusLines(cwd);
  if (lines.length === 0) return;
  const preview = lines.slice(0, 8).join(' | ');
  throw new Error(
    `leader_workspace_dirty_for_worktrees:${resolve(cwd)}:${preview}:commit_or_stash_before_omx_team`,
  );
}

function listWorktrees(repoRoot: string): GitWorktreeEntry[] {
  const raw = readGit(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!raw) return [];

  const entries: GitWorktreeEntry[] = [];
  const chunks = raw
    .split(/\n\n+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const worktreeLine = lines.find((line) => line.startsWith('worktree '));
    const headLine = lines.find((line) => line.startsWith('HEAD '));
    const branchLine = lines.find((line) => line.startsWith('branch '));
    const lockedLine = lines.find((line) => line === 'locked' || line.startsWith('locked '));
    if (!worktreeLine || !headLine) continue;

    entries.push({
      path: resolve(worktreeLine.slice('worktree '.length)),
      head: headLine.slice('HEAD '.length).trim(),
      branchRef: branchLine ? branchLine.slice('branch '.length).trim() : null,
      detached: lines.includes('detached') || !branchLine,
      lockReason: lockedLine ? lockedLine.slice('locked'.length).trim() : null,
    });
  }

  return entries;
}

function pruneStaleWorktreePath(repoRoot: string, worktreePath: string): void {
  const result = spawnSync('git', ['worktree', 'prune'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  throw new Error(stderr || `worktree_prune_failed:${worktreePath}`);
}

function resolveBranchName(input: WorktreePlanInput): string | null {
  if (!input.mode.enabled || input.mode.detached) return null;

  if (input.scope === 'launch') {
    return input.mode.name;
  }

  if (input.scope === 'autoresearch') {
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return `autoresearch/${sanitizePathToken(input.mode.name)}/${runTag}`;
  }

  const workerName = (input.workerName || '').trim();
  if (!workerName) {
    throw new Error('team_worktree_worker_name_required');
  }

  return `${input.mode.name}/${workerName}`;
}

function resolveWorktreePath(input: WorktreePlanInput, repoRoot: string): string {
  const parent = dirname(repoRoot);
  const bucket = `${basename(repoRoot)}.omx-worktrees`;

  if (input.scope === 'launch') {
    if (!input.mode.enabled || input.mode.detached) {
      return join(parent, bucket, 'launch-detached');
    }
    return join(parent, bucket, `launch-${sanitizePathToken(input.mode.name)}`);
  }

  if (input.scope === 'autoresearch') {
    if (!input.mode.enabled || input.mode.detached) {
      throw new Error('autoresearch_worktree_requires_named_mode');
    }
    const runTag = sanitizePathToken(input.worktreeTag || 'run');
    return join(repoRoot, '.omx', 'worktrees', `autoresearch-${sanitizePathToken(input.mode.name)}-${runTag}`);
  }

  const teamName = sanitizePathToken(input.teamName || 'team');
  const workerName = sanitizePathToken(input.workerName || 'worker');
  return join(repoRoot, '.omx', 'team', teamName, 'worktrees', workerName);
}

function findWorktreeByPath(entries: GitWorktreeEntry[], worktreePath: string): GitWorktreeEntry | null {
  const resolved = resolve(worktreePath);
  return entries.find((entry) => resolve(entry.path) === resolved) || null;
}

function hasBranchInUse(entries: GitWorktreeEntry[], branchName: string, worktreePath: string): boolean {
  const expectedRef = `refs/heads/${branchName}`;
  const resolvedPath = resolve(worktreePath);
  return entries.some((entry) => entry.branchRef === expectedRef && resolve(entry.path) !== resolvedPath);
}

function resolveGitCommonDir(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (result.status !== 0) return null;
  const value = (result.stdout || '').trim();
  if (!value) return null;
  return resolve(cwd, value);
}

function readWorktreeEntryFromPath(repoRoot: string, worktreePath: string): GitWorktreeEntry | null {
  if (!existsSync(worktreePath)) return null;

  const repoCommonDir = resolveGitCommonDir(repoRoot);
  const worktreeCommonDir = resolveGitCommonDir(worktreePath);
  if (!repoCommonDir || !worktreeCommonDir || repoCommonDir !== worktreeCommonDir) {
    return null;
  }

  const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  if (headResult.status !== 0) return null;
  const head = (headResult.stdout || '').trim();
  if (!head) return null;

  const branchResult = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf-8',
      windowsHide: true,
    });
  const branchRef = branchResult.status === 0 ? (branchResult.stdout || '').trim() : null;

  const listed = findWorktreeByPath(listWorktrees(repoRoot), worktreePath);
  return {
    path: resolve(worktreePath),
    head,
    branchRef: branchRef || null,
    detached: !branchRef,
    lockReason: listed?.lockReason ?? null,
  };
}

export function parseWorktreeMode(args: string[]): ParsedWorktreeMode {
  let mode: WorktreeMode = { enabled: false };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const rawArg = args[i];
    const arg = String(rawArg || '');

    if (arg === '--worktree' || arg === '-w') {
      // Peek at the next argument: if it looks like a git branch name (not a
      // flag and not a team worker spec like "3:debugger"), consume it as the
      // branch name. Colons are not valid in git branch names, so we use that
      // to distinguish branch names from other positional args.
      const next = args[i + 1];
      if (typeof next === 'string' && next.length > 0 && !next.startsWith('-') && !next.includes(':')) {
        mode = { enabled: true, detached: false, name: next };
        i += 1;
      } else {
        mode = { enabled: true, detached: true, name: null };
      }
      continue;
    }

    if (arg.startsWith('--worktree=')) {
      const value = arg.slice('--worktree='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w=')) {
      const value = arg.slice('-w='.length).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    if (arg.startsWith('-w') && arg.length > 2) {
      const value = arg.slice(2).trim();
      mode = value
        ? { enabled: true, detached: false, name: value }
        : { enabled: true, detached: true, name: null };
      continue;
    }

    remaining.push(rawArg);
  }

  return { mode, remainingArgs: remaining };
}

export function planWorktreeTarget(input: WorktreePlanInput): PlannedWorktreeTarget | { enabled: false } {
  if (!input.mode.enabled) return { enabled: false };

  const repoRoot = readGit(input.cwd, ['rev-parse', '--show-toplevel']);
  const baseRef = readGit(repoRoot, ['rev-parse', 'HEAD']);
  const branchName = resolveBranchName(input);

  if (branchName) {
    validateBranchName(repoRoot, branchName);
  }

  return {
    enabled: true,
    scope: input.scope,
    repoRoot,
    worktreePath: resolveWorktreePath(input, repoRoot),
    detached: input.mode.detached,
    baseRef,
    branchName,
  };
}

function prepareWorktree(
  plan: PlannedWorktreeTarget | { enabled: false },
  options: EnsureWorktreeOptions = {},
): EnsureWorktreeResult | { enabled: false } | PreparedWorktreeCreate {
  if (!plan.enabled) return { enabled: false };

  let allWorktrees = listWorktrees(plan.repoRoot);
  const staleAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath);
  if (staleAtPath && !existsSync(staleAtPath.path)) {
    pruneStaleWorktreePath(plan.repoRoot, staleAtPath.path);
    allWorktrees = listWorktrees(plan.repoRoot);
  }
  const existingAtPath = findWorktreeByPath(allWorktrees, plan.worktreePath)
    ?? readWorktreeEntryFromPath(plan.repoRoot, plan.worktreePath);
  const expectedBranchRef = plan.branchName ? `refs/heads/${plan.branchName}` : null;

  if (existingAtPath) {
    if (plan.detached) {
      if (!existingAtPath.detached || existingAtPath.head !== plan.baseRef) {
        throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
      }
    } else if (existingAtPath.branchRef !== expectedBranchRef) {
      throw new Error(`worktree_target_mismatch:${plan.worktreePath}`);
    }

    const dirty = isWorktreeDirty(plan.worktreePath);
    if (dirty && !options.allowDirtyReuse) {
      throw new Error(`worktree_dirty:${plan.worktreePath}`);
    }

    const reused = {
      enabled: true,
      repoRoot: plan.repoRoot,
      worktreePath: resolve(plan.worktreePath),
      baseRef: plan.baseRef,
      detached: plan.detached,
      branchName: plan.branchName,
      created: false,
      reused: true,
      createdBranch: false,
      ...(dirty ? { dirty: true } : {}),
    } satisfies EnsureWorktreeResult;

    if (plan.branchName) {
      upsertCurrentTaskBaseline(plan.repoRoot, {
        branch_name: plan.branchName,
        worktree_path: reused.worktreePath,
        base_ref: plan.baseRef,
        status: 'active',
      });
    }

    return reused;
  }

  if (existsSync(plan.worktreePath)) {
    throw new Error(`worktree_path_conflict:${plan.worktreePath}`);
  }

  if (plan.branchName && hasBranchInUse(allWorktrees, plan.branchName, plan.worktreePath)) {
    throw new Error(`branch_in_use:${plan.branchName}`);
  }

  if (plan.branchName) {
    assertCurrentTaskBranchAvailable(plan.repoRoot, plan.branchName, plan.worktreePath);
  }

  const branchAlreadyExisted = plan.branchName ? branchExists(plan.repoRoot, plan.branchName) : false;

  const addArgs = ['worktree', 'add'];
  if (plan.detached) {
    addArgs.push('--detach', plan.worktreePath, plan.baseRef);
  } else if (branchAlreadyExisted) {
    addArgs.push(plan.worktreePath, plan.branchName as string);
  } else {
    addArgs.push('-b', plan.branchName as string, plan.worktreePath, plan.baseRef);
  }

  return { kind: 'create', plan, branchAlreadyExisted, addArgs };
}

function createPreparedWorktree(prepared: PreparedWorktreeCreate): EnsureWorktreeResult {
  const { plan, branchAlreadyExisted, addArgs } = prepared;
  mkdirSync(dirname(plan.worktreePath), { recursive: true });

  const result = spawnSync('git', addArgs, {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
      windowsHide: true,
    });

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
      throw new Error(`branch_in_use:${plan.branchName}`);
    }
    throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
  }

  const ensured = {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: resolve(plan.worktreePath),
    baseRef: plan.baseRef,
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
  } satisfies EnsureWorktreeResult;

  if (plan.branchName) {
    upsertCurrentTaskBaseline(plan.repoRoot, {
      branch_name: plan.branchName,
      worktree_path: ensured.worktreePath,
      base_ref: plan.baseRef,
      status: 'active',
    });
  }

  return ensured;
}

function provisioningReason(token: string): string {
  return `${PROVISIONING_REASON_PREFIX}${token}`;
}

function branchClaimMatches(repoRoot: string, branchName: string, token: string): boolean {
  const result = spawnSync('git', ['reflog', 'show', '--format=%gs', `refs/heads/${branchName}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  return result.status === 0
    && (result.stdout || '').split(/\r?\n/).some((line) => line.trim() === provisioningReason(token));
}

function claimBranchForProvisioning(prepared: PreparedWorktreeCreate, token: string): void {
  const { plan, branchAlreadyExisted } = prepared;
  if (!plan.branchName || branchAlreadyExisted) return;
  const branchRef = `refs/heads/${plan.branchName}`;
  const result = spawnSync('git', [
    'update-ref',
    '--create-reflog',
    '-m',
    provisioningReason(token),
    branchRef,
    plan.baseRef,
    '0'.repeat(plan.baseRef.length),
  ], {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status === 0) return;
  const stderr = (result.stderr || '').trim();
  if (branchExists(plan.repoRoot, plan.branchName)) {
    throw new Error(`branch_ownership_conflict:${plan.branchName}`);
  }
  throw new Error(stderr || `worktree_branch_claim_failed:${branchRef}`);
}

function createClaimedWorktree(prepared: PreparedWorktreeCreate, token: string): EnsureWorktreeResult {
  const { plan, branchAlreadyExisted } = prepared;
  claimBranchForProvisioning(prepared, token);
  mkdirSync(dirname(plan.worktreePath), { recursive: true });

  const addArgs = ['worktree', 'add', '--lock', '--reason', provisioningReason(token)];
  if (plan.detached) {
    addArgs.push('--detach', plan.worktreePath, plan.baseRef);
  } else {
    addArgs.push(plan.worktreePath, plan.branchName as string);
  }
  const result = spawnSync('git', addArgs, {
    cwd: plan.repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (plan.branchName && BRANCH_IN_USE_PATTERN.test(stderr)) {
      throw new Error(`branch_in_use:${plan.branchName}`);
    }
    throw new Error(stderr || `worktree_add_failed:${addArgs.join(' ')}`);
  }

  const ensured = {
    enabled: true,
    repoRoot: plan.repoRoot,
    worktreePath: resolve(plan.worktreePath),
    baseRef: plan.baseRef,
    detached: plan.detached,
    branchName: plan.branchName,
    created: true,
    reused: false,
    createdBranch: Boolean(plan.branchName && !branchAlreadyExisted),
    provisioningToken: token,
  } satisfies EnsureWorktreeResult;

  if (plan.branchName) {
    upsertCurrentTaskBaseline(plan.repoRoot, {
      branch_name: plan.branchName,
      worktree_path: ensured.worktreePath,
      base_ref: plan.baseRef,
      status: 'active',
    });
  }
  return ensured;
}

export function releaseProvisionedWorktreeClaim(
  input: WorktreeCreateIntent,
  options: { allowUnlocked?: boolean } = {},
): void {
  const entry = readWorktreeEntryFromPath(input.repoRoot, input.worktreePath);
  if (!entry) throw new Error(`worktree_claim_missing:${input.worktreePath}`);
  const expectedBranchRef = input.branchName ? `refs/heads/${input.branchName}` : null;
  if (input.detached ? !entry.detached : entry.branchRef !== expectedBranchRef) {
    throw new Error(`worktree_claim_identity_mismatch:${input.worktreePath}`);
  }
  const expectedReason = provisioningReason(input.provisioningToken);
  if (entry.lockReason === null && options.allowUnlocked) return;
  if (entry.lockReason !== expectedReason) {
    throw new Error(`worktree_claim_owner_mismatch:${input.worktreePath}`);
  }
  const result = spawnSync('git', ['worktree', 'unlock', input.worktreePath], {
    cwd: input.repoRoot,
    encoding: 'utf-8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(stderr || `worktree_unlock_failed:${input.worktreePath}`);
  }
}

function removeEmptyProvisioningParents(repoRoot: string, worktreePath: string): void {
  const stop = resolve(repoRoot, '.omx');
  let current = dirname(resolve(worktreePath));
  while (current !== stop && current.startsWith(stop + sep)) {
    try {
      rmdirSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        current = dirname(current);
        continue;
      }
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return;
      throw error;
    }
    current = dirname(current);
  }
}

export function ensureWorktree(
  plan: PlannedWorktreeTarget | { enabled: false },
  options: EnsureWorktreeOptions = {},
): EnsureWorktreeResult | { enabled: false } {
  const prepared = prepareWorktree(plan, options);
  if (!('kind' in prepared)) return prepared;
  return createPreparedWorktree(prepared);
}

export async function ensureWorktreeWithProvisioningIntent(
  plan: PlannedWorktreeTarget | { enabled: false },
  beforeCreate: (intent: WorktreeCreateIntent) => Promise<void>,
  options: EnsureWorktreeOptions = {},
): Promise<EnsureWorktreeResult | { enabled: false }> {
  const prepared = prepareWorktree(plan, options);
  if (!('kind' in prepared)) return prepared;
  const provisioningToken = randomUUID();
  await beforeCreate({
    repoRoot: prepared.plan.repoRoot,
    worktreePath: resolve(prepared.plan.worktreePath),
    baseRef: prepared.plan.baseRef,
    detached: prepared.plan.detached,
    branchName: prepared.plan.branchName,
    createdBranch: Boolean(prepared.plan.branchName && !prepared.branchAlreadyExisted),
    provisioningToken,
  });
  return createClaimedWorktree(prepared, provisioningToken);
}

export interface RollbackWorktreeOptions {
  /** When true, keep created branches after removing their worktrees. */
  skipBranchDeletion?: boolean;
  /** When true, capture recovery refs without removing worktrees. */
  preserveWorktrees?: boolean;
  salvageContext?: string;
}

export interface RollbackWorktreeOutcome {
  worktreePath: string;
  removed: boolean;
  preservedRef: string | null;
  checkpointCommit: string | null;
  branchDeleted: boolean;
}

function gitFailure(error: unknown): string {
  const details = error as Record<string, unknown>;
  return String(details.stderr ?? details.message ?? `exit_${String(details.code ?? 'unknown')}`).trim();
}

function buildSalvageRef(
  result: EnsureWorktreeResult,
  context: string,
): string {
  const prefix = `salvage/${sanitizePathToken(context)}-${sanitizePathToken(basename(result.worktreePath))}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const branchName = `${prefix}-${Date.now()}${attempt === 0 ? '' : `-${attempt + 1}`}`;
    if (!branchExists(result.repoRoot, branchName)) return `refs/heads/${branchName}`;
  }
  throw new Error(`worktree_salvage_ref_exhausted:${result.worktreePath}`);
}

async function createSalvageRef(
  result: EnsureWorktreeResult,
  context: string,
  commit: string,
): Promise<string> {
  const ref = buildSalvageRef(result, context);
  await execFilePromise('git', ['update-ref', ref, commit, ''], {
    cwd: result.repoRoot,
    encoding: 'utf-8',
  });
  return ref;
}

async function captureDirtyWorktree(
  result: EnsureWorktreeResult,
  context: string,
  head: string,
): Promise<{ preservedRef: string; checkpointCommit: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'omx-salvage-index-'));
  const indexPath = join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await execFilePromise('git', ['read-tree', head], {
      cwd: result.worktreePath,
      encoding: 'utf-8',
      env,
    });
    await execFilePromise('git', ['add', '-A'], {
      cwd: result.worktreePath,
      encoding: 'utf-8',
      env,
    });
    const tree = await execFilePromise('git', ['write-tree'], {
      cwd: result.worktreePath,
      encoding: 'utf-8',
      env,
    });
    const commit = await execFilePromise(
      'git',
      ['commit-tree', tree.stdout.trim(), '-p', head, '-m', `chore(team): salvage ${context} changes`],
      {
        cwd: result.worktreePath,
        encoding: 'utf-8',
        env: {
          ...env,
          GIT_AUTHOR_NAME: 'OMX Salvage',
          GIT_AUTHOR_EMAIL: 'omx-salvage@localhost',
          GIT_COMMITTER_NAME: 'OMX Salvage',
          GIT_COMMITTER_EMAIL: 'omx-salvage@localhost',
        },
      },
    );
    const checkpointCommit = commit.stdout.trim();
    const preservedRef = await createSalvageRef(result, context, checkpointCommit);
    return { preservedRef, checkpointCommit };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function rollbackProvisionedWorktrees(
  results: Array<EnsureWorktreeResult | { enabled: false }>,
  options: RollbackWorktreeOptions = {},
): Promise<RollbackWorktreeOutcome[]> {
  const created = results
    .filter((result): result is EnsureWorktreeResult => result.enabled === true && result.created)
    .reverse();

  const errors: string[] = [];
  const outcomes: RollbackWorktreeOutcome[] = [];

  for (const result of created) {
    let preservedRef: string | null = null;
    let checkpointCommit: string | null = null;
    let changed = false;
    try {
      const status = await execFilePromise(
        'git',
        ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
        { cwd: result.worktreePath, encoding: 'utf-8' },
      );
      const statusLines = status.stdout.split(/\r?\n/).filter(Boolean);
      const dirty = statusLines.some((line) => !line.startsWith('!!'));
      const ignored = statusLines.some((line) => line.startsWith('!!'));
      const head = readGit(result.worktreePath, ['rev-parse', 'HEAD']);
      const advanced = result.baseRef
        ? head !== result.baseRef
        : result.detached || Boolean(result.branchName);
      changed = dirty || ignored || advanced;
      if (dirty) {
        const captured = await captureDirtyWorktree(
          result,
          options.salvageContext ?? 'worktree-rollback',
          head,
        );
        preservedRef = captured.preservedRef;
        checkpointCommit = captured.checkpointCommit;
      } else if (advanced && result.detached) {
        preservedRef = await createSalvageRef(
          result,
          options.salvageContext ?? 'worktree-rollback',
          head,
        );
      } else if (advanced && result.branchName) {
        preservedRef = `refs/heads/${result.branchName}`;
      }
    } catch (error) {
      errors.push(`preserve:${result.worktreePath}:${gitFailure(error)}`);
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: false,
        preservedRef,
        checkpointCommit,
        branchDeleted: false,
      });
      continue;
    }

    if (options.preserveWorktrees || changed) {
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: false,
        preservedRef,
        checkpointCommit,
        branchDeleted: false,
      });
      continue;
    }

    try {
      await execFilePromise('git', ['worktree', 'remove', result.worktreePath], {
        cwd: result.repoRoot,
        encoding: 'utf-8',
      });
      removeEmptyProvisioningParents(result.repoRoot, result.worktreePath);
    } catch (err: unknown) {
      errors.push(`remove:${result.worktreePath}:${gitFailure(err)}`);
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: false,
        preservedRef,
        checkpointCommit,
        branchDeleted: false,
      });
      continue;
    }

    if (options.skipBranchDeletion || !result.createdBranch || !result.branchName) {
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: true,
        preservedRef,
        checkpointCommit,
        branchDeleted: false,
      });
      continue;
    }

    const entriesAfterRemove = listWorktrees(result.repoRoot);
    const stillCheckedOut = hasBranchInUse(entriesAfterRemove, result.branchName, result.worktreePath);
    const branchRef = `refs/heads/${result.branchName}`;
    if (stillCheckedOut || !branchExists(result.repoRoot, result.branchName)) {
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: true,
        preservedRef,
        checkpointCommit,
        branchDeleted: !branchExists(result.repoRoot, result.branchName),
      });
      continue;
    }

    const branchHead = readGit(result.repoRoot, ['rev-parse', branchRef]);
    if (!result.baseRef || branchHead !== result.baseRef) {
      outcomes.push({
        worktreePath: result.worktreePath,
        removed: true,
        preservedRef: branchRef,
        checkpointCommit,
        branchDeleted: false,
      });
      continue;
    }

    const deleted = spawnSync('git', ['update-ref', '-d', branchRef, branchHead], {
      cwd: result.repoRoot,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (deleted.status !== 0 && branchExists(result.repoRoot, result.branchName)) {
      const stderr = (deleted.stderr || '').trim();
      errors.push(`delete_branch:${result.branchName}:${stderr || 'compare_and_delete_failed'}`);
    }
    outcomes.push({
      worktreePath: result.worktreePath,
      removed: true,
      preservedRef,
      checkpointCommit,
      branchDeleted: !branchExists(result.repoRoot, result.branchName),
    });
  }

  if (errors.length > 0) {
    throw new Error(`worktree_rollback_failed:${errors.join(' | ')}`);
  }
  return outcomes;
}

export interface ProvisionedWorktreeRecoveryInput extends WorktreeCreateIntent {
  created: boolean | null;
}

export interface ProvisionedWorktreeRecoveryOptions {
  allowUnlockedClaim?: boolean;
}

export type ProvisionedWorktreeClaimVerification =
  | { owned: true }
  | { owned: false; reason: string };

export type ProvisionedWorktreeRecoveryOutcome =
  | { status: 'absent'; worktreePath: string }
  | { status: 'removed'; worktreePath: string; branchDeleted: boolean }
  | { status: 'preserved'; worktreePath: string; preservedRef: string | null; checkpointCommit: string | null }
  | { status: 'ownership_conflict'; worktreePath: string; reason: string };

export function verifyProvisionedWorktreeClaim(
  input: WorktreeCreateIntent,
  options: ProvisionedWorktreeRecoveryOptions = {},
): ProvisionedWorktreeClaimVerification {
  const entry = readWorktreeEntryFromPath(input.repoRoot, input.worktreePath);
  if (!entry) return { owned: false, reason: 'not_repo_worktree' };
  const expectedReason = provisioningReason(input.provisioningToken);
  const claimOwned = entry.lockReason === expectedReason
    || (options.allowUnlockedClaim === true && entry.lockReason === null);
  if (!claimOwned) return { owned: false, reason: 'worktree_not_owned' };
  const expectedBranchRef = input.branchName ? `refs/heads/${input.branchName}` : null;
  if (input.detached ? !entry.detached : entry.branchRef !== expectedBranchRef) {
    return { owned: false, reason: 'identity_mismatch' };
  }
  if (input.createdBranch && (!input.branchName || !branchExists(input.repoRoot, input.branchName)
    || !branchClaimMatches(input.repoRoot, input.branchName, input.provisioningToken))) {
    return { owned: false, reason: 'branch_not_owned' };
  }
  return { owned: true };
}

export async function recoverProvisionedWorktree(
  input: ProvisionedWorktreeRecoveryInput,
  salvageContext: string,
  options: ProvisionedWorktreeRecoveryOptions = {},
): Promise<ProvisionedWorktreeRecoveryOutcome> {
  if (input.created === false) {
    return { status: 'ownership_conflict', worktreePath: input.worktreePath, reason: 'not_created_by_owner' };
  }

  const branchPresent = Boolean(input.branchName && branchExists(input.repoRoot, input.branchName));
  const branchOwned = Boolean(
    input.createdBranch
      && input.branchName
      && branchPresent
      && branchClaimMatches(input.repoRoot, input.branchName, input.provisioningToken),
  );
  if (!existsSync(input.worktreePath)) {
    if (!input.createdBranch || !input.branchName || !branchPresent) {
      removeEmptyProvisioningParents(input.repoRoot, input.worktreePath);
      return { status: 'absent', worktreePath: input.worktreePath };
    }
    if (!branchOwned) {
      return { status: 'ownership_conflict', worktreePath: input.worktreePath, reason: 'branch_not_owned' };
    }
    const worktrees = listWorktrees(input.repoRoot);
    if (hasBranchInUse(worktrees, input.branchName, input.worktreePath)) {
      return { status: 'ownership_conflict', worktreePath: input.worktreePath, reason: 'branch_in_use' };
    }
    const branchRef = `refs/heads/${input.branchName}`;
    const branchHead = readGit(input.repoRoot, ['rev-parse', branchRef]);
    if (branchHead !== input.baseRef) {
      return {
        status: 'preserved',
        worktreePath: input.worktreePath,
        preservedRef: branchRef,
        checkpointCommit: null,
      };
    }
    const deleted = spawnSync('git', ['update-ref', '-d', branchRef, branchHead], {
      cwd: input.repoRoot,
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (deleted.status !== 0) {
      const stderr = (deleted.stderr || '').trim();
      throw new Error(stderr || `worktree_recovery_branch_delete_failed:${branchRef}`);
    }
    removeEmptyProvisioningParents(input.repoRoot, input.worktreePath);
    return { status: 'removed', worktreePath: input.worktreePath, branchDeleted: true };
  }

  const verification = verifyProvisionedWorktreeClaim(input, options);
  if (!verification.owned) {
    return { status: 'ownership_conflict', worktreePath: input.worktreePath, reason: verification.reason };
  }

  releaseProvisionedWorktreeClaim(input, { allowUnlocked: options.allowUnlockedClaim });
  const [outcome] = await rollbackProvisionedWorktrees([{
    enabled: true,
    repoRoot: input.repoRoot,
    worktreePath: input.worktreePath,
    baseRef: input.baseRef,
    detached: input.detached,
    branchName: input.branchName,
    created: true,
    reused: false,
    createdBranch: input.createdBranch,
    provisioningToken: input.provisioningToken,
  }], { salvageContext });
  if (!outcome) {
    throw new Error(`worktree_recovery_outcome_missing:${input.worktreePath}`);
  }
  return outcome.removed
    ? { status: 'removed', worktreePath: outcome.worktreePath, branchDeleted: outcome.branchDeleted }
    : {
        status: 'preserved',
        worktreePath: outcome.worktreePath,
        preservedRef: outcome.preservedRef,
        checkpointCommit: outcome.checkpointCommit,
      };
}

export async function removeWorktreeForce(repoRoot: string, worktreePath: string): Promise<void> {
  await execFilePromise('git', ['worktree', 'remove', '--force', worktreePath], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
}
