import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export const ULTRAGOAL_DIR = '.omx/ultragoal';
export const ULTRAGOAL_BRIEF = 'brief.md';
export const ULTRAGOAL_GOALS = 'goals.json';
export const ULTRAGOAL_LEDGER = 'ledger.jsonl';
export const ULTRAGOAL_RUNS_DIR = 'runs';
export const ULTRAGOAL_ACTIVE_RUN_POINTER = 'active-run.json';

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
  return createHash('sha256').update(normalized, 'utf-8').digest('hex').slice(0, 16);
}

export function buildUltragoalRunId(briefHash: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run-${stamp}-${briefHash.slice(0, 8)}`;
}

export function isLegacyRunId(runId: string): boolean {
  return runId.startsWith('legacy-');
}

export function buildLegacyRunId(briefHash: string): string {
  return `legacy-${briefHash.slice(0, 8)}`;
}

export async function readActiveRunPointer(cwd: string): Promise<UltragoalActiveRunPointer | null> {
  const path = ultragoalActiveRunPointerPath(cwd);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as UltragoalActiveRunPointer;
    if (!parsed || parsed.version !== 1 || typeof parsed.runId !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeActiveRunPointer(cwd: string, pointer: UltragoalActiveRunPointer): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const path = ultragoalActiveRunPointerPath(cwd);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(pointer, null, 2)}\n`);
  await rename(tmpPath, path);
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

export interface RegistryConflictInput {
  cwd: string;
  /** Brief hash of the run that is about to start. */
  briefHash: string;
  existingBriefHash?: string;
  existingRunId?: string;
  existingOrigin?: UltragoalRunOrigin;
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

  if (input.existingOrigin && isInheritedOrigin(input.existingOrigin, input.cwd)) {
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
  if (!existsSync(flatGoals)) return null;
  const runDir = ultragoalRunDir(cwd, runId);
  await mkdir(runDir, { recursive: true });
  for (const file of [ULTRAGOAL_GOALS, ULTRAGOAL_BRIEF, ULTRAGOAL_LEDGER]) {
    const source = join(ultragoalDir(cwd), file);
    if (!existsSync(source)) continue;
    await copyFile(source, join(runDir, file));
  }
  return repoRelative(cwd, runDir);
}
