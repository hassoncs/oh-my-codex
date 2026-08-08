import { existsSync } from 'node:fs';
import { relative } from 'node:path';
import { allocateTasksToWorkers } from './allocation-policy.js';
import type { ApprovedRepositoryContextSummary } from '../planning/artifacts.js';
import { readTeamDagHandoffForLatestPlan, type TeamDagHandoff, type TeamDagNode, type TeamDagResolution, type TeamDagWorkerCountSource } from './dag-schema.js';

export interface LegacyTeamExecutionPlanInput {
  task: string;
  workerCount: number;
  agentType: string;
  explicitAgentType: boolean;
  explicitWorkerCount: boolean;
  cwd: string;
  buildLegacyPlan: (task: string, workerCount: number, agentType: string, explicitAgentType: boolean, explicitWorkerCount: boolean) => RepoAwareTeamExecutionPlan;
  allowDagHandoff?: boolean;
  dagFallbackReason?: string;
  approvedRepositoryContextSummary?: ApprovedRepositoryContextSummary;
}

export interface RepoAwareTask {
  subject: string;
  description: string;
  owner: string;
  role?: string;
  blocked_by?: string[];
  depends_on?: string[];
  symbolic_depends_on?: string[];
  requires_code_change?: boolean;
  filePaths?: string[];
  domains?: string[];
  lane?: string;
  allocation_reason?: string;
  symbolic_id?: string;
}

export interface TeamDecompositionMetadata {
  decomposition_source: 'dag_sidecar' | 'dag_markdown' | 'legacy_text';
  dag_artifact_path?: string;
  dag_resolution_warning?: string;
  fallback_reason?: string;
  worker_count_requested: number;
  worker_count_effective: number;
  worker_count_source: TeamDagWorkerCountSource;
  ready_lane_count: number;
  useful_lane_count: number;
  allocation_reasons: Record<string, string>;
  node_dependencies?: Record<string, string[]>;
  node_id_to_task_id?: Record<string, string>;
  task_hints?: Record<string, TaskHintSummary>;
  approved_context_summary?: ApprovedRepositoryContextSummary;
}

export interface TaskHintSummary {
  node_id?: string;
  lane?: string;
  filePaths?: string[];
  domains?: string[];
  depends_on?: string[];
  symbolic_depends_on?: string[];
  allocation_reason?: string;
}

export interface RepoAwareTeamExecutionPlan {
  workerCount: number;
  tasks: RepoAwareTask[];
  metadata?: TeamDecompositionMetadata;
  overOrchestrationNotice?: {
    code: 'team_over_orchestration_warning' | 'explicit_team_override_acknowledged';
    message: string;
  };
  /**
   * Raised when lanes were invented from the task string instead of read from the
   * plan. Heuristic lanes carry no file scope, so the allocator cannot keep two
   * workers off one file — that is a materially different run from a plan-derived
   * one, and it used to be visible only by reading `metadata.fallback_reason`
   * after the fact.
   */
  decompositionNotice?: {
    code: 'team_lanes_not_plan_derived';
    message: string;
  };
}

const DEFAULT_MAX_WORKERS = 20;
const IMPLEMENTATION_LANE_PATTERN = /\b(?:impl|implementation|code|build|feature|fix|refactor)\b/i;
const VERIFICATION_LANE_PATTERN = /\b(?:verify|verification|test|qa|review)\b/i;

function normalizePath(path: string): string {
  return path.replace(/^\.\//, '');
}

function pathExists(cwd: string, path: string): boolean {
  return existsSync(`${cwd}/${normalizePath(path)}`);
}

function inferDomains(node: TeamDagNode): string[] {
  const domains = new Set(node.domains ?? []);
  for (const path of node.filePaths ?? []) {
    const normalized = normalizePath(path);
    const first = normalized.split('/')[0];
    if (first) domains.add(first);
    const base = normalized.split('/').pop()?.replace(/\.[^.]+$/, '');
    if (base) domains.add(base);
  }
  return [...domains];
}

function enrichNodeDescription(node: TeamDagNode, cwd: string): string {
  const parts = [node.description];
  const files = (node.filePaths ?? []).map(normalizePath);
  if (files.length > 0) {
    const existing = files.filter((file) => pathExists(cwd, file));
    const missing = files.filter((file) => !pathExists(cwd, file));
    parts.push(`File scope: ${files.join(', ')}`);
    if (existing.length > 0) parts.push(`Existing paths: ${existing.map((file) => relative(cwd, `${cwd}/${file}`)).join(', ')}`);
    if (missing.length > 0) parts.push(`Planned/new paths: ${missing.join(', ')}`);
  }
  const domains = inferDomains(node);
  if (domains.length > 0) parts.push(`Domains: ${domains.join(', ')}`);
  if (node.lane) parts.push(`Lane: ${node.lane}`);
  if (node.acceptance?.length) parts.push(`Acceptance: ${node.acceptance.join('; ')}`);
  return parts.join('\n');
}

function topologicalSort(nodes: TeamDagNode[]): TeamDagNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inputIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      indegree.set(node.id, (indegree.get(node.id) ?? 0) + 1);
      outgoing.set(dep, [...(outgoing.get(dep) ?? []), node.id]);
    }
  }
  const ready = nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0);
  const sorted: TeamDagNode[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (inputIndex.get(a.id) ?? 0) - (inputIndex.get(b.id) ?? 0));
    const node = ready.shift()!;
    sorted.push(node);
    for (const next of outgoing.get(node.id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) ready.push(byId.get(next)!);
    }
  }
  if (sorted.length !== nodes.length) throw new Error('Team DAG contains a cycle');
  return sorted;
}

