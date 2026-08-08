import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, existsSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export const ULTRAGOAL_DIR = '.omx/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';
export const ULTRAGOAL_RUNS_DIR = 'runs';
export const ULTRAGOAL_ACTIVE_RUN_POINTER = 'active-run.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_BRIEF_HASH_PATTERN = /^[a-f0-9]{16}$/;
const RUN_ID_PATTERN = /^(?:run|legacy)-[A-Za-z0-9._-]+$/;

/**
 * Goal registries are namespaced per run under `.omx/ultragoal/runs/<runId>/`.
 * The flat `.omx/ultragoal/{brief.md,goals.json,ledger.jsonl}` files remain the
 * ACTIVE VIEW so every existing reader (HUD, shutdown gates, state operations)
 * keeps working; they are a derived projection of the active run and are only
 * ever written by the ultragoal writer alongside the canonical run directory.
 */
export interface UltragoalRunOrigin {
  /** Absolute path of the worktree that created this run. */
  worktreePath: string;
  createdAt: string;
  /** Worktrees that explicitly adopted this run (Grove CoW clones, moved trees). */
  adoptedWorktreePaths?: string[];
}

export interface UltragoalActiveRunPointer {
  version: 1;
  runId: string;
  briefHash: string;
  updatedAt: string;
  origin: UltragoalRunOrigin;
  files?: {
    brief: string;
    goals: string;
    ledger: string;
  };
}

export type UltragoalRegistryConflictReason =
  | 'brief_mismatch'
  | 'inherited_worktree'
  | 'unnamespaced_legacy_registry';

export class UltragoalRegistryConflictError extends Error {
  readonly reason: UltragoalRegistryConflictReason;
  readonly runId?: string;
  readonly briefHash?: string;
  readonly originWorktreePath?: string;

  constructor(
    message: string,
    details: {
      reason: UltragoalRegistryConflictReason;
      runId?: string;
      briefHash?: string;
      originWorktreePath?: string;
    },
  ) {
    super(message);
    this.name = 'UltragoalRegistryConflictError';
    this.reason = details.reason;
    this.runId = details.runId;
    this.briefHash = details.briefHash;
    this.originWorktreePath = details.originWorktreePath;
  }
}

export function ultragoalDir(cwd: string): string {
  return join(cwd, ULTRAGOAL_DIR);
}

export function ultragoalRunsDir(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_RUNS_DIR);
}

export function ultragoalRunDir(cwd: string, runId: string): string {
  return join(ultragoalRunsDir(cwd), runId);
}

export function ultragoalActiveRunPointerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_ACTIVE_RUN_POINTER);
}

