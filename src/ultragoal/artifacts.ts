import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  formatCodexGoalReconciliation,
  buildCompletedCodexGoalRemediation,
  parseCodexGoalSnapshot,
  reconcileCodexGoalSnapshot,
} from '../goal-workflows/codex-goal-snapshot.js';
import {
  LEADER_CONDUCTOR_BLOCK,
  buildUnsupportedNativeSubagentGuidance,
  type NativeSubagentSupportEvidence,
} from '../leader/contract.js';
import {
  recoverStaleOwnedLock,
  releaseOwnedLock,
  tryCreateOwnedLock,
} from '../scripts/dist-lock.js';

import {
  ULTRAGOAL_BRIEF,
  ULTRAGOAL_DIR,
  ULTRAGOAL_GOALS,
  ULTRAGOAL_LEDGER,
  UltragoalRegistryConflictError,
  archiveFlatRegistry,
  legacyRunIdForPlan,
  buildUltragoalRunId,
  computeUltragoalBriefHash,
  describeRegistryConflict,
  isInheritedOrigin,
  isUnownedInheritedRegistry,
  readActiveRunPointer,
  ultragoalDir,
  ultragoalRunDir,
  writeActiveRunPointer,
  type UltragoalRunOrigin,
} from './registry.js';

export {
  ULTRAGOAL_BRIEF,
  ULTRAGOAL_DIR,
  ULTRAGOAL_GOALS,
  ULTRAGOAL_LEDGER,
  UltragoalRegistryConflictError,
  computeUltragoalBriefHash,
  ultragoalDir,
};
const ULTRAGOAL_MUTATION_LOCK = '.mutation.lock';

export type UltragoalStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'review_blocked' | 'needs_user_decision';
export type UltragoalCodexGoalMode = 'aggregate' | 'per_story';
export type UltragoalSteeringStatus = 'superseded' | 'blocked';
export type UltragoalSteeringMutationKind =
  | 'add_subgoal'
  | 'split_subgoal'
  | 'reorder_pending'
  | 'revise_pending_wording'
  | 'annotate_ledger'
  | 'mark_blocked_superseded';
export type UltragoalSteeringSource = 'user_prompt_submit' | 'finding' | 'cli';

export const ULTRAGOAL_STEERING_MUTATION_KINDS: readonly UltragoalSteeringMutationKind[] = [
  'add_subgoal',
  'split_subgoal',
  'reorder_pending',
  'revise_pending_wording',
  'annotate_ledger',
  'mark_blocked_superseded',
];

export const ULTRAGOAL_STEERING_SOURCES: readonly UltragoalSteeringSource[] = [
  'user_prompt_submit',
  'finding',
  'cli',
];

export interface UltragoalSteeringInvariantResult {
  accepted: boolean;
  structuralInvariantAccepted: boolean;
  evidenceBackedNecessity: boolean;
  noEasierCompletion: boolean;
  rejectedReasons: string[];
  reasons?: string[];
}

export interface UltragoalSteeringChildGoal {
  title: string;
  objective: string;
  tokenBudget?: number;
}

export interface UltragoalSteeringAfterPayload {
  title?: string;
  objective?: string;
  pendingGoalIds?: string[];
  children?: UltragoalSteeringChildGoal[];
}

export interface UltragoalSteeringProposal {
  kind: UltragoalSteeringMutationKind;
  source: UltragoalSteeringSource;
  targetGoalId?: string;
  targetGoalIds?: string[];
  evidence: string;
  rationale: string;
  title?: string;
  objective?: string;
  childGoals?: UltragoalSteeringChildGoal[];
  revisedTitle?: string;
  revisedObjective?: string;
  pendingOrder?: string[];
  blockedReason?: string;
  after?: UltragoalSteeringAfterPayload;
  directiveText?: string;
  promptSignature?: string;
  idempotencyKey?: string;
  now?: Date;
}

export interface UltragoalSteeringAudit {
  kind: UltragoalSteeringMutationKind;
  source: UltragoalSteeringSource;
  targetGoalIds: string[];
  before?: unknown;
  after?: unknown;
  evidence: string;
  rationale: string;
  invariant: UltragoalSteeringInvariantResult;
  directiveText?: string;
  promptSignature?: string;
  idempotencyKey?: string;
  deduped?: boolean;
}

export interface SteerUltragoalResult {
  plan: UltragoalPlan;
  accepted: boolean;
  audit: UltragoalSteeringAudit;
  rejectedReasons: string[];
  deduped: boolean;
}



export interface UltragoalItem {
  id: string;
  title: string;
  objective: string;
  status: UltragoalStatus;
  tokenBudget?: number;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  reviewBlockedAt?: string;
  evidence?: string;
  failureReason?: string;
  steeringStatus?: UltragoalSteeringStatus;
  supersededBy?: string[];
  supersedes?: string[];
  blockedReason?: string;
  blockerSignature?: string;
  blockerOccurrenceCount?: number;
  requiredExternalDecision?: string;
  nonRetriable?: boolean;
  steeringEvidence?: string;
  steeringRationale?: string;
  resolvesReviewBlockedGoalId?: string;
  reviewBlockerResolution?: {
    resolverGoalId: string;
    status: 'pending' | 'complete';
    resolvedAt?: string;
    evidence?: string;
  };
}

export interface UltragoalAggregateCompletion {
  status: 'complete';
  completedAt: string;
  evidence: string;
  codexGoal?: unknown;
}

export interface UltragoalCodexRootBinding {
  threadId: string;
  objective: string;
  revision: number;
}

export type UltragoalLedgerAncestryRelation =
  | 'equal'
  | 'flat_only'
  | 'namespaced_only'
  | 'flat_has_namespaced_prefix'
  | 'flat_has_namespaced_suffix'
  | 'namespaced_has_flat_prefix'
  | 'namespaced_has_flat_suffix';

export interface UltragoalLedgerAncestry {
  relation: UltragoalLedgerAncestryRelation;
  flatDigest?: string;
  namespacedDigest?: string;
  selectedDigest: string;
  runAnchorDigest?: string;
  runAnchorLine?: number;
}

export interface UltragoalRootGoalTransition {
  transitionVersion: 1;
  snapshotDigest: string;
  evidenceDigest: string;
  evidence: string;
  reconciledAt: string;
  beforePlanDigest: string;
  ledgerAncestry: UltragoalLedgerAncestry;
  normalization?: {
    migratedStatuses: number;
    previousObjective?: string;
  };
  before?: UltragoalCodexRootBinding;
  legacyBefore?: {
    rootGoalId?: string;
    codexThreadId?: string;
    codexObjective?: string;
  };
  after: UltragoalCodexRootBinding;
}

export interface UltragoalRootGoalReconciliation extends UltragoalRootGoalTransition {
  eventId: string;
}

export interface UltragoalArchitectureInvariantEvidence {
  invariant: string;
  source: string;
  status: 'proved';
  implementationEvidence: string;
  testEvidence: string;
  reviewEvidence: string;
  blockers?: never;
}


export interface UltragoalPlan {
  version: 1;
  createdAt: string;
  updatedAt: string;
  /** Namespace of this run: `.omx/ultragoal/runs/<runId>/`. Absent on pre-namespacing plans. */
  runId?: string;
  /** Stable hash of the brief this run was created from. */
  briefHash?: string;
  /** Worktree that created this run, plus any that explicitly adopted it. */
  origin?: UltragoalRunOrigin;
  briefPath: string;
  goalsPath: string;
  ledgerPath: string;
  codexGoalMode?: UltragoalCodexGoalMode;
  codexObjective?: string;
  codexObjectiveAliases?: string[];
  codexRootBinding?: UltragoalCodexRootBinding;
  rootGoalReconciliation?: UltragoalRootGoalReconciliation;
  aggregateCompletion?: UltragoalAggregateCompletion;
  activeGoalId?: string;
  goals: UltragoalItem[];
}

export interface UltragoalLedgerEntry {
  ts: string;
  event:
    | 'plan_created'
    | 'plan_migrated'
    | 'goal_started'
    | 'goal_resumed'
    | 'goal_completed'
    | 'goal_blocked'
    | 'goal_failed'
    | 'goal_needs_user_decision'
    | 'goal_retried'
    | 'aggregate_completed'
    | 'aggregate_objective_migrated'
    | 'root_goal_reconciled'
    | 'goal_added'
    | 'steering_accepted'
    | 'steering_rejected'
    | 'final_review_failed'
    | 'goal_review_blocked';
  goalId?: string;
  status?: UltragoalStatus;
  message?: string;
  codexGoal?: unknown;
  evidence?: string;
  qualityGate?: UltragoalQualityGate;
  steering?: UltragoalSteeringAudit;
  before?: unknown;
  after?: unknown;
  mutationKind?: UltragoalSteeringMutationKind;
  idempotencyKey?: string;
  blockerSignature?: string;
  blockerOccurrenceCount?: number;
  requiredExternalDecision?: string;
  eventId?: string;
  eventVersion?: number;
  transitionVersion?: number;
  runId?: string;
  revision?: number;
  snapshotDigest?: string;
  evidenceDigest?: string;
  beforePlanDigest?: string;
  ledgerAncestry?: UltragoalLedgerAncestry;
  normalization?: UltragoalRootGoalTransition['normalization'];
  legacyBefore?: UltragoalRootGoalTransition['legacyBefore'];
}

export interface CreateUltragoalOptions {
  brief: string;
  goals?: Array<{ title?: string; objective: string; tokenBudget?: number }>;
  codexGoalMode?: UltragoalCodexGoalMode;
  now?: Date;
  /** Legacy escape hatch; equivalent to archiveExisting. */
  force?: boolean;
  /** Keep the existing registry under runs/<runId>/ and start a fresh namespace. */
  archiveExisting?: boolean;
  /** Continue the existing registry in this worktree instead of starting a new run. */
  adoptExisting?: boolean;
  /** Start a fresh namespace, leaving the existing run registered but inactive. */
  newNamespace?: boolean;
}

export interface StartNextOptions {
  now?: Date;
  retryFailed?: boolean;
}

export interface CheckpointOptions {
  goalId: string;
  status: Extract<UltragoalStatus, 'complete' | 'failed'> | 'blocked';
  evidence?: string;
  codexGoal?: unknown;
  qualityGate?: unknown;
  allowActiveFinalCodexGoal?: boolean;
  now?: Date;
}

export interface AddUltragoalGoalOptions {
  title: string;
  objective: string;
  evidence?: string;
  now?: Date;
}

export interface ReconcileUltragoalRootGoalOptions {
  codexGoal: unknown;
  evidence: string;
  expectedRevision: number;
  expectedCurrentThreadId?: string;
  expectedFlatLedgerDigest?: string;
  expectedNamespacedLedgerDigest?: string;
  now?: Date;
}

export interface ReconcileUltragoalRootGoalResult {
  plan: UltragoalPlan;
  deduped: boolean;
  eventId: string;
  before?: UltragoalCodexRootBinding;
  after: UltragoalCodexRootBinding;
  repairedProjections: string[];
}

export type UltragoalReviewBlockerClass = 'evidence_stale' | 'substantive';

export interface RecordFinalReviewBlockersOptions extends AddUltragoalGoalOptions {
  goalId: string;
  codexGoal?: unknown;
  /** Omit to classify from the review evidence. */
  blockerClass?: UltragoalReviewBlockerClass;
}

const EVIDENCE_STALE_PATTERNS: readonly RegExp[] = [
  /\bstale evidence\b/i,
  /\bevidence is stale\b/i,
  /\bevidence (?:is )?(?:one|1) commit behind\b/i,
  /\bproof (?:is )?(?:one|1) commit behind\b/i,
  /\bevidence predates\b/i,
  /\bevidence was captured before\b/i,
  /\bre-?capture (?:the )?evidence\b/i,
];

const SUBSTANTIVE_OVERRIDE_PATTERNS: readonly RegExp[] = [
  /\bbug\b/i,
  /\bregression\b/i,
  /\bincorrect\b/i,
  /\bunsafe\b/i,
  /\bmissing (?:test|validation|authz|authorization)\b/i,
];

/**
 * "Evidence is stale versus the just-repaired state" is a capture problem, not a
 * plan problem: it should cost an evidence re-capture task, not a full review
 * BLOCK round-trip that spawns fresh reviewer teams for hours.
 */
export function classifyReviewBlockerEvidence(evidence: string): UltragoalReviewBlockerClass {
  if (SUBSTANTIVE_OVERRIDE_PATTERNS.some((pattern) => pattern.test(evidence))) return 'substantive';
  return EVIDENCE_STALE_PATTERNS.some((pattern) => pattern.test(evidence)) ? 'evidence_stale' : 'substantive';
}

export interface CodexGoalInstructionOptions {
  nativeSubagentSupport?: NativeSubagentSupportEvidence;
}

export interface UltragoalQualityGate {
  aiSlopCleaner: {
    status: 'passed';
    evidence: string;
  };
  verification: {
    status: 'passed';
    commands: string[];
    evidence: string;
  };
  codeReview: {
    recommendation: 'APPROVE';
    architectStatus: 'CLEAR';
    evidence: string;
    independentReview: {
      codeReviewer: {
        agentRole: 'code-reviewer';
        evidence: string;
      };
      architect: {
        agentRole: 'architect';
        evidence: string;
      };
    };
  };
  architectureInvariantGate: {
    status: 'passed';
    sourceArtifacts: string[];
    invariants: UltragoalArchitectureInvariantEvidence[];
    evidence: string;
  };

}

export class UltragoalError extends Error {}

function iso(now = new Date()): string {
  return now.toISOString();
}

export function ultragoalBriefPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_BRIEF);
}

export function ultragoalGoalsPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_GOALS);
}

export function ultragoalLedgerPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER);
}

function repoRelative(cwd: string, path: string): string {
  return relative(cwd, path).split('\\').join('/');
}

function cleanLine(line: string): string {
  return line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').trim();
}

interface MarkdownListItem {
  lineIndex: number;
  indent: number;
  text: string;
  section?: string;
}

function lineIndentWidth(line: string): number {
  return (line.match(/^(\s*)/)?.[1] ?? '').replace(/\t/g, '  ').length;
}

function normalizeSectionLabel(value: string): string | undefined {
  if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(value)) return undefined;
  const atx = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(value)?.[1];
  const plain = /^([^\s].{1,100}):\s*$/.exec(value)?.[1];
  return (atx ?? plain)?.replace(/[`*_~]/g, '').replace(/:$/, '').trim().toLowerCase();
}

function normalizeIndentedAtxStorySectionLabel(value: string): string | undefined {
  const atx = /^\s{1,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(value)?.[1]
    ?.replace(/[`*_~]/g, '')
    .replace(/:$/, '')
    .trim()
    .toLowerCase();
  return sectionLooksStory(atx) ? atx : undefined;
}

const MAX_IMPLICIT_MARKDOWN_GOALS = 20;

function sectionLooksPlanReview(section: string | undefined): boolean {
  return /^(?:review(?:\s+artifact)?|review\s+findings?|findings?|verdict|status|consensus(?:\s+status)?|decision\s+log|approval(?:\s+status)?|implementation\s+notes?|handoff|context|background|summary|scope)$/.test(section ?? '');
}

function sectionLooksNonStory(section: string | undefined): boolean {
  return /^(?:acceptance\s+criteria|verification(?:\s+checklist)?|validation(?:\s+checklist)?|checklist|evidence|constraints?|risks?|immediate\s+next\s+actions?|next\s+actions?|follow-?ups?|notes?)$/.test(section ?? '') || sectionLooksPlanReview(section);
}

function sectionLooksStory(section: string | undefined): boolean {
  return /^(?:story|stories|goals?|milestones?|p\d+)$/.test(section ?? '');
}

function parseMarkdownListItems(lines: readonly string[]): MarkdownListItem[] {
  const items: MarkdownListItem[] = [];
  let section: string | undefined;
  let resetNonStorySection = false;
  let afterBlank = false;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (!line.trim()) {
      resetNonStorySection ||= sectionLooksNonStory(section);
      afterBlank = true;
      continue;
    }
    const nextSection = normalizeSectionLabel(line)
      ?? (afterBlank ? normalizeIndentedAtxStorySectionLabel(line) : undefined);
    if (nextSection) {
      section = nextSection;
      resetNonStorySection = false;
    }
    afterBlank = false;
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (!match) continue;
    const indent = match[1].replace(/\t/g, '  ').length;
    if (resetNonStorySection && indent === 0) section = undefined;
    resetNonStorySection = false;
    const text = cleanLine(line);
    if (!text || text.length > 1200) continue;
    items.push({ lineIndex, indent, text, section });
  }
  return items;
}

function selectedItemObjective(parent: MarkdownListItem, lines: readonly string[], nextParentLineIndex?: number): string {
  const parts = [parent.text];
  for (let lineIndex = parent.lineIndex + 1; lineIndex < (nextParentLineIndex ?? lines.length); lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const indent = lineIndentWidth(line);
    if (indent <= parent.indent && sectionLooksNonStory(normalizeSectionLabel(line))) break;
    if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) && indent <= parent.indent) break;
    if (indent <= parent.indent || !line.trim()) continue;
    const nested = cleanLine(line);
    if (nested && nested.length <= 1200) parts.push(nested);
  }
  return parts.join('\n');
}

