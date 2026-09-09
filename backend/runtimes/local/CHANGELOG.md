# @cat-factory/local-server

## 0.148.1

### Patch Changes

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
- Updated dependencies [ca5be97]
- Updated dependencies [333b967]
  - @cat-factory/kernel@0.342.0
  - @cat-factory/orchestration@0.305.0
  - @cat-factory/server@0.318.0
  - @cat-factory/node-server@0.228.0
  - @cat-factory/executor-harness@1.157.0
  - @cat-factory/agents@0.159.1
  - @cat-factory/binary-generators@0.3.42
  - @cat-factory/gitlab@0.23.5
  - @cat-factory/integrations@0.172.11
  - @cat-factory/prompt-fragments@1.1.38

## 0.148.0

### Minor Changes

- 5f06bfb: Run an environment dry run on the model the workspace picked, and hand it what the tester will get
  
  An agent dry run was dispatched on a model no workspace had chosen. Its facades read the deployment's
  env routing for the tester kinds once, at wiring, and pinned the prober to it for the process
  lifetime, so a workspace running everything on its Claude preset had its dry run dispatched at the
  Node family's Qwen default. The LLM proxy then refused it for having no key configured (`502`), after
  the run had already created a branch and stood a real environment up. The subscription that would
  have served it was never asked for, because the flow only ever knew the proxy branch: a
  subscription-routed model was refused at WIRING, which disabled the whole capability for exactly the
  deployments that had one.
  
  The model is now resolved per dispatch, under the same precedence a pipeline step gets (the frame's
  own pin, then the workspace's model preset entry for the prober's kind, then env routing), through
  the shared `ModelRouter`. The credential that opens it comes from the same `ContainerJobAuthResolver`
  the step executor uses, so a dry run can run on a pooled subscription, a personal one, or the
  developer's own CLI in native local mode. A personal credential is only leasable with its owner's
  unlock, so the start route gates on it exactly as a run start does (428 `credential_required`, minted
  against the run id the dispatch leases against) rather than provisioning an environment and failing
  at the lease. `provision` mode spends no model call and stays ungated.
  
  The dry run also now predicts what a tester step will be handed, which is the only thing it was ever
  claiming. Both are rendered by one module: the frame's test credentials as a three-state brief
  (configured / the platform could not open its own store / this deployment has no store), the
  environment access scheme including the two states the tester's own section used to drop, and one
  list of where to look in the repository for how to operate the service. The tester side of each was
  weaker: a sealed store that would not open reached it as an absent section, which reads as "this
  service has none configured" and sends someone to re-enter secrets that are already there, and an
  unopenable store took the whole dispatch down rather than costing the credentials.
  
  One rule the two held halves of moved with them: the shapes of a success nobody observed (a 200
  carrying an error body, a login page where JSON was expected, a command that printed failures and
  exited 0, a suite that ran zero tests). The prober named the HTTP ones; the tester, whose greenlight
  is what merges a change, had the principle and none of the shapes. Grading and writing deliberately
  did NOT move, because a prober never does either and the second is a security property its dispatch
  shape enforces.
  
  Watch for one behaviour change: a dry run used to run on the deployment's `tester-api` /
  `tester-ui` env routing, and now runs on whatever the workspace's preset names for
  `environment-prober-api` / `environment-prober-ui`, falling back to that same env routing when the
  preset names neither. A deployment that wants a specific model for dry runs sets it on those two
  preset entries. The proxyable check moved with the resolution: it is asked of the RESOLVED model at
  dispatch instead of disabling the capability deployment-wide over a routing entry no workspace had
  chosen.
  
  Three things the dispatch resolves are now PERSISTED on the run row and handed back to every later
  poll (`probe_model`, `probe_subscription_token_id`, `probe_subscription_vendor`), the same rule a
  pipeline step's `recordDispatchAttribution` follows. The poll runs in a fresh process and rebuilds
  its handle from that row: re-resolving the model there answered about the frame and preset as they
  are NOW, so a pin cleared while the container worked stamped the settled report with a model nobody
  ran, and the leased pooled token id has no second source at all.
  
  With it, a settled dry run files what it spent through the same `ContainerJobAccounting` a step's
  poll files through: the per-call rows, the leased token's usage-aware rotation counters and the
  modeled quota cycle. That only binds on a subscription harness, which is why it could not be left
  out: a Pi job is metered by the LLM proxy, but a subscription harness talks to the vendor direct, so
  the whole burn of a subscription-routed dry run was previously absent from the telemetry, from the
  rotation and from the quota window: free and invisible, on the flow whose own admission gate is a
  budget.
  
  Admission now also asks whether the RESOLVED model can be dispatched (409
  `env_test_probe_model_unavailable`, translated in every locale), covering a provider the LLM proxy
  cannot serve and a subscription-only model with no connected credential. Both were knowable before
  anything was created and both used to cost a throwaway branch, a full provision and a teardown to
  discover. The personal-credential unlock moved to LAST among the gates, resolved through a closure
  the service calls after its own refusals, so a dry run that could never have started no longer asks
  for a password first; and the mint now happens before the run row exists and outside the start's
  cleanup path, so an unlock that fails answers `428 credential_required` instead of a `201` carrying
  a failed run that the SPA reads as a finished action.
  
  Two fixes reach beyond the dry run. The modeled subscription quota cycle is now keyed on the VENDOR
  the dispatch resolved rather than the model's provider: the two differ for four of the five
  (`claude`/`anthropic`, `codex`/`openai`, `glm`/`zai`, `kimi`/`moonshot`), so the fold silently
  matched DeepSeek alone and counted nothing for the rest. Expect quota cycles to start reporting
  usage for those vendors. And both facades now compose every container dispatch's credential channels
  through one builder, which is what closes the gap the dry run's own composition had: it omitted
  `resolveAccountId`, so the proxy session token carried no account scope and the account-tier spend
  budget was not enforced for a dry run while it was for every pipeline step.

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0
  - @cat-factory/agents@0.159.0
  - @cat-factory/orchestration@0.304.0
  - @cat-factory/server@0.317.0
  - @cat-factory/node-server@0.227.0
  - @cat-factory/executor-harness@1.155.0
  - @cat-factory/binary-generators@0.3.41
  - @cat-factory/gitlab@0.23.4
  - @cat-factory/integrations@0.172.10
  - @cat-factory/prompt-fragments@1.1.37

