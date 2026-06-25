---
'@cat-factory/agents': patch
'@cat-factory/server': patch
'@cat-factory/orchestration': patch
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

No image bump: the shipped harness `handleAgent` explore-structured handler already serves
this. The dead `/spec` handler is removed in a later sweep step (image bump). Cross-runtime
conformance asserts the post-op shards + commits the `spec/` artifact onto the work branch via
`RepoFiles` on both runtimes.
