# @cat-factory/observability-otel

## 0.23.29

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

## 0.23.28

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

## 0.23.27

### Patch Changes

- Updated dependencies [d36d0a8]
  - @cat-factory/kernel@0.335.1
  - @cat-factory/contracts@0.346.1

## 0.23.26

### Patch Changes

- Updated dependencies [0f3fb10]
  - @cat-factory/contracts@0.346.0
  - @cat-factory/kernel@0.335.0

## 0.23.25

### Patch Changes

- Updated dependencies [745eae8]
  - @cat-factory/contracts@0.345.0
  - @cat-factory/kernel@0.334.0

## 0.23.24

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/contracts@0.344.0
  - @cat-factory/kernel@0.333.0

## 0.23.23

### Patch Changes

- Updated dependencies [3b11b10]
  - @cat-factory/contracts@0.343.0
  - @cat-factory/kernel@0.332.0

## 0.23.22

### Patch Changes

- Updated dependencies [9dfd40b]
  - @cat-factory/contracts@0.342.0
  - @cat-factory/kernel@0.331.0

## 0.23.21

### Patch Changes

- Updated dependencies [1c79070]
  - @cat-factory/contracts@0.341.0
  - @cat-factory/kernel@0.330.0

## 0.23.20

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/contracts@0.340.0
  - @cat-factory/kernel@0.329.0

## 0.23.19

### Patch Changes

- Updated dependencies [ec0aba1]
  - @cat-factory/contracts@0.339.0
  - @cat-factory/kernel@0.328.0

## 0.23.18

### Patch Changes

- Updated dependencies [436f373]
  - @cat-factory/contracts@0.338.0
  - @cat-factory/kernel@0.327.0

## 0.23.17

### Patch Changes

- Updated dependencies [a745ee2]
  - @cat-factory/contracts@0.337.0
  - @cat-factory/kernel@0.326.0

## 0.23.16

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/contracts@0.336.0
  - @cat-factory/kernel@0.325.0

## 0.23.15

### Patch Changes

- Updated dependencies [dc4a5d9]
- Updated dependencies [4d999cb]
  - @cat-factory/contracts@0.335.0
  - @cat-factory/kernel@0.324.0

## 0.23.14

### Patch Changes

- Updated dependencies [0f426b3]
  - @cat-factory/kernel@0.323.2

## 0.23.13

### Patch Changes

- Updated dependencies [332ef26]
  - @cat-factory/kernel@0.323.1

## 0.23.12

### Patch Changes

- Updated dependencies [4b1c76f]
  - @cat-factory/contracts@0.334.0
  - @cat-factory/kernel@0.323.0

## 0.23.11

### Patch Changes

- Updated dependencies [6d4b02a]
  - @cat-factory/kernel@0.322.2

## 0.23.10

### Patch Changes

- Updated dependencies [be0b953]
  - @cat-factory/kernel@0.322.1

## 0.23.9

### Patch Changes

- Updated dependencies [27b22a3]
  - @cat-factory/contracts@0.333.0
  - @cat-factory/kernel@0.322.0

## 0.23.8

### Patch Changes

- Updated dependencies [e1f6325]
- Updated dependencies [90a915e]
  - @cat-factory/contracts@0.332.0
  - @cat-factory/kernel@0.321.3

## 0.23.7

### Patch Changes

- Updated dependencies [e0eed49]
  - @cat-factory/kernel@0.321.2

## 0.23.6

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/contracts@0.331.0
  - @cat-factory/kernel@0.321.1

## 0.23.5

### Patch Changes

- Updated dependencies [dc12c82]
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0

## 0.23.4

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0

## 0.23.3

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1

## 0.23.2

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0

## 0.23.1

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/kernel@0.318.1

## 0.23.0

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
- Updated dependencies [08752da]
- Updated dependencies [0cfa7a2]
- Updated dependencies [dc26bb5]
  - @cat-factory/contracts@0.327.0
  - @cat-factory/kernel@0.318.0

## 0.22.6

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/kernel@0.317.1

## 0.22.5

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0

## 0.22.4

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/kernel@0.316.0

## 0.22.3

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0

## 0.22.2

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

## 0.22.1

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0

## 0.22.0

### Minor Changes

- 5b281a3: Act on the first external-API sweep: three vendor surfaces had already moved, two more carry
  announced dates, and eight had drifted.

  **Broken.** Confluence page reads move to Cloud REST v2 (`GET /wiki/api/v2/pages/{id}`); the v1
  content endpoint they targeted was retired on 2025-04-30, and CQL search stays on v1 because v2
  publishes no search endpoint. incident.io enrichment posts to `POST /v2/actions`, an endpoint that
  exists, where `POST /v2/incident_updates` never has at any version: the investigation lands as an
  unassigned action on the live incident rather than a status-page update (which would re-alert
  customers) or a follow-up (which is post-incident work). The MCP tool-server probe is now dual-era:
  revision `2026-07-28` deleted the `initialize` handshake, `notifications/initialized` and
  protocol-level sessions, so the probe opens in the modern stateless dialect and falls back to the
  handshake on a refusal that is not one of the three MCP-reserved error codes, or on any refusal
  naming a handshake-era revision. `server/discover`'s `supportedVersions` is negotiated onto rather
  than read and discarded, and the HTTP status is read before the body, so a 401 answered in JSON
  (the ordinary shape for an OAuth-protected server) is one refusal rather than two.

  **Dated.** The Langfuse sink is now the OTLP exporter pointed at Langfuse's OpenTelemetry endpoint;
  the batch ingestion API it used to speak is deprecated, sunsets on Langfuse Cloud on 2026-11-16, and
  its three event types are already unsupported on the v4 data model.

  **Drift.** Google userinfo reads from `openidconnect.googleapis.com/v1/userinfo`, the host Google's
  own discovery document publishes. Datadog monitor reads ask for `group_states=all` and fold
  `state.groups[*].last_triggered_ts` over the groups that are STILL ALERTING, so the
  post-release-health gate can once again tell a standing alert from one this release caused; the
  field it used to read is not in Datadog's schema, so the transition time was silently always
  absent, and the per-group timestamp outlives the group recovering, so folding it over every group
  would hand a week-old standing alert to whatever release a since-cleared blip landed after. Figma OAuth refreshes at `/v1/oauth/token`, which
  superseded `/v1/oauth/refresh`. The MCP authorization-server discovery walk drops an undocumented
  location, adds the OpenID Connect path-insert one, and enforces RFC 8414's issuer-equality check
  against a DECLARED issuer: in the origin fallback there is no published identifier to compare
  against, so the equality would refuse every deployment whose authorization server identifies as a
  fronted IdP or a tenant path. Linear rate limits are read off the error `code`, because Linear
  answers an exhausted quota with HTTP 400, and a setup check reports one as the new `rate_limited`
  verdict: the key is valid and the fix is to wait, which neither `auth_failed` nor a generic error
  says. The OTLP exporter reads `partialSuccess` instead of treating any 200 as full acceptance.
  GitLab 413s carry their own remedy. The Gemini image contract narrows `thinking_level` to the two
  values that exist, states the per-model reference-image split, and declares the 401 an invalid key
  really returns. The DeepSeek base URL drops an undocumented `/v1`.

  **Additive on the wire:** a task source's setup check can answer `rate_limited`, an eighth verdict
  in `taskSourceDiagnosticStatusSchema`.

  **Breaking for an embedder:** kernel's `GateContext` and `JudgeContext` now carry a required
  `logger`. Both are built by the engine (`makeGateContext`) and by `stubGateContext` /
  `stubJudgeContext` in tests, so a registered gate or judge needs no change.

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/contracts@0.322.0
  - @cat-factory/kernel@0.313.0

## 0.21.12

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0

## 0.21.11

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0

## 0.21.10

### Patch Changes

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0

## 0.21.9

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0

## 0.21.8

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0

## 0.21.7

### Patch Changes

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0

## 0.21.6

### Patch Changes

- Updated dependencies [5333319]
  - @cat-factory/kernel@0.306.0

## 0.21.5

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0

## 0.21.4

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0

## 0.21.3

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0

## 0.21.2

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0

## 0.21.1

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0

## 0.21.0

### Minor Changes

- 0ef48d1: Stop an agent's own cleanup command from killing the harness that supervises it, and report a
  harness that WAS stopped as what it is.

  A local acceptance run failed as "the container kept vanishing, treating as deterministic" after
  two full coder passes. Nothing evicted anything. The harness ran as PID 1 with the command line
  `node dist/server.js`, which is also where the Fastify service the coder was scaffolding built to;
  the agent started that service in the background to smoke-test it over a real socket, then ran
  `pkill -f 'node dist/server.js'` to stop it again. The image ships no `pkill`, so that failed with
  `command not found` and the next turn used something that works without procps, which matched PID 1
  and shut the harness down. The container exited 0, the engine could only see a backend that had
  stopped answering, so it called it an eviction, spent its crash-recovery budget re-running the same
  agent into the same wall, and blamed infrastructure churn.

  **The harness no longer answers to a pattern kill aimed at anything else.** It runs from
  `dist/harness-server.js` and sets `process.title = 'cat-factory-harness'`, which on Linux rewrites
  both `/proc/<pid>/cmdline` and (truncated) `/proc/<pid>/comm`, so neither `pkill -f 'node dist/…'`
  nor a bare `pkill node` nor a hand-rolled `/proc` sweep can name it. It is not a security boundary
  and is not claimed as one: the agent shares the harness's uid, and separating them needs a PID 1
  running as root, which this image deliberately does not have. What it removes is the accident.

  **`procps` + `psmisc` are now in the image**, which reads backwards until you look at what the
  absence caused: `pkill`/`pgrep`/`ps` are the narrow tools an agent reaches for first, and the
  fallback it writes when they are missing is the unbounded one that took the harness down.

  **A harness that exits cleanly mid-job is no longer an eviction.** Every transport that can read an
  exit code (the local container and native-process legs, the Cloudflare per-run container, and a
  Kubernetes runner pod's `state.terminated`) now distinguishes a workload that exited 0 with a job
  still in flight from one that crashed or was reclaimed, and reports `harnessShutdown` instead of
  `evicted`. The engine fails that run immediately with a new `harness_shutdown` failure kind
  (additive to the public failure-kind vocabulary; OpenAPI surface 1.54.0) and a hint that names the
  causes worth checking, rather than spending an automatic retry that walks back into whatever
  stopped it. A backend that reports no exit code (Apple `container`, a manifest-driven runner pool
  whose scheduler exposes only status words) keeps reporting an eviction, because an absent code is
  not a zero.

  The distinction is only ever drawn where NOTHING else explains the stop. Infrastructure churn is
  named and recovers on its own budget, and it stays named even after its attribution window passes:
  a rollout drain the harness answered by exiting 0, discovered minutes later by a re-driven poll, is
  still that drain rather than a shutdown. The same rule orders the engine's own reading: a killed
  job that some branch settles WITHOUT failing the run (a parked PR review's read-only Challenge
  Investigator) keeps that settlement, since losing a human's in-flight curation is worse than the
  retry this failure kind exists to prevent. `container.harness_shutdown` counts the class, kept out
  of `container.evicted` so the eviction rate an operator sizes infrastructure by is not inflated by
  deaths no infrastructure change prevents.

  **An aborted agent run says who aborted it.** The Claude Code / Codex runner rejected with a
  hard-coded "agent run aborted by watchdog" for every abort, including the shutdown handler's, so a
  job killed by something else filed its failure against a watchdog that never fired. It now carries
  the abort reason the caller supplied, the way the Pi runner already did, and an abort that supplied
  none falls back to saying so rather than quoting the platform's own contentless "This operation was
  aborted" (a reasonless `abort()` sets an `AbortError` that IS an `Error`, so the fallback was
  unreachable).

  The image moves to `cat-factory-executor:1.121.0` across the wrangler config, the publish script and
  `RECOMMENDED_HARNESS_IMAGE`: the entrypoint rename and `procps` are only in effect once a deployment
  runs a tag that contains them.

  **The acceptance suite stops blaming the merge threshold for a failed run.** Its "the merge was
  HELD" hint fired on "there is a pull request and the status is not done", which is also true of a
  run that died three phases before any merge was considered; it is now offered only where nothing
  else explains the stop.

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0

