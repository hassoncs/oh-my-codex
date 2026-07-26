export interface WorkflowStateLockFaults {
  staleMs?: number;
  timeoutMs?: number;
  retryMs?: number;
  heartbeatMs?: number;
  processIsAlive?: (pid: number) => boolean;
  hook?: (
    stage: 'contended' | 'before-stale-rename' | 'after-stale-rename' | 'before-owner-write',
  ) => void | Promise<void>;
}

export interface WorkflowStateTransactionFaults {
  hook?: (
    stage: 'before-file-sync' | 'before-directory-sync' | 'before-journal-delete',
    path: string,
  ) => void | Promise<void>;
}

export type StateMutationCommitStage = 'detail-written' | 'clear-detail-written';

let lockFaults: WorkflowStateLockFaults = {};
let transactionFaults: WorkflowStateTransactionFaults = {};
let stateMutationCommitHook:
  ((stage: StateMutationCommitStage, mode: string) => void | Promise<void>)
  | null = null;
let skillActiveWriteHook: ((path: string) => void | Promise<void>) | null = null;

export function configureWorkflowStateLockFaults(
  faults: WorkflowStateLockFaults = {},
): void {
  lockFaults = faults;
}

export function configureWorkflowStateTransactionFaults(
  faults: WorkflowStateTransactionFaults = {},
): void {
  transactionFaults = faults;
}

export function configureStateMutationCommitHook(
  hook?: (stage: StateMutationCommitStage, mode: string) => void | Promise<void>,
): void {
  stateMutationCommitHook = hook ?? null;
}

export function configureSkillActiveWriteHook(
  hook?: (path: string) => void | Promise<void>,
): void {
  skillActiveWriteHook = hook ?? null;
}

export function getWorkflowStateLockFaults(): Readonly<WorkflowStateLockFaults> {
  return lockFaults;
}

export function getWorkflowStateTransactionFaults(): Readonly<WorkflowStateTransactionFaults> {
  return transactionFaults;
}

export function getStateMutationCommitHook():
  | ((stage: StateMutationCommitStage, mode: string) => void | Promise<void>)
  | null {
  return stateMutationCommitHook;
}

export function getSkillActiveWriteHook():
  | ((path: string) => void | Promise<void>)
  | null {
  return skillActiveWriteHook;
}
