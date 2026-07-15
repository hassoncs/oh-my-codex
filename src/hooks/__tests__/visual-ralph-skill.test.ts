import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(__dirname, '../../../skills/visual-ralph/SKILL.md'), 'utf-8');

describe('visual-ralph skill contract', () => {
  it('defines the image approval to Ralph workflow', () => {
    assert.match(skill, /^---\nname: visual-ralph/m);
    assert.match(skill, /description:\s*"Visual Ralph orchestration/i);
    assert.match(skill, /description:.*live URL targets/i);
    assert.match(skill, /\$imagegen/);
    assert.match(skill, /explicit user approval|explicit user confirmation/i);
    assert.match(skill, /\$ralph/);
    assert.match(skill, /built-in visual verdict|Visual Ralph verdict/i);
  });

  it('owns the migrated live URL cloning use case', () => {
    assert.match(skill, /live URL/i);
    assert.match(skill, /live URL.*visual implementation or clone/i);
    assert.match(skill, /source URL and permission\/scope note/i);
    assert.match(skill, /Interaction parity notes/i);
    assert.match(skill, /migrated `\$web-clone` use case/i);
    assert.match(skill, /Do not route new URL-driven website cloning work to `\$web-clone`/i);
    assert.doesNotMatch(skill, /The reference is a live URL; use `\$web-clone`/i);
  });

  it('keeps the built-in visual verdict authoritative and pixel diff secondary', () => {
    assert.match(skill, /score\s*>?=\s*90|90\+/i);
    assert.match(skill, /verdict.*explicitly passes/i);
    assert.match(skill, /category_match.*true/i);
    assert.match(skill, /pixel diff|pixelmatch/i);
    assert.match(skill, /does not replace the Visual Ralph verdict|secondary debug evidence/i);
  });

  it('requires reproducibility and repo-native design system artifacts', () => {
    assert.match(skill, /screenshot reproduction command|viewport|output paths/i);
    assert.match(skill, /repo-native reusable artifacts|repo-native and reusable/i);
    for (const token of ['colors', 'spacing', 'typography', 'radii', 'shadows']) {
      assert.match(skill, new RegExp(token, 'i'));
    }
  });

  it('forbids hardcoded stack assumptions and unapproved pivots', () => {
    assert.match(skill, /Do not hardcode React, Vue, Tailwind/i);
    assert.match(skill, /Major design pivots.*explicit user request|Do not make major design pivots unless explicitly requested/i);
  });

  it('requires repair, fresh re-review, derived closure, and regression evidence', () => {
    assert.match(skill, /Preserve generic findings through repair and re-review/i);
    assert.match(skill, /repair assertion; do not mark the finding closed/i);
    assert.match(skill, /fresh matching screenshot.*rerun the required evaluator/i);
    assert.match(skill, /derive `verified-resolved` only from matching pass evidence/i);
    assert.match(skill, /derive `regressed`/i);
    assert.match(skill, /score, source edit, screenshot, or human statement alone cannot claim generic verified closure/i);
    assert.match(skill, /non-empty result schema\/version/i);
    assert.match(skill, /stable target-partition\/census identity plus hash/i);
    assert.match(skill, /canonical target identity plus hash/i);
    assert.match(skill, /reference\/current\/diff artifact hashes/i);
    assert.match(skill, /partition pass, skipped, and error outcomes explicitly/i);
    assert.match(skill, /runtime `passes_threshold` field follows the same composite gate/i);
    assert.match(skill, /score-only threshold flag cannot satisfy/i);
  });

  it('fails closed across proof and data boundaries', () => {
    assert.match(skill, /Zero targets, all-skipped runs, capture errors.*blocked\/`unknown`/i);
    assert.match(skill, /Visual, source, behavioral, and certification proof remain separate/i);
    assert.match(skill, /proof envelope.*does not create or repair missing underlying evidence/i);
    assert.match(skill, /Never transmit private product source.*external evaluator/i);
    assert.match(skill, /no permitted evaluator exists.*blocked\/`unknown`/i);
    assert.match(skill, /Treat image generation as an external data boundary/i);
    assert.match(skill, /never include private repository source, secrets, authenticated screenshots/i);
  });
});
