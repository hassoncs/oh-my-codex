/**
 * Dynamic worker scaling for team mode — Phase 1: Manual Scaling.
 *
 * Provides scale_up (add workers mid-session) and scale_down (drain + remove idle workers).
 * Gated behind the OMX_TEAM_SCALING_ENABLED environment variable.
 *
 * Key design decisions:
 * - Monotonic worker index counter (next_worker_index in config) ensures unique names
 * - File-based scaling lock prevents concurrent scale operations
 * - 'draining' worker status for graceful transitions during scale_down
 */

import { isAbsolute, join, resolve } from 'path';
import { mkdir, readFile, rm } from 'fs/promises';
import {
  sanitizeTeamName,
  isTmuxAvailable,
  waitForWorkerReady,
  dismissTrustPromptIfPresent,
  sendToWorker,
  isWorkerAlive,
  getWorkerPanePid,
  teardownWorkerPanes,
  buildWorkerStartupCommand,
  trustWorkerMiseConfigIfAvailable,
  writeWorkerStartupScriptCommand,
  resolveTeamWorkerCliForResolvedLaunchArgs,
  tagPaneTeamOwner,
  readPaneTeamOwnerTagResult,
} from './tmux-session.js';
import { execFileSync, spawnSync } from 'child_process';
import {
  teamReadConfig as readTeamConfig,
  teamSaveConfig as saveTeamConfig,
  teamWriteWorkerIdentity as writeWorkerIdentity,
  teamReadManifest as readTeamManifestV2,
  teamNormalizePolicy as normalizeTeamPolicy,
  teamReadWorkerStatus as readWorkerStatus,
  teamWriteWorkerStatus as writeWorkerStatus,
  teamWithScalingLock as withScalingLock,
  teamAppendEvent as appendTeamEvent,
  teamCreateTask as createStateTask,
  teamListTasks as listTasks,
  teamMarkDispatchRequestNotified as markDispatchRequestNotified,
  teamReadDispatchRequest as readDispatchRequest,
  teamTransitionDispatchRequest as transitionDispatchRequest,
  type TeamConfig,
  type WorkerInfo,
  type WorkerStatus,
} from './team-ops.js';
import {
  queueInboxInstruction,
  waitForDispatchReceipt,
  type DispatchOutcome,
} from './mcp-comm.js';
import {
  generateInitialInbox,
  buildTriggerDirective,
  writeWorkerRoleInstructionsFile,
  writeWorkerWorktreeRootAgentsFile,
  removeWorkerWorktreeRootAgentsFile,
} from './worker-bootstrap.js';
import { buildTeamWorkerGoalInstruction } from './goal-workflow.js';
import { loadRolePrompt } from './role-router.js';
import { composeRoleInstructionsForRole } from '../agents/native-config.js';
import { codexPromptsDir } from '../utils/paths.js';
import { resolveCodexHomeForLaunch } from '../cli/codex-home.js';
import {
  parseTeamWorkerLaunchArgs,
  resolveTeamWorkerLaunchArgs,
  resolveAgentDefaultModel,
  resolveAgentReasoningEffort,
  shouldHonorAgentExactModel,
  TEAM_WORKER_INHERITED_MODEL_ENV,
  type TeamReasoningEffort,
} from './model-contract.js';
import { resolveCanonicalTeamStateRoot } from './state-root.js';
import {
  ensureWorktree,
  planWorktreeTarget,
  rollbackProvisionedWorktrees,
  type EnsureWorktreeResult,
  type WorktreeMode,
} from './worktree.js';
import {
  buildApprovedTeamHandoffSection,
  resolvePersistedApprovedTeamExecutionContinuityState,
  type PersistedApprovedTeamExecutionContinuityState,
} from './approved-execution.js';
import {
  readPersistedTeamUltragoalContext,
  renderLeaderOwnedUltragoalContextSection,
} from './ultragoal-context.js';

// ── Environment gate ──────────────────────────────────────────────────────────

const OMX_TEAM_SCALING_ENABLED_ENV = 'OMX_TEAM_SCALING_ENABLED';
const WORKTREE_TRIGGER_STATE_ROOT = '$OMX_TEAM_STATE_ROOT';

export function isScalingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OMX_TEAM_SCALING_ENABLED_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(normalized);
}

function assertScalingEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isScalingEnabled(env)) {
    throw new Error(
      `Dynamic scaling is disabled. Set ${OMX_TEAM_SCALING_ENABLED_ENV}=1 to enable.`,
    );
  }
}

function joinContextSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections.filter((section): section is string => Boolean(section?.trim()));
  return present.length > 0 ? present.join('\n\n') : undefined;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface ScaleUpResult {
  ok: true;
  addedWorkers: WorkerInfo[];
  newWorkerCount: number;
  nextWorkerIndex: number;
}

export interface ScaleDownResult {
  ok: true;
  removedWorkers: string[];
  newWorkerCount: number;
}

export interface ScaleError {
  ok: false;
  error: string;
}

function resolveInstructionStateRoot(worktreePath?: string | null): string | undefined {
  return worktreePath ? WORKTREE_TRIGGER_STATE_ROOT : undefined;
}

interface ScaleUpApprovedExecutionGate {
  ok: true;
  approvedContextSection?: string;
}

function assertUnreachableApprovedExecutionState(state: never): never {
  throw new Error(`unreachable_scale_up_approved_execution_state:${JSON.stringify(state)}`);
}