function topLevelStoryItems(items: readonly MarkdownListItem[]): MarkdownListItem[] {
  const storyItems = items.filter((item) => !sectionLooksNonStory(item.section));
  if (storyItems.length === 0) return [];
  const storySectionItems = storyItems.filter((item) => sectionLooksStory(item.section));
  const candidates = storySectionItems.length > 0 ? storySectionItems : storyItems;
  const minIndent = Math.min(...candidates.map((item) => item.indent));
  return candidates.filter((item) => item.indent === minIndent);
}

function hasExplicitStorySection(items: readonly MarkdownListItem[]): boolean {
  return items.some((item) => sectionLooksStory(item.section));
}

function briefLooksPlanLikeHandoff(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const label = normalizeSectionLabel(line);
    if (sectionLooksPlanReview(label)) return true;
    return /\b(?:RALPLAN|G\d{3,}\s+(?:verdict|review|status)|review\s+artifact|consensus\s+status|planner\s+consensus|critic\s+review|architect\s+review)\b/i.test(line);
  });
}

function assertSafeImplicitMarkdownGoalCount(brief: string, parsedItems: readonly MarkdownListItem[], parentItems: readonly MarkdownListItem[]): void {
  if (hasExplicitStorySection(parsedItems)) return;
  if (parentItems.length <= MAX_IMPLICIT_MARKDOWN_GOALS) return;
  const sourceKind = briefLooksPlanLikeHandoff(brief.split(/\r?\n/)) ? 'plan/review handoff markdown' : 'broad markdown';
  throw new UltragoalError(`Refusing to derive ${parentItems.length} implicit ultragoal goals from ${sourceKind}. Pass compact executable stories with repeated --goal "Title::Objective" entries, or rewrite the brief with an explicit ### Stories/### Goals section containing no more than ${MAX_IMPLICIT_MARKDOWN_GOALS} parent stories.`);
}

function normalizeObjective(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const OBJECTIVE_MAPPING_STOP_WORDS = new Set([
  'about',
  'active',
  'aggregate',
  'audit',
  'brief',
  'build',
  'clean',
  'codex',
  'complete',
  'completed',
  'different',
  'evidence',
  'fix',
  'goal',
  'goals',
  'implementation',
  'json',
  'ledger',
  'omx',
  'plan',
  'planned',
  'reconcile',
  'task',
  'tests',
  'ultragoal',
  'unrelated',
  'validation',
  'work',
]);

function objectiveMappingTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of value.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 5) continue;
    if (OBJECTIVE_MAPPING_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function objectivesHaveConservativeSpecificTokenOverlap(actual: string, brief: string): boolean {
  const actualTokens = objectiveMappingTokens(actual);
  const briefTokens = objectiveMappingTokens(brief);
  if (actualTokens.size < 4 || briefTokens.size < 4) return false;
  const shared = [...actualTokens].filter((token) => briefTokens.has(token)).length;
  const smallerSpecificSetSize = Math.min(actualTokens.size, briefTokens.size);
  return shared >= 4 && shared / smallerSpecificSetSize >= 0.6;
}

function normalizeBlockerEvidence(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`"'()[\]{}:,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ExternalAuthorizationBlocker {
  signature: string;
  requiredDecision: string;
}

function classifyExternalAuthorizationBlocker(evidence: string | undefined): ExternalAuthorizationBlocker | null {
  const normalized = normalizeBlockerEvidence(evidence);
  if (!normalized) return null;

  const mentionsAuthorization = /\b(auth|authorization|credential|credentials|token|permission|permissions|scope|scopes|access|unauthorized|forbidden|401|403)\b/.test(normalized);
  const mentionsMissingAuthority = /\b(unset|missing|required|requires|without|omit|omits|not set|not available|no read packages|read packages)\b/.test(normalized);
  if (!mentionsAuthorization || !mentionsMissingAuthority) return null;

  const mentionsGhcr = /\b(ghcr|github container registry|read packages|imagepullsecret|package api|anonymous image|container image)\b/.test(normalized);
  if (mentionsGhcr) {
    const has401 = /\b(401|unauthorized|anonymous pull|authentication required)\b/.test(normalized);
    const has403 = /\b(403|forbidden|read packages|package api)\b/.test(normalized);
    const status = [has401 ? 'HTTP_401_ANONYMOUS' : null, has403 ? 'HTTP_403_NO_READ_PACKAGES' : null]
      .filter((part): part is string => Boolean(part))
      .join('+') || 'AUTHORIZATION_REQUIRED';
    return {
      signature: `GHCR_PULL_ACCESS:${status}:GHCR_VISIBILITY_OR_CREDENTIAL_REQUIRED`,
      requiredDecision: 'make the GHCR package public, or provide/authorize a least-privilege read:packages credential and imagePullSecret/SOPS path',
    };
  }

  return {
    signature: 'EXTERNAL_AUTHORIZATION_REQUIRED',
    requiredDecision: 'provide the missing external authorization/credential, or explicitly choose a different unblock path',
  };
}

function sameBlockerOccurrences(entries: readonly UltragoalLedgerEntry[], goalId: string, signature: string): number {
  return entries.filter((entry) => (
    entry.goalId === goalId
    && (entry.event === 'goal_failed' || entry.event === 'goal_needs_user_decision')
    && entry.blockerSignature === signature
  )).length;
}

function clearGoalBlockerFields(goal: UltragoalItem): void {
  goal.blockedReason = undefined;
  goal.blockerSignature = undefined;
  goal.blockerOccurrenceCount = undefined;
  goal.requiredExternalDecision = undefined;
  goal.nonRetriable = undefined;
}


function textMentionsUltragoalPlanArtifact(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  return normalized.includes(ULTRAGOAL_DIR.toLowerCase())
    || normalized.includes(ULTRAGOAL_GOALS.toLowerCase())
    || normalized.includes(ULTRAGOAL_LEDGER.toLowerCase());
}

function textMentionsGoalId(value: string | undefined, goalId: string): boolean {
  return (value ?? '').toLowerCase().includes(goalId.toLowerCase());
}

function textHasCompletionValidationEvidence(value: string | undefined): boolean {
  const normalized = (value ?? '').toLowerCase();
  const hasImplementationCompletion = /\b(?:planned work|implementation|deliverables?|scope|task|work)\b/.test(normalized)
    && /\b(?:done|complete|completed|finished|shipped)\b/.test(normalized);
  const hasValidation = /\b(?:validation|verification|tests?|build|lint|review|quality gate|code-review)\b/.test(normalized)
    && /\b(?:passed|complete|completed|clean|green|approve|approved|clear)\b/.test(normalized);
  return hasImplementationCompletion && hasValidation;
}

async function snapshotObjectiveMapsToUltragoalPlan(cwd: string, snapshotObjective: string): Promise<boolean> {
  const actual = normalizeObjective(snapshotObjective).toLowerCase();
  if (actual.length < 24) return false;
  try {
    const brief = normalizeObjective(await readFile(ultragoalBriefPath(cwd), 'utf-8')).toLowerCase();
    if (!brief || brief.length < 24) return false;
    return brief.includes(actual) || actual.includes(brief) || objectivesHaveConservativeSpecificTokenOverlap(actual, brief);
  } catch {
    return false;
  }
}

function unresolvedReviewBlockedGoals(plan: UltragoalPlan): UltragoalItem[] {
  return plan.goals.filter((candidate) => candidate.status === 'review_blocked' && !isReviewBlockedResolved(candidate, plan));
}

function isDesignatedReviewBlockerResolver(goal: UltragoalItem, parent: UltragoalItem | undefined): boolean {
  return parent?.status === 'review_blocked'
    && goal.resolvesReviewBlockedGoalId === parent.id
    && parent.reviewBlockerResolution?.resolverGoalId === goal.id;
}

function canUseCleanFinalResolverPathForReviewBlockedParent(
  plan: UltragoalPlan,
  goal: UltragoalItem,
  finalRunCheckpoint: boolean,
  allowActiveFinalCodexGoal: boolean | undefined,
): boolean {
  const unresolvedReviewBlocked = unresolvedReviewBlockedGoals(plan);
  if (unresolvedReviewBlocked.length !== 1) return false;
  return finalRunCheckpoint
    && !allowActiveFinalCodexGoal
    && isDesignatedReviewBlockerResolver(goal, unresolvedReviewBlocked[0]);
}

async function canReconcileCompletedTaskScopedAggregateSnapshot(
  cwd: string,
  plan: UltragoalPlan,
  goal: UltragoalItem,
  snapshotObjective: string,
  evidence: string | undefined,
): Promise<boolean> {
  if (codexGoalMode(plan) !== 'aggregate') return false;
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) return false;
  if (!textMentionsUltragoalPlanArtifact(evidence)) return false;
  if (!textMentionsGoalId(evidence, goal.id)) return false;
  if (!textHasCompletionValidationEvidence(evidence)) return false;
  return snapshotObjectiveMapsToUltragoalPlan(cwd, snapshotObjective);
}


function buildCompletedLegacyGoalRemediation(goal: UltragoalItem): string {
  return [
    'If get_goal returns a different completed legacy/thread objective, do not repeat --status complete in this thread.',
    `Record a non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json "<different completed get_goal JSON or path>".`,
    'Then continue only from a Codex goal context with no active/completed conflicting goal, in the same repo/worktree, and create the intended goal there.',
  ].join(' ');
}

function buildUnavailableCodexGoalRemediation(goal: UltragoalItem): string {
  return [
    'If get_goal itself is unavailable due to a Codex DB/schema/context error, such as "no such table: thread_goals", do not repeat --status complete or mark the Codex goal complete from shell state.',
    `Record an auditable non-terminal blocker with: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<get_goal unavailable due to Codex DB/schema/context error; safe recovery requires a working Codex goal context>" --codex-goal-json "<unavailable get_goal error JSON or path>".`,
    'Then continue from a Codex goal context where get_goal works and strict completion reconciliation can be proven.',
  ].join(' ');
}

function evidenceDescribesCompletedAggregateMicrogoalLoop(evidence: string | undefined): boolean {
  const normalized = normalizeObjective(evidence ?? '').toLowerCase();
  return normalized.includes('aggregate codex goal')
    && /\bcomplete(?:d)?\b/.test(normalized)
    && normalized.includes('microgoal')
    && /\b(?:unreconcilable|mismatch|loop|already complete|already completed|blocks?)\b/.test(normalized);
}

function isSafeCompletedAggregateBlockerSnapshot(
  plan: UltragoalPlan,
  goal: UltragoalItem,
  snapshot: ReturnType<typeof parseCodexGoalSnapshot>,
  evidence: string | undefined,
): boolean {
  if (codexGoalMode(plan) !== 'aggregate') return false;
  if (goal.status !== 'in_progress' || plan.activeGoalId !== goal.id) return false;
  if (snapshot?.status !== 'complete' || !snapshot.objective) return false;
  if (!evidenceDescribesCompletedAggregateMicrogoalLoop(evidence)) return false;
  const actual = normalizeObjective(snapshot.objective);
  return [expectedCodexObjective(plan, goal), ...compatibleCodexObjectives(plan)]
    .some((objective) => normalizeObjective(objective) === actual);
}

function codexGoalMode(plan: UltragoalPlan): UltragoalCodexGoalMode {
  return plan.codexGoalMode ?? 'per_story';
}

function isResolvedStatus(status: UltragoalStatus): boolean {
  return status === 'complete' || status === 'review_blocked';
}

function isScheduleEligibleGoal(goal: UltragoalItem): boolean {
  return goal.steeringStatus !== 'superseded' && goal.steeringStatus !== 'blocked';
}

export const ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE =
  `Complete the durable ultragoal plan in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}, including later accepted/appended stories, under the original brief constraints; use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the audit trail.`;

function aggregateCodexObjective(_goals: readonly UltragoalItem[]): string {
  if (ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE.length <= 4000) return ULTRAGOAL_AGGREGATE_CODEX_OBJECTIVE;
  throw new UltragoalError('Generated aggregate Codex objective exceeds the 4,000 character goal limit.');
}

function isLegacyEnumeratedAggregateObjective(objective: string | undefined): boolean {
  if (!objective) return false;
  return (
    objective.startsWith(`Complete all ultragoal stories in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}: `)
    || objective === `Complete all ultragoal stories listed in ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}. Use ${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER} as the durable audit trail.`
  );
}

function compatibleCodexObjectives(plan: UltragoalPlan): string[] {
  if (plan.codexRootBinding) return [];
  return (plan.codexObjectiveAliases ?? [])
    .filter((objective) => isLegacyEnumeratedAggregateObjective(objective));
}

function expectedCodexObjective(plan: UltragoalPlan, goal: UltragoalItem): string {
  return codexGoalMode(plan) === 'aggregate'
    ? (plan.codexRootBinding?.objective ?? plan.codexObjective ?? aggregateCodexObjective(plan.goals))
    : goal.objective;
}

function isSupersededResolved(goal: UltragoalItem, plan: UltragoalPlan): boolean {
  if (goal.steeringStatus !== 'superseded') return false;
  const replacements = goal.supersededBy ?? [];
  if (replacements.length === 0) return false;
  return replacements.every((id) => {
    const replacement = plan.goals.find((candidate) => candidate.id === id);
    return replacement !== undefined && isResolvedStatus(replacement.status);
  });
}

function isReviewBlockedResolved(goal: UltragoalItem, plan: UltragoalPlan): boolean {
  if (goal.status !== 'review_blocked') return false;
  const resolverId = goal.reviewBlockerResolution?.resolverGoalId;
  if (!resolverId || goal.reviewBlockerResolution?.status !== 'complete') return false;
  const resolver = plan.goals.find((candidate) => candidate.id === resolverId);
  return resolver?.status === 'complete';
}

function isCompletionBlocking(goal: UltragoalItem, plan: UltragoalPlan): boolean {
  if (goal.steeringStatus === 'superseded') return !isSupersededResolved(goal, plan);
  if (goal.steeringStatus === 'blocked') return true;
  if (goal.status === 'review_blocked') return !isReviewBlockedResolved(goal, plan);
  return !isResolvedStatus(goal.status);
}

function isCompletionBlockingForFinalCandidate(candidate: UltragoalItem, finalCandidate: UltragoalItem, plan: UltragoalPlan): boolean {
  if (candidate.id === finalCandidate.id) return false;
  if (candidate.status === 'review_blocked' && candidate.reviewBlockerResolution?.resolverGoalId === finalCandidate.id) return false;
  if (candidate.steeringStatus === 'superseded') {
    const replacements = candidate.supersededBy ?? [];
    if (replacements.length === 0) return true;
    return !replacements.every((id) => {
      if (id === finalCandidate.id) return true;
      const replacement = plan.goals.find((goal) => goal.id === id);
      return replacement !== undefined && isResolvedStatus(replacement.status);
    });
  }
  return isCompletionBlocking(candidate, plan);
}

function isScheduleEligible(goal: UltragoalItem): boolean {
  return goal.steeringStatus !== 'superseded' && goal.steeringStatus !== 'blocked';
}

export function isFinalRunCompletionCandidate(plan: UltragoalPlan, goal: UltragoalItem): boolean {
  return plan.goals.every((candidate) => !isCompletionBlockingForFinalCandidate(candidate, goal, plan));
}

export function isUltragoalDone(plan: UltragoalPlan): boolean {
  if (plan.aggregateCompletion?.status === 'complete') return true;
  if (plan.goals.length === 0) return true;
  if (plan.goals.some((goal) => isCompletionBlocking(goal, plan))) return false;
  const latestNonReviewBlocked = [...plan.goals].reverse().find((goal) => goal.status !== 'review_blocked' && goal.steeringStatus !== 'superseded');
  return latestNonReviewBlocked?.status === 'complete';
}

function titleFromObjective(objective: string, fallback: string): string {
  const firstLine = objective.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;
}

export function deriveGoalCandidates(brief: string): Array<{ title: string; objective: string }> {
  const lines = brief.split(/\r?\n/);
  const parsedItems = parseMarkdownListItems(lines);
  const parentItems = topLevelStoryItems(parsedItems);
  assertSafeImplicitMarkdownGoalCount(brief, parsedItems, parentItems);
  const listGoals = parentItems
    .map((item, index) => selectedItemObjective(item, lines, parentItems[index + 1]?.lineIndex))
    .filter((objective, index, all) => all.findIndex((candidate) => candidate === objective) === index);
  const bulletGoals = (listGoals.length > 0 || parsedItems.length > 0 ? listGoals : lines
    .map((line) => ({ original: line, cleaned: cleanLine(line) }))
    .filter(({ cleaned }) => cleaned.length > 0 && cleaned.length <= 1200)
    .filter(({ original, cleaned }, index, all) => (
      /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(original)
      && all.findIndex((candidate) => candidate.cleaned === cleaned) === index
    ))
    .map(({ cleaned }) => cleaned));

  const objectives = bulletGoals.length > 0
    ? bulletGoals
    : parsedItems.length > 0
      ? [brief.trim() || 'Complete the requested project objective.']
      : brief
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0 && !paragraph.startsWith('#'));

  const selected = objectives.length > 0 ? objectives : [brief.trim() || 'Complete the requested project objective.'];
  return selected.map((objective, index) => ({
    title: titleFromObjective(objective, `Goal ${index + 1}`),
    objective,
  }));
}