## 0.20.4

### Patch Changes

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
  - @cat-factory/kernel@0.299.1
  - @cat-factory/contracts@0.311.0

## 0.20.3

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0

## 0.20.2

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2

## 0.20.1

### Patch Changes

- Updated dependencies [0e1e0fa]
  - @cat-factory/contracts@0.308.1
  - @cat-factory/kernel@0.298.1

## 0.20.0

### Minor Changes

- 7312e0a: Stop a refused work-branch push from failing a run whose work is already on the branch.

  The harness checkpoint-pushes the agent's commits every 60s so an evicted container's work
  survives, which makes it its own competing writer: a commit is published within a minute of being
  made, the agent cannot see that from inside the container, and amending it afterwards is ordinary
  git hygiene (the delivery contract even asks it to validate AFTER committing, which is exactly the
  sequence that produces an amend). The final push was then refused as a non-fast-forward and the
  whole run failed with a complete scaffold sitting on the branch.

  Every push after the first now carries `--force-with-lease` against the sha THIS pass published,
  which is the sha the push itself named: `pushBranch` pushes `<sha>:refs/heads/<branch>` and returns
  it, rather than reading `refs/remotes/origin/<branch>` back afterwards, which a fresh coding run's
  single-branch clone never creates. That is the whole discrimination: the run's own rewrite lands, and
  a second writer's commits (a concurrent dispatch, a person) still refuse the push as `(stale info)`,
  which is the "never clobber another run's work" property the resume design leans on.

  The lease is withheld entirely unless the branch still contains the tip this pass started from
  (`workBranchLease`), because the lease alone does not bound the force to this pass's own commits: a
  resumed run that had already landed one checkpoint would otherwise force over the commits it
  resumed from and take an earlier run's work with them.

  A refused push is no longer a generic `git` fault. It reports the new `branch-contended` failure
  cause, and the engine recovers by re-dispatching the step once (`MAX_BRANCH_CONTENTION_RECOVERIES`,
  recorded on `PipelineStep.branchContentionRecoveries` and projected by the debug API): the fresh
  dispatch resumes the branch as it now stands, so the agent continues on top of whatever is on it.
  Past the budget the run fails with a remedy naming which of the two causes it was, rather than git's
  own "use `git pull`" hint, which is advice for a person at a terminal. Each refusal also increments
  the new `container.branch_contended` operational counter, since a re-dispatch that a run reports as
  a clean success is invisible per run and costs a whole agent run twice.

  The checkpoint also stops re-pushing an unchanged branch. Its gate was "the branch advanced past the
  pre-run tip", which stays true forever once it has, so every tick issued a push: an hour-long run
  that commits eight times spent ~60 authenticated round trips, ~52 of them answering "Everything
  up-to-date" and each counting against the host's push rate limits. It now pushes only an
  UNPUBLISHED tip, which makes the interval a loss window rather than a rate (one push per commit the
  agent makes, whatever the model or the run's length) and leaves the durability guarantee unchanged.

  The `build` prompt bumps to v6 with the matching half of the rule stated to the agent: add commits,
  never rewrite them.

  `/api/v1/debug/runs/:runId` gains `branchContentionRecoveries` per step (OpenAPI 1.52.0, additive):
  a run that recovered reports as an ordinary success, so nothing else tells a post-mortem that one
  agent pass was paid for twice.

  Also fixes a git failure printing its stderr twice (`execFile` already folds it into the rejection
  message), which made one refused push read as two attempts.

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0

## 0.19.10

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0

## 0.19.9

### Patch Changes

- Updated dependencies [792ecde]
  - @cat-factory/kernel@0.296.1

## 0.19.8

### Patch Changes

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0

## 0.19.7

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0

## 0.19.6

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/kernel@0.294.1

## 0.19.5

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0

## 0.19.4

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0

## 0.19.3

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2

## 0.19.2

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/kernel@0.292.1

## 0.19.1

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0

## 0.19.0

### Minor Changes

- ee733ee: A run whose stored row cannot be decoded is now closed instead of re-driven forever, and one
  unrecoverable run no longer ends the stale-run sweep.

  The two are the same incident. A `kind='execution'` row with no `block_id` fails `rowToExecution`,
  and every path that could settle such a run begins by READING it: the re-drive throws on the load,
  and so does the hard-stall backstop whose entire job is to settle a run recovery cannot resume. The
  row therefore stayed `running` forever, was re-listed by every sweep (`listStale` is ordered oldest
  first, so it sorted to the front of each one), and past the hard-stall deadline its throw escaped
  the per-run body and ended the whole pass: no other stale run recovered, no spend-paused run
  resumed, no batch enqueue happened, tick after tick, while the sweeper reported itself as running.

  - **Disposal.** `RunStateMachine.loadOrDispose` recognises a `DataIntegrityError` by TYPE (a
    transient database failure still propagates and leaves the run alone) and settles the run through
    `markFailed`, the one write that decodes nothing. Both the driver entry point
    (`ExecutionService.advanceInstance`) and the settle path (`failRun`) read through it, so such a
    row is closed on its first re-drive rather than an hour later.
  - **The owning block goes with it.** A settled run row with the card still `in_progress` leaves the
    human half of the incident unresolved forever, because the run is dropped from the board snapshot
    and there is no failure card and no Retry. The run names no block, but the block names the run:
    the new `BlockRepository.getByExecution` reads that reverse link, and the card drops to `blocked`
    with a pushed board event and no fabricated progress.
  - **Only a MALFORMED row is disposed of.** A stored value this build does not RECOGNISE is a fact
    about the reader, not the row: during a rolling deploy an unknown `ExecutionStatus` member is a
    healthy run the newer replica wrote, and disposal is irreversible while a re-drive costs a tick.
    `DataIntegrityError` now carries a `DataIntegrityFault`, and the reversible half is the fallback
    wherever the fault is unknown or absent.
  - **Isolation.** Both facades' sweeps recover one run at a time inside a per-run boundary, log the
    run they skipped, and count it as `sweep.run_recovery_failed`. A pass that took runs on and
    recovered NONE of them reports itself as a FAILED pass, since such a pass now completes and a
    recorded success would reset `sweep_degraded` on precisely the wedged sweeper it watches for. A
    run whose probe threw keeps its per-process orphan clock, so the hard-stall backstop can still
    reach it.
  - **A new failure kind, `state_unreadable`** (surface version 1.48.0, additive), so these runs are
    distinguishable in the operator's failure-kind breakdown rather than filed under `stalled`, whose
    advice is "retry" and whose retry would re-read the same row.
  - **A write-side guard.** Composing the stored `detail` for a run that `rowToExecution` would refuse
    now throws, for both invariants it checks (no `blockId`, a cursor outside its step list), so the
    writer that produces one reports the fault instead of a sweeper hours later. Both facades'
    `upsert`/`insertLive`/`compareAndSwap` compose through that one function.

  `DataIntegrityError` moved to `@cat-factory/kernel` (re-exported from `@cat-factory/server`, so no
  import breaks) because the engine has to be able to recognise it. It also survives the mothership
  persistence RPC as its own error code rather than an opaque 500, without which the disposal would be
  a no-op on mothership deployments.

  Documented on the website in kibertoad/cat-factory-website#53.

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0

## 0.18.42

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/kernel@0.290.1

## 0.18.41

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0

## 0.18.40

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/kernel@0.289.1

## 0.18.39

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0

## 0.18.38

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0

## 0.18.37

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/kernel@0.287.0

## 0.18.36

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/kernel@0.286.3

## 0.18.35

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/kernel@0.286.2

## 0.18.34

### Patch Changes

- b889842: Report the actual cause of a failure everywhere, not just on a "Test connection" button.

  The previous slice taught the connection PROBES to read the cause chain, because on Node a transport
  failure is `TypeError: fetch failed` and what happened hangs off `.cause`. It turned out the repo had
  three describers of a thrown value and the other two stopped at `error.message`: `getErrorMessage`
  (the string a human is shown, and what a persisted failure reason or a PR comment records) and
  `describeError` (every log line). So a probe could name `connect ECONNREFUSED 127.0.0.1:6443` while
  the log line and the toast for the same failure still said `fetch failed`, which is what made a
  Kubernetes connect failure unexplainable even with the probe fixed.

  All three now flatten through one kernel core (`shared/error-chain.logic.ts`): `.cause` plus each
  `AggregateError` branch (so a dual-stack `localhost` reports what happened on each address), scrubbed
  through `redactSecrets`, capped with a marker saying what it dropped, and bounded by link identity so
  a cause cycle terminates. Roughly 90 hand-rolled `e instanceof Error ? e.message : String(e)` copies
  across the backend now call `getErrorMessage`, and five local `errMessage`/`messageOf` wrappers are
  deleted.

  Who may read a chain is part of the rule. An AUTHENTICATED reader gets it, because the inner link is
  usually the only thing saying whether the fix is theirs or the deployment's; where a deployment's
  model endpoints are platform-internal, their host and port do reach a workspace member through an
  ordinary 4xx. An UNAUTHENTICATED surface does not: `/ready` on BOTH facades answers with kernel's
  `publicDiagnostic` (the outermost link, scrubbed) rather than publishing the deployment's database
  address, sharing one helper so the two runtimes cannot drift to different depths.

  A VERDICT does not read the rendered string either. `errorChainMatches` tests each link uncapped, so
  a sentinel phrase pushed past the display budget by a long wrapper cannot silently turn a recognised
  rollout stop into a crash. Relatedly, log fields get their own, much wider cap than the 400 characters
  a human-facing message is held to, and an error with nothing to say answers with the empty string
  rather than the bare constructor name, so a call site's `getErrorMessage(e) || '<what to do>'` guard
  still fires.

  `redactSecrets` now spares a single-case word and an env-var-shaped identifier where a field-name rule
  matched: it scrubs the message a person reads, and `Missing required key: OPENAI_API_KEY` must not
  lose the name they have to go and set. Every credential shape the rules exist for still matches.

  An error message may therefore now carry appended causes where it did not before. The opening phrase
  is unchanged, which is what the downstream `/dispatch failed/i` and eviction-sentinel checks match on.

  On the SPA, every failure toast goes through the one funnel that already existed for pipeline errors,
  instead of 29 per-component copies of the same `notifyError(title, e)` and ~83 direct `toast.add`
  calls rendering the raw message. Beyond the translated copy that funnel already resolved, a failure
  toast now stays until dismissed instead of vanishing after about five seconds, its text is
  selectable, and one click copies the whole report: the action that failed, the class of failure, the
  backend's own account, and the `requestId` that is the only join between what the user saw and the
  server log line explaining it. Conflict (409) toasts get the same treatment, which matters most on
  the unknown-reason path, since that is where a reason an older SPA build has never heard of lands.

  `@cat-factory/cli` carries its own copy of the describer rather than importing kernel. That package is
  published and deliberately runtime-dependency-free, so a `workspace:*` import from its `bin` resolves
  through pnpm's link locally and is simply absent off the registry; a conformity test pins the copy to
  kernel's output byte for byte.

- Updated dependencies [b889842]
  - @cat-factory/kernel@0.286.1

## 0.18.33

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/kernel@0.286.0

## 0.18.32

### Patch Changes

- Updated dependencies [7119ca7]
  - @cat-factory/contracts@0.292.2
  - @cat-factory/kernel@0.285.3

## 0.18.31

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2

## 0.18.30

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/kernel@0.285.1

## 0.18.29

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/contracts@0.291.0

## 0.18.28

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0

## 0.18.27

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0

## 0.18.26

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1

## 0.18.25

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0

## 0.18.24

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/kernel@0.281.3

## 0.18.23

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2

## 0.18.22

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/kernel@0.281.1

## 0.18.21

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0

## 0.18.20

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0

## 0.18.19

### Patch Changes

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/kernel@0.279.3

## 0.18.18

### Patch Changes

- Updated dependencies [3036af7]
  - @cat-factory/kernel@0.279.2

## 0.18.17

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/kernel@0.279.1

## 0.18.16

### Patch Changes

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0

## 0.18.15

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0

## 0.18.14

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/kernel@0.277.0

## 0.18.13

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0

## 0.18.12

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/kernel@0.275.4

## 0.18.11

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/kernel@0.275.3

## 0.18.10

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/kernel@0.275.2

## 0.18.9

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/kernel@0.275.1

## 0.18.8

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/kernel@0.275.0

## 0.18.7

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0

## 0.18.6

### Patch Changes

- Updated dependencies [a62bcf8]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0

## 0.18.5

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/contracts@0.274.0

## 0.18.4

### Patch Changes

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0

## 0.18.3

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0

## 0.18.2

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0

## 0.18.1

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0

## 0.18.0

### Minor Changes

- 01bb6d2: Keep the cause of a failed dispatch and a dead durable driver, instead of discarding it at the
  moment it becomes the only thing anyone wants.

  Three sites had the same shape: the record of a failure was written by the thing that only exists
  once the failure did not happen.

  A run's `diagnostics.lastDispatch` was stamped from the job HANDLE, which `startJob` returns only
  after a container has accepted the job. So the two failure classes the block exists to explain, a
  container that never started and a preflight rejection like "GitHub not connected", were exactly
  the ones that recorded nothing. The block is now opened before the dispatch from what is already
  known and refined afterwards by what only the accepted dispatch resolved, and it carries the
  dispatch's own failure verdict, which the step also holds but loses to the next retry. Inline
  steps stamp one too, naming their backend `inline`: dispatching nowhere is why they stamped
  nothing, and the result was a mixed pipeline reporting whatever container step ran last as where
  the run was when it died.

  The Cloudflare stale-run sweeper answered "the instance was lost, re-create it" for both of its
  swallowed error paths, so a Workflows API outage read as every stale run losing its instance at
  once and re-drove the fleet with no log line to say why. The lookup now returns a probe over four
  states, and the fourth is the point: an instance it could not classify produces no action at all.
  Every action the sweep has is destructive against a run that is actually fine, so one unclassified
  tick costs a run some recovery latency where a guess costs it its container. Two states were also
  reaching the finalize branch by fall-through, Workflows' own `unknown` status and an instance
  finishing its work before pausing, and a terminal instance's own error, destructured by nobody,
  now reaches the stop reason that until now said only that some driver ended without finalizing
  something. An unconfigured workflow binding says so once per isolate rather than reporting the
  kind as healthy forever.

  The local pooled container poll now passes `postMortem`, the same argument the per-run poll always
  did, so a pool member that dies mid-run leaves its exit state and log tail behind rather than the
  bare eviction sentinel.

  Additive on the public API (`info.version` 1.29.0): `diagnostics.lastDispatch` grows an optional
  `failure` object and `executionBackend` one further value. What does change for a consumer is the
  population, since a pure-inline run used to answer no diagnostics at all and now answers a block.
  A new `sweep.run_state_unknown` operational counter reports what the sweeper could not classify,
  which is the one signal that separates a blind sweeper from a healthy one.

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0

## 0.17.7

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0

## 0.17.6

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0

## 0.17.5

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0

## 0.17.4

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0

## 0.17.3

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/kernel@0.262.2

## 0.17.2

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/kernel@0.262.1

## 0.17.1

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0

## 0.17.0

### Minor Changes

- aabfb4d: Worker cache-coherency pilot on layered-loader 16.1: caches of our own mutable state can
  now hold a real TTL on Cloudflare, with cross-isolate staleness bounded by a pull
  generation probe instead of being indefinite.

  - `@cat-factory/caching`: new `CacheGenerationStore` seam + `coherencyWindowMsecs` profile
    field (a probe of a shared per-(cache, group) generation directory before serving, with
    layered-loader 16.1's fencing `applyRemoteInvalidation*` applied on a moved counter, and
    a bump after every local invalidation; reads fail closed to pass-through, bumps fail
    open onto the TTL backstop). New `ISOLATE_COHERENT_APP_CACHES_PROFILE` flips
    `workspaceSettings` as the pilot. `scheduleBackgroundWork` is threaded to every loader.
    layered-loader bumped to ^16.1.0 (ESM package; also bumped in the Node facade).
  - `@cat-factory/caching`: a coherent cache declares `cacheWideInvalidation` when its
    service calls `invalidateAll`; only those probe the reserved `'*'` epoch shard (one
    globally placed Durable Object), and an undeclared `invalidateAll` on a coherent cache
    throws rather than dropping entries locally while peers serve them to the TTL.
  - `@cat-factory/caching`: new `currentInvocation` option for ISOLATE runtimes. Where it is
    supplied, a cache MISS (and a coherency probe) never joins an in-flight promise created
    by a different invocation, because Cloudflare destroys the joining invocation with an
    uncatchable "Cannot perform I/O on behalf of a different request"; coalescing within one
    invocation is unchanged, as is Node, which supplies nothing.
  - `@cat-factory/worker`: new `CacheGenerationDirectory` sqlite Durable Object (migration
    tag v5) behind the OPTIONAL `CACHE_GENERATIONS` binding; the app-cache bag is now one
    per isolate (module scope) instead of one per invocation, with loader background work
    adopted onto the current invocation's `ctx.waitUntil` and per-invocation load scoping
    (above) via an ambient ExecutionContext.
    Deployers: add the binding + v5 migration (see `deploy/backend/wrangler.toml`) to turn
    the coherent profile on; without the wrangler edit the Worker keeps the previous
    pass-through behaviour.
  - `@cat-factory/kernel` + `@cat-factory/observability-otel`: four new operational
    counters (`cache.coherency_probe`, `cache.coherency_invalidation`,
    `cache.coherency_probe_failure`, `cache.coherency_bump_failure`) with their OTel names
    and units.

  Behaviour changes worth calling out beyond the Worker:

  - `WorkspaceSettingsService.update` now reads its merge base from the repository instead of
    through the cache. It is a read-modify-write of the whole settings row, so a base stale by
    even one bounded-staleness window silently reverted a field a peer had committed inside it.
  - On the ISOLATE profiles, `repoFiles` and `fragmentDocumentBody` widen their preemptive
    refresh window to cover the whole TTL. Their entries now live that full TTL across requests
    (the bag used to be rebuilt per invocation), and the claim that keeps them enabled on the
    Worker at all is that their probe bounds staleness, so the window has to be the lifetime.
  - The coherent `workspaceSettings` entry carries a 60s TTL rather than the Node profile's five
    minutes: with bumps failing open, the TTL is the real bound when a bump fails, and that row
    carries `allowInitiatorPat`, `storeAgentContext` and the spend caps.

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/contracts@0.261.1
  - @cat-factory/kernel@0.261.0

## 0.16.8

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0

## 0.16.7

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/kernel@0.259.0

## 0.16.6

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/kernel@0.258.0

## 0.16.5

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0

## 0.16.4

### Patch Changes

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/kernel@0.256.0
  - @cat-factory/contracts@0.258.0

## 0.16.3

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/kernel@0.255.1

## 0.16.2

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0

## 0.16.1

### Patch Changes

- Updated dependencies [ee6ce7c]
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0

## 0.16.0

### Minor Changes

- 16576d6: Close the deployment extension-seam gaps a consumer build hit: every app-owned registry is now
  reachable from the documented boot entry point, and the prompt-fragment pool is injected rather than
  a module global.

  An org package outside this repo built a proprietary reusable operation against the PUBLISHED
  `@cat-factory/*` packages and reported nine gaps. Each seam it hit typechecks, boots, passes CI, and
  is either unreachable from the supported entry point or silently inert once reached. None showed up
  in our own tests because the worked example lives INSIDE this repo, where the composition root calls
  `buildNodeContainer` directly and every package resolves to one copy on disk.

  **Breaking, `@cat-factory/prompt-fragments`.** `registerPromptFragment(s)`,
  `clearRegisteredPromptFragments`, `universalFragments`, `registerTaskTypeDefaultFragments`,
  `clearRegisteredTaskTypeDefaultFragments` and `defaultFragmentIdsForTaskType` are REMOVED. They were
  two module globals, correct only while every reader resolved the same physical copy of the package;
  a `workspace:*` dependency publishes as an EXACT version, so a consumer floating the range onto a
  newer patch got two copies, the registration landed in one, the server read the other, and every
  task of the operation was seeded with fragment ids that folded nothing. Replaced by the app-owned
  `PromptFragmentRegistry` (kernel), injected by reference:
  `promptFragmentRegistryWithBuiltins()` news one carrying the shipped catalog, and it is an option on
  `start()` / `startLocal()` / the Worker overrides. `getFragment` remains, narrowed to the shipped
  catalog. One behaviour change rides along: `registerTaskTypeDefaults` REPLACES a built-in per-type
  set instead of silently unioning with it, so a deployment can now remove a shipped default; spread
  `DEFAULT_DOCUMENT_STYLE_FRAGMENT_IDS` to keep both.

  **Also breaking (internal surfaces, pre-1.0, no shims).** `validateRegistrations` /
  `collectRegistrationProblems` take their registries as ONE `registries` object (a facade passes its
  container) instead of seven hand-listed optional fields; that hand-list is why the local mothership
  boot validated five registries while its own comment claimed parity with `start()`, so a custom task
  type naming an unregistered pipeline booted clean on a laptop and failed on the Postgres path.
  `FragmentLibraryService` takes a `promptFragmentSource` and no longer falls back to the module pool.
  `TaskTypeCreationDefaults.fragmentIdsFor` is async. `PromptFragmentSource` gains a required
  `inProcess` flag, read by boot validation to tell "this deployment registered nothing" from "the
  pool lives on the mothership", which are the same empty list and opposite facts.

  **What is new rather than moved.** `start()` and `startLocal()` gain `pipelineRegistry`,
  `gateRegistry`, `judgeRegistry`, `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry`;
  the seam drift guard now asserts against those ENTRY POINTS rather than only the container builder
  behind them, which is how `pipelineRegistry` sat on `NodeContainerOptions` (documented, guarded,
  green) while no boot path forwarded it and local deployments had no escape hatch at all. A registered
  task type may declare `conditionalFragmentIds`, standing context selected by a `showWhen` condition
  over the answers a case supplied, evaluated once at creation by the same evaluator the form's own
  field visibility uses. A code-registered fragment carrying a `documentRef` now FAILS boot rather than
  being carried through the catalog, rendered as a live source in the library UI, and ignored at run
  time. An unresolvable standing-context id is reported on the run that dropped it instead of only as
  one boot warning that cannot be told apart from a typo, and is COUNTED on the new
  `fragments.dropped_from_run` operational counter, because a run going without its standards still
  succeeds and only a rate says a deployment is doing it every time. And a mothership-mode node reads
  the pool from the mothership over `GET /internal/prompt-fragments`, throwing rather than answering
  with an empty pool.

### Patch Changes

- Updated dependencies [16576d6]
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0

## 0.15.0

### Minor Changes

- 5202fb9: An agent now builds against the current design, and is told how to read it

  A linked document was frozen at import time. `probeVersion` existed on every provider and had exactly
  one caller (the fragment-library body cache); nothing on the run path ever looked at the source again.
  So a Figma frame edited after import fed every later run the old markdown, with the run reading as
  perfectly healthy. For a requirements page that is an annoyance; for a design under active iteration
  it means the agent routinely builds the previous revision.

  The linked-context resolution path now re-confirms each document at dispatch, through the kernel
  `LinkedDocumentRefresher` port. The cost model is the design, because that path runs per STEP: probe
  the source's version, compare it against the token the stored body came from, and re-import only what
  actually moved. That comparison needed something to compare to, which the row did not have, so
  `documents.source_version` is new. It is part of the idempotent-reimport comparison even though no
  agent reads it: a Figma file version bumps on any edit anywhere in the file, so leaving a stale token
  on an unchanged body would re-download the whole design on every dispatch, forever. NULL covers three
  cases that all mean "cannot be proven current" and all self-heal on one re-import: an upload, a
  source exposing no version, a row predating the column.

  Three things bound the cost, each a different half of it. The new short-TTL `linkedDocumentVersion`
  cache holds the OUTCOME of the whole ladder rather than the body or just the probe, so a burst of step
  dispatches costs one round trip per document, concurrent dispatches of one document dedupe onto a
  single download, and a source that is DOWN is remembered as down instead of being re-asked by every
  dispatch for as long as the outage lasts (a cache loader that throws caches nothing, which is why the
  failure is a value). It has no refresh window, since the load already is the check. The workspace's
  connection is resolved ONCE per pass for the whole corpus through a new batched
  `resolveConnections`, not per document and again inside each probe. And the per-document fan-out is
  bounded, because a task can attach a corpus budget's worth of Figma frames and each miss expands into
  chunked per-frame node reads. Coherence is invalidation plus the TTL: connect/disconnect drops the
  workspace group, a manual import drops that document's entry. The entry stays enabled on the Worker's
  isolate-safe profile, since an external version token is neither our own mutable state nor in need of
  a bus to heal.

  The ladder also has to CONVERGE, which took one non-obvious hop: `reimport` records the caller's
  probed token when the source's own fetch exposes none. A provider may resolve its version best-effort
  inside `fetchDocument` (GitHub docs' commit sha degrades to null on a rate-limited request) while its
  cheap probe still answers, so the row was left holding null, mismatched the probe on every future
  dispatch, and re-downloaded the whole document forever while reporting "this source has no revision"
  about a source that plainly has one.

  Freshness reaches the agent as a header line, and it is a three-way verdict rather than a boolean.
  `confirmed` contributes `Revision: <token>`, so "which revision did this run build against" is
  answerable from the checkout afterwards. `not-applicable` renders nothing: an upload has no source to
  trail, so a staleness warning there would invent a problem. `unconfirmed` warns and names which of
  four gaps applies, because "reconnect the source", "wait out the outage", "this source has no revision
  to compare" and "this deployment cannot read the credential" are four different fixes and one merged
  "unknown" sends the reader at the wrong one. The last of those is mothership mode, not a defensive
  branch: a node with no main database cannot read a connection sealed with the mothership's key, so the
  read fails permanently and by design, and calling that an outage would send an operator hunting a
  Figma incident that does not exist. One renderer serves both surfaces a document reaches (the
  materialised `.cat-context/` file and the in-prompt injection an INLINE kind gets instead of a
  checkout), because a judge or reviewer scoring against a stale design is the same failure as a
  container agent building from one, and an omitted note reads exactly like a copy that was checked.
  Every gap also increments the new `document.freshness_gap` counter, dimensioned by reason and source:
  each of these conditions repeats per dispatch while it lasts, so the log line answers "what happened
  to this run" and only a rate answers "is this spreading". The refresh still never throws, so a source
  outage costs the run a stale body and a stated warning rather than the run, and the readability
  refusal now runs on the refreshed records, since a page emptied since import is the case most worth
  refusing. That
  includes the REQUIREMENTS REVIEW, the first step of the default pipelines and the one a human signs
  off on, which resolves its attachments through the same refresher rather than reviewing the
  import-time copy while the coder two steps later builds from the current one. A deployment with no
  refresher wired gets no verdict at all rather than a synthesised one: it did not conclude these bodies
  are unverifiable, it never asked.

  Separately, the one fragment that tells an agent how to consume design context was selected by nothing.
  Its `appliesTo` selector is a management-surface hint the run path never drove, it is in no seed pin
  set, and basic mode hides the per-task fragment picker — so the standard case, a designer links a frame
  and starts a run, executed with a design context file on disk and no instruction anywhere to honour it.
  The engine now folds it whenever the run's resolved context carries a design-origin document. The
  trigger is the document rather than the block type, which the retired selector got wrong in both
  directions (it missed a design linked to an unlabelled task and fired on a frontend task with no
  design), and that selector is DELETED rather than left beside the new rule: the deterministic
  selector and the management surface still read it, so leaving it would keep labelling the fragment
  frontend-only while the engine folded it for anything carrying a design. It rides the normal fold, so
  a workspace override still wins and the two-tier brief/full verbosity still applies. The flag settles
  off the corpus read rather than off the finished linked context, so the fragment fold (an LLM call,
  when a standard needs condensing) is not serialised behind a live source probe on every dispatch.

  Two hygiene fixes ride along, both about a claim over a pasted URL. `makeDocumentUrlResolver` now
  consults host-pinned parsers before host-blind ones instead of in registration order: Notion's
  `parseRef` claims any UUID-shaped run anywhere, so registered first it stole a Figma URL whose file key
  carried one, and the point lookup then searched the wrong key space and found nothing — a linked design
  reaching the agent as no context at all. And the two source traits that decide these things
  (`isDesignSource`, `isHostPinnedSource`) live in contracts off one exhaustive `Record`, because the SPA
  has to label a design source too and the run path reads them where no provider is reachable.

  Reviewing: the refresh sits on the hot path of every dispatch, so the thing to check is the ladder's
  short-circuits (an unchanged design must cost one cached round trip and no download, a failed one must
  not be retried per dispatch, and the second dispatch after a re-import must do nothing at all) rather
  than the verdicts. The re-import running INSIDE the cache loader is the deliberate part: it is what
  lets one entry bound the expensive half and dedupe concurrent dispatches, and its consequence is that
  a caller which deduped onto someone else's outcome re-reads the row rather than labelling the body it
  already holds with a revision it does not carry. The `sourceVersion` column is nullable on purpose and
  a backfill would be wrong: an empty string cannot be told apart from a source that genuinely has no
  version, and the two get different treatment.

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0

## 0.14.2

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0

## 0.14.1

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0

## 0.14.0

### Minor Changes

- c9adc67: Refuse a blind run: the harness now tells the backend which job-body capabilities it parses

  An image older than a body capability does not reject the field, it ignores it. For most of the
  job body that degrades honestly, but a CAPABILITY is different: the backend composes the PROMPT,
  so a dropped `mcpServers` leaves the agent reading "you have these tools, prefer them over
  guessing" with no client wired, and a dropped `skills` leaves a claude-code run told a playbook
  "is installed for this step" that was never written. The harness CHANGELOG has documented this
  twice as an operator hazard, both times ending at the same wall: the backend has no way to know
  what image a self-hosted runner pool pins, so it could not be gated server-side. A blind run
  rather than a failed one, and the run that most needs a signal produced none.

  The handshake is a list of body field names the image reports on `/health` and on its job
  ACCEPTANCE. The acceptance is where it matters: the dispatch site is the only place the body it
  just sent is still in scope, and the last moment before the agent starts working from a prompt the
  body cannot back up. `RunnerTransport.dispatch` therefore returns an optional ack, forwarded by
  every transport that can see the harness's own response.

  The answer is deliberately THREE-STATE, and the middle state is the whole design. An image that
  reported nothing is not an image that reported "not this": every image between the capability
  landing and the handshake landing serves it perfectly and reports no list, so folding the two
  would refuse those runs on no evidence. So `unsupported` (the image said it cannot) refuses the
  dispatch and stops the job the harness already started, as an `UnavailableError` whose
  `runner_image_capability` reason makes the step a `preflight` fault rather than a container that
  died; `unknown` proceeds and is REPORTED as the deployment's own blind spot, on a warn line and a
  `container.capability_unknown` counter that should decay to zero as pools update. A body carrying
  no capability says nothing at all, which is most dispatches.

  Refusing the step is only half of it: the harness begins work on acceptance, so a refusal that
  merely throws leaves a full agent pass running against the repository, free to push a branch and
  open a pull request for a step the engine already failed. The refusal therefore STOPS the job,
  through a new `RunnerTransport.stopJob` and a new harness `DELETE /jobs/{id}` that aborts one job
  and waits for it to settle before answering. Never through `release`, which is a reclaim and means
  something different on every backend: on a per-run container it happens to kill the job, on a warm
  pool member it hands the container BACK with the agent still working in it, and on a self-hosted
  pool with no `release` template it does nothing at all.

  Not every backend can PROVE the job died, so the outcome is reported rather than assumed and the
  failure message says which of four it was: `stopped` (nothing is still running), `requested` (a
  pool cancel was accepted but cannot be verified), `unsupported` (no cancel path exists), `failed`.
  The last three also increment `container.blind_job_not_stopped`, dimensioned by the outcome,
  because each is a different operator fix. A backend that owns the container always reaches
  `stopped`, since a graceful abort that fails escalates to destroying it; on the local warm pool
  that escalation is also what keeps a member whose job could not be aborted off the idle list, where
  it still answers `/health` and the next run would lease a container with a live agent and a live
  checkout in it.

  A runner pool gets the handshake only when its manifest MAPS it: `response.dispatchCapabilitiesPath`,
  one line for a pool that proxies `POST /jobs` verbatim. Deliberately not read by name, because
  `capabilities` is an ordinary word for a scheduler to use about its own runners (`["gpu","docker"]`)
  and reading one of those as the harness's answer would narrow to an empty list and hard-refuse every
  capability dispatch against a perfectly current image. Unmapped lands in `unknown`, which is honest
  about a control plane this backend knows nothing about.

  OPERATORS: this bumps the runner image to `1.93.0`. A pool on an older image keeps working exactly
  as before; it simply reports no handshake, so tool-server and skill dispatches there are counted as
  unverifiable instead of confirmed. To get the check on a self-hosted pool, map
  `response.dispatchCapabilitiesPath` to `capabilities` and declare a `release` template so a refused
  run can actually be cancelled.

### Patch Changes

- Updated dependencies [3fbc87e]
- Updated dependencies [c9adc67]
  - @cat-factory/contracts@0.251.0
  - @cat-factory/kernel@0.249.0

## 0.13.7

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0

## 0.13.6

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0

## 0.13.5

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/contracts@0.248.0

## 0.13.4

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0

## 0.13.3

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0

## 0.13.2

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/kernel@0.243.1

## 0.13.1

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0

## 0.13.0

### Minor Changes

- f775c1d: Job tokens are scoped to the repos a run resolved, not the whole installation

  A container dispatch's clone/push credential was a GitHub App token minted with no
  `repository_ids`, so it reached every repository the workspace's installation covered. That made
  the installation the blast radius of a fully compromised run, and the mitigation was advice
  (scope the installation narrowly) rather than a mechanism. The narrowing mechanism already
  existed and was proven on the mothership delegation path; this brings it to every dispatch.

  `jobTokenRepoIds` collects the repos ONE job body names (the primary checkout plus fan-out
  peers, the conflict-resolver's targeted peer, the merger's combined-diff siblings, and read-only
  reference repos) and `buildDispatchTokenMint` turns them into `repository_ids`. That builder is
  shared by both facades, which previously carried byte-identical copies of the "initiator PAT
  first, else the deployment credential" decision: whose token and how wide are one question, so
  they now have one implementation and cannot drift.

  **Every path that hands a container a GitHub credential goes through it**, not just the step
  executor: the repo bootstrapper, the env-config repairer, the frontend preview job and the
  deploy clone target each name the one repo they touch. That totality is held by the TYPE, not by
  review. Supplying the run context is what makes a mint a dispatch mint, and a context must carry
  `repoIds`, so a new dispatcher cannot ship without deciding its scope. Engine calls (`RepoFiles`
  reads, the gate and merge clients) pass no context and stay installation-wide by design: they act
  as the deployment, and nothing they do reaches a container.

  Three dispositions are deliberate. A leg on a DIFFERENT installation is dropped rather than
  requested: one job carries one token, so such a repo is unreachable either way, and naming it
  would only make GitHub reject the mint. A scope that cannot be expressed as repo ids widens to
  installation-wide rather than dropping a leg the harness is about to clone, since minting for the
  parseable remainder would trade a data problem for a run that fails deep in a `git clone`. And a
  dispatcher whose own lookup came back empty passes an EMPTY scope rather than none, because
  "could not resolve my repos" and "I am not a dispatch" are opposite facts that an absent field
  renders identically. Neither widening is silent: a `warn` naming the run plus the new
  `dispatch.token_scope_widened` counter, because a security property degrading quietly reads
  exactly like one holding.

  What this does NOT narrow, both by construction: the token still carries `Contents: write` for
  the repos it covers (App tokens cannot be branch-scoped), and an initiator's personal PAT is
  unaffected, since `repository_ids` is an App-token mechanism with no PAT equivalent.
  `allowInitiatorPat` remains what bounds that.

  The mothership delegation endpoint takes the same scope. A node may now name `repositoryIds`,
  which is INTERSECTED with the installation's App-linked projection server-side: asking narrows
  and can never widen, nothing left in scope is the existing uniform 404, and a malformed ask falls
  back to the full linked set rather than a partial one.

  Worth reviewing: what a scoped mint changed about CACHING. `GitHubAppAuth` keyed its in-memory
  token cache by installation id alone, which made a scoped entry unsafe to store (it would
  over-grant a later engine call, and be under-granted by one), so scoped mints bypassed the cache
  entirely. On the delegation path that was already true and cheap; on the standard dispatch path
  it would have put an RSA signature plus a GitHub round trip on every step and every re-dispatch
  epoch, where a warm process previously paid one mint per installation per hour. Both sides now
  key by installation + sorted scope through one `InstallationTokenCache`, so a narrowed token
  caches beside the unscoped one and neither can serve or poison the other. That cache also evicts
  lapsed entries, which keying by scope made necessary: a map bounded by the installation count
  became one bounded by the number of distinct repo SETS a long-running node dispatches over.

  The dispatch also reorders: the auxiliary-checkout resolution moved INTO the parallel I/O wave
  and the token mint moved out behind it, because the mint's scope is what that resolution
  produces. One round trip left the wave as another entered it, and the ordering is pinned by a
  test, so a later latency pass cannot re-parallelise the mint back to installation-wide.
  `backend/docs/security-model.md` Layer 3 is updated, and the "job tokens are installation-wide"
  known gap is closed.

### Patch Changes

- Updated dependencies [f775c1d]
- Updated dependencies [bac6776]
- Updated dependencies [3857ea4]
  - @cat-factory/kernel@0.242.0
  - @cat-factory/contracts@0.243.0

## 0.12.3

### Patch Changes

- Updated dependencies [7cf3e70]
  - @cat-factory/kernel@0.241.1

## 0.12.2

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0

## 0.12.1

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0

## 0.12.0

### Minor Changes

- dd90c1e: Join the platform's telemetry to a caller's own distributed trace.

  `mountRequestLogging` now adopts an inbound W3C `traceparent`, binding `traceId`/`spanId` onto
  the request-scoped logger so an SDK client or gateway already collecting a trace sees this
  deployment's log lines inside it rather than beside it. A line naming a RUN still takes that
  run's derived trace id: that derivation is the only thing joining a run's logs to its spans, and
  nothing else asserts it, so the caller's context fills in everywhere else (which is most of what
  an API request emits). The header is untrusted, so the parse admits only the exact fixed-width
  hex grammar and refuses the spec's all-zero sentinels; malformed means ignored, never a refused
  request.

  Not shipped, deliberately, after weighing it: exporting COST over OTLP. It is derived data
  (`tokens x rates`) in a store that cannot reprice it, so a corrected rate table would leave
  history permanently wrong with nothing marking it, and it would sit beside `SpendService` as a
  second answer for money, at a grain that drops `workspace_id` and therefore can never be
  reconciled against what anyone is billed. The exporter carries the observed facts a downstream
  consumer prices FROM instead: the model, the three input token classes kept apart, and the
  output count. The reasoning is recorded in the README's not-emitted list so it is not
  re-proposed.

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/kernel@0.239.0

## 0.11.0

### Minor Changes

- 4e5640d: Adopt a catalog pipeline into the workspace on first run, so no board is stuck behind an advisory.

  Built-in pipelines are copied into each workspace at creation, so a board seeded before a pipeline
  shipped holds no row for it, and the catalog's own copy is invisible to every read: the library lists
  rows, the builder edits rows, a run resolves by row. For a human browsing the pipeline library the
  new-pipeline advisory plus a reseed closes that gap. For anything that PINS a pipeline by id it does
  not, and a reusable operation does exactly that: the pin resolves off the task-type registry, which
  knows nothing about rows, so a task of the operation was creatable on an older board and then refused
  to start with a bare 404 that named nothing the user could act on.

  Run resolution now goes through `pipelineAdoption.adoptForRun`, which returns the stored row or
  materialises the catalog entry and returns that. It WRITES rather than running off the code copy on
  purpose: resolving from the catalog without persisting would leave a run executing a pipeline the
  board's own library cannot show, open in the builder, or attach a schedule to, which is the same
  dishonesty as rendering an absent thing as an empty one. Only `builtin` catalog entries are adoptable,
  and that restriction is the safety argument rather than a convenience: a built-in is read-only and
  becomes deletable only once retired, and a retired id is absent from `seedPipelines` by construction,
  so "no row plus a live built-in entry" can only mean never adopted. A versionless registered pipeline
  is deletable, so adopting one would resurrect a deliberate deletion.

  Two adoptions race by construction (two tasks of one operation started at once both resolve "no row"),
  so this adds `PipelineRepository.insertIfAbsent`, conflict-targeted `DO NOTHING` on the composite key
  on both runtimes. Deliberately not `INSERT OR IGNORE` on D1, which would also swallow an unrelated
  constraint failure on that runtime alone and so hide a real bug behind a passing Postgres suite. Both
  writers write the same catalog definition, so first write wins and the loser has nothing to report.
  `PipelineService.reseed`'s absent branch moved onto the same method, fixing a pre-existing race of its
  own, and both now build the row through one shared `adoptedCatalogRow` so adopting and reseeding cannot
  diverge on labels or archive state.

  Widening what a start resolves means every GATE standing in front of one had to be widened with it,
  which is where the read-only twin `resolveDefinition` earns its place. Each of these read the bare row
  and, finding nothing, did not refuse but CONCLUDED, about a pipeline that was about to run anyway:

  - `individualVendorsForBlock` backs the personal-credential gate on the start request, so an un-adopted
    pipeline resolved to no agent kinds, the gate concluded the run needed no personal subscription, and
    the run then adopted and started ungated.
  - The public API's decide-scope check resolves the caller's `pipelineId` to inspect it for parks. A
    `null` skipped the check entirely, and `start` then adopted and parked the run, so a `write`-only key
    could set in motion exactly the park that scope exists to withhold. Both public start paths now read
    `PipelineService.resolveForRun`, which replaces the `get` that served the stored row (nothing wants
    that read any more). One public-API behaviour change falls out of it, additive: naming a pipeline the
    board has not adopted starts the run (or is refused for want of `decide`) instead of answering `404`
    / `pipeline_not_public`, so an integration pinning a pipeline by id no longer waits on a human to
    reseed the board.
  - The post-merge auto-start resolved dependents from the workspace's pipeline LIST and dropped any
    whose pin had no row, silently, so a merge propagated into a task that never began. It now resolves
    misses through `adoptableCatalog()` (no point read per miss: the list already proves there is no
    row), and a dependent whose pin resolves to nothing at all is reported rather than dropped.

  So a bare `pipelineRepository.get` on a run-adjacent path is now the smell. Adoption is also COUNTED,
  through the new `pipeline.adopted` operational counter: the log line says which board caught up, and
  only the rate says how many are still behind a catalog the deployment already shipped.

  Left refusing on purpose: an initiative policy edit or a recurring schedule naming an un-adopted
  pipeline. Both are authoring paths where the SPA only offers stored pipelines, so the refusal is
  reachable headlessly only, and adopting on an authoring write would materialise rows for pipelines
  nobody ran.

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/contracts@0.239.0

## 0.10.2

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/contracts@0.238.0

## 0.10.1

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/kernel@0.236.1

## 0.10.0

### Minor Changes

- c9c1dd3: Persist an agent's tool calls as a first-class trajectory: one row per invocation, in the order it
  made them, carrying the tool's arguments and result. The evidence standard for a merged PR is
  "how, not just the diff", and until now the tool loop survived a run only as metadata spans a
  trace sink had to be wired to see, so reconstructing what an agent actually did meant diffing
  consecutive prompt bodies against each other.

  The fourth telemetry sink (`agent_tool_calls`), beside the per-call cost rows and the dispatch
  context snapshots, in the same store and on the same retention window: D1 on Cloudflare, the
  `telemetry` Postgres schema on Node, `node:sqlite` on a mothership-mode node, with the same
  cross-runtime conformance assertions and the same local-first routing as its siblings. Readable
  through a new `GET /api/v1/debug/runs/:runId/tool-calls` (additive; the spec's `info.version`
  takes a minor and the four SDK clients plus the MCP facade gain the operation), and exported on
  the OTel and Langfuse tool spans alongside the dispatch and ordinal a trajectory orders by.

  The endpoint serves two orders, because the order is the product and a client cannot derive it
  from the rows: `recent` is the newest-first keyset every sibling debug list shares, and
  `order=trajectory` is the run's calls oldest-first as the agents made them, a bounded prefix that
  issues no cursor (pairing one with it is refused rather than quietly served in the other order).
  Both narrow to a single dispatch with `jobId`. The server orders by when each call STARTED, with
  `seq` separating the calls that share a millisecond: sorting by the job id instead would order a
  run's dispatches by agent-kind spelling and its re-runs `-10` before `-2`.

  Both harnesses produce it: the Pi runner pairs each `tool_execution_start` with its end, and the
  claude-code runner pairs each `tool_use` block with the `tool_result` that answers it — the CLI's
  own stream being the only place a subscription run's tool loop is visible at all. Bodies are
  capped and secret-scrubbed at capture, and ride the same `LLM_RECORD_PROMPTS` +
  `storeAgentContext` double gate as every other captured body; a withheld body is recorded AS
  withheld, so an opted-out workspace's trajectory never reads as a run whose every tool took no
  arguments.

  Breaks nothing, retains nothing new by default beyond a run's tool metadata, and requires the
  `1.91.0` runner image (an older image's calls still reach the trace sinks; their trajectory is
  skipped rather than persisted under colliding ids, and the skip is logged).

### Patch Changes

- Updated dependencies [c9c1dd3]
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0

## 0.9.5

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1

## 0.9.4

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0

## 0.9.3

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/kernel@0.234.2

## 0.9.2

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/kernel@0.234.1

## 0.9.1

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0

## 0.9.0

### Minor Changes

- 2580fee: Add OTLP log export: the platform's own structured log lines can now be shipped to the same
  OpenTelemetry endpoint as its traces and metrics.

  A new kernel `LogSink` port lets a facade install a second destination on the logging adapter,
  and `@cat-factory/observability-otel` implements it as a fetch-based exporter POSTing OTLP log
  records to `{endpoint}/v1/logs`. Lines keep their field names, carry their `child`-bound
  correlation ids, and a line naming an `executionId` is stamped (through the same `deriveTraceId`
  the spans go through, not a second copy of it) with that run's trace id and a sampled flag, so
  logs and traces join in the backend.

  Observability may not become a new failure class, so the drain path is total and the send chain
  is terminated: a field that cannot be read or serialised is reported in place of its value rather
  than escaping into the chain, where a rejection would have silenced the exporter permanently and,
  on Node, exited the process through the unhandled-rejection guard. The shutdown flush is bounded
  so it cannot outlast a SIGTERM grace period.

  Opt-in on top of the existing exporter: `OTEL_LOGS=true` plus `OTEL_ENABLED=true` and an
  endpoint, with `OTEL_LOGS_MAX_BATCH_SIZE` and (Node only) `OTEL_LOGS_FLUSH_INTERVAL_MS`.
  `LOG_LEVEL` governs what is exported. Nothing changes for a deployment that has not opted in.

### Patch Changes

- Updated dependencies [2580fee]
- Updated dependencies [eb4ca17]
  - @cat-factory/kernel@0.233.0
  - @cat-factory/contracts@0.231.0

## 0.8.7

### Patch Changes

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0

## 0.8.6

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0

## 0.8.5

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0

## 0.8.4

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0

## 0.8.3

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/kernel@0.228.1

## 0.8.2

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0

## 0.8.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0

## 0.8.0

### Minor Changes

- 3605630: Finish the in-app-tutorial initiative (now [ADR 0036](backend/docs/adr/0036-in-app-tutorials.md)):
  make the walkthroughs reach the user who needs one, and measure whether they do.

  The catalogue already made every tour REACHABLE; nothing brought one up. Starting any tour saves the
  launch-prompt answer, which is what stops that prompt returning, so after a user's first tour the
  product never mentioned the tutorial again unless they went looking, and the two tours whose windows
  are transient (answer a parked run, review and merge) were the least likely to be found while they
  applied. So: the finish card now hands off to the one walkthrough the user's own last action
  unlocked, and a contextual offer catches a tour's declared requirements flipping from blocked to
  ready. Four new tours ship with it, the first of which closes the biggest hole in the arc: reading a
  FAILED run (the state a first run reaches most often, and the only one that had no walkthrough),
  plus where runs execute, review-by-panel, and the shared-services catalog.

  Progress now follows the USER rather than the browser, through a new per-user `tutorial_progress`
  table on both facades (`remote` in mothership mode, self-scoped). The browser-persisted store stays
  what the SPA reads and stays fully functional with no accounts, no store wired, or offline; the
  server row is a best-effort mirror. Both id lists are grow-only sets, UNIONED on both sides, because
  two browsers signed in as one person each hold a full copy and each write it back: a
  last-writer-wins replace on either side silently drops what the other learned. "Reset progress" is
  therefore a DELETE. Each push carries the whole local state and reconciles the merged row it gets
  back, so a merge that lost a concurrent writer's ids re-pushes instead of waiting for a local change
  that may never come; a merge whose RESULT would exceed `MAX_TUTORIAL_TOUR_IDS` is refused with
  `details.reason: 'tutorial_progress_too_large'` rather than truncated, since the row rides every
  workspace snapshot.

  Three new operational counters (`tutorial.tour_started` / `_completed` / `_abandoned`, dimensioned
  by tour) answer the question the initiative could not answer about itself. They ride the existing
  `OperationalMetrics` port because there is deliberately only one counter seam; the tour dimension is
  bounded twice, by the wire schema's shape rule and by a per-process distinct-value cap that folds
  the rest onto a visible `other` bucket, since a dimension whose values come from a browser is
  otherwise an unbounded-cardinality hole in an operator's metrics backend.

  New internal routes (not `/api/v1`, so no SDK surface): `GET|PUT|DELETE /tutorial/progress` and
  `POST /tutorial/events`, root-mounted beside `/user-settings`. Root-mounted specifically so they sit
  outside the workspace-RBAC viewer write floor, which a read-only viewer taking a walkthrough would
  otherwise trip. The workspace snapshot gains an optional `tutorialProgress`, and `NavGates` gains
  `boardHasFailedRun`; a deployment that builds its own gates object must add that field.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0

## 0.7.2

### Patch Changes

- Updated dependencies [36b1853]
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0

## 0.7.1

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0

## 0.7.0

### Minor Changes

- 04e44f8: Finish the operator-observability initiative: gate/CI-fixer attempt statistics, a daily run
  rollup behind new 30d/90d dashboard windows, per-account alert-threshold settings, and a
  platform-health alert card that deep-links to the runs it aggregated.

  Three new main-store tables ship with it: `gate_outcomes` (one row per polling gate that reaches a
  terminal verdict), `platform_run_days` (the daily rollup, materialised by the retention sweep) and
  `platform_rollup_state` (how far that sweep has covered, which is a fact about the sweep and so
  cannot be derived from the rolled-up rows). The first two are pruned on their own retention
  windows, `GATE_OUTCOME_RETENTION_DAYS` (90) and `PLATFORM_RUN_DAY_RETENTION_DAYS` (400); the third
  is a single forward-only marker row and is not pruned.

  Breaking (pre-1.0, no migration path offered): the `PlatformObservability` wire shape gains
  required `source`, `rolledUpThrough` and `gates` fields, and `platformObservabilityWindowSchema`
  gains `30d` / `90d`. A `platform_health` notification's `platformWindow` narrows to the
  live-scanned windows only. Any stored projection or client pinned to the old shape must be
  re-read rather than migrated.

  Also breaking for a deployment that assembles its own container: `CoreDependencies.gateOutcomeRepository`
  is REQUIRED, like `logger` and `operationalMetrics` and for the same reason. The engine WRITES this
  projection, and an un-wired writer reads downstream as "no gate on this deployment ever escalated",
  which is indistinguishable from a healthy one. A deployment with no such store passes the new
  `noopGateOutcomeRepository`, which says so in code.

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0

## 0.6.0

### Minor Changes

- c8ba2cd: OTLP traces: arrange a run's spans into a `run → agent kind → generations + tool calls`
  hierarchy instead of siblings sharing a trace id, and document the GenAI semantic-convention
  coverage explicitly.

  Parent ids are derived from the run rather than held anywhere, so a stateless per-call emission
  names a parent it has never seen; the parents themselves are emitted when the run settles, through
  the new optional `LlmTraceSink.recordRunSpans`. Their extent is folded from stamps the run already
  recorded rather than read off a clock, so the terminal hook re-firing for an already-settled run
  re-exports a byte-identical tree instead of the same span ids carrying a different duration.

  A step that dispatched a helper kind (a gate's `ci-fixer`, a Tester's fixer, a two-phase coder's
  `fork-proposer`) gets a span for that kind nested under it. Those dispatches are what the helper's
  telemetry is tagged with, so without one every generation and tool span they produced would name a
  parent nobody emits. The run now records what it dispatched on `PipelineStep.dispatches`, written
  through the single `recordDispatchAttribution` funnel.

  Cycles are counted rather than separated. A fixer loop, a Ralph iteration and a bounced step all
  repeat under one span, and the events beneath it carry no attempt ordinal to split it by, so each
  step span states `cat_factory.attempt_count` beside `step_count`. A re-run step's span now starts
  from the new `PipelineStep.firstStartedAt`, which survives the reset that re-stamps `startedAt`;
  without it the span began after the generations of its own earlier attempts.

  Span names changed, so an existing dashboard filtering on them needs re-pointing. A generation
  adopts the convention's `{operation} {model}` (the agent kind now names the step span above it and
  still rides as `cat_factory.agent_kind`), a tool call becomes `execute_tool {tool}`, and a run's
  root span is the bare `run` with its pipeline as `cat_factory.pipeline`, keeping every span name a
  bounded class rather than workspace-authored free text.

