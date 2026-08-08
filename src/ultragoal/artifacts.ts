import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants, existsSync, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
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
  ultragoalActiveRunPointerPath,
  ultragoalDir,
  ultragoalRunDir,
  ultragoalRunsDir,
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
const ULTRAGOAL_MUTATION_GUARD = '.mutation.guard';
const ULTRAGOAL_LEDGER_TRANSACTION = '.ledger-transaction.json';
const ULTRAGOAL_RUN_TRANSACTION = '.run-transaction.json';

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
    const brief = normalizeObjective(
      await readSafeRegularFile(cwd, ultragoalBriefPath(cwd), 'active ultragoal projection'),
    ).toLowerCase();
    if (!brief || brief.length < 24) return false;
    return brief.includes(actual) || actual.includes(brief) || objectivesHaveConservativeSpecificTokenOverlap(actual, brief);
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
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
  return (plan.codexObjectiveAliases ?? [])
    .filter((objective) => isLegacyEnumeratedAggregateObjective(objective));
}

function expectedCodexObjective(plan: UltragoalPlan, goal: UltragoalItem): string {
  return codexGoalMode(plan) === 'aggregate'
    ? (plan.codexObjective ?? aggregateCodexObjective(plan.goals))
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

interface UltragoalMutationLockOwner {
  version: 1;
  pid: number;
  createdAt: string;
  ownerToken: string;
  processStartIdentity?: string;
}

interface LegacyUltragoalMutationLockOwner {
  pid: number;
  createdAt: string;
}

function parseMutationLockOwner(
  raw: string,
): UltragoalMutationLockOwner | LegacyUltragoalMutationLockOwner | null {
  try {
    const parsed = JSON.parse(raw) as Partial<UltragoalMutationLockOwner>;
    if (
      !Number.isSafeInteger(parsed.pid)
      || (parsed.pid as number) <= 0
      || typeof parsed.createdAt !== 'string'
      || parsed.createdAt.length === 0
    ) {
      return null;
    }
    if (parsed.version === undefined && parsed.ownerToken === undefined) {
      return { pid: parsed.pid as number, createdAt: parsed.createdAt };
    }
    if (
      parsed.version === 1
      && typeof parsed.ownerToken === 'string'
      && parsed.ownerToken.length > 0
      && (parsed.processStartIdentity === undefined || typeof parsed.processStartIdentity === 'string')
    ) {
      return parsed as UltragoalMutationLockOwner;
    }
    return null;
  } catch {
    return null;
  }
}

function processStartIdentity(pid: number): string | null {
  if (process.platform === 'win32') return null;
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function inspectProcess(pid: number): { alive: boolean; startIdentity: string | null } {
  try {
    process.kill(pid, 0);
    return { alive: true, startIdentity: processStartIdentity(pid) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      return { alive: true, startIdentity: processStartIdentity(pid) };
    }
    return { alive: false, startIdentity: null };
  }
}

function lockOwnerMatchesProcess(
  owner: UltragoalMutationLockOwner | LegacyUltragoalMutationLockOwner,
  processState: { alive: boolean; startIdentity: string | null },
): boolean {
  if (!processState.alive) return false;
  if ('ownerToken' in owner) {
    return (
      !owner.processStartIdentity
      || !processState.startIdentity
      || processState.startIdentity === owner.processStartIdentity
    );
  }
  if (!processState.startIdentity) return true;
  const processStartedAt = Date.parse(processState.startIdentity);
  const lockCreatedAt = Date.parse(owner.createdAt);
  if (!Number.isFinite(processStartedAt) || !Number.isFinite(lockCreatedAt)) return true;
  return processStartedAt <= lockCreatedAt + 1_000;
}

function advisoryLockCommand(path: string): { command: string; args: string[] } {
  const readyScript = [
    'process.stdout.write("LOCKED\\n");',
    'process.stdin.resume();',
    'process.stdin.on("end", () => process.exit(0));',
  ].join('');
  if (process.platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: ['-k', '-t', '0', path, process.execPath, '-e', readyScript],
    };
  }
  if (process.platform === 'win32') {
    const script = [
      '$path = $args[0];',
      '$stream = [System.IO.File]::Open($path, "OpenOrCreate", "ReadWrite", "None");',
      '[Console]::Out.WriteLine("LOCKED");',
      '[Console]::In.ReadToEnd() | Out-Null;',
      '$stream.Dispose();',
    ].join(' ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', script, path],
    };
  }
  return {
    command: 'flock',
    args: ['-n', path, process.execPath, '-e', readyScript],
  };
}

async function startAdvisoryLock(path: string): Promise<ChildProcessWithoutNullStreams | null> {
  const invocation = advisoryLockCommand(path);
  const child = spawn(invocation.command, invocation.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    const finish = (value: ChildProcessWithoutNullStreams | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('LOCKED\n')) finish(child);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('exit', () => finish(null));
  });
}

async function stopAdvisoryLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.stdin.end();
  });
}

async function ensureAdvisoryGuard(path: string): Promise<Stats> {
  try {
    const existing = await lstat(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new UltragoalError(`Refusing unsafe ultragoal mutation guard at ${path}.`);
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const created = await lstat(path);
  if (!created.isFile() || created.isSymbolicLink() || created.nlink !== 1) {
    throw new UltragoalError(`Refusing unsafe ultragoal mutation guard at ${path}.`);
  }
  return created;
}

async function readCompatibleMutationLock(
  cwd: string,
  lockPath: string,
): Promise<{
  owner: UltragoalMutationLockOwner | LegacyUltragoalMutationLockOwner;
  publicationCandidatePath: string | null;
} | null> {
  let raw: string;
  let publicationCandidatePath: string | null = null;
  try {
    raw = await readSafeRegularFile(cwd, lockPath, 'ultragoal mutation lock');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    const publication = await readMutationLockPublication(lockPath);
    if (publication) {
      raw = publication.raw;
      publicationCandidatePath = publication.candidatePath;
    } else {
      try {
        raw = await readSafeRegularFile(cwd, lockPath, 'ultragoal mutation lock');
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw retryError;
      }
    }
  }
  const owner = parseMutationLockOwner(raw);
  if (!owner) {
    throw new UltragoalError(`Refusing malformed ultragoal mutation lock at ${lockPath}.`);
  }
  return { owner, publicationCandidatePath };
}

async function clearAbandonedMutationLock(
  cwd: string,
  lockPath: string,
): Promise<boolean> {
  const existing = await readCompatibleMutationLock(cwd, lockPath);
  if (!existing) return true;
  if (lockOwnerMatchesProcess(existing.owner, inspectProcess(existing.owner.pid))) {
    return false;
  }
  if (existing.publicationCandidatePath) {
    await removeDurable(existing.publicationCandidatePath);
  }
  await removeDurable(lockPath);
  return true;
}

async function publishMutationLock(
  lockPath: string,
  owner: UltragoalMutationLockOwner,
): Promise<boolean> {
  const candidatePath = `${lockPath}.${owner.ownerToken}.candidate`;
  let linked = false;
  try {
    await writeFileSynced(candidatePath, `${JSON.stringify(owner, null, 2)}\n`, 0o600);
    try {
      await link(candidatePath, lockPath);
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await removeDurable(candidatePath);
        return false;
      }
      throw error;
    }
    await syncDirectory(dirname(lockPath));
    await removeDurable(candidatePath);
    return true;
  } catch (error) {
    if (linked) await rm(lockPath, { force: true }).catch(() => undefined);
    await rm(candidatePath, { force: true }).catch(() => undefined);
    await syncDirectory(dirname(lockPath)).catch(() => undefined);
    throw error;
  }
}

async function withUltragoalMutationLock<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  await ensureDirectoryDurable(ultragoalDir(cwd));
  const lockPath = join(ultragoalDir(cwd), ULTRAGOAL_MUTATION_LOCK);
  const guardPath = join(ultragoalDir(cwd), ULTRAGOAL_MUTATION_GUARD);
  const owner: UltragoalMutationLockOwner = {
    version: 1,
    pid: process.pid,
    createdAt: iso(),
    ownerToken: randomUUID(),
    processStartIdentity: processStartIdentity(process.pid) ?? undefined,
  };
  const guardIdentity = await ensureAdvisoryGuard(guardPath);
  let guard: ChildProcessWithoutNullStreams | null = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const attemptGuard = await startAdvisoryLock(guardPath);
    if (attemptGuard) {
      let keepGuard = false;
      try {
        const guarded = await lstat(guardPath);
        if (
          !guarded.isFile()
          || guarded.isSymbolicLink()
          || guarded.nlink !== 1
          || guarded.dev !== guardIdentity.dev
          || guarded.ino !== guardIdentity.ino
        ) {
          throw new UltragoalError(`Refusing replaced ultragoal mutation guard at ${repoRelative(cwd, guardPath)}.`);
        }
        if (
          await clearAbandonedMutationLock(cwd, lockPath)
          && await publishMutationLock(lockPath, owner)
        ) {
          guard = attemptGuard;
          keepGuard = true;
          break;
        }
      } finally {
        if (!keepGuard) await stopAdvisoryLock(attemptGuard);
      }
    }
    await sleep(Math.min(25 + attempt * 5, 250));
  }
  if (!guard) {
    throw new UltragoalError(`Timed out waiting for ultragoal mutation lock at ${repoRelative(cwd, lockPath)}.`);
  }
  try {
    try {
      await recoverRunTransaction(cwd);
      await recoverLedgerTransaction(cwd);
      return await operation();
    } finally {
      let current: Partial<UltragoalMutationLockOwner>;
      try {
        current = JSON.parse(
          await readSafeRegularFile(cwd, lockPath, 'ultragoal mutation lock'),
        ) as Partial<UltragoalMutationLockOwner>;
      } catch (error) {
        throw new UltragoalError(
          `Lost or invalid ultragoal mutation lock ownership at ${repoRelative(cwd, lockPath)}: ${error instanceof Error ? error.message : String(error)}.`,
        );
      }
      if (current.ownerToken !== owner.ownerToken) {
        throw new UltragoalError(`Refusing to release ultragoal mutation lock owned by a different writer at ${repoRelative(cwd, lockPath)}.`);
      }
      await removeDurable(lockPath);
    }
  } finally {
    await stopAdvisoryLock(guard);
  }
}

