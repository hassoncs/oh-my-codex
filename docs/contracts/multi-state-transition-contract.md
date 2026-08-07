# Multi-state transition compatibility contract

This document defines the peer workflow state model: which tracked workflows may
be active at the same time, and what a refusal owes the caller.

## Canonical sources of truth

The runtime must treat workflow state as a combination of:

- mode state files under `.omx/state/{scope}/<mode>-state.json`
- canonical workflow enumeration under `.omx/state/{scope}/skill-active-state.json`

`skill-active-state.json` is the canonical active-set inventory. Legacy top-level
fields such as `skill` or `phase` may remain as compatibility metadata, but they
must not override the authoritative active set when multiple workflow members
are live.

## Declared compatibility

Legal coexistence is **declared per mode**, not enumerated as a pair list. A
hand-maintained pair list silently omits every mode added after it was written,
which is how `ultragoal` — a supervised child phase of `autopilot` and the
documented host for nested `team` work — ended up unable to coexist with either.

`src/state/workflow-transition.ts` holds two declarations:

- `UNIVERSAL_OVERLAP_MODES` — modes that add behaviour to whatever run is
  already in progress rather than owning it. Currently `ultrawork`.
- `WORKFLOW_MODE_HOSTED_MODES` — each supervising mode lists the modes it may
  host while it stays active. Declaring `host: [child]` legalises the
  combination in **either** activation order.

Current declarations:

| Host | Hosted modes | Source of the declaration |
| --- | --- | --- |
| `autopilot` | `deep-interview`, `ralplan`, `ultragoal`, `team`, `ralph`, `ultraqa` | derived from `AUTOPILOT_CHILD_PHASES` in `src/autopilot/fsm.ts` |
| `ultragoal` | `team` | a story's parallel execution lanes; the goal ledger stays leader-owned |
| `ralph` | `team` | the original approved pair |

Deriving autopilot's row from its own FSM is deliberate: a new autopilot child
phase becomes a legal overlap automatically, so the omission class that produced
this contract's previous revision cannot recur.

The resulting active set is peer state. Neither member is semantically primary
just because it was activated first or happens to occupy the legacy top-level
`skill` field.

## Standalone-only workflows

`autoresearch` is the only tracked workflow that stays standalone. It is not a
child phase of any supervisor and hosts nothing, so every overlap attempt except
`ultrawork` is denied.

A denied overlap must preserve the current state unchanged.

## Preconditions beyond the compatibility table

A legal overlap may still carry a runtime precondition. `team` under an active
`autopilot` is legal, but only from a phase that owns story work: the check in
`assertWorkflowTransitionContextAllowed` requires autopilot's `current_phase` to
be `ultragoal` or `team`, and requires a valid leader-owned ultragoal context.
That precondition is unconditional — it does not depend on a caller passing an
opt-in flag — and its failure message must name the command that resolves it.

## Transition rules

A canonical transition helper should answer three questions for every writer or
consumer that mutates workflow state:

1. Is the requested transition allowed from the current active set?
2. What is the resulting active set if it is allowed?
3. What operator guidance should be shown if it is denied?

Until a combination is explicitly approved, the default rule is deny-without-
mutation.

## Invalid transition UX

Every denied transition must:

1. keep the current active state unchanged
2. name the denied combination explicitly
3. **name the blocking modes and emit a runnable command per blocking mode** —
   a denial that prints a `"mode":"<mode>"` placeholder leaves the caller stuck
   and is treated as a defect, not as guidance
4. mention both supported clearing surfaces:
   - `omx state ...`
   - `omx_state.*` MCP tools

`findBlockingWorkflowModes(currentModes, requestedMode)` computes exactly the
set that blocks a transition — modes that neither auto-complete into the
request nor declare compatibility with it. Guidance is built from that set, so
modes that would have auto-completed or coexisted are never named as blockers.

Example operator guidance shape:

> Cannot start `team`: `autoresearch` is already active. Unsupported workflow
> overlap: `autoresearch + team`. To proceed, finish that workflow or clear it
> yourself: `omx state clear --input '{"mode":"autoresearch"}' --json`

### Operator recovery examples

CLI parity surface:

- `omx state clear --input '{"mode":"team"}' --json`
- `omx state clear --input '{"mode":"ralph","all_sessions":true}' --json`

MCP parity surface:

- `omx_state.state_clear({ mode: "team" })`
- `omx_state.state_clear({ mode: "ralph", all_sessions: true })`

## Brownfield consumer expectations

The following surfaces must consume the same transition semantics instead of
re-inventing their own precedence rules:

- `src/state/skill-active.ts` — canonical active-set persistence/sync
- `src/hooks/keyword-detector.ts` — keyword-triggered activation should add or
  deny according to the allowlist instead of overwriting to a single owner
- `src/modes/base.ts` — mode start validation must defer to the same transition
  rules and emit the same operator guidance
- `src/mcp/state-server.ts` — state writes/clears must preserve combined state
  correctly and remove only the cleared member
- `src/hud/state.ts` — HUD rendering must show approved combined states even
  when legacy top-level metadata is non-authoritative
- `src/hooks/agents-overlay.ts` — AGENTS overlay active-mode reporting must list
  every active approved member
- `src/scripts/codex-native-hook.ts` — Stop/continuation logic must respect the
  combined state and stop blocking when the relevant member is cleared

## Scope behavior

Session-scoped state remains authoritative when present. Root scope remains a
compatibility fallback only. Clearing one member of an approved combined set
must not accidentally delete the entire combined state.

## Regression expectations

Implementation should be considered complete only when tests prove:

1. canonical active state can hold a multi-entry active set
2. `team + ralph` is allowed in both activation orders
3. `team + ultrawork` is allowed in both activation orders
4. `team + ultragoal` is allowed in both activation orders, and the
   `autopilot + ultragoal + team` triple is allowed
5. every mode in `AUTOPILOT_CHILD_PHASES` coexists with `autopilot`
6. unsupported overlaps deny without mutation
7. denial messages name each blocking mode, emit a runnable `omx state clear`
   per blocking mode, never emit the `"mode":"<mode>"` placeholder, and mention
   both `omx state` and `omx_state.*`
8. HUD / overlay / stop-hook consumers honor the combined set consistently
9. `autoresearch` still rejects every overlap attempt except `ultrawork`;
   Autopilot review-driven planning loopbacks keep `autopilot` active and update
   its `current_phase` to `ralplan` while a supervised `ralplan` write leaves the
   supervisor state untouched (no auto-complete)
10. `deep-interview -> ralplan` is evidence-gated: answered or handoff-cleared question obligations alone do not complete deep-interview, and Autopilot ralplan handoff requires tracker-backed native Architect and Critic lane evidence rather than `codex_exec`/artifact-only approvals
