# Dist Lock Recovery

Build and test processes use PID plus process-start identity as ownership
authority. Darwin identity reads use three bounded `/bin/ps` attempts.

Recovery follows these rules:

- dead PID or process group: stale authority may be removed
- observed identity mismatch: PID reuse; stale authority may be removed
- live PID or process group with exhausted identity observation: preserve
  authority and emit `dist_process_identity_observation_unavailable`
- missing identity during lock or child creation: fail loud; do not publish
  authority

The diagnostic is emitted as one JSON object on stderr, once per
lock/PID/scope key within a bounded cache. Callers that need structured
handling can pass `onDiagnostic` to `isOwnedLockActive` or
`isOwnedChildLeaseActive`.
