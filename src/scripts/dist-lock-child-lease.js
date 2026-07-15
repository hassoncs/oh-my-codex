import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isProcessAlive,
  processGroupMembers,
  registerOwnedChildLeaseSentinel,
} from './dist-lock.js';

const leasePath = process.env.OMX_DIST_CHILD_LEASE?.trim();
const token = process.env.OMX_DIST_CHILD_LEASE_TOKEN?.trim();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

if (process.env.OMX_DIST_CHILD_LEASE_SENTINEL === '1') {
  const leaderPid = Number(process.env.OMX_DIST_CHILD_LEADER_PID);
  const processGroupId = Number(process.env.OMX_DIST_CHILD_PROCESS_GROUP_ID);
  if (!Number.isInteger(leaderPid) || leaderPid <= 0 || !Number.isInteger(processGroupId) || processGroupId <= 0) {
    throw new Error('dist_child_sentinel_identity_missing');
  }
  while (isProcessAlive(leaderPid)) Atomics.wait(waitBuffer, 0, 0, 50);
  while (true) {
    const members = processGroupMembers(processGroupId);
    if (members && members.every((pid) => pid === process.pid)) break;
    Atomics.wait(waitBuffer, 0, 0, 100);
  }
  process.exit(0);
}

if (!leasePath || !token) throw new Error('dist_child_lease_missing');
const deadline = Date.now() + 60_000;
while (true) {
  try {
    const current = JSON.parse(readFileSync(leasePath, 'utf-8'));
    if (current?.token === token && Number.isInteger(current.pid) && current.pid > 0) break;
  } catch {
    // Parent may be activating the pre-created lease.
  }
  if (Date.now() >= deadline) throw new Error('dist_child_lease_activation_timeout');
  Atomics.wait(waitBuffer, 0, 0, 5);
}

const current = JSON.parse(readFileSync(leasePath, 'utf-8'));
const processGroupId = Number(current.process_group_id);
if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
  throw new Error('dist_child_process_group_missing');
}
const sentinel = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
  stdio: 'ignore',
  env: {
    ...process.env,
    OMX_DIST_CHILD_LEASE_SENTINEL: '1',
    OMX_DIST_CHILD_LEADER_PID: String(process.pid),
    OMX_DIST_CHILD_PROCESS_GROUP_ID: String(processGroupId),
  },
});
if (!sentinel.pid) throw new Error('dist_child_sentinel_pid_missing');
try {
  registerOwnedChildLeaseSentinel(leasePath, token, sentinel.pid);
} catch (error) {
  sentinel.kill('SIGKILL');
  throw error;
}
sentinel.unref();

delete process.env.OMX_DIST_CHILD_LEASE;
delete process.env.OMX_DIST_CHILD_LEASE_TOKEN;
delete process.env.OMX_DIST_CHILD_LEASE_SENTINEL;
delete process.env.OMX_DIST_CHILD_LEADER_PID;
delete process.env.OMX_DIST_CHILD_PROCESS_GROUP_ID;
