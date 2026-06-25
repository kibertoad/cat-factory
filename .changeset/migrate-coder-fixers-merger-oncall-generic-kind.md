---
'@cat-factory/server': patch
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