function normalizeGoalId(title: string, index: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/g, '');
  return `G${String(index + 1).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withUltragoalMutationLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const lockPath = join(ultragoalDir(cwd), ULTRAGOAL_MUTATION_LOCK);
  const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (tryCreateOwnedLock(lockPath, {
      token,
      pid: process.pid,
      created_at: iso(),
    })) {
      acquired = true;
      break;
    }
    recoverStaleOwnedLock(lockPath, 30_000);
    await sleep(Math.min(25 + attempt * 5, 250));
  }
  if (!acquired) {
    throw new UltragoalError(`Timed out waiting for ultragoal mutation lock at ${repoRelative(cwd, lockPath)}.`);
  }
  let operationError: unknown;
  try {
    return await operation();
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (!releaseOwnedLock(lockPath, token)) {
      const releaseError = new UltragoalError(`Lost ownership of ultragoal mutation lock at ${repoRelative(cwd, lockPath)}.`);
      if (operationError) {
        throw new AggregateError([operationError, releaseError], releaseError.message);
      }
      throw releaseError;
    }
  }
}

async function appendLedger(cwd: string, entry: UltragoalLedgerEntry): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(ultragoalLedgerPath(cwd), line);
  const pointer = await readActiveRunPointer(cwd);
  if (!pointer) return;
  const runDir = ultragoalRunDir(cwd, pointer.runId);
  await mkdir(runDir, { recursive: true });
  await appendFile(join(runDir, ULTRAGOAL_LEDGER), line);
}

function normalizeLegacyGoalStatuses(plan: UltragoalPlan): number {
  let migrated = 0;
  for (const goal of plan.goals) {
    if ((goal.status as string) !== 'completed') continue;
    goal.status = 'complete';
    migrated += 1;
  }
  return migrated;
}
async function appendLegacyStatusMigration(cwd: string, migratedStatuses: number, now: string): Promise<void> {
  if (migratedStatuses === 0) return;
  await appendLedger(cwd, {
    ts: now,
    event: 'plan_migrated',
    message: `Normalized ${migratedStatuses} legacy completed goal status${migratedStatuses === 1 ? '' : 'es'} to complete.`,
  });
}

async function loadUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omx ultragoal create-goals ...\` first.`);
  }
  const parsed = JSON.parse(raw) as UltragoalPlan;
  if (parsed.version !== 1 || !Array.isArray(parsed.goals)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${repoRelative(cwd, path)}.`);
  }
  if (await isUnownedInheritedRegistry(parsed.origin, cwd)) {
    throw new UltragoalRegistryConflictError(
      [
        `Refusing to read an ultragoal registry created by a different worktree.`,
        `  run:          ${parsed.runId ?? 'unknown'}`,
        `  created in:   ${parsed.origin?.worktreePath}`,
        `  current tree: ${cwd}`,
        'A Grove CoW clone inherits .omx state from its source; that registry is not this run.',
        'Run `omx ultragoal adopt-run` to take ownership here, or start a fresh run with',
        '`omx ultragoal create-goals --new-namespace`.',
      ].join('\n'),
      {
        reason: 'inherited_worktree',
        runId: parsed.runId,
        briefHash: parsed.briefHash,
        originWorktreePath: parsed.origin?.worktreePath,
      },
    );
  }
  return parsed;
}

function requiresLegacyPlanMigration(plan: UltragoalPlan): boolean {
  return plan.goals.some((goal) => (goal.status as string) === 'completed')
    || (
      codexGoalMode(plan) === 'aggregate'
      && isLegacyEnumeratedAggregateObjective(plan.codexObjective)
    );
}

async function migrateUltragoalPlanUnderLock(cwd: string, parsed: UltragoalPlan): Promise<UltragoalPlan> {
  const migratedStatuses = normalizeLegacyGoalStatuses(parsed);
  const objectiveMigrated = codexGoalMode(parsed) === 'aggregate' && isLegacyEnumeratedAggregateObjective(parsed.codexObjective);
  if (migratedStatuses > 0 || objectiveMigrated) {
    const previousObjective = parsed.codexObjective;
    const now = iso();
    if (objectiveMigrated) {
      parsed.codexObjective = aggregateCodexObjective(parsed.goals);
      parsed.codexObjectiveAliases = Array.from(new Set([...(parsed.codexObjectiveAliases ?? []), previousObjective].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    }
    parsed.updatedAt = now;
    await writePlan(cwd, parsed);
    await appendLegacyStatusMigration(cwd, migratedStatuses, now);
    if (objectiveMigrated) {
      await appendLedger(cwd, {
        ts: now,
        event: 'aggregate_objective_migrated',
        message: 'Migrated legacy enumerated aggregate Codex objective to the stable pointer objective.',
        before: { codexObjective: previousObjective },
        after: { codexObjective: parsed.codexObjective },
      });
    }
  }
  return parsed;
}

async function readUltragoalPlanUnderLock(cwd: string): Promise<UltragoalPlan> {
  return migrateUltragoalPlanUnderLock(cwd, await loadUltragoalPlan(cwd));
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  const plan = await loadUltragoalPlan(cwd);
  if (!requiresLegacyPlanMigration(plan)) return plan;
  return withUltragoalMutationLock(cwd, () => readUltragoalPlanUnderLock(cwd));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmpPath, path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * The namespaced run directory is canonical; the flat `.omx/ultragoal/goals.json`
 * is the active-run projection every existing reader (HUD, shutdown gates, state
 * operations) consumes. One writer, both paths, always together.
 */
async function writePlan(cwd: string, plan: UltragoalPlan): Promise<void> {
  await mkdir(ultragoalDir(cwd), { recursive: true });
  if (plan.runId) {
    const runDir = ultragoalRunDir(cwd, plan.runId);
    await mkdir(runDir, { recursive: true });
    await writeJsonAtomic(join(runDir, ULTRAGOAL_GOALS), plan);
  }
  await writeJsonAtomic(ultragoalGoalsPath(cwd), plan);
}


interface ExistingUltragoalPlan {
  plan: UltragoalPlan;
  migratedStatuses: number;
}

async function readExistingPlanForConflictCheck(cwd: string): Promise<ExistingUltragoalPlan | null> {
  if (!existsSync(ultragoalGoalsPath(cwd))) return null;
  try {
    const plan = JSON.parse(await readFile(ultragoalGoalsPath(cwd), 'utf-8')) as UltragoalPlan;
    if (!Array.isArray(plan.goals)) return null;
    return { plan, migratedStatuses: normalizeLegacyGoalStatuses(plan) };
  } catch {
    return null;
  }
}

/**
 * Refuse to silently capture a new run with a registry that belongs to someone
 * else: a different brief, a pre-namespacing registry, or a registry inherited
 * from the worktree this tree was CoW-cloned from.
 */
async function resolveRegistryDisposition(
  cwd: string,
  briefHash: string,
  options: CreateUltragoalOptions,
): Promise<{ adopt: ExistingUltragoalPlan | null; archivedTo: string | null }> {
  const loaded = await readExistingPlanForConflictCheck(cwd);
  if (!loaded) return { adopt: null, archivedTo: null };
  const { plan: existing, migratedStatuses } = loaded;

  const pointer = await readActiveRunPointer(cwd);
  const existingOrigin = existing.origin ?? pointer?.origin;
  const conflict = describeRegistryConflict({
    cwd,
    briefHash,
    existingBriefHash: existing.briefHash,
    existingRunId: existing.runId ?? pointer?.runId,
    existingOrigin,
    originInherited: await isUnownedInheritedRegistry(existingOrigin, cwd),
    unnamespacedLegacyRegistry: !existing.runId,
  });

  const archive = options.archiveExisting || options.force;
  if (!conflict && !options.newNamespace && !archive) {
    // Same brief, same worktree: this is a resume of the same run.
    return { adopt: loaded, archivedTo: null };
  }
  if (options.adoptExisting) return { adopt: loaded, archivedTo: null };
  if (!archive && !options.newNamespace && conflict) {
    throw new UltragoalRegistryConflictError(conflict.message, {
      reason: conflict.reason,
      runId: existing.runId ?? pointer?.runId,
      briefHash: existing.briefHash,
      originWorktreePath: existingOrigin?.worktreePath,
    });
  }
  // Creating a new run overwrites the flat files and truncates the flat ledger.
  // Archive first, on every path that reaches here: a pre-namespacing registry
  // has no run directory behind those files, so skipping this destroys it.
  await writeJsonAtomic(ultragoalGoalsPath(cwd), existing);
  await appendLegacyStatusMigration(cwd, migratedStatuses, iso(options.now));
  const archivedTo = await archiveFlatRegistry(cwd, existing.runId ?? legacyRunIdForPlan(existing));
  return { adopt: null, archivedTo };
}

export async function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  const briefHash = computeUltragoalBriefHash(options.brief);
  const disposition = await resolveRegistryDisposition(cwd, briefHash, options);
  if (disposition.adopt) {
    const adopted = await adoptExistingPlanForRun(cwd, disposition.adopt.plan, disposition.adopt.migratedStatuses, briefHash, options);
    return adopted;
  }
  const now = iso(options.now);
  const sourceGoals: Array<{ title?: string; objective: string; tokenBudget?: number }> = options.goals?.length
    ? options.goals
    : deriveGoalCandidates(options.brief);
  const candidates = sourceGoals
    .map((goal, index): UltragoalItem => ({
      id: normalizeGoalId(goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`), index),
      title: goal.title ?? titleFromObjective(goal.objective, `Goal ${index + 1}`),
      objective: goal.objective.trim(),
      status: 'pending',
      tokenBudget: goal.tokenBudget,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    }));

  const runId = buildUltragoalRunId(briefHash, options.now ?? new Date());
  const plan: UltragoalPlan = {
    version: 1,
    createdAt: now,
    updatedAt: now,
    runId,
    briefHash,
    origin: { worktreePath: cwd, createdAt: now },
    briefPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`,
    goalsPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}`,
    ledgerPath: `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`,
    codexGoalMode: options.codexGoalMode ?? 'aggregate',
    goals: candidates,
  };
  if (plan.codexGoalMode === 'aggregate') plan.codexObjective = aggregateCodexObjective(candidates);

  await mkdir(ultragoalDir(cwd), { recursive: true });
  await writeFile(ultragoalBriefPath(cwd), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
  await writeFile(ultragoalLedgerPath(cwd), '');
  await writeActiveRunPointer(cwd, {
    version: 1,
    runId,
    briefHash,
    updatedAt: now,
    origin: plan.origin as UltragoalRunOrigin,
  });
  await writePlan(cwd, plan);
  await writeFile(join(ultragoalRunDir(cwd, runId), ULTRAGOAL_BRIEF), options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`);
  await appendLedger(cwd, {
    ts: now,
    event: 'plan_created',
    message: `${candidates.length} goal(s) created in run ${runId}`
      + (disposition.archivedTo ? `; archived previous registry to ${disposition.archivedTo}` : ''),
  });
  return plan;
  });
}

/**
 * Explicitly take ownership of a registry inherited from another worktree
 * (Grove CoW clone, moved tree). Deliberately manual: silent inheritance is the
 * failure this guards against.
 */
export async function adoptUltragoalRun(cwd: string, options: { now?: Date } = {}): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
    if (!existsSync(ultragoalGoalsPath(cwd))) {
      throw new UltragoalError(`No ultragoal registry found at ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS} to adopt.`);
    }
    const loaded = await readExistingPlanForConflictCheck(cwd);
    if (!loaded) {
      throw new UltragoalError(`Invalid ultragoal registry at ${ULTRAGOAL_DIR}/${ULTRAGOAL_GOALS}.`);
    }
    const { plan: existing, migratedStatuses } = loaded;
    const now = iso(options.now);
    const runId = existing.runId ?? legacyRunIdForPlan(existing);
    const origin: UltragoalRunOrigin = existing.origin ?? { worktreePath: cwd, createdAt: existing.createdAt };
    origin.adoptedWorktreePaths = Array.from(new Set([...(origin.adoptedWorktreePaths ?? []), cwd]));
    const adopted: UltragoalPlan = { ...existing, runId, origin, updatedAt: now };
    await writeActiveRunPointer(cwd, {
      version: 1,
      runId,
      briefHash: adopted.briefHash ?? 'unknown',
      updatedAt: now,
      origin,
    });
    await writePlan(cwd, adopted);
    await appendLegacyStatusMigration(cwd, migratedStatuses, now);
    await appendLedger(cwd, {
      ts: now,
      event: 'plan_created',
      message: `run ${runId} adopted by worktree ${cwd} (origin ${origin.worktreePath})`,
    });
    return adopted;
  });
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf-8').digest('hex');
}

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isCodexRootBinding(value: unknown): value is UltragoalCodexRootBinding {
  if (!isRecord(value)) return false;
  return typeof value.threadId === 'string'
    && value.threadId.length > 0
    && !/\s/.test(value.threadId)
    && typeof value.objective === 'string'
    && value.objective.length > 0
    && Number.isSafeInteger(value.revision)
    && Number(value.revision) > 0;
}

function sameCodexRootBinding(
  left: UltragoalCodexRootBinding | undefined,
  right: UltragoalCodexRootBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.threadId === right.threadId
    && left.objective === right.objective
    && left.revision === right.revision;
}

interface CanonicalUltragoalPlan {
  path: string;
  raw: string;
  plan: UltragoalPlan;
}

function rootGoalTransitionEnvelope(
  runId: string,
  transition: UltragoalRootGoalTransition,
): Record<string, unknown> {
  return {
    contract: 'root-goal-reconcile-transition/v1',
    transitionVersion: transition.transitionVersion,
    runId,
    reconciledAt: transition.reconciledAt,
    beforePlanDigest: transition.beforePlanDigest,
    ledgerAncestry: transition.ledgerAncestry,
    snapshotDigest: transition.snapshotDigest,
    evidenceDigest: transition.evidenceDigest,
    ...(transition.normalization ? { normalization: transition.normalization } : {}),
    ...(transition.before ? { before: transition.before } : {}),
    ...(transition.legacyBefore ? { legacyBefore: transition.legacyBefore } : {}),
    after: transition.after,
  };
}

function expectedRootGoalEventId(
  runId: string,
  transition: UltragoalRootGoalTransition,
): string {
  return digestJson(rootGoalTransitionEnvelope(runId, transition));
}

function assertRootGoalTransition(
  value: unknown,
  label: string,
): asserts value is UltragoalRootGoalTransition {
  if (!isRecord(value)) {
    throw new UltragoalError(`${label} is malformed.`);
  }
  const transition = value as unknown as UltragoalRootGoalTransition;
  if (
    transition.transitionVersion !== 1
    || typeof transition.evidence !== 'string'
    || transition.evidence.length === 0
    || typeof transition.reconciledAt !== 'string'
    || transition.reconciledAt.length === 0
    || !isSha256(transition.beforePlanDigest)
    || !isSha256(transition.snapshotDigest)
    || !isSha256(transition.evidenceDigest)
    || !isRecord(transition.ledgerAncestry)
    || !isSha256(transition.ledgerAncestry.selectedDigest)
    || !isCodexRootBinding(transition.after)
  ) {
    throw new UltragoalError(`${label} is malformed.`);
  }
  if (transition.before !== undefined && !isCodexRootBinding(transition.before)) {
    throw new UltragoalError(`${label} before binding is malformed.`);
  }
  const expectedRevision = (transition.before?.revision ?? 0) + 1;
  if (transition.after.revision !== expectedRevision) {
    throw new UltragoalError(`${label} revision continuity is invalid.`);
  }
  if (
    transition.ledgerAncestry.flatDigest !== undefined
    && !isSha256(transition.ledgerAncestry.flatDigest)
  ) {
    throw new UltragoalError(`${label} flat ledger ancestry digest is malformed.`);
  }
  if (
    transition.ledgerAncestry.namespacedDigest !== undefined
    && !isSha256(transition.ledgerAncestry.namespacedDigest)
  ) {
    throw new UltragoalError(`${label} namespaced ledger ancestry digest is malformed.`);
  }
  const ancestryRequiresAnchor = transition.ledgerAncestry.relation !== 'equal'
    && transition.ledgerAncestry.relation !== 'flat_only'
    && transition.ledgerAncestry.relation !== 'namespaced_only';
  if (
    ancestryRequiresAnchor
    && (
      !isSha256(transition.ledgerAncestry.runAnchorDigest)
      || !Number.isSafeInteger(transition.ledgerAncestry.runAnchorLine)
      || Number(transition.ledgerAncestry.runAnchorLine) <= 0
    )
  ) {
    throw new UltragoalError(`${label} divergent ledger ancestry lacks a valid run anchor.`);
  }
  const relations: readonly UltragoalLedgerAncestryRelation[] = [
    'equal',
    'flat_only',
    'namespaced_only',
    'flat_has_namespaced_prefix',
    'flat_has_namespaced_suffix',
    'namespaced_has_flat_prefix',
    'namespaced_has_flat_suffix',
  ];
  if (!relations.includes(transition.ledgerAncestry.relation)) {
    throw new UltragoalError(`${label} ledger ancestry relation is malformed.`);
  }
  if (transition.evidenceDigest !== digestJson(transition.evidence)) {
    throw new UltragoalError(`${label} evidence digest mismatch.`);
  }
  if (transition.snapshotDigest !== digestJson({
    threadId: transition.after.threadId,
    objective: transition.after.objective,
    status: 'active',
  })) {
    throw new UltragoalError(`${label} snapshot digest mismatch.`);
  }
  if (transition.normalization) {
    if (
      !Number.isSafeInteger(transition.normalization.migratedStatuses)
      || transition.normalization.migratedStatuses < 0
      || (
        transition.normalization.previousObjective !== undefined
        && (
          typeof transition.normalization.previousObjective !== 'string'
          || transition.normalization.previousObjective.length === 0
        )
      )
    ) {
      throw new UltragoalError(`${label} normalization receipt is malformed.`);
    }
  }
  if (transition.legacyBefore !== undefined) {
    if (
      !isRecord(transition.legacyBefore)
      || Object.keys(transition.legacyBefore).length === 0
      || Object.values(transition.legacyBefore).some((entry) => (
        typeof entry !== 'string' || entry.length === 0
      ))
    ) {
      throw new UltragoalError(`${label} legacy predecessor is malformed.`);
    }
  }
}

function assertRootGoalReconciliationReceipt(plan: UltragoalPlan): void {
  const binding = plan.codexRootBinding;
  const receipt = plan.rootGoalReconciliation;
  if (!binding && !receipt) return;
  if (!binding || !receipt) {
    throw new UltragoalError('Canonical Codex root binding and reconciliation receipt must exist together.');
  }
  if (!isCodexRootBinding(binding)) {
    throw new UltragoalError('Canonical Codex root binding is malformed.');
  }
  assertRootGoalTransition(receipt, 'Canonical Codex root reconciliation receipt');
  if (!sameCodexRootBinding(binding, receipt.after)) {
    throw new UltragoalError('Canonical Codex root binding does not match its reconciliation receipt.');
  }
  if (!plan.runId || receipt.eventId !== expectedRootGoalEventId(plan.runId, receipt)) {
    throw new UltragoalError('Canonical Codex root reconciliation event id mismatch.');
  }
}

async function readCanonicalUltragoalPlan(cwd: string): Promise<CanonicalUltragoalPlan> {
  const pointer = await readActiveRunPointer(cwd);
  if (!pointer) {
    throw new UltragoalError('Root goal reconciliation requires an active namespaced run; run `omx ultragoal adopt-run` first.');
  }
  const path = join(ultragoalRunDir(cwd, pointer.runId), ULTRAGOAL_GOALS);
  let plan: UltragoalPlan;
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
    plan = JSON.parse(raw) as UltragoalPlan;
  } catch (error) {
    throw new UltragoalError(`Cannot read canonical Ultragoal plan at ${repoRelative(cwd, path)}${error instanceof Error ? `: ${error.message}` : ''}.`);
  }
  if (plan.version !== 1 || !Array.isArray(plan.goals) || plan.runId !== pointer.runId) {
    throw new UltragoalError(`Canonical Ultragoal plan does not match active run ${pointer.runId}.`);
  }
  if (await isUnownedInheritedRegistry(plan.origin, cwd)) {
    throw new UltragoalError('Refusing root goal reconciliation for an Ultragoal run not adopted by this worktree.');
  }
  if (pointer.briefHash !== plan.briefHash || digestJson(pointer.origin) !== digestJson(plan.origin)) {
    throw new UltragoalError('Active Ultragoal pointer metadata does not match the canonical run.');
  }
  assertRootGoalReconciliationReceipt(plan);
  return { path, raw, plan };
}

function rootGoalLedgerEntry(plan: UltragoalPlan, receipt: UltragoalRootGoalReconciliation): UltragoalLedgerEntry {
  return {
    ts: receipt.reconciledAt,
    event: 'root_goal_reconciled',
    eventVersion: 1,
    transitionVersion: receipt.transitionVersion,
    eventId: receipt.eventId,
    runId: plan.runId,
    revision: receipt.after.revision,
    snapshotDigest: receipt.snapshotDigest,
    evidence: receipt.evidence,
    evidenceDigest: receipt.evidenceDigest,
    beforePlanDigest: receipt.beforePlanDigest,
    ledgerAncestry: receipt.ledgerAncestry,
    normalization: receipt.normalization,
    legacyBefore: receipt.legacyBefore,
    message: `Reconciled aggregate Ultragoal run ${plan.runId} to active Codex thread ${receipt.after.threadId}.`,
    before: receipt.before,
    after: receipt.after,
  };
}

interface ValidatedLedger {
  state: 'missing' | 'empty' | 'present';
  raw: string;
  entries: UltragoalLedgerEntry[];
  digest?: string;
}

function assertRootGoalLedgerEntry(entry: UltragoalLedgerEntry, path: string, line: number): void {
  if (
    entry.eventVersion !== 1
    || entry.transitionVersion !== 1
    || !isSha256(entry.eventId)
    || typeof entry.runId !== 'string'
    || entry.runId.length === 0
    || !Number.isSafeInteger(entry.revision)
    || Number(entry.revision) <= 0
    || !isSha256(entry.snapshotDigest)
    || !isSha256(entry.evidenceDigest)
    || !isSha256(entry.beforePlanDigest)
    || !isRecord(entry.ledgerAncestry)
    || typeof entry.evidence !== 'string'
    || entry.evidence.length === 0
    || !isCodexRootBinding(entry.after)
  ) {
    throw new UltragoalError(`Malformed root goal reconciliation ledger entry at ${path}:${line}.`);
  }
  const transition: UltragoalRootGoalTransition = {
    transitionVersion: 1,
    snapshotDigest: entry.snapshotDigest,
    evidenceDigest: entry.evidenceDigest,
    evidence: entry.evidence,
    reconciledAt: entry.ts,
    beforePlanDigest: entry.beforePlanDigest,
    ledgerAncestry: entry.ledgerAncestry as UltragoalLedgerAncestry,
    ...(entry.normalization ? { normalization: entry.normalization } : {}),
    ...(entry.before ? { before: entry.before as UltragoalCodexRootBinding } : {}),
    ...(entry.legacyBefore ? { legacyBefore: entry.legacyBefore } : {}),
    after: entry.after,
  };
  assertRootGoalTransition(
    transition,
    `Root goal reconciliation ledger transition at ${path}:${line}`,
  );
  if (entry.revision !== entry.after.revision) {
    throw new UltragoalError(`Invalid root goal reconciliation revision at ${path}:${line}.`);
  }
  if (entry.eventId !== expectedRootGoalEventId(entry.runId, transition)) {
    throw new UltragoalError(`Invalid root goal reconciliation event id at ${path}:${line}.`);
  }
}

function assertLegacyRootGoalLedgerEntry(entry: Record<string, unknown>, path: string, line: number): void {
  if (
    typeof entry.runId !== 'string'
    || entry.runId.length === 0
    || typeof entry.message !== 'string'
    || entry.message.length === 0
    || typeof entry.evidence !== 'string'
    || entry.evidence.length === 0
    || typeof entry.rootGoalId !== 'string'
    || entry.rootGoalId.length === 0
    || typeof entry.codexThreadId !== 'string'
    || entry.codexThreadId.length === 0
  ) {
    throw new UltragoalError(`Malformed legacy root goal reconciliation ledger entry at ${path}:${line}.`);
  }
}

async function readValidatedLedger(path: string): Promise<ValidatedLedger> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing', raw: '', entries: [] };
    }
    throw error;
  }
  if (raw && !raw.endsWith('\n')) {
    throw new UltragoalError(`Refusing to repair truncated Ultragoal ledger at ${path}.`);
  }
  const entries: UltragoalLedgerEntry[] = [];
  const logicalRootEvents = new Set<string>();
  const lastRootEventByRun = new Map<string, UltragoalLedgerEntry>();
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new UltragoalError(`Refusing to repair malformed ledger line ${index + 1} at ${path}.`);
    }
    if (
      !isRecord(parsed)
      || typeof parsed.ts !== 'string'
      || parsed.ts.length === 0
      || typeof parsed.event !== 'string'
      || parsed.event.length === 0
    ) {
      throw new UltragoalError(`Refusing to repair invalid ledger entry ${index + 1} at ${path}.`);
    }
    const entry = parsed as unknown as UltragoalLedgerEntry;
    if (entry.event === 'root_goal_reconciled') {
      if (entry.eventVersion === undefined) {
        assertLegacyRootGoalLedgerEntry(parsed, path, index + 1);
      } else {
        assertRootGoalLedgerEntry(entry, path, index + 1);
        const logicalKey = `${entry.runId}\0${entry.revision}`;
        if (logicalRootEvents.has(logicalKey)) {
          throw new UltragoalError(`Duplicate logical root goal reconciliation transition at ${path}:${index + 1}.`);
        }
        const previous = lastRootEventByRun.get(entry.runId!);
        const expectedRevision = (previous?.revision ?? 0) + 1;
        if (entry.revision !== expectedRevision) {
          throw new UltragoalError(`Non-contiguous root goal reconciliation revision at ${path}:${index + 1}.`);
        }
        if (previous) {
          if (!sameCodexRootBinding(
            previous.after as UltragoalCodexRootBinding,
            entry.before as UltragoalCodexRootBinding | undefined,
          )) {
            throw new UltragoalError(`Broken root goal reconciliation binding chain at ${path}:${index + 1}.`);
          }
        } else if (entry.before !== undefined) {
          throw new UltragoalError(`First root goal reconciliation revision has an unexpected predecessor at ${path}:${index + 1}.`);
        }
        logicalRootEvents.add(logicalKey);
        lastRootEventByRun.set(entry.runId!, entry);
      }
    }
    entries.push(entry);
  }
  if (entries.length === 0) return { state: 'empty', raw, entries, digest: digestText(raw) };
  return { state: 'present', raw, entries, digest: digestText(raw) };
}

function rootGoalEvents(ledger: ValidatedLedger): UltragoalLedgerEntry[] {
  return ledger.entries.filter((entry) => (
    entry.event === 'root_goal_reconciled' && entry.eventVersion === 1
  ));
}

function matchingRootGoalEvent(ledger: ValidatedLedger, entry: UltragoalLedgerEntry): boolean {
  const sameTransition = rootGoalEvents(ledger).filter((candidate) => (
    candidate.runId === entry.runId && candidate.revision === entry.revision
  ));
  if (sameTransition.length > 1) {
    throw new UltragoalError(`Duplicate root goal reconciliation transition ${entry.runId}:${entry.revision}.`);
  }
  if (sameTransition.length === 0) return false;
  if (digestJson(sameTransition[0]) !== digestJson(entry)) {
    throw new UltragoalError(`Conflicting root goal reconciliation transition ${entry.runId}:${entry.revision}.`);
  }
  return true;
}

function requireLedgerDigest(value: string | undefined, label: string): string {
  if (!isSha256(value)) throw new UltragoalError(`${label} must be an exact lowercase SHA-256 digest.`);
  return value;
}

function runAnchor(
  ledger: ValidatedLedger,
  plan: UltragoalPlan,
): { digest: string; line: number } {
  const candidates = ledger.raw
    .split('\n')
    .map((line, index) => {
      if (!line) return null;
      const entry = JSON.parse(line) as UltragoalLedgerEntry;
      return { entry, line: index + 1 };
    })
    .filter((candidate): candidate is { entry: UltragoalLedgerEntry; line: number } => (
      candidate !== null
      && candidate.entry.event === 'plan_created'
      && typeof candidate.entry.message === 'string'
      && candidate.entry.message.includes(`run ${plan.runId}`)
    ));
  const anchor = candidates.at(-1);
  if (!anchor) {
    throw new UltragoalError(`Refusing to reconcile divergent Ultragoal ledgers without a plan_created anchor for run ${plan.runId}.`);
  }
  return {
    digest: digestJson(anchor.entry),
    line: anchor.line,
  };
}

function initialLedgerAncestry(
  plan: UltragoalPlan,
  flat: ValidatedLedger,
  namespaced: ValidatedLedger,
  options: ReconcileUltragoalRootGoalOptions,
): { ancestry: UltragoalLedgerAncestry; selected: string } {
  const flatAvailable = flat.state === 'present';
  const namespacedAvailable = namespaced.state === 'present';
  if (!flatAvailable && !namespacedAvailable) {
    throw new UltragoalError('Refusing root goal reconciliation because neither ledger contains valid history.');
  }
  if (flatAvailable && !namespacedAvailable) {
    return {
      ancestry: {
        relation: 'flat_only',
        flatDigest: flat.digest,
        selectedDigest: flat.digest!,
      },
      selected: flat.raw,
    };
  }
  if (!flatAvailable && namespacedAvailable) {
    return {
      ancestry: {
        relation: 'namespaced_only',
        namespacedDigest: namespaced.digest,
        selectedDigest: namespaced.digest!,
      },
      selected: namespaced.raw,
    };
  }
  if (flat.raw === namespaced.raw) {
    return {
      ancestry: {
        relation: 'equal',
        flatDigest: flat.digest,
        namespacedDigest: namespaced.digest,
        selectedDigest: flat.digest!,
      },
      selected: flat.raw,
    };
  }
  const expectedFlat = requireLedgerDigest(
    options.expectedFlatLedgerDigest,
    '--expected-flat-ledger-sha256',
  );
  const expectedNamespaced = requireLedgerDigest(
    options.expectedNamespacedLedgerDigest,
    '--expected-namespaced-ledger-sha256',
  );
  if (flat.digest !== expectedFlat || namespaced.digest !== expectedNamespaced) {
    throw new UltragoalError('Ultragoal ledger ancestry digest mismatch.');
  }
  let relation: UltragoalLedgerAncestryRelation;
  let selected: ValidatedLedger;
  if (flat.raw.startsWith(namespaced.raw)) {
    relation = 'flat_has_namespaced_prefix';
    selected = flat;
  } else if (flat.raw.endsWith(namespaced.raw)) {
    relation = 'flat_has_namespaced_suffix';
    selected = flat;
  } else if (namespaced.raw.startsWith(flat.raw)) {
    relation = 'namespaced_has_flat_prefix';
    selected = namespaced;
  } else if (namespaced.raw.endsWith(flat.raw)) {
    relation = 'namespaced_has_flat_suffix';
    selected = namespaced;
  } else {
    throw new UltragoalError('Refusing to reconcile divergent Ultragoal ledgers without an authorized exact prefix or suffix relationship.');
  }
  const anchor = runAnchor(selected, plan);
  return {
    ancestry: {
      relation,
      flatDigest: flat.digest,
      namespacedDigest: namespaced.digest,
      selectedDigest: selected.digest!,
      runAnchorDigest: anchor.digest,
      runAnchorLine: anchor.line,
    },
    selected: selected.raw,
  };
}

function normalizationLedgerEntries(
  plan: UltragoalPlan,
  receipt: UltragoalRootGoalReconciliation,
): UltragoalLedgerEntry[] {
  const normalization = receipt.normalization;
  if (!normalization) return [];
  const entries: UltragoalLedgerEntry[] = [];
  if (normalization.migratedStatuses > 0) {
    entries.push({
      ts: receipt.reconciledAt,
      event: 'plan_migrated',
      message: `Normalized ${normalization.migratedStatuses} legacy completed goal status${normalization.migratedStatuses === 1 ? '' : 'es'} to complete.`,
    });
  }
  if (normalization.previousObjective) {
    entries.push({
      ts: receipt.reconciledAt,
      event: 'aggregate_objective_migrated',
      message: 'Migrated legacy enumerated aggregate Codex objective to the stable pointer objective.',
      before: { codexObjective: normalization.previousObjective },
      after: { codexObjective: plan.codexObjective },
    });
  }
  return entries;
}

function appendLedgerEntries(raw: string, entries: readonly UltragoalLedgerEntry[]): string {
  return `${raw}${entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')}`;
}

function assertRecordedRunAnchor(
  selectedHistory: string,
  receipt: UltragoalRootGoalReconciliation,
  runId: string,
): void {
  const relation = receipt.ledgerAncestry.relation;
  if (relation === 'equal' || relation === 'flat_only' || relation === 'namespaced_only') return;
  const lineNumber = receipt.ledgerAncestry.runAnchorLine!;
  const line = selectedHistory.split('\n')[lineNumber - 1];
  if (!line) {
    throw new UltragoalError('Committed root goal reconciliation run anchor line is missing.');
  }
  let entry: UltragoalLedgerEntry;
  try {
    entry = JSON.parse(line) as UltragoalLedgerEntry;
  } catch {
    throw new UltragoalError('Committed root goal reconciliation run anchor is malformed.');
  }
  if (
    entry.event !== 'plan_created'
    || typeof entry.message !== 'string'
    || !entry.message.includes(`run ${runId}`)
    || digestJson(entry) !== receipt.ledgerAncestry.runAnchorDigest
  ) {
    throw new UltragoalError('Committed root goal reconciliation run anchor does not match recorded ancestry.');
  }
}

function committedRootGoalBatchPrefix(
  ledger: ValidatedLedger,
  expectedBatch: string,
  receipt: UltragoalRootGoalReconciliation,
  runId: string,
): string {
  const start = ledger.raw.indexOf(expectedBatch);
  if (start < 0) {
    throw new UltragoalError('Committed root goal reconciliation ledger batch is incomplete.');
  }
  if (ledger.raw.indexOf(expectedBatch, start + expectedBatch.length) >= 0) {
    throw new UltragoalError('Committed root goal reconciliation ledger batch is duplicated.');
  }
  const prefix = ledger.raw.slice(0, start);
  if (digestText(prefix) !== receipt.ledgerAncestry.selectedDigest) {
    throw new UltragoalError('Committed root goal reconciliation ledger ancestry digest mismatch.');
  }
  assertRecordedRunAnchor(prefix, receipt, runId);
  return prefix;
}

function replayLedgerBase(
  plan: UltragoalPlan,
  flat: ValidatedLedger,
  namespaced: ValidatedLedger,
  receipt: UltragoalRootGoalReconciliation,
  entry: UltragoalLedgerEntry,
): string {
  const flatHasEvent = matchingRootGoalEvent(flat, entry);
  const namespacedHasEvent = matchingRootGoalEvent(namespaced, entry);
  if (flatHasEvent || namespacedHasEvent) {
    const expectedBatch = appendLedgerEntries('', [
      ...normalizationLedgerEntries(plan, receipt),
      entry,
    ]);
    if (flatHasEvent) committedRootGoalBatchPrefix(flat, expectedBatch, receipt, entry.runId!);
    if (namespacedHasEvent) committedRootGoalBatchPrefix(namespaced, expectedBatch, receipt, entry.runId!);
    if (flatHasEvent && namespacedHasEvent) {
      if (flat.raw === namespaced.raw) return flat.raw;
      if (flat.raw.startsWith(namespaced.raw)) return flat.raw;
      if (namespaced.raw.startsWith(flat.raw)) return namespaced.raw;
      throw new UltragoalError('Root goal reconciliation ledgers diverged after the committed event.');
    }
    const committed = flatHasEvent ? flat : namespaced;
    const stale = flatHasEvent ? namespaced : flat;
    const staleDigest = stale.digest;
    const allowedStaleDigests = new Set([
      receipt.ledgerAncestry.flatDigest,
      receipt.ledgerAncestry.namespacedDigest,
    ].filter((value): value is string => Boolean(value)));
    if (
      stale.state !== 'missing'
      && stale.state !== 'empty'
      && !allowedStaleDigests.has(staleDigest ?? '')
    ) {
      throw new UltragoalError('Stale ledger projection does not match committed reconciliation ancestry.');
    }
    return committed.raw;
  }
  const candidates = [flat, namespaced].filter((ledger) => ledger.state === 'present');
  const selected = candidates.find((ledger) => ledger.digest === receipt.ledgerAncestry.selectedDigest);
  if (!selected) {
    throw new UltragoalError('Current divergent Ultragoal ledgers do not match the committed root reconciliation ancestry.');
  }
  assertRecordedRunAnchor(selected.raw, receipt, entry.runId!);
  for (const ledger of candidates) {
    const allowed = ledger.digest === receipt.ledgerAncestry.flatDigest
      || ledger.digest === receipt.ledgerAncestry.namespacedDigest;
    if (!allowed) throw new UltragoalError('Ledger projection drifted before reconciliation recovery.');
  }
  return appendLedgerEntries(selected.raw, [
    ...normalizationLedgerEntries(plan, receipt),
    entry,
  ]);
}

async function convergeRootGoalReconciliationArtifacts(
  cwd: string,
  canonical: CanonicalUltragoalPlan,
  plan: UltragoalPlan,
): Promise<string[]> {
  const receipt = plan.rootGoalReconciliation;
  if (!plan.runId || !receipt) throw new UltragoalError('Canonical root goal reconciliation receipt is missing.');
  assertRootGoalReconciliationReceipt(plan);
  const entry = rootGoalLedgerEntry(plan, receipt);
  const namespacedLedgerPath = join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_LEDGER);
  const flatLedgerPath = ultragoalLedgerPath(cwd);
  const namespacedLedger = await readValidatedLedger(namespacedLedgerPath);
  const flatLedger = await readValidatedLedger(flatLedgerPath);
  const expectedLedger = replayLedgerBase(plan, flatLedger, namespacedLedger, receipt, entry);

  const canonicalPlanPath = join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_GOALS);
  const flatPlanPath = ultragoalGoalsPath(cwd);
  const expectedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  const currentCanonical = await readFile(canonicalPlanPath, 'utf-8');
  if (
    currentCanonical !== expectedPlan
    && digestText(currentCanonical) !== receipt.beforePlanDigest
  ) {
    throw new UltragoalError('Canonical Ultragoal plan is neither the committed reconciliation nor its exact predecessor.');
  }
  if (canonical.path !== canonicalPlanPath || canonical.raw !== currentCanonical) {
    throw new UltragoalError('Canonical Ultragoal plan changed during reconciliation preflight.');
  }
  let currentFlat: string | null;
  try {
    currentFlat = await readFile(flatPlanPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    currentFlat = null;
  }
  if (
    currentFlat !== null
    && currentFlat !== expectedPlan
    && digestText(currentFlat) !== receipt.beforePlanDigest
  ) {
    throw new UltragoalError('Flat Ultragoal plan is neither the committed reconciliation nor its exact predecessor.');
  }

  const repaired: string[] = [];
  for (const [label, path] of [['namespaced goals', canonicalPlanPath], ['flat goals', flatPlanPath]] as const) {
    const current = path === canonicalPlanPath ? currentCanonical : currentFlat;
    if (current === expectedPlan) continue;
    await writeJsonAtomic(path, plan);
    repaired.push(label);
  }

  for (const [label, path, current] of [
    ['namespaced ledger', namespacedLedgerPath, namespacedLedger],
    ['flat ledger', flatLedgerPath, flatLedger],
  ] as const) {
    if (current.raw === expectedLedger) continue;
    await writeTextAtomic(path, expectedLedger);
    repaired.push(label);
  }
  return repaired;
}