- 175f78f: Security hardening round 2, P1: close SEC-3, SEC-4 and SEC-5 (docs/initiatives/security-hardening-round-2.md).

  - **Machine tokens are revocable (SEC-5).** Every `POST /auth/machine-token` mint is recorded on
    the new `machine_nodes` roster (kernel `MachineNodeRepository`; D1 migration
    `0077_machine_nodes.sql` ⇄ Drizzle `machineNodes`), the new shared machine gate
    (`verifyMachineRequest`) checks the revocation tombstone on every `/internal/*` machine surface
    plus the WS subscribe handshake, and the owner drives `GET /auth/machine-nodes` /
    `POST /auth/machine-nodes/:nodeId/revoke`. A revoked node id can never be re-minted and a
    foreign node id cannot be taken over, enforced by the roster WRITE itself (a guarded
    `ON CONFLICT ... WHERE`) so two concurrent mints of one id cannot leave a row whose owner did
    not mint it. A mothership with no roster wired refuses to mint at all, since an unrecorded token
    could never be revoked; a roster read that fails refuses the call rather than serving it, and on
    the WS handshake answers 503 (retry) rather than crashing the upgrade. Rows prune once past
    their latest signed `exp`.
  - **The password throttle is durable and spoof-resistant (SEC-4).** Attempts land in the new
    cross-replica `auth_attempts` ledger (kernel `AuthAttemptRepository`; D1 migration
    `0078_auth_attempts.sql` ⇄ Drizzle `authAttempts`) with a per-`ip:email` burst cap AND a per-IP
    aggregate that catches one-password-many-emails credential stuffing; the in-process Map remains
    only as the store-outage backstop. WHICH header carries the client address is a per-facade
    decision behind `ServerContainer.resolveClientAddress`: Node reads the socket peer, and
    `x-forwarded-for` (rightmost hop, `AUTH_TRUST_PROXY_HOPS` deep) only under the new
    `AUTH_TRUST_PROXY=true`; the Worker reads `cf-connecting-ip`, which is authentic only there.
    Addresses are normalised before keying (port stripped, non-IP refused, IPv6 bucketed to its
    /64). The 429 carries `details.reason: 'auth_attempts'` and `retryAfterSeconds`, and both a trip
    and a store outage are counted (`auth.throttle.limited`, `auth.throttle.store_unavailable`).
    Completes the durable-auth-rate-limiting initiative, now ADR 0032.
  - **Local-runner hosts are loopback-only by default (SEC-3). BEHAVIOUR BREAK:** registering or
    calling a locally-run model endpoint on a private-LAN host (RFC1918 / ULA / mDNS `.local`) now
    requires the operator opt-in `LOCAL_MODELS_ALLOW_LAN=true` on hosted deployments; single-tenant
    local mode defaults the opt-in on. The policy binds the write boundary, the test probe and every
    run-time redirect hop, so an existing LAN row on a hosted deployment is refused instead of
    silently serving an internal-network SSRF surface. Such a row is now also reported on the
    endpoint itself (`LocalModelEndpoint.urlBlockedReason`) and its models are withheld from the
    picker, so the failure surfaces in settings rather than mid-run.
  - **BEHAVIOUR BREAK (SEC-3):** a runner base URL may no longer carry a query string, a `#`
    fragment or `.`/`..` path segments, and `*.localhost` subdomains are no longer accepted (plain
    `localhost` still is). A base URL ending in `#` made the fixed `/models` and `/chat/completions`
    suffixes inert, which turned both server-side forwards into an arbitrary-path request against
    whatever listens on loopback; endpoint URLs are now composed through one validating helper
    rather than concatenated. Every refusal carries a machine-readable
    `LocalRunnerUrlReason` the SPA maps to translated copy.

