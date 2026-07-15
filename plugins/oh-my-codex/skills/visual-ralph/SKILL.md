---
name: visual-ralph
description: "Visual Ralph orchestration for frontend UI from generated references, static references, or live URL targets, using $ralph with built-in visual verdict and pixel-diff evidence until the implementation matches and leaves a reproducible design system."
---

# Visual Ralph Skill

Use this skill when the user wants Codex to build or restyle frontend UI through a Visual Ralph loop: an approved generated reference, static reference, or live URL-derived baseline becomes the target, Ralph implements, and Visual Verdict drives measured iteration rather than subjective description alone.

## Purpose

Create a measured frontend delivery loop from either a generated reference, a static reference, or a live URL:

`user description / live URL -> approved visual reference -> $ralph implementation -> Visual Ralph verdict + pixel diff -> reproducible design system`.

For live URL cloning requests, Visual Ralph owns the migrated `$web-clone` use case. Do not route new URL-driven website cloning work to `$web-clone`; preserve the URL, viewport, fidelity requirements, and interaction notes inside the Visual Ralph loop.

This is an orchestration skill. It composes existing skills and must not add runtime commands, dependencies, or app-specific assumptions by itself.

When the repository exposes generic review authority, Visual Ralph produces visual-plane observations for that authority. It does not own finding identity, mutable status, or release readiness.

## Use when

- The user describes a desired web/app UI and wants implementation, not just design advice.
- The user provides a live URL and wants a visual implementation or clone through measured Visual Verdict iteration.
- A generated raster mockup/reference image would make the target clearer.
- The task needs pixel-level visual iteration with a pass/fail threshold.
- The final result should leave reusable design tokens/components, not only a one-off screenshot match.

## Do not use when

- The user only wants repo-wide design guidance, product/design context, or a DESIGN.md source of truth; use `$design` or a designer lane.
- The task is a non-visual backend/API implementation with no UI reference target.
- The user already supplied a final static reference image and only needs comparison/fixes; hand directly to `$ralph` with Visual Ralph verdict guidance.
- The requested output is a deterministic SVG/vector/code-native asset rather than a raster reference.

## Workflow

### 1. Ground the target repo

Before stack-specific choices, inspect local evidence:
- package manager and scripts,
- frontend framework and routing structure,
- styling system and design-token conventions,
- screenshot/test tooling,
- existing components that should be reused.

Do not hardcode React, Vue, Tailwind, Playwright, or any other stack unless the repository evidence supports it.

### 2. Establish the visual reference

For live URL requests, capture or document the URL-derived reference inside the Visual Ralph artifacts and carry forward viewport, content-state, and interaction constraints. Do not invoke `$web-clone`; that standalone skill is hard-deprecated.

Live URL reference artifacts must include:
- source URL and permission/scope note,
- viewport(s), route/state, and any seed/login assumptions,
- captured baseline screenshot path or documented capture command/tool,
- interaction parity notes for visible controls,
- known exclusions such as backend/API/auth, personalized data, multi-page crawling, and third-party widget parity.

Before capture or judgment, record data policy for the exact reference, screenshot, source context, and evaluator destination. Never transmit private product source, authenticated/personalized screenshots, secrets, or runtime data to an external evaluator without explicit policy authority. When no permitted evaluator exists, use an approved local/private path or report blocked/`unknown`; never silently weaken the review.

For generated UI concepts, use `$imagegen` to produce the reference from the user's UI description.

Treat image generation as an external data boundary unless the active tool is explicitly documented otherwise. Send only the approved design prompt and allowed reference inputs; never include private repository source, secrets, authenticated screenshots, or unrelated user/runtime data.

Prompt requirements:
- classify as `ui-mockup`, unless another imagegen taxonomy is clearly better,
- include viewport/aspect ratio and intended surface,
- specify layout, hierarchy, typography direction, color mood, and any exact text,
- forbid logos/watermarks/unrequested brand marks,
- ask imagegen to avoid impossible UI details or unreadable text.

When running under OMX CLI/runtime and a generated reference is part of an active Ralph-style loop, queue a continuation checkpoint before invoking the built-in image tool:

```bash
omx imagegen continuation <session-id> --artifact <slug-or-filename> --generated-dir "$CODEX_HOME/generated_images/<session>" --work-dir ".omx/artifacts/visual-ralph/<slug>"
```

This helper records `.omx/state/sessions/<session>/imagegen-pending.json` and uses the existing Stop-hook follow-up queue. It exists because built-in image generation may have to end the assistant turn immediately; the next Stop checkpoint should resume artifact recovery, copy the generated image into the workspace, and run the required visual QA/verdict gate instead of relying on a manual `$ralph` re-prompt.

For project-bound implementation, copy the approved reference into the workspace, for example under `.omx/artifacts/visual-ralph/<slug>/reference.png`. Never leave the implementation reference only in `$CODEX_HOME/generated_images/...`.

### 3. Require explicit user approval

Stop after reference generation or URL-derived reference capture and ask the user to approve one reference image/state or request a targeted regeneration/capture adjustment.

Before approval:
- do not start frontend implementation,
- do not invoke `$ralph`,
- do not treat a rough image as final.

After approval, the confirmed image or URL-derived baseline becomes the visual source of truth. Major design pivots, replacing the reference, or changing the design direction require an explicit user request.

### 4. Hand off to `$ralph` for implementation

Invoke `$ralph` with:
- the approved reference image path or URL-derived baseline artifact,
- source URL, viewport(s), content state, and interaction parity notes for live URL tasks,
- the user description,
- the detected repo/frontend context,
- exact screenshot command/viewport requirements,
- the completion checklist below.