export async function reconcileUltragoalRootGoal(
  cwd: string,
  options: ReconcileUltragoalRootGoalOptions,
): Promise<ReconcileUltragoalRootGoalResult> {
  return withUltragoalMutationLock(cwd, async () => {
    let canonical = await readCanonicalUltragoalPlan(cwd);
    let plan = canonical.plan;
    if (codexGoalMode(plan) !== 'aggregate') {
      throw new UltragoalError('Root Codex goal reconciliation is available only for aggregate Ultragoal runs.');
    }
    const completionPlan = plan.goals.some((goal) => (goal.status as string) === 'completed')
      ? {
        ...plan,
        goals: plan.goals.map((goal) => (
          (goal.status as string) === 'completed' ? { ...goal, status: 'complete' as const } : goal
        )),
      }
      : plan;
    if (isUltragoalDone(completionPlan) || plan.aggregateCompletion?.status === 'complete') {
      throw new UltragoalError('Refusing to reconcile a successor Codex goal after the Ultragoal run is complete.');
    }

    const evidence = assertNonEmpty(options.evidence, '--evidence');
    if (evidence.length > 8_000) throw new UltragoalError('--evidence exceeds 8000 characters.');
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
      throw new UltragoalError('--expected-revision must be a non-negative safe integer.');
    }
    const snapshot = parseCodexGoalSnapshot(options.codexGoal);
    if (!snapshot.available) {
      throw new UltragoalError('Codex goal snapshot is absent or unavailable; call get_goal and pass its JSON with --codex-goal-json.');
    }
    if (snapshot.status !== 'active') {
      throw new UltragoalError(`Successor Codex goal must be active; got ${snapshot.status ?? 'unknown'}.`);
    }
    const nextThreadId = assertNonEmpty(snapshot.threadId, 'Codex goal snapshot threadId');
    const nextObjective = assertNonEmpty(snapshot.objective, 'Codex goal snapshot objective');
    const current = plan.codexRootBinding;
    const currentRevision = current?.revision ?? 0;
    const receipt = plan.rootGoalReconciliation;
    const replayMatches = receipt
      && receipt.after.threadId === nextThreadId
      && receipt.after.objective === nextObjective
      && sameCodexRootBinding(current, receipt.after)
      && options.expectedRevision === (receipt.before?.revision ?? 0);
    if (
      options.expectedCurrentThreadId
      && options.expectedCurrentThreadId !== current?.threadId
      && !replayMatches
    ) {
      throw new UltragoalError(`Current Codex thread mismatch: expected ${options.expectedCurrentThreadId}, got ${current?.threadId ?? 'unbound'}.`);
    }
    if (options.expectedRevision !== currentRevision && !replayMatches) {
      throw new UltragoalError(`Codex root binding revision mismatch: expected ${options.expectedRevision}, current ${currentRevision}.`);
    }
    if (current?.threadId === nextThreadId && current.objective !== nextObjective) {
      throw new UltragoalError('Refusing objective drift for the existing Codex thread identity.');
    }

    if (sameCodexRootBinding(current, receipt?.after) && current?.threadId === nextThreadId && current.objective === nextObjective) {
      if (!receipt) throw new UltragoalError('Current Codex root binding has no reconciliation receipt.');
      const repairedProjections = await convergeRootGoalReconciliationArtifacts(cwd, canonical, plan);
      return {
        plan,
        deduped: true,
        eventId: receipt.eventId,
        before: receipt.before,
        after: receipt.after,
        repairedProjections,
      };
    }

    if (current && receipt) {
      await convergeRootGoalReconciliationArtifacts(cwd, canonical, plan);
      canonical = await readCanonicalUltragoalPlan(cwd);
      plan = canonical.plan;
    }
    const flatLedger = await readValidatedLedger(ultragoalLedgerPath(cwd));
    const namespacedLedger = await readValidatedLedger(
      join(ultragoalRunDir(cwd, plan.runId!), ULTRAGOAL_LEDGER),
    );
    if (
      !plan.codexRootBinding
      && (rootGoalEvents(flatLedger).length > 0 || rootGoalEvents(namespacedLedger).length > 0)
    ) {
      throw new UltragoalError('Ledger contains root reconciliation history but the canonical plan has no binding receipt.');
    }
    const ledger = initialLedgerAncestry(plan, flatLedger, namespacedLedger, options);
    const migratedStatuses = normalizeLegacyGoalStatuses(plan);
    const previousObjective = (
      isLegacyEnumeratedAggregateObjective(plan.codexObjective)
        ? plan.codexObjective
        : undefined
    );
    if (previousObjective) {
      plan.codexObjective = aggregateCodexObjective(plan.goals);
      plan.codexObjectiveAliases = Array.from(new Set([
        ...(plan.codexObjectiveAliases ?? []),
        previousObjective,
      ]));
    }

    const refreshedCurrent = plan.codexRootBinding;
    const refreshedRevision = refreshedCurrent?.revision ?? 0;
    const after: UltragoalCodexRootBinding = {
      threadId: nextThreadId,
      objective: nextObjective,
      revision: refreshedRevision + 1,
    };
    const legacyPlan = plan as UltragoalPlan & { rootGoalId?: string; codexThreadId?: string };
    const legacyBefore = refreshedCurrent ? undefined : {
      ...(legacyPlan.rootGoalId ? { rootGoalId: legacyPlan.rootGoalId } : {}),
      ...(legacyPlan.codexThreadId ? { codexThreadId: legacyPlan.codexThreadId } : {}),
      ...((previousObjective ?? plan.codexObjective)
        ? { codexObjective: previousObjective ?? plan.codexObjective }
        : {}),
    };
    const now = iso(options.now);
    const transition: UltragoalRootGoalTransition = {
      transitionVersion: 1,
      snapshotDigest: digestJson({ threadId: nextThreadId, objective: nextObjective, status: 'active' }),
      evidenceDigest: digestJson(evidence),
      evidence,
      reconciledAt: now,
      beforePlanDigest: digestText(canonical.raw),
      ledgerAncestry: ledger.ancestry,
      ...(
        migratedStatuses > 0 || previousObjective
          ? {
            normalization: {
              migratedStatuses,
              ...(previousObjective ? { previousObjective } : {}),
            },
          }
          : {}
      ),
      ...(refreshedCurrent ? { before: refreshedCurrent } : {}),
      ...(legacyBefore && Object.keys(legacyBefore).length > 0 ? { legacyBefore } : {}),
      after,
    };
    const eventId = expectedRootGoalEventId(plan.runId!, transition);
    plan.codexRootBinding = after;
    plan.rootGoalReconciliation = {
      ...transition,
      eventId,
    };
    delete legacyPlan.rootGoalId;
    delete legacyPlan.codexThreadId;
    plan.updatedAt = now;

    const repairedProjections = await convergeRootGoalReconciliationArtifacts(cwd, canonical, plan);
    return {
      plan,
      deduped: false,
      eventId,
      before: refreshedCurrent,
      after,
      repairedProjections,
    };
  });
}

