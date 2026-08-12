---
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
'@cat-factory/acceptance': patch
---

A fourth built-in model preset, **GPT-5.6 Sol** (`mdp_chatgpt`), is seeded for every workspace
alongside Kimi K2.7, GLM-5.2 and Claude Opus 5, so `claude | chatgpt | kimi` is finally expressible
as a pin rather than as a note in a config file.

It needs no new catalog route to be usable. `gpt-5.6-sol` carries an `openrouter` route and a Codex
`subscription` route, which is the same pair `claude-opus` already had, so `effectiveVariant` lands
on whichever the workspace holds: an OpenRouter key alone makes the preset dispatchable to a SYSTEM
API key (a Codex subscription is per-seat and individual-only, so a system token may not spend one),
and a connected subscription wins where there is one. Deliberately NOT a seeded default on any
deployment shape: Cloudflare and Node still seed Kimi K2.7, local mode still seeds Claude Opus 5.
The seed id names a VENDOR rather than a generation (`mdp_chatgpt`, not `mdp_gpt56sol`) so a built-in
can roll its `baseModelId` forward without becoming a preset nobody selected; argued in ADR 0056.

**An OpenAI API key is not one of those routes, and the run-start refusal now says which are.**
`openai` is a first-class poolable provider with its own onboarding copy, so "add an API key for the
provider" read as a `platform.openai.com` secret key, which cannot make this preset dispatchable.
`providers_unconfigured` now names each unusable model's DECLARED routes, computed from the catalog by
the new kernel `declaredModelRouteLabels`: `gpt-5.6-sol (needs OpenRouter or ChatGPT (Codex))`. That
fixes the misattribution for every subscription-or-gateway-only model rather than for this one, and
`details.models` still carries the bare ids the SPA and the four SDK clients read.

**Model presets gained the catalog NAME channel pipelines already had.** The snapshot ships
`modelPresetCatalogNames` beside `modelPresetCatalogVersions`, built from one `seedModelPresets()`
read. A brand-new built-in has no stored row to take a name off, which is exactly the state the
startup advisory offers to fix: without the map the SPA humanises the id, so every board created
before this release would have been offered "Chatgpt" instead of GPT-5.6 Sol. A new optional field on
the wire, so an older SPA keeps working off the humanised fallback.

**The built-in seed is now ONE batched write.** `ModelPresetRepository.upsertMany` (mirrored D1 batch
and Drizzle transaction, allow-listed for mothership mode) replaces a serial `upsert` per built-in on
a path that runs at a workspace's first board load, where every shipped built-in used to add a
round-trip. The single-default invariant is read over the batch: a promoted member demotes every row
outside it, and each member's own flag stands as written.

`catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run. The
conformance seeding assertion is derived the same way, and now compares the persisted rows against
the catalog member by member and in order instead of counting them.

The `acceptance-suite-operator-setup` initiative tracker is retired into
[ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
its committed scope now complete.
