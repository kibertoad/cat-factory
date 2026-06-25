---
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/kernel': patch
---

Migrate the next batch of built-in agents — `coder`, `ci-fixer`, `fixer`, `merger` and
`on-call` — onto the generic, manifest-driven `agent` harness kind, continuing the
strangler started with the read-only kinds.

`ContainerAgentExecutor` now routes these through `buildMigratedBuiltInBody` →
`buildRegisteredAgentBody` (which gained an optional `userPrompt` override) instead of their
bespoke per-kind bodies:

- `coder` dispatches `kind: 'agent'` in `mode: 'coding'` (clone the work branch, push it,
  open a PR). `runCodingAgent` already does branch-resume + checkpointing, so this is
  behaviour-equivalent to the old `/run` body.
- `ci-fixer` / `fixer` dispatch `mode: 'coding'` against the PR branch with
  `noChangesIsError: false` (in-place fixers — a no-op is a clean non-event), matching the
  old `/ci-fix` / `/fix-tests` bodies.
- `merger` / `on-call` dispatch `mode: 'explore'` with structured output (full clone). The
  conservative JSON coercion that used to live in the harness `/merge` and `/on-call`
  handlers now runs backend-side: `toRunResult` is kind-aware and maps the agent's `custom`
  result into `mergeAssessment` / `onCallAssessment` via `coerceMergeAssessment` /
  `coerceOnCallAssessment`, so the engine's merge resolver and post-release-health gate see
  exactly the same assessment shape as before.

The already-shipped executor-harness image serves all of these via its generic `handleAgent`
handler (explore-structured + coding-on-PR/coding-with-PR), so no image bump is required.
Two intentional, low-risk deltas: the merger/on-call explore bodies now carry the shared
web-tools fields like every other explore agent (gated by `webSearchProxyEnabled`), and the
merger's container-side `diffExaminable` guard is replaced by the backend coercion's
conservative-on-garbage defaults (documented in `coerceMergeAssessment`).

The now-dead `/run`, `/ci-fix`, `/fix-tests`, `/merge` and `/on-call` harness handlers are
removed in a later step of the sweep (which bumps the executor image), once parity is
confirmed on CI.

Three correctness fixes to the kind-aware mapping itself:

- The poll site (`ExecutionService.pollAgentJob`) now threads `step.agentKind` into the
  `pollJob` handle. `toRunResult`'s kind-aware coercion keys off `handle.agentKind`, which
  the engine previously never supplied at poll time — so the merger/on-call coercion was
  dead code and `mergeAssessment` / `onCallAssessment` were never set, leaving the merge
  gate and post-release-health gate with no assessment.
- `clamp01` no longer coerces `null` / `''` / `false` / `[]` to a finite `0` (via `Number()`):
  those now fall back to the conservative default (`1` for the merger → routes to human
  review), so a garbage/null score can't silently read as "trivial/safe" and auto-merge.
- The coerced `rationale` falls back to a stable `"No rationale provided."` when both the
  agent rationale and the run summary are empty, instead of an empty string.