function resolveScaleUpApprovedExecutionGate(
  teamName: string,
  approvedExecutionState: PersistedApprovedTeamExecutionContinuityState,
): ScaleUpApprovedExecutionGate | ScaleError {
  switch (approvedExecutionState.status) {
    case 'missing':
      return { ok: true };
    case 'malformed':
      return { ok: false, error: `approved_execution_binding_malformed:${teamName}` };
    case 'ambiguous':
      return {
        ok: false,
        error: `approved_execution_binding_ambiguous:${approvedExecutionState.binding.prd_path}:${approvedExecutionState.binding.task}`,
      };
    case 'stale':
      return {
        ok: false,
        error: `approved_execution_binding_stale:${approvedExecutionState.binding.prd_path}:${approvedExecutionState.binding.task}`,
      };
    case 'valid':
      return {
        ok: true,
        approvedContextSection: buildApprovedTeamHandoffSection(approvedExecutionState.approvedHint),
      };
    default:
      return assertUnreachableApprovedExecutionState(approvedExecutionState);
  }
}

function resolveLegacyScaledTeamWorktreeMode(config: Pick<TeamConfig, 'name' | 'workspace_mode' | 'worktree_mode' | 'workers'>): WorktreeMode {
  if (config.worktree_mode) return config.worktree_mode;
  if (config.workspace_mode !== 'worktree') return { enabled: false };

  const workersWithMetadata = config.workers.filter((worker) =>
    worker.worktree_path || worker.worktree_branch || typeof worker.worktree_detached === 'boolean',
  );
  if (workersWithMetadata.length === 0) {
    throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
  }

  if (workersWithMetadata.some((worker) => worker.worktree_detached === true)) {
    return { enabled: true, detached: true, name: null };
  }

  const branchPrefixes = new Set(
    workersWithMetadata
      .map((worker) => worker.worktree_branch?.trim())
      .filter((branch): branch is string => Boolean(branch))
      .map((branch) => {
        const match = /^(.*)\/worker-\d+$/.exec(branch);
        return match?.[1]?.trim() || '';
      })
      .filter(Boolean),
  );

  if (branchPrefixes.size === 1) {
    return { enabled: true, detached: false, name: [...branchPrefixes][0] };
  }

  throw new Error(`scale_up_missing_team_worktree_contract:${config.name}`);
}

function resolveScaleUpWorktreeMode(config: TeamConfig): WorktreeMode {
  if (config.workspace_mode !== 'worktree') return { enabled: false };
  try {
    return resolveLegacyScaledTeamWorktreeMode(config);
  } catch (error) {
    if (error instanceof Error && error.message === `scale_up_missing_team_worktree_contract:${config.name}`) {
      return { enabled: true, detached: true, name: null };
    }
    throw error;
  }
}

