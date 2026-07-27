# Team startup dispatch latency contract

Date: 2026-04-30

Closure update: 2026-07-27

Review lane: worker-3

## Scope

This note documents the review contract for the team startup assignment-delay
fix described by `.omx/plans/ralplan-team-worker-assignment-delay-20260430T110158Z.md`.
It focuses on the startup window after tmux worker panes are created and before
workers receive their first inbox trigger.

The issue is not task allocation: tasks, worker identity, and worker inbox files
are already durable before startup notification attempts begin. The latency risk
sits in the readiness, dispatch, and startup-evidence gates that currently sit
between pane creation and the first trigger.

## Current startup path under review

1. `src/team/tmux-session.ts:createTeamSession()` splits leader/worker panes and
   returns concrete `workerPaneIds`.
2. `src/team/runtime.ts:startTeam()` writes every worker identity and inbox file,
   saves team config, then fans out `runWorkerStartupAttempt()` for each worker.
3. Interactive workers without an `initialPrompt` call
   `waitForWorkerReadyAsync()` before `dispatchCriticalInboxInstruction()`.
4. The default dispatch policy uses `hook_preferred_with_fallback`, so startup
   inbox dispatch is first queued for the notify hook and then waits for a
   receipt before falling back to direct tmux send.
5. A transport success is provisional. Codex and Claude workers must emit
   startup evidence after the hook/direct fallback path before startup settles.
6. All worker attempts settle before `startTeam()` reports the lowest-index
   failure, so one missing-evidence worker cannot prevent sibling notification.

## Latency phases that must be instrumented

The startup timing log should use monotonic timing deltas and include at least
these phase markers for each worker:

| Marker | Meaning |
|---|---|
| `pane_id_captured` | `createTeamSession()` returned the worker pane id. |
| `identity_inbox_written` | worker identity and inbox state were written. |
| `ready_wait_start` | interactive readiness polling began. |
| `ready_wait_end` | readiness polling returned ready, timed out, or hit a prompt guard. |
| `dispatch_queued` | startup inbox dispatch request was persisted. |
| `hook_receipt` | hook-preferred path observed `notified`, `delivered`, `failed`, or timeout. |
| `direct_trigger_attempt` | direct tmux trigger injection was attempted. |
| `direct_trigger_result` | direct injection result was recorded. |
| `receiver_ready_and_notified` | receiver showed a ready prompt and transport notification succeeded; this does not prove task consumption. |
| `startup_evidence` | task-consumption evidence (`task_claim`, `worker_progress`, qualifying `leader_ack`, `none`) was observed. |

A useful operator-facing summary is the per-worker delta from
`pane_id_captured` to first trigger attempt, plus whether the final startup
settlement came from hook delivery, direct fallback, or asynchronous evidence.

## Fast-path safety contract

A startup-only direct-trigger path is acceptable only when all of the following
conditions hold:

- It runs only for the first worker inbox trigger during team startup.
- Durable assignment state is already written: task JSON, identity JSON, inbox,
  manifest/config pane id, and dispatch request metadata.
- It does not replace or bypass mailbox dispatch for follow-up worker messages.
- It does not send through visible Codex trust prompts.
- It does not send through visible Claude bypass-permissions prompts unless the
  existing explicit auto-accept path has handled the prompt first.
- It does not mark hook delivery as successful merely because a direct trigger
  was attempted.
- A ready prompt or writable prompt-worker stdin proves only receiver readiness.
  Neither can settle Codex or Claude startup without subsequent startup
  evidence.
- Missing startup evidence fails startup after fallback, even when the worker is
  still alive. Sibling startup attempts must still settle first.
- Failure after mode admission tears down prompt workers, records failed startup
  state, and preserves changed worker worktrees. Detached work receives a
  salvage ref before any cleanup can remove it.

## Review checklist

Use this checklist when reviewing the implementation:

- [ ] Startup timing instrumentation records all phase markers above without
      making evidence confirmation delay the first safe trigger.
- [ ] The direct-trigger fast path is startup-only and cannot be reached by
      general mailbox or follow-up dispatch.
- [ ] Trust and bypass prompt guards reuse the same pane-capture safety semantics
      as `waitForWorkerReadyAsync()` / notify-hook dispatch.
- [ ] Dispatch request state remains authoritative for `pending`, `notified`,
      `delivered`, and `failed`; timing logs are supporting evidence only.
- [ ] Existing `hook_preferred_with_fallback` mailbox behavior is unchanged for
      non-startup messages.
- [ ] Prompt-worker stdin notification remains transport-only; Codex and Claude
      require startup evidence after fallback.
- [ ] Failed admitted startup preserves worker edits and tears down started
      prompt workers.
- [ ] Tests isolate readiness latency, hook receipt/evidence latency, and the
      startup fast path separately so failures identify the phase that regressed.

## Regression tests expected

Focused coverage should include:

1. A runtime test proving a slow `waitForWorkerReadyAsync()` used to delay first
   startup dispatch up to the configured ready timeout.
2. A runtime test proving hook-preferred startup dispatch no longer waits for
   startup evidence before attempting the first safe trigger.
3. A tmux/session or notify-hook guard test proving no startup direct trigger is
   sent through visible trust or bypass prompts.
4. A mailbox regression test proving ordinary mailbox dispatch still uses the
   existing hook-preferred/fallback behavior outside startup.
5. A multi-worker startup test proving worker-1 evidence delay does not block
   worker-2 from receiving a first trigger.
6. A prompt-worker test proving writable stdin without startup evidence rejects
   startup with a typed `*_startup_no_evidence_after_fallback` reason.
7. A failed-startup test proving tracked and untracked worker edits survive in
   the retained worktree and salvage ref while prompt workers are terminated.

## Known review risks

- `waitForWorkerReadyAsync()` currently contains useful prompt-handling safety.
  Moving a trigger earlier must preserve its prompt guards rather than deleting
  them from the startup story.
- Notify-hook post-injection verification intentionally refuses to confirm worker
  dispatch while a pane is not ready. The startup fast path may attempt an early
  trigger, but it must keep confirmation and evidence semantics separate.
- Startup evidence differs by worker CLI: Codex ACK-only messages are not enough
  to settle startup, while Claude leader ACK can be evidence. Reviewers should
  keep this distinction when interpreting timing logs.
- Worktree cleanup must compare against the persisted provisioning base ref, not
  current leader HEAD. Otherwise concurrent leader commits can make an unchanged
  detached worker look dirty or hide worker advancement.