interface UltragoalLedgerTransaction {
  version: 1;
  runId: string;
  line: string;
  baseSha256: string;
  nextSha256: string;
}

interface UltragoalRunFileDigests {
  brief: string;
  goals: string;
  ledger: string;
}

interface UltragoalRunFileStates {
  brief: string | null;
  goals: string | null;
  ledger: string | null;
}

interface UltragoalRunTransaction {
  version: 1;
  mode?: 'create' | 'update';
  runId: string;
  pointer: {
    version: 1;
    runId: string;
    briefHash: string;
    updatedAt: string;
    origin: UltragoalRunOrigin;
  };
  files: UltragoalRunFileDigests;
  before: {
    run: UltragoalRunFileStates;
    projection: UltragoalRunFileStates;
    pointerSha256: string | null;
  };
  archive?: {
    runId: string;
    files: UltragoalRunFileDigests;
  };
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LEGACY_BRIEF_HASH_PATTERN = /^[a-f0-9]{16}$/;
const RUN_ID_PATTERN = /^(?:run|legacy)-[A-Za-z0-9._-]+$/;
const ULTRAGOAL_STATUS_VALUES = new Set([
  'pending',
  'in_progress',
  'complete',
  'completed',
  'failed',
  'review_blocked',
  'needs_user_decision',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf-8').digest('hex');
}

function isRunOrigin(value: unknown): value is UltragoalRunOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as Partial<UltragoalRunOrigin>;
  return (
    typeof origin.worktreePath === 'string'
    && origin.worktreePath.length > 0
    && typeof origin.createdAt === 'string'
    && origin.createdAt.length > 0
    && (
      origin.adoptedWorktreePaths === undefined
      || (
        Array.isArray(origin.adoptedWorktreePaths)
        && origin.adoptedWorktreePaths.every((path) => typeof path === 'string' && path.length > 0)
      )
    )
  );
}

function sameRunOrigin(left: UltragoalRunOrigin | undefined, right: UltragoalRunOrigin): boolean {
  if (!left) return false;
  const leftAdopted = left.adoptedWorktreePaths ?? [];
  const rightAdopted = right.adoptedWorktreePaths ?? [];
  return (
    left.worktreePath === right.worktreePath
    && left.createdAt === right.createdAt
    && leftAdopted.length === rightAdopted.length
    && leftAdopted.every((path, index) => path === rightAdopted[index])
  );
}

function sameBriefHashIdentity(left: string, right: string): boolean {
  return (
    left === right
    || (LEGACY_BRIEF_HASH_PATTERN.test(left) && right.startsWith(left))
    || (LEGACY_BRIEF_HASH_PATTERN.test(right) && left.startsWith(right))
  );
}

function assertPointerAuthority(
  pointer: Awaited<ReturnType<typeof readActiveRunPointer>>,
  plan: UltragoalPlan,
  files: { brief: string; goals: string; ledger: string },
): void {
  if (
    !pointer
    || pointer.runId !== plan.runId
    || !plan.briefHash
    || !sameBriefHashIdentity(pointer.briefHash, plan.briefHash)
    || pointer.updatedAt !== plan.updatedAt
    || !sameRunOrigin(plan.origin, pointer.origin)
  ) {
    throw new UltragoalError(`Refusing ultragoal run ${plan.runId ?? 'unknown'} without matching active-run pointer authority.`);
  }
  if (pointer.files) {
    assertRunFileDigests(files, pointer.files, `committed run ${plan.runId}`);
  }
}

function parseUltragoalPlanJson(raw: string, path: string): UltragoalPlan {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}.`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}.`);
  }
  const plan = value as Partial<UltragoalPlan>;
  if (
    plan.version !== 1
    || typeof plan.createdAt !== 'string'
    || plan.createdAt.length === 0
    || typeof plan.updatedAt !== 'string'
    || plan.updatedAt.length === 0
    || typeof plan.briefPath !== 'string'
    || plan.briefPath.length === 0
    || typeof plan.goalsPath !== 'string'
    || plan.goalsPath.length === 0
    || typeof plan.ledgerPath !== 'string'
    || plan.ledgerPath.length === 0
    || !Array.isArray(plan.goals)
  ) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}.`);
  }
  for (const goal of plan.goals) {
    if (
      !goal
      || typeof goal !== 'object'
      || Array.isArray(goal)
      || typeof goal.id !== 'string'
      || goal.id.length === 0
      || typeof goal.title !== 'string'
      || goal.title.length === 0
      || typeof goal.objective !== 'string'
      || goal.objective.length === 0
      || typeof goal.status !== 'string'
      || !ULTRAGOAL_STATUS_VALUES.has(goal.status)
      || !Number.isSafeInteger(goal.attempt)
      || goal.attempt < 0
      || typeof goal.createdAt !== 'string'
      || goal.createdAt.length === 0
      || typeof goal.updatedAt !== 'string'
      || goal.updatedAt.length === 0
    ) {
      throw new UltragoalError(`Invalid ultragoal plan at ${path}.`);
    }
  }
  if (plan.activeGoalId !== undefined && !plan.goals.some((goal) => goal.id === plan.activeGoalId)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}: active goal is missing.`);
  }
  if (plan.runId !== undefined && (typeof plan.runId !== 'string' || !RUN_ID_PATTERN.test(plan.runId))) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}: invalid run identity.`);
  }
  if (
    plan.briefHash !== undefined
    && (
      typeof plan.briefHash !== 'string'
      || (!SHA256_PATTERN.test(plan.briefHash) && !LEGACY_BRIEF_HASH_PATTERN.test(plan.briefHash))
    )
  ) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}: invalid brief hash.`);
  }
  if (plan.origin !== undefined && !isRunOrigin(plan.origin)) {
    throw new UltragoalError(`Invalid ultragoal plan at ${path}: invalid run origin.`);
  }
  return plan as UltragoalPlan;
}

function runTransactionPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_RUN_TRANSACTION);
}

function runStageDir(cwd: string, runId: string): string {
  return join(ultragoalDir(cwd), `.run-stage-${runId}`);
}

async function readRunFiles(cwd: string, runId: string): Promise<{ brief: string; goals: string; ledger: string }> {
  const runsDir = ultragoalRunsDir(cwd);
  const dir = ultragoalRunDir(cwd, runId);
  assertSafeDirectory(runsDir, await lstat(runsDir));
  assertSafeDirectory(dir, await lstat(dir));
  return {
    brief: await readCanonicalRunFile(cwd, join(dir, ULTRAGOAL_BRIEF)),
    goals: await readCanonicalRunFile(cwd, join(dir, ULTRAGOAL_GOALS)),
    ledger: await readCanonicalRunFile(cwd, join(dir, ULTRAGOAL_LEDGER)),
  };
}

