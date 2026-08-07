#!/usr/bin/env bash
# Build this fork and install it as the global `omx`.
#
# `npm install -g .` is deliberately not used: it links the global `omx` name at
# whatever checkout it was run from, so a disposable worktree becomes the global
# install and disappears with the worktree. Packing first produces a real
# tarball that is installed independently of this directory.
#
# Idempotent: safe to re-run at any time, from any checkout of this repo.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

version="$(node -p 'require("./package.json").version')"
pkg_name="$(node -p 'require("./package.json").name')"

echo "[install-fork-build] building ${pkg_name}@${version} from ${repo_root}"
npm run build

pack_dir="$(mktemp -d)"
trap 'rm -rf "$pack_dir"' EXIT

echo "[install-fork-build] packing"
# npm pack's stdout filename is not reliable across npm versions and --silent
# levels, so locate the artifact in the (freshly created, single-use) pack dir.
npm pack --pack-destination "$pack_dir" >/dev/null
tarball="$(find "$pack_dir" -maxdepth 1 -name '*.tgz' -print -quit)"
[ -n "$tarball" ] && [ -f "$tarball" ] \
  || { echo "[install-fork-build] npm pack produced no tarball in $pack_dir" >&2; exit 1; }

echo "[install-fork-build] installing $tarball globally"
npm install -g "$tarball"

installed_root="$(npm root -g)/${pkg_name}"
installed_marker="$(node -p "require('${installed_root}/package.json').forkBuild || ''" 2>/dev/null || echo '')"
installed_version="$(node -p "require('${installed_root}/package.json').version" 2>/dev/null || echo 'unknown')"

if [ -z "$installed_marker" ]; then
  echo "[install-fork-build] FAILED: global install at $installed_root carries no forkBuild marker" >&2
  exit 1
fi

echo "[install-fork-build] installed ${pkg_name}@${installed_version} (forkBuild=${installed_marker})"
echo "[install-fork-build] \`omx update\` will now refuse to overwrite this build with upstream."