## 0.147.0

### Minor Changes

- 8dc6677: Test whether an agent can actually operate a service's ephemeral environment, before a pipeline finds out
  
  "Test environment creation" answers whether a service's provisioning stands an environment up and
  takes it down again. The expensive failure is the one after that, and it is a GREEN deploy: the
  environment is up, the tester reaches it, and the agent then spends its whole step
  reverse-engineering an auth flow, guessing a base path, or reporting the service as broken because
  nobody told it which credential to send. That is a full run spent to discover a missing sentence of
  configuration.
  
  "Test agent dry run" sits beside it on the same service and buys the same finding for one
  container. It runs the identical lifecycle against a throwaway branch and adds one stage in the
  middle. The environment is handed to an agent (HTTP for a backend service, a browser for a
  frontend frame) together with the frame's sealed test credentials, the provider's own access
  handle and a read-only checkout of the branch the environment was built from. The agent picks a few
  simple but meaningful operations, at least one of which must go through authentication, attempts
  them, and reports each one: what it was, how it was performed, whether it exercised auth, and what
  happened. Then the run tears the environment down and deletes the branch exactly as before.
  
  The report's most valuable field is the one listing what the PLATFORM failed to supply (a
  credential with no reference, an endpoint that could not be discovered, an auth flow that had to
  be reverse-engineered), because each entry is a thing to fix before a real run spends a step on
  it. An operation the agent could not even attempt is a first-class outcome carrying the reason,
  not a failed call, and the failure vocabulary is grouped by whose problem each kind is: "no credential
  was supplied" and "the credential I was given was refused" are different fixes and therefore
  different members.
  
  The verdict is computed by the platform from the agent's per-operation judgements, never read off
  the reply, and it will not call a service operable unless something that worked went through
  authentication: a healthcheck answering 200 proves an ingress exists and nothing about whether an
  agent can work there.
  
  Two things to watch when reviewing. The run's `status` deliberately stays a statement about the
  LIFECYCLE, so a dry run reporting `inoperable` is a SUCCEEDED run that found something. Folding
  the verdict in would make the one interesting outcome indistinguishable from a broken diagnostic
  and leave a real teardown failure with nothing to say. And everything knowable before the first
  side effect is refused there rather than mid-run: a deployment that cannot drive a dry run at all,
  one whose runner backend has no image for THIS frame's surface, a workspace over its spend budget,
  and a frame that already has a self-test running. Each of those otherwise costs a branch, a full
  provision and a teardown to discover.
  
  Internal break: `environment_test_runs` gains `mode`, `probe_surface`, `probe_dispatched_at`,
  `probe_progress` and `probe` on both runtimes, and the start endpoint takes an optional `{ mode }`
  body (absent is the provisioning self-test, so an existing client is unchanged). The reasoning, the
  traps and the wiring: `backend/docs/environment-self-tests.md`.

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0
  - @cat-factory/agents@0.158.0
  - @cat-factory/orchestration@0.303.0
  - @cat-factory/server@0.316.0
  - @cat-factory/node-server@0.226.0
  - @cat-factory/executor-harness@1.155.0
  - @cat-factory/binary-generators@0.3.40
  - @cat-factory/gitlab@0.23.3
  - @cat-factory/integrations@0.172.9
  - @cat-factory/prompt-fragments@1.1.36

