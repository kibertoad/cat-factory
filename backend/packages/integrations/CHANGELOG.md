# @cat-factory/integrations

## 0.172.10

### Patch Changes

- Updated dependencies [5f06bfb]
  - @cat-factory/contracts@0.349.0
  - @cat-factory/kernel@0.341.0

## 0.172.9

### Patch Changes

- Updated dependencies [8dc6677]
  - @cat-factory/contracts@0.348.0
  - @cat-factory/kernel@0.340.0

## 0.172.8

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

## 0.172.7

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
  - @cat-factory/kernel@0.338.0

## 0.172.6

### Patch Changes

- 76e2c1d: Bug-fishing expeditions now partition a large codebase into TERRITORIES and fish each angle over
  each one, instead of telling every pass to decide for itself where an angle could bite.
  
  The partition is computed by the platform from the repository tree (blueprint modules first, then
  package and directory boundaries, sized by blob bytes), the expedition stays ONE run whose phase
  list is territory x angle, each pass is handed its territory's manifest as a `.cat-context/` file
  so it starts from a map rather than three greps, and what each pass reported reading becomes a
  per-phase coverage record. A pass budget bounds the matrix and every cell it cuts is recorded as
  unfished. A codebase small enough to fish whole runs exactly as before.
  
  Territories are computed and stated in the frame the AGENT works in: the service's own directory
  in a monorepo, which is where the harness roots its checkout, rather than the repository root.
  
  A task-type field descriptor gains `integer`, so a `number` field whose value must be whole says so
  where a caller can read it instead of being refused at creation with a raw schema error. The public
  API spec moves to 1.70.0 for it; `review.prNumber` and the new `bug-fishing.fishingMaxPasses` both
  declare it.
  
  Internal wire break: `GitHubClient.listTree` and `VcsClient.listTree` now return
  `{ entries, truncated }` rather than a bare array, so a caller building a manifest can tell a
  truncated tree from a complete one. `bug-fisher` switches to `standardsDelivery: 'context-files'`,
  so its standards are read once from `.cat-context/` instead of re-sent on every turn of every
  pass.
- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0

## 0.172.5

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
  - @cat-factory/contracts@0.346.2
  - @cat-factory/kernel@0.336.1

## 0.172.4

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

## 0.172.3

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 0.172.2

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 0.172.1

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 0.172.0

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

## 0.171.2

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 0.171.1

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.171.0

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

## 0.170.1

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.170.0

### Minor Changes

