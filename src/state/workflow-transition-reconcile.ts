import { existsSync } from 'fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { getBaseStateDir, getStatePath } from '../mcp/state-paths.js';
import {
  buildWorkflowTransitionError,
  evaluateWorkflowTransition,
  isTrackedWorkflowMode,
  TRACKED_WORKFLOW_MODES,
  type TrackedWorkflowMode,
  type WorkflowTransitionAction,
  type WorkflowTransitionDecision,
} from './workflow-transition.js';
import {
  clearTerminalSkillActiveMarkers,
  getSkillActiveStatePathsForStateDir,
  listActiveSkills,
  readSkillActiveState,
  syncCanonicalSkillStateForMode,
  writeSkillActiveStateCopiesForStateDir,
  type SkillActiveEntry,
  type SkillActiveStateLike,
} from './skill-active.js';
import { applyRunOutcomeContract } from '../runtime/run-outcome.js';
import { normalizeTerminalWorkflowState } from './terminal-normalization.js';
import { clearDeepInterviewQuestionObligation } from '../question/deep-interview.js';
import {
  buildAutopilotDeepInterviewRalplanGateError,
  canAdvanceAutopilotDeepInterviewToRalplan,
} from '../autopilot/deep-interview-gate.js';
import { isAutopilotSupervisingChild } from '../autopilot/fsm.js';
import { resolveLeaderOwnedUltragoalContextOutcome } from '../team/ultragoal-context.js';
import {
  withWorkflowStateLock,
  type WorkflowStateLockLease,
} from './workflow-state-lock.js';

interface TransitionStateLike {
  active?: unknown;
  current_phase?: unknown;
  completed_at?: unknown;
  [key: string]: unknown;
}

interface AuthoritativeWorkflowSnapshot {
  currentModes: TrackedWorkflowMode[];
  states: Map<TrackedWorkflowMode, TransitionStateLike>;
}

export interface ReconciledWorkflowTransition {
  decision: WorkflowTransitionDecision;
  transitionMessage?: string;
  autoCompletedModes: TrackedWorkflowMode[];
  completedPaths: string[];
}

export interface PreflightedWorkflowTransition {
  action: WorkflowTransitionAction;
  allowNestedAutopilotTeam: boolean;
  authorityDigest: string;
  baseStateDir?: string;
  cwd: string;
  currentModesSource: 'authoritative' | 'override';
  decision: WorkflowTransitionDecision;
  currentModes: TrackedWorkflowMode[];
  requestedMode: TrackedWorkflowMode;
  sessionId?: string;
}