### Patch Changes

- Updated dependencies [c8ba2cd]
- Updated dependencies [807e442]
- Updated dependencies [807e442]
- Updated dependencies [175f78f]
- Updated dependencies [807e442]
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0

## 0.5.7

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/kernel@0.221.1

## 0.5.6

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/kernel@0.221.0

## 0.5.5

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/kernel@0.220.0

## 0.5.4

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0

## 0.5.3

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0

## 0.5.2

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0

## 0.5.1

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0

## 0.5.0

### Minor Changes

- 54d531d: Count the deployment's operational EVENTS, and let the health alerts see a dead one.

  The platform-observability projection answers "how are the runs doing" by aggregating
  `agent_runs`. It structurally cannot answer what an operator asks during an incident — how often
  container dispatch is failing, whether the sweeper is re-driving more than it was, whether a queue
  is draining — because none of those are rows in a table. A new kernel `OperationalMetrics` port
  counts them, and the OTLP platform exporter ships them as delta sums beside the existing gauges.
  Wired at the sweepers, the container seam, the trace sinks, the notification webhook and every
  app-cache read; `agent_runs` gained a persisted `redrive_count`, so "was this run re-driven three
  times?" is answerable after the process (or the isolate) that did it is gone.

  `platform_health` gained three conditions. The important one is zero-throughput: every existing
  condition divides by runs and goes silent at zero, so a deployment that stopped accepting work
  read identically to a quiet healthy one. Alongside it, a dominant-failure-kind condition (100%
  `evicted` and 100% `agent` produce the same failure rate and need opposite fixes) and one that
  alerts on the sweepers themselves, since a wedged sweeper makes every other signal stale without
  making any of them fire. A sweep pass reports its rate and its failure streak through ONE call
  (`SweepHealthTracker.recordFailure`), and the Worker drives its crons through a `SweepTick` that
  is the facade-symmetric twin of Node's `startSweeper` — so both runtimes cover the same set of
  sweepers, and the tick's counters are flushed after its passes have settled rather than before.

  Also: retention pruning is now isolated per table (one sick table used to abort the whole pass,
  indefinitely, and report zeroes indistinguishable from an empty table); `/ready` round-trips
  pg-boss's own connection instead of trusting a process-local boolean, and the Worker gained a
  bindings-probing `/ready`; and every pg-boss queue is created with a dead-letter sibling whose
  depth rides the `queue.depth` gauge under `state: dead_letter`, with an hourly sweep logging the
  source queue to go and look at.

