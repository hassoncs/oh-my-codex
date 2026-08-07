import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOW_UPSTREAM_OVERWRITE_ENV,
  evaluateForkBuildGuard,
  readForkBuildMarker,
} from '../fork-build-guard.js';

const FORK = 'ch5/oh-my-codex';

describe('fork build guard', () => {
  it('refuses upstream install sources on a fork build', () => {
    for (const installSource of [
      'oh-my-codex@latest',
      'oh-my-codex',
      'github:Yeachan-Heo/oh-my-codex#dev',
    ]) {
      const decision = evaluateForkBuildGuard({
        installSource,
        forkBuildMarker: FORK,
        env: {},
      });
      assert.equal(decision.allowed, false, installSource);
      assert.match(String(decision.reason), /local build of the ch5\/oh-my-codex fork/);
      assert.match(String(decision.reason), /scripts\/install-fork-build\.sh/);
      assert.match(String(decision.reason), new RegExp(ALLOW_UPSTREAM_OVERWRITE_ENV));
    }
  });

  it('allows an explicit operator override', () => {
    const decision = evaluateForkBuildGuard({
      installSource: 'oh-my-codex@latest',
      forkBuildMarker: FORK,
      env: { [ALLOW_UPSTREAM_OVERWRITE_ENV]: '1' },
    });
    assert.equal(decision.allowed, true);
  });

  it('does not interfere with an unmodified upstream install', () => {
    const decision = evaluateForkBuildGuard({
      installSource: 'oh-my-codex@latest',
      forkBuildMarker: '',
      env: {},
    });
    assert.equal(decision.allowed, true);
  });

  it('leaves non-upstream install sources alone', () => {
    const decision = evaluateForkBuildGuard({
      installSource: '/tmp/oh-my-codex-0.20.1.tgz',
      forkBuildMarker: FORK,
      env: {},
    });
    assert.equal(decision.allowed, true);
  });

  it('reads the fork marker this repository bakes into its manifest', () => {
    assert.equal(readForkBuildMarker(), FORK);
  });
});