async function workflowAuthorityDigest(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<string> {
  const resolvedBaseStateDir = await canonicalTransitionStateRoot(cwd, baseStateDir);
  const canonicalPaths = [
    join(resolvedBaseStateDir, 'skill-active-state.json'),
    ...(sessionId
      ? [join(resolvedBaseStateDir, 'sessions', sessionId, 'skill-active-state.json')]
      : []),
  ];
  const paths = [
    ...TRACKED_WORKFLOW_MODES.map((mode) => modeStatePathForRoot(
      mode,
      cwd,
      sessionId,
      resolvedBaseStateDir,
    )),
    ...canonicalPaths,
  ];
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    const content = await readFile(path, 'utf-8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    hash.update(path);
    hash.update('\0');
    hash.update(content ?? '<absent>');
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function canonicalTransitionStateRoot(cwd: string, baseStateDir?: string): Promise<string> {
  const resolved = baseStateDir ? resolve(baseStateDir) : getBaseStateDir(cwd);
  return await realpath(resolved).catch(() => resolved);
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonIfExists(
  path: string,
  options?: { mode?: TrackedWorkflowMode; throwOnParseError?: boolean },
): Promise<TransitionStateLike | null> {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('workflow state must be an object');
    }
    return parsed as TransitionStateLike;
  } catch {
    if (options?.throwOnParseError && options.mode) {
      throw new Error(
        `Cannot read ${options.mode} workflow state at ${path}. Repair or clear that workflow state yourself via \`omx state clear --input '{"mode":"${options.mode}"}' --json\`; if explicit MCP compatibility is enabled, \`omx_state.*\` tools are also acceptable.`,
      );
    }
    return null;
  }
}

function modeStatePathForRoot(
  mode: TrackedWorkflowMode,
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): string {
  if (baseStateDir) {
    return sessionId
      ? join(baseStateDir, 'sessions', sessionId, `${mode}-state.json`)
      : join(baseStateDir, `${mode}-state.json`);
  }
  return getStatePath(mode, cwd, sessionId);
}


async function readAuthoritativeWorkflowSnapshot(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<AuthoritativeWorkflowSnapshot> {
  const currentModes: TrackedWorkflowMode[] = [];
  const states = new Map<TrackedWorkflowMode, TransitionStateLike>();
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePath = modeStatePathForRoot(mode, cwd, sessionId, baseStateDir);
    const state = await readJsonIfExists(candidatePath, { mode, throwOnParseError: true });
    if (!state) continue;
    states.set(mode, state);
    if (state.active === true) currentModes.push(mode);
  }
  return { currentModes, states };
}

function buildProjectionState(
  base: SkillActiveStateLike | null,
  entries: SkillActiveEntry[],
  fallbackMode: string,
  sessionId: string | undefined,
  nowIso: string,
): SkillActiveStateLike {
  const inherited = entries.length > 0
    ? clearTerminalSkillActiveMarkers(base ?? {})
    : { ...(base ?? {}) };
  const currentPrimary = safeString(inherited.skill).trim();
  const primary = entries.find((entry) => entry.skill === currentPrimary) ?? entries[0];
  return {
    ...inherited,
    version: 1,
    active: entries.length > 0,
    skill: primary?.skill || currentPrimary || fallbackMode,
    phase: primary?.phase || safeString(inherited.phase).trim(),
    updated_at: nowIso,
    source: 'workflow-transition-reconcile',
    session_id: primary?.session_id || sessionId,
    active_skills: entries,
  };
}

function projectionMatches(
  visibleEntries: SkillActiveEntry[],
  expectedEntries: SkillActiveEntry[],
  sessionId?: string,
): boolean {
  const expectedSessionId = safeString(sessionId).trim();
  const visibleTrackedEntries = visibleEntries.filter((entry) => (
    isTrackedWorkflowMode(entry.skill)
    && safeString(entry.session_id).trim() === expectedSessionId
  ));
  if (visibleTrackedEntries.length !== expectedEntries.length) return false;
  return expectedEntries.every((expected) => visibleTrackedEntries.some((visible) => (
    visible.skill === expected.skill
    && safeString(visible.phase).trim() === safeString(expected.phase).trim()
  )));
}

async function readProjectionBytes(path: string): Promise<string | null> {
  return readFile(path, 'utf-8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function restoreProjectionBytes(path: string, content: string | null): Promise<void> {
  if (content === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function writeProjectionCopies(
  stateDir: string,
  state: SkillActiveStateLike,
  sessionId?: string,
  rootState?: SkillActiveStateLike,
): Promise<void> {
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  const previousRoot = await readProjectionBytes(rootPath);
  const previousSession = sessionPath ? await readProjectionBytes(sessionPath) : null;
  try {
    await writeSkillActiveStateCopiesForStateDir(stateDir, state, sessionId, rootState);
  } catch (error) {
    try {
      await restoreProjectionBytes(rootPath, previousRoot);
      if (sessionPath) await restoreProjectionBytes(sessionPath, previousSession);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'workflow_projection_reconcile_rollback_failed',
      );
    }
    throw error;
  }
}

async function reconcileVisibleTrackedModes(
  cwd: string,
  snapshot: AuthoritativeWorkflowSnapshot,
  sessionId?: string,
  baseStateDir?: string,
): Promise<void> {
  const stateDir = baseStateDir ?? getBaseStateDir(cwd);
  const { rootPath, sessionPath } = getSkillActiveStatePathsForStateDir(stateDir, sessionId);
  const existingRoot = await readSkillActiveState(rootPath);
  const existingSession = sessionPath ? await readSkillActiveState(sessionPath) : null;
  const visiblePath = sessionPath ?? rootPath;
  const visibleState = sessionPath ? existingSession : existingRoot;
  const rootEntries = listActiveSkills(existingRoot ?? {});
  const visibleEntries = listActiveSkills(visibleState ?? {});
  const existingEntries = [...visibleEntries, ...rootEntries];
  const nowIso = new Date().toISOString();
  const expectedEntries = snapshot.currentModes.map((mode): SkillActiveEntry => {
    const state = snapshot.states.get(mode)!;
    const existing = existingEntries.find((entry) => entry.skill === mode);
    return {
      ...existing,
      skill: mode,
      phase: safeString(state.current_phase).trim() || undefined,
      active: true,
      activated_at: existing?.activated_at || safeString(state.started_at).trim() || nowIso,
      updated_at: safeString(state.updated_at).trim() || nowIso,
      session_id: sessionId,
    };
  });
  const rootSessionEntries = sessionId
    ? rootEntries.filter((entry) => safeString(entry.session_id).trim() === sessionId)
    : rootEntries;
  if (
    !(existsSync(visiblePath) && visibleState === null)
    && !(existsSync(rootPath) && existingRoot === null)
    && projectionMatches(visibleEntries, expectedEntries, sessionId)
    && projectionMatches(rootSessionEntries, expectedEntries, sessionId)
  ) {
    return;
  }

  const fallbackMode = snapshot.currentModes[0] || safeString(visibleState?.skill).trim() || 'skill-active';
  if (sessionPath && sessionId) {
    const nextRootEntries = [
      ...listActiveSkills(existingRoot ?? {}).filter((entry) => !(
        isTrackedWorkflowMode(entry.skill)
        && safeString(entry.session_id).trim() === sessionId
      )),
      ...expectedEntries,
    ];
    const nextSessionEntries = [
      ...visibleEntries.filter((entry) => !isTrackedWorkflowMode(entry.skill)),
      ...expectedEntries,
    ];
    const nextRoot = buildProjectionState(existingRoot, nextRootEntries, fallbackMode, undefined, nowIso);
    const nextSession = buildProjectionState(existingSession, nextSessionEntries, fallbackMode, sessionId, nowIso);
    await writeProjectionCopies(stateDir, nextSession, sessionId, nextRoot);
    return;
  }

  const nextRootEntries = [
    ...listActiveSkills(existingRoot ?? {}).filter((entry) => (
      !isTrackedWorkflowMode(entry.skill)
      || safeString(entry.session_id).trim().length > 0
    )),
    ...expectedEntries,
  ];
  const nextRoot = buildProjectionState(existingRoot, nextRootEntries, fallbackMode, undefined, nowIso);
  await writeProjectionCopies(stateDir, nextRoot, undefined, nextRoot);
}

async function completeSourceModeState(
  cwd: string,
  baseStateDir: string | undefined,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  sessionId: string | undefined,
  nowIso: string,
  source: string,
): Promise<string[]> {
  const transitionMessage = `mode transiting: ${sourceMode} -> ${destinationMode}`;
  const candidatePaths = [modeStatePathForRoot(sourceMode, cwd, sessionId, baseStateDir)];
  const completedPaths: string[] = [];

  for (const candidatePath of candidatePaths) {
    const existing = await readJsonIfExists(candidatePath, {
      mode: sourceMode,
      throwOnParseError: true,
    });
    if (!existing || existing.active !== true) continue;
    if (sourceMode === 'deep-interview' && destinationMode === 'ralplan') {
      const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
        cwd,
        sessionId,
        baseStateDir,
        deepInterviewState: existing,
      });
      if (!gate.allowed) {
        throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
      }
    }

    const nextCandidate: TransitionStateLike = {
      ...existing,
      active: false,
      current_phase: 'completed',
      completed_at: safeString(existing.completed_at).trim() || nowIso,
      auto_completed_reason: transitionMessage,
      completion_note: `Auto-completed ${sourceMode} during allowlisted transition to ${destinationMode}.`,
      transition_source: source,
      transition_target_mode: destinationMode,
    };
    if (sourceMode === 'deep-interview') {
      const nextQuestionEnforcement = clearDeepInterviewQuestionObligation(
        existing.question_enforcement as Parameters<typeof clearDeepInterviewQuestionObligation>[0],
        'handoff',
        new Date(nowIso),
      );
      if (nextQuestionEnforcement) {
        nextCandidate.question_enforcement = nextQuestionEnforcement;
      } else {
        delete nextCandidate.question_enforcement;
      }
    }
    delete nextCandidate.run_outcome;
    const runOutcomeState = applyRunOutcomeContract(nextCandidate, { nowIso }).state as TransitionStateLike;
    const nextState = normalizeTerminalWorkflowState(runOutcomeState, { mode: sourceMode, nowIso }).state as TransitionStateLike;

    await mkdir(dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, JSON.stringify(nextState, null, 2));
    completedPaths.push(candidatePath);
  }

  if (sourceMode === 'deep-interview' && destinationMode === 'ralplan' && completedPaths.length === 0) {
    const gate = await canAdvanceAutopilotDeepInterviewToRalplan({
      cwd,
      sessionId,
      baseStateDir,
      deepInterviewState: null,
    });
    throw new Error(buildAutopilotDeepInterviewRalplanGateError(gate));
  }

  await syncCanonicalSkillStateForMode({
    cwd,
    ...(baseStateDir ? { baseStateDir } : {}),
    mode: sourceMode,
    active: false,
    currentPhase: 'completed',
    sessionId,
    nowIso,
    source,
  });

  return completedPaths;
}

export async function completeWorkflowModeState(
  cwd: string,
  sourceMode: TrackedWorkflowMode,
  destinationMode: TrackedWorkflowMode,
  options: {
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
  } = {},
): Promise<string[]> {
  return completeSourceModeState(
    cwd,
    options.baseStateDir,
    sourceMode,
    destinationMode,
    options.sessionId,
    options.nowIso ?? new Date().toISOString(),
    options.source ?? 'workflow-transition',
  );
}

export async function assertWorkflowTransitionContextAllowed(
  cwd: string,
  currentModes: Iterable<string>,
  requestedMode: TrackedWorkflowMode,
  options: {
    sessionId?: string;
    baseStateDir?: string;
    allowNestedAutopilotTeam?: boolean;
  } = {},
): Promise<void> {
  const modes = [...currentModes];
  // Nesting a team beneath autopilot is a legal overlap, but only from a phase
  // that actually owns story work. This precondition is unconditional: the
  // overlap itself no longer depends on a caller opting in, so neither may the
  // check that keeps it honest.
  if (requestedMode !== 'team' || !modes.includes('autopilot')) {
    return;
  }

  const autopilotState = await readJsonIfExists(
    modeStatePathForRoot('autopilot', cwd, options.sessionId, options.baseStateDir),
    { mode: 'autopilot', throwOnParseError: true },
  );
  const validChild = isAutopilotSupervisingChild(autopilotState, 'ultragoal')
    || isAutopilotSupervisingChild(autopilotState, 'team');
  if (!validChild) {
    throw new Error(
      'nested_autopilot_team_requires_active_ultragoal_child: autopilot is active but its current_phase is not `ultragoal` or `team`, so there is no story for the team to run under. '
      + 'Autopilot reaches its ultragoal phase through its own progression (deep-interview -> ralplan -> ultragoal) and rejects a direct phase jump, so either let it advance and retry, '
      + 'or run the team standalone by clearing autopilot: `omx state clear --input \'{"mode":"autopilot"}\' --json`.',
    );
  }

  const ultragoalOutcome = await resolveLeaderOwnedUltragoalContextOutcome(cwd);
  if (ultragoalOutcome.status !== 'valid') {
    throw new Error(
      `invalid_ultragoal_team_context:${ultragoalOutcome.warning?.message ?? ultragoalOutcome.status}. `
      + 'Start or repair the leader-owned ultragoal story before nesting a team under it '
      + '(`omx ultragoal status --json` to inspect, `omx state clear --input \'{"mode":"autopilot"}\' --json` to run the team standalone).',
    );
  }
}

export async function preflightWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    baseStateDir?: string;
    currentModes?: Iterable<string>;
    allowNestedAutopilotTeam?: boolean;
    workflowLockLease?: WorkflowStateLockLease;
  } = {},
): Promise<PreflightedWorkflowTransition> {
  const {
    action = 'activate',
    sessionId,
    baseStateDir,
  } = options;
  if (!options.workflowLockLease) {
    return withWorkflowStateLock(
      baseStateDir ? resolve(baseStateDir) : getBaseStateDir(cwd),
      cwd,
      (workflowLockLease) => preflightWorkflowTransition(cwd, requestedMode, {
        ...options,
        workflowLockLease,
      }),
    );
  }
  const authoritativeSnapshot = options.currentModes
    ? null
    : await readAuthoritativeWorkflowSnapshot(cwd, sessionId, baseStateDir);
  if (authoritativeSnapshot) {
    await reconcileVisibleTrackedModes(cwd, authoritativeSnapshot, sessionId, baseStateDir);
  }
  const currentModes = options.currentModes
    ? [...options.currentModes].filter(isTrackedWorkflowMode)
    : authoritativeSnapshot!.currentModes;
  await assertWorkflowTransitionContextAllowed(cwd, currentModes, requestedMode, {
    sessionId,
    baseStateDir,
    allowNestedAutopilotTeam: options.allowNestedAutopilotTeam,
  });
  const decision = evaluateWorkflowTransition(currentModes, requestedMode, {
    allowNestedAutopilotTeam: options.allowNestedAutopilotTeam,
  });

  if (!decision.allowed) {
    throw new Error(buildWorkflowTransitionError(currentModes, requestedMode, action));
  }

  return {
    action,
    allowNestedAutopilotTeam: options.allowNestedAutopilotTeam === true,
    authorityDigest: await workflowAuthorityDigest(cwd, sessionId, baseStateDir),
    baseStateDir: await canonicalTransitionStateRoot(cwd, baseStateDir),
    cwd: resolve(cwd),
    currentModesSource: options.currentModes ? 'override' : 'authoritative',
    decision,
    currentModes,
    requestedMode,
    sessionId,
  };
}

