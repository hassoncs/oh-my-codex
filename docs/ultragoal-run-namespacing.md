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

Ledger appends use a private `.ledger-transaction.json` journal. The journal
records the active run, exact appended line, and before/after digests before
either ledger changes. The canonical run ledger appends first, then the flat
projection; every governed read or mutation recovers an interrupted append
idempotently before continuing. Recovery accepts only the recorded before or
after digest and valid newline-terminated JSONL, so it cannot guess through
unrelated or malformed divergence. Ledger updates write and sync complete next
bytes before atomic replacement; they never depend on recovering a torn
in-place append.

All mutations serialize on persistent `.mutation.guard` OS advisory locking:
macOS uses `lockf`, Linux uses `flock`, and Windows holds a `FileStream` opened
with `FileShare.None`. `.mutation.lock` remains atomic owner metadata for
compatibility and diagnosis; a same-directory hard link publishes it without
overwriting a legacy writer, and a token-bound candidate makes an interrupted
publication recoverable. macOS must invoke `lockf -k`; without `-k`, `lockf`
unlinks the guard on exit and concurrent writers can lock different inodes. It
records a random token, PID, creation time, and
process-start identity when the platform exposes one. Legacy PID-only owners
are reclaimed when the PID now belongs to a newer process, so PID reuse cannot
create an ABA admission race. A crashed process releases the OS guard
automatically. Malformed or unsafe guard/owner objects fail loud, and owner-token
verification still protects metadata cleanup. Windows provides process-lifetime
serialization but, because Node has no portable Windows directory-fsync
primitive, does not claim power-loss durability for directory entries. These
rules serialize cooperating OMX writers and reject pre-existing unsafe
filesystem objects; they are not a privilege boundary against an arbitrary
process already running as the same OS account.

Fresh namespaces use a second private `.run-transaction.json` journal. The
complete new run is first written outside `runs/`, then the journal binds its
brief, goals, ledger, pointer, preserved archive digests, and exact pre-state
digests for the canonical run, flat projection, and pointer. Only then is the
staged directory renamed into `runs/<runId>/` and projected onto the flat files.
Recovery accepts every object only in its recorded old state or exact new state;
unrelated canonical, projection, or pointer divergence stops recovery. Existing
canonical archive files are immutable: a complete new archive is staged and
renamed atomically, an identical partial legacy archive may be finished safely,
and different historical bytes fail instead of being overwritten. Archive,
stage, canonical, projection, pointer, and replacement-target reads bind
validation and reading to the same opened inode, rejecting symlinks,
non-regular files, files with multiple hard links, and replacement between
validation and open. Atomic replacement rechecks destination identity
immediately before rename and removes its temporary file on refusal. Existing
`runs/`, run-directory, and staged-run paths must be real directories, never
symlinks; recovery validates both canonical directory levels, and cleanup
refuses unsafe stage objects instead of silently removing them.
Staged files and atomic replacements are file-synced before publication. On
POSIX, directory renames, pointer updates, and journal removal are also
directory-synced before the transaction is retired. Existing-run adoption and
legacy migration use the same staged run transaction so goals, ledger audit,
pointer, and flat projections recover as one state. Ordinary goal mutations use
that transaction too: changed goals and their audit entries become one
recoverable canonical state before the flat projection advances. Ledger-only
observations keep the smaller ledger journal.

Explicit legacy adoption may repair the earlier bug shape where the flat ledger
contains valid historical lines followed by the shorter namespaced ledger. It
promotes that lossless superset into the canonical run once, preserves existing
file permissions, then resumes journaled appends with byte-identical ledgers.
Fresh namespace and archive operations reject any projection divergence; they
never treat an archive transition as permission to repair canonical history.

`runId` is `run-<UTC timestamp>-<first 8 of the brief hash>`. The stored brief
hash is the full 64-character SHA-256 of the whitespace-normalized brief; older
16-character prefixes migrate only after they match the current brief bytes.
The same brief re-entering the same tree therefore resumes its own run instead
of creating a second one.
An explicitly fresh namespace created in the same second uses the first free
numeric suffix (`-2`, `-3`, ...) so it cannot overwrite the archived run.

`omx status --json` reads transactions without recovering them. It inspects
journals before flat goals, so a first-create transaction is visible. A
structurally valid persistent journal reports a transaction in progress;
malformed JSON or an invalid journal shape reports
`invalid ultragoal transaction journal`. A journal that disappears during
inspection is retried as normal retirement, not mislabeled corruption. Stable
status also validates pointer authority and SHA-256 bindings across pointer,
canonical run, and flat projection without mutating them.

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

Whichever option is chosen, the existing flat registry is archived to
`runs/<runId>/` **before** the new run overwrites `goals.json`, `brief.md` and
the ledger. A pre-namespacing registry has no run directory behind those files,
so skipping that copy would destroy it.

Archived runs are a durable record, not browsable state: `active-run.json` moves
forward only, and every reader consumes the flat projection. To go back to an
archived run, copy its files into place and re-point the pointer deliberately.

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

A CoW clone inherits **untracked** runtime state; git delivers **tracked** state
on purpose. Repos that commit `.omx/ultragoal/goals.json` bake an absolute
`origin.worktreePath` into the commit, so every fresh worktree or clone of that
branch would read as inherited forever. A registry that `git ls-files` reports as
tracked is therefore treated as delivered, not inherited — `omx status --json`
still reports it as `origin.deliveredViaGit: true`.

Plans written before namespacing carry no `origin`, so they stay readable; the
first `create-goals` against them backfills a namespace or refuses per the table
above.

## Operating rule

Before dispatching a workflow into an existing tree, inspect `.omx/` first: read
`active-run.json` and `goals.json`, establish whose run it is, and pick
archive / adopt / new-namespace deliberately.
