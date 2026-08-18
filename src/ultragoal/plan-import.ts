import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface NeutralPlanNode {
  id: string;
  dependencies: string[];
  intent: unknown;
  ownership: unknown;
  deliverables: unknown;
  proofs: unknown;
  [key: string]: unknown;
}

export interface NeutralPlanGraph {
  planId: string;
  digest: string;
  nodes: NeutralPlanNode[];
  [key: string]: unknown;
}

export interface NeutralPlanConsensus {
  planId: string;
  graphDigest: string;
  [key: string]: unknown;
}

export interface ValidatedNeutralPlan {
  graph: NeutralPlanGraph;
  consensus: NeutralPlanConsensus;
  graphBytes: string;
  consensusBytes: string;
  digest: string;
}

export class NeutralPlanImportError extends Error {
  readonly code:
    | 'invalid_json'
    | 'invalid_graph'
    | 'invalid_consensus'
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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digestPayload(graph: Record<string, unknown>): string {
  const payload = { ...graph };
  delete payload.digest;
  delete payload.graphDigest;
  return JSON.stringify(canonicalize(payload));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requiredString(value: unknown, label: string, code: NeutralPlanImportError['code']): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new NeutralPlanImportError(`Neutral plan ${label} must be a non-empty string.`, code);
  }
  return value;
}

function validateGraph(value: unknown): NeutralPlanGraph {
  if (!isRecord(value)) throw new NeutralPlanImportError('graph.json must contain an object.', 'invalid_graph');
  const planId = requiredString(value.planId, 'graph.planId', 'invalid_graph');
  const digest = requiredString(value.digest ?? value.graphDigest, 'graph.digest', 'invalid_graph');
  if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
    throw new NeutralPlanImportError('graph.nodes must contain at least one node.', 'semantic_invalidity');
  }

  const ids = new Set<string>();
  const nodes = value.nodes.map((raw, index) => {
    if (!isRecord(raw)) throw new NeutralPlanImportError(`graph.nodes[${index}] must be an object.`, 'semantic_invalidity');
    const id = requiredString(raw.id, `graph.nodes[${index}].id`, 'semantic_invalidity');
    if (ids.has(id)) throw new NeutralPlanImportError(`Duplicate neutral plan node id: ${id}.`, 'semantic_invalidity');
    ids.add(id);
    if (!Array.isArray(raw.dependencies) || raw.dependencies.some((dependency) => typeof dependency !== 'string' || dependency.trim() === '')) {
      throw new NeutralPlanImportError(`graph.nodes[${index}].dependencies must be an array of non-empty strings.`, 'semantic_invalidity');
    }
    for (const field of ['intent', 'ownership', 'deliverables', 'proofs']) {
      if (!(field in raw)) throw new NeutralPlanImportError(`graph.nodes[${index}] is missing ${field}.`, 'semantic_invalidity');
    }
    return raw as NeutralPlanNode;
  });

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
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
    for (const dependency of nodeMap.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);

  return { ...value, planId, digest, nodes };
}

function validateConsensus(value: unknown, graph: NeutralPlanGraph): NeutralPlanConsensus {
  if (!isRecord(value)) throw new NeutralPlanImportError('consensus.json must contain an object.', 'invalid_consensus');
  const planId = requiredString(value.planId, 'consensus.planId', 'invalid_consensus');
  const graphDigest = requiredString(value.graphDigest ?? value.digest, 'consensus.graphDigest', 'invalid_consensus');
  const approved = value.approved === true
    || ['approve', 'approved', 'clear', 'pass', 'passed'].includes(String(value.status ?? value.verdict ?? '').toLowerCase());
  if (!approved) throw new NeutralPlanImportError('consensus.json must record approved consensus.', 'consensus_mismatch');
  if (planId !== graph.planId) throw new NeutralPlanImportError('Consensus planId does not match graph planId.', 'consensus_mismatch');
  if (graphDigest !== graph.digest) throw new NeutralPlanImportError('Consensus graph digest does not match graph digest.', 'consensus_mismatch');
  return { ...value, planId, graphDigest };
}

export async function readValidatedNeutralPlan(planDir: string): Promise<ValidatedNeutralPlan> {
  let graphBytes: string;
  let consensusBytes: string;
  try {
    [graphBytes, consensusBytes] = await Promise.all([
      readFile(join(planDir, 'graph.json'), 'utf8'),
      readFile(join(planDir, 'consensus.json'), 'utf8'),
    ]);
  } catch {
    throw new NeutralPlanImportError(`Neutral plan directory must contain graph.json and consensus.json: ${planDir}`, 'invalid_json');
  }

  let graphValue: unknown;
  let consensusValue: unknown;
  try {
    graphValue = JSON.parse(graphBytes);
    consensusValue = JSON.parse(consensusBytes);
  } catch {
    throw new NeutralPlanImportError('Neutral plan graph.json and consensus.json must be valid JSON.', 'invalid_json');
  }

  const graph = validateGraph(graphValue);
  const expectedDigest = sha256(digestPayload(graph));
  const suppliedDigest = graph.digest.replace(/^sha256:/, '').toLowerCase();
  if (!/^[a-f0-9]{16,64}$/.test(suppliedDigest) || !expectedDigest.startsWith(suppliedDigest)) {
    throw new NeutralPlanImportError(`Neutral plan graph digest mismatch for ${graph.planId}.`, 'digest_mismatch');
  }
  const consensus = validateConsensus(consensusValue, graph);
  return { graph, consensus, graphBytes, consensusBytes, digest: suppliedDigest };
}