async function notifyWorkerPaneOutcome(
  sessionName: string,
  workerIndex: number,
  message: string,
  paneId?: string,
  workerCli?: 'codex' | 'claude' | 'gemini',
): Promise<DispatchOutcome> {
  try {
    await sendToWorker(sessionName, workerIndex, message, paneId, workerCli);
    return { ok: true, transport: 'tmux_send_keys', reason: 'tmux_send_keys_sent' };
  } catch (error) {
    return {
      ok: false,
      transport: 'tmux_send_keys',
      reason: `tmux_send_keys_failed:${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── Scale Up ──────────────────────────────────────────────────────────────────

/**
 * Add workers to a running team mid-session.
 *
 * Acquires the file-based scaling lock, reads the current config,
 * validates capacity, creates new tmux panes, and bootstraps workers.
 */
export async function scaleUp(
  teamName: string,
  count: number,
  agentType: string,
  tasks: Array<{ subject: string; description: string; owner?: string; blocked_by?: string[]; role?: string }>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleUpResult | ScaleError> {
  assertScalingEnabled(env);

  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, error: `count must be a positive integer (got ${count})` };
  }

  if (!isTmuxAvailable()) {
    return { ok: false, error: 'tmux is not available' };
  }

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleUpResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    const maxWorkers = config.max_workers;
    const currentCount = config.workers.length;
    if (currentCount + count > maxWorkers) {
      return {
        ok: false,
        error: `Cannot add ${count} workers: would exceed max_workers (${currentCount} + ${count} > ${maxWorkers})`,
      };
    }

    const teamStateRoot = config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd);
    const codexHomeOverride = resolveCodexHomeForLaunch(leaderCwd, env);
    const launchEnv = codexHomeOverride
      ? { ...env, CODEX_HOME: codexHomeOverride }
      : env;
    const sessionName = config.tmux_session;
    const manifest = await readTeamManifestV2(sanitized, leaderCwd);
    const dispatchPolicy = normalizeTeamPolicy(manifest?.policy, {
      display_mode: manifest?.policy?.display_mode === 'split_pane' ? 'split_pane' : 'auto',
      worker_launch_mode: config.worker_launch_mode,
    });
    const approvedExecutionState = await resolvePersistedApprovedTeamExecutionContinuityState(
      sanitized,
      config.leader_cwd ?? leaderCwd,
      config.team_state_root ?? teamStateRoot,
    );
    const approvedExecutionGate = resolveScaleUpApprovedExecutionGate(
      sanitized,
      approvedExecutionState,
    );
    if (!approvedExecutionGate.ok) {
      return approvedExecutionGate;
    }
    const persistedUltragoalContext = await readPersistedTeamUltragoalContext(
      sanitized,
      config.leader_cwd ?? leaderCwd,
      config.team_state_root ?? teamStateRoot,
    );
    const approvedContextSection = joinContextSections(
      approvedExecutionGate.approvedContextSection,
      renderLeaderOwnedUltragoalContextSection(persistedUltragoalContext),
    );
    const effectiveWorktreeMode = config.worktree_mode ?? resolveScaleUpWorktreeMode(config);
    if (!config.worktree_mode && effectiveWorktreeMode.enabled) {
      config.worktree_mode = effectiveWorktreeMode;
      await saveTeamConfig(config, leaderCwd);
    }

    // Resolve the monotonic worker index counter
    let nextIndex = config.next_worker_index ?? (currentCount + 1);
    const initialNextIndex = nextIndex;
    const addedWorkers: WorkerInfo[] = [];
    const createdTaskIds: string[] = [];

    const rollbackScaleUp = async (
      error: string,
      context: { paneId?: string; workerName?: string; worktreePath?: string } = {},
    ): Promise<ScaleError> => {
      for (const w of addedWorkers) {
        const idx = config.workers.findIndex((worker) => worker.name === w.name);
        if (idx >= 0) {
          config.workers.splice(idx, 1);
        }
        try {
          if (w.pane_id) {
            execFileSync('tmux', ['kill-pane', '-t', w.pane_id], { stdio: 'pipe',
      windowsHide: true,
    });
          }
        } catch {}
        if (w.worktree_path) {
          await removeWorkerWorktreeRootAgentsFile(sanitized, w.name, teamStateRoot, w.worktree_path).catch(() => {});
        }
      }

      if (
        context.workerName &&
        context.worktreePath &&
        !addedWorkers.some((worker) => worker.name === context.workerName)
      ) {
        await removeWorkerWorktreeRootAgentsFile(
          sanitized,
          context.workerName,
          teamStateRoot,
          context.worktreePath,
        ).catch(() => {});
      }

      if (context.paneId) {
        try {
          execFileSync('tmux', ['kill-pane', '-t', context.paneId], { stdio: 'pipe',
      windowsHide: true,
    });
        } catch {}
      }

      for (const taskId of createdTaskIds) {
        await rm(join(leaderCwd, '.omx', 'state', 'team', sanitized, 'tasks', `task-${taskId}.json`), { force: true }).catch(() => {});
      }

      config.worker_count = config.workers.length;
      config.next_worker_index = initialNextIndex;
      await saveTeamConfig(config, leaderCwd);

      return { ok: false, error };
    };

    // Persist incoming tasks first so scaling resolves worker roles and inboxes from
    // canonical task state (stable task ids, owner, role), matching startTeam().
    for (const task of tasks) {
      const createdTask = await createStateTask(sanitized, {
        subject: task.subject,
        description: task.description,
        status: 'pending',
        owner: task.owner,
        blocked_by: task.blocked_by,
        role: task.role,
      }, leaderCwd);
      createdTaskIds.push(createdTask.id);
    }
    const persistedTasks = await listTasks(sanitized, leaderCwd);

    for (let i = 0; i < count; i++) {
      const workerIndex = nextIndex;
      nextIndex++;
      const workerName = `worker-${workerIndex}`;

      // Create worker directory
      const workerDirPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'workers', workerName);
      await mkdir(workerDirPath, { recursive: true });

      // Resolve per-worker role from assigned task roles before launch so reasoning effort can vary by teammate.
      const workerTaskRoles = persistedTasks.filter(t => t.owner === workerName).map(t => t.role).filter(Boolean) as string[];
      const uniqueTaskRoles = new Set(workerTaskRoles);
      const workerRole = workerTaskRoles.length > 0 && uniqueTaskRoles.size === 1
        ? workerTaskRoles[0]
        : agentType;
      const runtimeRole = workerRole;
      if (uniqueTaskRoles.size > 1) {
        console.log(`[omx:scaling] ${workerName}: mixed task roles [${[...uniqueTaskRoles].join(', ')}], falling back to ${agentType}`);
      }

      const worktreeMode = resolveScaleUpWorktreeMode(config);
      const workerWorkspaceResult = worktreeMode.enabled
        ? ensureWorktree(planWorktreeTarget({
            cwd: leaderCwd,
            scope: 'team',
            mode: worktreeMode,
            teamName: sanitized,
            workerName,
          }))
        : { enabled: false } as const;
      const workerWorkspace = workerWorkspaceResult.enabled ? workerWorkspaceResult : null;
      const workerCwd = workerWorkspace ? workerWorkspace.worktreePath : leaderCwd;

      // Build startup command and create tmux pane
      const rawRolePromptContent = await loadRolePrompt(runtimeRole, join(leaderCwd, '.codex', 'prompts'))
        ?? await loadRolePrompt(runtimeRole, codexPromptsDir());
      const preferredReasoning = resolveAgentReasoningEffort(runtimeRole, codexHomeOverride)
        ?? resolveAgentReasoningEffort(agentType, codexHomeOverride);
      const workerLaunchArgs = resolveWorkerLaunchArgsForScaling(launchEnv, runtimeRole, preferredReasoning, codexHomeOverride);
      const workerCli = resolveTeamWorkerCliForResolvedLaunchArgs(i + 1, count, workerLaunchArgs, launchEnv);
      const resolvedWorkerModel = parseTeamWorkerLaunchArgs(workerLaunchArgs).modelOverride ?? undefined;
      const rolePromptContent = rawRolePromptContent
        ? composeRoleInstructionsForRole(runtimeRole, rawRolePromptContent, resolvedWorkerModel)
        : null;
      const teamInstructionsPath = join(leaderCwd, '.omx', 'state', 'team', sanitized, 'worker-agents.md');
      const instructionsFilePath = workerWorkspace
        ? await writeWorkerWorktreeRootAgentsFile({
            teamName: sanitized,
            workerName,
            workerRole: runtimeRole,
            rolePromptContent: rolePromptContent ?? '',
            teamStateRoot,
            leaderCwd,
            worktreePath: workerWorkspace.worktreePath,
          })
        : rolePromptContent
          ? await writeWorkerRoleInstructionsFile(sanitized, workerName, leaderCwd, teamInstructionsPath, runtimeRole, rolePromptContent)
          : teamInstructionsPath;
      const extraEnv: Record<string, string> = {
        OMX_TEAM_STATE_ROOT: teamStateRoot,
        OMX_TEAM_LEADER_CWD: leaderCwd,
        OMX_MODEL_INSTRUCTIONS_FILE: instructionsFilePath,
        ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
      };
      if (workerWorkspace) {
        extraEnv.OMX_TEAM_WORKTREE_PATH = workerWorkspace.worktreePath;
        if (workerWorkspace.branchName) {
          extraEnv.OMX_TEAM_WORKTREE_BRANCH = workerWorkspace.branchName;
        }
        extraEnv.OMX_TEAM_WORKTREE_DETACHED = workerWorkspace.detached ? '1' : '0';
      }
      trustWorkerMiseConfigIfAvailable(workerCwd);
      const cmd = writeWorkerStartupScriptCommand(
        sanitized,
        workerIndex,
        workerLaunchArgs,
        workerCwd,
        extraEnv,
        workerCli,
        undefined,
        runtimeRole,
      ) ?? buildWorkerStartupCommand(
        sanitized,
        workerIndex,
        workerLaunchArgs,
        workerCwd,
        extraEnv,
        workerCli,
        undefined,
        runtimeRole,
      );

      // Find the right-most worker pane to split from, or fall back to leader pane.
      // Keep the initial split from leader horizontal to preserve the leader-left
      // / workers-right composition.
      const splitTarget = config.workers.length > 0
        ? (config.workers[config.workers.length - 1]?.pane_id ?? config.leader_pane_id ?? '')
        : (config.leader_pane_id ?? '');
      const splitDirection = splitTarget === (config.leader_pane_id ?? '') ? '-h' : '-v';

      const result = spawnSync('tmux', [
        'split-window', splitDirection, '-t', splitTarget, '-d', '-P', '-F', '#{pane_id}', '-c', workerCwd, cmd,
      ], { encoding: 'utf-8' });

      if (result.status !== 0) {
        return await rollbackScaleUp(
          `Failed to create tmux pane for ${workerName}: ${(result.stderr || '').trim()}`,
          { workerName, worktreePath: workerWorkspace?.worktreePath },
        );
      }

      const paneId = (result.stdout || '').trim().split('\n')[0]?.trim();
      if (!paneId || !paneId.startsWith('%')) {
        return await rollbackScaleUp(`Failed to capture pane ID for ${workerName}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }
      if (config.tmux_pane_owner_id) {
        try {
          tagPaneTeamOwner(paneId, config.tmux_pane_owner_id);
        } catch (error) {
          return await rollbackScaleUp(
            `Failed to tag tmux pane for ${workerName}: ${error instanceof Error ? error.message : String(error)}`,
            { paneId, workerName, worktreePath: workerWorkspace?.worktreePath },
          );
        }
      }

      // Intentionally avoid forcing `select-layout tiled` here.
      // Tiled relayout reflows leader/HUD panes and breaks team window layout.

      // Get PID
      const panePid = getWorkerPanePid(sessionName, workerIndex, paneId);

      const workerInfo: WorkerInfo = {
        name: workerName,
        index: workerIndex,
        role: workerRole,
        worker_cli: workerCli,
        assigned_tasks: [],
        pid: panePid ?? undefined,
        pane_id: paneId,
        working_dir: workerCwd,
        worktree_repo_root: workerWorkspace ? workerWorkspace.repoRoot : undefined,
        worktree_path: workerWorkspace ? workerWorkspace.worktreePath : undefined,
        worktree_branch: workerWorkspace ? (workerWorkspace.branchName ?? undefined) : undefined,
        worktree_base_ref: workerWorkspace?.baseRef,
        worktree_detached: workerWorkspace ? workerWorkspace.detached : undefined,
        worktree_created: workerWorkspace ? workerWorkspace.created : undefined,
        team_state_root: teamStateRoot,
      };

      await writeWorkerIdentity(sanitized, workerName, workerInfo, leaderCwd);

      // Wait for worker readiness
      const readyTimeoutMs = resolveWorkerReadyTimeoutMs(env);
      const skipReadyWait = env.OMX_TEAM_SKIP_READY_WAIT === '1';
      if (!skipReadyWait) {
        const ready = waitForWorkerReady(sessionName, workerIndex, readyTimeoutMs, paneId);
        if (!ready) {
          console.log(`[omx:scaling] Warning: worker ${workerName} did not become ready within timeout`);
        }
      }

      // Get assigned tasks for this worker
      const workerTasks = persistedTasks.filter(t => t.owner === workerName);

      const inbox = generateInitialInbox(workerName, sanitized, agentType, workerTasks, {
        teamStateRoot,
        leaderCwd,
        workerRole: runtimeRole,
        rolePromptContent: rawRolePromptContent ?? undefined,
        worktreeRootAgentsCanonical: Boolean(workerWorkspace?.worktreePath),
        approvedContextSection,
        workerGoalInstruction: buildTeamWorkerGoalInstruction(sanitized, workerName, workerTasks, { teamStateRoot }),
      });

      const triggerDirective = buildTriggerDirective(
        workerName,
        sanitized,
        resolveInstructionStateRoot(workerInfo.worktree_path),
      );
      const queued = await queueInboxInstruction({
        teamName: sanitized,
        workerName,
        workerIndex,
        paneId,
        inbox,
        triggerMessage: triggerDirective.text,
        intent: triggerDirective.intent,
        cwd: leaderCwd,
        transportPreference: dispatchPolicy.dispatch_mode,
        fallbackAllowed: true,
        inboxCorrelationKey: `scale_up:${workerName}`,
        notify: async (_target, message) => {
          if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback') {
            return { ok: true, transport: 'hook', reason: 'queued_for_hook_dispatch' };
          }
          return await notifyWorkerPaneOutcome(sessionName, workerIndex, message, paneId, workerCli);
        },
      });
      let outcome = queued;
      if (dispatchPolicy.dispatch_mode === 'hook_preferred_with_fallback' && queued.request_id) {
        const receipt = await waitForDispatchReceipt(sanitized, queued.request_id, leaderCwd, {
          timeoutMs: dispatchPolicy.dispatch_ack_timeout_ms,
          pollMs: 50,
        });
        if (receipt && (receipt.status === 'notified' || receipt.status === 'delivered')) {
          outcome = { ok: true, transport: 'hook', reason: `hook_receipt_${receipt.status}`, request_id: queued.request_id };
        } else {
          const fallback = await notifyWorkerPaneOutcome(sessionName, workerIndex, triggerDirective.text, paneId, workerCli);
          if (receipt?.status === 'failed') {
            if (fallback.ok) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: true,
                transport: fallback.transport,
                reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}`,
                request_id: queued.request_id,
              };
            } else {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
              outcome = {
                ok: false,
                transport: fallback.transport,
                reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
                request_id: queued.request_id,
              };
            }
          } else if (fallback.ok) {
            const marked = await markDispatchRequestNotified(
              sanitized,
              queued.request_id,
              { last_reason: `fallback_confirmed:${fallback.reason}` },
              leaderCwd,
            );
            if (!marked) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                'failed',
                'failed',
                { last_reason: `fallback_confirmed_after_failed_receipt:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: true,
              transport: fallback.transport,
              reason: `hook_timeout_fallback_confirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          } else {
            const current = await readDispatchRequest(sanitized, queued.request_id, leaderCwd);
            if (current) {
              await transitionDispatchRequest(
                sanitized,
                queued.request_id,
                current.status,
                'failed',
                { last_reason: `fallback_attempted_but_unconfirmed:${fallback.reason}` },
                leaderCwd,
              ).catch(() => {});
            }
            outcome = {
              ok: false,
              transport: fallback.transport,
              reason: `fallback_attempted_but_unconfirmed:${fallback.reason}`,
              request_id: queued.request_id,
            };
          }
        }
      }
      // Retry dispatch once if a trust prompt is blocking the worker pane (fixes #393).
      if (!outcome.ok && dismissTrustPromptIfPresent(sessionName, workerIndex, paneId)) {
        waitForWorkerReady(sessionName, workerIndex, readyTimeoutMs, paneId);
        const retry = await notifyWorkerPaneOutcome(sessionName, workerIndex, triggerDirective.text, paneId, workerCli);
        if (retry.ok) {
          outcome = retry;
        }
      }
      if (!outcome.ok) {
        return await rollbackScaleUp(`scale_up_dispatch_failed:${workerName}:${outcome.reason}`, {
          paneId,
          workerName,
          worktreePath: workerWorkspace?.worktreePath,
        });
      }

      addedWorkers.push(workerInfo);
      config.workers.push(workerInfo);
      config.worker_count = config.workers.length;
      config.next_worker_index = nextIndex;
      await saveTeamConfig(config, leaderCwd);
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_up: added ${count} worker(s), new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      addedWorkers,
      newWorkerCount: config.worker_count,
      nextWorkerIndex: nextIndex,
    };
  });
}

// ── Scale Down ────────────────────────────────────────────────────────────────

export interface ScaleDownOptions {
  /** Worker names to remove. If empty, removes idle workers up to `count`. */
  workerNames?: string[];
  /** Number of idle workers to remove (used when workerNames is not specified). */
  count?: number;
  /** Force kill without waiting for drain. Default: false. */
  force?: boolean;
  /** Drain timeout in milliseconds. Default: 30000. */
  drainTimeoutMs?: number;
}

function exposeWorkerRootAgentsChanges(worktrees: EnsureWorktreeResult[]): string[] {
  const exposed: string[] = [];
  for (const worktree of worktrees) {
    const tracked = execFileSync('git', ['ls-files', '-v', '--', 'AGENTS.md'], {
      cwd: worktree.worktreePath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!tracked.split(/\r?\n/).some((line) => /^[Ss] /.test(line))) continue;
    execFileSync('git', ['update-index', '--no-skip-worktree', 'AGENTS.md'], {
      cwd: worktree.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exposed.push(worktree.worktreePath);
  }
  return exposed;
}

function restoreWorkerRootAgentsSkipWorktree(worktreePaths: string[]): string[] {
  const errors: string[] = [];
  for (const worktreePath of worktreePaths) {
    try {
      execFileSync('git', ['update-index', '--skip-worktree', 'AGENTS.md'], {
        cwd: worktreePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      errors.push(`${worktreePath}:${String(error)}`);
    }
  }
  return errors;
}

function isMissingTmuxPaneError(error: string): boolean {
  return /(?:can't find|no such) pane\b/i.test(error);
}

async function ownsGeneratedRootAgents(worktreePath: string): Promise<boolean> {
  try {
    const rawBackupPath = execFileSync(
      'git',
      ['rev-parse', '--git-path', 'omx/root-agents-backup.json'],
      { cwd: worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const backupPath = isAbsolute(rawBackupPath) ? rawBackupPath : resolve(worktreePath, rawBackupPath);
    const backup = JSON.parse(await readFile(backupPath, 'utf-8')) as {
      generatedContent?: unknown;
      ownershipToken?: unknown;
    };
    if (typeof backup.generatedContent !== 'string' || typeof backup.ownershipToken !== 'string') {
      return false;
    }
    return await readFile(join(worktreePath, 'AGENTS.md'), 'utf-8') === backup.generatedContent;
  } catch {
    return false;
  }
}

async function worktreeHasChanges(worktree: EnsureWorktreeResult): Promise<boolean> {
  const status = execFileSync(
    'git',
    ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'],
    { cwd: worktree.worktreePath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const statusLines = status.split(/\r?\n/).filter(Boolean);
  const ownsRootAgents = await ownsGeneratedRootAgents(worktree.worktreePath);
  if (statusLines.some((line) => !ownsRootAgents || line.slice(3) !== 'AGENTS.md')) return true;
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktree.worktreePath,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return worktree.baseRef
    ? head !== worktree.baseRef
    : worktree.detached || Boolean(worktree.branchName);
}

async function changedWorktrees(worktrees: EnsureWorktreeResult[]): Promise<EnsureWorktreeResult[]> {
  const changed = await Promise.all(worktrees.map(async (worktree) => ({
    worktree,
    changed: await worktreeHasChanges(worktree),
  })));
  return changed.filter((entry) => entry.changed).map((entry) => entry.worktree);
}

/**
 * Remove workers from a running team.
 *
 * Sets targeted workers to 'draining' status, waits for them to finish
 * current work (or force kills), then removes tmux panes and updates config.
 */
export async function scaleDown(
  teamName: string,
  cwd: string,
  options: ScaleDownOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScaleDownResult | ScaleError> {
  assertScalingEnabled(env);

  const sanitized = sanitizeTeamName(teamName);
  const leaderCwd = resolve(cwd);
  const force = options.force === true;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;

  return await withScalingLock(sanitized, leaderCwd, async (): Promise<ScaleDownResult | ScaleError> => {
    const config = await readTeamConfig(sanitized, leaderCwd);
    if (!config) {
      return { ok: false, error: `Team ${sanitized} not found` };
    }

    // Determine which workers to remove
    let targetWorkers: WorkerInfo[];
    if (options.workerNames && options.workerNames.length > 0) {
      targetWorkers = [];
      for (const name of options.workerNames) {
        const w = config.workers.find(w => w.name === name);
        if (!w) {
          return { ok: false, error: `Worker ${name} not found in team ${sanitized}` };
        }
        targetWorkers.push(w);
      }
    } else {
      const count = options.count ?? 1;
      if (!Number.isInteger(count) || count < 1) {
        return { ok: false, error: `count must be a positive integer (got ${count})` };
      }
      // Find idle workers to remove
      const idleWorkers: WorkerInfo[] = [];
      for (const w of config.workers) {
        const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
        if (status.state === 'idle' || status.state === 'done' || status.state === 'unknown') {
          idleWorkers.push(w);
        }
      }
      if (idleWorkers.length < count && !force) {
        return {
          ok: false,
          error: `Not enough idle workers to remove: found ${idleWorkers.length}, requested ${count}. Use force=true to remove busy workers.`,
        };
      }
      targetWorkers = idleWorkers.slice(0, count);
      if (force && targetWorkers.length < count) {
        // Add non-idle workers if force is enabled
        const remaining = count - targetWorkers.length;
        const targetNames = new Set(targetWorkers.map(w => w.name));
        const nonIdle = config.workers.filter(w => !targetNames.has(w.name));
        targetWorkers.push(...nonIdle.slice(0, remaining));
      }
    }

    if (targetWorkers.length === 0) {
      return { ok: false, error: 'No workers selected for removal' };
    }

    // Minimum worker guard: must keep at least 1 worker
    if (config.workers.length - targetWorkers.length < 1) {
      return { ok: false, error: 'Cannot remove all workers — at least 1 must remain' };
    }

    const missingWorktreeBaselines = targetWorkers
      .filter((worker) => worker.worktree_created === true && worker.worktree_detached === true)
      .filter((worker) => !worker.worktree_base_ref)
      .map((worker) => worker.name);
    if (missingWorktreeBaselines.length > 0) {
      return {
        ok: false,
        error: `scale_down_worktree_baseline_missing:${missingWorktreeBaselines.join(',')}`,
      };
    }

    const expectedPaneOwner = config.tmux_pane_owner_id?.trim() ?? '';
    const paneWorkers = targetWorkers.filter((worker): worker is WorkerInfo & { pane_id: string } => (
      typeof worker.pane_id === 'string' && worker.pane_id.trim().length > 0
    ));
    if (paneWorkers.length > 0 && expectedPaneOwner === '') {
      return { ok: false, error: 'scale_down_pane_owner_authority_missing' };
    }
    const livePaneWorkers: Array<WorkerInfo & { pane_id: string }> = [];
    let alreadyTerminated = false;
    for (const worker of paneWorkers) {
      const paneId = worker.pane_id.trim();
      const owner = readPaneTeamOwnerTagResult(paneId);
      if (owner.status === 'error') {
        if (isMissingTmuxPaneError(owner.error)) {
          alreadyTerminated = true;
          continue;
        }
        return {
          ok: false,
          error: `scale_down_pane_owner_read_failed:${worker.name}:${paneId}:${owner.error}`,
        };
      }
      if (owner.status === 'missing') {
        return { ok: false, error: `scale_down_pane_owner_missing:${worker.name}:${paneId}` };
      }
      if (owner.value !== expectedPaneOwner) {
        return { ok: false, error: `scale_down_pane_owner_mismatch:${worker.name}:${paneId}` };
      }
      livePaneWorkers.push(worker);
    }

    const sessionName = config.tmux_session;
    const previousStatuses = new Map<string, WorkerStatus>();
    const restorePreviousStatuses = async (): Promise<string[]> => {
      const errors: string[] = [];
      for (const worker of targetWorkers) {
        const previous = previousStatuses.get(worker.name);
        if (!previous) continue;
        try {
          await writeWorkerStatus(sanitized, worker.name, previous, leaderCwd);
        } catch (error) {
          errors.push(`${worker.name}:${String(error)}`);
        }
      }
      return errors;
    };
    const markFailedStatuses = async (reason: string): Promise<string[]> => {
      const errors: string[] = [];
      for (const worker of targetWorkers) {
        try {
          await writeWorkerStatus(sanitized, worker.name, {
            state: 'failed',
            reason,
            updated_at: new Date().toISOString(),
          }, leaderCwd);
        } catch (error) {
          errors.push(`${worker.name}:${String(error)}`);
        }
      }
      return errors;
    };

    // Phase 1: Set workers to 'draining' status
    for (const w of targetWorkers) {
      previousStatuses.set(w.name, await readWorkerStatus(sanitized, w.name, leaderCwd));
      const drainingStatus: WorkerStatus = {
        state: 'draining',
        reason: 'scale_down requested by leader',
        updated_at: new Date().toISOString(),
      };
      await writeWorkerStatus(sanitized, w.name, drainingStatus, leaderCwd);
    }

    // Phase 2: Wait for draining workers to finish or timeout
    if (!force) {
      const deadline = Date.now() + drainTimeoutMs;
      while (Date.now() < deadline) {
        const allDrained = await Promise.all(
          targetWorkers.map(async (w) => {
            const status = await readWorkerStatus(sanitized, w.name, leaderCwd);
            return status.state === 'idle' || status.state === 'done' ||
                   !isWorkerAlive(sessionName, w.index, w.pane_id);
          }),
        );
        if (allDrained.every(Boolean)) break;
        await new Promise(r => setTimeout(r, 2_000));
      }

      const undrainedWorkers: string[] = [];
      for (const worker of targetWorkers) {
        const status = await readWorkerStatus(sanitized, worker.name, leaderCwd);
        if (
          status.state !== 'idle'
          && status.state !== 'done'
          && isWorkerAlive(sessionName, worker.index, worker.pane_id)
        ) {
          undrainedWorkers.push(worker.name);
        }
      }
      if (undrainedWorkers.length > 0) {
        const restoreErrors = await restorePreviousStatuses();
        return {
          ok: false,
          error: `scale_down_drain_timeout:${undrainedWorkers.join(',')}`
            + (restoreErrors.length > 0 ? `;scale_down_restore_failed:${restoreErrors.join('|')}` : ''),
        };
      }
    }

    const worktreesToPreserve: EnsureWorktreeResult[] = targetWorkers
      .filter((worker) =>
        typeof worker.worktree_repo_root === 'string'
        && worker.worktree_repo_root.length > 0
        && typeof worker.worktree_path === 'string'
        && worker.worktree_path.length > 0,
      )
      .map((worker) => ({
        enabled: true,
        repoRoot: worker.worktree_repo_root as string,
        worktreePath: resolve(worker.worktree_path as string),
        baseRef: worker.worktree_base_ref,
        detached: worker.worktree_detached === true,
        branchName: worker.worktree_branch ?? null,
        created: true,
        reused: false,
        createdBranch: false,
      }));

    let exposedRootAgentsWorktrees: string[] = [];
    if (worktreesToPreserve.length > 0) {
      try {
        exposedRootAgentsWorktrees = exposeWorkerRootAgentsChanges(worktreesToPreserve);
        const changed = await changedWorktrees(worktreesToPreserve);
        if (changed.length > 0) {
          await rollbackProvisionedWorktrees(changed, {
            preserveWorktrees: true,
            salvageContext: `team-scale-down-${sanitized}`,
          });
          const restoreErrors = [
            ...restoreWorkerRootAgentsSkipWorktree(exposedRootAgentsWorktrees),
            ...await restorePreviousStatuses(),
          ];
          return {
            ok: false,
            error: `scale_down_worktree_preserved:${changed.map((worktree) => worktree.worktreePath).join(',')}`
              + (restoreErrors.length > 0 ? `;scale_down_restore_failed:${restoreErrors.join('|')}` : ''),
          };
        }
      } catch (error) {
        const restoreErrors = [
          ...restoreWorkerRootAgentsSkipWorktree(exposedRootAgentsWorktrees),
          ...await restorePreviousStatuses(),
        ];
        return {
          ok: false,
          error: `scale_down_worktree_preservation_failed:${String(error)}`
            + (restoreErrors.length > 0 ? `;scale_down_restore_failed:${restoreErrors.join('|')}` : ''),
        };
      }
    }

    const paneTeardown = await teardownWorkerPanes(
      livePaneWorkers.map((worker) => worker.pane_id.trim()),
      { leaderPaneId: config.leader_pane_id, hudPaneId: config.hud_pane_id },
    );
    const quiesced = alreadyTerminated || paneTeardown.kill.succeeded > 0;
    if (paneTeardown.kill.failed > 0) {
      const statusErrors = await markFailedStatuses('scale_down_worker_quiesce_failed');
      return {
        ok: false,
        error: `scale_down_worker_quiesce_failed:${paneTeardown.kill.failed}`
          + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
      };
    }

    if (worktreesToPreserve.length > 0) {
      try {
        const changed = await changedWorktrees(worktreesToPreserve);
        if (changed.length > 0) {
          await rollbackProvisionedWorktrees(changed, {
            preserveWorktrees: true,
            salvageContext: `team-scale-down-${sanitized}`,
          });
          const restoreErrors = restoreWorkerRootAgentsSkipWorktree(exposedRootAgentsWorktrees);
          const statusErrors = quiesced
            ? await markFailedStatuses('scale_down_worktree_preserved_after_quiesce')
            : await restorePreviousStatuses();
          return {
            ok: false,
            error: `scale_down_worktree_preserved_after_quiesce:${changed.map((worktree) => worktree.worktreePath).join(',')}`
              + ([...restoreErrors, ...statusErrors].length > 0
                ? `;scale_down_restore_failed:${[...restoreErrors, ...statusErrors].join('|')}`
                : ''),
          };
        }
      } catch (error) {
        const statusErrors = quiesced
          ? await markFailedStatuses('scale_down_final_preservation_failed')
          : await restorePreviousStatuses();
        return {
          ok: false,
          error: `scale_down_final_preservation_failed:${String(error)}`
            + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
        };
      }
    }

    for (const worker of targetWorkers) {
      if (!worker.worktree_path) continue;
      try {
        await removeWorkerWorktreeRootAgentsFile(
          sanitized,
          worker.name,
          worker.team_state_root ?? config.team_state_root ?? resolveCanonicalTeamStateRoot(leaderCwd),
          worker.worktree_path,
        );
      } catch (error) {
        const statusErrors = await markFailedStatuses('scale_down_worktree_instruction_cleanup_failed');
        return {
          ok: false,
          error: `scale_down_worktree_instruction_cleanup_failed:${worker.name}:${String(error)}`
            + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
        };
      }
    }

    const detachedPaths = new Set(
      targetWorkers
        .filter((worker) =>
          worker.worktree_created === true
          && worker.worktree_detached === true
          && typeof worker.worktree_path === 'string'
          && worker.worktree_path.length > 0,
        )
        .map((worker) => resolve(worker.worktree_path as string)),
    );
    const detachedWorktreesToRollback = worktreesToPreserve.filter((worktree) => (
      detachedPaths.has(worktree.worktreePath)
    ));
    if (detachedWorktreesToRollback.length > 0) {
      try {
        const outcomes = await rollbackProvisionedWorktrees(detachedWorktreesToRollback, {
          salvageContext: `team-scale-down-${sanitized}`,
        });
        const preserved = outcomes.filter((outcome) => !outcome.removed);
        if (preserved.length > 0) {
          const statusErrors = await markFailedStatuses('scale_down_worktree_preserved_after_quiesce');
          return {
            ok: false,
            error: `scale_down_worktree_preserved_after_quiesce:${preserved.map((outcome) => outcome.worktreePath).join(',')}`
              + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
          };
        }
      } catch (error) {
        const statusErrors = await markFailedStatuses('scale_down_worktree_cleanup_failed');
        return {
          ok: false,
          error: `scale_down_worktree_cleanup_failed:${String(error)}`
            + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
        };
      }
    }

    const removedNames = targetWorkers.map((worker) => worker.name);
    const removedSet = new Set(removedNames);
    config.workers = config.workers.filter(w => !removedSet.has(w.name));
    config.worker_count = config.workers.length;
    try {
      await saveTeamConfig(config, leaderCwd);
    } catch (error) {
      const statusErrors = await markFailedStatuses('scale_down_state_transition_failed');
      return {
        ok: false,
        error: `scale_down_state_transition_failed:${String(error)}`
          + (statusErrors.length > 0 ? `;scale_down_status_failed:${statusErrors.join('|')}` : ''),
      };
    }

    await appendTeamEvent(sanitized, {
      type: 'team_leader_nudge',
      worker: 'leader-fixed',
      reason: `scale_down: removed ${removedNames.length} worker(s) [${removedNames.join(', ')}], new count=${config.worker_count}`,
    }, leaderCwd);

    return {
      ok: true,
      removedWorkers: removedNames,
      newWorkerCount: config.worker_count,
    };
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveWorkerReadyTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.OMX_TEAM_READY_TIMEOUT_MS;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (Number.isFinite(parsed) && parsed >= 5_000) return parsed;
  return 45_000;
}

function resolveWorkerLaunchArgsForScaling(
  env: NodeJS.ProcessEnv,
  agentType: string,
  preferredReasoning?: TeamReasoningEffort,
  codexHomeOverride?: string,
): string[] {
  const inheritedLeaderModel = typeof env[TEAM_WORKER_INHERITED_MODEL_ENV] === 'string'
    ? env[TEAM_WORKER_INHERITED_MODEL_ENV]?.trim()
    : undefined;
  const inheritedArgs = inheritedLeaderModel ? ['--model', inheritedLeaderModel] : [];
  const fallbackModel = resolveAgentDefaultModel(agentType, codexHomeOverride ?? env.CODEX_HOME);

  return resolveTeamWorkerLaunchArgs({
    existingRaw: env.OMX_TEAM_WORKER_LAUNCH_ARGS,
    inheritedArgs,
    fallbackModel,
    preferredReasoning,
    honorExactRoleModel: shouldHonorAgentExactModel(agentType, codexHomeOverride),
  });
}
