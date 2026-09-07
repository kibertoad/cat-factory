---
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/consensus': patch
'@cat-factory/executor-harness': minor
'@cat-factory/integrations': patch
'@cat-factory/kernel': minor
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/server': patch
'@cat-factory/spend': minor
'@cat-factory/worker': patch
---

Re-verify every curated model route against its serving provider, take the agent CLIs at their
newest, and refresh the dependency tree.

**A withdrawn route, caught by the pin checker.** OpenRouter has withdrawn the undated
`qwen/qwen3.8-max` and now serves the dated `qwen/qwen3.8-max-0902` instead. That is the silent
failure `scripts/check-openrouter-pins.mjs` exists for: nothing throws, `effectiveVariant` keeps
choosing the gateway for a workspace holding only an OpenRouter key, and every dispatch fails on
a dead slug. The two entries swap arms accordingly, and the floating entry is deliberately NOT
re-pointed at the dated slug: following an alias onto a snapshot is the identity the pinned entry
beside it exists to hold.

**GLM-5.3 gains the two routes it was waiting for.** It shipped subscription-only because Z.ai
had not yet released the weights; Workers AI picked it up on 2026-08-28 and OpenRouter serves
`z-ai/glm-5.3` today. Both were read off the serving provider before being declared, and each
carries that provider's own window rather than the vendor's headline figure: Workers AI
1,048,576, OpenRouter 1,310,720, the coding plan 1M.

**Qwen3.8 Flash joins the catalog**, on DashScope and OpenRouter. It is the cheapest 1M-window
entry here that reads images, which is what earns it a curated slot rather than the dynamic
OpenRouter catalog: it is the natural low-cost tier for the inline steps that reach for
`glm-flash` today, and a per-token rate is what those steps are chosen on.

**One pinned rate was understating the budget gate.** `openrouter:x-ai/grok-4.6` carried xAI's
SHORT band ($2 / $6) with its cache tier left to derive, while the direct `xai:grok-4.6` row
carried the long band as its comment explains. xAI bills a request whose prompt reaches 200K
tokens entirely at the doubled rate and OpenRouter is a passthrough, so the gateway row now
matches: a cache read was metering at 60% below the live rate on a route that really does record
the class (`x-ai` is `auto-prefix` on the gateway). Every other pin came back at or above its
live rate, and every curated `openrouter` context window matches what the gateway serves.

**Two omissions re-checked rather than assumed.** GPT-6 Astra still declares no `bedrock` arm:
Codex 0.153.3 did add Astra to the Bedrock picker, so the route demonstrably exists, but neither
AWS nor OpenAI publishes the model id it addresses, and a `baseModelId` guessed from a
neighbouring entry is precisely the dead pin repaired above. Still no separate "Astra Pro" entry
either, though the reasoning has narrowed: OpenRouter has minted its own `openai/gpt-6-astra-pro`
slug, while OpenAI's model doc states reasoning effort is a parameter on the single `gpt-6-astra`
id and Codex has no such `--model` slug. A second entry could therefore carry one arm re-badging
a model already here at byte-identical pricing, and the two-entry shape is for a choice made with
the price in front of you.

**Agent CLIs.** Pi 0.85.0 -> 0.85.1 and Claude Code 2.1.261 -> 2.1.263 take their newest releases
ahead of the 24h age window, as the Dockerfile's standing note allows for those three pins. Codex
holds at 0.153.4 (already newest) and both Pi extensions at 2.9.0. Playwright in the UI image goes
1.62.1 -> 1.63.0 with `@playwright/test`. The executor image tag rolls to 1.154.0.

**Dependency refresh.** Direct ranges plus a lockfile re-resolution: 56 resolved names moved, no
package name added or dropped. Four holds are unchanged and were re-verified at HEAD rather than
restated: vitest at 4.1.11 and wrangler at 4.124.0 (`@cloudflare/vitest-pool-workers` 0.22.0 is
still the newest and peers `vitest: ^4.1.0` while pinning that wrangler exactly),
`@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date), and frontend TypeScript
at 6.0.3 (`vue-tsc` 3.3.11 calls `require.resolve('typescript/lib/tsc')`, which TS 7's exports map
does not carry). Base images are unchanged: `node:26-trixie-slim` still resolves to the digest
already pinned. GitHub Actions: `docker/setup-qemu-action` v4.2.0 -> v4.3.0, `pnpm/action-setup`
v6.0.10 -> v6.1.0, `zizmorcore/zizmor-action` v0.6.2 -> v0.6.3.
