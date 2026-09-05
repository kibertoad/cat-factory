---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/consensus': patch
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-worker': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': minor
'@cat-factory/local-server': patch
'@cat-factory/node-server': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/spend': minor
'@cat-factory/worker': patch
---

Add GPT-6 Astra to the curated catalog, take the agent CLIs at their newest, and refresh the
dependency tree.

**GPT-6 Astra.** OpenAI's new flagship (2026-09-03) joins the catalog as `gpt-6-astra` with a
Codex subscription arm and an OpenRouter pay-as-you-go arm, a 1.05M window and image input. The
model id IS the Codex `--model` slug, the same rule the GPT-5.6 tiers already follow. Two shapes
were decided by checking the routes rather than the announcement:

- **No `bedrock` arm**, even though OpenAI named Bedrock among the launch-day routes. No published
  model card names the Bedrock **id** for Astra, and this catalog declares a flavour only once the
  route is verified to serve that exact model: a declared-but-absent route is selected by
  `effectiveVariant` and then fails at dispatch, with nothing upstream of the dispatch to catch it.
  The arm can be added, additively, when the id lands.
- **No separate "Astra Pro" entry.** Pro is not a second model or a second API id: it is this same
  `gpt-6-astra` served with `reasoning.mode` set to `pro`, and it exists only inside the ChatGPT
  plans, never on the API or in Codex. An entry for it could only name a route nothing here can
  dispatch.

Astra is priced at $10 / $50 per 1M, the most expensive model this catalog can select on either
OpenAI route, so it gets its own `openai:` and `openrouter:` spend rows rather than metering
against the bare provider fallback. Its cached input is $1, the same 0.1x read multiplier the
GPT-5.6 tiers use, so the derived cache tiers are already exact. The 2x "Fast mode" rate is
deliberately not modelled: nothing here dispatches it, and a row set to a mode we never request
would over-meter every ordinary Astra run against the budget gate.

The built-in `mdp_chatgpt` preset deliberately stays on `gpt-5.6-sol` this round. It names a
vendor rather than a generation and is meant to roll forward as that vendor's flagship moves, but
Astra is still rolling out per-organization: rolling the preset now would repoint every workspace
holding it onto a model its subscription may not serve yet, and the failure would land at dispatch.
It is a one-line roll-forward once the rollout completes.

**Agent CLIs.** Claude Code 2.1.260 -> 2.1.261, Codex 0.153.2 -> 0.153.4 and Pi 0.84.4 -> 0.85.0
all take their newest releases ahead of the 24h age window, as the Dockerfile's standing note
allows for those three pins. The Codex pin now also carries a floor the catalog depends on: Astra
resolves only from Codex 0.153.0 onward, and an older CLI answers `Unknown model` rather than
falling back, so that coupling is recorded at both ends. Both Pi extensions are already newest at
2.9.0. The executor image tag rolls to 1.152.0.

**Dependency refresh.** Direct ranges plus a full lockfile re-resolution: 70 resolved names moved,
no package name added or dropped. Three holds, each for a live constraint rather than caution:
vitest and `@vitest/coverage-v8` stay on 4.1.11 because `@cloudflare/vitest-pool-workers` 0.22.0
(the newest) still peers `vitest: ^4.1.0`; wrangler holds at 4.124.0 for the sixth round, still
pinned exactly as a dependency of that same package; and TypeScript holds at 6.0.3 on the frontend,
where `vue-tsc` resolves `typescript/lib/tsc`, which TS 7 no longer exports.
