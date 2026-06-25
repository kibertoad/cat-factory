---
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
'@cat-factory/kernel': patch
'@cat-factory/executor-harness': patch
---

Migrate the `spec-writer` built-in agent onto the generic, manifest-driven `agent` harness
kind, continuing the Task-5 strangler (after the read-only kinds, the merger/on-call/fixers,
the coder, and blueprints).

`ContainerAgentExecutor` now routes `spec-writer` through `buildMigratedBuiltInBody` →
`buildRegisteredAgentBody` as a read-only `mode: 'explore'` structured agent that clones the
per-block WORK branch (`cat-factory/<blockId>` — the coder's branch, created from base when
absent; the spec-writer runs BEFORE the coder, so it seeds that branch) instead of the
bespoke `/spec` body. The agent now READS the baseline spec from its own checkout under
`spec/` (the harness no longer pre-injects it) and returns ONLY the complete spec doc as JSON;
`toRunResult` coerces that `custom` result into the `spec` channel (via `coerceSpecDoc`) the
engine already strict-validates + ingests. The `SPEC_WRITER_SYSTEM_PROMPT` is updated to point
the agent at `spec/overview.md` + the `spec/modules/**` shards, and a new `specWriterUserPrompt`
carries the task increment + the read-the-baseline / reuse-the-taxonomy guidance the harness
`buildUserPrompt`/`renderTaxonomyInventory` used to inject.

The deterministic SHARD + commit of the in-repo `spec/` artifact that used to live in the
executor-harness `/spec` handler now runs as a BACKEND built-in post-op (`specPostOp`,
`@cat-factory/agents`), over the checkout-free `RepoFiles` port. It is keyed by the engine's
own built-in op map in `ExecutionService` — deliberately NOT the agent-kind registry, so the
built-ins never leak into `customAgentKinds` / the SPA palette. It reproduces the harness
reconcile exactly: the canonical `service.json` / `overview.md` / `modules/<m>/<g>.{json,md}`
shards are always rewritten and a removed module/group's shards are PRUNED (the deletion
channel); the Gherkin `features/<m>/<g>.feature` files are SEEDED-ONCE (committed only when
absent, never clobbering a polished one); and the pre-sharding monolithic artifacts
(`spec/spec.json` / `rules.md` / `version.json`) + old flat `features/*.feature` files are
dropped on sight. Idempotent: the spec has no `version.json` manifest, so the post-op
byte-compares each rendered shard to the branch and makes NO commit when everything matches
and there is nothing to seed or prune (durable-driver replay re-commits nothing).

Because the spec doc is handed onward to be sharded + committed, the migrated kind opts into
a new `output.failOnUnusableFinal` flag (kernel `AgentOutputSpec`) so the generic explore
handler FAILS the run LOUDLY when the agent's final answer is cut off at the output ceiling
(or empty) — restoring the bespoke `/spec` handler's `unusableFinalAnswerCause` gate, which
the generic `handleAgent` path lacked, so a truncated reply can no longer be laundered into a
half-baked spec by the structured repair. This is a harness change, so the executor-harness
image is bumped to `1.12.0` (the `deploy/backend` `image:publish` tag + `wrangler.toml` are
bumped to match). The dead `/spec` handler is removed in a later sweep step.

Cross-runtime conformance asserts the post-op shards + commits the `spec/` artifact onto the
work branch via `RepoFiles` on both runtimes.