## 0.146.8

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/agents@0.157.2
  - @cat-factory/executor-harness@1.155.0
  - @cat-factory/integrations@0.172.8
  - @cat-factory/kernel@0.339.0
  - @cat-factory/node-server@0.225.6
  - @cat-factory/orchestration@0.302.2
  - @cat-factory/server@0.315.2
  - @cat-factory/binary-generators@0.3.39
  - @cat-factory/gitlab@0.23.2
  - @cat-factory/prompt-fragments@1.1.35

## 0.146.7

### Patch Changes

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
- Updated dependencies [386c4a2]
  - @cat-factory/agents@0.157.1
  - @cat-factory/executor-harness@1.153.0
  - @cat-factory/integrations@0.172.7
  - @cat-factory/kernel@0.338.0
  - @cat-factory/node-server@0.225.5
  - @cat-factory/orchestration@0.302.1
  - @cat-factory/binary-generators@0.3.38
  - @cat-factory/server@0.315.1
  - @cat-factory/gitlab@0.23.1
  - @cat-factory/prompt-fragments@1.1.34

## 0.146.6

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/orchestration@0.302.0
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0
  - @cat-factory/agents@0.157.0
  - @cat-factory/server@0.315.0
  - @cat-factory/gitlab@0.23.0
  - @cat-factory/integrations@0.172.6
  - @cat-factory/binary-generators@0.3.37
  - @cat-factory/node-server@0.225.4
  - @cat-factory/executor-harness@1.151.0
  - @cat-factory/prompt-fragments@1.1.33

## 0.146.5

### Patch Changes

- 5c50d30: Cleanup pass with no behaviour change: deletes exports nothing consumed (dead constants, parse
  wrappers, alias schemas, pass-through re-exports and the Worker's compat-shim modules left over
  from the `@cat-factory/server` extraction), drops the `export` keyword from module-local symbols,
  folds duplicated private helpers onto one owner (base64, `scrub`, `sleep`, `withFlag`, the
  per-row busy guard), and removes tests that asserted a constant against its own literal or
  re-implemented the code under test. The SPA's unreachable palette drop handler goes with it.
  
  Internal-surface break, flagged per the compatibility rules: the removed barrel exports
  (`DEFAULT_CI_MAX_ATTEMPTS`, `STANDARD_PHASES`, `isTestingKind`, `isBugFishingPhaseId`,
  `SEALED_SECRET_SOURCE_NAMES`, `TelemetryReadResults`, `LinearFetchLike`, `ENVIRONMENT_BLOCK_TYPE`,
  the contracts `parse*`/`safeParse*` one-liners and the `initiativePreset*`/`taskTypeFieldOption`
  schema aliases) had no consumer in this repository; a downstream import of one of them fails at
  typecheck and should read the underlying helper directly.
- Updated dependencies [5c50d30]
  - @cat-factory/agents@0.156.3
  - @cat-factory/contracts@0.346.2
  - @cat-factory/gitlab@0.22.36
  - @cat-factory/integrations@0.172.5
  - @cat-factory/kernel@0.336.1
  - @cat-factory/node-server@0.225.3
  - @cat-factory/orchestration@0.301.3
  - @cat-factory/prompt-fragments@1.1.32
  - @cat-factory/server@0.314.3
  - @cat-factory/binary-generators@0.3.36
  - @cat-factory/executor-harness@1.151.0

## 0.146.4

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
  - @cat-factory/agents@0.156.2
  - @cat-factory/executor-harness@1.151.0
  - @cat-factory/integrations@0.172.4
  - @cat-factory/kernel@0.336.0
  - @cat-factory/node-server@0.225.2
  - @cat-factory/orchestration@0.301.2
  - @cat-factory/server@0.314.2
  - @cat-factory/binary-generators@0.3.35
  - @cat-factory/gitlab@0.22.35
  - @cat-factory/prompt-fragments@1.1.31