/**
 * Same brief, same tree: continue the existing run rather than recreating it.
 * Backfills namespace identity onto pre-namespacing registries and records an
 * explicit adoption when the tree differs from the run's origin.
 */
async function adoptExistingPlanForRun(
  cwd: string,
  existing: UltragoalPlan,
  migratedStatuses: number,
  briefHash: string,
  options: CreateUltragoalOptions,
): Promise<UltragoalPlan> {
  const now = iso(options.now);
  const runId = existing.runId ?? legacyRunIdForPlan(existing);
  const origin: UltragoalRunOrigin = existing.origin ?? { worktreePath: cwd, createdAt: existing.createdAt };
  if (isInheritedOrigin(origin, cwd)) {
    origin.adoptedWorktreePaths = Array.from(new Set([...(origin.adoptedWorktreePaths ?? []), cwd]));
  }
  const adopted: UltragoalPlan = {
    ...existing,
    runId,
    briefHash: existing.briefHash ?? briefHash,
    origin,
    updatedAt: now,
  };
  await writeActiveRunPointer(cwd, {
    version: 1,
    runId,
    briefHash: adopted.briefHash as string,
    updatedAt: now,
    origin,
  });
  await writePlan(cwd, adopted);
  await appendLegacyStatusMigration(cwd, migratedStatuses, now);
  await appendLedger(cwd, {
    ts: now,
    event: 'plan_created',
    message: `adopted existing ultragoal registry as run ${runId} (${adopted.goals.length} goal(s))`,
  });
  return adopted;
}

export function summarizeUltragoalPlan(plan: UltragoalPlan): { total: number; pending: number; inProgress: number; complete: number; failed: number; reviewBlocked: number; historicalReviewBlocked: number; needsUserDecision: number; superseded: number; steeringBlocked: number; aggregateComplete: boolean; aggregateCompletionRecorded: boolean; artifactComplete: boolean; activeGoalId?: string } {
  const activeReviewBlocked = plan.goals.filter((goal) => goal.status === 'review_blocked' && !isReviewBlockedResolved(goal, plan)).length;
  const artifactComplete = isUltragoalDone(plan);
  const aggregateCompletionRecorded = plan.aggregateCompletion?.status === 'complete';
  return {
    total: plan.goals.length,
    pending: plan.goals.filter((goal) => goal.status === 'pending').length,
    inProgress: plan.goals.filter((goal) => goal.status === 'in_progress').length,
    complete: plan.goals.filter((goal) => goal.status === 'complete').length,
    failed: plan.goals.filter((goal) => goal.status === 'failed').length,
    reviewBlocked: activeReviewBlocked,
    historicalReviewBlocked: plan.goals.filter((goal) => goal.status === 'review_blocked').length - activeReviewBlocked,
    needsUserDecision: plan.goals.filter((goal) => goal.status === 'needs_user_decision').length,
    superseded: plan.goals.filter((goal) => goal.steeringStatus === 'superseded').length,
    steeringBlocked: plan.goals.filter((goal) => goal.steeringStatus === 'blocked').length,
    // Completed artifacts are authoritative when legacy plans lack the aggregate marker.
    aggregateComplete: aggregateCompletionRecorded || artifactComplete,
    aggregateCompletionRecorded,
    artifactComplete,
    activeGoalId: plan.activeGoalId,
  };
}

function assertNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new UltragoalError(`Missing ${label}.`);
  return trimmed;
}

export function parseUltragoalSteeringDirective(raw: string): UltragoalSteeringProposal | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 5) return null;
  try {
    const parsed = JSON.parse(trimmed) as UltragoalSteeringProposal;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.kind || typeof parsed.kind !== 'string') return null;
    if (!parsed.source || typeof parsed.source !== 'string') return null;
    if (!parsed.evidence || typeof parsed.evidence !== 'string') return null;
    if (!parsed.rationale || typeof parsed.rationale !== 'string') return null;
    if (!ULTRAGOAL_STEERING_MUTATION_KINDS.includes(parsed.kind as UltragoalSteeringMutationKind)) return null;
    if (!ULTRAGOAL_STEERING_SOURCES.includes(parsed.source as UltragoalSteeringSource)) return null;
    return parsed;
  } catch {
    return null;
  }
}


