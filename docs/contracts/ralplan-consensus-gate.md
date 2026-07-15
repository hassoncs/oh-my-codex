# Ralplan Consensus Gate Contract

The `ralplan -> ultragoal` transition requires durable Architect and Critic approval evidence from native subagent lanes. Advisory lanes such as Scholastic do not replace this gate.

## Required review artifact fields

Each review artifact used by the gate must include:

- `agent_role`: `architect` or `critic`
- `provenance_kind`: `native_subagent`
- `session_id`: the current transition session id, unless supplied by the transition context
- `thread_id`: the native subagent thread id for that review lane
- `completed_turn_id`: the native turn that completed this review
- `tracker_path`: `.omx/state/subagent-tracking.json`

The Architect and Critic reviews must approve in strict order and must refer to distinct native subagent threads. Equal timestamps or sequence values are not order proof.

## Required tracker schema

`.omx/state/subagent-tracking.json` must contain the session and both review threads:

```text
sessions["<current_session_id>"].threads["<architect_thread_id>"].kind = "subagent"
sessions["<current_session_id>"].threads["<critic_thread_id>"].kind = "subagent"
each thread role matches its review lane
each thread has thread_source = "subagent", parent_thread_id, and depth proving lineage to the current leader
each thread last_turn_id is absent or exactly matches last_completed_turn_id
each review completed_turn_id exactly matches its thread last_completed_turn_id
both threads have completed_at, with Critic strictly later than Architect
architect and critic thread IDs are distinct
```

The transition session is the explicit transition `sessionId` when available; otherwise it is resolved from the review artifact `session_id` fields.

When runtime and workspace tracker replicas both contain a review thread, the gate ranks current activity before validating role, lineage, order, or `completed_turn_id`. Rank uses the latest parseable `last_seen_at` or `completed_at`, then whether `last_turn_id` identifies a newer in-progress turn than `last_completed_turn_id`, then completion time. The expected runtime tracker wins exact ties. A newer active or incomplete replica blocks stale completed evidence; a workspace fallback is authoritative only when runtime evidence is absent, unreadable, or provably older.

## Failure diagnostics

Rejected transitions include a structured diagnostic object on `RalplanConsensusGateEvidence.diagnostic` and a rendered error with:

- expected tracker schema,
- current session id used for lookup,
- Architect/Critic thread ids,
- whether the tracker session exists,
- whether each thread exists,
- each thread `kind`,
- whether each thread has `completed_at`,
- review `completed_turn_id` and tracker `last_completed_turn_id`,
- whether thread ids are distinct,
- remediation steps,
- this docs path.

## Remediation

Re-run native ralplan Architect/Critic reviews, or repair the review artifacts so `agent_role`, `provenance_kind`, `session_id`, `thread_id`, `completed_turn_id`, and `tracker_path` point to the current completed native subagent turns.