## 0.146.3

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1
  - @cat-factory/orchestration@0.301.1
  - @cat-factory/server@0.314.1
  - @cat-factory/executor-harness@1.149.0
  - @cat-factory/agents@0.156.1
  - @cat-factory/binary-generators@0.3.34
  - @cat-factory/gitlab@0.22.34
  - @cat-factory/integrations@0.172.3
  - @cat-factory/prompt-fragments@1.1.30
  - @cat-factory/node-server@0.225.1

## 0.146.2

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0
  - @cat-factory/agents@0.156.0
  - @cat-factory/orchestration@0.301.0
  - @cat-factory/server@0.314.0
  - @cat-factory/node-server@0.225.0
  - @cat-factory/executor-harness@1.149.0
  - @cat-factory/binary-generators@0.3.33
  - @cat-factory/gitlab@0.22.33
  - @cat-factory/integrations@0.172.2
  - @cat-factory/prompt-fragments@1.1.29

## 0.146.1

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0
  - @cat-factory/agents@0.155.0
  - @cat-factory/orchestration@0.300.0
  - @cat-factory/server@0.313.0
  - @cat-factory/node-server@0.224.0
  - @cat-factory/executor-harness@1.149.0
  - @cat-factory/binary-generators@0.3.32
  - @cat-factory/gitlab@0.22.32
  - @cat-factory/integrations@0.172.1
  - @cat-factory/prompt-fragments@1.1.28

## 0.146.0

### Minor Changes

- e7e1f8c: Bug fishing expeditions: hunt a codebase for the defects nobody has reported yet
  
  Every defect flow the platform had started from a REPORT: `bug-investigator` triages one,
  `pl_bugfix` fixes one, `bug-hunt` picks one off a tracker board. Nothing looked for the defects
  nobody has hit, and those are the ones that surface as an incident rather than as a ticket.
  
  A new `bug-fishing` task type runs the new read-only `bug-fisher` agent over a service's codebase
  once per ANGLE — logic and control flow, failure handling, boundary conditions, concurrency and
  idempotency, state and resource lifecycle, interface contracts, footguns, and conformance with the
  supplied product requirements. One pass told to find everything returns the shallow half of
  everything; a pass told to think only about concurrency reads the same files with a question that
  makes the race visible, and each angle is its own dispatch with a fresh context, so one angle's
  reading never lands on another's transcript. Nothing is written and no pull request is opened.
  
  Triage does not wait for the hunt. A finished angle's findings are final the moment they land, so
  the expedition window offers them while later angles are still fishing, and each finding a human
  MARKS spawns its own bug-fix task — carrying the finding's evidence and reproduction — on the
  pipeline the board configures for spawned fixes (`bugFishingFixPipelineId`, defaulting to the
  built-in bug-fix preset, overridable per batch). The spawned task links back through the new
  `Block.expeditionId`.
  
  Refusals are deliberately loud rather than convenient. A pass that crashes settles THAT angle as
  failed carrying its reason, and so does one that answers unusably (no `result.custom`, or a blob
  the schema rejects), because a phase that silently reported nothing is indistinguishable from one
  that honestly found nothing — and which angles came back empty is the whole thing a human reads.
  A mark whose fix task cannot be created — a pipeline that no longer exists, or one that cannot be
  started on a one-off task — fails with the pipeline named instead of answering 200 and leaving
  somebody waiting for a task that will never appear. Dismissing an id the expedition does not carry
  is refused rather than quietly accepted. And an expedition that caught nothing still parks and
  says so.
  
  Marking is safe against two people at once. Creating the task and recording it after would let two
  markings of one finding each file the same bug and start a run for it, so the finding's spawn
  record is taken as a `pending` CLAIM under the run's compare-and-swap, carrying the block id it is
  about to create, and settled to `spawned` or `failed` behind the work. The consequence for anyone
  reading the state: whether a finding is being fixed is its spawn's `status`, not the record being
  present. A spawned fix is also created the way the create form would have created it — with the
  service's standing standards and the marking user as its creator — so it is held to the same
  standards as the identical bug filed by hand, and the notifications its run raises reach somebody.
  
  The pre-dispatch input gate learned about the type: a bug-fishing task legitimately carries no
  description, because its input is the codebase, so `description_missing` no longer parks one at
  step 0.
  
  Public API: `taskType` gains `bug-fishing` and `NotificationType` gains `bug_fishing_triage`,
  with two new optional notification-payload fields (`phaseCount`, `untriagedFindingCount`). Both are
  additive enum members the SDKs already tolerate; the spec is `1.67.0`.
  
  Internal break: `workspace_settings` and `blocks` each gain a column, and
  `ExecutionServiceDependencies` gains an optional `serviceRepository` plus an optional
  `promptFragmentSource` (the pool a newly created task's default fragments come from, so a spawned
  fix reads the same one the create form does). Both facades ship the migration.

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0
  - @cat-factory/agents@0.154.0
  - @cat-factory/orchestration@0.299.0
  - @cat-factory/integrations@0.172.0
  - @cat-factory/server@0.312.0
  - @cat-factory/node-server@0.223.0
  - @cat-factory/executor-harness@1.149.0
  - @cat-factory/binary-generators@0.3.31
  - @cat-factory/gitlab@0.22.31
  - @cat-factory/prompt-fragments@1.1.27