export function computeUltragoalBriefHash(brief: string): string {
  const normalized = brief.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

export function buildUltragoalRunId(briefHash: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run-${stamp}-${briefHash.slice(0, 8)}`;
}

export function isLegacyRunId(runId: string): boolean {
  return runId.startsWith('legacy-');
}

export function buildLegacyRunId(seed: string): string {
  return `legacy-${computeUltragoalBriefHash(seed).slice(0, 8)}`;
}

/**
 * Pre-namespacing registries carry no identity, so derive a stable one from
 * their own content: two archived registries in one tree must not collide.
 */
export function legacyRunIdForPlan(plan: {
  briefHash?: string;
  createdAt?: string;
  goals?: Array<{ id?: string }>;
}): string {
  if (plan.briefHash) return `legacy-${plan.briefHash.slice(0, 8)}`;
  const seed = [plan.createdAt ?? '', ...(plan.goals ?? []).map((goal) => goal.id ?? '')].join('|');
  return buildLegacyRunId(seed);
}

export async function readActiveRunPointer(cwd: string): Promise<UltragoalActiveRunPointer | null> {
  const path = ultragoalActiveRunPointerPath(cwd);
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assertSafeActiveRunPointer(cwd, path, before);
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    throw new Error(
      `Refusing unsafe ultragoal active-run pointer at ${repoRelative(cwd, path)}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  let raw: string;
  try {
    const opened = await handle.stat();
    assertSafeActiveRunPointer(cwd, path, opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Refusing replaced ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
    }
    raw = await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
  }
  if (!isValidActiveRunPointer(parsed)) {
    throw new Error(`Invalid ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
  }
  if (LEGACY_BRIEF_HASH_PATTERN.test(parsed.briefHash)) {
    let brief: string;
    try {
      brief = (await readArchiveFile(cwd, join(ultragoalDir(cwd), ULTRAGOAL_BRIEF))).toString('utf-8');
    } catch {
      throw new Error(`Invalid ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
    }
    if (!computeUltragoalBriefHash(brief).startsWith(parsed.briefHash)) {
      throw new Error(`Invalid ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
    }
  }
  return parsed;
}

function assertSafeActiveRunPointer(cwd: string, path: string, file: Stats): void {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
    throw new Error(`Refusing unsafe ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
  }
}

function isValidRunOrigin(value: unknown): value is UltragoalRunOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  return (
    typeof origin.worktreePath === 'string'
    && origin.worktreePath.length > 0
    && typeof origin.createdAt === 'string'
    && origin.createdAt.length > 0
    && (
      origin.adoptedWorktreePaths === undefined
      || (
        Array.isArray(origin.adoptedWorktreePaths)
        && origin.adoptedWorktreePaths.every((path) => typeof path === 'string' && path.length > 0)
      )
    )
  );
}

function isValidPointerFiles(value: unknown): value is NonNullable<UltragoalActiveRunPointer['files']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const files = value as Record<string, unknown>;
  return (
    Object.keys(files).length === 3
    && SHA256_PATTERN.test(String(files.brief))
    && SHA256_PATTERN.test(String(files.goals))
    && SHA256_PATTERN.test(String(files.ledger))
  );
}

function isValidActiveRunPointer(value: unknown): value is UltragoalActiveRunPointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pointer = value as Record<string, unknown>;
  return (
    pointer.version === 1
    && RUN_ID_PATTERN.test(String(pointer.runId))
    && (
      SHA256_PATTERN.test(String(pointer.briefHash))
      || LEGACY_BRIEF_HASH_PATTERN.test(String(pointer.briefHash))
    )
    && typeof pointer.updatedAt === 'string'
    && pointer.updatedAt.length > 0
    && isValidRunOrigin(pointer.origin)
    && (pointer.files === undefined || isValidPointerFiles(pointer.files))
  );
}

