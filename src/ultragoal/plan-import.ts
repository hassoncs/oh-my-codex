import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface NeutralPlanNode {
  id: string;
  title: string;
  objective: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
  dependsOn?: string[];
  parallelWith?: string[];
  intent: {
    kind: 'implementation' | 'planning' | 'review' | 'research' | 'operations' | 'exploration' | 'merge' | 'curation';
    effort: number;
    risk: 'low' | 'medium' | 'high';
    qualityFloor: 'cheap' | 'work' | 'smart';
  };
  repo?: string;
  ownsPaths?: string[];
  writeExclusions?: string[];
  deliverable?: string;
  proof?: string[];
  [key: string]: unknown;
}

export interface NeutralPlanGraph {
  schema: 'ch5.plan-graph.v1';
  planId: string;
  createdAt: string;
  updatedAt: string;
  nodes: NeutralPlanNode[];
  [key: string]: unknown;
}

export interface NeutralPlanConsensus {
  schema: 'ch5.plan-consensus.v1';
  status: 'approved';
  planId: string;
  planRevision: string;
  artifacts: {
    'graph.json': string;
    'graph-validation.json': string;
    [key: string]: unknown;
  };
  semanticValidation: {
    status: 'pass';
    receiptPath: string;
    receiptSha256: string;
    [key: string]: unknown;
  };
  ralplanConsensusGate: {
    complete: true;
    architectApproved: true;
    criticApproved: true;
    criticRetryPending: false;
    planRevision: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface NeutralPlanValidation {
  schema: 'ch5.plan-graph-validation.v1';
  planId: string;
  valid: true;
  planRevision: string;
  [key: string]: unknown;
}

export interface ValidatedNeutralPlan {
  graph: NeutralPlanGraph;
  consensus: NeutralPlanConsensus;
  validation: NeutralPlanValidation;
  graphBytes: string;
  consensusBytes: string;
  validationBytes: string;
  graphDigest: string;
  validationDigest: string;
  planRevision: string;
}

export class NeutralPlanImportError extends Error {
  readonly code:
    | 'invalid_json'
    | 'invalid_graph'
    | 'invalid_consensus'
    | 'invalid_validation'
    | 'digest_mismatch'
    | 'consensus_mismatch'
    | 'semantic_invalidity';

  constructor(message: string, code: NeutralPlanImportError['code']) {
    super(message);
    this.name = 'NeutralPlanImportError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string, code: NeutralPlanImportError['code']): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NeutralPlanImportError(`Neutral plan ${label} must be a non-empty string.`, code);
  }
  return value;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function assertDigest(value: unknown, expected: string, label: string): void {
  const supplied = requiredString(value, label, 'digest_mismatch');
  if (supplied !== expected) {
    throw new NeutralPlanImportError(`${label} does not match the source artifact digest.`, 'digest_mismatch');
  }
}

function assertIso(value: unknown, label: string, code: NeutralPlanImportError['code']): string {
  const text = requiredString(value, label, code);
  if (Number.isNaN(Date.parse(text))) {
    throw new NeutralPlanImportError(`${label} must be an ISO datetime.`, code);
  }
  return text;
}

function validateIntent(value: unknown, label: string): NeutralPlanNode['intent'] {
  if (!isRecord(value)
    || !['implementation', 'planning', 'review', 'research', 'operations', 'exploration', 'merge', 'curation'].includes(String(value.kind))
    || !Number.isInteger(value.effort) || Number(value.effort) < 1 || Number(value.effort) > 5
    || !['low', 'medium', 'high'].includes(String(value.risk))
    || !['cheap', 'work', 'smart'].includes(String(value.qualityFloor))
    || Object.keys(value).some((key) => !['kind', 'effort', 'risk', 'qualityFloor'].includes(key))) {
    throw new NeutralPlanImportError(`${label} must match strict Fabric intent shape.`, 'semantic_invalidity');
  }
  return value as NeutralPlanNode['intent'];
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new NeutralPlanImportError(`${label} must be an array of non-empty strings.`, 'semantic_invalidity');
  }
  return value;
}

function validateGraph(value: unknown): NeutralPlanGraph {
  if (!isRecord(value) || value.schema !== 'ch5.plan-graph.v1') {
    throw new NeutralPlanImportError('graph.json must match ch5.plan-graph.v1.', 'invalid_graph');
  }
  const planId = requiredString(value.planId, 'graph.planId', 'invalid_graph');
  assertIso(value.createdAt, 'graph.createdAt', 'invalid_graph');
  assertIso(value.updatedAt, 'graph.updatedAt', 'invalid_graph');
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new NeutralPlanImportError('graph.nodes must contain at least one node.', 'semantic_invalidity');
  }

  const ids = new Set<string>();
  const nodes = value.nodes.map((raw, index) => {
    if (!isRecord(raw)) throw new NeutralPlanImportError(`graph.nodes[${index}] must be an object.`, 'semantic_invalidity');
    const label = `graph.nodes[${index}]`;
    const id = requiredString(raw.id, `${label}.id`, 'semantic_invalidity');
    if (ids.has(id)) throw new NeutralPlanImportError(`Duplicate neutral plan node id: ${id}.`, 'semantic_invalidity');
    ids.add(id);
    const title = requiredString(raw.title, `${label}.title`, 'semantic_invalidity');
    const objective = requiredString(raw.objective, `${label}.objective`, 'semantic_invalidity');
    const status = requiredString(raw.status, `${label}.status`, 'semantic_invalidity') as NeutralPlanNode['status'];
    if (!['pending', 'in_progress', 'blocked', 'complete', 'failed'].includes(status)) {
      throw new NeutralPlanImportError(`${label}.status is not canonical.`, 'semantic_invalidity');
    }
    const dependsOn = optionalStringArray(raw.dependsOn, `${label}.dependsOn`);
    const parallelWith = optionalStringArray(raw.parallelWith, `${label}.parallelWith`);
    const ownsPaths = optionalStringArray(raw.ownsPaths, `${label}.ownsPaths`);
    const writeExclusions = optionalStringArray(raw.writeExclusions, `${label}.writeExclusions`);
    const proof = optionalStringArray(raw.proof, `${label}.proof`);
    if (raw.repo !== undefined) requiredString(raw.repo, `${label}.repo`, 'semantic_invalidity');
    if (raw.deliverable !== undefined) requiredString(raw.deliverable, `${label}.deliverable`, 'semantic_invalidity');
    return {
      ...raw,
      id,
      title,
      objective,
      status,
      createdAt: assertIso(raw.createdAt, `${label}.createdAt`, 'semantic_invalidity'),
      updatedAt: assertIso(raw.updatedAt, `${label}.updatedAt`, 'semantic_invalidity'),
      intent: validateIntent(raw.intent, `${label}.intent`),
      ...(dependsOn ? { dependsOn } : {}),
      ...(parallelWith ? { parallelWith } : {}),
      ...(ownsPaths ? { ownsPaths } : {}),
      ...(writeExclusions ? { writeExclusions } : {}),
      ...(proof ? { proof } : {}),
    } as NeutralPlanNode;
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!nodeMap.has(dependency)) {
        throw new NeutralPlanImportError(`Node ${node.id} depends on missing node ${dependency}.`, 'semantic_invalidity');
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new NeutralPlanImportError(`Neutral plan dependency cycle includes ${id}.`, 'semantic_invalidity');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodeMap.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  return { ...value, planId, nodes } as NeutralPlanGraph;
}

function validateConsensus(value: unknown, graph: NeutralPlanGraph): NeutralPlanConsensus {
  if (!isRecord(value) || value.schema !== 'ch5.plan-consensus.v1') {
    throw new NeutralPlanImportError('consensus.json must match ch5.plan-consensus.v1.', 'invalid_consensus');
  }
  if (value.status !== 'approved') throw new NeutralPlanImportError('consensus.json status must be approved.', 'consensus_mismatch');
  const planId = requiredString(value.planId, 'consensus.planId', 'invalid_consensus');
  if (planId !== graph.planId) throw new NeutralPlanImportError('Consensus planId does not match graph planId.', 'consensus_mismatch');
  const planRevision = requiredString(value.planRevision, 'consensus.planRevision', 'invalid_consensus');
  if (!/^sha256:[a-f0-9]{64}$/.test(planRevision)) throw new NeutralPlanImportError('consensus.planRevision must be a sha256 digest.', 'consensus_mismatch');
  if (!isRecord(value.artifacts)) throw new NeutralPlanImportError('consensus.artifacts is missing.', 'invalid_consensus');
  const semanticValidation = value.semanticValidation;
  if (!isRecord(semanticValidation) || semanticValidation.status !== 'pass') {
    throw new NeutralPlanImportError('consensus.semanticValidation.status must be pass.', 'consensus_mismatch');
  }
  const gate = value.ralplanConsensusGate;
  if (!isRecord(gate) || gate.complete !== true || gate.architectApproved !== true || gate.criticApproved !== true || gate.criticRetryPending !== false || gate.planRevision !== planRevision) {
    throw new NeutralPlanImportError('consensus.ralplanConsensusGate does not prove ordered approval for this plan revision.', 'consensus_mismatch');
  }
  return { ...value, planId, planRevision, artifacts: value.artifacts, semanticValidation, ralplanConsensusGate: gate } as NeutralPlanConsensus;
}

function validateGraphValidation(value: unknown, graph: NeutralPlanGraph, consensus: NeutralPlanConsensus): NeutralPlanValidation {
  if (!isRecord(value) || value.schema !== 'ch5.plan-graph-validation.v1' || value.valid !== true) {
    throw new NeutralPlanImportError('graph-validation.json must be a valid canonical graph-validation artifact.', 'invalid_validation');
  }
  const planId = requiredString(value.planId, 'graph-validation.planId', 'invalid_validation');
  const planRevision = requiredString(value.planRevision, 'graph-validation.planRevision', 'invalid_validation');
  if (planId !== graph.planId || planRevision !== consensus.planRevision) {
    throw new NeutralPlanImportError('graph-validation.json plan identity does not match graph/consensus.', 'consensus_mismatch');
  }
  return { ...value, planId, planRevision } as NeutralPlanValidation;
}

export async function readValidatedNeutralPlan(planDir: string): Promise<ValidatedNeutralPlan> {
  let graphBytes: string;
  let consensusBytes: string;
  let validationBytes: string;
  try {
    [graphBytes, consensusBytes, validationBytes] = await Promise.all([
      readFile(join(planDir, 'graph.json'), 'utf8'),
      readFile(join(planDir, 'consensus.json'), 'utf8'),
      readFile(join(planDir, 'graph-validation.json'), 'utf8'),
    ]);
  } catch {
    throw new NeutralPlanImportError(`Neutral plan directory must contain graph.json, consensus.json, and graph-validation.json: ${planDir}`, 'invalid_json');
  }
  let graphValue: unknown;
  let consensusValue: unknown;
  let validationValue: unknown;
  try {
    graphValue = JSON.parse(graphBytes);
    consensusValue = JSON.parse(consensusBytes);
    validationValue = JSON.parse(validationBytes);
  } catch {
    throw new NeutralPlanImportError('Neutral plan artifacts must be valid JSON.', 'invalid_json');
  }
  const graph = validateGraph(graphValue);
  const graphDigest = digest(graphBytes);
  const consensus = validateConsensus(consensusValue, graph);
  assertDigest(consensus.artifacts['graph.json'], graphDigest, 'consensus.artifacts.graph.json');
  const validation = validateGraphValidation(validationValue, graph, consensus);
  const validationDigest = digest(validationBytes);
  assertDigest(consensus.artifacts['graph-validation.json'], validationDigest, 'consensus.artifacts.graph-validation.json');
  assertDigest(consensus.semanticValidation.receiptSha256, validationDigest, 'consensus.semanticValidation.receiptSha256');
  return { graph, consensus, validation, graphBytes, consensusBytes, validationBytes, graphDigest, validationDigest, planRevision: consensus.planRevision };
}