## 0.145.2

### Patch Changes

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
- Updated dependencies [3b11b10]
  - @cat-factory/executor-harness@1.149.0
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0
  - @cat-factory/agents@0.153.1
  - @cat-factory/binary-generators@0.3.30
  - @cat-factory/gitlab@0.22.30
  - @cat-factory/integrations@0.171.2
  - @cat-factory/orchestration@0.298.1
  - @cat-factory/prompt-fragments@1.1.26
  - @cat-factory/server@0.311.3
  - @cat-factory/node-server@0.222.2

## 0.145.1

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0
  - @cat-factory/agents@0.153.0
  - @cat-factory/orchestration@0.298.0
  - @cat-factory/executor-harness@1.147.0
  - @cat-factory/binary-generators@0.3.29
  - @cat-factory/gitlab@0.22.29
  - @cat-factory/integrations@0.171.1
  - @cat-factory/prompt-fragments@1.1.25
  - @cat-factory/server@0.311.2
  - @cat-factory/node-server@0.222.1

## 0.145.0

### Minor Changes

- 1c79070: An environment provider can state a balancer by NAME, and the platform resolves it when it dials
  
  A route candidate had to be an IP literal, on the reasoning that "a name would just be the lookup
  that already failed". That is true of the environment's own hostname and false of the name the
  deployments this feature exists for actually have: a per-PR environment whose record lives in an
  internal view is fronted by load balancers that are ordinary public names, and those names resolve
  from anywhere. A provider had to resolve them itself and state the result, which pins a snapshot of
  a set that rotates as the balancer scales, forces DNS into a pure response mapping, and asks every
  such provider to get bounded resolution and partial failure right on its own.
  
  A candidate may now state `host` instead of `address`, and a manifest declares one through the new
  `response.hostsPath` beside `addressesPath`. The platform resolves each stated name at the moment
  it dials, expands it in place into the addresses it answered with (so the provider's preference
  order still means what it says), and grades every one of those addresses by exactly the rule that
  governs a stated address, so an address a bridge may not name is still refused and the destination
  a container is bridged to is still a literal the platform itself proved. The proof publishes the
  address that carried plus the name it came from, and the stored candidate stays the stable identity
  rather than today's answer, which is also what lets a proof survive the balancer changing addresses.
  
  Which kind a candidate names is stated, never inferred from the value. The address rule refuses
  `2130706433` precisely because it is loopback in a disguise, and a resolver handed the same string
  answers loopback without complaint, so a bare string means an address under `addressesPath` and a
  name under `hostsPath`.
  
  Every way a name fails to become an address is recorded as its own attempt rather than dropped: a
  name that resolves nowhere rules that candidate out and the proof moves to the next, a lookup that
  failed (or a resolver that rejected, which the port forbids and nothing can enforce) carries the
  resolver's own words, and a deployment with nothing wired to resolve records the new
  `resolver_unavailable` reason, which settles nothing either way and can never fail a frame. Both
  facades wire a resolver (Node through `dns.lookup`, the Worker over DNS-over-HTTPS, which is the
  view its own outbound connections already resolve through).
  
  The platform also says when it stopped reading: the plan bounds how many names it looks up and how
  many addresses it dials, and a list longer than that now ends in one `not_attempted` attempt naming
  how many were passed over. That is a second new reason, and it leaves the route unruled-out for the
  same reason the first does. A verdict that nothing reaches an environment may not be graded against
  candidates nobody looked at, and the deployer fails a frame on that verdict.
  
  Two proofs that used to stand forever are now re-taken by the status poll: one recording that this
  deployment could not resolve a name (once one is wired), and a `reached` proof whose address was
  RESOLVED rather than stated. The second is the price of surviving a balancer rescale, which is what
  `viaHost` is for: the name stays good while the literal beside it, the one a container host bridge
  is built from, can be released by the same scale event.
  
  Internal breaks, no migration: `EnvironmentAddress` / `environmentAddressSchema` are renamed to
  `EnvironmentRouteCandidate` / `environmentRouteCandidateSchema` with `address` now optional;
  `planRouteProbes` takes an options object in place of its bare timeout argument;
  `RouteProbeTarget`'s `refused` member is generalized to `undialled` and `recordRefusedAttempt` to
  `recordUndialledAttempt`; and `reduceRouteProof` takes the carrying target rather than its address.
  A stored candidate or proof written before this parses and behaves exactly as it did.

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0
  - @cat-factory/integrations@0.171.0
  - @cat-factory/agents@0.152.0
  - @cat-factory/orchestration@0.297.0
  - @cat-factory/node-server@0.222.0
  - @cat-factory/executor-harness@1.147.0
  - @cat-factory/binary-generators@0.3.28
  - @cat-factory/gitlab@0.22.28
  - @cat-factory/prompt-fragments@1.1.24
  - @cat-factory/server@0.311.1

