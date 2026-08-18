import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importUltragoalPlan, readUltragoalPlan } from '../artifacts.js';
import { readValidatedNeutralPlan, NeutralPlanImportError } from '../plan-import.js';
import { ultragoalRunDir } from '../registry.js';

const REAL_PLAN = '/Users/hassoncs/worktrees/ch5/open-pencil/image-editor-standalone-engine-plan/.ch5/plan/image-editor-standalone-engine-r13';

function sha256(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

async function canonicalFixture(root: string, options: { approved?: boolean; tamperGraph?: boolean } = {}): Promise<string> {
  const planDir = join(root, 'image-editor-standalone-engine-r13');
  await mkdir(planDir, { recursive: true });
  if (existsSync(join(REAL_PLAN, 'graph.json')) && options.approved !== false && !options.tamperGraph) {
    for (const file of ['graph.json', 'consensus.json', 'graph-validation.json']) {
      await copyFile(join(REAL_PLAN, file), join(planDir, file));
    }
    return planDir;
  }

  const graph = {
    schema: 'ch5.plan-graph.v1',
    planId: 'image-editor-standalone-engine-r13',
    createdAt: '2026-08-18T16:34:51.000Z',
    updatedAt: '2026-08-18T16:34:51.000Z',
    planObjective: 'Run the approved standalone engine plan.',
    nodes: [{
      id: 'H0', title: 'Freeze contract', objective: 'Publish the contract.', status: 'pending', attempt: 0,
      createdAt: '2026-08-18T16:34:51.000Z', updatedAt: '2026-08-18T16:34:51.000Z', dependsOn: [], parallelWith: [],
      intent: { kind: 'implementation', effort: 5, risk: 'high', qualityFloor: 'smart' }, repo: 'https://git.ch5.me/ch5/open-pencil.git',
      ownsPaths: ['packages/scene-graph/src/index.ts'], writeExclusions: ['.ch5/plan/**'], deliverable: 'Contract.', proof: ['Focused tests pass.'],
    }],
  };
  const originalGraphBytes = `${JSON.stringify(graph, null, 2)}\n`;
  const graphDigest = sha256(originalGraphBytes);
  const graphBytes = options.tamperGraph
    ? originalGraphBytes.replace('Freeze contract', 'Tampered contract')
    : originalGraphBytes;
  const validation = {
    schema: 'ch5.plan-graph-validation.v1', planId: graph.planId, validatedAt: graph.createdAt, valid: true,
    planRevision: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };
  const validationBytes = `${JSON.stringify(validation, null, 2)}\n`;
  const consensus = {
    schema: 'ch5.plan-consensus.v1', status: options.approved === false ? 'rejected' : 'approved', planId: graph.planId,
    planRevision: validation.planRevision, artifacts: { 'graph.json': graphDigest, 'graph-validation.json': sha256(validationBytes) },
    semanticValidation: { status: 'pass', receiptPath: '.ch5/plan/image-editor-standalone-engine-r13/graph-validation.json', receiptSha256: sha256(validationBytes) },
    ralplanConsensusGate: { complete: true, architectApproved: true, criticApproved: true, criticRetryPending: false, planRevision: validation.planRevision },
  };
  await writeFile(join(planDir, 'graph.json'), graphBytes);
  await writeFile(join(planDir, 'graph-validation.json'), validationBytes);
  await writeFile(join(planDir, 'consensus.json'), `${JSON.stringify(consensus, null, 2)}\n`);
  return planDir;
}

async function withTemp<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'omx-neutral-plan-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('neutral plan importer', () => {
  it('imports the copied canonical real-plan shape 1:1', async () => {
    await withTemp(async (root) => {
      const planDir = await canonicalFixture(root);
      const source = await readValidatedNeutralPlan(planDir);
      const plan = await importUltragoalPlan(root, planDir);
      assert.equal(plan.neutralPlanId, source.graph.planId);
      assert.equal(plan.neutralPlanRevision, source.planRevision);
      assert.deepEqual(plan.goals[0]?.dependencies, source.graph.nodes[0]?.dependsOn);
      assert.deepEqual(plan.goals[0]?.intent, source.graph.nodes[0]?.intent);
      assert.deepEqual(plan.goals[0]?.ownership, { repo: source.graph.nodes[0]?.repo, ownsPaths: source.graph.nodes[0]?.ownsPaths, writeExclusions: source.graph.nodes[0]?.writeExclusions });
      assert.equal(plan.goals[0]?.deliverables, source.graph.nodes[0]?.deliverable);
      assert.deepEqual(plan.goals[0]?.proofs, source.graph.nodes[0]?.proof);
      const runDir = ultragoalRunDir(root, plan.runId as string);
      for (const file of ['graph.json', 'consensus.json', 'graph-validation.json']) {
        assert.equal(await readFile(join(runDir, file), 'utf8'), await readFile(join(planDir, file), 'utf8'));
      }
      assert.match(await readFile(join(root, '.omx/ultragoal/ledger.jsonl'), 'utf8'), /"event":"plan_imported"/);
      assert.equal((await readUltragoalPlan(root)).neutralPlanDigest, source.graphDigest);
    });
  });

  it('fails typed on consensus status and graph digest mismatch', async () => {
    await withTemp(async (root) => {
      const rejected = await canonicalFixture(root, { approved: false });
      await assert.rejects(() => readValidatedNeutralPlan(rejected), (error: unknown) => error instanceof NeutralPlanImportError && error.code === 'consensus_mismatch');
      const tampered = await canonicalFixture(root, { tamperGraph: true });
      await assert.rejects(() => readValidatedNeutralPlan(tampered), (error: unknown) => error instanceof NeutralPlanImportError && error.code === 'digest_mismatch');
    });
  });

  it('uses registry conflict semantics for a second approved plan', async () => {
    await withTemp(async (root) => {
      const firstDir = await canonicalFixture(root);
      const first = await importUltragoalPlan(root, firstDir);
      const secondDir = await canonicalFixture(root, { tamperGraph: false });
      const second = await importUltragoalPlan(root, secondDir, { namespace: 'other-plan', newNamespace: true });
      assert.notEqual(second.runId, first.runId);
    });
  });
});