### Patch Changes

- Updated dependencies [233e279]
- Updated dependencies [54d531d]
  - @cat-factory/contracts@0.212.0
  - @cat-factory/kernel@0.215.0

## 0.4.42

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/kernel@0.214.1

## 0.4.41

### Patch Changes

- Updated dependencies [3435bd1]
  - @cat-factory/kernel@0.214.0

## 0.4.40

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0

## 0.4.39

### Patch Changes

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/contracts@0.210.1

## 0.4.38

### Patch Changes

- Updated dependencies [769a3d9]
  - @cat-factory/kernel@0.211.0

## 0.4.37

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0

## 0.4.36

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0

## 0.4.35

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0

## 0.4.34

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0

## 0.4.33

### Patch Changes

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/contracts@0.206.1

## 0.4.32

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0

## 0.4.31

### Patch Changes

- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0

## 0.4.30

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0

## 0.4.29

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0

## 0.4.28

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/contracts@0.203.0
  - @cat-factory/kernel@0.201.1

## 0.4.27

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/kernel@0.201.0

## 0.4.26

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0

## 0.4.25

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0

## 0.4.24

### Patch Changes

- Updated dependencies [d9789f9]
  - @cat-factory/kernel@0.198.0
  - @cat-factory/contracts@0.200.0