## 0.144.0

### Minor Changes

- 8b015a3: Bootstrap a new service INTO an existing monorepo, with a human review of what it adopts.
  
  Repo bootstrap only ever created a service in a repository of its own: clone a reference
  architecture, adapt it, force-push a single commit to a fresh empty repo. That shape is exactly
  wrong for a monorepo, which already holds other people's services: there is no empty target, the
  force-push would destroy them, and the question worth asking is not what the service contains but
  what it should share with everything around it. A bootstrap can now target a DIRECTORY of a
  repository the workspace already has, and it is delivered as a pull request.
  
  That question has no good default, which is why the run stops to ask. The template ships its own
  build tooling, lint config, test runner, CI wiring and layout; the monorepo has answers for the
  same areas, usually different ones. Adopt the template wholesale and the repository grows a second
  toolchain; adopt the monorepo wholesale and the template stops being worth having. So a monorepo
  run is two phases with a person between them: it surveys both sides, proposes per-area
  recommendations, parks on a new `awaiting_review` status, and writes nothing until a human has
  settled every line.
  
  The suggestion is built to be CHECKED rather than trusted. The platform reads a bounded, declared
  set of files through the checkout-free repo port (the root manifests, the CI workflows, and the
  nearest EXISTING sibling service, which is the only thing that says what a service in this
  repository actually looks like), and the model only judges what it was given. A recommendation
  whose evidence names no file the survey read is dropped before it reaches the reviewer, and the
  plan reports the drop rather than quietly shortening: a plan that lost half its lines to invention
  must not look like a monorepo with few conventions. What the survey could not read is reported
  apart from what is simply absent, for the same reason.
  
  Two refusals are load-bearing. A review that leaves a decision unanswered is refused rather than
  defaulted onto the recommendation, because agreeing with a suggestion and never having read it are
  the two things this step exists to tell apart. And an answer naming a decision the plan does not
  carry is refused whole, since the reviewer was looking at a different proposal. Where no model is
  configured, over budget, or unable to read the repository, the run still parks and the reviewer is
  told what the platform could not offer and why. An empty decision list and "the analysis never
  ran" lead to opposite conclusions, and each cause needs a different fix, so each is its own
  reason. The reviewer can settle such a plan anyway: there is nothing to answer, their notes are
  the whole instruction, and the review is the only exit from the park.
  
  The survey's own model call is guarded twice. It answers to the same workspace budget a run start
  does, since nothing else gates it; and it is claimed atomically before the call rather than marked
  after it, because both durable drivers replay and two drives that each saw no plan yet would bill
  twice and leave a reviewer answering a plan that had been replaced underneath them.
  
  The apply phase is an ORDINARY coding job rather than a bootstrap one: the monorepo as the
  writable primary at a work branch, the reference template beside it as a read-only checkout the
  run is structurally incapable of pushing to, and one pull request. Nothing outside the new
  directory is touched beyond the registration the monorepo's own tooling needs, and nothing is
  merged for the reviewer.
  
  The settled decisions ride the pull request as an engine-owned marker region rather than as its
  body. The harness lets an agent-authored description replace the body field-wise, and it asks for
  one whenever the target repository ships a pull request template, so the reviewed decisions (the
  one thing on that PR the agent did not choose) would otherwise be routinely overwritten. The
  region also means every hole in it crosses the host-markdown boundary: a reviewer's note reading
  "fixes #412" would close an unrelated issue on the monorepo when the bootstrap PR merged.
  
  `BootstrapStatus` gains `awaiting_review` and `BootstrapJob` gains `prUrl`, both reaching
  `/api/v1` (surface 1.65.0) because a run started in the app is read through it. `prUrl` is a new
  field rather than a reuse of `repoUrl`: a monorepo run creates no repository, and putting a pull
  request link in a field documented as the created repository's URL would leave an integration
  that clones what it reads cloning a PR. It is additive (the clients tolerate unknown enum values),
  but a poller's terminal test has to change: `awaiting_review` is neither running nor finished, so a
  loop treating "not succeeded and not failed" as "still working" would wait forever on a run that is
  waiting for a person.

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0
  - @cat-factory/agents@0.151.0
  - @cat-factory/orchestration@0.296.0
  - @cat-factory/server@0.311.0
  - @cat-factory/node-server@0.221.0
  - @cat-factory/executor-harness@1.147.0
  - @cat-factory/binary-generators@0.3.27
  - @cat-factory/gitlab@0.22.27
  - @cat-factory/integrations@0.170.1
  - @cat-factory/prompt-fragments@1.1.23