function appendGoalToPlan(plan: UltragoalPlan, options: AddUltragoalGoalOptions & { resolvesReviewBlockedGoalId?: string }, nowOverride?: string): UltragoalItem {
  const now = nowOverride ?? iso(options.now);
  const title = assertNonEmpty(options.title, '--title');
  const objective = assertNonEmpty(options.objective, '--objective');
  const goal: UltragoalItem = {
    id: normalizeGoalId(title, plan.goals.length),
    title,
    objective,
    status: 'pending',
    attempt: 0,
    createdAt: now,
    updatedAt: now,
    evidence: options.evidence,
    resolvesReviewBlockedGoalId: options.resolvesReviewBlockedGoalId,
  };
  plan.goals.push(goal);
  plan.updatedAt = now;
  return goal;
}

export async function addUltragoalGoal(cwd: string, options: AddUltragoalGoalOptions): Promise<{ plan: UltragoalPlan; goal: UltragoalItem }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnderLock(cwd);
  const now = iso(options.now);
  const goal = appendGoalToPlan(plan, options);
  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: goal.title,
  });
  return { plan, goal };
  });
}


function proposalTargetIds(proposal: UltragoalSteeringProposal): string[] {
  return proposal.targetGoalIds?.length ? proposal.targetGoalIds : (proposal.targetGoalId ? [proposal.targetGoalId] : []);
}

function steeringTargets(plan: UltragoalPlan, proposal: UltragoalSteeringProposal): UltragoalItem[] {
  return proposalTargetIds(proposal).map((id) => {
    const goal = plan.goals.find((candidate) => candidate.id === id);
    if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${id}`);
    return goal;
  });
}

function mentionsWeakenedCompletion(...values: Array<string | undefined>): boolean {
  const normalized = values.filter(Boolean).join(' ').toLowerCase();
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/.test(normalized)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/.test(normalized);
}

function hasProtectedSteeringPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const protectedKeys = new Set([
    'aggregateCompletion',
    'brief',
    'briefPath',
    'codexObjective',
    'constraints',
    'completedAt',
    'qualityGate',
    'status',
  ]);
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      if (protectedKeys.has(key)) return true;
      if (key.toLowerCase().includes('complete')) return true;
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return false;
}

function protectedIntentText(proposal: UltragoalSteeringProposal): string {
  const after = proposal.after as UltragoalSteeringAfterPayload | undefined;
  const childTexts = rawChildGoalsFromProposal(proposal).flatMap((child) => {
    if (!child || typeof child !== 'object' || Array.isArray(child)) return [];
    const candidate = child as { title?: unknown; objective?: unknown };
    return [candidate.title, candidate.objective];
  });
  return [
    proposal.title,
    proposal.objective,
    proposal.revisedTitle,
    proposal.revisedObjective,
    after?.title,
    after?.objective,
    proposal.rationale,
    proposal.directiveText,
    ...childTexts,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
}

function rawChildGoalsFromProposal(proposal: UltragoalSteeringProposal): unknown[] {
  if (Array.isArray(proposal.childGoals) && proposal.childGoals.length > 0) return proposal.childGoals;
  const after = proposal.after as { children?: unknown[] } | undefined;
  return Array.isArray(after?.children) ? after.children : [];
}

function isValidSteeringChildGoal(value: unknown): value is UltragoalSteeringChildGoal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as { title?: unknown; objective?: unknown };
  return typeof candidate.title === 'string'
    && candidate.title.trim().length > 0
    && typeof candidate.objective === 'string'
    && candidate.objective.trim().length > 0;
}

function childGoalsFromProposal(proposal: UltragoalSteeringProposal): UltragoalSteeringChildGoal[] {
  return rawChildGoalsFromProposal(proposal).filter(isValidSteeringChildGoal);
}

function pendingOrderFromProposal(proposal: UltragoalSteeringProposal): string[] {
  if (proposal.pendingOrder?.length) return proposal.pendingOrder;
  const after = proposal.after as { pendingGoalIds?: string[] } | undefined;
  return Array.isArray(after?.pendingGoalIds) ? after.pendingGoalIds : [];
}

function revisedTitleFromProposal(proposal: UltragoalSteeringProposal): string | undefined {
  if (proposal.revisedTitle?.trim()) return proposal.revisedTitle;
  const after = proposal.after as { title?: string } | undefined;
  return after?.title ?? proposal.title;
}

function revisedObjectiveFromProposal(proposal: UltragoalSteeringProposal): string | undefined {
  if (proposal.revisedObjective?.trim()) return proposal.revisedObjective;
  const after = proposal.after as { objective?: string } | undefined;
  return after?.objective ?? proposal.objective;
}

export function validateUltragoalSteeringProposal(plan: UltragoalPlan, proposal: UltragoalSteeringProposal): UltragoalSteeringInvariantResult {
  const rejectedReasons: string[] = [];
  const evidenceBackedNecessity = Boolean(proposal.evidence?.trim()) && Boolean(proposal.rationale?.trim());
  if (!ULTRAGOAL_STEERING_MUTATION_KINDS.includes(proposal.kind)) rejectedReasons.push(`Invalid steering mutation kind: ${String(proposal.kind)}.`);
  if (!ULTRAGOAL_STEERING_SOURCES.includes(proposal.source)) rejectedReasons.push(`Invalid steering source: ${String(proposal.source)}.`);
  if (!evidenceBackedNecessity) rejectedReasons.push('Steering requires non-empty evidence and rationale.');
  if (hasProtectedSteeringPayload(proposal.after)) rejectedReasons.push('Steering payload must not edit protected objective, constraint, quality gate, or completion fields.');
  if (/\b(?:skip|bypass|weaken|remove)\b.*\b(?:test|tests|review|verification|quality gate|complete|completion)\b|\bauto[- ]?complete\b/.test(protectedIntentText(proposal))) {
    rejectedReasons.push('Steering must not weaken completion, quality gates, tests, reviews, or auto-complete work.');
  }
  if (plan.aggregateCompletion?.status === 'complete') rejectedReasons.push('Cannot steer an already completed aggregate ultragoal plan.');

  let targets: UltragoalItem[] = [];
  try {
    targets = steeringTargets(plan, proposal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rejectedReasons.push(message.replace(/^Unknown ultragoal id:/, 'unknown ultragoal id:'));
  }
  const target = targets[0];
  if ((proposal.kind === 'split_subgoal' || proposal.kind === 'revise_pending_wording' || proposal.kind === 'mark_blocked_superseded') && targets.length > 1) {
    rejectedReasons.push(`${proposal.kind} accepts exactly one target goal id.`);
  }
  if ((proposal.kind === 'split_subgoal' || proposal.kind === 'revise_pending_wording' || proposal.kind === 'mark_blocked_superseded') && !target) {
    rejectedReasons.push(`${proposal.kind} requires a target goal id.`);
  }
  if ((proposal.kind === 'split_subgoal' || proposal.kind === 'revise_pending_wording') && target?.status !== 'pending') {
    rejectedReasons.push(`${proposal.kind} can only target a pending goal.`);
  }

  if (proposal.kind === 'add_subgoal') {
    if (!proposal.title?.trim() || !proposal.objective?.trim()) rejectedReasons.push('add_subgoal requires title and objective.');
  }
  if (proposal.kind === 'split_subgoal') {
    const rawChildren = rawChildGoalsFromProposal(proposal);
    if (rawChildren.length === 0) rejectedReasons.push('split_subgoal requires replacement child goals.');
    if (rawChildren.some((child) => !isValidSteeringChildGoal(child))) rejectedReasons.push('split_subgoal children require title and objective.');
  }
  if (proposal.kind === 'mark_blocked_superseded') {
    const rawChildren = rawChildGoalsFromProposal(proposal);
    if (rawChildren.some((child) => !isValidSteeringChildGoal(child))) rejectedReasons.push('mark_blocked_superseded replacement children require title and objective.');
  }
  if (proposal.kind === 'reorder_pending') {
    const requested = pendingOrderFromProposal(proposal);
    const pending = plan.goals.filter((goal) => goal.status === 'pending' && isScheduleEligible(goal)).map((goal) => goal.id);
    if (requested.length === 0) rejectedReasons.push('reorder_pending requires at least one pending goal id.');
    if (new Set(requested).size !== requested.length) rejectedReasons.push('duplicate goal id in pendingOrder.');
    if (requested.some((id) => !pending.includes(id))) rejectedReasons.push('pendingOrder contains non-pending or unknown goal.');
  }
  if (proposal.kind === 'revise_pending_wording') {
    if (!revisedTitleFromProposal(proposal)?.trim() && !revisedObjectiveFromProposal(proposal)?.trim()) rejectedReasons.push('revise_pending_wording requires title or objective.');
  }
  if (proposal.kind === 'annotate_ledger' && !proposal.evidence?.trim()) rejectedReasons.push('annotate_ledger requires evidence.');

  const accepted = rejectedReasons.length === 0;
  const noEasierCompletion = !mentionsWeakenedCompletion(protectedIntentText(proposal));
  return {
    structuralInvariantAccepted: accepted,
    evidenceBackedNecessity,
    noEasierCompletion,
    accepted,
    rejectedReasons,
    reasons: rejectedReasons,
  };
}

export const validateSteeringProposal = validateUltragoalSteeringProposal;

async function readSteeringLedgerEntries(cwd: string): Promise<UltragoalLedgerEntry[]> {
  try {
    const raw = await readFile(ultragoalLedgerPath(cwd), 'utf-8');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as UltragoalLedgerEntry);
  } catch {
    return [];
  }
}

function cloneForAudit<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function moveGoalsAfterTarget(plan: UltragoalPlan, targetId: string, movedIds: string[]): void {
  const moved = movedIds.map((id) => plan.goals.find((goal) => goal.id === id)).filter((goal): goal is UltragoalItem => Boolean(goal));
  if (moved.length === 0) return;
  plan.goals = plan.goals.filter((goal) => !movedIds.includes(goal.id));
  const targetIndex = plan.goals.findIndex((goal) => goal.id === targetId);
  plan.goals.splice(targetIndex >= 0 ? targetIndex + 1 : plan.goals.length, 0, ...moved);
}

function applySteeringMutation(plan: UltragoalPlan, proposal: UltragoalSteeringProposal, now: string): { before?: unknown; after?: unknown } {
  const targets = steeringTargets(plan, proposal);
  const target = targets[0];
  if (proposal.kind === 'add_subgoal') {
    const goal = appendGoalToPlan(plan, { title: proposal.title ?? '', objective: proposal.objective ?? '', evidence: proposal.evidence, now: new Date(now) });
    return { before: undefined, after: cloneForAudit(goal) };
  }
  if (proposal.kind === 'split_subgoal') {
    const before = cloneForAudit(target);
    const children = childGoalsFromProposal(proposal).map((child) => appendGoalToPlan(plan, { ...child, evidence: proposal.evidence, now: new Date(now) }));
    target.steeringStatus = 'superseded';
    target.supersededBy = children.map((child) => child.id);
    moveGoalsAfterTarget(plan, target.id, children.map((child) => child.id));
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    for (const child of children) child.supersedes = [target.id];
    if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
    plan.updatedAt = now;
    return { before, after: { target: cloneForAudit(target), children: cloneForAudit(children) } };
  }
  if (proposal.kind === 'reorder_pending') {
    const before = plan.goals.map((goal) => goal.id);
    const requested = pendingOrderFromProposal(proposal);
    const requestedSet = new Set(requested);
    const requestedGoals = requested.map((id) => plan.goals.find((goal) => goal.id === id)).filter((goal): goal is UltragoalItem => Boolean(goal));
    const remaining = plan.goals.filter((goal) => !requestedSet.has(goal.id));
    plan.goals = [...requestedGoals, ...remaining];
    plan.updatedAt = now;
    return { before, after: plan.goals.map((goal) => goal.id) };
  }
  if (proposal.kind === 'revise_pending_wording') {
    const before = cloneForAudit(target);
    const revisedTitle = revisedTitleFromProposal(proposal);
    const revisedObjective = revisedObjectiveFromProposal(proposal);
    if (revisedTitle?.trim()) target.title = revisedTitle.trim();
    if (revisedObjective?.trim()) target.objective = revisedObjective.trim();
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    plan.updatedAt = now;
    return { before, after: cloneForAudit(target) };
  }
  if (proposal.kind === 'annotate_ledger') {
    return { before: undefined, after: { evidence: proposal.evidence, rationale: proposal.rationale } };
  }
  if (proposal.kind === 'mark_blocked_superseded') {
    const before = cloneForAudit(target);
    const children = childGoalsFromProposal(proposal);
    if (children.length > 0) {
      const replacements = children.map((child) => appendGoalToPlan(plan, { ...child, evidence: proposal.evidence, now: new Date(now) }));
      target.steeringStatus = 'superseded';
      target.supersededBy = replacements.map((child) => child.id);
      moveGoalsAfterTarget(plan, target.id, replacements.map((child) => child.id));
      target.steeringEvidence = proposal.evidence;
      target.steeringRationale = proposal.rationale;
      target.updatedAt = now;
      for (const replacement of replacements) replacement.supersedes = [target.id];
      if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
      plan.updatedAt = now;
      return { before, after: { target: cloneForAudit(target), children: cloneForAudit(replacements) } };
    }
    if (plan.activeGoalId === target.id) delete plan.activeGoalId;
    target.steeringStatus = 'blocked';
    target.blockedReason = proposal.blockedReason ?? proposal.rationale;
    target.steeringEvidence = proposal.evidence;
    target.steeringRationale = proposal.rationale;
    target.updatedAt = now;
    if (plan.activeGoalId === target.id) plan.activeGoalId = undefined;
    plan.updatedAt = now;
    return { before, after: cloneForAudit(target) };
  }
  return {};
}

export async function steerUltragoal(cwd: string, proposal: UltragoalSteeringProposal, options: { now?: Date; directiveText?: string } = {}): Promise<SteerUltragoalResult> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnderLock(cwd);
  const existing = proposal.idempotencyKey
    ? (await readSteeringLedgerEntries(cwd)).find((entry) => entry.event === 'steering_accepted' && (entry.idempotencyKey === proposal.idempotencyKey || entry.steering?.idempotencyKey === proposal.idempotencyKey) && entry.steering)
    : undefined;
  if (existing?.steering) {
    return { plan, accepted: true, audit: { ...existing.steering, deduped: true }, rejectedReasons: [], deduped: true };
  }

  let invariant = validateUltragoalSteeringProposal(plan, proposal);
  const now = iso(options.now ?? proposal.now);
  const beforePlan = cloneForAudit(plan);
  let mutation: { before?: unknown; after?: unknown } = {};
  if (invariant.accepted) {
    try {
      mutation = applySteeringMutation(plan, proposal, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedReasons = [...invariant.rejectedReasons, `Steering mutation failed: ${message}`];
      invariant = {
        ...invariant,
        accepted: false,
        structuralInvariantAccepted: false,
        rejectedReasons,
        reasons: rejectedReasons,
      };
    }
  }
  const audit: UltragoalSteeringAudit = {
    kind: proposal.kind,
    source: proposal.source,
    targetGoalIds: proposalTargetIds(proposal),
    before: mutation.before ?? beforePlan,
    after: mutation.after,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    invariant,
    directiveText: options.directiveText ?? proposal.directiveText,
    promptSignature: proposal.promptSignature,
    idempotencyKey: proposal.idempotencyKey,
  };

  if (invariant.accepted) await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: invariant.accepted ? 'steering_accepted' : 'steering_rejected',
    goalId: proposalTargetIds(proposal)[0],
    evidence: proposal.evidence,
    message: proposal.rationale,
    steering: audit,
    mutationKind: proposal.kind,
    before: audit.before,
    after: audit.after,
  });

  return { plan, accepted: invariant.accepted, audit, rejectedReasons: invariant.rejectedReasons, deduped: false };
  });
}

function normalizeInvariantText(value: string): string {
  return value.replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
interface RequiredArchitectureInvariant {
  invariant: string;
  sourceArtifact: string;
  source: string;
}

function requiredInvariantSourceKey(invariant: RequiredArchitectureInvariant): string {
  return `${normalizeInvariantText(invariant.invariant)}\u0000${invariant.sourceArtifact}`;
}

function uniqueRequiredArchitectureInvariants(invariants: readonly RequiredArchitectureInvariant[]): RequiredArchitectureInvariant[] {
  const seen = new Set<string>();
  const unique: RequiredArchitectureInvariant[] = [];
  for (const invariant of invariants) {
    const key = requiredInvariantSourceKey(invariant);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(invariant);
  }
  return unique;
}

function architectureInvariantSectionSlug(label: string): string {
  return label
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'architecture-invariants';
}

function normalizeSourceArtifact(value: string): string {
  return value.trim().split('#', 1)[0]?.replace(/\\/g, '/') ?? '';
}

function sourceReferencesArtifact(source: string, artifact: string): boolean {
  return normalizeSourceArtifact(source) === normalizeSourceArtifact(artifact);
}

function sourceReferencesAnyArtifact(source: string, artifacts: readonly string[]): boolean {
  return artifacts.some((artifact) => sourceReferencesArtifact(source, artifact));
}

function invariantFromInlineDeclaration(line: string): string | undefined {
  const trimmed = cleanLine(line).replace(/^['"]|['"]$/g, '').trim();
  const match = /\b(?:(?:non-negotiable|required)\s+)?(?:architecture|architectural|domain)\s+(?:invariants?|constraints?|non-negotiables?)\s*:\s*(.+)$/i.exec(trimmed)
    ?? /\bnon-negotiables?\s+(?:architecture|architectural|domain)\s+(?:invariants?|constraints?)\s*:\s*(.+)$/i.exec(trimmed);
  const invariant = match?.[1]?.trim().replace(/[.;]\s*$/, '').trim();
  return invariant || undefined;
}

function extractArchitectureInvariantsFromArtifact(text: string, sourceArtifact: string, sourcePrefix?: string): RequiredArchitectureInvariant[] {
  const lines = text.split(/\r?\n/);
  const invariants: RequiredArchitectureInvariant[] = [];
  let inInvariantSection = false;
  let sectionSlug = 'architecture-invariants';
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const label = heading[1] ?? '';
      const normalizedLabel = label.toLowerCase();
      inInvariantSection = /\b(?:architecture|architectural|domain|non-negotiable)\b/.test(normalizedLabel) && /\binvariants?\b|\bconstraints?\b|\bnon-negotiables?\b/.test(normalizedLabel);
      if (inInvariantSection) sectionSlug = architectureInvariantSectionSlug(label);
      continue;
    }
    const inline = invariantFromInlineDeclaration(line);
    if (inline) {
      invariants.push({ invariant: inline, sourceArtifact, source: `${sourceArtifact}#${sourcePrefix ?? 'inline-architecture-invariant'}` });
      continue;
    }
    if (!inInvariantSection) continue;
    const item = cleanLine(line);
    if (!item || item === line.trim()) continue;
    invariants.push({ invariant: item, sourceArtifact, source: `${sourceArtifact}#${sourcePrefix ? `${sourcePrefix}-${sectionSlug}` : sectionSlug}` });
  }
  return uniqueRequiredArchitectureInvariants(invariants.map((item) => ({ ...item, invariant: item.invariant.trim() })).filter((item) => item.invariant));
}

