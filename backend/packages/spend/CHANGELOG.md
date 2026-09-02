# @cat-factory/spend

## 0.17.7

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.17.6

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 0.17.5

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.17.4

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.17.3

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.17.2

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 0.17.1

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.17.0

### Minor Changes

- 4d999cb: Treat OpenRouter as the gateway it is, rather than as one more OpenAI-compatible vendor.
  
  **Its own client.** `openrouter` now resolves through `@openrouter/ai-sdk-provider`
  (`openRouterResolver`) instead of the generic `createOpenAICompatible`; every other
  OpenAI-compatible provider is unchanged. The dispatch is made once, in
  `directOpenAiCompatibleResolver`, which both entry points that build a provider from a leased key
  route through.
  
  **Cost and upstream are now RECORDED rather than derived.** Usage accounting is requested on both
  model paths, so `llm_call_metrics` gains `reported_cost_usd` (the gateway's own USD ledger figure)
  and `upstream_provider` (which vendor actually served the call). Both are nullable and null is
  load-bearing: every other cost on the table is derived from the spend price table, so a 0 would
  report an unpriced call as free. **Break:** the two columns are added to the D1 telemetry store, the
  Postgres `telemetry` schema and local mode's SQLite store; existing rows read NULL, which is the
  correct answer for them.
  
  **`supportsStructuredOutputs` is now set** on the generic OpenAI-compatible client for the cloud
  VENDORS. Without it the SDK silently rewrites a schema-carrying request to `{ type: 'json_object' }`
  and drops the schema. Nothing in this repo passes a schema today, so this closes a trap rather than
  changing behaviour. It is withheld from the upstreams nobody here can vouch for: per-user local
  runners (which never come through this path anyway) and the operator-hosted `bifrost` / `litellm`
  gateways, whose model ids are the operator's own aliases and routinely front an Ollama or vLLM
  model that answers a `json_schema` request with a 400.
  
  **The `/models` catalog reads what it was dropping**: the conditional `overrides` pricing bands
  (folded to their maximum), both cache classes and the 1-hour write fallback, `expiration_date` and
  `canonical_slug`. A published cache rate now reaches the spend table instead of the derived
  multiplier, unless it is zero, which cannot be told apart from a placeholder for a class the
  gateway does not bill separately and would meter every cache hit free. A model's withdrawal date
  is shown in the catalog picker.
  
  **Prompt caching is no longer reported as absent for every gateway model.** `providerCachePolicy`
  takes the model, so an `openrouter:deepseek/…` slug resolves to the policy stated for its vendor
  prefix. Those are stated per prefix rather than borrowed from the direct provider of the same
  name, because the two genuinely differ: OpenRouter's Moonshot route caches automatically while our
  direct `moonshot` does not, and its Alibaba route needs explicit breakpoints while direct Qwen
  does not. Anthropic (and now Qwen) behind a gateway stays `none`, because nothing on that path
  sends `cache_control`. **Break:** the rule moved from `@cat-factory/kernel` to
  `@cat-factory/contracts` (kernel re-exports it unchanged) so the SPA can read the same function
  instead of mirroring it in a Vue constant, which had already drifted.
  
  **Two new env vars, because both routing constraints can empty the upstream pool.**
  `OPENROUTER_DATA_COLLECTION` (default `deny`, stricter than the vendor's own) is whether OpenRouter
  may route to a prompt-retaining upstream; `OPENROUTER_REQUIRE_PARAMETERS` (default `true`) is
  whether it must route only to an upstream advertising every parameter the request carries. A pool
  narrowed to nothing is a 404, not a degraded call, so the proxy recognises that refusal and records
  which constraint could have caused it: the gateway cannot say, since our request is the only place
  both are stated.
  
  **New check `scripts/check-openrouter-pins.mjs`** re-reads the live catalogue against the spend
  table's pinned slugs, comparing all three pinned classes: input, output, and the cache-READ rate a
  row names only where the vendor departs from the derived floor (so nothing else follows it when the
  vendor moves). Its runs found four pins metering below the live rate, one
  (`deepseek/deepseek-v4-pro`) by nearly 3x; all four are repinned here.
  
  **Reported cost and upstream are rendered**, in the observability panel's call list: the upstream
  beside `provider:model`, the gateway's own figure in the expanded row. They stay out of the spend
  rollups, which remain derived end to end, because a rollup mixing a measured figure for one
  provider's rows with an estimate for the rest answers a different question per row.
  
  **The inline instrumented provider now REFUSES to stream** rather than passing an unrecorded call
  through. Nothing inline streams today (the recorder hard-codes `streaming: false` for that reason),
  and a streamed call would have reached no sink at all, which downstream is indistinguishable from a
  step that spent nothing.

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 0.16.26

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.16.25

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

## 0.16.24

### Patch Changes

- Updated dependencies [4b1c76f]
  - @cat-factory/contracts@0.334.0
  - @cat-factory/kernel@0.323.0

## 0.16.23

### Patch Changes

- 6d4b02a: Add GLM-5.3 Flash to the model catalog: Z.ai's cheap natively multimodal GLM-5 (320B total, 18B
  active), served on Workers AI, through OpenRouter, and on a GLM (Z.ai) coding-plan subscription,
  with all three routes priced in the built-in spend table at Z.ai's list rate rather than its
  launch discount. Image input is declared on the two routes whose providers document it and left
  undeclared on the coding-plan route, which reaches Z.ai's Anthropic-compatible endpoint.
- Updated dependencies [6d4b02a]
  - @cat-factory/kernel@0.322.2

## 0.16.22

### Patch Changes

- Updated dependencies [be0b953]
  - @cat-factory/kernel@0.322.1

## 0.16.21

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0

## 0.16.20

### Patch Changes

- 90a915e: Attribute an inline agent step's tokens to the credential that served them, not to the path it
  ran on. A deployment serving inline steps through a subscription harness (the local facade's
  ambient claude/codex CLI, or a container on a leased subscription token) filed every
  non-containerised kind as metered spend with a blank vendor, so companion and research steps
  were counted as money on a plan that costs nothing per token. A resolved model now declares
  its billing, both metering sites forward it, and a subscription row always names a vendor.
  
  The step-level rollup carries the billing kind too (`PipelineStep.usageBilling`), so
  `metrics.costEstimate`, which is a list-price estimate for both billing kinds, renders labelled
  instead of reading as spend.
  
  The declaration travels on the resolved model, so it has to survive the provider decorators
  stacked above it: the AI SDK's `wrapLanguageModel` returns a fresh object that keeps only the
  members it knows about, and the inline concurrency limiter wraps every subscription vendor by
  default. Both decorators now wrap through `wrapModelPreservingMarkers`, which also keeps the
  existing `reportsOwnLlmCalls` marker readable wherever a decorator sits above the model that
  declares it.
  
  A consensus panel reports the billing its models agree on, so a diverted step on one
  subscription credential stops filing as metered too. A panel straddling two credentials keeps
  the metered default, because it did spend real money and one ledger row cannot state both.
- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/kernel@0.321.3

## 0.16.19

### Patch Changes

- e0eed49: Meter agent token usage per INPUT CLASS instead of pricing every input token at the fresh
  rate. `AgentTokenUsage` now carries an optional `inputClasses` split, filled in by the inline
  AI-SDK path, the consensus strategies and the container harness, so the two `spend.record`
  call sites that record from an agent result stop over-charging a cache-heavy run (measured at
  4.7x on a `coder` dispatch that was 96% cache reads). `estimateCost` is now the single entry
  point for pricing a usage and branches on the split internally.
  
  Internal break: `RecordUsageInput.inputClasses` is gone — the split rides `usage.inputClasses`
  instead, so a producer cannot report the two inconsistently. `ConsensusUsage` and spend's
  `InputTokenClassUsage` are now aliases of the kernel types they duplicated.
  
  Two rules the aggregate paths depend on: a multi-call usage fold applies the all-fresh
  fallback per PART, so one consensus participant whose provider reports no cache details no
  longer re-prices the whole panel at the fresh rate; and cache shares that overshoot their own
  total clamp the CHEAPEST class, so a producer whose two channels disagree is charged the dear
  class it reported rather than a tenth of it.
- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2

## 0.16.18

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/kernel@0.321.1

## 0.16.17

### Patch Changes

- Updated dependencies [dc12c82]
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0

## 0.16.16

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0

## 0.16.15

### Patch Changes

- 4f59cc0: Re-validate the built-in spend pricing table against vendor list prices. Corrects several
  entries that under-metered runs (both GPT-5.6 mid tiers, Moonshot's own Kimi K2.6 rate,
  DeepSeek V4 Pro on Workers AI, GLM-5.2 through OpenRouter), drops Claude Sonnet 5 to the
  $2/$10 Anthropic has since made permanent, and names the cache-read tiers vendors have
  begun publishing instead of deriving them.
- c030a23: Add Qwen3.8 Max to the model catalog: Alibaba's flagship 2.4T-param multimodal MoE with a 1M
  context, reachable direct on a DashScope key or through OpenRouter, with both routes priced in
  the built-in spend table. No Cloudflare flavour is declared, because Workers AI serves the
  open-weights Qwen3.8-27B rather than Max.
- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1

## 0.16.14

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0

## 0.16.13

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/kernel@0.318.1

## 0.16.12

### Patch Changes

- 0cfa7a2: Refresh the dependency tree, the pinned GitHub Actions and the Docker images, and move the three bundled agent CLIs.
  
  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):
  
  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.68 → ^7.0.77`,
    `@ai-sdk/anthropic@^4.0.39 → ^4.0.41`, `@ai-sdk/openai@^4.0.43 → ^4.0.46`,
    `@ai-sdk/openai-compatible@^3.0.31 → ^3.0.35`, `@ai-sdk/amazon-bedrock@^5.0.58 → ^5.0.61`.
  - **Runtime deps**: `jose@^6.2.9 → ^6.2.10`, `pg-boss@^12.27.0 → ^12.28.0`,
    `capnweb@^0.11.1 → ^0.12.0`, `@aws-sdk/client-s3@^3.1113.0 → ^3.1116.0`,
    `@cloudflare/workers-types@^5.20260819.1 → ^5.20260823.1`.
  - **Frontend**: `@nuxt/ui@^4.10.0 → ^4.11.0`, `happy-dom@^20.11.2 → ^20.11.6`,
    `vue-tsc@^3.3.10 → ^3.3.11`. The frontend's `typescript@^6.0.3` is deliberately unchanged:
    `vue-tsc` still resolves `typescript/lib/tsc`, a subpath TypeScript 7's exports map does not
    expose, so the SPA stays on 6 until `vue-tsc` supports the Go port.
  - **Tooling**: `@stryker-mutator/*@9.6.1 → 10.0.0` (its only breaking change is dropping Node 20;
    CI runs 26) and pnpm `11.22.0 → 11.23.0`.
  
  **Changesets moves as a coupled major**: `@changesets/cli@^2.31.1 → ^3.0.1` plus
  `changesets/action@v1.9.0 → v2.1.1`, which refuse each other's majors. Two behaviour changes had to
  be pinned back to what this repo already relied on: `.changeset/config.json` now sets
  `privatePackages: { version: true, tag: false }`, because v3 stopped versioning private packages by
  default and `@cat-factory/executor-harness`'s version IS the runner image tag; and `release.yml`
  takes the renamed inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`), the
  `pr-number` output, and the token through the `github-token` input, which v2 no longer accepts from
  the environment. v2 pushes the release branch and tags through the GitHub API, so that job's
  checkout no longer persists git credentials.
  
  **Held back, all inside the ~24h `minimumReleaseAge` window when this was cut**: `@types/node@26.3.0`,
  `hono@4.13.4`, `oxlint@1.80.0`, `oxfmt@0.65.0`, `ai@7.0.78`, `@ai-sdk/openai-compatible@3.0.36`,
  `@aws-sdk/client-s3@3.1117.0`. `pg-boss@12.28.0` was ~20 minutes short of the same window and was
  taken anyway, so it is listed in `minimumReleaseAgeExclude` — the ONE third-party entry there, added
  deliberately with a PRUNE ME note, since it has already aged past the gate and removing the line is
  now a no-op re-resolve.
  
  **`wrangler` is now pinned by override**, not merely ranged. `@cloudflare/vitest-pool-workers@0.22.0`
  pins `wrangler` (and through it `workerd` and `miniflare`) EXACTLY, so any in-range refresh floats our
  caret ahead of the pool's pin and the tree gains a SECOND workerd — not just ~100MB of duplicated
  platform binary per arch, but a runtime the Worker suite proves that is a different build from the one
  `wrangler deploy` ships. The override holds it at whatever pool-workers pins, exactly as the three
  esbuild pins beside it already do, and moves when that package moves.
  
  **Stryker 10 pulled Babel 8 into a tree whose Nuxt half is on Babel 7**, and the three Babel plugins
  Nuxt declares as OPTIONAL PEERS were then filled from the 8.x line while still being handed
  `@babel/core@7`. A Babel 8 plugin's `declare()` asserts the core major and throws, so
  `pnpm-workspace.yaml` scopes those three names back to 7.x for their Nuxt parents.
  
  **The three agent CLIs the executor image bundles** move together and are all taken at their newest
  release, ahead of the release-age window: Pi `0.84.2 → 0.84.3`, Claude Code `2.1.237 → 2.1.243`,
  Codex `0.148.0 → 0.149.1`. That exemption is an explicit call re-made at each bump, and the
  Dockerfile now says so for all three rather than for Claude Code alone. Pi's two extensions take the
  ordinary aged pick, `2.6.2 → 2.7.0`. The UI image moves `pnpm 11.22.0 → 11.23.0` to match the
  workspace; its Playwright (1.62.1), Yarn (4.18.0), `serve` (14.2.6) and WireMock (3.13.1) pins are
  already current, as are the deploy image's kubectl `v1.36.4` / kustomize `v5.8.1` / helm `v4.2.4` and
  both images' `node:26-trixie-slim` digest.
  
  The executor image tag therefore rolls to `1.130.0` (base + UI): republishing over a live tag does
  not roll a deployment out. The deploy image is unchanged and stays at `0.2.15`.
  
  **Pinned GitHub Actions**: `actions/checkout v7.0.0 → v7.0.1`, `actions/setup-node v6.4.0 → v7.0.0`,
  `actions/setup-java v5.7.0 → v6.0.0` (both majors are ESM rewrites with no change to the inputs used
  here), `docker/build-push-action v7.2.0 → v7.3.0`, `docker/login-action v4.2.0 → v4.6.0`,
  `docker/setup-buildx-action v4.1.0 → v4.3.0`, `docker/setup-qemu-action v4.1.0 → v4.2.0`,
  `dorny/paths-filter v4.0.1 → v4.0.3`, `pnpm/action-setup v6.0.9 → v6.0.10`,
  `rharkor/caching-for-turbo v2.5.0 → v2.5.1`, and `zizmorcore/zizmor-action v0.5.7 → v0.6.2`, which
  raises the default zizmor from 1.26.1 to 1.29.0.
- Updated dependencies [08752da]
- Updated dependencies [0cfa7a2]
- Updated dependencies [dc26bb5]
  - @cat-factory/contracts@0.327.0
  - @cat-factory/kernel@0.318.0

## 0.16.11

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/kernel@0.317.1

## 0.16.10

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0

## 0.16.9

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0

## 0.16.8

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0

## 0.16.7

### Patch Changes

- 3db0d43: Refresh the whole dependency tree, re-roll both runner images, and move the three bundled agent CLIs.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the
  newest release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.64 → ^7.0.68`,
    `@ai-sdk/anthropic@^4.0.38 → ^4.0.39`, `@ai-sdk/openai@^4.0.41 → ^4.0.43`,
    `@ai-sdk/openai-compatible@^3.0.30 → ^3.0.31`, `@ai-sdk/amazon-bedrock@^5.0.55 → ^5.0.58`.
  - **Runtime deps**: `hono@^4.13.1 → ^4.13.3`, `@hono/node-server@^2.1.0 → ^2.1.1`,
    `jose@^6.2.8 → ^6.2.9`, `capnweb@^0.11.0 → ^0.11.1`, `@aws-sdk/client-s3@^3.1109.0 → ^3.1113.0`.
  - **Tooling**: `wrangler@^4.122.0 → ^4.124.0`,
    `@cloudflare/workers-types@^5.20260812.1 → ^5.20260819.1` (which is what wrangler 4.124 now
    peer-requires), `@cloudflare/vitest-pool-workers@^0.21.2 → ^0.22.0`, `vitest@^4.1.10 → ^4.1.11`,
    `@vitest/coverage-v8@^4.1.10 → ^4.1.11`, `oxlint@^1.78.0 → ^1.79.0`, `oxfmt@^0.63.0 → ^0.64.0`,
    `publint@^0.3.23 → ^0.3.24`, `turbo@^2.10.9 → ^2.10.11`, `vue-tsc@^3.3.9 → ^3.3.10`,
    `@types/pg@^8.21.0 → ^8.23.1`, pnpm `11.21.0 → 11.22.0`.

  **The three agent CLIs the executor image bundles** move together: Pi `0.84.1 → 0.84.2`, Codex
  `0.147.0 → 0.148.0`, Claude Code `2.1.231 → 2.1.237`. The Claude Code pin is taken at its newest
  release, ahead of the 24h `minimumReleaseAge` window, which is the explicit call that pin's own note
  asks to re-make on every bump. Pi's two extensions move in lockstep as their monorepo publishes
  them, `2.4.0 → 2.6.2`.

  **The UI-tester image** aligns its Playwright with the one the e2e suite drives (`1.61.1 → 1.62.1`),
  and moves `@yarnpkg/cli-dist@4.10.3 → 4.18.0` and `serve@14.2.5 → 14.2.6`. **The deploy image** takes
  `kubectl v1.36.3 → v1.36.4` and `helm v4.2.3 → v4.2.4`; kustomize is already current at `v5.8.1`.

  Both image tags therefore move in this change (`cat-factory-executor:1.127.0`,
  `cat-factory-executor-ui:1.127.0`, `cat-factory-deploy:0.2.14`): republishing over a live tag does
  not roll a deployment out.

  No `minimumReleaseAgeExclude` entries were added and none were needed: every registry bump above
  already clears the gate. Five packages had a newer release the gate still withholds
  (`@ai-sdk/*`, `ai@7.0.70`, `happy-dom@20.11.6`, `@aws-sdk/client-s3@3.1114.0`,
  `@cloudflare/workers-types@5.20260820.1`), so each lands one release short of the registry's head.
  `drizzle-orm`/`drizzle-kit` stay on `1.0.0-rc.4`: the only newer builds are commit-suffixed
  snapshots, not a released `rc.5`. Majors available but deliberately not taken here, each being its
  own change: `@changesets/cli@3`, `@stryker-mutator/*@10`, and TypeScript 7 for the two frontend
  packages still on 6.

- Updated dependencies [3db0d43]
  - @cat-factory/contracts@0.323.1
  - @cat-factory/kernel@0.314.1

## 0.16.6

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0

## 0.16.5

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0

## 0.16.4

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 0.16.3

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.16.2

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 0.16.1

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 0.16.0

### Minor Changes

- 3f7d8b2: Support Bifrost as an AI gateway, and make the OpenAI-compatible provider set one table both
  runtimes derive from.

  `bifrost` joins the workspace API-key pool and the model catalog (`bifrost-default`) as the second
  operator-hosted gateway beside LiteLLM: self-hosted software with no public instance, so it is
  proxyable and key-poolable but resolves only once the deployment sets `BIFROST_BASE_URL`. Until then
  its pooled key is inert and its catalog entry reads `available: false`, rather than passing the start
  guard and failing at dispatch. Its catalog default is `openai/gpt-4o`, a real id on any Bifrost whose
  OpenAI provider is configured, because Bifrost names models by their canonical `provider/model` pair
  rather than by operator-coined aliases.

  **The seam it landed through.** `OPENAI_COMPATIBLE_ENDPOINTS` (`@cat-factory/agents`
  `providers/endpoints.ts`) is now the ONE table naming every OpenAI-compatible provider and the
  endpoint it defaults to, `null` marking an operator-hosted one. Everything else is derived from it:
  the built-in base URLs, `UI_CONFIGURABLE_DIRECT_PROVIDERS`, `isProxyableProvider`, the new
  `isOpenAiCompatibleProvider` / `isOperatorHostedGateway` predicates, and the `OperatorHostedGateway`
  union that the base-URL remedy's display names are an exhaustive `Record` over. Adding a provider is
  one entry there, and the compiler finds the rest.

  **Four facade gaps that closed with it**, every one of them silent before:

  - The Node LLM-proxy upstream kept its own provider→env table, which omitted `xai`. A Pi step
    pinned to Grok-direct passed the dispatch guard (`isProxyableProvider('xai')` is true) and then
    failed as "upstream not available". That table is gone; the upstream resolves through
    `baseUrlForNode`, the same resolution the inline path takes.
  - `workers-ai` was the SAME bug from the other side: the dispatch guard is runtime-neutral and
    admits it everywhere, the catalog offers every Cloudflare model once the REST credentials are set,
    and only the Worker (which has the `AI` binding) had a route. A container step on Node died at its
    first proxy call with "Provider 'workers-ai' is not available". Node now forwards it to
    Cloudflare's own OpenAI-compatible endpoint, carrying the account token on the resolved endpoint
    because `workers-ai` owns no pooled key. The proxy prefers an in-process route and falls back to
    the forward path, reporting the provider unavailable only when neither resolves.
  - The Worker's typed env override map was a loose `Record<string, …>` and omitted `xai` too, so the
    documented `XAI_BASE_URL` was consumed by neither facade. It is now total over the shared
    `DirectProvider` union, so a provider missing from it is a type error.
  - That union is the direct providers, not just the OpenAI-compatible ones, which closes
    `ANTHROPIC_BASE_URL`: Node reads env by name and always honoured it, the Worker never declared it.
    The container proxy still refuses `anthropic` (its own SDK dialect would reject an OpenAI-shaped
    body), and refuses it by the table's predicate rather than by "did a base URL resolve", those two
    answers now differing for exactly that provider.

  **Metering**: the shipped `bifrost-default` entry routes `openai/gpt-4o`, so it is priced at that
  model's own direct rate rather than the generic gateway fallback, which would have under-counted it
  about sixteenfold against a workspace budget.

  **For operators**: `BIFROST_BASE_URL` is new (CF + Node). `XAI_BASE_URL` now actually takes effect on
  the Worker, and `ANTHROPIC_BASE_URL` on the Worker at all: a deployment that set either expecting a
  regional or proxied endpoint was silently reaching the public API and will now reach what it
  configured. Both, plus the rest of the `${VENDOR}_BASE_URL` family, are documented in
  `docs/environment-variables.md` and reserved against being named as a capability credential, which
  they were not before. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` is now read in one place on
  Node, so a whitespace-only value counts as unset everywhere instead of enabling the picker only.

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.15.101

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.15.100

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.15.99

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

## 0.15.98

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0

## 0.15.97

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0

## 0.15.96

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0

## 0.15.95

### Patch Changes

- 409238f: Add GLM-5.3, Gemini 3.7 Flash and Grok 4.6 to the model catalog, and re-baseline the spend
  price table against what the providers currently charge.

  New catalog entries: `glm-5.3` (subscription-only, GLM Coding Plan), `gemini-3.7-flash`
  (OpenRouter) and `grok` (Grok 4.6, direct via a new `xai` provider or OpenRouter). GLM-4.7
  Flash gains a Bedrock flavour (`zai.glm-4.7-flash`).

  `xai` is a new direct provider: `XAI_API_KEY` joins the poolable key providers and the
  reserved-env-key list, `XAI_BASE_URL` overrides the endpoint, and `grok` joins the model
  family vocabulary the account model policy allows or blocks. A policy in `allowlist` mode
  does not admit the new family until an admin adds it, which is the intended default.

  Price corrections, several of which were metering runs BELOW their real cost: DeepSeek's V4
  pair moves to the peak rates its 2026-08-16 peak/off-peak switch introduces, the OpenRouter
  `deepseek/deepseek-v4-pro` alias nearly triples, and Cloudflare's now-published cached-input
  rates for GLM-5.2 and the Kimi pair replace a derived floor that was ~1.9x too low. GLM-5.2
  and Gemini 3.6 Flash on OpenRouter were overpriced and come down. Z.ai subscription refs
  (`zai:*`) were falling through to the generic default price and now carry Z.ai's list rate.

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0

## 0.15.94

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0

## 0.15.93

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 0.15.92

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 0.15.91

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 0.15.90

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 0.15.89

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 0.15.88

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 0.15.87

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 0.15.86

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 0.15.85

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 0.15.84

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 0.15.83

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 0.15.82

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 0.15.81

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 0.15.80

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 0.15.79

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 0.15.78

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 0.15.77

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 0.15.76

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 0.15.75

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 0.15.74

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 0.15.73

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 0.15.72

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 0.15.71

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 0.15.70

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 0.15.69

### Patch Changes

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1

## 0.15.68

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 0.15.67

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 0.15.66

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 0.15.65

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 0.15.64

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 0.15.63

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 0.15.62

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 0.15.61

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 0.15.60

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 0.15.59

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 0.15.58

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 0.15.57

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 0.15.56

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0

## 0.15.55

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 0.15.54

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 0.15.53

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 0.15.52

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 0.15.51

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 0.15.50

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 0.15.49

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 0.15.48

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 0.15.47

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 0.15.46

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 0.15.45

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 0.15.44

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 0.15.43

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 0.15.42

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 0.15.41

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 0.15.40

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 0.15.39

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 0.15.38

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 0.15.37

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 0.15.36

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 0.15.35

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 0.15.34

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 0.15.33

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 0.15.32

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 0.15.31

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 0.15.30

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 0.15.29

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 0.15.28

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 0.15.27

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 0.15.26

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 0.15.25

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 0.15.24

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 0.15.23

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 0.15.22

### Patch Changes

- 2fdb08d: Simplify three predicates the nightly mutation run showed nothing could distinguish: the OpenRouter
  slug's vendor prefix is sliced rather than split-and-guarded, the family policy's unclassified case
  is an explicit early return, and `effectiveTierLimit` drops a branch `Math.min()` already answers.
  Name the subscription-harness rule once as `runsOnSubscriptionHarness`, which three model decisions
  spelled inline and two of them as its negation. Behaviour is unchanged; the rest of the change is
  tests.
- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 0.15.21

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 0.15.20

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 0.15.19

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 0.15.18

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.15.17

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0

## 0.15.16

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.15.15

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0

## 0.15.14

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0

## 0.15.13

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0

## 0.15.12

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0

## 0.15.11

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0

## 0.15.10

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0

## 0.15.9

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0

## 0.15.8

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1

## 0.15.7

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0

## 0.15.6

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0

## 0.15.5

### Patch Changes

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.15.4

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0

## 0.15.3

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0

## 0.15.2

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0

## 0.15.1

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0

## 0.15.0

### Minor Changes

- aa62acf: Warn about spend BEFORE the safeguard starts pausing runs. The budget gate was purely reactive:
  `isOverBudget` paused a run at the ceiling and a `budget_paused` card appeared, so the first
  signal a team got that their budget was running out was a pipeline stopping halfway through. The
  new forecast layer measures a trailing-window burn rate, projects the period total, and raises a
  `budget_threshold` notification once metered spend crosses 80% of the workspace or account budget,
  or is projected to overrun it before the period ends. Gating is untouched: the forecast is
  advisory, so a projection bug can cost a wrong card and never a paused or unpaused run.

  The burn rate divides by the span the ledger was actually OBSERVED over, not the nominal window.
  Without that, a workspace that started spending two hours ago is divided by seven days and reads
  as 1/84th of its real pace, which is exactly the runaway the alert exists to catch. Below six
  hours of history the projection is withheld rather than published as a number nobody should act
  on, and `insufficient-history` is reported as its own state rather than rendered as a calm zero.

  The card notifies once per crossing per period and re-arms at the period rollover. Its persisted
  state IS the card row, read back through a new `listLatestByType` that ignores card status
  deliberately: a crossed threshold stays crossed for the rest of the month, so reading only OPEN
  cards would re-alert every fifteen minutes the moment somebody tidied their inbox. Its title and
  body therefore name only stable facts (the threshold, the limit), never the live spend or burn
  rate, which would re-toast the inbox on every sweep. The sweep runs on both facades from the same
  shared driver and cadence; it is not behind an opt-in flag, because having configured a budget is
  the opt-in. The USER budget tier is deliberately not alerted on: a personal budget is not a fact a
  workspace-visible card may state, and there is no per-user inbox to raise it in.

  `budget_threshold` is Slack-routable (unlike `budget_paused`, which arrives too late to act on).

  Also adds two TCO axes to the Reports spend rollup: `repo` and `ticket`, grouping spend by the
  run's linked repository and by the tracker issue linked to the run's block. Both are one grouped
  query rather than a hand-written join against the database. A block legitimately linked to several
  tickets is attributed to one deterministically (the lowest `source:externalId` ref) rather than
  fanned out, which would have multiplied that block's cost by the number of tickets pointing at it
  and left the breakdown disagreeing with the window totals.

  The public API's notification-type enum gains `budget_threshold` (an additive change; OpenAPI
  `info.version` 1.3.0 → 1.4.0, SDK clients regenerated). It is NOT in
  `DEFAULT_NOTIFICATION_WEBHOOK_TYPES`: like the other operator-concern cards it ships only to
  webhooks that name it in their `types` filter.

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0

## 0.14.15

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1

## 0.14.14

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0

## 0.14.13

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.14.12

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0

## 0.14.11

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2

## 0.14.10

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1

## 0.14.9

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0

## 0.14.8

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0

## 0.14.7

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0

## 0.14.6

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0

## 0.14.5

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0

## 0.14.4

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0

## 0.14.3

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1

## 0.14.2

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0

## 0.14.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0

## 0.14.0

### Minor Changes

- cc17221: Price the three input token classes at their own rates and surface the resulting cost on the run
  and debug surfaces.

  `ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
  rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
  the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
  was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

  The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
  run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
  model away again, returning the `(agentKind, phase)` cells every consumer already read, now
  carrying `costEstimate`. That collapsed cell is its own type (`LlmRollupCell`), so a reader
  cannot ask it which model it was: after the fold there is no single answer. An unpriceable slice
  reports `null` rather than `0`, and a total containing one propagates that null instead of
  reporting a partial sum as complete.

  Public API (`/api/v1`), additive, `info.version` 1.1.0 → 1.2.0: the debug run overview's LLM
  rollups carry `costEstimate` and the block carries `costCurrency`. The four SDK clients are
  regenerated; the Python and Java manifests are bumped so the new models publish.

  The run's LLM-metrics export now states whether it is `truncated`. It is capped at the newest
  1000 calls, and a cost folded from that slice would be a smaller number that still reads as the
  run's total, so a truncated bundle reports null costs rather than pricing the part it holds.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0

## 0.13.13

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0

## 0.13.12

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0

## 0.13.11

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0

## 0.13.10

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0

## 0.13.9

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1

## 0.13.8

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0

## 0.13.7

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0

## 0.13.6

### Patch Changes

- 87161e8: Make AWS Bedrock a selectable per-model route, resolved by a preference walk instead of a hard-coded if-chain.

  `BEDROCK_MODELS` was already a per-model allow-list and nothing consumed it but a throw-on-mismatch guard, so Bedrock was reachable only by repointing the whole deployment's routing default. That left the account model policy's `trustedProviders: ['bedrock']` half-wired: its entire purpose is to let an otherwise-blocked family through on a residency-guaranteed route, and no user could select one. A catalog entry now declares a `bedrock` flavour and becomes selectable exactly when the account's allow-list carries its model, so a single task can be pinned to Bedrock.

  **The allow-list is parsed once, by `bedrockAllowListFromEnv`, and that one value feeds both consumers.** The resolver THROWS on an id outside its list while the catalog decides what the picker offers; parsed separately, a trailing space or a re-ordered var makes the picker advertise a route that fails at dispatch. `BEDROCK_REGION` with no `BEDROCK_MODELS` deliberately contributes NO flavour: the resolver runs unconstrained, but Bedrock grants are per account and per Region, so with nothing enumerated the platform would be guessing, and a guess here surfaces models AWS rejects at call time. Bedrock stays reachable as a routing default there, exactly as before. On the Worker, which does not bundle the provider package, the capability is further gated on a registered registry that can actually serve `bedrock` (`bedrockModelsCapability`): the env vars alone don't prove the `registerModelRegistry` mix-in happened, and set-but-unregistered logs a warning naming the missing call instead of offering picker rows whose dispatch fails.

  **The catalog declares the UNPREFIXED base id and the deployment's own entry is what runs.** The id an account calls carries a geo/global inference prefix (`us.` / `eu.` / `global.` / …) that differs per Region, so any prefix baked into the catalog would be wrong for every deployment but one. `resolveBedrockModelId` matches an allow-list entry that IS the base or ends in `.<base>` and uses it verbatim. Two consequences are load-bearing: the prefix set is never enumerated (a prefix AWS adds later just works), and where an operator lists two profiles for one model the FIRST wins, so ordering the env var is how they choose between a regional and a global one. That also means `bedrockModels` is a `Set` whose ITERATION ORDER matters, built from the env string once.

  **Bedrock lags the vendors' own APIs, and the catalog says so structurally rather than in a comment.** `gpt-5.5` and `gpt-oss-120b` carry a `bedrock` flavour because Bedrock serves that same generation. Opus 4.8 is a NEW `claude-opus-4-8` entry instead of a flavour on `claude-opus`, because it is a different model rather than another route to the same one: folding it in would silently run 4.8 for a block pinned to Opus 5, and nothing downstream could tell. Llama and Nova are deliberately left unenabled: their concrete Bedrock ids could not be verified against a live account, and a base id that never matches an allow-list entry is a permanently unselectable row in everyone's picker.

  `effectiveVariant` is now a walk over `DEFAULT_PROVIDER_PREFERENCE` (`direct > bedrock > openrouter > cloudflare > subscription`), with each route supplying its `declared`/`usable`/`build` arms through an exhaustive `Record<ModelFlavor, …>`, so **a route added to the wire vocabulary fails to compile until every arm is handled**. This replaces two hand-ordered if-chains that had to be kept in step by eye. The tuple is pinned to the contracts picklist by `satisfies` in one direction and by a test in the other, because a flavour contracts gained but the tuple lacked would never be TRIED and no typecheck can see that: the resolver walks the tuple, not the union.

  **A best-effort build must still produce a ref.** A Bedrock-only entry has no other route, so returning nothing when the allow-list misses would make the resolver THROW for every deployment that has not configured Bedrock, which is most of them, and the throw would take out the whole `/models` catalog. It falls back to the base id, flagged `available: false`, which is what tells the picker it cannot run.

  **A Bedrock ref's context window cannot be keyed on the ref.** `contextWindowFor` keys on `${provider}:${model}` and a Bedrock ref carries the operator's prefixed id, so the window is stored per catalog base id and found through the same suffix match resolution uses. Missed, the LLM proxy silently stops capping requested output for every Bedrock model, which surfaces as a provider-side rejection of the whole request rather than as a misconfiguration.

  `providerCachePolicy('bedrock')` stays `none`, so the picker reports no prompt caching. Bedrock does support Anthropic-style cache breakpoints, but the hint is model-specific and we do not send it; claiming caching we have not implemented would be worse than reporting none.

  **Spend gets a bare `bedrock` rate, priced high on purpose.** Making the route selectable without it would have metered every Bedrock call at `defaultPrice`, roughly a thirtieth of an Opus-tier run's real cost: an undercount in the budget safeguard introduced by this change. It cannot be per-model yet: `priceFor` matches `provider:model` exactly and a Bedrock ref carries the operator's Region prefix, so a per-model key would silently never match. Teaching `priceFor` the same prefix-tolerant match `contextWindowFor` now uses is the follow-up, and it is also what would stop a cheap Bedrock model being metered at the frontier rate.

  **Behaviour change for deployments that already set both Bedrock vars**: a model whose only other routes are the gateway or the Cloudflare floor now resolves to Bedrock, which is the point of the feature (a first-party route beats an aggregator that resells it). A configured direct key still wins.

  Slicing note: the initiative called for the subscription-first reorder FIRST, and scoping it against the code inverted that. `ModelRouter.resolveEffectiveRef` reads a truthy `ref.harness` as proof of entitlement, and `resolveBlockModel` is built at boot from capabilities that assert every vendor, so promoting `subscription` in the tuple alone would dispatch subscription runs for workspaces holding no token; separately, the ~10 inline call sites degrade through `inlineModelRef`, which sees a ref and not a model id, so a dual-mode pin would fall back to the routing default rather than the model's own base (a GLM-pinned reviewer silently running Qwen). Both need resolution to be given facts it does not have today, which is a slice of its own rather than a preliminary commit. The default order therefore keeps `subscription` last for now, with the reasoning recorded beside the tuple, in `model-support.md` §4, and in the initiative's redirect note.

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0

## 0.13.5

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0

## 0.13.4

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0

## 0.13.3

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0

## 0.13.2

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0

## 0.13.1

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1

## 0.13.0

### Minor Changes

- 3435bd1: Refresh the model catalog against what the providers actually serve (Aug 2026). Several
  curated entries pointed at ids their provider has since retired, so the model was
  un-runnable rather than merely dated:

  - **Cloudflare Workers AI**: `@cf/meta/llama-3.1-8b-instruct` and `@cf/moonshotai/kimi-k2.5`
    were deprecated on 30 May 2026. `cloudflare-llama` now serves `llama-4-scout` (131K,
    tool calling) and the `kimi-k2.5` entry is removed. The `conflict-resolver` routing
    default on BOTH runtimes pointed at the deprecated K2.5 and moves to K2.6. Adds
    `gpt-oss-120b` and `glm-flash` (GLM-4.7 Flash) as the missing open-weights and
    cheap-tier options.
  - **ChatGPT / Codex**: `gpt-5.5-codex` and `gpt-5.4-codex` were never valid Codex
    `--model` slugs (the `-codex` family ended at GPT-5.3), so both entries failed with
    `Unknown model`. The catalog now carries the GPT-5.6 tiers Codex actually serves —
    `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` — plus plain `gpt-5.5`. **The `gpt-5.4`
    entry is removed** (Codex retires it for ChatGPT sign-ins on 31 Aug 2026); a block
    pinned to it falls through to the workspace/deployment default.
  - **DeepSeek**: the `deepseek-chat` alias was retired on 24 Jul 2026 in favour of the V4
    pair. The `deepseek` entry moves to `deepseek-v4-flash` (1M context) across its direct,
    OpenRouter and subscription flavours, and `deepseek-v4-pro` gains direct + OpenRouter
    flavours beside its Cloudflare one.
  - **OpenRouter**: `google/gemini-3-pro` no longer exists on the gateway — the `gemini`
    entry moves to `google/gemini-3.1-pro-preview`. Adds gateway routes for GLM-5.2 and
    Qwen, and a `kimi-k3` entry.
  - Claude Sonnet moves from 4.6 to 5; Qwen's direct flavour from `qwen3-max` to
    `qwen3.7-max`.

  Spend pricing gains per-model entries for every Workers AI model that is billed per
  token rather than by neuron. **GLM-5.2 — the architect/reviewer routing default — and the
  DeepSeek R1 distill had none, so they were metering at the near-free neuron rate and
  escaping the budget gate.**

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.12.144

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.12.143

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1

## 0.12.142

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.12.141

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0

## 0.12.140

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0

## 0.12.139

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0

## 0.12.138

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0

## 0.12.137

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/contracts@0.206.1

## 0.12.136

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0

## 0.12.135

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0

## 0.12.134

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0

## 0.12.133

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.12.132

### Patch Changes

- a7aae8a: Finish the `/api/v1` external surface: a workspace usage read, and an outbound run-lifecycle push
  so an integration stops polling.

  `GET /api/v1/usage` (a `read`-scope key) serves the current billing period as ONE resource: the
  METERED budget position the spend safeguard itself acts on — including `exceeded`, which is what
  pauses runs — plus the per-`(billing, vendor, provider, model)` breakdown behind it. Splitting it
  into two endpoints would let a caller render a breakdown against a budget read a period-roll apart.
  It reads through a new `SpendService.periodUsage`, which resolves ONE `periodStart` for both
  aggregates and still issues them concurrently: composing the response from `status()` +
  `usageBreakdown()` would have reintroduced the same skew inside one request, since each derives its
  own period from the clock.
  Rows keep their `billing` discriminator and are never summed for the caller: a `subscription` row's
  `costEstimate` is illustrative (a flat-rate plan bills nothing per token), so adding it to metered
  spend would report money nobody is billed for. Workspace tier only — the account and user budgets
  are cross-workspace, and a workspace-scoped key must never learn a sibling workspace's spend.

  The workspace's ONE registered outbound endpoint now also delivers run-lifecycle events —
  `run.started`, `run.completed`, `run.failed` — beside the notification cards it already carried,
  reaching the transport through a new kernel `RunLifecycleSink` port. This exists because the HAPPY
  path raises no notification at all: a pipeline whose `merger` merges its own PR settles with an
  empty inbox, which is exactly the outcome a CI system wants to hear about. Same row, same sealed
  secret, same SSRF guard, same retry budget: the retry/signature/redirect core moved to a shared
  `signedDelivery.ts` that both families drive, because everything interesting about a delivery is a
  property of the endpoint rather than the payload.

  **Subscribing is opt-in and empty means NONE**, deliberately the opposite of the sibling
  notification `types` filter — an endpoint registered for parked decisions must not silently start
  receiving an event per run — so an existing webhook keeps byte-for-byte its current behaviour until
  someone sets `runEvents`.

  Worth knowing when reviewing: the two edges hook different places on purpose. `run.started` fires
  from `handOffLiveRun`, the one funnel every start path ends with, and is announced LAST — after the
  block is committed and the durable runner has the run — so a slow or black-holing receiver costs the
  announcement and never the run. It is still exactly once, because the claim that precedes the
  hand-off (`insertLiveRunOrConflict`) is what mints a live run, and a start path added later inherits
  it since skipping the funnel would also skip `startRun`. The terminal edges fire from the engine's
  terminal-emit funnel, because a run reaches `done` from four independent sites and a hook at each
  would compile, pass, and drift the day a fifth is added — the cost is that a durable replay can
  re-emit a settled run, so delivery is **at-least-once** with a `<runId>:<event>` dedupe id in the
  body. **Dedupe on that id, not on the body**: a replay re-stamps `sentAt`/`occurredAt`, so two
  deliveries of one transition are not byte-identical even though everything a receiver routes on is.
  That is a considered departure from the platform's atomic-claim rule: unlike a merge or a posted
  review, a repeat here is collapsed by one id comparison, so it does not earn a claim table and the
  sweeper that would come with it.

  `docs/openapi.json` shrinks by ~17k lines in the same change, with no semantic difference beyond
  the new endpoint. The generator copied every component definition into a `$defs` block on each
  schema it inlined, so the whole component set was duplicated across ten operations and every new
  public DTO cost roughly ten times its size in the committed file. Those `$defs` resolved nothing —
  the refs are rewritten into `#/components/schemas` — and generation now asserts that every `$ref`
  names an emitted component, so a DTO that actually needs hoisting fails the build instead of
  shipping a dangling pointer.

  Schema: `notification_webhooks` gains a `run_events` JSON column (D1 migration 0072 ⇄ Drizzle),
  defaulting to `'[]'`. The webhook repository is now read on the run's terminal path, so it is
  allow-listed for mothership mode (`get`/`put`/`delete`, workspace-scoped) — an un-routed method
  there would have surfaced only as a webhook that silently never fires, since both delivery paths
  are best-effort by contract.

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1

## 0.12.131

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.12.130

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0

## 0.12.129

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0

## 0.12.128

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0

## 0.12.127

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0

## 0.12.126

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0

## 0.12.125

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.12.124

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.12.123

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0

## 0.12.122

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0

## 0.12.121

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0

## 0.12.120

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.12.119

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0

## 0.12.118

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0

## 0.12.117

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0

## 0.12.116

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0

## 0.12.115

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1

## 0.12.114

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.12.113

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.12.112

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0

## 0.12.111

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0

## 0.12.110

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0

## 0.12.109

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.12.108

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0

## 0.12.107

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0

## 0.12.106

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0

## 0.12.105

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0

## 0.12.104

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0

## 0.12.103

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0

## 0.12.102

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0

## 0.12.101

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0

## 0.12.100

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0

## 0.12.99

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/kernel@0.170.0

## 0.12.98

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0

## 0.12.97

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0

## 0.12.96

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1

## 0.12.95

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0

## 0.12.94

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0

## 0.12.93

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.12.92

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0

## 0.12.91

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0

## 0.12.90

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1

## 0.12.89

### Patch Changes

- 829a905: Add Claude Opus 5 support: the `claude-opus` catalog entry rolls forward from Opus 4.8 to
  Opus 5, with its own spend pricing and an updated OpenRouter recommended slug.

  - `@cat-factory/kernel`: `MODEL_CATALOG`'s `claude-opus` entry now resolves to Anthropic's
    **Claude Opus 5** — subscription ref `anthropic:claude-opus-5` (Claude Code harness, 1M
    context, previously left implicit) and OpenRouter ref `anthropic/claude-opus-5`. This
    mirrors how the entry already tracked the current Opus across 4.6 → 4.7 → 4.8, so a block
    pinned to `claude-opus` picks up Opus 5 with no migration. **Breaking (pre-1.0,
    acceptable):** Opus 4.8 is no longer a curated catalog entry — a workspace that wants it
    specifically reaches it through the dynamic per-workspace OpenRouter catalog.
  - `@cat-factory/kernel`: the built-in `mdp_claude` model preset is renamed to "Claude
    Opus 5" and its catalog `version` bumped to `2`, so existing workspaces get the usual
    reseed advisory for the built-in they still hold under the old name.
  - `@cat-factory/spend`: adds `anthropic:claude-opus-5` and
    `openrouter:anthropic/claude-opus-5` price entries at Opus-tier list price ($5 in / $25
    out per 1M, ~4.6 / 23 EUR). The Opus 4.8 entries are kept so historical spend rows and
    OpenRouter passthroughs still cost correctly.
  - `@cat-factory/app`: "Enable recommended" in the OpenRouter catalog panel now offers
    `anthropic/claude-opus-5` instead of `anthropic/claude-opus-4.8`, matching the curated
    backend refs.
  - `@cat-factory/cli` / `@cat-factory/local-server` / `@cat-factory/orchestration`: picker
    label and doc comments follow the catalog ("Claude Opus 5").
  - `@cat-factory/conformance`: the model-preset suite asserts the new `mdp_claude` catalog
    version.

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.12.88

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0

## 0.12.87

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0

## 0.12.86

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0

## 0.12.85

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1

## 0.12.84

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.12.83

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0

## 0.12.82

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0

## 0.12.81

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0

## 0.12.80

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0

## 0.12.79

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1

## 0.12.78

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.12.77

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0

## 0.12.76

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0

## 0.12.75

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0

## 0.12.74

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0

## 0.12.73

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0

## 0.12.72

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.12.71

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.12.70

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.12.69

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.12.68

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.12.67

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.12.66

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.12.65

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.12.64

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.12.63

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.12.62

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.12.61

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.12.60

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.12.59

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.12.58

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.12.57

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0

## 0.12.56

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.12.55

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.12.54

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.12.53

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.12.52

### Patch Changes

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.12.51

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.12.50

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.12.49

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.12.48

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.12.47

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.12.46

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.12.45

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.12.44

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0

## 0.12.43

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0

## 0.12.42

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/kernel@0.134.1

## 0.12.41

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0

## 0.12.40

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0

## 0.12.39

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0

## 0.12.38

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0

## 0.12.37

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0

## 0.12.36

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/kernel@0.129.2

## 0.12.35

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.12.34

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0

## 0.12.33

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/kernel@0.128.1

## 0.12.32

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/contracts@0.132.0

## 0.12.31

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0

## 0.12.30

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0

## 0.12.29

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0

## 0.12.28

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.12.27

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3

## 0.12.26

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1

## 0.12.25

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.12.24

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.12.23

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0

## 0.12.22

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.12.21

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.12.20

### Patch Changes

- 67dccb6: perf(caching): route workspace-settings and spend budget reads through the app cache seam (perf-tracker items 7 & 9)

  Replaces `SpendService`'s three homebrew `{ value, expiresAt }` TTL `Map`s (pricing /
  account limit / user limit) and the uncached `WorkspaceSettingsService.get` with three new
  `AppCaches` slices — `workspaceSettings`, `accountBudgetLimit`, `userBudgetLimit` — so these
  slow-moving reads are coherent across a horizontally-scaled Node deployment (a budget/settings
  edit invalidates every replica via the notification bus instead of leaving peers stale for the
  TTL). The workspace-settings row is now read through a single shared slice by
  `WorkspaceSettingsService`, `SpendService`'s pricing overlay, and
  `LlmObservabilityService.bodiesEnabled`, so one invalidation on `WorkspaceSettingsService.update`
  covers them all. The slices are pass-through on the Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate bus).

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.12.19

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/contracts@0.127.1
  - @cat-factory/kernel@0.121.5

## 0.12.18

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.12.17

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.12.16

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/kernel@0.121.2

## 0.12.15

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.12.14

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.12.13

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.12.12

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.12.11

### Patch Changes

- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/kernel@0.118.1

## 0.12.10

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0

## 0.12.9

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6

## 0.12.8

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.12.7

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/kernel@0.117.4

## 0.12.6

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.12.5

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1

## 0.12.4

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.12.3

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.12.2

### Patch Changes

- 51869b8: Add Claude Fable 5 to the model catalog. `claude-fable` runs via the Claude Code
  subscription harness (Anthropic's most capable model, 1M context) with an
  OpenRouter pay-as-you-go flavour, mirrors the existing `claude-opus` entry, and
  carries its own spend pricing ($10 in / $50 out per 1M) plus an OpenRouter
  recommended-slug entry.
- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.12.1

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.12.0

### Minor Changes

- a0c6934: Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
  (usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
  `billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
  harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
  the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
  every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
  `billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
  inflates spend or trips a budget.

  New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
  `(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
  (both metered and subscription usage, with per-model progress bars). Subscription cost is
  illustrative (the equivalent metered-API cost), never billed.

  D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
  cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
  data migration — existing rows default to `metered`.

  (The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
  `TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
  runner image changed.)

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0

## 0.11.24

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0

## 0.11.23

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/contracts@0.121.2

## 0.11.22

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.11.21

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.11.20

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/kernel@0.111.1

## 0.11.19

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/contracts@0.121.0

## 0.11.18

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.11.17

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0

## 0.11.16

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.11.15

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0

## 0.11.14

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.11.13

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.11.12

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.11.11

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0
  - @cat-factory/contracts@0.118.0

## 0.11.10

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/contracts@0.117.0
  - @cat-factory/kernel@0.104.4

## 0.11.9

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/kernel@0.104.3

## 0.11.8

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/kernel@0.104.2

## 0.11.7

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/contracts@0.115.0
  - @cat-factory/kernel@0.104.1

## 0.11.6

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/kernel@0.104.0

## 0.11.5

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0

## 0.11.4

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0

## 0.11.3

### Patch Changes

- Updated dependencies [fdba1ea]
  - @cat-factory/contracts@0.111.0
  - @cat-factory/kernel@0.101.2

## 0.11.2

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1

## 0.11.1

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0

## 0.11.0

### Minor Changes

- 9ea1e77: Tiered spend budgets (account / workspace / user) with operator hard caps.

  Budgets are now tracked and enforced across three tiers: the existing per-workspace
  monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
  tier is exhausted. All three tiers are configurable and visible in the Budget settings
  screen.

  Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
  `BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
  operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
  shows it on the budget screen. See `docs/environment-variables.md` and
  `docs/initiatives/tiered-budgets.md`.

  Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
  `account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
  account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
  `SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
  A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
  budget.

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0

## 0.10.109

### Patch Changes

- Updated dependencies [e66accb]
  - @cat-factory/contracts@0.108.1
  - @cat-factory/kernel@0.99.1

## 0.10.108

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/contracts@0.108.0

## 0.10.107

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/contracts@0.107.0
  - @cat-factory/kernel@0.98.0

## 0.10.106

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0

## 0.10.105

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0

## 0.10.104

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0

## 0.10.103

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0

## 0.10.102

### Patch Changes

- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0
  - @cat-factory/contracts@0.102.0

## 0.10.101

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/kernel@0.92.0

## 0.10.100

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0

## 0.10.99

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0

## 0.10.98

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/kernel@0.89.1

## 0.10.97

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0

## 0.10.96

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.10.95

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.10.94

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/kernel@0.86.1

## 0.10.93

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0

## 0.10.92

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.10.91

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.10.90

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.10.89

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0

## 0.10.88

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0

## 0.10.87

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0

## 0.10.86

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/kernel@0.79.1

## 0.10.85

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0

## 0.10.84

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0

## 0.10.83

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0

## 0.10.82

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0

## 0.10.81

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0

## 0.10.80

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0

## 0.10.79

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.10.78

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0

## 0.10.77

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/kernel@0.71.0

## 0.10.76

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2

## 0.10.75

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.10.74

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.10.73

### Patch Changes

- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/kernel@0.69.8

## 0.10.72

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.10.71

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/kernel@0.69.6

## 0.10.70

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/kernel@0.69.5

## 0.10.69

### Patch Changes

- Updated dependencies [2a91615]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/kernel@0.69.4

## 0.10.68

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/kernel@0.69.3

## 0.10.67

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/contracts@0.80.1

## 0.10.66

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/kernel@0.69.1

## 0.10.65

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0

## 0.10.64

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1

## 0.10.63

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0

## 0.10.62

### Patch Changes

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [6c51e31]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/kernel@0.67.0

## 0.10.61

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/kernel@0.66.1

## 0.10.60

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0

## 0.10.59

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0

## 0.10.58

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0

## 0.10.57

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/kernel@0.63.4

## 0.10.56

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/kernel@0.63.3

## 0.10.55

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2

## 0.10.54

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/kernel@0.63.1

## 0.10.53

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0

## 0.10.52

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/kernel@0.62.4

## 0.10.51

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/kernel@0.62.3

## 0.10.50

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/kernel@0.62.2

## 0.10.49

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/kernel@0.62.1

## 0.10.48

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/contracts@0.65.0
  - @cat-factory/kernel@0.62.0

## 0.10.47

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/kernel@0.61.1

## 0.10.46

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0

## 0.10.45

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0

## 0.10.44

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0

## 0.10.43

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0

## 0.10.42

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.10.41

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0

## 0.10.40

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/contracts@0.58.0
  - @cat-factory/kernel@0.56.1

## 0.10.39

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0

## 0.10.38

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.10.37

### Patch Changes

- Updated dependencies [21b2096]
  - @cat-factory/contracts@0.56.1
  - @cat-factory/kernel@0.55.3

## 0.10.36

### Patch Changes

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/kernel@0.55.2

## 0.10.35

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/kernel@0.55.1

## 0.10.34

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0
  - @cat-factory/contracts@0.54.0

## 0.10.33

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0

## 0.10.32

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/kernel@0.53.1

## 0.10.31

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0

## 0.10.30

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1

## 0.10.29

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0

## 0.10.28

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0

## 0.10.27

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0

## 0.10.26

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0

## 0.10.25

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/contracts@0.46.0
  - @cat-factory/kernel@0.47.2

## 0.10.24

### Patch Changes

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/kernel@0.47.1

## 0.10.23

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0

## 0.10.22

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0

## 0.10.21

### Patch Changes

- Updated dependencies [8fad695]
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5

## 0.10.20

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/kernel@0.45.4

## 0.10.19

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.10.18

### Patch Changes

- c11a0cc: Add a `prepublishOnly` build hook so each package is compiled to `dist/` before it is
  packed, regardless of how publish is invoked. `dist/` is gitignored and was only built by
  the canonical `pnpm ci:publish` flow, so a bare `pnpm publish` could ship an empty shell
  (this is what happened to `@cat-factory/gitlab` and `@cat-factory/provider-s3`). The hook
  removes that footgun for every publishable library.
- Updated dependencies [c11a0cc]
  - @cat-factory/contracts@0.43.1
  - @cat-factory/kernel@0.45.2

## 0.10.17

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.10.16

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0

## 0.10.15

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0

## 0.10.14

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.10.13

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/kernel@0.42.2

## 0.10.12

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1

## 0.10.11

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/contracts@0.40.0

## 0.10.10

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0

## 0.10.9

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0

## 0.10.8

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0

## 0.10.7

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/kernel@0.38.1

## 0.10.6

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0

## 0.10.5

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0

## 0.10.4

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0

## 0.10.3

### Patch Changes

- Updated dependencies [eb48652]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0

## 0.10.2

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0

## 0.10.1

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0

## 0.10.0

### Minor Changes

- b82304e: Remove per-model price overrides from the workspace budget. A workspace's budget is
  now just a currency + monthly limit overlaid on the built-in `DEFAULT_SPEND_PRICING`
  table; the `spendModelPrices` setting, its contracts/schemas, and the
  `workspace_settings.spend_model_prices` column (D1 + Postgres) are dropped. Also fixes
  the budget save in the UI throwing `spendMonthlyLimit.trim is not a function` when the
  number input emits a numeric value.

  **Breaking:** the `spend_model_prices` column is dropped on both runtimes with no
  migration of existing override data (pre-1.0); any stored overrides are discarded and
  budgets fall back to the built-in price table.

### Patch Changes

- Updated dependencies [b82304e]
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0

## 0.9.5

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0

## 0.9.4

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0

## 0.9.3

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0

## 0.9.2

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/kernel@0.28.1

## 0.9.1

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0

## 0.9.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0

## 0.8.26

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1

## 0.8.25

### Patch Changes

- 2aae8bc: Fix the OpenRouter key panel falsely reporting "connected" on a rejected key, and add Kimi K2.7 as a curated OpenRouter model.

  - The OpenRouter setup panel (`OpenRouterCatalogPanel`) used to fire its "OpenRouter key connected" success toast — and flip the panel into the connected state — _before_ probing OpenRouter, since the save endpoint stores keys without validating them. A wrong/expired key therefore showed a 401 "could not reach OpenRouter" toast **and** a "connected" status simultaneously. `connectKey` now probes OpenRouter with the freshly stored key first, only announces success when it's reachable, and rolls the key back on rejection so the form stays for a retry. (The Vendors & keys → Proxies screen shares the same store-only save codepath; it never showed the bug because it doesn't probe OpenRouter after saving.)
  - `kimi-k2.7` now carries an `openrouter` flavour (`moonshotai/kimi-k2.7-code`, 256K context per OpenRouter's catalog), so it routes through the OpenRouter gateway out of the box once an OpenRouter key is connected. It's added to the OpenRouter panel's "Enable recommended" slugs and the spend price table (billed at Moonshot's upstream rates).

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0

## 0.8.24

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0

## 0.8.23

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0

## 0.8.22

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0

## 0.8.21

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0

## 0.8.20

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0

## 0.8.19

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0

## 0.8.18

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0

## 0.8.17

### Patch Changes

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0

## 0.8.16

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0

## 0.8.15

### Patch Changes

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2

## 0.8.14

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/kernel@0.16.1

## 0.8.13

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0

## 0.8.12

### Patch Changes

- Updated dependencies [494fb34]
  - @cat-factory/kernel@0.15.1

## 0.8.11

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0

## 0.8.10

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0

## 0.8.9

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/kernel@0.13.4

## 0.8.8

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/kernel@0.13.3

## 0.8.7

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2

## 0.8.6

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/kernel@0.13.1

## 0.8.5

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0

## 0.8.4

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/contracts@0.12.0

## 0.8.3

### Patch Changes

- Updated dependencies [f8a24e0]
  - @cat-factory/kernel@0.11.1

## 0.8.2

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0

## 0.8.1

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/kernel@0.10.1

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0

## 0.7.5

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0

## 0.7.4

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0

## 0.7.3

### Patch Changes

- a0a1bcc: Add Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`) to the model catalog as a Cloudflare-only
  entry (256K context) with its spend pricing. Cloudflare lists K2.5 at $0.60 in / $3.00
  out per 1M, below the K2.6/K2.7 rate, so without an explicit price entry it would fall
  back to the near-free `workers-ai` neuron rate and meter at ~0.

  Default the `conflict-resolver` agent kind to Kimi K2.5 on both runtimes (Worker + Node).
  The conflict-resolver rewrites conflicted hunks against the base, a focused diff-heavy
  reasoning task the small default MoE handles poorly. Operators can still override via
  `AGENT_MODELS`.

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1

## 0.7.0

### Minor Changes

- 4a08935: Add **OpenRouter** and **LiteLLM** as model providers. Both are OpenAI-compatible, so
  they reuse the existing inlined `openAiCompatibleResolver` path (no new dependency, no
  dedicated package) and work for both inline engine calls and container coding agents via
  the LLM proxy. Keys are onboarded per workspace/user through the UI key pool like the
  other direct vendors; their base URLs are deployment config — OpenRouter defaults to the
  public gateway (`OPENROUTER_BASE_URL` override optional), while LiteLLM is operator-hosted
  so `LITELLM_BASE_URL` is required to enable it. Ships curated, direct-only catalog entries
  (OpenRouter: Claude Opus, Gemini 3 Pro, GPT-5.5, DeepSeek, Llama 3.3; LiteLLM: a generic
  gateway-default entry) with approximate pricing/context, overridable via
  `SPEND_MODEL_PRICES`.

  Catalog selectability now also gates on a **resolvable base URL**: an OpenAI-compatible
  provider (everything but `openai`/`anthropic`) is only offered once its base URL resolves,
  so a LiteLLM model stays unselectable — and a pipeline using it is blocked at start —
  until `LITELLM_BASE_URL` is set, instead of passing the guard and throwing "No base URL
  configured" mid-run. Wired symmetrically into both facades' capability resolution.

  **Wire change:** `apiKeyProviderSchema` is widened with `'openrouter'` and `'litellm'`.

- 6406c8c: Extract `@cat-factory/spend` — pricing tables and spend metering/gating are now a standalone package. `@cat-factory/core` re-exports the full public surface for backward compatibility; the acceptance test and worker's spending config now import directly from `@cat-factory/spend`, narrowing the CI container-acceptance gate from `backend/packages/core/**` to `backend/packages/spend/**`.

### Patch Changes

- 8eed38c: Author relative imports with explicit `.js` extensions across the shared backend
  packages so their emitted `dist` is directly resolvable by Node's ESM loader (no
  bundler required). This lets the Node runtime run the built output on plain Node
  (`node dist/main.js`) — no tsx, no esbuild bundle — and is inert for the Cloudflare
  Worker (wrangler bundles regardless). `handlebars/runtime` is imported as
  `handlebars/runtime.js` for the same reason (its type is sourced from the full
  package, type-only). No behaviour or public-API change.
- 7c37653: Expand the model picker, route AI Gateway catalog models, and default the
  implementer (coder) to the latest Kimi.

  - The picker catalog (`MODEL_CATALOG`) gains three Cloudflare-served entries:
    `kimi-k2.7` (`@cf/moonshotai/kimi-k2.7-code`), `glm` (`@cf/zai-org/glm-5.2`,
    262K context) and `deepseek-v4-pro` (`deepseek/deepseek-v4-pro`, 131K context).
    The existing DeepSeek reasoning entry is relabelled `DeepSeek R1`.
  - The Workers AI upstream now serves `<provider>/<model>` AI-catalog slugs like
    `deepseek/deepseek-v4-pro` (a unified-billing run-catalog model Cloudflare serves
    via Fireworks) by calling `binding.run` directly in the OpenAI Chat Completions
    shape, with the account's own token — no AI Gateway, no BYOK. A `@cf/...` Workers AI
    id is unaffected (still routed through the AI SDK).
  - The build phase (`coder`) now defaults to Kimi K2.7 instead of GLM-5.2. GLM-5.2
    on Workers AI was observed emitting malformed tool calls (`write` with no `path`)
    and looping until the harness no-progress guard aborted; design/review
    (`architect`/`reviewer`) stay on GLM-5.2. Operators can still override per kind
    via `AGENT_MODELS`.
  - Spend pricing gains an approximate entry for `workers-ai:deepseek/deepseek-v4-pro`
    (a partner model billed at provider rates, not the near-free neuron rate).

- 56ee67d: Price Cloudflare Workers AI Kimi models (`@cf/moonshotai/kimi-k2.6` and
  `@cf/moonshotai/kimi-k2.7-code`) at Cloudflare's published Workers AI per-token
  rate ($0.95 in / $4.00 out per 1M, USD→EUR ~0.92) instead of letting them fall
  through to the near-free `workers-ai` neuron rate. Kimi K2.7 is the default coder,
  so without explicit `workers-ai:@cf/moonshotai/...` entries every Cloudflare-Kimi
  run metered at 0.1/0.1 EUR per million tokens and showed spend as ~0.00. Mirrors
  the existing partner-model exception for `deepseek-v4-pro`.
- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- Updated dependencies [fe53445]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [268c15d]
- Updated dependencies [157cd02]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [8807f5c]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [4a08935]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [3a12f15]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2d66d34]
- Updated dependencies [a54ada2]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/kernel@0.7.0
