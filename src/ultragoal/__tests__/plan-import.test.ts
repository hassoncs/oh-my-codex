import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importUltragoalPlan, readUltragoalPlan } from '../artifacts.js';
import { readValidatedNeutralPlan, NeutralPlanImportError } from '../plan-import.js';
import { ultragoalRunDir } from '../registry.js';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}

function graphDigest(graph: Record<string, unknown>): string {
  const payload = { ...graph };
  delete payload.digest;
  delete payload.graphDigest;
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

async function writeFixture(root: string, options: { approved?: boolean; badDigest?: boolean } = {}): Promise<string> {
  const planDir = join(root, 'plan-42');
  await mkdir(planDir, { recursive: true });
  const graph: Record<string, unknown> = {
    planId: 'plan-42',
    nodes: [
      { id: 'N-root', dependencies: [], intent: 'Prepare root', ownership: { team: 'core' }, deliverables: ['root'], proofs: ['test-root'] },
      { id: 'N-child', dependencies: ['N-root'], intent: 'Prepare child', ownership: { team: 'ui' }, deliverables: ['child'], proofs: ['test-child'] },
    ],
  };
  const digest = graphDigest(graph);
  graph.digest = options.badDigest ? '0'.repeat(64) : digest;
  await writeFile(join(planDir, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
  await writeFile(join(planDir, 'consensus.json'), `${JSON.stringify({
    planId: 'plan-42',
    graphDigest: digest,
    status: options.approved === false ? 'rejected' : 'approved',
  }, null, 2)}\n`);
  return planDir;
}

async function withTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'omx-neutral-plan-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('neutral plan importer', () => {
  it('validates approval and projects graph nodes without rewriting identity fields', async () => {
    await withTemp(async (root) => {
      const planDir = await writeFixture(root);
      const source = await readValidatedNeutralPlan(planDir);
      const plan = await importUltragoalPlan(root, planDir);
      assert.equal(plan.neutralPlanId, 'plan-42');
      assert.equal(plan.goals.map((goal) => goal.id).join(','), 'N-root,N-child');
      assert.deepEqual(plan.goals[1]?.dependencies, ['N-root']);
      const runDir = ultragoalRunDir(root, plan.runId as string);
      assert.equal(await readFile(join(runDir, 'graph.json'), 'utf8'), source.graphBytes);
      assert.equal(await readFile(join(runDir, 'consensus.json'), 'utf8'), source.consensusBytes);
      const ledger = await readFile(join(root, '.omx/ultragoal/ledger.jsonl'), 'utf8');
      assert.match(ledger, /"event":"plan_imported"/);
      assert.equal((await readUltragoalPlan(root)).neutralPlanDigest, source.digest);
    });
  });

  it('fails typed on digest and consensus invalidity', async () => {
    await withTemp(async (root) => {
      const badDigest = await writeFixture(root, { badDigest: true });
      await assert.rejects(() => readValidatedNeutralPlan(badDigest), (error: unknown) => {
        assert.ok(error instanceof NeutralPlanImportError);
        assert.equal(error.code, 'digest_mismatch');
        return true;
      });

      const rejected = await writeFixture(root, { approved: false });
      await assert.rejects(() => readValidatedNeutralPlan(rejected), (error: unknown) => {
        assert.ok(error instanceof NeutralPlanImportError);
        assert.equal(error.code, 'consensus_mismatch');
        return true;
      });
    });
  });

  it('uses registry conflict semantics and archives before a new namespace', async () => {
    await withTemp(async (root) => {
      const firstDir = await writeFixture(root);
      const first = await importUltragoalPlan(root, firstDir);
      const repeated = await importUltragoalPlan(root, firstDir, { newNamespace: true });
      assert.notEqual(repeated.runId, first.runId);
      const secondDir = join(root, 'plan-42-second');
      await mkdir(secondDir, { recursive: true });
      const graph: Record<string, unknown> = {
        planId: 'plan-99',
        nodes: [{ id: 'N-only', dependencies: [], intent: 'Only', ownership: 'core', deliverables: [], proofs: [] }],
      };
      graph['digest'] = graphDigest(graph);
      await writeFile(join(secondDir, 'graph.json'), JSON.stringify(graph));
      await writeFile(join(secondDir, 'consensus.json'), JSON.stringify({ planId: 'plan-99', graphDigest: graph.digest, approved: true }));
      await assert.rejects(() => importUltragoalPlan(root, secondDir), /different brief|registry/i);
      const second = await importUltragoalPlan(root, secondDir, { newNamespace: true });
      assert.notEqual(second.runId, first.runId);
      assert.ok(await readFile(join(ultragoalRunDir(root, first.runId as string), 'graph.json'), 'utf8'));
    });
  });
});