function extractArchitectureInvariantsFromBrief(brief: string): RequiredArchitectureInvariant[] {
  return extractArchitectureInvariantsFromArtifact(brief, `${ULTRAGOAL_DIR}/${ULTRAGOAL_BRIEF}`);
}

function extractArchitectureInvariantsFromAcceptedSteering(entries: readonly UltragoalLedgerEntry[]): RequiredArchitectureInvariant[] {
  const invariants: RequiredArchitectureInvariant[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.event !== 'steering_accepted' || !entry.steering?.invariant.accepted) continue;
    const sourcePrefix = `steering-${index + 1}`;
    const steering = entry.steering;
    const texts = [
      entry.evidence,
      entry.message,
      steering.evidence,
      steering.rationale,
      steering.directiveText,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    for (const text of texts) {
      invariants.push(...extractArchitectureInvariantsFromArtifact(text, `${ULTRAGOAL_DIR}/${ULTRAGOAL_LEDGER}`, sourcePrefix));
    }
  }
  return uniqueRequiredArchitectureInvariants(invariants);
}

async function collectRequiredArchitectureInvariants(cwd: string): Promise<RequiredArchitectureInvariant[]> {
  const briefInvariants = extractArchitectureInvariantsFromBrief(await readFile(ultragoalBriefPath(cwd), 'utf-8'));
  const steeringInvariants = extractArchitectureInvariantsFromAcceptedSteering(await readSteeringLedgerEntries(cwd));
  return uniqueRequiredArchitectureInvariants([...briefInvariants, ...steeringInvariants]);
}


function validateArchitectureInvariantGate(gate: Partial<UltragoalQualityGate>, requiredInvariants: readonly RequiredArchitectureInvariant[]): void {
  const invariantGate = gate.architectureInvariantGate;
  if (!invariantGate || typeof invariantGate !== 'object') {
    throw new UltragoalError('Final quality gate is missing architectureInvariantGate evidence; include derived architecture/domain invariants, source artifacts, implementation/test/review evidence, or record final blockers for unproved invariants.');
  }
  if (invariantGate.status !== 'passed') {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.status="passed"; record blocker-resolution work for unproved invariants.');
  }
  if (!Array.isArray(invariantGate.sourceArtifacts)) {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.sourceArtifacts.');
  }
  const sourceArtifacts = invariantGate.sourceArtifacts.map((source) => assertNonEmpty(source, 'architectureInvariantGate.sourceArtifacts[]'));
  for (const required of requiredInvariants) {
    if (!sourceArtifacts.some((source) => sourceReferencesArtifact(source, required.sourceArtifact))) {
      throw new UltragoalError(`Final architecture-invariant gate sourceArtifacts must include required invariant source artifact: ${required.sourceArtifact}`);
    }
  }
  assertNonEmpty(invariantGate.evidence, 'architectureInvariantGate.evidence');
  if (!Array.isArray(invariantGate.invariants)) {
    throw new UltragoalError('Final architecture-invariant gate requires architectureInvariantGate.invariants.');
  }
  const provided = new Map<string, UltragoalArchitectureInvariantEvidence[]>();
  for (const invariant of invariantGate.invariants) {
    if (!invariant || typeof invariant !== 'object') throw new UltragoalError('Final architecture-invariant gate invariants must be objects.');
    const record = invariant as Partial<UltragoalArchitectureInvariantEvidence> & { blockers?: unknown };
    const text = assertNonEmpty(record.invariant, 'architectureInvariantGate.invariants[].invariant');
    const source = assertNonEmpty(record.source, 'architectureInvariantGate.invariants[].source');
    if (!sourceReferencesAnyArtifact(source, sourceArtifacts)) {
      throw new UltragoalError(`Final architecture invariant "${text}" source must reference one of architectureInvariantGate.sourceArtifacts; decorative provenance labels are not sufficient.`);
    }
    if (record.status !== 'proved') throw new UltragoalError(`Final architecture invariant "${text}" is not proved; record blocker-resolution work before final completion.`);
    if (record.blockers !== undefined) throw new UltragoalError(`Final architecture invariant "${text}" has blockers; record blocker-resolution work before final completion.`);
    assertNonEmpty(record.implementationEvidence, 'architectureInvariantGate.invariants[].implementationEvidence');
    assertNonEmpty(record.testEvidence, 'architectureInvariantGate.invariants[].testEvidence');
    assertNonEmpty(record.reviewEvidence, 'architectureInvariantGate.invariants[].reviewEvidence');
    const key = normalizeInvariantText(text);
    const records = provided.get(key) ?? [];
    records.push(record as UltragoalArchitectureInvariantEvidence);
    provided.set(key, records);
  }
  for (const required of requiredInvariants) {
    const matches = provided.get(normalizeInvariantText(required.invariant)) ?? [];
    if (matches.length === 0) {
      throw new UltragoalError(`Final architecture-invariant gate is missing proof for required invariant from ${required.sourceArtifact}: ${required.invariant}`);
    }
    if (!matches.some((record) => sourceReferencesArtifact(record.source, required.sourceArtifact))) {
      throw new UltragoalError(`Final architecture-invariant gate proof for required invariant must reference ${required.sourceArtifact}: ${required.invariant}`);
    }
  }
}

function validateQualityGate(value: unknown, requiredInvariants: readonly RequiredArchitectureInvariant[] = []): UltragoalQualityGate {
  if (!value || typeof value !== 'object') {
    throw new UltragoalError('Final ultragoal completion requires --quality-gate-json with ai-slop-cleaner, verification, code-review, and architecture-invariant evidence.');
  }
  const gate = value as Partial<UltragoalQualityGate>;
  const cleaner = gate.aiSlopCleaner;
  const verification = gate.verification;
  const review = gate.codeReview;
  if (!cleaner || typeof cleaner !== 'object') throw new UltragoalError('Final quality gate is missing aiSlopCleaner evidence.');
  if (cleaner.status !== 'passed') {
    throw new UltragoalError('Final quality gate requires aiSlopCleaner.status="passed"; run ai-slop-cleaner even when it is a no-op.');
  }
  assertNonEmpty(cleaner.evidence, 'aiSlopCleaner.evidence');
  if (!verification || typeof verification !== 'object') throw new UltragoalError('Final quality gate is missing verification evidence.');
  if (verification.status !== 'passed') throw new UltragoalError('Final quality gate requires verification.status="passed".');
  if (!Array.isArray(verification.commands) || verification.commands.length === 0 || verification.commands.some((command) => typeof command !== 'string' || command.trim() === '')) {
    throw new UltragoalError('Final quality gate requires non-empty verification.commands.');
  }
  assertNonEmpty(verification.evidence, 'verification.evidence');
  if (!review || typeof review !== 'object') throw new UltragoalError('Final quality gate is missing codeReview evidence.');
  if (review.recommendation !== 'APPROVE') {
    throw new UltragoalError('Final code-review must be clean: codeReview.recommendation must be APPROVE; use record-review-blockers for COMMENT or REQUEST CHANGES.');
  }
  if (review.architectStatus !== 'CLEAR') {
    throw new UltragoalError('Final code-review must be clean: codeReview.architectStatus must be CLEAR; use record-review-blockers for WATCH or BLOCK.');
  }
  assertNonEmpty(review.evidence, 'codeReview.evidence');
  const independentReview = (review as Partial<UltragoalQualityGate['codeReview']>).independentReview;
  if (!independentReview || typeof independentReview !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: codeReview.independentReview must include completed code-reviewer and architect subagent evidence; use record-review-blockers instead of self-approving.');
  }
  const codeReviewer = independentReview.codeReviewer;
  if (!codeReviewer || typeof codeReviewer !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: missing codeReview.independentReview.codeReviewer evidence from the code-reviewer subagent.');
  }
  if (codeReviewer.agentRole !== 'code-reviewer') {
    throw new UltragoalError('Final code-review must use an independent code-reviewer subagent; self-review or default/authoring-lane review cannot approve the ultragoal gate.');
  }
  assertNonEmpty(codeReviewer.evidence, 'codeReview.independentReview.codeReviewer.evidence');
  const architect = independentReview.architect;
  if (!architect || typeof architect !== 'object') {
    throw new UltragoalError('Final code-review independent review unavailable: missing codeReview.independentReview.architect evidence from the architect subagent.');
  }
  if (architect.agentRole !== 'architect') {
    throw new UltragoalError('Final code-review must use an independent architect subagent; self-review or default/authoring-lane review cannot approve the ultragoal gate.');
  }
  assertNonEmpty(architect.evidence, 'codeReview.independentReview.architect.evidence');
  validateArchitectureInvariantGate(gate, requiredInvariants);
  return gate as UltragoalQualityGate;
}