## 0.4.23

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/contracts@0.199.0
  - @cat-factory/kernel@0.197.0

## 0.4.22

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0

## 0.4.21

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0

## 0.4.20

### Patch Changes

- Updated dependencies [f9db6a6]
  - @cat-factory/kernel@0.194.0

## 0.4.19

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0

## 0.4.18

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0

## 0.4.17

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0

## 0.4.16

### Patch Changes

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0

## 0.4.15

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0

## 0.4.14

### Patch Changes

- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0

## 0.4.13

### Patch Changes

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0

## 0.4.12

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0

## 0.4.11

### Patch Changes

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/kernel@0.185.1

## 0.4.10

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/kernel@0.185.0

## 0.4.9

### Patch Changes

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0

## 0.4.8

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0

## 0.4.7

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0

## 0.4.6

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0

## 0.4.5

### Patch Changes

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0

## 0.4.4

### Patch Changes

- Updated dependencies [b75a08a]
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0

## 0.4.3

### Patch Changes

- Updated dependencies [9d965c9]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0

## 0.4.2

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0

## 0.4.1

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/contracts@0.183.0
  - @cat-factory/kernel@0.176.0

## 0.4.0

### Minor Changes

- b30cc6e: Make the three LLM input-token classes orthogonal in telemetry: `promptTokens` is now FRESH
  (uncached) input only, with `cacheReadTokens` and `cacheWriteTokens` carried beside it, so total
  input is their sum. A cache read is priced ~0.1x base input and a cache write 1.25-2x, so the old
  lumped `cachedPromptTokens` made a run re-writing its prefix every turn indistinguishable from one
  riding a warm cache.

  BREAKING (telemetry only, no migration path by design): `cachedPromptTokens` is dropped from
  `llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema` and the metrics export, and
  `cached_prompt_tokens` is dropped from both telemetry stores. `HarnessCallMetric.cachedInputTokens`
  becomes `cacheReadTokens` + `cacheWriteTokens`, and `inlineResult.usage` gains the same split.
  `llm_call_metrics` is pruned to a 3-day window, so rows carrying the old inclusive `prompt_tokens`
  semantics churn out on their own; `cacheHitRate` is now `(read + write) / (fresh + read + write)`
  and no longer needs its clamp. `cachedTokensFromUsage` is replaced by `readInputTokenClasses`,
  which returns all three classes from one usage payload (reconciling the inclusive and exclusive
  provider shapes internally, so no caller has to know which it is holding), and
  `ProxyCallObservation.cachedPromptTokens` becomes `inputTokens: InputTokenClasses`.