export async function reconcileWorkflowTransition(
  cwd: string,
  requestedMode: TrackedWorkflowMode,
  options: {
    action?: WorkflowTransitionAction;
    sessionId?: string;
    nowIso?: string;
    source?: string;
    baseStateDir?: string;
    currentModes?: Iterable<string>;
    allowNestedAutopilotTeam?: boolean;
    preflight?: PreflightedWorkflowTransition;
    workflowLockLease?: WorkflowStateLockLease;
  } = {},
): Promise<ReconciledWorkflowTransition> {
  const {
    action = 'activate',
    sessionId,
    nowIso = new Date().toISOString(),
    source = 'workflow-transition',
    baseStateDir,
  } = options;
  if (!options.workflowLockLease) {
    return withWorkflowStateLock(
      baseStateDir ? resolve(baseStateDir) : getBaseStateDir(cwd),
      cwd,
      (workflowLockLease) => reconcileWorkflowTransition(cwd, requestedMode, {
        ...options,
        workflowLockLease,
      }),
    );
  }
  let decision: WorkflowTransitionDecision;
  if (options.preflight) {
    const expectedBaseStateDir = await canonicalTransitionStateRoot(cwd, baseStateDir);
    if (options.preflight.requestedMode !== requestedMode) {
      throw new Error(`workflow_transition_preflight_mode_mismatch:${options.preflight.requestedMode}:${requestedMode}`);
    }
    if (options.preflight.action !== action) {
      throw new Error(`workflow_transition_preflight_action_mismatch:${options.preflight.action}:${action}`);
    }
    if (options.preflight.cwd !== resolve(cwd)) {
      throw new Error('workflow_transition_preflight_cwd_mismatch');
    }
    if (options.preflight.sessionId !== sessionId) {
      throw new Error('workflow_transition_preflight_session_mismatch');
    }
    if (options.preflight.baseStateDir !== expectedBaseStateDir) {
      throw new Error('workflow_transition_preflight_state_root_mismatch');
    }
    if (options.preflight.allowNestedAutopilotTeam !== (options.allowNestedAutopilotTeam === true)) {
      throw new Error('workflow_transition_preflight_nested_team_mismatch');
    }
    const currentDigest = await workflowAuthorityDigest(cwd, sessionId, baseStateDir);
    if (currentDigest !== options.preflight.authorityDigest) {
      throw new Error('workflow_transition_preflight_state_drift');
    }
    const currentModes = options.preflight.currentModesSource === 'override'
      ? options.preflight.currentModes
      : (await readAuthoritativeWorkflowSnapshot(cwd, sessionId, baseStateDir)).currentModes;
    await assertWorkflowTransitionContextAllowed(cwd, currentModes, requestedMode, {
      sessionId,
      baseStateDir,
      allowNestedAutopilotTeam: options.allowNestedAutopilotTeam,
    });
    decision = evaluateWorkflowTransition(currentModes, requestedMode, {
      allowNestedAutopilotTeam: options.allowNestedAutopilotTeam,
    });
    if (!decision.allowed) {
      throw new Error(buildWorkflowTransitionError(currentModes, requestedMode, action));
    }
  } else {
    decision = (await preflightWorkflowTransition(cwd, requestedMode, {
      action,
      sessionId,
      baseStateDir,
      currentModes: options.currentModes,
      allowNestedAutopilotTeam: options.allowNestedAutopilotTeam,
      workflowLockLease: options.workflowLockLease,
    })).decision;
  }

  const completedPaths: string[] = [];
  for (const sourceMode of decision.autoCompleteModes) {
    completedPaths.push(...await completeSourceModeState(
      cwd,
      baseStateDir,
      sourceMode,
      requestedMode,
      sessionId,
      nowIso,
      source,
    ));
  }

  return {
    decision,
    transitionMessage: decision.transitionMessage,
    autoCompletedModes: decision.autoCompleteModes,
    completedPaths,
  };
}