## 0.143.1

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0
  - @cat-factory/integrations@0.170.0
  - @cat-factory/agents@0.150.0
  - @cat-factory/orchestration@0.295.0
  - @cat-factory/node-server@0.220.0
  - @cat-factory/executor-harness@1.147.0
  - @cat-factory/binary-generators@0.3.26
  - @cat-factory/gitlab@0.22.26
  - @cat-factory/prompt-fragments@1.1.22
  - @cat-factory/server@0.310.2

## 0.143.0

### Minor Changes

- 720bad0: A boot-validation warning now names ONE structured `subject`, so `escalateRegistrationWarning` can
  dispose of a mixed fragment declaration per id.
  
  `task_type_unknown_fragment` reports one warning per unresolved id instead of batching a
  declaration's ids into one, and every warning carries the id it is about as data rather than only
  interpolated into its message. A deployment whose `defaultFragmentIds` names code-registered
  standards beside a late-bound tenant-tier reference can now fail boot on the typo and keep the
  warning on the late-bound id, by testing the namespace its own standards live under:
  
  ```ts
  escalateRegistrationWarning: (p) =>
    p.code === 'task_type_unknown_fragment' && p.subject.startsWith('acme.'),
  ```
  
  Test that namespace positively. The inverse (`!p.subject.startsWith('src:')`) reads as the same rule
  and is not one: a hand-authored account-tier row and a repo-sourced file pinning its own frontmatter
  `id` both carry a plain slug, so it fails boot on exactly the tenant-tier reference it means to
  spare.
  
  The platform's own severity is unchanged: both are still warnings by default, because boot cannot
  tell a typo from a tenant-tier id. Design record: ADR 0063.
  
  Two reports also stop arriving in duplicate: a repeated id in one declaration is one warning, and a
  tool-server definition shared across kinds is checked once, naming every kind it is declared for. A
  blank `defaultFragmentIds` entry is now an ERROR (no tier resolves a blank id, so it cannot be a
  late-bound reference).
  
  INTERNAL BREAK (pre-1.0, no shim): `RegistrationProblem` is now a union of `RegistrationErrorProblem`
  and `RegistrationWarning`, and only the warn branch carries `subject`; its `code` is the closed
  `RegistrationWarnCode` union. Code constructing a problem by hand, or reading `subject` off the
  union, must narrow on `severity` first. An `escalateRegistrationWarning` predicate written against
  the previous signature keeps compiling: its parameter is narrowed to `RegistrationWarning`, and
  every field it could read is still present. The two credential warnings
  (`oauth_header_collision`, `unused_credential_env_name`) name the TOOL SERVER as their subject
  rather than the credential key, which several servers may share.

### Patch Changes

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
- Updated dependencies [436f373]
- Updated dependencies [720bad0]
  - @cat-factory/executor-harness@1.147.0
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0
  - @cat-factory/orchestration@0.294.0
  - @cat-factory/node-server@0.219.0
  - @cat-factory/agents@0.149.1
  - @cat-factory/binary-generators@0.3.25
  - @cat-factory/gitlab@0.22.25
  - @cat-factory/integrations@0.169.1
  - @cat-factory/prompt-fragments@1.1.21
  - @cat-factory/server@0.310.1

## 0.142.0

### Minor Changes