### Patch Changes

- Updated dependencies [b30cc6e]
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0

## 0.3.2

### Patch Changes

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0

## 0.3.1

### Patch Changes

- Updated dependencies [bead6df]
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0

## 0.3.0

### Minor Changes

- 6dbd864: Introduce a central, pino-backed structured logger behind a kernel `Logger` port, so the whole
  domain engine can log — previously only `@cat-factory/server` and the runtime facades could, which
  forced the domain packages to swallow failures silently.

  - **New**: `Logger` / `noopLogger` / `createRecordingLogger` (`@cat-factory/kernel`,
    `ports/logging.ts`), and `runBestEffort` / `describeError` (`shared/best-effort.ts`) as the
    replacement for `.catch(() => {})`. `@cat-factory/server` exports `createPinoLogger`,
    `parseLogLevel`, `setLogLevel` and `getLogLevel` alongside the process-wide `logger`.
  - **`LOG_LEVEL`** is now honoured (`process.env` on Node/local, a wrangler var on the Worker);
    it was previously read from a global nothing ever assigned.
  - **Node/local** register `unhandledRejection`/`uncaughtException` guards and subscribe to
    pg-boss's `error` event (an unhandled one on an EventEmitter throws). The guards add the
    structured line only — both still exit non-zero, matching what Node already did (since Node 15
    an unhandled rejection is raised as an uncaught exception), so process lifetime is unchanged.

  **Breaking (pre-1.0, no shims):**

  - The logger's calling convention is now **message-first**: `logger.warn(msg, fields)`, not pino's
    `logger.warn(fields, msg)`. `Logger` is the kernel port type, no longer pino's own.
  - Every ad-hoc logger interface is **removed**, not deprecated: `PrReportLogger`,
    `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
    `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
    `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`. Every `logger?:` dependency now takes the
    kernel `Logger`.
  - `@cat-factory/node-server` no longer exports `pinoKeyFingerprintLogger` (the shapes match, so the
    bridge is gone). `@cat-factory/orchestration`'s `Core` gains a required `logger`.
  - **`CoreDependencies.logger` is REQUIRED**, not optional. A facade or harness assembling the bag
    by hand must pass one (`noopLogger` if it does not care) or it will not typecheck — the guard
    that would have caught the Worker shipping with no logger wired at all.

  Also fixes `MergeTrackRecordService.classify` losing the repo identity when `listChangedFiles`
  throws, which permanently broke external-merge attribution for that record.