/**
 * How many ready nodes can run at once without two of them editing the same file.
 *
 * Nodes are grouped by *shared file paths*, transitively: `[a.ts]`, `[a.ts, b.ts]`
 * and `[b.ts, c.ts]` are one lane, not three. Grouping by whole-path-set equality
 * — which is what this did — counts overlapping-but-unequal scopes as independent
 * and widens the run into the exact collision the file scope exists to prevent.
 *
 * A node declaring no file scope is its own lane: unknown scope is not proof of
 * disjoint scope, but refusing to fan out on unscoped nodes would collapse every
 * plan that has not filled `filePaths` in to a single worker.
 */
function firstReadyLaneCount(nodes: TeamDagNode[]): number {
  const ready = nodes.filter((node) => (node.depends_on?.length ?? 0) === 0);
  if (ready.length === 0) return 1;

  const groupOfPath = new Map<string, number>();
  const parent: number[] = [];
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    for (let cursor = index; parent[cursor] !== root; ) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };

  let laneCount = 0;
  for (const node of ready) {
    const files = (node.filePaths ?? []).map(normalizePath);
    if (files.length === 0) {
      laneCount += 1;
      continue;
    }
    const own = parent.length;
    parent.push(own);
    for (const file of files) {
      const seen = groupOfPath.get(file);
      if (seen === undefined) groupOfPath.set(file, own);
      else union(seen, own);
    }
  }

  const distinctScopedGroups = new Set<number>();
  for (let index = 0; index < parent.length; index += 1) distinctScopedGroups.add(find(index));
  return Math.max(1, laneCount + distinctScopedGroups.size);
}

function hasImplementationWork(nodes: TeamDagNode[]): boolean {
  return nodes.some((node) => {
    if (node.requires_code_change === true) return true;
    const text = `${node.lane ?? ''} ${node.role ?? ''} ${node.subject} ${node.description}`;
    return IMPLEMENTATION_LANE_PATTERN.test(text) && !VERIFICATION_LANE_PATTERN.test(text);
  });
}

function usefulLaneCount(nodes: TeamDagNode[], readyLaneCount: number, reserveVerification: boolean): number {
  const laneLabels = new Set(nodes.map((node) => node.lane?.trim()).filter(Boolean) as string[]);
  const base = Math.max(readyLaneCount, laneLabels.size || readyLaneCount);
  if (reserveVerification && hasImplementationWork(nodes)) return Math.max(base, Math.min(nodes.length, readyLaneCount + 1));
  return base;
}

function resolveWorkerCount(params: {
  requested: number;
  explicitWorkerCount: boolean;
  dag: TeamDagHandoff;
  readyLaneCount: number;
  usefulLaneCount: number;
}): { count: number; source: TeamDagWorkerCountSource } {
  const policy = params.dag.worker_policy;
  const source: TeamDagWorkerCountSource = params.explicitWorkerCount
    ? 'cli-explicit'
    : policy?.count_source ?? (policy?.requested_count ? 'plan-suggested' : 'default-derived');
  const requested = params.explicitWorkerCount
    ? params.requested
    : policy?.requested_count ?? params.requested;
  const hardCap = Math.min(DEFAULT_MAX_WORKERS, policy?.max_count ?? DEFAULT_MAX_WORKERS);
  if (source === 'cli-explicit') {
    const cap = policy?.strict_max_count === true ? hardCap : DEFAULT_MAX_WORKERS;
    return { count: Math.max(1, Math.min(requested, cap)), source };
  }
  return {
    count: Math.max(1, Math.min(requested, hardCap, params.usefulLaneCount)),
    source,
  };
}