- a745ee2: An environment now carries an address as well as a name, and the platform proves the route before a tester is pointed at it
  
  An environment reached an agent as one nullable URL, so "reachable" meant "a URL exists" and
  nothing between the provider stating it and a tester dialling it ever checked. The tester then got
  `curl` code 000, which covers a DNS failure, a missing route and a refused connection as one
  symptom, and reported the hypothesis its own task made salient: that the environment was down.
  
  Three things change together, because landing any one alone is incoherent or worse than today. A
  host bridge can now map a name to an ADDRESS as well as to the container runtime's host gateway,
  which is what a per-PR environment whose DNS record lives in an internal view needs. The deployer
  DIALS the environment once when its frame settles ready, publishing the candidate that carried
  rather than the first that resolved and recording every attempt either way. And what it proved
  rides the handle into the tester's prompt, so an agent that cannot resolve a name is told which
  layer the platform already ruled out and which address carried.
  
  An environment nothing can reach now settles the frame `failed` with the new
  `environment_unreachable` reason, in about two minutes, rather than being handed on for a tester to
  spend ten minutes and a model budget misdiagnosing. That failing verdict is deliberately the narrow
  one, because a wrong "unreachable" kills a healthy deploy while a wrong "could not tell" costs one
  diagnostic: a probe that could not classify its own failure, an environment with no address to dial
  (a `ready` service that publishes no ingress), and a facade with nothing wired to open a socket are
  `inconclusive` or `unproved`, and neither fails anything. The agent is told when a check was
  inconclusive; a deployment with no prober carries no reachability line at all.
  
  The addresses the platform will dial are limited to those a host bridge may name, applied when the
  probe is PLANNED rather than only when a bridge is built, so a provider-authored address list
  cannot aim the platform's own outbound socket at loopback or a cloud metadata endpoint. A refused
  address is recorded on the proof rather than silently dropped.
  
  Internal breaks, both deliberate: `RunnerDispatchOptions.environmentUrls` becomes `environments`,
  a list of `{ url, address? }` (the pairing is what keeps the host side of a bridge a host the job
  was actually handed), and `planEnvironmentBridges` moves from the local runtime into
  `@cat-factory/integrations`, where the Kubernetes runner transport builds the same bridges as pod
  `hostAliases`. Existing environment rows carry no addresses and no proof, which reads exactly as it
  should: nothing has looked yet.

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0
  - @cat-factory/integrations@0.169.0
  - @cat-factory/agents@0.149.0
  - @cat-factory/orchestration@0.293.0
  - @cat-factory/server@0.310.0
  - @cat-factory/node-server@0.218.0
  - @cat-factory/executor-harness@1.145.1
  - @cat-factory/binary-generators@0.3.24
  - @cat-factory/gitlab@0.22.24
  - @cat-factory/prompt-fragments@1.1.20

## 0.141.16

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0
  - @cat-factory/integrations@0.168.0
  - @cat-factory/orchestration@0.292.0
  - @cat-factory/server@0.309.0
  - @cat-factory/node-server@0.217.0
  - @cat-factory/agents@0.148.0
  - @cat-factory/executor-harness@1.145.1
  - @cat-factory/binary-generators@0.3.23
  - @cat-factory/gitlab@0.22.23
  - @cat-factory/prompt-fragments@1.1.19

## 0.141.15

### Patch Changes

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
- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0
  - @cat-factory/integrations@0.167.0
  - @cat-factory/agents@0.147.0
  - @cat-factory/orchestration@0.291.0
  - @cat-factory/server@0.308.0
  - @cat-factory/node-server@0.216.0
  - @cat-factory/executor-harness@1.145.1
  - @cat-factory/binary-generators@0.3.22
  - @cat-factory/gitlab@0.22.22
  - @cat-factory/prompt-fragments@1.1.18

## 0.141.14

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
- Updated dependencies [0f426b3]
  - @cat-factory/agents@0.146.6
  - @cat-factory/executor-harness@1.145.1
  - @cat-factory/integrations@0.166.22
  - @cat-factory/kernel@0.323.2
  - @cat-factory/node-server@0.215.13
  - @cat-factory/orchestration@0.290.2
  - @cat-factory/binary-generators@0.3.21
  - @cat-factory/server@0.307.9
  - @cat-factory/gitlab@0.22.21
  - @cat-factory/prompt-fragments@1.1.17

## 0.141.13

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
- Updated dependencies [332ef26]
  - @cat-factory/agents@0.146.5
  - @cat-factory/executor-harness@1.144.1
  - @cat-factory/integrations@0.166.21
  - @cat-factory/kernel@0.323.1
  - @cat-factory/node-server@0.215.12
  - @cat-factory/orchestration@0.290.1
  - @cat-factory/binary-generators@0.3.20
  - @cat-factory/server@0.307.8
  - @cat-factory/gitlab@0.22.20
  - @cat-factory/prompt-fragments@1.1.16

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
