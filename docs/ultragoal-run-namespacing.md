# Ultragoal run namespacing

## The failure this prevents

A `$ralplan`/`$ultragoal` run dispatched into a worktree that already held an
older `.omx/ultragoal/` registry was silently captured by it. Checkpoints failed
with "completed legacy Codex goal blocks this ultragoal story", shutdown gates
counted the *legacy* registry's pending goals, and after roughly eleven hours the
lane began executing legacy stories instead of its own contract.

The registry was tree-global (`.omx/ultragoal/goals.json`) and carried no
identity, so nothing could tell "my run" from "somebody else's run".

## Layout

```
.omx/ultragoal/
  runs/<runId>/brief.md            canonical, namespaced per run
  runs/<runId>/goals.json
  runs/<runId>/ledger.jsonl
  active-run.json                  pointer: which run is active here
  brief.md                         active-run projection
  goals.json                       active-run projection
  ledger.jsonl                     active-run projection
```

The run directory is canonical. The flat files remain the **active-run
projection** so every existing reader (HUD, shutdown gates, `omx state`) keeps
working unchanged; they are written by the same writer, in the same operation,
never independently.

`runId` is `run-<UTC timestamp>-<first 8 of the brief hash>`. The brief hash is a
SHA-256 of the whitespace-normalized brief, so the same brief re-entering the
same tree resumes its own run instead of creating a second one.

## Identity and refusal

Every plan records `runId`, `briefHash`, and `origin.worktreePath`.

`omx ultragoal create-goals` refuses, rather than capturing an existing registry,
when any of these hold:

| reason | meaning |
| --- | --- |
| `brief_mismatch` | the registry was created from a different brief |
| `unnamespaced_legacy_registry` | a pre-namespacing `goals.json` occupies the tree |
| `inherited_worktree` | the registry's origin worktree is not this tree |

The refusal names three explicit choices:

- `--archive-existing` — copy the existing registry to `runs/<runId>/` and start
  a fresh namespace. Nothing is destroyed. (`--force` is kept as an alias.)
- `--adopt-existing` — continue the existing registry as this run.
- `--new-namespace` — start fresh, leaving the existing run registered but
  inactive.

## Grove CoW clones

A Grove Tree is CoW-cloned from its source, so it inherits the source's `.omx/`
directory — including an "active" registry that does not belong to it. Because
the plan records the worktree that created it, an inherited registry is:

- never read implicitly — `readUltragoalPlan` raises `inherited_worktree`;
- never counted by the HUD, so it cannot gate a shutdown in the clone;
- reported (not hidden) by `omx status --json`, as
  `ultragoal.origin.inherited: true`.

`omx ultragoal adopt-run` takes ownership explicitly and records this worktree in
`origin.adoptedWorktreePaths`.

Plans written before namespacing carry no `origin`, so they stay readable; the
first `create-goals` against them backfills a namespace or refuses per the table
above.

## Operating rule

Before dispatching a workflow into an existing tree, inspect `.omx/` first: read
`active-run.json` and `goals.json`, establish whose run it is, and pick
archive / adopt / new-namespace deliberately.
