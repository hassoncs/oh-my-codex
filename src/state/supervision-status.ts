/**
 * OMX supervision status - the machine-readable surface supervisors read.
 *
 * Supervising an OMX lane by scraping `tmux capture-pane` re-matches scrollback
 * and floods monitors with duplicate events. Everything a supervisor needs is
 * already durable on disk under `.omx/`; this module renders it as one stable
 * document that can be read from OUTSIDE the session, by path.
 */

import { createHash } from 'node:crypto';
import { constants, existsSync, type Stats } from 'node:fs';
import { lstat, open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isInheritedOrigin, isRegistryGitTracked, type UltragoalRunOrigin } from '../ultragoal/registry.js';

export const SUPERVISION_STATUS_SCHEMA = 'omx.supervision.status.v1';

export interface SupervisionModeStatus {
  mode: string;
  active: boolean;
  phase: string | null;
  sessionId: string | null;
  path: string;
}

export interface SupervisionGoalStatus {
  id: string;
  title: string;
  status: string;
  attempt: number | null;
  updatedAt: string | null;
}

export interface SupervisionLedgerEntry {
  ts: string | null;
  event: string | null;
  goalId: string | null;
  status: string | null;
  message: string | null;
}

export interface SupervisionUltragoalStatus {
  present: boolean;
  runId: string | null;
  briefHash: string | null;
  origin: {
    worktreePath: string | null;
    /** Created by another worktree AND not delivered by git. */
    inherited: boolean;
    /** The registry is tracked in git, so another worktree's path is expected. */
    deliveredViaGit: boolean;
  };
  activeGoalId: string | null;
  aggregateComplete: boolean;
  counts: Record<string, number>;
  goals: SupervisionGoalStatus[];
  lastCheckpoint: SupervisionLedgerEntry | null;
  lastLedgerEntry: SupervisionLedgerEntry | null;
  paths: { goals: string; ledger: string; activeRun: string; runDir: string | null };
  error?: string;
}

export interface SupervisionTeamStatus {
  name: string;
  active: boolean;
  phase: string | null;
  taskDescription: string | null;
  agentCount: number | null;
  startedAt: string | null;
  workerWorktrees: string[];
  path: string | null;
}

export interface SupervisionStatus {
  schema: typeof SUPERVISION_STATUS_SCHEMA;
  generatedAt: string;
  worktreePath: string;
  omxPresent: boolean;
  phase: string | null;
  modes: SupervisionModeStatus[];
  ultragoal: SupervisionUltragoalStatus | null;
  teams: SupervisionTeamStatus[];
}

const CHECKPOINT_EVENTS = new Set([
  'goal_completed',
  'goal_failed',
  'goal_blocked',
  'goal_review_blocked',
  'goal_needs_user_decision',
  'aggregate_completed',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const RUN_ID_PATTERN = /^(?:run|legacy)-[A-Za-z0-9._-]+$/;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasRunFileDigests(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 3
    && SHA256_PATTERN.test(String(value.brief))
    && SHA256_PATTERN.test(String(value.goals))
    && SHA256_PATTERN.test(String(value.ledger))
  );
}

function hasRunOrigin(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    optionalString(value.worktreePath) !== null
    && optionalString(value.createdAt) !== null
    && (
      value.adoptedWorktreePaths === undefined
      || (
        Array.isArray(value.adoptedWorktreePaths)
        && value.adoptedWorktreePaths.every((path) => optionalString(path) !== null)
      )
    )
  );
}

