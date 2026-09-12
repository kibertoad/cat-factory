# @cat-factory/executor-harness

## 1.159.0

### Minor Changes

- 9f8cabc: Re-point the DeepSeek Flash route at the model DeepSeek actually serves, take the agent CLIs at
  their newest, and refresh the dependency tree.
  
  **A retired model behind a live alias.** DeepSeek retired V4-Flash and V4-Flash-Vision-Exp on
  2026-09-10 and made `deepseek-flash` the canonical, unversioned name for V4.1-Flash. The old
  `deepseek-v4-flash` id still resolves, but only as a TEMPORARY compatibility alias onto the new
  model, which is the quietest shape this catalog's failures take: nothing throws and nothing fails
  to dispatch, so the picker went on saying "DeepSeek V4 Flash" while a different model answered, at
  a rate the spend table did not carry, and the route dies outright whenever the alias is withdrawn.
  All three DeepSeek-served arms of the `deepseek` entry (direct, subscription, and the OpenRouter
  one, which must name the same model or the entry straddles two) now name the live model. The entry
  keeps its `deepseek` id: that id is what a workspace persists against a block, and this is the same
  slot following the vendor's own successor, so re-minting it would invalidate every stored pick to
  say nothing new. `acceptsImages` is new on both refs and is a real capability gain rather than a
  correction, since V4.1-Flash folds the vision line back into the main model.
  
  Two adjacent claims were re-read rather than trusted. The 2026-09-10 release note said
  `deepseek-v4-pro` would route to V4.1-Flash from 2026-09-14, which would have silently demoted that
  entry to a cheaper, weaker model; DeepSeek has since decided to keep serving V4 Pro with billing
  unchanged, so it is untouched. And OpenRouter still serves a separate `deepseek/deepseek-v4-flash`
  at a fifth of the price, which this entry deliberately does not keep: it is the retired build, and
  an entry whose direct and gateway arms named different models is the neighbouring-version trap the
  catalog header bans. Both retired price keys stay in the table so historical spend rows keep
  costing correctly.
  
  **No other catalog gap.** Every frontier launch since the last sweep was checked against its
  serving provider and is already here: Claude Fable 5.1, Gemini 3.8 Flash, Muse Spark 1.3 and GPT-6
  Astra. Claude Mythos 5.1 stays out on purpose. It is the same model as Fable 5.1 at identical
  pricing, offered by invitation only through Project Glasswing with no public route on any provider
  this platform reaches, so an entry could only be a re-badge that `effectiveVariant` would pick and
  then fail to dispatch. "Astra Pro" stays out for the reason recorded last time, re-checked here:
  OpenRouter mints a slug for it, but reasoning effort is a parameter on the single `gpt-6-astra` id.
  
  **Agent CLIs at their newest**, ahead of the 24h `minimumReleaseAge` window, as the Dockerfile's
  standing note allows for those three pins alone: Claude Code 2.1.265 to 2.1.270 and Codex 0.153.4
  to 0.154.0 (still above the 0.153.0 floor `gpt-6-astra` needs). Pi holds at 0.85.1, already newest.
  The two Pi extensions do NOT take that exemption and hold at 2.9.0: 2.10.0 published three hours
  before this change and has not aged past the window. Both harness images move to the newest
  `node:26-trixie-slim` digest that has (node 26.8.2), and the executor image tag rolls to 1.158.0
  with the deploy image at 0.6.8.
  
  **Dependency refresh**: direct ranges plus a lockfile re-resolution, 31 resolved names moved, no
  package name dropped. `pg-boss` 12.31.0 brings `rrule-temporal` and `temporal-spec` in as new
  transitive deps, the only additions. A `pnpm dedupe` follows the bump because the partial
  re-resolution left `@types/node` resolved at two patch versions. Four holds are unchanged and were
  re-verified at HEAD rather than assumed: `vitest` at 4.1.11 and `wrangler` at 4.124.0
  (`@cloudflare/vitest-pool-workers` 0.22.0 is still newest, peers `vitest: ^4.1.0` and pins that
  wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the resolved workerd's date, which
  that pool pins), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 reaches for
  `typescript/lib/tsc`, absent from TS 7's exports map). pnpm moves 11.24.0 to 11.26.0, staying on
  its major. WireMock holds at 3.13.1, still its newest non-prerelease. Actions: `setup-java` v6.0.0
  to v6.0.1 and `zizmor-action` v0.6.3 to v0.6.4; every other pinned action is already newest.

## 1.157.0

### Minor Changes