function buildFromDag(input: LegacyTeamExecutionPlanInput, resolution: TeamDagResolution & { dag: TeamDagHandoff }): RepoAwareTeamExecutionPlan {
  const sorted = topologicalSort(resolution.dag.nodes);
  const readyLaneCount = firstReadyLaneCount(sorted);
  const useful = usefulLaneCount(sorted, readyLaneCount, resolution.dag.worker_policy?.reserve_verification_lane !== false);
  const countPolicy = resolveWorkerCount({
    requested: input.workerCount,
    explicitWorkerCount: input.explicitWorkerCount,
    dag: resolution.dag,
    readyLaneCount,
    usefulLaneCount: useful,
  });
  const workers = Array.from({ length: countPolicy.count }, (_, index) => ({
    name: `worker-${index + 1}`,
    role: input.explicitAgentType ? input.agentType : undefined,
  }));

  const allocationInput = sorted.map((node) => ({
    subject: node.subject,
    description: enrichNodeDescription(node, input.cwd),
    role: input.explicitAgentType ? input.agentType : node.role,
    blocked_by: node.depends_on ?? [],
    symbolic_depends_on: node.depends_on ?? [],
    requires_code_change: node.requires_code_change,
    filePaths: node.filePaths,
    domains: inferDomains(node),
    lane: node.lane,
    symbolic_id: node.id,
  }));
  const allocated = allocateTasksToWorkers(allocationInput, workers);
  const allocationReasons: Record<string, string> = {};
  const tasks = allocated.map((task): RepoAwareTask => {
    allocationReasons[task.symbolic_id] = task.allocation_reason;
    const { blocked_by: _symbolicBlockedBy, ...runtimeTask } = task;
    return runtimeTask;
  });
  const nodeDependencies = Object.fromEntries(sorted.map((node) => [node.id, node.depends_on ?? []]));

  return {
    workerCount: countPolicy.count,
    tasks,
    metadata: {
      decomposition_source: resolution.source === 'sidecar' ? 'dag_sidecar' : 'dag_markdown',
      dag_artifact_path: resolution.path,
      dag_resolution_warning: resolution.warning,
      worker_count_requested: input.explicitWorkerCount
        ? input.workerCount
        : resolution.dag.worker_policy?.requested_count ?? input.workerCount,
      worker_count_effective: countPolicy.count,
      worker_count_source: countPolicy.source,
      ready_lane_count: readyLaneCount,
      useful_lane_count: useful,
      allocation_reasons: allocationReasons,
      node_dependencies: nodeDependencies,
      ...(input.approvedRepositoryContextSummary ? { approved_context_summary: input.approvedRepositoryContextSummary } : {}),
    },
  };
}

export function remapRepoAwareDecompositionMetadataToCreatedTasks(
  metadata: TeamDecompositionMetadata,
  plannedTasks: Array<Pick<RepoAwareTask, 'symbolic_id' | 'symbolic_depends_on' | 'lane' | 'filePaths' | 'domains' | 'allocation_reason'>>,
  createdTasks: Array<{ id: string }>,
): TeamDecompositionMetadata {
  const nodeIdToTaskId: Record<string, string> = {};
  plannedTasks.forEach((task, index) => {
    if (task.symbolic_id && createdTasks[index]?.id) {
      nodeIdToTaskId[task.symbolic_id] = createdTasks[index].id;
    }
  });

  const taskHints: Record<string, TaskHintSummary> = {};
  plannedTasks.forEach((task, index) => {
    const taskId = createdTasks[index]?.id;
    if (!taskId || !task.symbolic_id) return;
    const symbolicDeps = task.symbolic_depends_on ?? metadata.node_dependencies?.[task.symbolic_id] ?? [];
    taskHints[taskId] = {
      node_id: task.symbolic_id,
      lane: task.lane,
      filePaths: task.filePaths,
      domains: task.domains,
      depends_on: symbolicDeps.map((dep) => nodeIdToTaskId[dep]).filter(Boolean),
      symbolic_depends_on: symbolicDeps,
      allocation_reason: task.allocation_reason ?? metadata.allocation_reasons[task.symbolic_id],
    };
  });

  return {
    ...metadata,
    node_id_to_task_id: nodeIdToTaskId,
    task_hints: taskHints,
  };
}

export function buildRepoAwareTeamExecutionPlan(input: LegacyTeamExecutionPlanInput): RepoAwareTeamExecutionPlan {
  const resolution = input.allowDagHandoff === true
    ? readTeamDagHandoffForLatestPlan(input.cwd)
    : ({
      dag: null,
      source: 'none',
      error: input.dagFallbackReason ?? 'dag_handoff_not_approved_for_invocation',
    } satisfies TeamDagResolution);
  if (resolution.dag) return buildFromDag(input, resolution as TeamDagResolution & { dag: TeamDagHandoff });

  const legacy = input.buildLegacyPlan(input.task, input.workerCount, input.agentType, input.explicitAgentType, input.explicitWorkerCount);
  const fallbackReason = resolution.error ?? 'no_valid_dag';
  return {
    ...legacy,
    decompositionNotice: {
      code: 'team_lanes_not_plan_derived',
      message: `lanes were split from the task text, not from a plan DAG (${fallbackReason}). `
        + 'These lanes have no file scope, so nothing keeps two workers off the same file. '
        + 'For plan-derived, non-overlapping lanes run `$ralplan` first and then launch the exact '
        + '`omx team ...` command its approved-execution section prints.',
    },
    metadata: {
      decomposition_source: 'legacy_text',
      dag_artifact_path: resolution.path,
      fallback_reason: fallbackReason,
      worker_count_requested: input.workerCount,
      worker_count_effective: legacy.workerCount,
      worker_count_source: input.explicitWorkerCount ? 'cli-explicit' : 'default-derived',
      ready_lane_count: legacy.workerCount,
      useful_lane_count: legacy.workerCount,
      allocation_reasons: {},
      ...(input.approvedRepositoryContextSummary ? { approved_context_summary: input.approvedRepositoryContextSummary } : {}),
    },
  };
}