function sameRunOrigin(left: unknown, right: unknown): boolean {
  if (!hasRunOrigin(left) || !hasRunOrigin(right)) return false;
  const leftOrigin = left as Record<string, unknown>;
  const rightOrigin = right as Record<string, unknown>;
  const leftAdopted = (leftOrigin.adoptedWorktreePaths as string[] | undefined) ?? [];
  const rightAdopted = (rightOrigin.adoptedWorktreePaths as string[] | undefined) ?? [];
  return (
    leftOrigin.worktreePath === rightOrigin.worktreePath
    && leftOrigin.createdAt === rightOrigin.createdAt
    && leftAdopted.length === rightAdopted.length
    && leftAdopted.every((path, index) => path === rightAdopted[index])
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isValidLedgerTransaction(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.version === 1
    && RUN_ID_PATTERN.test(String(value.runId))
    && typeof value.line === 'string'
    && value.line.endsWith('\n')
    && SHA256_PATTERN.test(String(value.baseSha256))
    && SHA256_PATTERN.test(String(value.nextSha256))
  );
}

function isValidRunTransaction(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.pointer)) return false;
  const archive = value.archive;
  const before = value.before;
  return (
    value.version === 1
    && (value.mode === undefined || value.mode === 'create' || value.mode === 'update')
    && RUN_ID_PATTERN.test(String(value.runId))
    && value.pointer.version === 1
    && value.pointer.runId === value.runId
    && SHA256_PATTERN.test(String(value.pointer.briefHash))
    && optionalString(value.pointer.updatedAt) !== null
    && hasRunOrigin(value.pointer.origin)
    && hasRunFileDigests(value.files)
    && isRecord(before)
    && hasRunFileStates(before.run)
    && hasRunFileStates(before.projection)
    && (
      before.pointerSha256 === null
      || SHA256_PATTERN.test(String(before.pointerSha256))
    )
    && (
      archive === undefined
      || (
        isRecord(archive)
        && RUN_ID_PATTERN.test(String(archive.runId))
        && archive.runId !== value.runId
        && hasRunFileDigests(archive.files)
      )
    )
  );
}

function hasRunFileStates(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).length === 3
    && [value.brief, value.goals, value.ledger].every(
      (digest) => digest === null || SHA256_PATTERN.test(String(digest)),
    )
  );
}

function isValidActiveRunPointer(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.version === 1
    && RUN_ID_PATTERN.test(String(value.runId))
    && SHA256_PATTERN.test(String(value.briefHash))
    && optionalString(value.updatedAt) !== null
    && hasRunOrigin(value.origin)
    && hasRunFileDigests(value.files)
  );
}

async function readSafeUltragoalFile(path: string): Promise<string> {
  const before = await lstat(path);
  assertSafeUltragoalFile(before);
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    assertSafeUltragoalFile(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('transaction journal was replaced while reading');
    }
    return await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
}

function assertSafeUltragoalFile(file: Stats): void {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
    throw new Error('unsafe transaction journal');
  }
}