### Patch Changes

- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0

## 0.2.57

### Patch Changes

- Updated dependencies [9d8fe9b]
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0

## 0.2.56

### Patch Changes

- Updated dependencies [cf2779a]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/kernel@0.170.0

## 0.2.55

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0

## 0.2.54

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0

## 0.2.53

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/kernel@0.167.1

## 0.2.52

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/kernel@0.167.0

## 0.2.51

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0

## 0.2.50

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1

## 0.2.49

### Patch Changes

- Updated dependencies [f0e9bab]
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0

## 0.2.48

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0

## 0.2.47

### Patch Changes

- Updated dependencies [968a214]
  - @cat-factory/contracts@0.169.0
  - @cat-factory/kernel@0.163.1

## 0.2.46

### Patch Changes

- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/kernel@0.163.0

## 0.2.45

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/contracts@0.168.0
  - @cat-factory/kernel@0.162.0

## 0.2.44

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0

## 0.2.43

### Patch Changes

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0

## 0.2.42

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/kernel@0.159.1

## 0.2.41

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0

## 0.2.40

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0

## 0.2.39

### Patch Changes

- Updated dependencies [55e0a85]
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0

## 0.2.38

### Patch Changes

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0

## 0.2.37

### Patch Changes

- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0

## 0.2.36

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/contracts@0.160.1

## 0.2.35

### Patch Changes

- 770f926: Upgrade the Vercel AI SDK family to v7 (paired with `workers-ai-provider@4`) and refresh the rest of the dependency tree within the supply-chain release-age gate.

  - **AI SDK v7 / Cloudflare Workers AI**: `ai@^6 → ^7`, `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/provider` `^3/^4 → ^4`, `@ai-sdk/openai-compatible@^2 → ^3`, `@ai-sdk/amazon-bedrock@^4 → ^5`, and `workers-ai-provider@^3 → ^4`. This is now possible because `workers-ai-provider@4` accepts `ai@^7` peers, lifting the pin that previously held the family at v6. The only code change required is reading the AI SDK v7 usage shape (`usage.inputTokenDetails.cacheReadTokens` in place of the removed `usage.cachedInputTokens`).
  - **Dependency sweep**: within-range refresh of the tree plus targeted bumps of `@cloudflare/workers-types@^4 → ^5` (aligns with the `wrangler@4` peer), `@opentelemetry/exporter-*-otlp-http@^0.220 → ^0.221` (lockstep with the `@opentelemetry/*@2.10` SDKs), and `oxfmt`, `undici`, `pg-boss`, `@nuxtjs/i18n`, `happy-dom`, `vue-tsc`, `wrangler` and others to their latest release-age-compliant versions. The `@cat-factory/executor-harness` runner-image deps are deliberately untouched.

- Updated dependencies [770f926]
  - @cat-factory/kernel@0.154.1

## 0.2.34

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0

## 0.2.33

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0

## 0.2.32

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0

## 0.2.31

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0

## 0.2.30

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/kernel@0.150.0

## 0.2.29

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0

## 0.2.28

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.2.27

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4

## 0.2.26

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.2.25

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2

## 0.2.24

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/kernel@0.148.1

## 0.2.23

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0

## 0.2.22

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.2.21

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2

## 0.2.20

### Patch Changes

- 492d0a2: Lint ratchet: complete `max-depth` (5 → 4, its final target; no behavioural change).

  Refactored the 18 depth-5 sites down to ≤ 4 by hoisting the innermost loop bodies into
  helpers along cohesive seams:

  - Extract a shared `parseSubtasks` into `@cat-factory/kernel` (`domain/subtasks.logic.ts`)
    and replace the four duplicated row→domain copies in the D1 and Drizzle bootstrap /
    env-config-repair repositories (removing the 4× duplication as well as the depth).
  - Split the two Worker `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop`
    - a shared `pollOnce`), the benchmark harness's per-task fixture dispatch, the seed-dump
      child scan and the env-config bootstrap commit/PR path in `@cat-factory/integrations`, the
      Workers-AI assistant tool-call conversion, and the OTEL conformity metric fold into helpers.
  - Lower `max-depth` to `4` in `.oxlintrc.json`.

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.2.19

### Patch Changes

- 2d97b16: First pass on the oxlint complexity/size ratchet (no behavioural change):

  - Tighten the free size ceilings now that the conformance god-file split dropped their floors:
    `max-lines` 3119 → 2802 and `max-lines-per-function` 3103 → 2453.
  - Complete `max-nested-callbacks` (6 → 4, its final target) by extracting the spec-id flatMap
    chain in `render.test.ts` into a helper.
  - Lower `max-depth` 6 → 5 by extracting the per-metric fold in the OTEL conformity test and the
    per-target recommendation application in `RequirementReviewService` (`applyRecommendationToTarget`)
    out of their deeply-nested loops.
  - Add `scripts/lint-limits-report.mjs`, a floor-finder that reports each ratcheted rule's live
    ceiling, actual floor, and top offenders to plan subsequent slices.

## 0.2.18

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.2.17

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1

## 0.2.16

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/kernel@0.145.1

## 0.2.15

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0

## 0.2.14

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0

## 0.2.13

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0

## 0.2.12

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.2.11

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.2.10

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.2.9

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/contracts@0.148.1

## 0.2.8

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.2.7

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/kernel@0.139.2

## 0.2.6

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1

## 0.2.5

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0

## 0.2.4

### Patch Changes

- Updated dependencies [60c0a1e]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/kernel@0.138.1

## 0.2.3

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/kernel@0.138.0

## 0.2.2

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/kernel@0.137.1

## 0.2.1

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.2.0

### Minor Changes

- 27f0ea2: Expose the deployment-level (platform-operator) observability aggregates via OpenTelemetry.

  A periodic, runtime-symmetric sweep (Worker `scheduled` cron ⇄ Node interval, like the
  retention sweeps) now pushes the same run-health projection the operator dashboard renders —
  run outcomes by status, the failure-kind taxonomy, live/parked depth, and the avg/min/max +
  p50/p90/p99 duration percentiles — to any OTLP/HTTP backend as OpenTelemetry **gauge**
  metrics (`cat_factory.platform.*`), per account (the bounded tenant scope) and stamped with
  the projection's `generatedAt`. The OTel backend builds trends from the gauge series, so the
  sweep exports the shortest trailing window (`1h` default).

  `@cat-factory/observability-otel` gains a fetch-based `PlatformMetricsOtelExporter`
  (`createPlatformMetricsOtelExporter`) — the workerd-safe transport used on BOTH runtimes
  (the platform push is a stateless snapshot POST, so it needs no SDK, mirroring the Langfuse
  sink's fetch-on-both shape). The runtime-neutral `sweepPlatformMetrics` driver + the
  `distinctAccountIds` account enumeration live in `@cat-factory/orchestration`.

  Opt-in on top of the base OTel exporter (it adds recurring DB rollup load): off unless
  `OTEL_ENABLED=true` + an endpoint AND `OTEL_PLATFORM_METRICS=true`. `OTEL_PLATFORM_METRICS_WINDOW`
  (`1h`/`24h`/`7d`) and, on Node, `OTEL_PLATFORM_METRICS_INTERVAL_MS` tune it. A deployment
  that hasn't opted in emits nothing and runs no sweep.

## 0.1.12

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.1.11

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.1.10

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.1.9

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.1.8

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.1.7

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.1.6

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.1.5

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.1.4

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.1.3

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.1.2

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.1.1

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.1.0

### Minor Changes

- d68e3a8: Add opt-in OpenTelemetry (OTLP) observability. A new `@cat-factory/observability-otel`
  package implements the kernel `LlmTraceSink` port and exports LLM generations (+ container
  tool spans) and metrics to any OTLP/HTTP backend — a workerd-safe fetch exporter on the
  Cloudflare Worker facade and the official `@opentelemetry/*` SDK exporter on Node, kept
  conformant by a shared mapping layer + a conformity test.

  - **kernel:** new `CompositeTraceSink` + `composeTraceSinks` so multiple external trace
    destinations (Langfuse and/or OTLP) fan out through the single sink slot.
  - **server:** new `OtelConfig` on `AppConfig`.
  - **worker / node-server:** wire the OTLP exporter (fetch on the Worker, SDK on Node)
    everywhere the Langfuse sink is wired, composed alongside Langfuse. Enabled with
    `OTEL_ENABLED=true` + `OTEL_EXPORTER_OTLP_ENDPOINT` (`OTEL_EXPORTER_OTLP_HEADERS` /
    `OTEL_SERVICE_NAME` optional).
  - **cli:** advertise the `OTEL_*` vars in the generated `.env`.

  Refinements: the Node facade shares ONE trace-sink instance across the core, the container
  executor and the inline model-provider (so the SDK exporter's batch processors/timers aren't
  duplicated) and flushes + shuts it down on graceful shutdown (via `LlmTraceSink.shutdown` /
  `CompositeTraceSink` fan-out) so the final batch isn't dropped. Metric data points carry only
  the low-cardinality `gen_ai.*` dimensions — the unbounded workspace id stays on spans, off
  metrics — to keep metric-backend cardinality bounded.

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
