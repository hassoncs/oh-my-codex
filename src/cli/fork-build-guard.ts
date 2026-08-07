/**
 * Guards a locally built fork against being silently replaced by an upstream
 * release.
 *
 * The globally installed `omx` on a fork-maintaining machine is a local build of
 * this repository, not the published npm package. `omx update` installs from
 * upstream (`oh-my-codex@latest`, or `github:Yeachan-Heo/oh-my-codex#dev`),
 * which overwrites that build and reverts every fork-local change with no
 * warning and no trace: the version string is identical, so nothing afterwards
 * looks wrong. The only place this can be caught is here, before the overwrite.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { getPackageRoot } from '../utils/package.js';

export const FORK_BUILD_MARKER_ENV = 'OMX_FORK_BUILD';
export const ALLOW_UPSTREAM_OVERWRITE_ENV = 'OMX_ALLOW_UPSTREAM_OVERWRITE';

/** Manifest field a fork sets to identify builds made from its own source. */
export const FORK_BUILD_MANIFEST_FIELD = 'forkBuild';

/**
 * Read the fork identity baked into the running install's manifest. Returns an
 * empty string for an unmodified upstream install, which disables the guard.
 */
export function readForkBuildMarker(packageRoot: string = getPackageRoot()): string {
  try {
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) return '';
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    const marker = manifest[FORK_BUILD_MANIFEST_FIELD];
    return typeof marker === 'string' ? marker.trim() : '';
  } catch {
    return '';
  }
}

export interface ForkBuildGuardInput {
  /** Install source the update is about to run. */
  installSource: string;
  /** Marker recorded into the package manifest at fork build time. */
  forkBuildMarker?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ForkBuildGuardDecision {
  allowed: boolean;
  reason?: string;
}

function isUpstreamInstallSource(installSource: string): boolean {
  const normalized = installSource.trim().toLowerCase();
  if (!normalized) return false;
  // Anything that resolves through the public package name or the upstream
  // repository replaces a fork build.
  return normalized.includes('oh-my-codex@')
    || normalized.startsWith('oh-my-codex')
    || normalized.includes('yeachan-heo/oh-my-codex');
}

export function buildForkOverwriteWarning(forkBuildMarker: string, installSource: string): string {
  return [
    `[omx] Refusing to update: this install is a local build of the ${forkBuildMarker} fork.`,
    `[omx] Installing \`${installSource}\` would overwrite it with upstream code and silently revert every fork-local change.`,
    '[omx] The version string would not change, so the revert would leave no visible trace.',
    '[omx] To rebuild and reinstall the fork:  scripts/install-fork-build.sh',
    `[omx] To overwrite the fork build anyway: ${ALLOW_UPSTREAM_OVERWRITE_ENV}=1 omx update ...`,
  ].join('\n');
}

/**
 * Decide whether an update may proceed. Fork builds refuse upstream install
 * sources unless the operator explicitly opts in.
 */
export function evaluateForkBuildGuard(input: ForkBuildGuardInput): ForkBuildGuardDecision {
  const env = input.env ?? process.env;
  const marker = (
    input.forkBuildMarker
    ?? env[FORK_BUILD_MARKER_ENV]
    ?? readForkBuildMarker()
  ).trim();
  if (!marker) return { allowed: true };
  if (!isUpstreamInstallSource(input.installSource)) return { allowed: true };
  if ((env[ALLOW_UPSTREAM_OVERWRITE_ENV] ?? '').trim() === '1') {
    return { allowed: true, reason: `${ALLOW_UPSTREAM_OVERWRITE_ENV}=1` };
  }
  return {
    allowed: false,
    reason: buildForkOverwriteWarning(marker, input.installSource),
  };
}
