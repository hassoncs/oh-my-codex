/**
 * OMX supervision status - the machine-readable surface supervisors read.
 *
 * Supervising an OMX lane by scraping `tmux capture-pane` re-matches scrollback
 * and floods monitors with duplicate events. Everything a supervisor needs is
 * already durable on disk under `.omx/`; this module renders it as one stable
 * document that can be read from OUTSIDE the session, by path.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
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

async function readLedgerTail(path: string): Promise<{ last: SupervisionLedgerEntry | null; lastCheckpoint: SupervisionLedgerEntry | null }> {
  if (!existsSync(path)) return { last: null, lastCheckpoint: null };
  let last: SupervisionLedgerEntry | null = null;
  let lastCheckpoint: SupervisionLedgerEntry | null = null;
  const contents = await readFile(path, 'utf-8').catch(() => '');
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
  if (!existsSync(goalsPath)) return null;

  const plan = await readJson<Record<string, unknown>>(goalsPath);
  const ledger = await readLedgerTail(ledgerPath);
  if (!plan || !Array.isArray(plan.goals)) {
    return {
      present: true,
      runId: null,
      briefHash: null,
      origin: { worktreePath: null, inherited: false, deliveredViaGit: false },
      activeGoalId: null,
      aggregateComplete: false,
      counts: {},
      goals: [],
      lastCheckpoint: ledger.lastCheckpoint,
      lastLedgerEntry: ledger.last,
      paths: { goals: goalsPath, ledger: ledgerPath, activeRun: activeRunPath, runDir: null },
      error: 'malformed goal registry',
    };
  }

  const origin = plan.origin as UltragoalRunOrigin | undefined;
  const deliveredViaGit = isInheritedOrigin(origin, cwd) ? await isRegistryGitTracked(cwd) : false;
  const runId = optionalString(plan.runId);
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
