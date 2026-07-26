# Supervision status surface

## The failure this prevents

Supervisors watching an OMX lane had no machine-readable status, so they fell
back to `tmux capture-pane` scraping. Pane scraping re-matches scrollback on
every poll and floods monitors with duplicate events — while the truth sat on
disk the whole time in `.omx/ultragoal/goals.json`, `.omx/ultragoal/ledger.jsonl`
and `.omx/state/*.json`.

`omx status` accepted `--json` and silently ignored it.

## Contract

```bash
omx status --json [--cwd <path>] [--all-modes]
```

Emits one document, schema `omx.supervision.status.v1`. `--cwd` makes it readable
from **outside** the session, by path — no attach, no pane, no scraping.

| field | meaning |
| --- | --- |
| `worktreePath`, `omxPresent` | which tree was read, and whether it has `.omx/` |
| `phase` | current run phase (`run-state.json`, falling back to the active mode) |
| `modes[]` | active `*-state.json`, base and session-scoped: mode, active, phase, sessionId, path. `--all-modes` adds every historical session — a long-lived tree holds hundreds, and a polling supervisor should not pay ~150KB a tick for them |
| `ultragoal.runId`, `.briefHash` | the active run namespace |
| `ultragoal.origin` | creating worktree, and `inherited: true` for a registry that belongs to another tree |
| `ultragoal.counts`, `.goals[]` | per-goal status |
| `ultragoal.lastCheckpoint` | last goal-status ledger event |
| `ultragoal.lastLedgerEntry` | last ledger event of any kind |
| `ultragoal.paths` | goals / ledger / active-run / run directory, absolute |
| `teams[]` | team name, active, phase, task, agent count, worker worktrees |

Failure states are reported, never thrown: a malformed registry yields
`ultragoal.error`, a tree with no `.omx/` yields `omxPresent: false` and empty
collections, and an inherited registry is flagged rather than refused.

## Rule

Supervise OMX lanes through this surface and the state files it points at. Do not
scrape panes.