async function readCanonicalRunFile(cwd: string, path: string): Promise<string> {
  const runDir = dirname(path);
  assertSafeDirectory(ultragoalRunsDir(cwd), await lstat(ultragoalRunsDir(cwd)));
  assertSafeDirectory(runDir, await lstat(runDir));
  return readSafeRegularFile(cwd, path, 'canonical ultragoal run file');
}

async function readRunFileStateFromDir(
  cwd: string,
  dir: string,
  label: string,
): Promise<{ raw: { brief: string | null; goals: string | null; ledger: string | null }; digests: UltragoalRunFileStates }> {
  const empty = {
    raw: { brief: null, goals: null, ledger: null },
    digests: emptyRunFileStates(),
  };
  try {
    assertSafeDirectory(ultragoalRunsDir(cwd), await lstat(ultragoalRunsDir(cwd)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw error;
  }
  try {
    assertSafeDirectory(dir, await lstat(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw error;
  }
  const raw = {
    brief: await readOptionalSafeRegularFile(cwd, join(dir, ULTRAGOAL_BRIEF), label),
    goals: await readOptionalSafeRegularFile(cwd, join(dir, ULTRAGOAL_GOALS), label),
    ledger: await readOptionalSafeRegularFile(cwd, join(dir, ULTRAGOAL_LEDGER), label),
  };
  return { raw, digests: runFileStates(raw) };
}

async function readFlatRunFileState(
  cwd: string,
): Promise<{ raw: { brief: string | null; goals: string | null; ledger: string | null }; digests: UltragoalRunFileStates }> {
  const raw = {
    brief: await readOptionalSafeRegularFile(cwd, ultragoalBriefPath(cwd), 'active ultragoal projection'),
    goals: await readOptionalSafeRegularFile(cwd, ultragoalGoalsPath(cwd), 'active ultragoal projection'),
    ledger: await readOptionalSafeRegularFile(cwd, ultragoalLedgerPath(cwd), 'active ultragoal projection'),
  };
  return { raw, digests: runFileStates(raw) };
}

async function readSafeRegularFile(cwd: string, path: string, label: string): Promise<string> {
  const before = await lstat(path);
  assertSafeRegularFile(cwd, path, before, label);
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(path, flags);
  } catch (error) {
    throw new UltragoalError(
      `Refusing unsafe ${label} at ${repoRelative(cwd, path)}: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  try {
    const opened = await handle.stat();
    assertSafeRegularFile(cwd, path, opened, label);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new UltragoalError(`Refusing replaced ${label} at ${repoRelative(cwd, path)}.`);
    }
    return await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
}

async function readMutationLockPublication(
  lockPath: string,
): Promise<{ raw: string; candidatePath: string } | null> {
  let before: Stats;
  try {
    before = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 2) return null;

  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  let handle;
  try {
    handle = await open(lockPath, flags);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.isSymbolicLink()
      || opened.nlink !== 2
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      return null;
    }
    const raw = await handle.readFile({ encoding: 'utf-8' });
    const owner = parseMutationLockOwner(raw);
    if (!owner || !('ownerToken' in owner)) return null;
    const candidatePath = `${lockPath}.${owner.ownerToken}.candidate`;
    let candidate: Stats;
    try {
      candidate = await lstat(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      !candidate.isFile()
      || candidate.isSymbolicLink()
      || candidate.nlink !== 2
      || candidate.dev !== opened.dev
      || candidate.ino !== opened.ino
    ) {
      return null;
    }
    return { raw, candidatePath };
  } finally {
    await handle.close();
  }
}

async function readOptionalSafeRegularFile(cwd: string, path: string, label: string): Promise<string | null> {
  try {
    return await readSafeRegularFile(cwd, path, label);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeRegularFile(cwd: string, path: string, file: Stats, label: string): void {
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
    throw new UltragoalError(`Refusing unsafe ${label} at ${repoRelative(cwd, path)}.`);
  }
}

function runFileDigests(files: { brief: string; goals: string; ledger: string }): UltragoalRunFileDigests {
  return {
    brief: sha256(files.brief),
    goals: sha256(files.goals),
    ledger: sha256(files.ledger),
  };
}

function isRunFileDigests(value: unknown): value is UltragoalRunFileDigests {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3
    && keys[0] === 'brief'
    && keys[1] === 'goals'
    && keys[2] === 'ledger'
    && SHA256_PATTERN.test(String(record.brief))
    && SHA256_PATTERN.test(String(record.goals))
    && SHA256_PATTERN.test(String(record.ledger))
  );
}

function isRunFileStates(value: unknown): value is UltragoalRunFileStates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 3
    && keys[0] === 'brief'
    && keys[1] === 'goals'
    && keys[2] === 'ledger'
    && [record.brief, record.goals, record.ledger].every(
      (digest) => digest === null || (typeof digest === 'string' && SHA256_PATTERN.test(digest)),
    )
  );
}

function emptyRunFileStates(): UltragoalRunFileStates {
  return { brief: null, goals: null, ledger: null };
}

function runFileStates(files: { brief: string | null; goals: string | null; ledger: string | null }): UltragoalRunFileStates {
  return {
    brief: files.brief === null ? null : sha256(files.brief),
    goals: files.goals === null ? null : sha256(files.goals),
    ledger: files.ledger === null ? null : sha256(files.ledger),
  };
}

function assertRunFileStateCanAdvance(
  current: UltragoalRunFileStates,
  before: UltragoalRunFileStates,
  next: UltragoalRunFileDigests,
  label: string,
): void {
  for (const key of ['brief', 'goals', 'ledger'] as const) {
    if (current[key] === before[key] || current[key] === next[key]) continue;
    throw new UltragoalError(`Refusing to recover ultragoal run transaction with divergent ${label} ${key}.`);
  }
}

function assertRunFileDigests(
  actual: { brief: string; goals: string; ledger: string },
  expected: UltragoalRunFileDigests,
  label: string,
): void {
  for (const key of ['brief', 'goals', 'ledger'] as const) {
    if (sha256(actual[key]) !== expected[key]) {
      throw new UltragoalError(`Refusing to recover ultragoal run transaction with divergent ${label} ${key}.`);
    }
  }
}

async function recoverRunTransaction(cwd: string): Promise<void> {
  const path = runTransactionPath(cwd);
  if (!existsSync(path)) return;

  let transaction: UltragoalRunTransaction;
  try {
    transaction = JSON.parse(await readSafeRegularFile(cwd, path, 'ultragoal run transaction journal')) as UltragoalRunTransaction;
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
    throw new UltragoalError(`Invalid ultragoal run transaction at ${repoRelative(cwd, path)}.`);
  }
  if (
    transaction.version !== 1
    || (transaction.mode !== undefined && transaction.mode !== 'create' && transaction.mode !== 'update')
    || !RUN_ID_PATTERN.test(transaction.runId)
    || transaction.pointer?.version !== 1
    || transaction.pointer.runId !== transaction.runId
    || !SHA256_PATTERN.test(transaction.pointer.briefHash)
    || typeof transaction.pointer.updatedAt !== 'string'
    || transaction.pointer.updatedAt.length === 0
    || !isRunOrigin(transaction.pointer.origin)
    || !isRunFileDigests(transaction.files)
    || !transaction.before
    || !isRunFileStates(transaction.before.run)
    || !isRunFileStates(transaction.before.projection)
    || (
      transaction.before.pointerSha256 !== null
      && !SHA256_PATTERN.test(transaction.before.pointerSha256)
    )
    || (
      transaction.archive !== undefined
      && (
        !RUN_ID_PATTERN.test(transaction.archive.runId)
        || transaction.archive.runId === transaction.runId
        || !isRunFileDigests(transaction.archive.files)
      )
    )
  ) {
    throw new UltragoalError(`Invalid ultragoal run transaction at ${repoRelative(cwd, path)}.`);
  }

  const finalDir = ultragoalRunDir(cwd, transaction.runId);
  const stageDir = runStageDir(cwd, transaction.runId);
  const staged = existsSync(stageDir) ? await readFilesFromDir(stageDir) : null;
  if (staged) validateRunFiles(cwd, stageDir, staged, transaction);
  const currentRun = await readRunFileStateFromDir(
    cwd,
    finalDir,
    'canonical ultragoal run file',
  );
  const currentProjection = await readFlatRunFileState(cwd);
  assertRunFileStateCanAdvance(
    currentRun.digests,
    transaction.before.run,
    transaction.files,
    `canonical run ${transaction.runId}`,
  );
  assertRunFileStateCanAdvance(
    currentProjection.digests,
    transaction.before.projection,
    transaction.files,
    'active projection',
  );
  const pointerRaw = await readOptionalSafeRegularFile(
    cwd,
    ultragoalActiveRunPointerPath(cwd),
    'ultragoal active-run pointer',
  );
  const pointerSha256 = pointerRaw === null ? null : sha256(pointerRaw);
  const nextPointerRaw = `${JSON.stringify({ ...transaction.pointer, files: transaction.files }, null, 2)}\n`;
  const nextPointerSha256 = sha256(nextPointerRaw);
  if (
    pointerSha256 !== transaction.before.pointerSha256
    && pointerSha256 !== nextPointerSha256
  ) {
    throw new UltragoalError('Refusing to recover ultragoal run transaction with divergent active-run pointer.');
  }

  if (transaction.mode === 'update') {
    if (staged) {
      await ensureDirectoryDurable(finalDir);
      if (currentRun.digests.brief !== transaction.files.brief) {
        await writeTextAtomic(join(finalDir, ULTRAGOAL_BRIEF), staged.brief);
      }
      if (currentRun.digests.goals !== transaction.files.goals) {
        await writeTextAtomic(join(finalDir, ULTRAGOAL_GOALS), staged.goals);
      }
      if (currentRun.digests.ledger !== transaction.files.ledger) {
        await writeJsonlAtomic(join(finalDir, ULTRAGOAL_LEDGER), staged.ledger);
      }
      await syncDirectory(finalDir);
    } else if (!existsSync(finalDir)) {
      throw new UltragoalError(`Ultragoal run transaction is missing staged run ${transaction.runId}.`);
    }
  } else if (!existsSync(finalDir)) {
    if (!existsSync(stageDir)) {
      throw new UltragoalError(`Ultragoal run transaction is missing staged run ${transaction.runId}.`);
    }
    await ensureDirectoryDurable(ultragoalRunsDir(cwd));
    await renameDurable(stageDir, finalDir);
  }

  const canonical = await readRunFiles(cwd, transaction.runId);
  validateRunFiles(cwd, finalDir, canonical, transaction);

  if (transaction.archive) {
    const archived = await readRunFiles(cwd, transaction.archive.runId);
    assertRunFileDigests(archived, transaction.archive.files, `archive ${transaction.archive.runId}`);
  }

  if (currentProjection.digests.brief !== transaction.files.brief) {
    await writeTextAtomic(ultragoalBriefPath(cwd), canonical.brief);
  }
  if (currentProjection.digests.goals !== transaction.files.goals) {
    await writeTextAtomic(ultragoalGoalsPath(cwd), canonical.goals);
  }
  if (currentProjection.digests.ledger !== transaction.files.ledger) {
    await writeJsonlAtomic(ultragoalLedgerPath(cwd), canonical.ledger);
  }
  if (pointerSha256 !== nextPointerSha256) {
    await writeActiveRunPointer(cwd, { ...transaction.pointer, files: transaction.files });
  }

  const projected = {
    brief: await readSafeRegularFile(cwd, ultragoalBriefPath(cwd), 'active ultragoal projection'),
    goals: await readSafeRegularFile(cwd, ultragoalGoalsPath(cwd), 'active ultragoal projection'),
    ledger: await readSafeRegularFile(cwd, ultragoalLedgerPath(cwd), 'active ultragoal projection'),
  };
  assertRunFileDigests(projected, transaction.files, 'active projection');
  await removeDirectoryDurable(stageDir);
  await removeDurable(path);
}

async function readFilesFromDir(dir: string): Promise<{ brief: string; goals: string; ledger: string }> {
  assertSafeDirectory(dir, await lstat(dir));
  return {
    brief: await readSafeRegularFile(dir, join(dir, ULTRAGOAL_BRIEF), 'staged run file'),
    goals: await readSafeRegularFile(dir, join(dir, ULTRAGOAL_GOALS), 'staged run file'),
    ledger: await readSafeRegularFile(dir, join(dir, ULTRAGOAL_LEDGER), 'staged run file'),
  };
}

function validateRunFiles(
  cwd: string,
  dir: string,
  files: { brief: string; goals: string; ledger: string },
  transaction: UltragoalRunTransaction,
): void {
  assertRunFileDigests(files, transaction.files, `run ${transaction.runId}`);
  assertValidLedgerJsonl(files.ledger, repoRelative(cwd, join(dir, ULTRAGOAL_LEDGER)));
  const goalsPath = repoRelative(cwd, join(dir, ULTRAGOAL_GOALS));
  const plan = parseUltragoalPlanJson(files.goals, goalsPath);
  if (
    plan.runId !== transaction.runId
    || plan.briefHash !== transaction.pointer.briefHash
    || computeUltragoalBriefHash(files.brief) !== transaction.pointer.briefHash
    || plan.updatedAt !== transaction.pointer.updatedAt
    || !sameRunOrigin(plan.origin, transaction.pointer.origin)
  ) {
    throw new UltragoalError(`Ultragoal run transaction identity mismatch for ${transaction.runId}.`);
  }
}

function assertValidLedgerJsonl(value: string, path: string): void {
  if (value && !value.endsWith('\n')) {
    throw new UltragoalError(`Invalid ultragoal ledger at ${path}: missing final newline.`);
  }
  for (const line of value.split('\n')) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('entry is not an object');
    } catch {
      throw new UltragoalError(`Invalid ultragoal ledger JSONL at ${path}.`);
    }
  }
}

function ledgerTransactionPath(cwd: string): string {
  return join(ultragoalDir(cwd), ULTRAGOAL_LEDGER_TRANSACTION);
}

async function readLedger(cwd: string, path: string): Promise<string> {
  return (await readOptionalSafeRegularFile(cwd, path, 'ultragoal ledger')) ?? '';
}

async function recoverLedgerTransaction(cwd: string): Promise<void> {
  const path = ledgerTransactionPath(cwd);
  if (!existsSync(path)) return;
  let transaction: UltragoalLedgerTransaction;
  try {
    transaction = JSON.parse(
      await readSafeRegularFile(cwd, path, 'ultragoal ledger transaction journal'),
    ) as UltragoalLedgerTransaction;
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
    throw new UltragoalError(`Invalid ultragoal ledger transaction at ${repoRelative(cwd, path)}.`);
  }
  const pointer = await readActiveRunPointer(cwd);
  if (
    transaction.version !== 1
    || !transaction.runId
    || !transaction.line.endsWith('\n')
    || !SHA256_PATTERN.test(transaction.baseSha256)
    || !SHA256_PATTERN.test(transaction.nextSha256)
    || pointer?.runId !== transaction.runId
    || !pointer.files
  ) {
    throw new UltragoalError(`Invalid ultragoal ledger transaction at ${repoRelative(cwd, path)}.`);
  }
  assertValidLedgerJsonl(transaction.line, repoRelative(cwd, path));
  const runPath = join(ultragoalRunDir(cwd, transaction.runId), ULTRAGOAL_LEDGER);
  const flatPath = ultragoalLedgerPath(cwd);
  const runFilesBefore = await readRunFiles(cwd, transaction.runId);
  if (
    pointer.files.brief !== sha256(runFilesBefore.brief)
    || pointer.files.goals !== sha256(runFilesBefore.goals)
    || (
      pointer.files.ledger !== transaction.baseSha256
      && pointer.files.ledger !== transaction.nextSha256
    )
  ) {
    throw new UltragoalError(`Invalid ultragoal ledger transaction authority at ${repoRelative(cwd, path)}.`);
  }
  for (const target of [runPath, flatPath]) {
    const current = await readLedger(cwd, target);
    assertValidLedgerJsonl(current, repoRelative(cwd, target));
    const currentSha = sha256(current);
    if (currentSha === transaction.nextSha256) continue;
    if (currentSha !== transaction.baseSha256) {
      throw new UltragoalError(`Refusing to recover divergent ultragoal ledger transaction at ${repoRelative(cwd, target)}.`);
    }
    if (sha256(`${current}${transaction.line}`) !== transaction.nextSha256) {
      throw new UltragoalError(`Invalid ultragoal ledger transaction digest at ${repoRelative(cwd, path)}.`);
    }
    await writeJsonlAtomic(target, `${current}${transaction.line}`);
  }
  const run = await readLedger(cwd, runPath);
  const flat = await readLedger(cwd, flatPath);
  if (run !== flat || sha256(run) !== transaction.nextSha256) {
    throw new UltragoalError(`Ultragoal ledger transaction did not converge ${repoRelative(cwd, runPath)} and ${repoRelative(cwd, flatPath)}.`);
  }
  const runFiles = await readRunFiles(cwd, transaction.runId);
  await writeActiveRunPointer(cwd, { ...pointer, files: runFileDigests(runFiles) });
  await removeDurable(path);
}

async function selectLegacyLedgerProjection(cwd: string, runId: string): Promise<string> {
  await recoverLedgerTransaction(cwd);
  const runDir = ultragoalRunDir(cwd, runId);
  const runPath = join(runDir, ULTRAGOAL_LEDGER);
  const flatPath = ultragoalLedgerPath(cwd);
  const run = await readLedger(cwd, runPath);
  const flat = await readLedger(cwd, flatPath);
  assertValidLedgerJsonl(run, repoRelative(cwd, runPath));
  assertValidLedgerJsonl(flat, repoRelative(cwd, flatPath));
  if (run === flat) return run;
  if (!run || flat.startsWith(run) || flat.endsWith(run)) {
    return flat;
  }
  if (!flat || run.startsWith(flat) || run.endsWith(flat)) {
    return run;
  }
  throw new UltragoalError(
    `Refusing to reconcile unrelated ultragoal ledgers at ${repoRelative(cwd, flatPath)} and ${repoRelative(cwd, runPath)}.`,
  );
}

async function appendLedger(
  cwd: string,
  entry: UltragoalLedgerEntry,
  expectedRunId?: string,
): Promise<void> {
  await ensureDirectoryDurable(ultragoalDir(cwd));
  const line = `${JSON.stringify(entry)}\n`;
  await recoverLedgerTransaction(cwd);
  const pointer = await readActiveRunPointer(cwd);
  if (!pointer) {
    if (expectedRunId) {
      throw new UltragoalError(`Refusing ledger append without active-run pointer authority for ${expectedRunId}.`);
    }
    const path = ultragoalLedgerPath(cwd);
    await writeJsonlAtomic(path, `${await readLedger(cwd, path)}${line}`);
    return;
  }
  if (expectedRunId && pointer.runId !== expectedRunId) {
    throw new UltragoalError(
      `Refusing ledger append for ${expectedRunId}; active-run pointer owns ${pointer.runId}.`,
    );
  }
  if (!pointer.files) {
    throw new UltragoalError(`Refusing ledger append without active-run file digests for ${pointer.runId}.`);
  }
  const runDir = ultragoalRunDir(cwd, pointer.runId);
  assertSafeDirectory(runDir, await lstat(runDir));
  const flatPath = ultragoalLedgerPath(cwd);
  const runPath = join(runDir, ULTRAGOAL_LEDGER);
  const canonical = await readRunFiles(cwd, pointer.runId);
  assertRunFileDigests(canonical, pointer.files, `committed run ${pointer.runId}`);
  const flatFiles = await readFlatRunFiles(cwd);
  assertRunFileDigests(flatFiles, pointer.files, 'active projection');
  const flat = flatFiles.ledger;
  const run = canonical.ledger;
  assertValidLedgerJsonl(flat, repoRelative(cwd, flatPath));
  assertValidLedgerJsonl(run, repoRelative(cwd, runPath));
  if (flat !== run) {
    throw new UltragoalError(
      `Refusing to append divergent ultragoal ledgers at ${repoRelative(cwd, flatPath)} and ${repoRelative(cwd, runPath)}.`,
    );
  }
  const transaction: UltragoalLedgerTransaction = {
    version: 1,
    runId: pointer.runId,
    line,
    baseSha256: sha256(run),
    nextSha256: sha256(`${run}${line}`),
  };
  await writePrivateJsonAtomic(ledgerTransactionPath(cwd), transaction);
  await writeJsonlAtomic(runPath, `${run}${line}`);
  await writeJsonlAtomic(flatPath, `${flat}${line}`);
  await recoverLedgerTransaction(cwd);
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

async function normalizeLegacyBriefHash(cwd: string, plan: UltragoalPlan): Promise<boolean> {
  if (!plan.briefHash || SHA256_PATTERN.test(plan.briefHash)) return false;
  const briefPath = plan.runId && existsSync(join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_BRIEF))
    ? join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_BRIEF)
    : ultragoalBriefPath(cwd);
  let brief: string;
  try {
    brief = briefPath === ultragoalBriefPath(cwd)
      ? await readSafeRegularFile(cwd, briefPath, 'active ultragoal projection')
      : await readCanonicalRunFile(cwd, briefPath);
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
    throw new UltragoalError(`Cannot validate legacy ultragoal brief hash without ${repoRelative(cwd, briefPath)}.`);
  }
  const canonical = computeUltragoalBriefHash(brief);
  if (!canonical.startsWith(plan.briefHash)) {
    throw new UltragoalError(`Legacy ultragoal brief hash does not match ${repoRelative(cwd, briefPath)}.`);
  }
  plan.briefHash = canonical;
  return true;
}

async function readUltragoalPlanUnlocked(cwd: string): Promise<UltragoalPlan> {
  await recoverLedgerTransaction(cwd);
  const path = ultragoalGoalsPath(cwd);
  let raw: string;
  try {
    raw = await readSafeRegularFile(cwd, path, 'active ultragoal projection');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new UltragoalError(`No ultragoal plan found at ${repoRelative(cwd, path)}. Run \`omx ultragoal create-goals ...\` first.`);
  }
  const parsed = parseUltragoalPlanJson(raw, repoRelative(cwd, path));
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
  let migratedPointerHash = false;
  let migratedPointerDigests = false;
  if (parsed.runId && existsSync(join(ultragoalRunDir(cwd, parsed.runId), ULTRAGOAL_GOALS))) {
    const canonical = await readRunFiles(cwd, parsed.runId);
    if (raw !== canonical.goals) {
      throw new UltragoalError(
        `Refusing to migrate divergent flat and canonical ultragoal goals for ${parsed.runId}.`,
      );
    }
    let pointer = await readActiveRunPointer(cwd);
    if (pointer && LEGACY_BRIEF_HASH_PATTERN.test(pointer.briefHash)) {
      const fullBriefHash = computeUltragoalBriefHash(canonical.brief);
      if (!fullBriefHash.startsWith(pointer.briefHash)) {
        throw new UltragoalError(`Legacy active-run brief hash does not match canonical run ${parsed.runId}.`);
      }
      pointer = { ...pointer, briefHash: fullBriefHash };
      migratedPointerHash = true;
    }
    assertPointerAuthority(pointer, parsed, canonical);
    const projected = {
      brief: await readSafeRegularFile(cwd, ultragoalBriefPath(cwd), 'active ultragoal projection'),
      goals: raw,
      ledger: await readSafeRegularFile(cwd, ultragoalLedgerPath(cwd), 'active ultragoal projection'),
    };
    if (pointer?.files) {
      assertRunFileDigests(projected, pointer.files, 'active projection');
    } else {
      migratedPointerDigests = true;
    }
    if (
      projected.brief !== canonical.brief
      || projected.goals !== canonical.goals
      || projected.ledger !== canonical.ledger
    ) {
      throw new UltragoalError(`Refusing divergent active and canonical ultragoal run ${parsed.runId}.`);
    }
  }
  const migratedStatuses = normalizeLegacyGoalStatuses(parsed);
  const migratedBriefHash = await normalizeLegacyBriefHash(cwd, parsed);
  const objectiveMigrated = codexGoalMode(parsed) === 'aggregate' && isLegacyEnumeratedAggregateObjective(parsed.codexObjective);
  if (migratedStatuses > 0 || migratedBriefHash || migratedPointerHash || migratedPointerDigests || objectiveMigrated) {
    const previousObjective = parsed.codexObjective;
    const now = iso();
    if (objectiveMigrated) {
      parsed.codexObjective = aggregateCodexObjective(parsed.goals);
      parsed.codexObjectiveAliases = Array.from(new Set([...(parsed.codexObjectiveAliases ?? []), previousObjective].filter((value): value is string => typeof value === 'string' && value.length > 0)));
    }
    parsed.updatedAt = now;
    const migrationEntries: UltragoalLedgerEntry[] = [];
    if (migratedStatuses > 0) {
      migrationEntries.push({
        ts: now,
        event: 'plan_migrated',
        message: `Normalized ${migratedStatuses} legacy completed goal status${migratedStatuses === 1 ? '' : 'es'} to complete.`,
      });
    }
    if (migratedBriefHash) {
      migrationEntries.push({
        ts: now,
        event: 'plan_migrated',
        message: 'Expanded legacy truncated brief hash to full SHA-256.',
      });
    }
    if (migratedPointerHash) {
      migrationEntries.push({
        ts: now,
        event: 'plan_migrated',
        message: 'Expanded legacy truncated active-run brief hash to full SHA-256.',
      });
    }
    if (migratedPointerDigests) {
      migrationEntries.push({
        ts: now,
        event: 'plan_migrated',
        message: 'Bound legacy active-run pointer to canonical run file digests.',
      });
    }
    if (objectiveMigrated) {
      migrationEntries.push({
        ts: now,
        event: 'aggregate_objective_migrated',
        message: 'Migrated legacy enumerated aggregate Codex objective to the stable pointer objective.',
        before: { codexObjective: previousObjective },
        after: { codexObjective: parsed.codexObjective },
      });
    }
    await publishPlanMutation(cwd, parsed, migrationEntries, {
      allowLegacyPointerFiles: migratedPointerDigests,
    });
  }
  return parsed;
}

export async function readUltragoalPlan(cwd: string): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, () => readUltragoalPlanUnlocked(cwd));
}

async function writeTextAtomic(path: string, value: string, defaultMode = 0o644): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const destination = await inspectReplacementDestination(path);
  try {
    await writeFileSynced(tmpPath, value, destination?.mode ?? defaultMode);
    await replacePreparedFile(path, tmpPath, destination);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function writePrivateJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

async function writeJsonlAtomic(path: string, value: string): Promise<void> {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const destination = await inspectReplacementDestination(path);
  try {
    await writeFileSynced(tmpPath, value, destination?.mode ?? 0o600);
    await replacePreparedFile(path, tmpPath, destination);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

interface ReplacementDestination {
  dev: number;
  ino: number;
  mode: number;
}

async function inspectReplacementDestination(path: string): Promise<ReplacementDestination | null> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new UltragoalError(`Refusing unsafe atomic replacement target at ${path}.`);
  }
  const flags = process.platform === 'win32'
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.isSymbolicLink()
      || opened.nlink !== 1
      || opened.dev !== before.dev
      || opened.ino !== before.ino
    ) {
      throw new UltragoalError(`Refusing replaced atomic replacement target at ${path}.`);
    }
    return { dev: opened.dev, ino: opened.ino, mode: opened.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function replacePreparedFile(
  destination: string,
  temporary: string,
  expected: ReplacementDestination | null,
): Promise<void> {
  try {
    const current = await inspectReplacementDestination(destination);
    if (
      (expected === null && current !== null)
      || (
        expected !== null
        && (
          current === null
          || current.dev !== expected.dev
          || current.ino !== expected.ino
        )
      )
    ) {
      throw new UltragoalError(`Refusing changed atomic replacement target at ${destination}.`);
    }
    await renameDurable(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeFileSynced(path: string, value: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDirectoryDurable(path: string): Promise<void> {
  if (existsSync(path)) {
    assertSafeDirectory(path, await lstat(path));
    return;
  }
  const parent = dirname(path);
  if (parent !== path) await ensureDirectoryDurable(parent);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertSafeDirectory(path, await lstat(path));
  await syncDirectory(path);
  if (parent !== path) await syncDirectory(parent);
}

function assertSafeDirectory(path: string, directory: Stats): void {
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new UltragoalError(`Refusing unsafe ultragoal directory at ${path}.`);
  }
}

async function renameDurable(source: string, destination: string): Promise<void> {
  await rename(source, destination);
  const sourceParent = dirname(source);
  const destinationParent = dirname(destination);
  await syncDirectory(destinationParent);
  if (sourceParent !== destinationParent) await syncDirectory(sourceParent);
}

async function removeDurable(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncDirectory(dirname(path));
}

async function removeDirectoryDurable(path: string): Promise<void> {
  let directory: Stats;
  try {
    directory = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  assertSafeDirectory(path, directory);
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}

/**
 * The namespaced run directory is canonical; the flat `.omx/ultragoal/goals.json`
 * is the active-run projection every existing reader (HUD, shutdown gates, state
 * operations) consumes. One writer, both paths, always together.
 */
function availableRunId(cwd: string, briefHash: string, now: Date): string {
  const base = buildUltragoalRunId(briefHash, now);
  if (!existsSync(ultragoalRunDir(cwd, base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existsSync(ultragoalRunDir(cwd, candidate))) return candidate;
  }
}


interface ExistingUltragoalPlan {
  plan: UltragoalPlan;
  migratedStatuses: number;
  migratedBriefHash: boolean;
}

async function readExistingPlanForConflictCheck(cwd: string): Promise<ExistingUltragoalPlan | null> {
  if (!existsSync(ultragoalGoalsPath(cwd))) return null;
  try {
    const flatRaw = await readSafeRegularFile(
      cwd,
      ultragoalGoalsPath(cwd),
      'active ultragoal projection',
    );
    const plan = parseUltragoalPlanJson(flatRaw, repoRelative(cwd, ultragoalGoalsPath(cwd)));
    if (plan.runId && existsSync(join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_GOALS))) {
      const canonicalRaw = await readCanonicalRunFile(
        cwd,
        join(ultragoalRunDir(cwd, plan.runId), ULTRAGOAL_GOALS),
      );
      if (flatRaw !== canonicalRaw) {
        throw new UltragoalError(
          `Refusing to use divergent flat and canonical ultragoal goals for ${plan.runId}.`,
        );
      }
    }
    const migratedStatuses = normalizeLegacyGoalStatuses(plan);
    const migratedBriefHash = await normalizeLegacyBriefHash(cwd, plan);
    return { plan, migratedStatuses, migratedBriefHash };
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
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
): Promise<{ adopt: ExistingUltragoalPlan | null; archivedTo: string | null; archivedRunId: string | null }> {
  const loaded = await readExistingPlanForConflictCheck(cwd);
  if (!loaded) return { adopt: null, archivedTo: null, archivedRunId: null };
  const existing = loaded.plan;
  const migratedStatuses = loaded.migratedStatuses;

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
    return { adopt: loaded, archivedTo: null, archivedRunId: null };
  }
  if (options.adoptExisting) return { adopt: loaded, archivedTo: null, archivedRunId: null };
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
  const archivedRunId = existing.runId ?? legacyRunIdForPlan(existing);
  const existingRunDir = existing.runId ? ultragoalRunDir(cwd, existing.runId) : null;
  if (existing.runId && existingRunDir && existsSync(existingRunDir)) {
    const canonical = await readRunFiles(cwd, existing.runId);
    const flat = await readFlatRunFiles(cwd);
    if (flat.brief !== canonical.brief || flat.goals !== canonical.goals || flat.ledger !== canonical.ledger) {
      throw new UltragoalError(
        `Refusing to archive divergent flat and canonical ultragoal run ${existing.runId}.`,
      );
    }
  } else {
    const now = iso(options.now);
    const existingBrief = (await readOptionalSafeRegularFile(
      cwd,
      ultragoalBriefPath(cwd),
      'active ultragoal projection',
    )) ?? '';
    existing.runId = archivedRunId;
    existing.briefHash ??= computeUltragoalBriefHash(existingBrief);
    existing.origin ??= { worktreePath: cwd, createdAt: existing.createdAt };
    existing.updatedAt = now;
    await publishExistingRunState(cwd, existing, migratedStatuses === 0 ? [] : [{
      ts: now,
      event: 'plan_migrated',
      message: `Normalized ${migratedStatuses} legacy completed goal status${migratedStatuses === 1 ? '' : 'es'} to complete.`,
    }]);
  }
  const archivedTo = await archiveFlatRegistry(cwd, archivedRunId);
  return { adopt: null, archivedTo, archivedRunId };
}

async function publishRunState(
  cwd: string,
  plan: UltragoalPlan,
  brief: string,
  ledger: string,
  mode: 'create' | 'update',
  archivedRunId: string | null,
): Promise<void> {
  const runId = plan.runId as string;
  const finalDir = ultragoalRunDir(cwd, runId);
  const stageDir = runStageDir(cwd, runId);
  if (mode === 'create' && existsSync(finalDir)) {
    throw new UltragoalError(`Refusing to overwrite existing ultragoal run ${runId}.`);
  }
  await removeDirectoryDurable(stageDir);
  await ensureDirectoryDurable(stageDir);
  await writeTextAtomic(join(stageDir, ULTRAGOAL_BRIEF), brief);
  await writeTextAtomic(join(stageDir, ULTRAGOAL_GOALS), `${JSON.stringify(plan, null, 2)}\n`);
  await writeTextAtomic(join(stageDir, ULTRAGOAL_LEDGER), ledger, 0o600);
  await syncDirectory(stageDir);
  await syncDirectory(dirname(stageDir));

  const staged = await readFilesFromDir(stageDir);
  assertValidLedgerJsonl(staged.ledger, repoRelative(cwd, join(stageDir, ULTRAGOAL_LEDGER)));
  const beforeRun = await readRunFileStateFromDir(
    cwd,
    finalDir,
    'canonical ultragoal run file',
  );
  const beforeProjection = await readFlatRunFileState(cwd);
  const beforePointer = await readOptionalSafeRegularFile(
    cwd,
    ultragoalActiveRunPointerPath(cwd),
    'ultragoal active-run pointer',
  );

  const transaction: UltragoalRunTransaction = {
    version: 1,
    mode,
    runId,
    pointer: {
      version: 1,
      runId,
      briefHash: plan.briefHash as string,
      updatedAt: plan.updatedAt,
      origin: plan.origin as UltragoalRunOrigin,
    },
    files: runFileDigests(staged),
    before: {
      run: beforeRun.digests,
      projection: beforeProjection.digests,
      pointerSha256: beforePointer === null ? null : sha256(beforePointer),
    },
  };
  if (archivedRunId) {
    const archived = await readRunFiles(cwd, archivedRunId);
    transaction.archive = {
      runId: archivedRunId,
      files: runFileDigests(archived),
    };
  }

  validateRunFiles(cwd, stageDir, staged, transaction);
  await writePrivateJsonAtomic(runTransactionPath(cwd), transaction);
  await recoverRunTransaction(cwd);
}

async function readFlatRunFiles(cwd: string): Promise<{ brief: string; goals: string; ledger: string }> {
  return {
    brief: (await readOptionalSafeRegularFile(
      cwd,
      ultragoalBriefPath(cwd),
      'active ultragoal projection',
    )) ?? '',
    goals: await readSafeRegularFile(cwd, ultragoalGoalsPath(cwd), 'active ultragoal projection'),
    ledger: await readLedger(cwd, ultragoalLedgerPath(cwd)),
  };
}

async function publishExistingRunState(
  cwd: string,
  plan: UltragoalPlan,
  entries: UltragoalLedgerEntry[],
  options: { allowLegacyPointerFiles?: boolean } = {},
): Promise<void> {
  if (!plan.runId || !plan.briefHash || !plan.origin) {
    throw new UltragoalError('Cannot publish an existing ultragoal run without canonical identity.');
  }
  const runDir = ultragoalRunDir(cwd, plan.runId);
  const current = existsSync(runDir)
    ? await readRunFiles(cwd, plan.runId)
    : await readFlatRunFiles(cwd);
  if (existsSync(runDir)) {
    const flat = await readFlatRunFiles(cwd);
    const pointer = await readActiveRunPointer(cwd);
    const currentPlan = parseUltragoalPlanJson(
      current.goals,
      repoRelative(cwd, join(runDir, ULTRAGOAL_GOALS)),
    );
    assertPointerAuthority(pointer, currentPlan, current);
    if (
      plan.runId !== currentPlan.runId
      || !sameBriefHashIdentity(plan.briefHash, currentPlan.briefHash as string)
      || !sameRunOrigin(plan.origin, currentPlan.origin as UltragoalRunOrigin)
    ) {
      throw new UltragoalError(`Refusing ordinary mutation that changes canonical run identity for ${plan.runId}.`);
    }
    if (!pointer?.files && !options.allowLegacyPointerFiles) {
      throw new UltragoalError(`Refusing ordinary mutation without active-run file digests for ${plan.runId}.`);
    }
    if (pointer?.files) assertRunFileDigests(flat, pointer.files, 'active projection');
    if (flat.brief !== current.brief || flat.goals !== current.goals || flat.ledger !== current.ledger) {
      throw new UltragoalError(
        `Refusing to update divergent flat and canonical ultragoal run ${plan.runId}.`,
      );
    }
  }
  assertValidLedgerJsonl(current.ledger, repoRelative(cwd, join(runDir, ULTRAGOAL_LEDGER)));
  const ledger = entries.reduce((value, entry) => `${value}${JSON.stringify(entry)}\n`, current.ledger);
  await publishRunState(cwd, plan, current.brief, ledger, 'update', null);
}

async function publishPlanMutation(
  cwd: string,
  plan: UltragoalPlan,
  entries: UltragoalLedgerEntry[],
  options: { allowLegacyPointerFiles?: boolean } = {},
): Promise<void> {
  const identityCount = Number(Boolean(plan.runId)) + Number(Boolean(plan.briefHash)) + Number(Boolean(plan.origin));
  if (identityCount !== 0 && identityCount !== 3) {
    throw new UltragoalError('Refusing to mutate an ultragoal plan with partial canonical identity.');
  }
  if (identityCount === 0) {
    const pointer = await readActiveRunPointer(cwd);
    const runId = legacyRunIdForPlan(plan);
    if (pointer || existsSync(ultragoalRunDir(cwd, runId))) {
      throw new UltragoalError('Refusing to mutate an ambiguous pre-namespacing ultragoal plan; run `omx ultragoal adopt-run` first.');
    }
    const brief = (await readOptionalSafeRegularFile(
      cwd,
      ultragoalBriefPath(cwd),
      'active ultragoal projection',
    )) ?? '';
    plan.runId = runId;
    plan.briefHash = computeUltragoalBriefHash(brief);
    plan.origin = { worktreePath: cwd, createdAt: plan.createdAt };
  }
  await publishExistingRunState(cwd, plan, entries, options);
}

async function readAdoptionBase(
  cwd: string,
  runId: string,
): Promise<{ brief: string; ledger: string }> {
  const runDir = ultragoalRunDir(cwd, runId);
  if (existsSync(join(runDir, ULTRAGOAL_BRIEF)) && existsSync(ultragoalBriefPath(cwd))) {
    const canonicalBrief = await readCanonicalRunFile(cwd, join(runDir, ULTRAGOAL_BRIEF));
    const flatBrief = await readSafeRegularFile(
      cwd,
      ultragoalBriefPath(cwd),
      'active ultragoal projection',
    );
    if (canonicalBrief !== flatBrief) {
      throw new UltragoalError(`Refusing to adopt divergent flat and canonical ultragoal brief for ${runId}.`);
    }
  }
  return {
    brief: existsSync(join(runDir, ULTRAGOAL_BRIEF))
      ? await readCanonicalRunFile(cwd, join(runDir, ULTRAGOAL_BRIEF))
      : (await readOptionalSafeRegularFile(
          cwd,
          ultragoalBriefPath(cwd),
          'active ultragoal projection',
        )) ?? '',
    ledger: existsSync(join(runDir, ULTRAGOAL_LEDGER))
      ? await selectLegacyLedgerProjection(cwd, runId)
      : await readLedger(cwd, ultragoalLedgerPath(cwd)),
  };
}

export async function createUltragoalPlan(cwd: string, options: CreateUltragoalOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  const briefHash = computeUltragoalBriefHash(options.brief);
  const disposition = await resolveRegistryDisposition(cwd, briefHash, options);
  if (disposition.adopt) {
    const adopted = await adoptExistingPlanForRun(
      cwd,
      disposition.adopt.plan,
      disposition.adopt.migratedStatuses,
      disposition.adopt.migratedBriefHash,
      options,
    );
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

  const runId = availableRunId(cwd, briefHash, options.now ?? new Date());
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

  const initialLedger = `${JSON.stringify({
    ts: now,
    event: 'plan_created',
    message: `${candidates.length} goal(s) created in run ${runId}`
      + (disposition.archivedTo ? `; archived previous registry to ${disposition.archivedTo}` : ''),
  })}\n`;
  await publishRunState(
    cwd,
    plan,
    options.brief.endsWith('\n') ? options.brief : `${options.brief}\n`,
    initialLedger,
    'create',
    disposition.archivedRunId,
  );
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
    const { plan: existing, migratedStatuses, migratedBriefHash } = loaded;
    const now = iso(options.now);
    const runId = existing.runId ?? legacyRunIdForPlan(existing);
    const origin: UltragoalRunOrigin = existing.origin ?? { worktreePath: cwd, createdAt: existing.createdAt };
    origin.adoptedWorktreePaths = Array.from(new Set([...(origin.adoptedWorktreePaths ?? []), cwd]));
    const base = await readAdoptionBase(cwd, runId);
    const adopted: UltragoalPlan = {
      ...existing,
      runId,
      briefHash: computeUltragoalBriefHash(base.brief),
      origin,
      updatedAt: now,
    };
    const entries: UltragoalLedgerEntry[] = [];
    if (migratedStatuses > 0) {
      entries.push({
        ts: now,
        event: 'plan_migrated',
        message: `Normalized ${migratedStatuses} legacy completed goal status${migratedStatuses === 1 ? '' : 'es'} to complete.`,
      });
    }
    if (migratedBriefHash) {
      entries.push({
        ts: now,
        event: 'plan_migrated',
        message: 'Expanded legacy truncated brief hash to full SHA-256.',
      });
    }
    entries.push({
      ts: now,
      event: 'plan_created',
      message: `run ${runId} adopted by worktree ${cwd} (origin ${origin.worktreePath})`,
    });
    await publishRunState(
      cwd,
      adopted,
      base.brief,
      entries.reduce((ledger, entry) => `${ledger}${JSON.stringify(entry)}\n`, base.ledger),
      'update',
      null,
    );
    return adopted;
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
  migratedBriefHash: boolean,
  options: CreateUltragoalOptions,
): Promise<UltragoalPlan> {
  const now = iso(options.now);
  const runId = existing.runId ?? legacyRunIdForPlan(existing);
  const origin: UltragoalRunOrigin = existing.origin ?? { worktreePath: cwd, createdAt: existing.createdAt };
  if (isInheritedOrigin(origin, cwd)) {
    origin.adoptedWorktreePaths = Array.from(new Set([...(origin.adoptedWorktreePaths ?? []), cwd]));
  }
  const base = await readAdoptionBase(cwd, runId);
  const adopted: UltragoalPlan = {
    ...existing,
    runId,
    briefHash: computeUltragoalBriefHash(base.brief),
    origin,
    updatedAt: now,
  };
  const entries: UltragoalLedgerEntry[] = [];
  if (migratedStatuses > 0) {
    entries.push({
      ts: now,
      event: 'plan_migrated',
      message: `Normalized ${migratedStatuses} legacy completed goal status${migratedStatuses === 1 ? '' : 'es'} to complete.`,
    });
  }
  if (migratedBriefHash) {
    entries.push({
      ts: now,
      event: 'plan_migrated',
      message: 'Expanded legacy truncated brief hash to full SHA-256.',
    });
  }
  entries.push({
    ts: now,
    event: 'plan_created',
    message: `adopted existing ultragoal registry as run ${runId} (${adopted.goals.length} goal(s))`,
  });
  await publishRunState(
    cwd,
    adopted,
    base.brief,
    entries.reduce((ledger, entry) => `${ledger}${JSON.stringify(entry)}\n`, base.ledger),
    'update',
    null,
  );
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
  const plan = await readUltragoalPlanUnlocked(cwd);
  const now = iso(options.now);
  const goal = appendGoalToPlan(plan, options);
  await publishPlanMutation(cwd, plan, [{
    ts: now,
    event: 'goal_added',
    goalId: goal.id,
    status: goal.status,
    evidence: options.evidence,
    message: goal.title,
  }]);
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
    const raw = await readSafeRegularFile(cwd, ultragoalLedgerPath(cwd), 'active ultragoal projection');
    return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as UltragoalLedgerEntry);
  } catch (error) {
    if (error instanceof UltragoalError) throw error;
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
  const plan = await readUltragoalPlanUnlocked(cwd);
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

  const entry: UltragoalLedgerEntry = {
    ts: now,
    event: invariant.accepted ? 'steering_accepted' : 'steering_rejected',
    goalId: proposalTargetIds(proposal)[0],
    evidence: proposal.evidence,
    message: proposal.rationale,
    steering: audit,
    mutationKind: proposal.kind,
    before: audit.before,
    after: audit.after,
  };
  if (invariant.accepted) await publishPlanMutation(cwd, plan, [entry]);
  else await appendLedger(cwd, entry, plan.runId);

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
  const briefInvariants = extractArchitectureInvariantsFromBrief(
    await readSafeRegularFile(cwd, ultragoalBriefPath(cwd), 'active ultragoal projection'),
  );
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
  const plan = await readUltragoalPlanUnlocked(cwd);
  const now = iso(options.now);
  if (plan.aggregateCompletion?.status === 'complete') return { plan, goal: null, resumed: false, done: true };
  const existing = plan.goals.find((goal) => goal.status === 'in_progress' && isScheduleEligibleGoal(goal));
  if (existing) {
    await appendLedger(
      cwd,
      { ts: now, event: 'goal_resumed', goalId: existing.id, status: existing.status, message: 'Resuming active ultragoal' },
      plan.runId,
    );
    return { plan, goal: existing, resumed: true, done: false };
  }

  let next = plan.goals.find((goal) => goal.status === 'pending' && isScheduleEligible(goal));
  const entries: UltragoalLedgerEntry[] = [];
  if (!next && options.retryFailed) {
    next = plan.goals.find((goal) => goal.status === 'failed' && !goal.nonRetriable && isScheduleEligible(goal));
    if (next) entries.push({ ts: now, event: 'goal_retried', goalId: next.id, status: 'pending', message: next.failureReason });
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
  entries.push({ ts: now, event: 'goal_started', goalId: next.id, status: next.status, message: `Attempt ${next.attempt}` });
  await publishPlanMutation(cwd, plan, entries);
  return { plan, goal: next, resumed: false, done: false };
  });
}

export async function checkpointUltragoal(cwd: string, options: CheckpointOptions): Promise<UltragoalPlan> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnlocked(cwd);
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
      await publishPlanMutation(cwd, plan, [{
        ts: now,
        event: 'goal_blocked',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        message: 'Codex get_goal was unavailable due to a DB/schema/context error; strict completion reconciliation is deferred until get_goal works.',
      }]);
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
    await publishPlanMutation(cwd, plan, [{
      ts: now,
      event: 'goal_blocked',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      message: safeCompletedAggregateBlocker
        ? 'Completed aggregate Codex goal is already terminal while the repo-native microgoal remains in progress; recorded a non-terminal safe-recovery blocker to avoid repeating an impossible checkpoint loop.'
        : undefined,
    }]);
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
    await publishPlanMutation(cwd, plan, [
      {
        ts: now,
        event: 'goal_completed',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        qualityGate,
        message: 'Active repo-native microgoal completed while reconciling a completed task-scoped aggregate Codex goal snapshot.',
      },
      {
        ts: now,
        event: 'aggregate_completed',
        goalId: goal.id,
        status: goal.status,
        evidence: options.evidence,
        codexGoal: options.codexGoal,
        qualityGate,
        message: 'Aggregate ultragoal plan completed via task-scoped Codex goal snapshot; checkpointed active microgoal row was reconciled to complete.',
      },
    ]);
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
  const blockerEvent = goal.status === 'needs_user_decision';
  const entries: UltragoalLedgerEntry[] = [{
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
  }];
  if (options.status === 'complete' && goal.resolvesReviewBlockedGoalId) {
    const resolvedParent = plan.goals.find((candidate) => candidate.id === goal.resolvesReviewBlockedGoalId);
    if (resolvedParent?.reviewBlockerResolution?.status === 'complete' && resolvedParent.reviewBlockerResolution.resolverGoalId === goal.id) {
      entries.push({
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
    entries.push({
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
  await publishPlanMutation(cwd, plan, entries);
  return plan;
  });
}

export async function recordFinalReviewBlockers(cwd: string, options: RecordFinalReviewBlockersOptions): Promise<{ plan: UltragoalPlan; blockedGoal: UltragoalItem; addedGoal: UltragoalItem }> {
  return withUltragoalMutationLock(cwd, async () => {
  const plan = await readUltragoalPlanUnlocked(cwd);
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
    await publishPlanMutation(cwd, plan, [{
      ts: now,
      event: 'goal_added',
      goalId: recaptureGoal.id,
      status: recaptureGoal.status,
      evidence: options.evidence,
      message: `Final review reported stale evidence against the repaired state; appended evidence re-capture story ${recaptureGoal.id} and left ${goal.id} in progress instead of a full review-block round-trip.`,
    }]);
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

  await publishPlanMutation(cwd, plan, [
    {
      ts: now,
      event: 'final_review_failed',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
      message: aggregateMode
        ? 'Final aggregate code-review was not clean; blocker story was appended while Codex goal remains active.'
        : 'Final per-story code-review was not clean; blocker story was appended and may require an available Codex goal context.',
    },
    {
      ts: now,
      event: 'goal_added',
      goalId: addedGoal.id,
      status: addedGoal.status,
      evidence: options.evidence,
      message: addedGoal.title,
    },
    {
      ts: now,
      event: 'goal_review_blocked',
      goalId: goal.id,
      status: goal.status,
      evidence: options.evidence,
      codexGoal: options.codexGoal,
    },
  ]);
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
  const objective = plan.codexObjective ?? aggregateCodexObjective(plan.goals);
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
