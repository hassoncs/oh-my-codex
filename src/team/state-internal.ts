import { rename } from 'fs/promises';

let renameForAtomicWrite: typeof rename = rename;

export function renameAtomicForState(from: string, to: string): Promise<void> {
  return renameForAtomicWrite(from, to);
}

export function setWriteAtomicRenameForTests(fn: typeof rename): void {
  renameForAtomicWrite = fn;
}

export function resetWriteAtomicRenameForTests(): void {
  renameForAtomicWrite = rename;
}