- 333b967: Meter every two-band model in the band its prompt actually lands in, check the cache classes the
  table DERIVES, take the agent CLIs at their newest, and refresh the dependency tree.
  
  **Six rows were metering a long-context request at half its input rate.** OpenAI bills a request
  whose prompt reaches 272,000 input tokens entirely at roughly double the short rate, with no
  blending, and Gemini 3.1 Pro does the same at 200,000 tokens. Every OpenAI row and the Gemini Pro
  row carried the SHORT band, so a long-prompt run metered at half its input and around 60% of its
  output. The catalog gives all six entries a window over a million tokens, so a container agent
  re-sending a large checkout crosses that threshold as ordinary behaviour, not as an edge case.
  
  **`ModelPrice` now carries both bands, and the meter picks between them.** A two-band row states
  its base rates plus a `longBand` (rates, cache tiers and the threshold), `bandFor` selects on the
  request's total input, and both metering entry points already hold that count: `estimateCost` gets
  `inputTokens`, and `estimateClassedCost` sums the three input classes, because a vendor's threshold
  is stated against the whole request and a 300K prompt served mostly from cache crosses it all the
  same. Ten OpenAI rows, Gemini 3.1 Pro and the three Grok 4.6 rows carry a band, and each band's
  cache tiers derive from that band's own input rate. A caller that cannot see the prompt size, which
  is the telemetry rollup's rate resolver, still gets the DEARER band: of the two answers open to it,
  only that one keeps a budget safe.
  
  Pricing the whole row at the long band instead is worse in both directions the figure is read. A
  short-prompt run meters at roughly double its cost, which on inline judges and estimators is the
  majority of calls and trips a workspace ceiling at half its real spend. The same rows are also the
  picker's informational list price, rendered with no band annotation, so GPT-6 Astra would read
  18.4/69 beside Claude Fable 5 at 9.2/46 while both bill $10/$50 at ordinary prompt lengths.
  `modelCostResolver` stays on the base band for that reason, and the split between `priceFor` (the
  list price a human compares) and `ratesFor` (the rate a budget meters) is now stated at both.
  
  The DYNAMIC per-workspace OpenRouter overlay still folds a model's bands to their maximum
  (`dearestRate`), because which band applies depends on the prompt actually sent and a catalog
  refresh has none to read. So enabling a two-band model in a workspace catalog meters its short
  requests conservatively where the curated row prices each band exactly; carrying the threshold
  through the catalog metadata is what would close that.
  
  **A DERIVED cache rate can understate the live one, and nothing was checking it.** A row names a
  cache rate only where the vendor departs from the `CACHE_*_MULTIPLIER` floor, and
  `check-openrouter-pins.mjs` skipped every unnamed class on the grounds that a derived figure has no
  pin to have drifted. The derived figure is still what the budget meters with, and it follows OUR
  input rate rather than the vendor's cache rate: `openrouter:z-ai/glm-5.3` was metering cache reads
  at 54% of the live rate while the report said "nothing to do", on the class a container agent's
  re-sent prefix lands in every turn. That row now names its rate, and the check compares the
  EFFECTIVE rate for four classes rather than the pinned numbers for three.
  
  Three things keep that from becoming noise. A cache class is compared only where a hit can actually
  land on the route, read out of the contracts `GATEWAY_PREFIX_POLICY` rather than restated, and the
  gate covers a NAMED rate as well as a derived one: a figure no hit reaches is inert however it was
  obtained, which is what `pricing.test.ts` already records for the two Alibaba slugs. The live side
  is read band for band, so a row priced correctly in both bands reports nothing rather than flagging
  its short band on every run. And the pinned THRESHOLD is checked as well, against the lowest
  `min_prompt_tokens` the route publishes: pinned above the live one, every request between the two
  meters in a band the vendor has stopped charging.
  
  Three parser fixes came with it, each of which silenced a comparison rather than breaking one. The
  policy-map and price-row readers count braces and skip comments and strings, where a `[^}]*` match
  ends the policy map at the `{@link}` reference sitting between its entries (leaving every vendor
  declared below that line invisible) and would end a price row at its nested band's closing brace.
  The cache-WRITE class reads `input_cache_write_1h` as a fallback, the order `cacheWriteRate`
  applies on the dynamic path, so a route publishing only the long TTL is compared instead of passing
  by default. And a non-array `overrides` is treated as no bands rather than thrown on, because a
  throw exits 1, which is this script's reserved signal for a pinned route that was withdrawn.
  
  `openrouter:moonshotai/kimi-k2.7-code` is re-pinned from $0.674 / $3.40 to the $0.71 / $3.50 the
  gateway's blend reads today, and its named cache read to 0.18: 0.17 sat under the 0.1748 the
  conversion gives by more than the checker's rounding tolerance. The two Workers AI Kimi rows that
  round the same vendor figures are corrected with it. The DeepSeek alias rows are re-stamped and
  deliberately not moved: both now sit above their live rate, and Pro has swung $0.556 to $1.60 to
  $0.946 across three reads in a fortnight, so chasing that blend down would spend the table's margin
  on noise.
  
  **Every other rate was re-read and is unchanged**, against each vendor's own list rather than
  inferred: Anthropic, the twelve Workers AI partner rows, Z.ai, Moonshot K3 and K2.6, DeepSeek's
  peak bands, xAI, Qwen3.8 Max and Flash. Two prose corrections came out of it. Gemini 3.7 Flash's
  half-rate promotion has lapsed on the gateway, so the row's deliberate over-count against it no
  longer describes anything, and all three Flash routes now serve at the list price the rows carry.
  Qwen3.8 Max is confirmed flat across its whole 1M window, unlike most of the Qwen line.
  
  **No major model is missing.** Everything shipped between 2026-09-01 and 2026-09-04 is already in
  the catalog, and every one of the 27 curated OpenRouter routes is still served at the context
  window it declares. Three re-checked and still not added: GPT-6 Astra Pro carries the same
  $10 / $50 short band, the same $20 / $75 long band and the same 1,050,000-token window as
  `gpt-6-astra`, and OpenAI's pricing page lists no row for it, so an entry could only re-badge a
  model already here; Claude Mythos 5.1 is limited-availability; and Mercury 2.5, the one text model
  the gateway has gained since, is a new vendor family rather than a frontier route.
  
  Pi holds at 0.85.1, Codex at 0.153.4 and both Pi extensions at 2.9.0, each already newest. Claude
  Code goes 2.1.263 to 2.1.265, taking its newest release ahead of the 24h age window as the
  Dockerfile's standing note allows. Playwright holds at 1.63.0 and WireMock at 3.13.1, both still
  newest stable. `node:26-trixie-slim` still resolves to the pinned digest, so no base image moved.
  The executor image tag rolls to 1.156.0, and the DEPLOY image tag to 0.6.6: the dependency refresh
  reaches the deploy harness's own `@types/node` range, which is an image source, and republishing
  over a live tag does not roll a deployment out.
  
  Dependency refresh: direct ranges plus a lockfile re-resolution, 75 resolved names moved, no
  package name added or dropped, and three names that had two copies now have one. `@clack/prompts`
  1.8.0 needed one source change: `isCancel` narrows to a UNIQUE symbol while the prompts still
  return the wide `symbol`, so control flow cannot subtract one from the other. The CLI's single
  cancel seam supplies the second half itself (`isCancel(value) || typeof value === 'symbol'`), which
  narrows to `T` with no assertion and also exits cleanly on a cancel symbol minted by a second copy
  of `@clack/core`, where an assertion would hand that symbol back to a caller about to call `.trim()`
  on it. Four holds are unchanged and were re-verified at HEAD:
  vitest at 4.1.11 and wrangler at 4.124.0 (vitest-pool-workers 0.22.0 is still newest, peers
  `vitest: ^4.1.0` and pins that wrangler exactly), `@cloudflare/workers-types` at 5.20260815.1 (the
  resolved workerd's date), and frontend TypeScript at 6.0.3 (vue-tsc 3.3.11 is still newest and
  calls `require.resolve('typescript/lib/tsc')`, absent from TS 7's exports map). Actions:
  changesets/action v2.1.1 to v2.1.2, the only one that moved.

## 1.155.0

### Minor Changes

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

## 1.153.0

### Minor Changes

- 386c4a2: Add GPT-6 Astra to the curated catalog, take the agent CLIs at their newest, and refresh the
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
  no package name added or dropped. Four holds, each on a live constraint rather than caution, and
  the first three are one constraint at three levels:
  
  - vitest and `@vitest/coverage-v8` stay on 4.1.11: `@cloudflare/vitest-pool-workers` 0.22.0 is the
    newest release and still peers `vitest: ^4.1.0`.
  - wrangler holds at 4.124.0 for the sixth round, pinned exactly as a dependency of that same package.
  - `@cloudflare/workers-types` holds at 5.20260815.1, one level further down. Its version encodes a
    workerd DATE and the wrangler above pins `workerd@1.20260815.1`, so moving the types to
    5.20260904.1 would describe a runtime three weeks newer than the one that actually executes: an
    API added in the gap typechecks green and throws in production. That is the whole reason
    `check-cloudflare-runtime-pins` exists, and it is what caught the attempt.
  - TypeScript holds at 6.0.3 on the frontend, where `vue-tsc` resolves `typescript/lib/tsc`, which
    TS 7 no longer exports.

## 1.151.0

### Minor Changes

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

## 1.149.0

### Minor Changes

- 3b11b10: Give the runner image's nested containers a network again, and measure it before claiming one
  
  The image started its rootless daemon with `--iptables=false` unconditionally. That flag arrived
  because the daemon could not start at all without it in a sandbox like Cloudflare Containers, and
  it did fix that. What went unnoticed is what it costs once the daemon DOES start: the rule it
  drops is the MASQUERADE for the bridge, so traffic from a nested container is never NATed and the
  container has no egress whatsoever, no DNS and no raw IP either. The daemon's own `docker pull`
  keeps working, which is most of why it stayed hidden, and the cost lands on the thing agents do
  constantly. On the run that exposed this, a coder's first `docker build` spent 426s inside
  `RUN npm ci` before failing, and from outside it read as a hang: the heartbeat stayed fresh,
  `lastActivityAt` moved, and nothing was logged between the job starting and the failure.
  
  The flag is now a fallback rather than a premise. The entrypoint starts the daemon that manages
  its own firewall rules and only starts the crippled one when the first one EXITS without serving,
  which is the one piece of evidence that is actually about its flags: a sandbox with no iptables
  binary and no NAT module does not slow the daemon down, it makes `dockerd` exit at once. A first
  arm that is merely slow keeps the rest of the readiness budget, because a clock says nothing about
  firewall rules and swapping there would take a capable daemon away from a cold sandbox for the
  container's whole life; a first arm that never answers is recorded as undecided and LEFT RUNNING,
  so `resolveDockerVerdict`'s live re-probe can still find it, with its NAT. A sandbox that genuinely
  cannot do iptables ends up exactly where it was; a privileged Docker or Podman host, which is what
  local mode runs on, gets working nested networking.
  
  Each arm gets its OWN rootlesskit state directory, image store and pid file, and the abandon path
  waits for the process to be gone after `kill -9` rather than returning the moment the parent is
  reaped. Both matter for the same reason: SIGKILL is not propagated, so a launcher that had already
  forked the real `dockerd` dies while its child holds a lock on the shared data root and a live pid
  file, and the replacement then fails for a reason that has nothing to do with why it was started.
  That is the worst outcome available here, since both arms record `failed` and the container ends up
  with no daemon at all where before it had a working crippled one. The two arms record different
  `reason` words, and the fallback's detail states only what was OBSERVED (the first daemon exited)
  rather than naming iptables as the cause, which nothing in the entrypoint measures; the real cause
  is the daemon's own log tail, which now rides the stderr line announcing the switch.
  
  The other half is that nothing could see this. The container check runs a container, which is
  strictly better than asking the daemon about itself, and it still cannot see a daemon whose
  containers have no network, because loading and running a local image needs none: the harness
  reported `dockerDaemon: "usable"` on every published image and told each agent, as stated fact, in
  a block that also says not to spend turns re-checking it, that `docker build` works there. So a
  `usable` verdict now carries what a SECOND container, on the default network, could reach:
  `reachable`, `blocked` (with a detail separating no route at all from a route with broken DNS) or
  `undetermined`. It rides `GET /health`, the agent's environment inventory and the Tester step's
  own `infraSetup.dockerEgress`, so the record a human reads no longer shows the same
  undifferentiated `usable` for a daemon whose containers cannot fetch anything. Which commands the
  inventory claims now comes FROM that verdict rather than being stated and then retracted one
  sentence later, and the `blocked` wording is precise about which break, since the daemon does still
  pull base images and only the `RUN` lines that fetch from the public internet fail.
  
  Same asymmetry as the daemon verdict: a busybox without the applet, an unreadable target setting, a
  container that printed nothing and a daemon that refused to start the egress container at all are
  facts about the platform's own check and are never reported as an absent network, and a name that
  resolved while the configured address was refused is undetermined rather than blocked, because a
  deployment that filters that address is likelier than one with no route. An undetermined verdict
  now says whether asking again could ANSWER differently: a timeout is re-measured, while a rejected
  setting, a payload with no `nc` and a filtered address are latched, because re-running two
  container starts and an image load per job never converges on a cause that cannot change under a
  running container.
  
  The connect probe no longer reads a bare `nc -w` exit status as evidence. busybox documents that
  flag as the timeout for connects AND FINAL NET READS, so a connect that SUCCEEDED to a peer which
  expects the client to speak first (every TLS port, the default `1.1.1.1:443` included) hits the
  alarm and exits non-zero, which is indistinguishable from a refusal. It uses `-z` where the
  payload's busybox has it and no `-w` where it does not, and wraps both halves in `busybox timeout`.
  
  New knobs, all optional: `HARNESS_DOCKER_EGRESS_TARGET` / `HARNESS_DOCKER_EGRESS_DNS_NAME` aim the
  egress check somewhere a restricted network permits, which is what a deployment with an internal
  mirror and no public egress should set. `HARNESS_DOCKER_READY_TIMEOUT_SECONDS` keeps its meaning as
  the budget for the WHOLE sequence rather than gaining a per-arm sibling.

## 1.147.0

### Minor Changes

- 436f373: Find out whether the container's Docker daemon can actually run a container, instead of telling
  every agent that it can.
  
  The harness appended a line to every agent's system prompt saying `docker build`, `docker run` and
  `docker compose up` work here, on the strength of `docker info` exiting zero. Those are different
  facts. A rootless daemon nested inside a sandbox serves happily while its snapshotter cannot mount
  a single image layer, so a multi-layer `docker pull`, a `docker run` of a single-layer image and
  `docker build` all fail on one EINVAL from `mount(2)`. The same block also tells the agent not to
  spend turns re-checking what it states, which made the claim maximally expensive: in the reported
  run the coder, the reviewer and the tester each disproved it separately, and the tester's
  containerised deployment contract went unverified by anyone.
  
  The reachable case is now split by a real workload. The platform assembles a one-layer image in
  memory from a statically linked binary already in the image, loads it and runs a container that has
  to print a marker, so the check needs no registry, no network and no second image. `usable`,
  `unusable` and a daemon that answered while the check could not be carried out are three different
  lines to the agent, and only the first claims the commands work. The asymmetry runs the other way
  too, deliberately: only the container RUN may produce `unusable`, and only where the DAEMON is what
  refused it, so every failure of the platform's own machinery reports that it could not tell rather
  than condemning a working daemon. That covers the steps before the run (no payload on this machine,
  a daemon whose architecture the payload is not built for, a `docker load` that refuses the archive)
  and the halves of a failed run that are ours rather than the daemon's: docker's exit 126/127, a tag
  that did not resolve, a payload that cannot exec there. The image is built for the architecture the
  DAEMON reports, not this process's, because an external `DOCKER_HOST` need not share one.
  
  The weaker fact still decides one case, and it is the one a stale boot record is read against. A
  check that could not be carried out says whether it reached a daemon on the way past, so a
  warm-pool container whose sidecar came up after the entrypoint's bounded wait is not latched into
  refusing local infra for its whole life: a daemon that merely answered overrules a recorded absence
  exactly as the old `docker version` probe did, and only a check that never reached one leaves the
  record to decide. The stand-up refuses on the resolved verdict and names the cause, and the Tester
  step now carries both facts (`infraSetup.dockerAvailable` and a new `infraSetup.dockerWorkload`)
  because the daemon has two ways to stop a stand-up and they are fixed in different places: a
  reachable daemon that cannot run a container, reported as an absent one, sends an operator to
  restart a daemon that is already up. `GET /health` reports the last measurement beside the boot
  record, since `serving` was never the same word as `usable`.
  
  The check is bounded and cancellable, being on the critical path ahead of the clone: one budget for
  the whole pass rather than a ceiling per command, the job's signal on every command it makes, and a
  measurement cancelled once the last caller waiting on it has gone. It answers rather than throwing,
  whatever happens inside it, because the stand-up that consults it is best-effort by design.
  
  The cause is addressed as well as the claim. The rootless daemon is taken off the containerd image
  store, whose snapshotter mounts or fails with no fallback; the graphdriver path it returns to probes
  overlay2, then `fuse-overlayfs`, then `vfs`, and settles on whichever the sandbox permits. That is
  written as a config key rather than a daemon flag, because an unknown key inside `features` is
  ignored while an unknown flag takes the daemon down at startup. Whether it worked is not assumed
  either way: the platform runs a container and reports what happened.
  
  The image also gains the buildx plugin, without which `docker build` and `docker compose build` fail
  before reading a Dockerfile, and a `docker-compose` shim for the spelling half the world's repo
  scripts still use.

## 1.145.1

### Patch Changes

- 0f426b3: Refresh the dependency tree and the bundled agent CLIs.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
  newest release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Direct**: `ai@^7.0.84 → ^7.0.85`, `@ai-sdk/anthropic@^4.0.45 → ^4.0.46`,
    `@ai-sdk/openai@^4.0.51 → ^4.0.52`, `@ai-sdk/openai-compatible@^3.0.40 → ^3.0.41`,
    `@ai-sdk/provider@^4.0.8 → ^4.0.9`, `@ai-sdk/amazon-bedrock@^5.0.67 → ^5.0.68`,
    `happy-dom@^20.11.15 → ^20.12.0`, `pg-boss@^12.28.1 → ^12.29.0`,
    `layered-loader@^16.1.0 → ^16.1.1`. The whole `@ai-sdk` line and `ai` were named as
    age-blocked by the previous round and have now aged past the window. `layered-loader`
    16.1.1 is 23 hours old and would miss it, but the package is ours and sits on
    `minimumReleaseAgeExclude`, which is exactly the case that list exists for.
  - **Transitives the re-resolve moved**, 32 resolved entries added against 32 removed:
    `zod@4.5.2 → 4.5.4`, `@ai-sdk/gateway@4.0.68 → 4.0.69`,
    `@ai-sdk/provider-utils@5.0.33 → 5.0.34`, `qs@6.15.3 → 6.16.0`,
    `serialize-javascript@7.1.0 → 7.1.1`, `type-fest@5.8.0 → 5.9.0`, `ignore@7.0.6 → 7.0.7`,
    `electron-to-chromium@1.5.416 → 1.5.417`.
  
  The tree is structurally unchanged: 1434 distinct names and 1967 resolved entries on both
  sides, with no name added and none removed. The two-`zod` split the previous round introduced
  holds along the same seam: `@cloudflare/vitest-pool-workers` keeps its hard-pinned `4.4.3` for
  its own config validation, and every app-reachable consumer (the AI SDK family,
  `@modelcontextprotocol/sdk`, `drizzle-orm`) moves to `4.5.4` together, so a schema built in one
  module is still read by the same identity in another.
  
  **The agent CLIs**: Claude Code `2.1.251 → 2.1.252` and Codex `0.151.0 → 0.152.0`, both taken
  at their newest under the Dockerfile's standing exemption from the age window (2.1.252 is 17
  hours old, 0.152.0 is 8). That exemption covers exactly those three pins and is an explicit
  call re-made on each bump. Pi is already newest at `0.84.4`, as are both Pi extensions at
  `2.8.0`, and the extensions are held to the ordinary window regardless.
  
  The executor image tag rolls to `1.145.0` for the two CLI pins, because republishing over a
  live tag does not roll a deployment out. The deploy image is untouched at `0.6.1`: nothing
  under `backend/internal/deploy-harness/` moved.
  
  **Held back by the age window rather than by a compatibility call**, and takeable next round:
  `ai@7.0.87` with `@ai-sdk/openai@4.0.53` and `@ai-sdk/amazon-bedrock@5.0.69` beside it (all
  published late on 2026-08-31), `@aws-sdk/client-s3@3.1123.0`, `knip@6.34.0`, `undici@8.10.1`,
  and the OpenTelemetry line (`@opentelemetry/sdk-*` and `resources` at 2.11.0, the two OTLP
  exporters at 0.222.0).
  
  **Held by a deliberate call**, unchanged: `wrangler` stays at `4.124.0` and
  `@cloudflare/workers-types` at `5.20260815.1` for the sixth round running, because
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins that exact
  wrangler, and the types are derived from the `workerd@1.20260815.1` it brings. `4.127.1` is
  available and would split the runtime the tests prove from the runtime that ships. Drizzle
  stays at `1.0.0-rc.4`: still only per-commit `rc.5` snapshots. The frontend layer stays on
  `typescript@^6.0.3` while the rest of the tree is on `7.0.2`, which is why sherif ignores that
  name. The `node:26-trixie-slim` base digest and the `searxng` tag in the local compose stack
  are both already the newest published.

