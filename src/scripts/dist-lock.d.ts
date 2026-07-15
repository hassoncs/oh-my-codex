export interface DistLockConfig {
  lockRoot: string;
  buildLock: string;
  readerPrefix: string;
  timeoutMs: number;
}

export function parsePositiveMs(value: string | undefined, fallback: number): number;
export function resolveDistLockConfig(cwd: string, env?: NodeJS.ProcessEnv): DistLockConfig;
export function isProcessAlive(pid: number): boolean;
export function isProcessGroupAlive(processGroupId: number): boolean;
export function processGroupMembers(processGroupId: number): number[] | null;
export function assertDistProcessTreeAuthority(platform?: NodeJS.Platform, processStartIdentity?: string | null): void;
export function ownedChildLeasePath(lockPath: string, token: string): string;
export function prepareOwnedChildLease(lockPath: string, token: string): string;
export function activateOwnedChildLease(
  lockPath: string,
  token: string,
  pid: number,
  processGroupId?: number,
  observeProcessStartIdentity?: (pid: number) => string | null,
): string;
export function registerOwnedChildLeaseSentinel(leasePath: string, token: string, pid: number): void;
export function releaseOwnedChildLease(lockPath: string, token: string): void;
export function isOwnedChildLeaseActive(lockPath: string, token: string, unownedStaleMs?: number): boolean;
export function isOwnedLockActive(lockPath: string, unownedStaleMs?: number): boolean;
export function tryCreateOwnedLock(lockPath: string, owner: Record<string, unknown>): boolean;
export function releaseOwnedLock(lockPath: string, token: string): boolean;
export function recoverStaleOwnedLock(lockPath: string, unownedStaleMs?: number): boolean;
