# Local install provenance and the `omx update` revert hazard

`omx` is normally a global npm install of the published `oh-my-codex` package.
Fixes landed on this fork's `main` reach the running binary only after a local
install:

```bash
npm pack --pack-destination /tmp
npm install -g /tmp/oh-my-codex-<version>.tgz
```

Install the packed tarball, not the working tree. `npm install -g .` links the
global name straight at the source directory, so the runtime silently depends on
that checkout continuing to exist — fatal when the source is a disposable
worktree.

**The hazard:** a locally built install carries the same `version` string as the
published package, and both update paths overwrite it —

- `omx update --stable` installs `oh-my-codex@latest` from npm;
- `omx update --dev` installs upstream's `dev` branch.

Either one silently reverts a locally built fix, with no version change to make
the revert visible. After any `omx update`, confirm the fix is still present by
**feature probe rather than version** — for example:

```bash
omx ultragoal help | grep -q -- --new-namespace   # run-namespacing present?
omx status --json --cwd . | head -2               # supervision surface present?
```

If a probe fails, re-pack and re-install from this fork.