export async function startNextUltragoal(cwd: string, options: StartNextOptions = {}): Promise<{ plan: UltragoalPlan; goal: UltragoalItem | null; resumed: boolean; done: boolean }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnderLock(cwd);
  const now = iso(options.now);
  if (plan.aggregateCompletion?.status === 'complete') return { plan, goal: null, resumed: false, done: true };
  const existing = plan.goals.find((goal) => goal.status === 'in_progress' && isScheduleEligibleGoal(goal));
  if (existing) {
    await appendLedger(cwd, { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' });
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((goal) => goal.status === 'pending' && isScheduleEligible(goal));
  if (!next && options.retryFailed) {
    next = plan.goals.find((goal) => goal.status === 'failed' && !goal.nonRetriable && isScheduleEligible(goal));
    if (next) await appendLedger(cwd, { ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason });
  }
  if (!next) return { plan, goal: null, resumed: false, done: isUltragoalDone(plan) };

  next.status = 'in_progress';
  next.attempt += 1;
  next.startedAt = now;
  next.failedAt = undefined;
  next.failureReason = undefined;
  clearGoalBlockerFields(next);
  next.updatedAt = now;
  plan.activeGoalId = next.id;
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  await appendLedger(cwd, { ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` });
  return { plan, goal: next, resumed: false, done: false };
  });
}

export async function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnderLock(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  const now = iso(options.now);
  if (options.status === 'blocked') {
    if (goal.status !== 'in_progress') {
      throw new UltragoalError(`Cannot record a blocked checkpoint for ${goal.id} while it is ${goal.status}; start or resume the ultragoal before recording a non-terminal blocker.`);
    }
    const snapshot = options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal);
    if (snapshot?.unavailableReason === 'db_schema_context_error') {
      goal.updatedAt = now;
      goal.failureReason = assertNonEmpty(options.evidence, '--evidence');
      plan.activeGoalId = goal.id;
      plan.updatedAt = now;
      await writePlan(cwd, plan);
      await appendLedger(cwd, {
        ts: now,
        event: 'goal_blocked',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        message: 'Codex get_goal was unavailable due to a DB/schema/context error; strict completion reconciliation is deferred until get_goal works.',
      });
      return plan;
    }
    if (!snapshot?.available) {
      throw new UltragoalError('Blocked ultragoal checkpoints require either a get_goal snapshot for the completed legacy Codex goal that blocked create_goal, or an unavailable get_goal error JSON for a Codex DB/schema/context failure; pass --codex-goal-json.');
    }
    if (snapshot.status !== 'complete') {
      throw new UltragoalError(`Cannot record a blocked ultragoal checkpoint while the existing Codex goal is ${snapshot.status ?? 'unknown'}; strict objective mismatch protection remains required for active or incomplete goals.`);
    }
    if (!snapshot.objective) {
      throw new UltragoalError('Blocked ultragoal checkpoint Codex snapshot is missing objective text.');
    }
    const safeCompletedAggregateBlocker = isSafeCompletedAggregateBlockerSnapshot(plan, goal, snapshot, options.evidence);
    const blockedSnapshotMatchesExpected = [expectedCodexObjective(plan, goal), ...compatibleCodexObjectives(plan)]
      .some((objective) => normalizeObjective(objective) === normalizeObjective(snapshot.objective ?? ''));
    if (!safeCompletedAggregateBlocker && blockedSnapshotMatchesExpected) {
      throw new UltragoalError('Blocked ultragoal checkpoint is only for a different completed legacy Codex goal unless an aggregate Codex goal is already complete and unreconcilable while the active repo-native microgoal remains in progress.');
    }
    goal.updatedAt = now;
    if (safeCompletedAggregateBlocker) goal.failureReason = assertNonEmpty(options.evidence, '--evidence');
    plan.activeGoalId = goal.id;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'goal_blocked',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      message: safeCompletedAggregateBlocker
        ? 'Completed aggregate Codex goal is already terminal while the repo-native microgoal remains in progress; recorded a non-terminal safe-recovery blocker to avoid repeating an impossible checkpoint loop.'
        : undefined,
    });
    return plan;
  }
  let aggregateCompletion: UltragoalAggregateCompletion | undefined;
  let normalFinalAggregateCompletion: UltragoalAggregateCompletion | undefined;
  if (options.status === 'complete') {
    const expectedObjective = expectedCodexObjective(plan, goal);
    const aggregateMode = codexGoalMode(plan) === 'aggregate';
    const finalRunCheckpoint = isFinalRunCompletionCandidate(plan, goal);
    const snapshot = options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal);
    const reconciliation = reconcileCodexGoalSnapshot(
      snapshot,
      {
        expectedObjective,
        expectedThreadId: aggregateMode ? plan.codexRootBinding?.threadId : undefined,
        acceptedObjectives: aggregateMode ? compatibleCodexObjectives(plan) : undefined,
        allowedStatuses: aggregateMode
          ? (finalRunCheckpoint && !options.allowActiveFinalCodexGoal ? ['complete'] : ['active'])
          : ['complete'],
        requireSnapshot: true,
        requireComplete: !aggregateMode || (finalRunCheckpoint && !options.allowActiveFinalCodexGoal),
      },
    );
    if (!reconciliation.ok) {
      const completedTaskScopedAggregateSnapshot = snapshot?.available
        && snapshot.status === 'complete'
        && Boolean(snapshot.objective)
        && normalizeObjective(snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
        && await canReconcileCompletedTaskScopedAggregateSnapshot(
          cwd,
          plan,
          goal,
          snapshot.objective ?? '',
          options.evidence,
        );
      if (completedTaskScopedAggregateSnapshot) {
        if (unresolvedReviewBlockedGoals(plan).length > 0) {
          if (!canUseCleanFinalResolverPathForReviewBlockedParent(plan, goal, finalRunCheckpoint, options.allowActiveFinalCodexGoal)) {
            throw new UltragoalError('Completed task-scoped aggregate reconciliation is not allowed while unresolved review_blocked parent goals exist; only the parent\'s designated resolver may continue through the clean final quality gate path.');
          }
        } else {
          aggregateCompletion = {
            status: 'complete',
            completedAt: now,
            evidence: assertNonEmpty(options.evidence, '--evidence'),
            codexGoal: options.codexGoal,
          };
        }
      } else {
        const taskScopedRequirement = aggregateMode && snapshot?.status === 'complete' && Boolean(snapshot.objective)
          ? ' Completed task-scoped aggregate reconciliation requires the checkpoint goal to be the active in-progress OMX goal, evidence that names that active OMX goal id, names .omx/ultragoal/goals.json or ledger.jsonl, includes completed implementation plus validation/review evidence, and a get_goal objective that maps to the ultragoal brief.'
          : '';
        const remediation = reconciliation.snapshot.available
          && reconciliation.snapshot.status === 'complete'
          && Boolean(reconciliation.snapshot.objective)
          && normalizeObjective(reconciliation.snapshot.objective ?? '') !== normalizeObjective(expectedObjective)
          ? ` ${buildCompletedLegacyGoalRemediation(goal)}`
          : reconciliation.snapshot.unavailableReason === 'db_schema_context_error'
            ? ` ${buildUnavailableCodexGoalRemediation(goal)}`
          : '';
        throw new UltragoalError(`${formatCodexGoalReconciliation(reconciliation)}${taskScopedRequirement}${remediation}`);
      }
    }
    const designatedReviewBlockerResolver = goal.resolvesReviewBlockedGoalId
      ? isDesignatedReviewBlockerResolver(
        goal,
        plan.goals.find((candidate) => candidate.id === goal.resolvesReviewBlockedGoalId),
      )
      : false;
    if (aggregateMode && finalRunCheckpoint && !options.allowActiveFinalCodexGoal && designatedReviewBlockerResolver) {
      normalFinalAggregateCompletion = {
        status: 'complete',
        completedAt: now,
        evidence: assertNonEmpty(options.evidence, '--evidence'),
        codexGoal: options.codexGoal,
      };
    }
    if (finalRunCheckpoint && !options.allowActiveFinalCodexGoal) goal.evidence = options.evidence;
  }
  const requiredArchitectureInvariants = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalCodexGoal))
    ? await collectRequiredArchitectureInvariants(cwd)
    : [];
  const qualityGate = options.status === 'complete' && (aggregateCompletion !== undefined || (isFinalRunCompletionCandidate(plan, goal) && !options.allowActiveFinalCodexGoal))
    ? validateQualityGate(options.qualityGate, requiredArchitectureInvariants)
    : undefined;
  if (aggregateCompletion) {
    goal.status = 'complete';
    goal.completedAt = now;
    goal.updatedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    clearGoalBlockerFields(goal);
    plan.aggregateCompletion = aggregateCompletion;
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'goal_completed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      qualityGate,
      message: 'Active repo-native microgoal completed while reconciling a completed task-scoped aggregate Codex goal snapshot.',
    });
    await appendLedger(cwd, {
      ts: now,
      event: 'aggregate_completed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      qualityGate,
      message: 'Aggregate ultragoal plan completed via task-scoped Codex goal snapshot; checkpointed active microgoal row was reconciled to complete.',
    });
    return plan;
  }
  goal.status = options.status;
  goal.updatedAt = now;
  if (options.status === 'complete') {
    goal.completedAt = now;
    goal.evidence = options.evidence;
    goal.failureReason = undefined;
    goal.failedAt = undefined;
    clearGoalBlockerFields(goal);
    if (normalFinalAggregateCompletion) plan.aggregateCompletion = normalFinalAggregateCompletion;
    const resolvedParent = goal.resolvesReviewBlockedGoalId
      ? plan.goals.find((candidate) => candidate.id === goal.resolvesReviewBlockedGoalId)
      : undefined;
    if (resolvedParent?.status === 'review_blocked' && resolvedParent.reviewBlockerResolution?.resolverGoalId === goal.id && qualityGate) {
      resolvedParent.status = 'complete';
      resolvedParent.completedAt = now;
      resolvedParent.updatedAt = now;
      resolvedParent.reviewBlockerResolution = {
        resolverGoalId: goal.id,
        status: 'complete',
        resolvedAt: now,
        evidence: options.evidence,
      };
      clearGoalBlockerFields(resolvedParent);
    }
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  } else {
    const blocker = classifyExternalAuthorizationBlocker(options.evidence);
    const previousEntries = blocker ? await readSteeringLedgerEntries(cwd) : [];
    const occurrenceCount = blocker ? sameBlockerOccurrences(previousEntries, goal.id, blocker.signature) + 1 : 0;
    const shouldCircuitBreak = blocker !== null && occurrenceCount >= 3;
    goal.failedAt = now;
    goal.failureReason = options.evidence;
    goal.blockerSignature = blocker?.signature;
    goal.blockerOccurrenceCount = blocker ? occurrenceCount : undefined;
    goal.requiredExternalDecision = blocker?.requiredDecision;
    goal.nonRetriable = shouldCircuitBreak || undefined;
    if (shouldCircuitBreak) {
      goal.status = 'needs_user_decision';
      goal.blockedReason = options.evidence;
    }
    if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  }
  plan.updatedAt = now;
  await writePlan(cwd, plan);
  const blockerEvent = goal.status === 'needs_user_decision';
  await appendLedger(cwd, {
    ts: now,
    event: options.status === 'complete' ? 'goal_completed' : blockerEvent ? 'goal_needs_user_decision' : 'goal_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
    qualityGate,
    blockerSignature: goal.blockerSignature,
    blockerOccurrenceCount: goal.blockerOccurrenceCount,
    requiredExternalDecision: goal.requiredExternalDecision,
    message: blockerEvent
      ? `Blocked on repeated external authorization. Required decision: ${goal.requiredExternalDecision}.`
      : undefined,
  });
  if (options.status === 'complete' && goal.resolvesReviewBlockedGoalId) {
    const resolvedParent = plan.goals.find((candidate) => candidate.id === goal.resolvesReviewBlockedGoalId);
    if (resolvedParent?.reviewBlockerResolution?.status === 'complete' && resolvedParent.reviewBlockerResolution.resolverGoalId === goal.id) {
      await appendLedger(cwd, {
        ts: now,
        event: 'goal_completed',
        goalId: resolvedParent.id,
        status: resolvedParent.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        qualityGate,
        message: `Review-blocked final story resolved by ${goal.id}; original failed review remains in prior final_review_failed/goal_review_blocked ledger entries.`,
      });
    }
  }
  if (normalFinalAggregateCompletion) {
    await appendLedger(cwd, {
      ts: now,
      event: 'aggregate_completed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      qualityGate,
      message: 'Aggregate ultragoal plan completed with a clean final quality gate.',
    });
  }
  return plan;
  });
}

export async function recordFinalReviewBlockers(cwd: string, options: RecordFinalReviewBlockersOptions): Promise<{ plan: UltragoalPlan; blockedGoal: UltragoalItem; addedGoal: UltragoalItem }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnderLock(cwd);
  const goal = plan.goals.find((candidate) => candidate.id === options.goalId);
  if (!goal) throw new UltragoalError(`Unknown ultragoal id: ${options.goalId}`);
  assertNonEmpty(options.evidence, '--evidence');
  if (goal.status !== 'in_progress') {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id} while it is ${goal.status}; start or resume the ultragoal first.`);
  }
  if (!isFinalRunCompletionCandidate(plan, goal)) {
    throw new UltragoalError(`Cannot record final review blockers for ${goal.id}; it is not the only unresolved ultragoal story.`);
  }

  const now = iso(options.now);
  const expectedObjective = expectedCodexObjective(plan, goal);
  const aggregateMode = codexGoalMode(plan) === 'aggregate';
  const reconciliation = reconcileCodexGoalSnapshot(
    options.codexGoal === undefined ? null : parseCodexGoalSnapshot(options.codexGoal),
    {
      expectedObjective,
      expectedThreadId: aggregateMode ? plan.codexRootBinding?.threadId : undefined,
      acceptedObjectives: aggregateMode ? compatibleCodexObjectives(plan) : undefined,
      allowedStatuses: ['active'],
      requireSnapshot: true,
      requireComplete: false,
    },
  );
  if (!reconciliation.ok) {
    throw new UltragoalError(formatCodexGoalReconciliation(reconciliation));
  }

  const blockerClass = options.blockerClass ?? classifyReviewBlockerEvidence(options.evidence ?? '');
  if (blockerClass === 'evidence_stale') {
    const recaptureGoal = appendGoalToPlan(plan, { ...options, now: options.now });
    goal.updatedAt = now;
    plan.updatedAt = now;
    await writePlan(cwd, plan);
    await appendLedger(cwd, {
      ts: now,
      event: 'goal_added',
      goalId: recaptureGoal.id,
      status: recaptureGoal.status,
      evidence: options.evidence,
      message: `Final review reported stale evidence against the repaired state; appended evidence re-capture story ${recaptureGoal.id} and left ${goal.id} in progress instead of a full review-block round-trip.`,
    });
    return { plan, blockedGoal: goal, addedGoal: recaptureGoal };
  }

  const addedGoal = appendGoalToPlan(plan, { ...options, now: options.now, resolvesReviewBlockedGoalId: goal.id });
  goal.status = 'review_blocked';
  goal.reviewBlockedAt = now;
  goal.updatedAt = now;
  goal.completedAt = undefined;
  goal.failedAt = undefined;
  goal.failureReason = undefined;
  goal.evidence = options.evidence;
  goal.reviewBlockerResolution = {
    resolverGoalId: addedGoal.id,
    status: 'pending',
    evidence: options.evidence,
  };
  if (plan.activeGoalId === goal.id) delete plan.activeGoalId;
  plan.updatedAt = now;

  await writePlan(cwd, plan);
  await appendLedger(cwd, {
    ts: now,
    event: 'final_review_failed',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
    message: aggregateMode
      ? 'Final aggregate code-review was not clean; blocker story was appended while Codex goal remains active.'
      : 'Final per-story code-review was not clean; blocker story was appended and may require an available Codex goal context.',
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_added',
    goalId: addedGoal.id,
    status: addedGoal.status,
    evidence: options.evidence,
    message: addedGoal.title,
  });
  await appendLedger(cwd, {
    ts: now,
    event: 'goal_review_blocked',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    codexGoal: options.codexGoal,
  });
  return { plan, blockedGoal: goal, addedGoal };
  });
}

function codexGoalConductorGuidance(options: CodexGoalInstructionOptions): string {
  if (options.nativeSubagentSupport?.status !== 'unsupported') return LEADER_CONDUCTOR_BLOCK;
  return [
    buildUnsupportedNativeSubagentGuidance(options.nativeSubagentSupport),
    'Native independent review unavailable: do not treat final review as clean, do not call update_goal for clean completion, and use omx ultragoal record-review-blockers to create a non-clean blocker for the missing native independent review.',
  ].join('\n');
}

export function buildCodexGoalInstruction(
  goal: UltragoalItem,
  plan: UltragoalPlan,
  options: CodexGoalInstructionOptions = {},
): string {
  if (codexGoalMode(plan) === 'aggregate') return buildAggregateCodexGoalInstruction(goal, plan, options);
  return buildPerStoryCodexGoalInstruction(goal, plan, options);
}

function buildPerStoryCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan, options: CodexGoalInstructionOptions): string {
  const createPayload = {
    objective: goal.objective,
    ...(goal.tokenBudget ? { token_budget: goal.tokenBudget } : {}),
  };
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  return [
    codexGoalConductorGuidance(options),
    '',
    'Ultragoal active-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Codex goal integration constraints:',
    '- First call get_goal. If no active goal exists, call create_goal with the payload below.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Ultragoal preflight')}`,
    '- If a different active Codex goal exists, finish/checkpoint that goal before starting this ultragoal.',
    '- Ultragoal cannot call /goal clear from the model/shell tool surface. For another per-story goal in the same session/thread after a completed Codex goal, manually run /goal clear in the Codex UI before creating the next goal.',
    '- If get_goal returns a different completed legacy/thread goal and create_goal rejects because this thread already has a completed goal, continue only from a Codex goal context with no active/completed conflicting goal in the same repo/worktree and create the payload there.',
    `- To preserve the durable ledger before switching threads, record the non-terminal blocker without failing this goal: omx ultragoal checkpoint --goal-id ${goal.id} --status blocked --evidence "<completed legacy Codex goal blocks create_goal in this thread>" --codex-goal-json "<get_goal JSON or path>"`,
    '- Work only this goal until its completion audit passes.',
    finalStory
      ? '- Final mandatory quality gate: run ai-slop-cleaner on changed files even when it is a no-op, rerun verification, then run $code-review.'
      : '- This is not the final ultragoal story; do not run the final ai-slop-cleaner/$code-review gate yet.',
    finalStory
      ? '- Final $code-review is clean only when it is APPROVE with architect status CLEAR and includes independentReview evidence from both code-reviewer and architect subagents.'
      : null,
    finalStory
      ? '- If final $code-review is non-clean, missing independentReview evidence, or independent delegation is unavailable/skipped/failed, do not call update_goal. Record blockers with:'
      : '- After the goal is actually complete, call update_goal({status: "complete"}), call get_goal again for a fresh completion snapshot, then checkpoint the ledger with:',
    finalStory
      ? `  omx ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json "<active get_goal JSON or path>"`
      : `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh get_goal JSON or path>"`,
    finalStory
      ? '- In legacy per-story mode, the blocker story may require an available Codex goal context because this story remains an active incomplete Codex goal; do not claim it is complete.'
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR + independent code-reviewer and architect subagent evidence), call update_goal({status: "complete"}), call get_goal again, then checkpoint with --quality-gate-json:'
      : null,
    finalStory
      ? `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh complete get_goal JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : null,
    finalStory
      ? '- After the final checkpoint command succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.'
      : null,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Objective:',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}

function buildAggregateCodexGoalInstruction(goal: UltragoalItem, plan: UltragoalPlan, options: CodexGoalInstructionOptions): string {
  const objective = plan.codexRootBinding?.objective
    ?? plan.codexObjective
    ?? aggregateCodexObjective(plan.goals);
  const finalStory = isFinalRunCompletionCandidate(plan, goal);
  const createPayload = { objective };
  const checkpointStatus = finalStory ? 'complete' : 'active';
  return [
    codexGoalConductorGuidance(options),
    '',
    'Ultragoal aggregate-goal handoff',
    `Plan: ${plan.goalsPath}`,
    `Ledger: ${plan.ledgerPath}`,
    `Goal: ${goal.id} — ${goal.title}`,
    '',
    'Codex goal integration constraints:',
    '- Codex goal = the whole ultragoal run; OMX G001/G002/etc. = ledger stories.',
    '- First call get_goal. If no active goal exists, call create_goal with the aggregate payload below.',
    '- If get_goal reports the same aggregate objective as active, continue this OMX story without creating a new Codex goal.',
    `- If get_goal reports status complete before create_goal, do not call create_goal over it. ${buildCompletedCodexGoalRemediation('Ultragoal preflight')}`,
    '- If a different active or incomplete Codex goal exists, finish/checkpoint that goal before starting this ultragoal; do not replace hidden Codex state from the shell.',
    '- Ultragoal does not call /goal clear. After a completed aggregate run, manually run /goal clear in the Codex UI before starting another ultragoal run in the same session/thread.',
    finalStory
      ? '- This is the final pending story: run the mandatory final ai-slop-cleaner pass, rerun verification, and run $code-review before any update_goal call.'
      : '- This is not the final story: do not call update_goal yet; the aggregate Codex goal must remain active while later OMX stories remain.',
    finalStory
      ? '- Final $code-review is clean only when it is APPROVE with architect status CLEAR and includes independentReview evidence from both code-reviewer and architect subagents.'
      : null,
    finalStory
      ? '- If final $code-review is non-clean, missing independentReview evidence, or independent delegation is unavailable/skipped/failed, do not call update_goal. Record durable blocker work first:'
      : null,
    finalStory
      ? `  omx ultragoal record-review-blockers --goal-id ${goal.id} --title "Resolve final code-review blockers" --objective "<blocker-resolution objective>" --evidence "<review findings>" --codex-goal-json "<active get_goal JSON or path>"`
      : null,
    finalStory
      ? '- If final $code-review is clean (APPROVE + CLEAR + independent code-reviewer and architect subagent evidence), call update_goal({status: "complete"}), call get_goal again for a fresh complete snapshot, then checkpoint with --quality-gate-json.'
      : null,
    finalStory
      ? '- After the final checkpoint command succeeds, treat `/goal clear` as the explicit terminal cleanup step before another same-thread goal.'
      : null,
    `- Checkpoint this OMX story with a fresh get_goal snapshot whose objective matches the aggregate payload and whose status is ${checkpointStatus}:`,
    finalStory
      ? `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh complete get_goal JSON or path>" --quality-gate-json "<quality gate JSON or path>"`
      : `  omx ultragoal checkpoint --goal-id ${goal.id} --status complete --evidence "<tests/files/PR evidence>" --codex-goal-json "<fresh get_goal JSON or path>"`,
    '- If blocked or failed, checkpoint with --status failed and the failure evidence; rerun complete-goals --retry-failed to resume.',
    '',
    'create_goal payload:',
    JSON.stringify(createPayload, null, 2),
    '',
    'Aggregate objective:',
    objective,
    '',
    'Current OMX story objective:',
    goal.objective,
  ].filter((line): line is string => line !== null).join('\n');
}
