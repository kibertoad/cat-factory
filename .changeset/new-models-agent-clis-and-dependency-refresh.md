---
'@cat-factory/acceptance-kit': patch
'@cat-factory/agents': patch
'@cat-factory/app': patch
'@cat-factory/caching': patch
'@cat-factory/cli': patch
'@cat-factory/consensus': patch
'@cat-factory/deploy-harness': patch
'@cat-factory/eks': patch
'@cat-factory/executor-harness': minor
'@cat-factory/gatekeeper-bindings': patch
'@cat-factory/integrations': patch
'@cat-factory/kernel': minor
'@cat-factory/local-server': patch
'@cat-factory/mcp-server': patch
'@cat-factory/node-server': patch
'@cat-factory/observability-langfuse': patch
'@cat-factory/observability-otel': patch
'@cat-factory/orchestration': patch
'@cat-factory/provider-bedrock': patch
'@cat-factory/provider-cloudflare': patch
'@cat-factory/provider-s3': patch
'@cat-factory/sdk': patch
'@cat-factory/server': patch
'@cat-factory/spend': minor
'@cat-factory/worker': patch
---

Add five catalog models, take the agent CLIs at their newest, and refresh the dependency tree.

**Five new curated models.** Claude Fable 5.1, Gemini 3.8 Flash, a pinned Qwen3.8-Max-0902
snapshot, and Meta's Muse Spark 1.3 in both of its commercial tiers. Every route was checked
against the serving provider's live catalogue before it was declared, which is what decided three
of the shapes:

- **Claude Fable 5.1** is the first Claude entry carrying subscription, OpenRouter and Bedrock arms
  at once. Bedrock listed `anthropic.claude-fable-5-1` on Anthropic's own launch day rather than a
  generation behind, so the flavour is declared against a verified route. Its OpenRouter slug is
  DOTTED (`anthropic/claude-fable-5.1`) where the API id is dashed; the two genuinely disagree and
  normalising either spelling yields a dead id.
- **Qwen3.8-Max-0902** is DashScope-only. OpenRouter serves the undated alias and publishes no dated
  slug, and a flavour declared before its route exists is picked by `effectiveVariant` and then
  fails at dispatch. It is a separate entry rather than a repoint of `qwen3.8-max` for the reason
  `claude-opus-4-8` is separate: a block pinned to a snapshot must keep getting that build.
- **Muse Spark 1.3 ships as TWO entries**, standard and contributor. They are the same model on the
  same route and differ only in what Meta may do with the traffic: the contributor tier costs a
  twelfth on input in exchange for Meta training on the prompts and completions. That is a choice
  an operator has to make with the price in front of them, and one entry could only make it
  silently, so the two prices sit in separate rows and the SPA's "enable recommended" set omits the
  contributor slug.

`meta` joins the OpenRouter vendor-prefix family map beside `meta-llama`, so an account that blocks
the Meta family blocks Muse Spark too rather than leaving it unclassified.

**The bare `bedrock` price row moved up a tier**, from ~$5/$30 to ~$10/$50 per 1M. A Bedrock ref
carries the account's own geo prefix, so `priceFor` can only ever match the bare provider key, and
that row is deliberately set to the frontier tier the catalog can select there. Fable 5.1 moved that
ceiling; leaving the row behind would have metered every Fable-5.1-on-Bedrock run at half its cost.

**Both runner image tags roll**: the executor to 1.150.0 for the CLI bumps, and the deploy image
to 0.6.2 because the dependency round moved `@types/node` in its `package.json`, which the image
builds from. A dep bump inside a harness IS an image-source change, and republishing over a live
tag does not roll a deployment out.

**Agent CLIs at their newest, ahead of the age window**, as the Dockerfile's standing note allows
for exactly these pins: Claude Code 2.1.252 -> 2.1.260 and Codex 0.152.0 -> 0.153.2. Pi is already
at its newest (0.84.4). Both Pi extensions move 2.8.0 -> 2.9.0 and have aged past the window, so
they take the ordinary route.

**Dependency refresh**: direct ranges plus a lockfile re-resolution, so transitives move to the
newest release each declared range already admits under the `minimumReleaseAge` gate. 68 resolved
names move and the re-resolve adds and drops nothing, leaving 1388 names on both sides. Direct:
the `@ai-sdk/*` line (`amazon-bedrock@^5.0.73`, `anthropic@^4.0.49`, `openai@^4.0.57`,
`openai-compatible@^3.0.43`, `provider@^4.0.10`), `ai@^7.0.91`, `@aws-sdk/client-s3@^3.1125.0`, the
`@opentelemetry/*` set (`0.222.0` exporters, `2.11.0` SDK), `@types/node@^26.4.1`,
`happy-dom@^20.13.2`, `knip@^6.34.0`, `oxfmt@^0.66.0`, `oxlint@^1.81.0`, `undici@^8.10.1`. The AI
SDK family stays inside the `ai@^7` + `@ai-sdk/*@^4` majors that pair with `workers-ai-provider`.

Three holds, each for a reason rather than for the age window:

- **TypeScript stays at 6.0.3 on the frontend** while the backend is already on 7.0.2. TS 7 was
  tried and reverted: `vue-tsc@3.3.11` resolves `typescript/lib/tsc`, which TS 7 no longer exports,
  so the typecheck dies with `ERR_PACKAGE_PATH_NOT_EXPORTED` before reading a single file. vue-tsc
  is the real gate for `.vue`, so the frontend moves when vue-tsc does.
- **wrangler holds at 4.124.0 and `@cloudflare/workers-types` at 5.20260815.1** for the fifth round
  running. `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins wrangler
  exactly; the types version IS the workerd date that pin resolves.
- **`@types/node@26.4.0` and `undici@8.10.0` keep a second resolved copy** beside the new ones, held
  by upstream ranges (`@types/pg`, `happy-dom`, `nuxt`, `unifont`) rather than by anything here.

Also re-pins `openrouter:deepseek/deepseek-v4-flash`, the one row `check-openrouter-pins.mjs`
reported as metering BELOW the live rate. The alias drifted up ~9% since the 2026-09-01 read, and a
budget gate is allowed to be early but never short.