## 1.144.1

### Patch Changes

- 332ef26: Refresh the dependency tree, the agent CLIs and the local web-search image.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
  newest release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Direct**: `ai@^7.0.83 → ^7.0.84`, `@ai-sdk/anthropic@^4.0.44 → ^4.0.45`,
    `@ai-sdk/openai@^4.0.50 → ^4.0.51`, `@ai-sdk/openai-compatible@^3.0.39 → ^3.0.40`,
    `@ai-sdk/amazon-bedrock@^5.0.66 → ^5.0.67`, `@aws-sdk/client-s3@^3.1120.0 → ^3.1121.0`,
    `happy-dom@^20.11.12 → ^20.11.15`, `knip@^6.32.3 → ^6.33.0`, `pg-boss@^12.28.0 → ^12.28.1`.
    Every one of these was named as held back by the age window in the previous round and has now
    aged past it.
  - **Transitives the re-resolve moved**, 42 resolved entries added against 43 removed:
    `oxc-parser@0.143.0 → 0.147.0` with its 19 platform bindings, `@ai-sdk/gateway@4.0.68`,
    `@ai-sdk/provider-utils@5.0.33`, `express-rate-limit@8.7.0`, `fastq@1.20.3`,
    `formatly@0.3.0 → 0.7.0` (knip's own range), `ip-address@10.7.0`, `json-rpc-2.0@1.8.0`,
    `open@11.0.2`, `powershell-utils@0.2.1`, `pretty-bytes@7.1.2`, `pretty-ms@9.3.1`,
    `@iconify/collections@1.0.730`.
  
  The tree stays at 1387 distinct names on both sides, and 1614 resolved entries becomes 1613:
  `@oxc-project/types` collapses from three copies to two and `get-tsconfig` from two to one, while
  `zod` gains a second.
  
  **That second `zod` is deliberate and is worth knowing about**, because a duplicated singleton is
  usually a bug here. No workspace package declares `zod`, so every copy of it fills an
  auto-installed optional peer slot, and until now the exact `zod@4.4.3` that
  `@cloudflare/vitest-pool-workers@0.22.0` pins as a hard dependency was the only version in the
  tree, which dragged every other consumer onto it. `zod@4.5.2` has now aged past the window, so the
  peer slots take it and the pool's pin no longer speaks for the whole graph. The split is along a
  seam nothing crosses: `4.4.3` is reachable only from the vitest pool, which uses it to validate its
  own config, and everything app-reachable (the AI SDK family, `@modelcontextprotocol/sdk`,
  `drizzle-orm`) moves to `4.5.2` together, so there is still exactly one `zod` identity in every
  place a schema is built in one module and read in another. Do not "fix" this with a top-level
  override pinning `4.4.3`: that would freeze the whole tree on a decision that belongs to the test
  pool, which is the mistake the `wrangler` note in `pnpm-workspace.yaml` exists to prevent.
  
  **Held back by the age window rather than by a compatibility call**, and takeable next round:
  `ai@7.0.85` and the whole `@ai-sdk` line beside it (`anthropic@4.0.46`, `openai@4.0.52`,
  `openai-compatible@3.0.41`, `amazon-bedrock@5.0.68`) were all published about six hours ago, and
  `happy-dom@20.12.0` misses by two and a half hours.
  
  **The agent CLIs**: Codex `0.150.1 → 0.151.0`, and both Pi extensions `2.7.1 → 2.8.0`. Pi
  (`0.84.4`) and Claude Code (`2.1.251`) are already at their newest. The Dockerfile's standing
  exemption that lets the three CLI pins run ahead of the age window is not exercised this round:
  every version taken here has aged past it on its own, the extensions included, which is the rule
  they are held to anyway.
  
  The executor image tag rolls to `1.144.0` for those pins, because republishing over a live tag does
  not roll a deployment out. The deploy image is unchanged and stays at `0.6.1`: nothing under
  `backend/internal/deploy-harness/` moved, and its `kubectl`/`kustomize`/`helm` pins are managed
  deliberately rather than swept (`kubectl` has a `v1.37.0` available against the pinned `v1.36.4`,
  which is a call for its own change).
  
  **The `searxng` image in the local compose stack takes `2026.8.29-d226b78bc`**, 29 hours old, after
  holding two rounds at `2026.8.22-9fea41204` for tags that kept landing an hour or two short of the
  window. The `node:26-trixie-slim` digest both runner Dockerfiles pin does not move: the tag still
  resolves to `sha256:c0753125` (Node 26.8.1), unchanged since 2026-08-27.
  
  **Standing holds, restated so the next round need not re-derive them**: `wrangler` and
  `@cloudflare/workers-types` do not move for the fifth round running, because
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
  exactly, and the types version is the workerd date that pin resolves to. `drizzle-orm` and
  `drizzle-kit` stay at `1.0.0-rc.4`: the only newer publishes are per-commit `rc.5` snapshots, not a
  release to pin against. The frontend keeps `typescript@^6.0.3` against the root's `7.0.2` because
  `vue-tsc@3.3.11` is what pairs with it, so moving it is a Nuxt-toolchain decision rather than a
  sweep. The Java SDK moves nothing: jackson, junit, jspecify and every build plugin are already at
  their newest stable on Maven Central, and Go and Python have no dependencies by design.

## 1.143.1

### Patch Changes

- 4b41767: Refresh the dependency tree, the runner base image and the agent CLIs.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the
  newest release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Direct**: `@aws-sdk/client-s3@^3.1119.0 → ^3.1120.0`, `happy-dom@^20.11.8 → ^20.11.12`,
    `markdown-it@^15.0.0 → ^15.0.1`, `p-map@^7.0.6 → ^7.0.7`.
  - **Transitives the re-resolve moved**, 39 resolved names in total: `rollup@4.63.0 → 4.63.1` with
    its 24 platform binaries, `terser@5.51.1 → 5.51.2`, `@jridgewell/sourcemap-codec@1.5.5 → 1.6.0`,
    `devalue@5.9.1 → 5.9.2`, `fastq@1.20.1 → 1.20.2`, `json-rpc-2.0@1.7.1 → 1.7.2`, and the
    browserslist data set (`baseline-browser-mapping`, `electron-to-chromium`, `node-releases`,
    `update-browserslist-db`).
  
  This is a narrow round because the previous one landed a day earlier, and the tree shows it: the
  re-resolve adds and drops nothing, leaving 1389 resolved names on both sides. Everything held back
  is held by the age window rather than by a compatibility decision, and each will be takeable next
  round: `ai@7.0.84`, `@ai-sdk/anthropic@4.0.45`, `@ai-sdk/openai@4.0.51`,
  `@ai-sdk/amazon-bedrock@5.0.67`, `knip@6.33.0`, `pg-boss@12.28.1` and `fastq@1.20.3` were all
  published inside the last 24 hours. The Java SDK moves nothing: jackson, junit, jspecify and every
  build plugin are already at their newest on Maven Central.
  
  **The `node:26-trixie-slim` digest both runner Dockerfiles pin moves to `sha256:c0753125`**
  (Node 26.8.1), the build held back at 14h old last round and now 37h old. `searxng` in the local
  compose stack stays at `2026.8.22-9fea41204`: the newer `2026.8.28-a30b2d474` is 23h old, an hour
  short of the window, so it is the first thing to take next round.
  
  **Pi `0.84.3 → 0.84.4` and Claude Code `2.1.250 → 2.1.251` take their newest releases** ahead of
  the age window, as the Dockerfile's standing note about the three agent CLIs allows. Codex
  (`0.150.1`) and both Pi extensions (`2.7.1`) are already at their newest and have aged past the
  window. Both image tags roll (executor `1.143.0`, deploy `0.6.0`) because republishing over a live
  tag does not roll a deployment out.
  
  `wrangler` and `@cloudflare/workers-types` deliberately do not move for the fourth round running:
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
  exactly, and the types version IS the workerd date that pin resolves. `drizzle-orm` and
  `drizzle-kit` stay at `1.0.0-rc.4` for a different reason: the only newer publishes are per-commit
  `1.0.0-rc.5-<sha>` snapshots, not a release to pin against.

## 1.142.1

### Patch Changes

- be0b953: Refresh the dependency tree, the base images and the agent CLIs.
  
  **Direct ranges plus a lockfile re-resolution from an empty tree**, so transitives move to the newest
  release each declared range already admits, under the `minimumReleaseAge` gate:
  
  - **Runtime**: the `ai` / `@ai-sdk/*` line takes its first aged releases since it was held back last
    round (`ai@^7.0.77 → ^7.0.83`, `@ai-sdk/anthropic@^4.0.41 → ^4.0.44`,
    `@ai-sdk/openai@^4.0.46 → ^4.0.50`, `@ai-sdk/openai-compatible@^3.0.35 → ^3.0.39`,
    `@ai-sdk/provider@^4.0.7 → ^4.0.8`, `@ai-sdk/amazon-bedrock@^5.0.61 → ^5.0.66`), staying on the
    majors `workers-ai-provider` pairs with. Also `hono@^4.13.4 → ^4.13.5`,
    `@aws-sdk/client-s3@^3.1116.0 → ^3.1119.0` and `vue@3.5.41 → 3.5.42` with the whole pinned
    `@vue/*` override family moved in lockstep.
  - **Tooling**: `@types/node@^26.2.0 → ^26.4.0`, `turbo@^2.10.11 → ^2.10.12`, `knip@^6.32.2 → ^6.32.3`,
    `happy-dom@^20.11.6 → ^20.11.8`.
  - **Java SDK**: `jackson-databind 2.22.1 → 2.22.2`, `junit-jupiter 6.1.2 → 6.1.3`, and the build
    plugins (compiler 3.15.0, source 3.4.0, javadoc 3.12.0, gpg 3.2.8, central-publishing 0.11.0).
  - **Transitives the re-resolve moved**, among ~180: `eslint@10.6.0 → 10.9.1`,
    `@tiptap/*@3.24.0/3.30.0 → 3.30.5`, `rollup@4.62.5 → 4.63.0`, `rolldown@1.2.5 → 1.2.6`,
    `terser@5.50.0 → 5.51.1`, `@ai-sdk/gateway@4.0.62 → 4.0.67`, `@ai-sdk/provider-utils@5.0.29 →
  5.0.32`, `@inquirer/*`, `@intlify/*` and `vue-i18n` to 11.4.10, `cssnano@8.0.8 → 8.0.10`.
  
  **The re-resolve also drops ~22 packages that were in the tree only through lockfile inertia**:
  `@vitejs/devtools-kit`, `tsx`, `@parcel/watcher` (with its platform packages), `devframe`,
  `@devframes/*`, `@json-render/core`, `zigpty` and `node-addon-api`. Every one of them occupies an
  OPTIONAL peer slot, which pnpm does not auto-install; they survived because each partial install
  preferred what the previous tree already held. Resolving from a deleted `node_modules` as well as a
  deleted lockfile is what surfaces that, and it is also what collapses the duplicate `h3` and `srvx`
  copies. `@parcel/watcher-wasm` still serves the watcher slot, so this costs dev-time niceties at
  most.
  
  **The base image both runner Dockerfiles pin by digest moves to `sha256:5758d367…`** (Node 26.7.0),
  the build held back at 17h old last round and now 74h old. The newer `26.8.1` digest is 14h old and
  is held on the same rule. `searxng` in the local compose stack takes `2026.8.22-9fea41204`.
  
  **Claude Code `2.1.246 → 2.1.250` and Codex `0.150.0 → 0.150.1` take their newest releases** ahead of
  the age window, as the Dockerfile's standing note about the three agent CLIs allows. Pi (`0.84.3`)
  and both Pi extensions (`2.7.1`) are already at their newest and have aged past the window, so they
  need no exemption. Both image tags roll (executor `1.142.0`, deploy `0.5.0`) because republishing
  over a live tag does not roll a deployment out.
  
  **`wrangler` and `@cloudflare/workers-types` deliberately do not move**, for the third round running:
  `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still pins `wrangler@4.124.0`
  exactly, and the types version IS the workerd date that pin resolves (`1.20260815.1`). They move
  together on the next pool bump.
  
  **Held back, all inside the 24h window when this was cut**: `@aws-sdk/client-s3@3.1120.0` (12h),
  `happy-dom@20.11.12` (16h), `vue-router@5.3.0` (18h), `wrangler@4.127.0` (23h) and
  `@cloudflare/workers-types@5.20260828.1` (4h, and blocked by workerd besides). Held on the
  compatible-major rule: `pnpm@12.0.0` and `typescript@7` for the frontend, which is on `^6.0.3`
  because that is the line Nuxt's build graph resolves.

## 1.141.0

### Minor Changes

- e1f6325: Move the harness job server off `:8080`, so a tester grades the product rather than the platform.
  
  The harness is PID 1 of the job container and shares its network namespace with everything the
  agent starts, and it held 8080: the most common default for a containerised HTTP service. A
  service under test started on its own documented default died with `EADDRINUSE`, and a health
  check aimed at 8080 got a 200 back from the harness, whose body begins `{"status":"ok"}`. Every
  ordinary health assertion passes against that, so a step could report green on a service that
  never ran.
  
  Both images (executor and deploy) now bind `27182`, and the four backend copies of the number
  collapse onto one `HARNESS_JOB_PORT` in `@cat-factory/contracts`, pinned to each harness's own
  literal by a conformity test. The environment inventory the harness states to every agent now
  names the port it holds and says a reply from it is not evidence, which stays true for a
  deployment that overrides `PORT`.
  
  Moving the number is not on its own the fix, because the harness exports the port it holds as
  `PORT` and the agent's own processes inherited it: a service written as `listen(process.env.PORT)`
  would have been aimed straight back at the one address in the namespace it cannot have. `PORT`
  joins `NODE_ENV` on the short list of harness variables stripped from everything spawned into the
  checkout, so the collision is closed rather than relocated.
  
  Two things now hold the port in one place per job. Every facade STATES the port the container must
  bind rather than leaving it to the image: the Kubernetes pod spec already did, and the local
  container adapters and the Cloudflare container class now do too. A deployment pins its own
  mirrored image tag, so without that the published port and the served one were joined only by the
  image happening to agree, and a tag from before this change would answer nothing and surface as a
  container that never became ready (rather than as the version handshake naming the skew, which
  needs a reachable harness to run at all). And the frontend stand-up refuses a serve port equal to
  the port the harness is listening on, read from the live process rather than predicted from the
  shared constant, which is what covers a deployment whose `PORT` the constant does not name.
  
  Breaking for a deployment that pins the harness port itself: a runner pool's pod spec, a
  `NetworkPolicy`, or a `harnessPort` runner-backend setting written against 8080 must move with the
  image tag. **A pool left on `harnessPort: 8080` keeps dispatching, which is the trap rather than
  the relief**: the harness then holds 8080 inside every job container, exactly the collision this
  change removes, and a `frontend` frame is free to be configured to serve there because the shared
  guard now reserves 27182. The stand-up refusal above is what makes that land as a named infra gap
  instead of a green grade against the platform, but the pool setting is still the thing to clear.

## 1.139.1

### Patch Changes

- 2ea756f: Take the bundled agent CLIs at their newest releases: Claude Code `2.1.245 → 2.1.246` and Codex
  `0.149.1 → 0.150.0`. Pi stays at `0.84.3`, which is still its newest release, as do the two Pi
  extensions at `2.7.1`.
  
  Codex `0.150.0` is inside the 24h `minimumReleaseAge` window (published ~4h before this was cut),
  so it is taken under the standing exemption the Dockerfile's note carries for exactly these three
  CLIs, re-made here as an explicit call. Claude Code `2.1.246` needs no exemption: it has aged past
  the window. Claude Code `2.1.247` is published but sits on the `next` dist-tag rather than
  `latest`, so it is deliberately not taken; the pins follow the stable line.
  
  The executor image tag rolls to `1.139.0` (base + UI) because republishing over a live tag does not
  roll a deployment out.

## 1.139.0

### Minor Changes

- 82a3b94: Put the salvage in front of the pre-PR gates, keep its account of itself honest, and stop
  declaring a tool set to a CLI this image does not pin.
  
  The salvage ran last, after the reproduction proof and the pre-PR validation loop. Both are gated
  on whether the branch carries commits, so a run whose entire product was uncommitted new files
  (the greenfield case the salvage exists for) skipped validation altogether and then opened a pull
  request with no validation report at all: "only a green checkout opens a PR" held for every run
  except the ones being rescued. It now commits ahead of both, with a second mop-up pass folded onto
  the first so a repair round's own new files are still recovered.
  
  Three smaller corrections around it. A settle-path salvage told a human "this run was aborted",
  describing a failure that had not happened, because only the commit message took the occasion. A
  single-repo pull request built entirely out of salvage carried nothing saying so, though the
  multi-repo path had marked its legs for a while. And `commitPaths` committed the whole index
  rather than the paths it was given, so an agent killed with work staged had that work landed under
  a message naming other files, counted by a report that had never seen it; the abort rescue now
  commits tracked edits under the run's own message first.
  
  Separately, `--tools` is withheld from an `ambientAuth` run. The declared set is deliberately
  over-inclusive because a tool NAME the build lacks is dropped silently, but that reasoning does not
  extend to the FLAG carrying it: on a developer's own machine the harness knows neither which
  `claude` is on the PATH nor how old it is, and an unrecognised flag fails the run outright.

## 1.137.0

### Minor Changes

- 17e29df: Tell an agent what its sandbox contains instead of making every one of them find out.
  
  The dispatch used to instruct every container agent to discover its own environment ("probe for a tool before relying on it"), and every agent obeyed. In one measured run four calls out of a forty-call budget went on it twice over: an architect swept `docker kubectl helm kustomize` and then ran `docker info`, and the coder it handed off to rediscovered the same two answers thirty calls later. The harness holds all of it before the agent's first turn.
  
  Ownership now splits along what each layer can know. The backend keeps the POLICY, which is true whatever the machine contains: no cluster or container-registry credentials, an artifact this environment cannot execute is still a correct artifact, and the limit is never a finding against the work. It names no tooling at all, because it is composed before a transport is chosen and the same job body serves the harness image, a deployment's own image variant and the developer's own machine under `LOCAL_NATIVE_AGENTS`. The harness probes once per job and appends an `ENVIRONMENT INVENTORY` block with the facts.
  
  That block is three-valued, so a probe that failed renders as could-not-be-determined rather than as an absence, and it says in its last line that an unlisted tool is unknown rather than missing. The Docker DAEMON is answered by running `docker info`, never by finding the CLI: the image ships the CLI unconditionally and the rootless daemon it starts best-effort is what a run actually needs, which is why the old `command -v docker` answer was a half-truth.
  
  A daemon that is still STARTING gets the third answer rather than the absence a refused connection looks like. The entrypoint does not wait for the rootless daemon, so a job begins seconds before there is a socket and `docker info` is refused immediately; stating that as "no Docker daemon is reachable" is a prohibition, and it would have landed on machines whose daemon was up moments later. A refusal is now read against `DOCKER_HOST`, which the entrypoint sets whenever anything is meant to serve a daemon here: unset means nothing was coming and the definite absence is correct, set means one short retry and then could-not-be-determined. For the same reason the absent-tools line no longer forbids installation outright, only a system-wide install, because `pnpm` is not on the base image and is routinely the package manager the job's own repository declares.
  
  Composed at ONE point in `handleAgent`, onto the job's own system prompt, so every mode and all three agent CLIs inherit it and none carries it twice. The backend deliberately does not PROMISE the block: an image older than the backend appends none, which is why the sandbox policy keeps a conditional probe clause ("where the platform has stated what this machine holds, take that as given; where it has not, check") rather than dropping the instruction to check. Dropped outright, it read correctly only against a fresh image, and one version behind is the normal state of running a deployment.
  
  Two smaller prompt changes ride along. Every container dispatch now names a tool preference (file tools for file work, the shell for running things), because the models stopped reaching for their file tools on their own: four runs of one task in a three-day window used the write tool zero times, against 26 to 34 times per dispatch a fortnight earlier, rewriting whole files through shell heredocs instead. It is a nudge and nothing may depend on it. And the delivery contract now asks for a commit per coherent chunk rather than leaving the timing open, which bumps the build prompt to `build@v8`: the contract already said commits are published as they are made, but the checkpoint push can only publish what exists, and one killed run had made none in six and a half minutes.

## 1.135.0

### Minor Changes

- a105803: Declare the claude-code CLI's built-in tool set with `--tools` instead of taking its headless
  default. The default carried no `Grep`, no `Glob` and no plan tools (so every search went through
  `Bash` and counted against the progress guard's no-edit budget, and `step.progress` had no signal
  to lift), plus a dozen tools an ephemeral container can act on none of.
  
  The same declared list now rides the `--allowedTools` re-grant, which is ADDITIVE rather than
  inert: a name in it unlocks a tool. Threading one value removes the drift where a run's capability
  depended on whether an unrelated tool server happened to narrow itself.
  
  The declared set is measured against the DEFAULT it replaces, not only against what is wanted:
  anything the default carried that a container can still act on is asked for by name, or the
  declaration is itself a capability loss. A retired name is kept beside its successor because
  `--tools` treats one as an ALIAS of the other (`BashOutput` grants `TaskOutput`; `KillBash` and
  `KillShell` both grant `TaskStop`), which is how one pinned image faces several CLI versions.
  
  `WebSearch`/`WebFetch` stay unconditional. They are served by the vendor the leased subscription
  already pays rather than by this deployment's web-search proxy, so the proxy's availability, which
  is what the job's `webSearch` flag states, does not decide whether they work; gating them on it
  would have withheld a working capability from every deployment with no search provider wired.
  
  Fixed alongside: the conflict-resolver and bootstrap flows forwarded neither web-research field to
  the agent, so a deployment that serves web research had two flows whose agents were never given
  it. Those fields now travel with the other per-job capabilities in `agentCapabilities`, and a
  structural guard fails a mode that forwards none.

## 1.134.0

### Minor Changes

- 71a39dc: Decide the no-progress bound on the working tree, and stop discarding an aborted run's work.
  
  `ProgressGuard`'s no-edit bound judged whether a run was making progress by looking at TOOL NAMES,
  so an agent writing every file through `bash` (heredocs, `sed -i`, `node -e`) read as "40 tool
  calls and not one file edit" however much it had built, and the guard killed it. It now returns a
  discriminated verdict: the four streak bounds stay immediate, while the no-edit bound is
  provisional and settled by a working-tree probe (`git status --porcelain -z --untracked-files=all`
  plus whether `HEAD` moved off the sha the pass began at). The probe is injected, runs at most once
  per run and only at the instant the bound is about to abort, and a probe that THROWS is
  inconclusive: the bound re-arms and warns rather than killing a run on a transient git failure. A
  multi-repo run works at a workspace root that is no repository, so it names its writable checkouts
  and the probe answers over all of them: one changed repository is progress, but a checkout that
  could not be probed makes the answer inconclusive rather than clean.
  
  When a run is aborted, the new files the agent created and never committed are now salvaged onto
  the work branch and pushed instead of being logged and dropped with the container. On a greenfield
  task every file is new, so that log line was the whole deliverable going in the bin. The salvage
  carries a dependency/build deny-list (a checkout whose agent had not written a `.gitignore` yet
  would otherwise swallow `node_modules`) and file-count plus byte bounds that refuse the whole
  salvage rather than truncating it, since a half-committed tree reads as a complete change. On that
  same un-gitignored greenfield checkout the harness is also the only thing between an agent-authored
  `.env` or private key and the pull request, so credential-bearing names are withheld and, unlike a
  dependency tree, NAMED on the run's outcome: the file did not land, and anything real it held needs
  rotating. The commit message states that it came from an aborted run and that nothing reviewed it,
  and the same recovery now runs on the ordinary settle path, where a forgotten new file was silently
  dropped from the pull request. In a multi-repo run, a leg whose branch is nothing BUT a salvage
  opens its pull request behind a banner saying so.
  
  Two things had to be right for any of that to happen on an aborted run, and are. The rescue runs on
  a fresh, timeout-bounded signal rather than the run's: `execFile` rejects on an already-aborted
  signal before it spawns, so a rescue carrying the watchdog's signal could not run one git command,
  in exactly the watchdog and eviction cases it exists for. And it stops the checkpoint interval and
  drains any push already in flight first, because the push coalesces and would otherwise report a
  commit the remote never received; a push that fails now says the commit is lost with the container
  rather than naming a sha nobody can fetch.
  
  Every git path listing (`ls-files`, `status --porcelain`) is read with `-z`, and the salvage stages
  each path as a `:(literal)` pathspec. Git's default output C-quotes a path holding a non-ASCII byte,
  a quote or a newline, and everything after `--` is a pathspec, not a filename: either way a single
  `café.ts` or `:notes.txt` made the salvage's one `git add` exit 128 and discarded all of it. A
  commit-less checkout no longer makes the probe throw, which is the scaffold-from-scratch case the
  working-tree half was written for.
  
  The generic `agent` failure hint no longer claims the step "failed after its automatic retries",
  which it cannot know and which was wrong on the run that prompted this: it points at the step's own
  attempt count and failure detail instead.
- dc12c82: Runner image: install the Docker daemon that was never there, stop handing the agent the harness's
  `NODE_ENV`, and add the three binaries agents reach for first.
  
  The image installed `docker-ce-rootless-extras` (the wrappers that START a rootless daemon) but
  never `docker-ce` (the daemon) or `iproute2` (the `ip` binary rootlesskit builds its network with),
  so no container could ever run `docker compose`. `entrypoint.sh` backgrounded the start in a
  subshell where its exit status was unobservable, so the Tester's local-infra stand-up silently
  became a no-infra run everywhere, and had done since it shipped. Both packages are installed now,
  and the entrypoint waits for the daemon on a bounded window (in the background, so it never delays
  the container's boot) and RECORDS the verdict: `GET /health` reports it, and the compose stand-up
  refuses a confirmed absence with the cause instead of running compose against nothing.
  
  What the entrypoint records describes BOOT, and a warm-pool container outlives its boot, so the
  stand-up re-checks a recorded absence against a live daemon before refusing on it: a sidecar that
  took longer to come up than the bounded wait allows is not latched into refusing local infra for
  the container's whole life. The record still supplies what only the record holds, the cause and the
  daemon's own log tail.
  
  `infraSetup` gains `dockerAvailable` on the wire (harness → `RunnerInfraSetup` →
  `testerInfraSetupSchema`), and the test window says "No Docker daemon in the executor" rather than
  "Dependencies failed to start" for that case: a compose stack that failed to come up and an
  executor with no daemon are opposite fixes. It is three-valued — absent means the container reached
  no verdict (an older image, or the native host transport, which runs the harness with no entrypoint
  to probe) and must never be read as `false`.
  
  `ENV NODE_ENV=production` is no longer baked into the image. npm reads it as `omit=dev`, so an
  agent's `npm install` in its checkout skipped every devDependency; one measured coder run spent six
  of its forty budgeted tool calls discovering and undoing that. The harness process still gets it
  (from `entrypoint.sh`), and the new `agentChildEnv` seam drops it from everything the harness spawns
  into the checkout — which is what makes the fix hold under the native host transport too, where the
  image is not involved at all.
  
  `python3`, `jq` and `ripgrep` join the image for the same reason `procps` is already there: agents
  reach for all three by reflex and each `command not found` costs a call.
  
  `entrypoint.sh` is also added to the executor images' source lists, so a change to how the container
  boots can no longer republish over a live tag without minting a version.

## 1.132.3

### Patch Changes

- 3ae3386: Carry a companion's unanswered findings to the next producer, stop counting a spend correction as an LLM call, and stop an exponential backoff from stalling a live run.
  
  A companion loop does not only end because the work is clean. Past its first forced round a `major` no longer holds the run, and a person may approve over a `blocker`, so the last verdict's points can be real, unanswered and on the record while the run walks straight past them. Those points now ride the reviewed step's `priorOutputs` entry and reach every later step under the artifact they are about, worded so they cannot read as already handled. Earlier rounds are excluded on purpose: each of those was answered.
  
  `llm_call_metrics` gains `spend_only`. A harness CLI costs each turn's input but leaves its output at the message-start snapshot, so the producer files the shortfall as its own row rather than inflating a measured turn. That row is real spend and is not a call, and `COUNT(*) AS calls` was counting it: one phantom call per dispatch on every subscription-harness step. Token sums are unchanged; call counts drop the row, and so do the `turns_after` windows behind the carry cost, which charged every real turn one carry too many for it.
  
  Which of the two a shortfall row is stays with the PRODUCER, on both paths: it is a spend correction when measured turns were filed beside it and the job's only call record when none were. The container harness states that on the metric (a new `spendOnly`, hence the image bump) rather than leaving the backend to infer it from `standsForJob`, which would have reported every un-narrated container run as zero calls with real spend, or from the batch it was handed, which the live drain splits across polls.
  
  All four Node drive queues now enqueue through one options builder with `retryBackoff: false`. A drive job mostly fails because the worker went away, which the next attempt succeeds at, and nothing else can shorten the delay: the stale-run sweeper reads a `retry`-state job as live and the exclusive singleton no-ops a fresh send.
  
  The default companion rework budget goes from 3 to 4, on every shipped preset including the unattended one.
  
  Opening a LOCAL `node:sqlite` store now reconciles the file's columns against the schema it was handed, adding the ones it is missing. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so every column added to a shipped schema (`phase`, `turn_index` and now `spend_only`, all on `llm_call_metrics`) reached a fresh database and no other, and an existing file then failed both the inserts and the reads naming it: `summarizeByExecution` backs the live board rollups, so the damage was never confined to the write side. The reconciliation is additive only, and refuses to open on a column SQLite cannot add rather than serving a store that fails one query at a time. D1 and Postgres migrate as before.

## 1.132.1

### Patch Changes

- abc1af8: Refresh the dependency tree and take Claude Code at its newest release.
  
  **Direct ranges plus a full lockfile re-resolution**, so transitives move to the newest release each
  declared range already admits, under the `minimumReleaseAge` gate that #2079 finally armed:
  
  - **Runtime**: `hono@^4.13.3 → ^4.13.4`, the one runtime dependency with an aged release to take.
  - **Tooling**: `oxlint@^1.79.0 → ^1.80.0`, `oxfmt@^0.64.0 → ^0.65.0`, and pnpm `11.23.0 → 11.24.0`
    in `packageManager` and in the UI image, which installs the workspace's pnpm so a repo under test
    builds with the same one CI does.
  - **Transitives the re-resolve moved**: `@typescript-eslint/*@8.67.0 → 8.68.0`,
    `@nuxt/icon@2.5.0 → 2.5.1`, `@iconify/collections@1.0.727 → 1.0.728`, `svgo@4.0.2 → 4.1.0` (with
    `css-select@5 → 6` and `css-what@6 → 7` behind it), `bare-fs@4.8.0 → 4.8.1`,
    `picomatch@4.0.5 → 4.0.7`.
  
  **`wrangler` and `@cloudflare/workers-types` deliberately do not move.** `wrangler@4.125.0` is
  published and aged, but `@cloudflare/vitest-pool-workers@0.22.0` is still the newest pool and still
  pins `wrangler@4.124.0` exactly. Taking the newer one would put a second workerd in the tree and
  make the runtime the Worker suite proves a different build from the one `wrangler deploy` ships,
  which is the invariant `scripts/check-cloudflare-runtime-pins.mjs` exists to hold. The types pin
  follows from that: `5.20260823.1` is aged, but its version IS a workerd date, and the workerd we
  resolve is still `1.20260815.1`. Both move on the next pool bump, together.
  
  **Held back, all inside the 24h window when this was cut**: `@types/node@26.3.0` (22h),
  `@aws-sdk/client-s3@3.1117.0` (23h), `ai@7.0.79` and the `@ai-sdk/*` line (14h),
  `@cloudflare/workers-types@5.20260825.1` (17h, and blocked by workerd besides). The
  `node:26-trixie-slim` base image both runner Dockerfiles pin by digest has a newer build
  (`sha256:5758d367…`, same Node 26.7.0, a Debian package refresh) that is 17h old, so it is held on
  the same rule rather than taken because a digest is not what the pnpm gate governs.
  
  **Claude Code moves to its newest release, 2.1.243 → 2.1.245**, ahead of the release-age window, as
  the Dockerfile's standing note about the three agent CLIs allows and as an explicit call re-made
  here. Pi (`0.84.3`) and Codex (`0.149.1`) are already at their newest and have since aged past the
  window, so this round needs no exemption for them; the Pi extensions take the ordinary aged pick,
  `2.7.0 → 2.7.1`.
  
  The executor image tag therefore rolls to `1.132.0` (base + UI): republishing over a live tag does
  not roll a deployment out. The deploy image is unchanged and stays at `0.2.16`.

## 1.131.0

### Minor Changes

- 08752da: Answering a Coder's question and RULING ON it are now different acts, and a decision the loop
  budget throws away says so.
  
  A local run spent three implementer passes and about €4 producing three commits that reworded one
  comment about a Kubernetes Ingress class, and the fourth walked the wording back to roughly where
  the second left it. Nothing was broken: every part behaved as designed, and the design was the bug.
  
  The Coder asked a question nobody in the loop could answer (which IngressClass the target cluster
  marks as default). Its answerer replied with a standing steer, the same string every time, because
  that is all an unattended caller has. `resolution` did not exist, so the engine had exactly one
  thing it could do with an answered question: fold it into another pass and tell the agent to apply
  it. There was nothing to apply, so the agent did the only thing left and wrote its uncertainty into
  the manifest comment, the README and the commit message, one wording per pass, re-raising the same
  question under a new title each time. The loop ended on `maxLoops`, not on agreement, and then the
  last round's answers were dropped in silence.
  
  **`POST …/follow-ups/…/answer` takes an optional `resolution`.** `answered` (the default, and
  byte-for-byte the old behaviour) means the reply carries something to apply and buys a pass.
  `closed` means the reply rules on the question: it clears the gate identically, spends nothing, and
  rides into every later rework prompt under a heading that says the topic is settled and must not be
  re-argued in the code or the commit message. The answerer picks; the engine does not try to read the
  difference out of prose, which it cannot do. The public-API surface moves to `1.60.0`; the SPA's
  answer box gains a second button.
  
  **Exhausting the send-back budget is no longer indistinguishable from converging.** The gate's
  decision was a boolean whose `false` covered three different situations, one of which was "a
  human's decision is about to be thrown away". It is now a named verdict, and the dropped items are
  stamped `sendBackDropped`, warned about with the budget that ran out, counted under
  `followup.send_back_dropped`, and reported on the pull request. Without the stamp such an item
  stays `answered` with `sentToCoder` false forever, which reads exactly like an answer the Coder
  applied.
  
  **The PR verification report gains a `followUps` section** (payload `version: 10`): what the Coder
  flagged and what was decided, with the three dispositions that mean "not dealt with as triage
  intended" called out above the table rather than left to be derived from a status column. Its
  counts (`total`, `dropped`, `dismissedByPolicy`) are taken over every item the run surfaced rather
  than over the rows the entries cap left visible, and the banner quotes `droppedBudget`, summed over
  the steps that actually dropped something. A pipeline may place more than one follow-up-enabled
  Coder, and a budget summed across all of them reads as half-spent while asserting it was spent.
  
  **A stamped drop is not permanent, and an unbudgeted step is not a drop.** Deciding an item again
  clears `sendBackDropped`, so the send-back the budget could not pay for can be sent once the step
  has a pass to spend; the stamp is terminal in the send-back selection, so left set it made that
  item unsendable forever while the window claimed it had been sent. And a step whose `maxLoops` is
  absent (persisted before the field existed) has the loop UNWIRED rather than exhausted: it passes
  through as before instead of stamping every decided item, warning, and banner-ing a budget of 0/0
  that nobody configured.
  
  **The acceptance suite closes questions instead of answering them.** It was the caller in the story
  above, and its own file header had already reasoned through this exact failure for the clarity-review
  gate. Its steer is a ruling, so it now sends one.
  
  **Fixed alongside, and part of why the agent had so little to work from:** the single-repo coding
  path dropped `job.contextFiles` on the floor. Every sibling caller forwarded them;
  `buildSingleRepoCodingSpec` did not. So a task whose brief was too long for `description` (and
  therefore rode an attached document, which is the documented way to submit a real specification)
  reached the implementer as a prompt naming `.cat-context/<file>.md` beside a checkout that had no
  such directory. The agent rebuilt the brief from whatever summary the prompt carried and filed the
  gap as a follow-up question. Bumps the runner image to `cat-factory-executor:1.130.0`.
  
  **The four SDK clients keep their published follow-up type names.** `PublicFollowUpItemKind` and
  `PublicFollowUpItemStatus` are deduped enums, and adding the report's follow-ups section re-pointed
  both onto a name derived from the section instead: a source break in four released clients,
  arriving as ordinary generated churn. Both are now pinned in the emitter's `INLINE_ENUM_NAMES`, so
  the only change to them is `closed` joining the status list. Python and Java are bumped to `0.5.0`,
  which is what publishes them.

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

## 1.129.0

### Minor Changes

- 1d3c115: Close the remaining actionable Kaizen findings: what the companion loop is told, and what a prompt
  pays for on every round.

  Six items the platform's own graders filed, all of them either a fact the prompt withheld or a
  fact it paid for twice.

  - **A companion was never told its bar on the first round.** The threshold rode the prior-rounds
    heading, and there is no prior round the first time a step is graded, so the opening verdict of
    every rework loop was a 0..1 rating against a number nobody had stated. The bar and the rope left
    are now their own slice of the run context, set for every grader dispatch.
    `priorReview.roundsRemaining` was the old home and is gone rather than left beside the new one.
    The ROPE needed a second fix to be true: the rework budget was adopted from the task's risk policy
    on the first grading RESULT, one dispatch after the prompt for that grading is composed, so a
    workspace whose policy allows no automatic rework was told on round one that two rounds remained.
    It is resolved once now, at run start, which also removes the second resolution point so the
    number an agent is shown and the number the cap enforces cannot diverge.
  - **A rework prompt re-sent every settled point that was still open.** A point the reviewer raises
    again arrives once as this round's ask and again in the history; on a real run the same six points
    appeared three times with no single list to work through. The history is now deduplicated against
    the current round's list, and the fold is COUNTED in place rather than silent: a round whose every
    point moved into the current list would otherwise read as a round that raised nothing. A point NOT
    re-raised survives in the history, which is the only place it exists. Matching is on the point's
    BODY under its anchor rather than on the anchor alone, because an `anchorId` names an ITEM and one
    item collects several findings: keyed on the anchor, two different asks on one requirement hash
    together and re-raising one drops the other from the prompt for good.
  - **The user prompt was assembled volatile-first.** A provider's cache matches on a prefix, and the
    injected context files (a preOp's output, the run's linked documents) are the largest block in the
    prompt and the same bytes on every round, while the revision feedback is different bytes by
    definition. They were composed the other way round, so each round paid a fresh cache write for the
    whole fold. The wrappers are now an ordered list, invariant material first, which is also what
    makes the ordering reviewable rather than five levels of nesting. The saving is the PRODUCER's
    rework dispatch: `priorOutputs` renders at the tail of the base prompt ahead of every wrapper and
    carries the producer's rewritten reply, so a GRADER's prefix still breaks before the fold. That
    bound is recorded at the code rather than implied away.
  - **A container-backed companion could not run the diff its prompt asked for.** The default explore
    clone is `--depth 1 --single-branch`, so `origin/<base>` and the merge base are both absent and no
    later `git fetch` of a shallow base recovers a common ancestor. It clones with full history now,
    the same reason the `merger` does, and the dispatch's resolved base branch is named in the prompt
    with the diff commands and the rule that the review is planned from the diffstat before anything
    is opened. A measured review spent ~40 exploratory calls discovering the change one file at a
    time. The prompt names no `git fetch`, because the container agent holds no git credential of its
    own and an agent-issued fetch fails on a private repo; it is WITHHELD entirely where the checkout
    is the base branch (a `pr` clone falls back there when the producer opened no pull request, and
    the diff would be empty), and where the base branch name cannot be safely quoted into a command.
  - **Trait guidance naming an injected file is gated on the file arriving.** The two foundational
    sections each open by pointing at a `.cat-context/` path the engine injects only where a
    `FoundationalServiceResolver` is wired; on a deployment with none they were a few hundred words of
    dangling pointer on every turn. `AgentTraitDefinition.guidance` now receives what the dispatch
    delivered and may decline to contribute. An absent delivery means UNKNOWN rather than empty and
    renders in full, so the prompt editor and the sandbox are unchanged, which makes
    `appendedDirectivesFor` a maximum rather than a prediction of one dispatch: a real dispatch may
    send a subset and never more. `BINARY_OUTPUT_GUIDANCE` is deliberately not gated, because its
    absent case is a refusal the agent has to be told about.
  - **New `deployment.*` best-practice fragments.** Three standards for shipping a containerized
    service (image build and publish, workload runtime hardening, the cross-file manifest contract),
    from the class of finding a design review kept re-deriving one round at a time: a numeric UID for
    `runAsNonRoot`, a writable mount for a read-only root filesystem, pull-side registry auth, pull
    policy against tag mutability, and the selector/label/port contract three files share. They are
    OPT-IN: nothing shipped selects them, because there is no deploy-shaped built-in task type and
    unioning them onto `feature` would fold deployment standards into every feature run everywhere.

  Runner image: the explore path's warm-pool checkout refreshed only the branch being explored,
  leaving `origin/<base>` at whatever tip the pool directory was first cloned with, so a reviewer's
  three-dot diff resolved its merge base to that stale tip and reported every commit merged into base
  since as part of the change under review. Fixed in `@cat-factory/executor-harness`, so the pinned
  image tag moves to `1.128.0`.

## 1.127.1

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

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