async function readOptionalSafeUltragoalFile(path: string): Promise<string | null> {
  try {
    return await readSafeUltragoalFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function inspectTransactionJournals(
  transactions: Array<{ path: string; validate: (value: unknown) => boolean }>,
): Promise<{ invalid: boolean; present: boolean }> {
  let present = false;
  for (const transaction of transactions) {
    try {
      const parsed = JSON.parse(await readSafeUltragoalFile(transaction.path)) as unknown;
      present = true;
      if (!transaction.validate(parsed)) return { invalid: true, present: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      return { invalid: true, present: true };
    }
  }
  return { invalid: false, present };
}

async function collectModeStateFiles(stateDir: string, sessionId: string | null): Promise<SupervisionModeStatus[]> {
  if (!existsSync(stateDir)) return [];
  const modes: SupervisionModeStatus[] = [];
  for (const file of await readdir(stateDir)) {
    if (!file.endsWith('-state.json')) continue;
    const path = join(stateDir, file);
    const data = await readJson<Record<string, unknown>>(path);
    modes.push({
      mode: file.replace('-state.json', ''),
      active: data?.active === true,
      phase: optionalString(data?.current_phase),
      sessionId,
      path,
    });
  }
  return modes;
}

async function collectModes(cwd: string): Promise<SupervisionModeStatus[]> {
  const baseStateDir = join(cwd, '.omx', 'state');
  const modes = await collectModeStateFiles(baseStateDir, null);
  const sessionsDir = join(baseStateDir, 'sessions');
  if (existsSync(sessionsDir)) {
    for (const sessionId of await readdir(sessionsDir)) {
      const sessionDir = join(sessionsDir, sessionId);
      if (!(await stat(sessionDir).catch(() => null))?.isDirectory()) continue;
      modes.push(...(await collectModeStateFiles(sessionDir, sessionId)));
    }
  }
  return modes;
}

function toLedgerEntry(raw: Record<string, unknown>): SupervisionLedgerEntry {
  return {
    ts: optionalString(raw.ts),
    event: optionalString(raw.event),
    goalId: optionalString(raw.goalId),
    status: optionalString(raw.status),
    message: optionalString(raw.message),
  };
}

function parseLedgerTail(contents: string): { last: SupervisionLedgerEntry | null; lastCheckpoint: SupervisionLedgerEntry | null } {
  let last: SupervisionLedgerEntry | null = null;
  let lastCheckpoint: SupervisionLedgerEntry | null = null;
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const entry = toLedgerEntry(parsed);
    last = entry;
    if (entry.event && CHECKPOINT_EVENTS.has(entry.event)) lastCheckpoint = entry;
  }
  return { last, lastCheckpoint };
}

/**
 * Read the goal registry WITHOUT the read-time inheritance guard: a supervisor
 * needs to be told that a registry is inherited, not have the read refused.
 */
async function collectUltragoal(cwd: string): Promise<SupervisionUltragoalStatus | null> {
  const dir = join(cwd, '.omx', 'ultragoal');
  const goalsPath = join(dir, 'goals.json');
  const ledgerPath = join(dir, 'ledger.jsonl');
  const activeRunPath = join(dir, 'active-run.json');
  const failedStatus = (
    error: string,
    lastCheckpoint: SupervisionLedgerEntry | null = null,
    lastLedgerEntry: SupervisionLedgerEntry | null = null,
  ): SupervisionUltragoalStatus => ({
    present: true,
    runId: null,
    briefHash: null,
    origin: { worktreePath: null, inherited: false, deliveredViaGit: false },
    activeGoalId: null,
    aggregateComplete: false,
    counts: {},
    goals: [],
    lastCheckpoint,
    lastLedgerEntry,
    paths: { goals: goalsPath, ledger: ledgerPath, activeRun: activeRunPath, runDir: null },
    error,
  });
  try {
    const directory = await lstat(dir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
      return failedStatus('unsafe ultragoal registry directory');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return failedStatus('unsafe ultragoal registry directory');
  }

  const transactions = [
    { path: join(dir, '.ledger-transaction.json'), validate: isValidLedgerTransaction },
    { path: join(dir, '.run-transaction.json'), validate: isValidRunTransaction },
  ];
  let goalsRaw: string | null = null;
  let briefRaw: string | null = null;
  let ledgerRaw: string | null = null;
  let pointerRaw: string | null = null;
  let stable = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const beforeTransactions = await inspectTransactionJournals(transactions);
    if (beforeTransactions.invalid) {
      return failedStatus('invalid ultragoal transaction journal');
    }
    if (beforeTransactions.present) continue;
    try {
      [briefRaw, goalsRaw, ledgerRaw, pointerRaw] = await Promise.all([
        readOptionalSafeUltragoalFile(join(dir, 'brief.md')),
        readOptionalSafeUltragoalFile(goalsPath),
        readOptionalSafeUltragoalFile(ledgerPath),
        readOptionalSafeUltragoalFile(activeRunPath),
      ]);
    } catch {
      return failedStatus('unsafe ultragoal registry object');
    }
    const afterTransactions = await inspectTransactionJournals(transactions);
    if (afterTransactions.invalid) {
      return failedStatus('invalid ultragoal transaction journal');
    }
    if (afterTransactions.present) continue;
    let confirm: Array<string | null>;
    try {
      confirm = await Promise.all([
        readOptionalSafeUltragoalFile(join(dir, 'brief.md')),
        readOptionalSafeUltragoalFile(goalsPath),
        readOptionalSafeUltragoalFile(ledgerPath),
        readOptionalSafeUltragoalFile(activeRunPath),
      ]);
    } catch {
      return failedStatus('unsafe ultragoal registry object');
    }
    if (
      briefRaw === confirm[0]
      && goalsRaw === confirm[1]
      && ledgerRaw === confirm[2]
      && pointerRaw === confirm[3]
    ) {
      stable = true;
      break;
    }
  }
  if (!stable) {
    return failedStatus('ultragoal registry transaction in progress');
  }
  if (goalsRaw === null) return null;

  let plan: Record<string, unknown> | null = null;
  try {
    plan = JSON.parse(goalsRaw) as Record<string, unknown>;
  } catch {
    // Malformed snapshots are reported below.
  }
  const ledger = parseLedgerTail(ledgerRaw ?? '');
  if (!plan || !Array.isArray(plan.goals)) {
    return failedStatus('malformed goal registry', ledger.lastCheckpoint, ledger.last);
  }

  const runId = optionalString(plan.runId);
  if (runId) {
    if (briefRaw === null || ledgerRaw === null || pointerRaw === null) {
      return failedStatus('missing active ultragoal projection', ledger.lastCheckpoint, ledger.last);
    }
    let pointer: Record<string, unknown>;
    try {
      pointer = JSON.parse(pointerRaw) as Record<string, unknown>;
    } catch {
      return failedStatus('invalid ultragoal active-run pointer', ledger.lastCheckpoint, ledger.last);
    }
    if (
      !isValidActiveRunPointer(pointer)
      || pointer.runId !== runId
      || pointer.briefHash !== plan.briefHash
      || pointer.updatedAt !== plan.updatedAt
      || !sameRunOrigin(pointer.origin, plan.origin)
    ) {
      return failedStatus('invalid ultragoal active-run pointer authority', ledger.lastCheckpoint, ledger.last);
    }
    const runDir = join(dir, 'runs', runId);
    try {
      const runsStat = await lstat(join(dir, 'runs'));
      const runStat = await lstat(runDir);
      if (
        !runsStat.isDirectory()
        || runsStat.isSymbolicLink()
        || !runStat.isDirectory()
        || runStat.isSymbolicLink()
      ) {
        return failedStatus('unsafe ultragoal registry object', ledger.lastCheckpoint, ledger.last);
      }
      const [canonicalBrief, canonicalGoals, canonicalLedger] = await Promise.all([
        readSafeUltragoalFile(join(runDir, 'brief.md')),
        readSafeUltragoalFile(join(runDir, 'goals.json')),
        readSafeUltragoalFile(join(runDir, 'ledger.jsonl')),
      ]);
      const files = pointer.files as Record<string, string>;
      if (
        sha256(canonicalBrief) !== files.brief
        || sha256(canonicalGoals) !== files.goals
        || sha256(canonicalLedger) !== files.ledger
        || sha256(briefRaw) !== files.brief
        || sha256(goalsRaw) !== files.goals
        || sha256(ledgerRaw) !== files.ledger
        || canonicalBrief !== briefRaw
        || canonicalGoals !== goalsRaw
        || canonicalLedger !== ledgerRaw
      ) {
        return failedStatus('divergent ultragoal pointer, canonical run, or projection', ledger.lastCheckpoint, ledger.last);
      }
    } catch {
      return failedStatus('unsafe or missing canonical ultragoal run', ledger.lastCheckpoint, ledger.last);
    }
  } else if (pointerRaw !== null) {
    return failedStatus('unexpected ultragoal active-run pointer', ledger.lastCheckpoint, ledger.last);
  }

  const origin = plan.origin as UltragoalRunOrigin | undefined;
  const deliveredViaGit = isInheritedOrigin(origin, cwd) ? await isRegistryGitTracked(cwd) : false;
  const goals: SupervisionGoalStatus[] = (plan.goals as Array<Record<string, unknown>>).map((goal) => ({
    id: optionalString(goal.id) ?? 'unknown',
    title: optionalString(goal.title) ?? '',
    status: optionalString(goal.status) ?? 'unknown',
    attempt: optionalNumber(goal.attempt),
    updatedAt: optionalString(goal.updatedAt),
  }));
  const counts: Record<string, number> = {};
  for (const goal of goals) counts[goal.status] = (counts[goal.status] ?? 0) + 1;

  const aggregateCompletion = plan.aggregateCompletion as { status?: unknown } | undefined;
  return {
    present: true,
    runId,
    briefHash: optionalString(plan.briefHash),
    origin: {
      worktreePath: origin?.worktreePath ?? null,
      inherited: isInheritedOrigin(origin, cwd) && !deliveredViaGit,
      deliveredViaGit,
    },
    activeGoalId: optionalString(plan.activeGoalId),
    aggregateComplete: aggregateCompletion?.status === 'complete',
    counts,
    goals,
    lastCheckpoint: ledger.lastCheckpoint,
    lastLedgerEntry: ledger.last,
    paths: {
      goals: goalsPath,
      ledger: ledgerPath,
      activeRun: activeRunPath,
      runDir: runId ? join(dir, 'runs', runId) : null,
    },
  };
}

async function listWorkerWorktrees(teamDir: string): Promise<string[]> {
  const worktreesDir = join(teamDir, 'worktrees');
  if (!existsSync(worktreesDir)) return [];
  return (await readdir(worktreesDir).catch(() => [])).sort();
}

async function collectTeams(cwd: string): Promise<SupervisionTeamStatus[]> {
  const teams: SupervisionTeamStatus[] = [];
  const teamState = await readJson<Record<string, unknown>>(join(cwd, '.omx', 'state', 'team-state.json'));
  const teamDirRoot = join(cwd, '.omx', 'team');
  const teamDirs = existsSync(teamDirRoot) ? (await readdir(teamDirRoot).catch(() => [])).sort() : [];

  for (const name of teamDirs) {
    const teamDir = join(teamDirRoot, name);
    if (!(await stat(teamDir).catch(() => null))?.isDirectory()) continue;
    const isCurrent = optionalString(teamState?.team_name) === name;
    teams.push({
      name,
      active: isCurrent && teamState?.active === true,
      phase: isCurrent ? optionalString(teamState?.current_phase) : null,
      taskDescription: isCurrent ? optionalString(teamState?.task_description) : null,
      agentCount: isCurrent ? optionalNumber(teamState?.agent_count) : null,
      startedAt: isCurrent ? optionalString(teamState?.started_at) : null,
      workerWorktrees: await listWorkerWorktrees(teamDir),
      path: teamDir,
    });
  }

  const currentName = optionalString(teamState?.team_name);
  if (currentName && !teams.some((team) => team.name === currentName)) {
    teams.push({
      name: currentName,
      active: teamState?.active === true,
      phase: optionalString(teamState?.current_phase),
      taskDescription: optionalString(teamState?.task_description),
      agentCount: optionalNumber(teamState?.agent_count),
      startedAt: optionalString(teamState?.started_at),
      workerWorktrees: [],
      path: null,
    });
  }
  return teams;
}

export interface BuildSupervisionStatusOptions {
  /**
   * Include every historical session's mode files. Off by default: a long-lived
   * tree accumulates hundreds of session-scoped state files, and a supervisor
   * polling this surface should not pay 150KB a tick to learn nothing.
   */
  allModes?: boolean;
  now?: Date;
}

export async function buildSupervisionStatus(
  cwd: string,
  options: Date | BuildSupervisionStatusOptions = {},
): Promise<SupervisionStatus> {
  const resolved: BuildSupervisionStatusOptions = options instanceof Date ? { now: options } : options;
  const now = resolved.now ?? new Date();
  const allModes = resolved.allModes === true;
  const collected = await collectModes(cwd);
  const modes = allModes ? collected : collected.filter((mode) => mode.active);
  const runState = await readJson<Record<string, unknown>>(join(cwd, '.omx', 'state', 'run-state.json'));
  const activeMode = collected.find((mode) => mode.active && mode.phase);
  return {
    schema: SUPERVISION_STATUS_SCHEMA,
    generatedAt: now.toISOString(),
    worktreePath: cwd,
    omxPresent: existsSync(join(cwd, '.omx')),
    phase: optionalString(runState?.current_phase) ?? activeMode?.phase ?? null,
    modes,
    ultragoal: await collectUltragoal(cwd),
    teams: await collectTeams(cwd),
  };
}