- ec0aba1: Keep what a status poll observes, and stop the environment investigation reasoning past it
  
  The first real environment investigation produced a confident wrong verdict: it blamed a platform
  readiness gate that had worked correctly, told a human to go change three behaviours that already
  behave as asked, and filed the actual cause as one bullet underneath. Three defects behind it, all
  in what the platform recorded rather than in what the model did with it.
  
  **A status poll now persists what it captured.** `refreshStatus` handed the whole provision-field
  bag to the provider and then wrote a patch that omitted it, so `provision_fields_cipher` was
  written once at create time and never again. For an asynchronous provider the create response is
  the least informative answer it will ever give (no finished deploy job, no load balancers, no
  readiness detail), so every fact worth capturing arrived on a poll and was discarded, and an
  adapter recording its balancer health and DNS resolution on each poll was writing into a field
  nothing read. A stated bag now REPLACES the stored one, whole, and
  `ProvisionedEnvironment.fields` is nullable: `null` states nothing and keeps what is stored, which
  is what stops a status endpoint answering a narrower shape than its create endpoint from erasing
  teardown state. The docstring described merge semantics and the code implemented neither.
  
  The corollary binds every adapter: a statement has to be COMPLETE. The generic manifest provider's
  `status()` therefore carries the keys this response said nothing about over from the stored bag
  under its freshly mapped values, because its bag is built from two paths a status endpoint commonly
  omits (the id usually rides the request path, not the body). Its no-`status`-template fallback and
  the Compose provider's no-project branch answer `null`, which is what an adapter that read nothing
  owes.
  
  **A poll the provider ANSWERED leaves a trail.** The provisioning log records a poll that threw and
  a poll that turned an environment `failed`; any other answer wrote nothing anywhere, so a readiness
  wait that polled for four minutes left two rows a second apart at the create, and nothing in the
  data distinguished "nothing polled" from "polling is not logged". The environment row carries
  `lastPolledAt` plus a `pollCount` floor (a row per poll being the wrong shape at a ten-second
  cadence), both projected onto `EnvironmentHandle`. It counts ANSWERS rather than successes, a
  `failed` verdict included: the claim a reader gets wrong is how much polling happened, and reading
  it as a success count would hand an investigation twenty-two successes for an environment that
  failed all twenty-two.
  
  **The investigation's evidence carries the route, and one timeline.** The bundle gains
  `route` (the addresses the provider stated and what dialling them proved) and folds the proof into
  the timeline dated from its own `checkedAt`, so an ordering claim that contradicts a timestamp the
  platform held is structurally hard to state; the verdict that filed this said the reachability
  check "settled roughly at the moment of the create request" against a `checkedAt` reading 4m18s
  later. The provisioning log's own state is an entry in that list too, in each of the four ways it
  can have one (this deployment keeps none / this environment is on no run / it was read and holds
  nothing / the read threw), because once the record's dates and the poll marker joined the timeline
  an absent log stopped being distinguishable from an empty one by the list coming back short. The
  platform also COMPUTES the determinate cause where its own inputs settle one (a `not_reached` proof
  beside an empty candidate list means nothing but the environment's own name was ever available to
  dial; a `no_candidate` proof BESIDE stated addresses is the different determinate cause that the
  URL published none, not that the provider stated no addresses) and tells the model it outranks
  anything inferred from apparent ordering. Prompt bumped to `environment-investigation@v2`, which
  also forbids reading the absence of an entry in a record of attempts as the absence of the event,
  and names the route evidence and the poll marker as sources an answer may cite.
  
  The route evidence is scrubbed and bounded on the way into the bundle, like every other
  provider-authored section: `candidates` comes off a response mapping with no declared length and a
  probe's `detail` is the only field carrying a raw error string. The attempt list now has ONE
  renderer (kernel's `describeRouteTargets`) rather than a copy per surface, which is how one of them
  came to ship that detail unredacted while its neighbour scrubbed it.
  
  **A route proof survives on what it established.** The fold compared the candidate list as a
  SEQUENCE, so any later poll whose list merely reordered dropped the proof, and nothing took
  another: `proveEnvironmentRoute` is reached only from the deployer's frame settle, which never runs
  again for a settled frame. A provider stating addresses from a live DNS answer does not control
  their order. A `reached` proof now survives while the target it names is still on offer (compared
  after the same trim the prober applies, so a padded address stops failing to match its own proof),
  any other proof while the candidate set is unchanged, and `refreshStatus` re-proves a `ready`
  environment whose proof it had to drop.
  
  The re-prove is bounded, and the bound needed a third field. It runs at most once a minute per
  environment, because a provider that genuinely re-states a different candidate set on every answer
  would otherwise add up to twenty seconds of sequential dialling to every poll of a ten-second
  readiness wait. Pacing that off the proof's own `checkedAt` does not work: the first time the poll
  waits, it persists the drop, and the next poll reads an environment nothing ever dialled. So
  `EnvironmentReachability` carries `probedAt` (when the platform last LOOKED, kept across a dropped
  verdict and a moved URL), which is also what lets an environment settled `unproved` before a
  deployment wired its prober get proved once one exists: `unproved` is a proof never taken, and it
  survives the fold indefinitely.
  
  Internal break: `ProvisionedEnvironment.fields` is `ProvisionFields | null` (nullable, not
  optional, so every provider still has to decide), `EnvironmentRecord` gains `lastPolledAt` and
  `pollCount`, and the stored reachability blob gains an optional `probedAt`. Both facades add the two
  columns (D1 migration 0099 and the matching Drizzle migration) and existing rows read back as
  never-polled, which is what they are; `probedAt` needs no migration (it is inside the existing JSON
  column) and a value written without one re-proves at its first opportunity.

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.169.1

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.169.0

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

## 0.168.0

### Minor Changes

- 92232a6: Let a provider say WHY an environment is not ready yet, so the readiness ceiling stops reporting only its own duration
  
  `judgeEnvironmentReadiness` formatted the provider's `lastError` into its `timed_out` message, and
  `lastError` is structurally always `null` on the one status that can reach that branch. Both
  persistence sites write it on `failed` alone and null it otherwise, so every poll that keeps a
  readiness wait alive cleared it and any poll that would have filled it settled the wait as `failed`
  first. The clause was unreachable, and the platform's whole account of a 20-minute wait was that it
  had waited 20 minutes.
  
  The missing thing was not the clause. `ProvisionedEnvironment` had no channel at all for a
  non-terminal explanation, so a provider that could name the stage an environment was stuck at had
  nowhere to put it. `ProvisionedEnvironment.statusNote` is that channel: one sentence, persisted on
  every provision and every poll whatever the status, surfaced in the step's Environment panel while
  the run is parked, in the run outcome's environment row, and in the `timed_out` failure detail.
  
  **A sibling field rather than `lastError` widened to every status**, which was the cheaper option
  and the wrong one. The note is rendered, and under the error's name a healthy environment
  mid-rollout would show an operator a "last error" it does not have. The two are read by different
  readers for opposite reasons and only one of them is a fault, so each keeps its own column and its
  own label wherever it is shown.
  
  **A recorded fault outranks a note on every reader, and neither is ever dropped for the other.**
  The `timed_out` message states both when both are present, fault first, each under its own label.
  The Environment panel withholds the note whenever a `lastError` is recorded, whatever the status
  (a torn-down environment carries the fault of the failure that preceded it), and says nothing
  beside a status that has already left the state a note describes. And where the run OUTCOME's
  environment row shows one of them, it says which: `OutcomeEnvironment.detailKind` is `fault` or
  `note`, because the two arrive through one slot, read identically as prose, and send a reader to
  opposite conclusions. Public API surface 1.63.0, additive.
  
  **The note is bounded where it is written**, not where it is read: provider-authored prose reaches
  three surfaces, and a code adapter answering with a controller dump would otherwise push each of
  them off screen. A capped note says it was capped.
  
  **The note is the current account, never a log.** It is re-read and rewritten on every poll,
  including back to `null`, so a note a provider stops returning stops being stored and cannot outlive
  the state it described. A deployment whose providers never set one keeps today's behaviour byte for
  byte, including the exact wording of both refusals.
  
  The built-in Kubernetes adapter is the first producer, at the two places it already knew and said
  nothing: which Deployments have not finished rolling out (capped, and the cap says it is capped),
  and a workload that is healthy behind an Ingress no controller has routed yet, where the ceiling
  previously reported a bare twenty-minute wait on an environment that had been up for nineteen of
  them. `IngressAdmission`'s `pending` verdict gained the prose that distinguishes its two causes.
  
  Its FAULT channel had the same hole, one status over, and it is closed here too: a rollout that
  gave up and a namespace that no longer exists were both reported as the generic `Provisioning
  failed` literal, though the reduction computing the verdict was holding the workload's own name.
  Both now name what happened.
  
  Watch for: the new `status_note` column lands as a nullable add on both runtimes (D1 migration 0098
  and the Drizzle mirror), and the deployer's projection comparison is now derived from the projected
  object rather than a hand-listed subset of its fields. During a wait the note is the only field that
  moves, so leaving it off the list would have meant the one update the projection exists to deliver
  was the one it never pushed; the TTL, provision type and engine beside it were already in that
  position, and now a field added to the projection joins the comparison with no second edit.
  
  The Node Drizzle schema's ephemeral-environment tables moved into `db/tables/environments.ts` to
  keep `schema.ts` inside its size budget, re-exported so no importer changes.
- a08d2ad: Diagnose an environment that never became usable, instead of ending the run at the tester
  
  A provisioning failure that no edit in the checkout could fix used to be terminal and
  unexplained: the `deploy-fixer` correctly declines every cause outside `manifest_invalid`, and
  nothing else looked. The run died at the tester with a report saying a human had to look, while
  the facts that explained it sat unread in the provider's own response.
  
  A `deployer` step now investigates such a failure. The platform gathers the evidence it already
  had (the environment record, the WHOLE captured provision-field bag rather than the four fields
  a consuming step is handed, and the run's provisioning timeline), asks the provider for its own
  account through a new optional `EnvironmentProvider.diagnostics` capability, and runs one inline
  model call that names the fault layer and picks one remediation from a list the engine narrowed
  first. The engine performs it and the deployer re-enters its own path, so the provider's next
  verdict is what settles the frame. When nothing is worth trying, the run still fails, but with a
  named cause instead of a tester's guess.
  
  The Kubernetes backend implements the new capability: `describe` reads the namespace phase, the
  Deployments' unsatisfied conditions, every pod through `analyzePodStatus`, the namespace's
  warning events and a log tail from each unhealthy pod, and `remediate` rolls the Deployments the
  `kubectl rollout restart` way. Every other provider is unaffected and degrades to the platform's
  own evidence, which it states rather than presenting as an absence of problems.
  
  Internal break: `EnvironmentProvisioningServiceDependencies` gains an optional
  `readProvisioningLog` and an optional `logger`; both facades wire them through the shared
  container, so nothing outside a hand-built instance is affected.
  
  The provisioning-log operation vocabulary gains `remediate`, and the platform appends one such row
  whenever it asks a provider to repair an environment in place. It is a distinct actor, the way
  `teardown-verify` is: the investigation's own second round rebuilds its timeline from that log, so
  an unlogged restart leaves the next round reasoning about an environment it believes nothing has
  touched. Additive on `/api/v1` (spec `info.version` 1.63.0); the clients tolerate unknown enum
  values, and a consumer that maps `operation` through an exhaustive table gains a member to name.

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.167.0

### Minor Changes

- dc4a5d9: Import an organisation's Backstage catalog, so triage agents know which services exist and who owns them
  
  The platform knew a great deal about the service being built and, since ADR 0031, about the shared
  capabilities a deployment registered by hand. It knew nothing about the rest of the estate. That
  cost most on the triage path: a bug investigator looking at a cross-service report had the
  repositories it was handed and no record of what else the organisation runs, who owns it, or what
  it exposes, so "which service is this?" was answered from repository names.
  
  Most organisations already record exactly that, in a developer portal. A workspace can now point
  the platform at its Backstage instance and have its components arrive as `workspace`-tier
  foundational services: identity, owner, system, domain and lifecycle composed into the
  description, tags as capabilities, and each API entity's definition stored as one of the service's
  contracts.
  
  **It feeds the EXISTING catalog rather than standing beside it**, which is the decision the rest
  follows from. A parallel mechanism would have meant a second `.cat-context/` directory, a second
  set of trait guidance, a second tiered merge and a second suppression surface, all describing the
  same organisation to the same agents. So an imported service is an ordinary catalog row carrying
  `sourceId: 'service-catalog'`, and the tier merge, the suppression sub-resource, the lazily-read
  contract documents and the SPA's catalog list are untouched.
  
  **Triage agents read it under a new `service-estate` trait, deliberately not the design one.**
  `foundational-catalog` asks its kind to prefer consuming a shared service and to end its reply
  with a machine-read declaration block; both are wrong for an agent whose job is to locate a fault,
  and the second is worse than wrong, because `bug-investigator` and its peers are structured-output
  kinds whose reply IS a JSON object. The estate file states ownership and interface surface and
  asks for nothing back. `bug-investigator` and `on-call` carry it; a deployment's own kind opts in
  through `registerAgentKind({ traits })`. It carries no contract DOCUMENTS: an orientation read
  happens on every triage dispatch, and folding every service's OpenAPI document into one would make
  the prompt scale with the size of the organisation's specs, which is what the catalog/contracts
  split exists to prevent.
  
  **The auth modes are a closed vocabulary of the shapes a self-hosted portal actually runs
  behind**: a static service token, the legacy shared secret (a short-lived HS256 token the platform
  mints per pass), OAuth2 client credentials for an instance behind an IdP or an identity-aware
  proxy, HTTP Basic for a reverse proxy, an explicit header list for a gateway that authenticates on
  its own names, and none at all for an instance reachable only inside a VPN. Free-form headers
  alone would have covered the mechanics and lost every remedy an operator needs when one fails. Two
  details are load-bearing: the legacy secret is base64-DECODED into an HMAC key rather than used as
  UTF-8 (which is what decides whether the token verifies at all, so a secret that is not base64 is
  refused rather than signed with the wrong key), and the header mode takes a LIST because the
  common case needs two: a Cloudflare Access service token is an id plus a secret, and a
  single-pair shape would have sent half a credential.
  
  Reviewers may want to look hardest at three things.
  
  **Widening the URL guard is the ordinary case here, not an exception.** A self-hosted portal
  usually lives on an internal host, so `SERVICE_CATALOG_ALLOW_URL_HOSTS` /
  `SERVICE_CATALOG_ALLOW_HTTP_URLS` exist and are scoped to this integration alone. Redirects are
  followed by hand and re-checked per hop, with the body and `Authorization` dropped on a
  cross-origin one, because the base URL is operator-supplied.
  
  **A partial import must never read as the estate.** An import reports `complete` / `truncated` /
  `empty` coverage plus three skip counts, and stamps `ok` / `partial` / `failed` with a sentence on
  the connection. `empty` is `partial` rather than a healthy import of zero services, because a
  filter that matched nothing is a configuration problem with a remedy. EVERY failure past the
  connection lookup is stamped before it propagates, including one raised before the portal is
  contacted: `lastSyncedAt` is what the autorefresh sweep orders on and it sorts nulls first, so an
  unstamped failure would pin that connection to the head of the stale queue and starve the sweep.
  A failure tombstones nothing: an unreachable portal and an empty one are opposite facts.
  
  **The import YIELDS to a service the workspace already registered by another route**, counting the
  refusal as `skippedConflicts` rather than taking the id over. An upsert there would replace a
  hand-authored row, delete its uploaded contracts and strip any platform capability it was granted,
  and disconnecting would then tombstone the original.
  
  **Two size ratchets moved DOWN, both by splitting.** The Worker's `container.ts` lost its three
  content-library selectors to a new `container-content-library-deps.ts`, the twin of the file the
  Node facade already had, so both facades now hold the same selectors in the same place (874 → 800).
  `orchestration`'s `dependencies.ts` lost the same three libraries' declarations to
  `content-library-dependencies.ts`, which `CoreDependencies` extends (1514 → 1301, under the
  default).
  
  Also in here, because the import needs them: `asyncapi`, `graphql` and `grpc` join the
  contract-format vocabulary, with AsyncAPI indexed (its channels are a parse, not a guess) and the
  other two answering through `operationsAreIndexable` as formats nobody reads. That widened what a
  linked-repository SCAN picks up too, so `detectContractFormat` requires a type-system definition of
  a `.graphql`/`.gql` file and a `service` block of a `.proto` one: the common `.gql` in a repo is a
  client's query text and the common `.proto` is generated message shapes, and neither is an
  interface the service publishes. `ApiContractManifestEntry` gains `sourceSha`, so a sync can decide
  whether a document changed without reading a body. The rendered catalog and estate blocks gained a
  total size cap that states what it dropped, because an imported estate is the first catalog whose
  size is decided by the organisation rather than by this deployment; the catalog's per-service
  heading now reads `id (Name)`, the form the estate block already used.
  
  Four batched repository methods land with it (`upsertMany`, `softDeleteByIds`,
  `replaceForServices`, `deleteForServices`, all on the mothership allow-list): reconciling a
  thousand-service estate one row at a time is two thousand sequential round trips inside one
  request. The `ownerFieldList` scope rule is new beside them, binding every record of a batched
  write rather than the first.
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

## 0.166.22

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
  - @cat-factory/kernel@0.323.2

## 0.166.21

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
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
