---
'@cat-factory/kernel': minor
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

The seed ids name a VENDOR rather than a model generation (`mdp_chatgpt`, not `mdp_gpt56sol`), so a
built-in rolls its `baseModelId` forward as the vendor's flagship moves and a workspace's pin survives
the move. That is what `mdp_claude`'s `version: 2` bump recorded when Opus 4.8 became Opus 5.

`catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run.

The `acceptance-suite-operator-setup` initiative tracker is retired into
[ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
its committed scope now complete.
