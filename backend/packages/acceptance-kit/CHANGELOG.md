# @cat-factory/acceptance-kit

## 0.7.8

### Patch Changes

- Updated dependencies [636fcf3]
  - @cat-factory/kernel@0.339.0

## 0.7.7

### Patch Changes

- Updated dependencies [386c4a2]
  - @cat-factory/kernel@0.338.0

## 0.7.6

### Patch Changes

- Updated dependencies [76e2c1d]
  - @cat-factory/contracts@0.347.0
  - @cat-factory/kernel@0.337.0
  - @cat-factory/sdk@0.51.2

## 0.7.5

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
  - @cat-factory/sdk@0.51.2

## 0.7.4

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
  - @cat-factory/sdk@0.51.1

## 0.7.3

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1
  - @cat-factory/sdk@0.51.0

## 0.7.2

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0
  - @cat-factory/sdk@0.51.0

## 0.7.1

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0
  - @cat-factory/sdk@0.51.0

## 0.7.0

### Minor Changes

- a1802d9: Report what the platform tried about a failed environment, instead of reporting only that it failed
  
  Both remediation loops a `deployer` step can run recorded everything on the step and nothing
  reduced either into the verification report. So a run whose environment failed, was diagnosed as a
  provider fault, was restarted in place and then came up served byte-for-byte what a run with no
  remediation loop wired at all serves. Nothing outside the backend could establish that the loop
  had run: a headless suite reading the report, the one provider-neutral surface it has, had no
  observable to assert on, which made the feature unfalsifiable from outside the deployment.
  
  `environments.entries[].remediation` now carries the DECISIONS, per frame. `deployFix` counts the
  `deploy-fixer`'s repair rounds against the cause it was dispatched for and splits the rounds whose
  job FINISHED from the ones that died having changed nothing in the checkout, because a bare round
  count reads as the first. `investigation` carries the layer the last verdict blamed, the action it
  asked for, every action the engine actually RAN, why a requested action was withheld, the
  investigation's own failure when a round produced no verdict, and how many readiness-ceiling
  extensions a `wait` verdict won: a granted `wait` is the one remedy that otherwise leaves no trace
  anywhere, since the bring-up simply runs past the configured ceiling and the timeline beside it
  cannot be reconciled without it. The investigator's summary paragraph and cited evidence stay on
  the run's own record.
  
  Three absences stay distinct: no `remediation` means neither loop ran, a null `faultLayer` means no
  round produced a verdict (never the `unknown` LAYER, which is a verdict reached on evidence that did
  not settle the question), and an empty `ranActions` means nothing ran, with `withheld` saying why.
  There is no field for whether the remedy WORKED, on purpose: that is the deployer's next verdict,
  which `entries[].status` already states. `@cat-factory/acceptance-kit` gains
  `checkEnvironmentRemediation`, the reduction that asserts the loop ran and settled on a fault layer.
  
  Fixes a defect the new section would otherwise have under-reported, and one bug beside it. A
  loop-back to a `deployer` step (the `human-test` gate rebuilding the environment a person is
  testing) dropped the whole of `step.deployFix`, so a frame whose deployment files the fixer had
  machine-edited reported as one nothing was ever attempted on; and `step.environmentInvestigation`
  had no reset at all, so the looped-back step carried a SPENT budget into its next failure, refused
  the first round of the new cycle as "the budget is spent", and explained the terminal failure with
  the verdict about the environment the re-provision had already superseded. The counters of both are
  now re-armed per provisioning CYCLE and the attempt logs survive the RUN, which is what the report
  reduces.
  
  Splitting those two lifetimes is what every remaining decision here follows from. Each attempt row
  carries the CYCLE that ran it, so a read scopes itself explicitly instead of taking whichever
  half is nearer: the live budget and the last verdict are read within the CURRENT cycle (a verdict
  from a superseded cycle diagnoses an environment the re-provision destroyed), while the report
  reduces the whole log and states `cycles` beside `attempts` rather than printing a run-long count
  against a per-cycle budget. `waitExtensions` is the one counter that stays RUN-long: a cycle is
  not always started by a person or a gate, since `rerunProducerThrough` is driven by the judge loop
  and the below-threshold companion loop too, and a per-cycle bound would hand the model a fresh
  readiness ceiling on every automatic rework round. Both logs are now capped and count what they
  drop, since they live in the run's compare-and-swapped JSON blob.
  
  Internal break: an attempt log's `attempt` is now its ordinal in that run-long log rather than a
  copy of the live cycle counter, and each row carries a `cycle`. The two ordinals are identical on
  any run that never loops back to its deployer, and only a stored step carries the fields.
  
  Additive on `/api/v1` (spec `info.version` 1.66.0): new optional and required fields on a response
  object introduced in the same release, plus a fourth `entries[].status` value, `unsettled`, for the
  frame whose recorded outcome a remediation loop cleared to re-provision it. The clients ignore
  unknown fields and tolerate unknown enum values, so a consumer built against 1.65.0 keeps parsing.

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0
  - @cat-factory/sdk@0.51.0

## 0.6.16

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0
  - @cat-factory/sdk@0.50.0

## 0.6.15

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0
  - @cat-factory/sdk@0.50.0

## 0.6.14

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0
  - @cat-factory/sdk@0.50.0

## 0.6.13

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0
  - @cat-factory/sdk@0.50.0

## 0.6.12

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0
  - @cat-factory/sdk@0.49.0

## 0.6.11

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0
  - @cat-factory/sdk@0.49.0

## 0.6.10

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0
  - @cat-factory/sdk@0.49.0

## 0.6.9

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0
  - @cat-factory/sdk@0.49.0

## 0.6.8

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0
  - @cat-factory/sdk@0.48.1

## 0.6.7

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.6.6

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