export async function writeActiveRunPointer(cwd: string, pointer: UltragoalActiveRunPointer): Promise<void> {
  await ensureDirectoryDurable(ultragoalDir(cwd));
  const path = ultragoalActiveRunPointerPath(cwd);
  const destination = await inspectPointerDestination(cwd, path);
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tmpPath, 'wx', destination?.mode ?? 0o644);
    try {
      await handle.writeFile(`${JSON.stringify(pointer, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await inspectPointerDestination(cwd, path);
    if (
      (destination === null && current !== null)
      || (
        destination !== null
        && (
          current === null
          || current.dev !== destination.dev
          || current.ino !== destination.ino
        )
      )
    ) {
      throw new Error(`Refusing changed ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
    }
    await renameDurable(tmpPath, path);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function inspectPointerDestination(
  cwd: string,
  path: string,
): Promise<{ dev: number; ino: number; mode: number } | null> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  assertSafeActiveRunPointer(cwd, path, before);
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    assertSafeActiveRunPointer(cwd, path, opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Refusing replaced ultragoal active-run pointer at ${repoRelative(cwd, path)}.`);
    }
    return { dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

/**
 * True when this registry was created by a different worktree and never adopted
 * here — the Grove CoW-clone case, where a cloned tree silently inherits an
 * "active" registry that does not belong to it.
 */
export function isInheritedOrigin(origin: UltragoalRunOrigin | undefined, cwd: string): boolean {
  if (!origin?.worktreePath) return false;
  if (origin.worktreePath === cwd) return false;
  return !(origin.adoptedWorktreePaths ?? []).includes(cwd);
}

/**
 * A CoW clone inherits UNTRACKED runtime state; git delivers TRACKED state on
 * purpose. Repos that commit `.omx/ultragoal/goals.json` would otherwise see
 * every fresh worktree or clone of the branch refuse forever, because
 * `origin.worktreePath` is an absolute local path baked into the commit.
 */
export async function isRegistryGitTracked(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '--error-unmatch', '--', `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`],
      { cwd },
      (error) => resolve(!error),
    );
  });
}

/** True only for a registry this tree inherited rather than one git delivered. */
export async function isUnownedInheritedRegistry(
  origin: UltragoalRunOrigin | undefined,
  cwd: string,
): Promise<boolean> {
  if (!isInheritedOrigin(origin, cwd)) return false;
  return !(await isRegistryGitTracked(cwd));
}

export interface RegistryConflictInput {
  cwd: string;
  /** Brief hash of the run that is about to start. */
  briefHash: string;
  existingBriefHash?: string;
  existingRunId?: string;
  existingOrigin?: UltragoalRunOrigin;
  /** Precomputed by the caller: inherited AND not delivered by git. */
  originInherited?: boolean;
  /** True when a flat goals.json exists with no namespaced run behind it. */
  unnamespacedLegacyRegistry?: boolean;
}

export function describeRegistryConflict(
  input: RegistryConflictInput,
): { reason: UltragoalRegistryConflictReason; message: string } | null {
  const remedies = [
    '  --archive-existing   keep the existing registry under .omx/ultragoal/runs/<runId>/ and start a fresh namespace',
    '  --adopt-existing     continue the existing registry in this worktree (its goals become this run)',
    '  --new-namespace      start a fresh namespace, leaving the existing run registered but inactive',
  ].join('\n');

  const inherited = input.originInherited ?? isInheritedOrigin(input.existingOrigin, input.cwd);
  if (input.existingOrigin && inherited) {
    return {
      reason: 'inherited_worktree',
      message: [
        `Refusing to start an ultragoal run against a registry created by a different worktree.`,
        `  existing run: ${input.existingRunId ?? 'unknown'}`,
        `  created in:   ${input.existingOrigin.worktreePath}`,
        `  current tree: ${input.cwd}`,
        'A Grove CoW clone inherits .omx state from its source; that registry is not this run.',
        'Choose explicitly:',
        remedies,
      ].join('\n'),
    };
  }

  if (input.unnamespacedLegacyRegistry) {
    return {
      reason: 'unnamespaced_legacy_registry',
      message: [
        `Refusing to start an ultragoal run: ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS} exists with no run namespace.`,
        'This is a pre-namespacing registry from an earlier run in this tree.',
        'Choose explicitly:',
        remedies,
      ].join('\n'),
    };
  }

  if (input.existingBriefHash && input.existingBriefHash !== input.briefHash) {
    return {
      reason: 'brief_mismatch',
      message: [
        'Refusing to start an ultragoal run against a registry created from a different brief.',
        `  existing run:  ${input.existingRunId ?? 'unknown'} (brief ${input.existingBriefHash})`,
        `  incoming brief: ${input.briefHash}`,
        'Choose explicitly:',
        remedies,
      ].join('\n'),
    };
  }

  return null;
}

/**
 * Copy the current flat active-view files into a namespaced run directory so a
 * pre-namespacing registry is never destroyed by the run that replaces it.
 */
export async function archiveFlatRegistry(cwd: string, runId: string): Promise<string | null> {
  const flatGoals = join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
  const flatGoalsStat = await archiveFileStat(flatGoals);
  if (!flatGoalsStat) return null;
  assertArchiveFile(cwd, flatGoals, flatGoalsStat);
  const runDir = ultragoalRunDir(cwd, runId);
  const files = new Map<string, { bytes: Buffer; mode: number }>();
  for (const file of [ULTRAGOAL_GOALS, ULTRAGOAL_BRIEF, ULTRAGOAL_LEDGER]) {
    const source = join(ultragoalDir(cwd), file);
    const sourceStat = await archiveFileStat(source);
    if (!sourceStat) continue;
    assertArchiveFile(cwd, source, sourceStat);
    const sourceBytes = await readArchiveFile(cwd, source);
    files.set(file, { bytes: sourceBytes, mode: sourceStat.mode & 0o777 });
  }

  const runDirStat = await archiveDirectoryStat(runDir);
  if (!runDirStat) {
    const stageDir = join(ultragoalRunsDir(cwd), `.archive-stage-${runId}`);
    const staleStage = await archiveDirectoryStat(stageDir);
    if (staleStage) {
      assertArchiveDirectory(stageDir, staleStage);
      await rm(stageDir, { recursive: true });
      await syncDirectory(dirname(stageDir));
    }
    await ensureDirectoryDurable(stageDir);
    try {
      for (const [file, source] of files) {
        const destination = join(stageDir, file);
        const handle = await open(destination, 'wx', source.mode);
        try {
          await handle.writeFile(source.bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      await syncDirectory(stageDir);
      await ensureDirectoryDurable(ultragoalRunsDir(cwd));
      if (await archiveDirectoryStat(runDir)) {
        throw new Error(`Refusing to overwrite canonical ultragoal archive at ${repoRelative(cwd, runDir)}.`);
      }
      await renameDurable(stageDir, runDir);
    } catch (error) {
      await rm(stageDir, { recursive: true, force: true });
      throw error;
    }
    return repoRelative(cwd, runDir);
  }

  assertArchiveDirectory(runDir, runDirStat);
  for (const file of [ULTRAGOAL_GOALS, ULTRAGOAL_BRIEF, ULTRAGOAL_LEDGER]) {
    const source = files.get(file);
    const destination = join(runDir, file);
    const destinationStat = await archiveFileStat(destination);
    if (!source) {
      if (destinationStat) {
        throw new Error(`Refusing unexpected canonical ultragoal archive file at ${repoRelative(cwd, destination)}.`);
      }
      continue;
    }
    if (destinationStat) {
      const destinationBytes = await readArchiveFile(cwd, destination);
      if (!source.bytes.equals(destinationBytes)) {
        throw new Error(`Refusing to overwrite canonical ultragoal archive at ${repoRelative(cwd, destination)}.`);
      }
      continue;
    }
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', source.mode);
      try {
        await handle.writeFile(source.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (await archiveFileStat(destination)) {
        throw new Error(`Refusing changed canonical ultragoal archive at ${repoRelative(cwd, destination)}.`);
      }
      await renameDurable(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return repoRelative(cwd, runDir);
}

async function archiveFileStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function archiveDirectoryStat(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertArchiveFile(cwd: string, path: string, file: Stats): void {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
    throw new Error(`Refusing unsafe ultragoal archive file at ${repoRelative(cwd, path)}.`);
  }
}

async function readArchiveFile(cwd: string, path: string): Promise<Buffer> {
  const before = await lstat(path);
  assertArchiveFile(cwd, path, before);
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    assertArchiveFile(cwd, path, opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Refusing replaced ultragoal archive file at ${repoRelative(cwd, path)}.`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurable(path: string): Promise<void> {
  if (existsSync(path)) {
    assertArchiveDirectory(path, await lstat(path));
    return;
  }
  const parent = dirname(path);
  if (parent !== path) await ensureDirectoryDurable(parent);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertArchiveDirectory(path, await lstat(path));
  await syncDirectory(path);
  if (parent !== path) await syncDirectory(parent);
}

function assertArchiveDirectory(path: string, directory: Stats): void {
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Refusing unsafe ultragoal archive directory at ${path}.`);
  }
}

async function renameDurable(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  await syncDirectory(destinationParent);
  if (sourceParent !== destinationParent) await syncDirectory(sourceParent);
}
