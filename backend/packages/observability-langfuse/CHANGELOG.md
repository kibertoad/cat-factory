# @cat-factory/observability-langfuse

## 0.11.44

### Patch Changes

- Updated dependencies [2ae7e2b]
  - @cat-factory/kernel@0.343.0
  - @cat-factory/observability-otel@0.23.37

## 0.11.43

### Patch Changes

- @cat-factory/kernel@0.342.1
  - @cat-factory/observability-otel@0.23.36

## 0.11.42

### Patch Changes

- Updated dependencies [ca5be97]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/observability-otel@0.23.35

## 0.11.41

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/kernel@0.341.0
  - @cat-factory/observability-otel@0.23.34

## 0.11.40

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/kernel@0.340.0
  - @cat-factory/observability-otel@0.23.33

## 0.11.39

### Patch Changes

- 636fcf3: Re-verify every curated model route against its serving provider, take the agent CLIs at their
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
- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0
  - @cat-factory/observability-otel@0.23.32

## 0.11.38

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0
  - @cat-factory/observability-otel@0.23.31

## 0.11.37

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/kernel@0.337.0
  - @cat-factory/observability-otel@0.23.30

## 0.11.36

### Patch Changes

- Updated dependencies [5c50d30]
  - @cat-factory/kernel@0.336.1
  - @cat-factory/observability-otel@0.23.29

## 0.11.35

### Patch Changes

- cd220f2: Add five catalog models, take the agent CLIs at their newest, and refresh the dependency tree.
  
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
- Updated dependencies [cd220f2]
  - @cat-factory/kernel@0.336.0
  - @cat-factory/observability-otel@0.23.28

## 0.11.34

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/observability-otel@0.23.27

## 0.11.33

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/kernel@0.335.0
  - @cat-factory/observability-otel@0.23.26

## 0.11.32

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/kernel@0.334.0
  - @cat-factory/observability-otel@0.23.25

## 0.11.31

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/kernel@0.333.0
  - @cat-factory/observability-otel@0.23.24

## 0.11.30

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/kernel@0.332.0
  - @cat-factory/observability-otel@0.23.23

## 0.11.29

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/kernel@0.331.0
  - @cat-factory/observability-otel@0.23.22

## 0.11.28

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/kernel@0.330.0
  - @cat-factory/observability-otel@0.23.21

## 0.11.27

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/kernel@0.329.0
  - @cat-factory/observability-otel@0.23.20

## 0.11.26

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/kernel@0.328.0
  - @cat-factory/observability-otel@0.23.19

## 0.11.25

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/kernel@0.327.0
  - @cat-factory/observability-otel@0.23.18

## 0.11.24

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/kernel@0.326.0
  - @cat-factory/observability-otel@0.23.17

## 0.11.23

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/kernel@0.325.0
  - @cat-factory/observability-otel@0.23.16

## 0.11.22

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/kernel@0.324.0
  - @cat-factory/observability-otel@0.23.15

## 0.11.21

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2
  - @cat-factory/observability-otel@0.23.14

## 0.11.20

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1
  - @cat-factory/observability-otel@0.23.13

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