Ralph may iterate autonomously after approval. It should edit code, run the app, capture screenshots, and keep improving until the approved reference is matched or a real blocker exists.

### 5. Use Visual Ralph verdict before every next edit

For each visual iteration:
1. Capture the current generated screenshot with recorded viewport/state.
2. Run the Visual Ralph verdict step comparing the approved reference and generated screenshot. Use the `vision` agent for image understanding when needed.
3. Treat the JSON verdict as authoritative.
4. Pass only when `score >= 90`, `verdict` explicitly passes, and `category_match` is true.
5. Otherwise, convert `differences[]` and `suggestions[]` into the next edit plan.
6. Rerun before the next edit.

Required verdict shape: `score`, `verdict`, `category_match`, `differences[]`, `suggestions[]`, and `reasoning`.

### 6. Preserve generic findings through repair and re-review

When a generic review system reports a visual finding:

1. Preserve its finding ID, rule/version, target, source/design/render identity, viewport, capture identity, evaluator identity, and evidence refs.
2. Convert the accepted edit into a repair assertion; do not mark the finding closed.
3. Capture a fresh matching screenshot and rerun the required evaluator against current source and the same canonical target.
4. Append the raw re-review observation. Let review authority derive `verified-resolved` only from matching pass evidence.
5. If the violation recurs after verified closure, append the new observation and let review authority derive `regressed`.

A Visual Ralph score, source edit, screenshot, or human statement alone cannot claim generic verified closure. Zero targets, all-skipped runs, capture errors, missing artifact hashes/identities, stale evidence, or wrong evaluator capability remain blocked/`unknown`.

An enforcing visual result artifact must carry a non-empty result schema/version and bind a stable target-partition/census identity plus hash, canonical target identity plus hash, source/design/render revisions, viewpoint, viewport, capture identity, producer/evaluator identity, and reference/current/diff artifact hashes. It must partition pass, skipped, and error outcomes explicitly. Missing partitions or identities cannot satisfy generic review closure.

The runtime `passes_threshold` field follows the same composite gate: score threshold, explicit passing verdict, and category match. A score-only threshold flag cannot satisfy Visual Ralph completion or generic review closure.

### 7. Keep proof planes separate

- Visual evidence proves only the exact visual target, viewpoint, capture, design/render revision, and source identity it binds.
- Source review, behavioral assertions, and certification evidence require their own producers.
- Pixel diffs are visual debug evidence, not behavioral proof or release certification.
- A proof envelope may certify a review artifact; it does not create or repair missing underlying evidence.

### 8. Use pixel diff only as secondary debug evidence

When mismatch diagnosis is hard, generate a pixel diff or pixelmatch overlay to locate hotspots. Pixel diff does not replace the Visual Ralph verdict; it only helps translate visual hotspots into concrete edits.

Record final diff evidence with the reference/screenshot artifacts so the result can be audited.

### 9. Build a reproducible design system

The implementation is incomplete unless the visual match is encoded in repo-native reusable artifacts. Depending on the project, this may mean CSS variables, theme tokens, Tailwind config, component variants, Storybook stories, updates that align with DESIGN.md, or existing equivalents.

Capture at least the applicable:
- colors,
- spacing scale,
- typography scale/weights,
- radii,
- shadows/elevation,
- important component variants and states.

Prefer existing token/component patterns. Do not introduce a new design-system layer if the repo already has one that can be extended.

## Completion checklist

Do not declare done until all are true:
- Approved reference image or URL-derived reference artifact is saved in the workspace.
- Screenshot reproduction command, viewport, route, seed/state, and output paths are documented.
- Visual Ralph verdict has final `score >= 90`, explicit passing `verdict`, and `category_match: true` against the approved reference.
- Pixel diff or overlay evidence is recorded as secondary debug evidence.
- Design-system tokens/components are repo-native and reusable.
- Build/lint/test or the repo's equivalent verification passes.
- No unapproved major design pivot occurred after reference approval.
- Remaining visual differences, if any, are explicitly documented with rationale.
- Generic findings preserve immutable identity through repair and fresh matching re-review.
- Generic closure comes from derived review status; edit-only, skipped, error, stale, zero-target, or missing-identity evidence remains blocked/`unknown`.
- Visual, source, behavioral, and certification proof remain separate.
- External evaluator inputs comply with explicit data/no-egress policy.

## Handoff template

```text
$ralph "Implement the approved frontend reference.
Reference: <workspace-reference-image-or-url-derived-artifact>
Source URL (if URL-derived): <url and permission/scope note>
Viewport/content state: <viewport, route/state, seed/login assumptions>
Interaction parity notes: <visible controls and known exclusions>
Route/surface: <route or component>
Screenshot command: <command and viewport>
Use the Visual Ralph verdict step before every next edit; pass requires score >= 90, an explicit passing verdict, and category_match: true.
Use pixel diff only as secondary debug evidence.
Extract reusable design tokens/components for colors, spacing, typography, radii, shadows, and key variants.
If generic findings exist, preserve finding/target/rule identities, record repair assertions, rerun matching evaluators, and accept only derived verified closure.
Keep visual, source, behavioral, and certification evidence separate. Missing, skipped, error, stale, or zero-target evidence is UNKNOWN.
Honor explicit evaluator data policy; never send private source or screenshots externally without authority.
Run build/lint/test before completion.
Do not make major design pivots unless explicitly requested."
```

Task: {{ARGUMENTS}}
