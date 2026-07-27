import { existsSync } from 'fs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
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
  listActiveSkills,
  readVisibleSkillActiveState,
  readVisibleSkillActiveStateForStateDir,
  syncCanonicalSkillStateForMode,
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
  const resolvedBaseStateDir = baseStateDir ? resolve(baseStateDir) : getBaseStateDir(cwd);
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
      baseStateDir,
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

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function readJsonIfExists(
  path: string,
  options?: { mode?: TrackedWorkflowMode; throwOnParseError?: boolean },
): Promise<TransitionStateLike | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as TransitionStateLike;
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


async function assertAuthoritativeWorkflowStateReadable(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<void> {
  for (const mode of TRACKED_WORKFLOW_MODES) {
    const candidatePath = modeStatePathForRoot(mode, cwd, sessionId, baseStateDir);
    await readJsonIfExists(candidatePath, { mode, throwOnParseError: true });
  }
}

async function visibleTrackedModes(
  cwd: string,
  sessionId?: string,
  baseStateDir?: string,
): Promise<TrackedWorkflowMode[]> {
  const canonical = baseStateDir
    ? await readVisibleSkillActiveStateForStateDir(baseStateDir, sessionId)
    : await readVisibleSkillActiveState(cwd, sessionId);
  const canonicalModes = listActiveSkills(canonical ?? {})
    .filter((entry) => sessionId || safeString(entry.session_id).trim().length === 0)
    .map((entry) => entry.skill)
    .filter(isTrackedWorkflowMode);

  return [...new Set(canonicalModes)];
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
  if (
    !options.allowNestedAutopilotTeam
    || requestedMode !== 'team'
    || !modes.includes('autopilot')
  ) {
    return;
  }

  const autopilotState = await readJsonIfExists(
    modeStatePathForRoot('autopilot', cwd, options.sessionId, options.baseStateDir),
    { mode: 'autopilot', throwOnParseError: true },
  );
  const validChild = isAutopilotSupervisingChild(autopilotState, 'ultragoal')
    || isAutopilotSupervisingChild(autopilotState, 'team');
  if (!validChild) {
    throw new Error('nested_autopilot_team_requires_active_ultragoal_child');
  }

  const ultragoalOutcome = await resolveLeaderOwnedUltragoalContextOutcome(cwd);
  if (ultragoalOutcome.status !== 'valid') {
    throw new Error(`invalid_ultragoal_team_context:${ultragoalOutcome.warning?.message ?? ultragoalOutcome.status}`);
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
  if (!options.currentModes) {
    await assertAuthoritativeWorkflowStateReadable(cwd, sessionId, baseStateDir);
  }
  const currentModes = options.currentModes
    ? [...options.currentModes].filter(isTrackedWorkflowMode)
    : await visibleTrackedModes(cwd, sessionId, baseStateDir);
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
    baseStateDir: baseStateDir ? resolve(baseStateDir) : undefined,
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
    const expectedBaseStateDir = baseStateDir ? resolve(baseStateDir) : undefined;
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
      : await visibleTrackedModes(cwd, sessionId, baseStateDir);
    await assertAuthoritativeWorkflowStateReadable(cwd, sessionId, baseStateDir);
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
