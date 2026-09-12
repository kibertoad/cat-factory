# @cat-factory/gatekeeper-worker

## 0.7.1

### Patch Changes

- Updated dependencies [9f8cabc]
  - @cat-factory/gatekeeper-bindings@0.36.1
  - @cat-factory/sdk@0.54.1

## 0.7.0

### Minor Changes

- 69fc66c: Watch a run that works in chunks: an SSE decision channel, bug-fishing verbs, and a step-boundary
  webhook event
  
  Three of the platform's longest operations work in CHUNKS. A PR deep review slices a diff, reviews
  the slices in parallel and aggregates. A bug-fishing expedition dispatches one read-only pass per
  angle per territory, recording each catch as it lands. A requirements review iterates. Each runs for
  minutes to tens of minutes, and none of it reached the stream: an SSE frame is emitted when the RUN
  projection changes, and what those operations move through lives on step state the projection does
  not carry. A seventeen-minute review produced no frame at all and then one `decision` at the park,
  while the public-API guide told a caller to poll the decisions endpoint for exactly the progress the
  stream could not give it.
  
  `GET /api/v1/runs/{runId}/decision-events` streams that decision list: a `decision-state` frame
  carrying the same payload `GET /api/v1/runs/{runId}/decisions` answers, pushed whenever it changes,
  so a slice reporting, a challenge verdict landing or an expedition's angle settling arrives without
  polling. Its own endpoint rather than a `?decisions=true` flag on the run streams, and that is the
  decision worth reading: a query parameter added to an existing operation is emitted as a positional
  argument ahead of the trailing options bag, so `client.tasks.stream(taskId, options)` becomes
  `client.tasks.stream(taskId, query, options)` and Go's `Stream(ctx, taskID)` grows an argument, which
  is an in-place retype of four released clients. A new operation is additive, and it is the better
  shape anyway: keyed by RUN like the list it streams, so one endpoint serves a board task and a
  headless job where the flag needed adding to two. The frame carries the WHOLE list, never a subset,
  because an empty `decisions` that means "nothing is being asked" and one that means "this payload was
  narrowed" are opposite facts. What it does reduce is the model-authored PROSE inside the list, which
  is where the volume is: over-long strings are clipped to a preview and `truncated: true` reports the
  clip, the same bargain `publicRunStep.truncated` strikes on the run streams. The point read still
  serves every field whole.
  
  `bug-fishing` joins the decision surface as a fourteenth kind, with the three verbs the app already
  drives: mark findings to be addressed (one bug-fix task per mark), dismiss one, finish triaging. A
  parked expedition used to arrive in `unanswerable[]` as a `curation_gate` saying the marking had to
  happen in the app, while the step's own approval gate WAS offered, so a `decide` key could end an
  expedition with everything it caught unacted on but could not act on any of it. Both shipped curating
  kinds are now answerable; `curation_gate` keeps a narrower population, a curating kind a deployment
  registered itself. All three verbs refuse an expedition the run has already advanced past
  (`expedition_settled`), which is the one state curation is not accepted in: marking is deliberately
  open while later angles are still being fished, so "settled" is what has to be checked and a stale
  finding id could otherwise be replayed into fix tasks nothing is left to link them to.
  
  The outbound webhook's `runEvents` family gains `run.step_completed`, one delivery per step
  BOUNDARY, opt-in per event like the rest. This is the narrowing of the per-step feed ADR 0030
  rejected, not a reversal: that rejection was about a progress feed the engine emits on every
  container poll, where this fires ten times over a ten-step pipeline. Its `deliveryId` carries the
  step index AND the step's attempt, because it is the one event a single run emits repeatedly and it
  does so along both axes: the family's two-part key would collapse a whole pipeline onto its first
  step, and an index-only key would collapse a step's rework cycles onto its first pass. `step.outcome`
  distinguishes `skipped` from `completed`, because the engine skips a gated step by marking it done
  with no output. The member is APPENDED to the vocabulary rather than slotted in beside the edge it
  belongs with: that list's order is published as a Java enum's `ordinal()` and as a `*_VALUES` array
  in three more clients.
  
  The `/api/v1` spec moves to 1.74.0 and the change is additive throughout. One thing to watch on the
  generated clients: bug-fishing's `confidence` vocabulary is `high|medium|low` and a reviewer
  finding's `severity` is `low|medium|high`, and the SDK emitter's enum signature is value-sorted, so
  two vocabularies spelled the same way collapse onto one type whose name and member order come from
  whichever walks first. Left alone that deleted `PublicReviewFindingSeverity` from four released SDKs.
  The emitter now answers both halves of that: a pin fixes member ORDER as well as the name (and is
  checked to be a permutation of the real set), and a vocabulary that merely coincides can be declared
  DISTINCT, so `confidence` publishes as `PublicBugFishingConfidence` rather than under a name that
  asserts it is a reviewer finding's severity.

### Patch Changes

- Updated dependencies [69fc66c]
  - @cat-factory/sdk@0.54.0
  - @cat-factory/gatekeeper-bindings@0.36.0

## 0.6.36

### Patch Changes

- Updated dependencies [2cf867d]
  - @cat-factory/sdk@0.53.0
  - @cat-factory/gatekeeper-bindings@0.35.0

## 0.6.35

### Patch Changes

- Updated dependencies [5dc7506]
  - @cat-factory/sdk@0.52.0
  - @cat-factory/gatekeeper-bindings@0.34.0

## 0.6.34

### Patch Changes

- Updated dependencies [333b967]
  - @cat-factory/gatekeeper-bindings@0.33.3
  - @cat-factory/sdk@0.51.3

## 0.6.33

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

## 0.6.32

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
  - @cat-factory/sdk@0.51.2
  - @cat-factory/gatekeeper-bindings@0.33.2

## 0.6.31

### Patch Changes

- Updated dependencies [cd220f2]
  - @cat-factory/gatekeeper-bindings@0.33.1
  - @cat-factory/sdk@0.51.1

## 0.6.30

### Patch Changes

- Updated dependencies [e7e1f8c]
- Updated dependencies [a1802d9]
  - @cat-factory/sdk@0.51.0
  - @cat-factory/gatekeeper-bindings@0.33.0

## 0.6.29

### Patch Changes

- Updated dependencies [8b015a3]
  - @cat-factory/sdk@0.50.0
  - @cat-factory/gatekeeper-bindings@0.32.0

## 0.6.28

### Patch Changes

- Updated dependencies [92232a6]
- Updated dependencies [a08d2ad]
  - @cat-factory/sdk@0.49.0
  - @cat-factory/gatekeeper-bindings@0.31.0

## 0.6.27

### Patch Changes

- Updated dependencies [be0b953]
  - @cat-factory/gatekeeper-bindings@0.30.1
  - @cat-factory/sdk@0.48.1

## 0.6.26

### Patch Changes

- Updated dependencies [7d899c4]
  - @cat-factory/sdk@0.48.0
  - @cat-factory/gatekeeper-bindings@0.30.0

## 0.6.25

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/sdk@0.47.0
  - @cat-factory/gatekeeper-bindings@0.29.0

## 0.6.24

### Patch Changes

- 1ea2f95: Turn on the supply-chain gate that was never configured, and hold the Cloudflare runtime to one copy
  with an assertion rather than an override.
  
  Three of these are follow-ups to the 2026-08-25 dependency refresh, but two of them turn out not to
  be about that PR at all.
  
  **The `minimumReleaseAge` gate has been off the whole time.** `pnpm-workspace.yaml` carried a
  maintained, documented, argued-over `minimumReleaseAgeExclude` list, and CLAUDE.md described a
  24-hour window that installs enforce. pnpm has no default for `minimumReleaseAge`, and the value was
  set nowhere: it derives `maximumPublishedBy` as `opts.minimumReleaseAge ? ... : undefined`, so an
  unset value is not a shorter window but no window at all, and the exclude list beside it governs
  nothing. Verified against pnpm 11.23.0 by resolving `hono@^4.13.0` twice: unset it takes 4.13.4,
  published 17 hours earlier; with `minimumReleaseAge: 1440` it takes 4.13.3. The setting is now
  present, which is the whole fix, and CLAUDE.md leads with the fact that the exclude list is inert
  without it. Re-resolving the tree under the armed gate moved nothing, so nothing in the lockfile was
  younger than the window it should always have been held to.
  
  That also settles the `pg-boss@12.28.0` exception the refresh added with a PRUNE ME note. It is
  gone, along with the last third-party entry; it was never doing anything anyway.
  
  **The `wrangler` override is replaced by the assertion it was standing in for.** The invariant is
  one wrangler, and through it one workerd and one miniflare, because the Worker suite runs inside
  `@cloudflare/vitest-pool-workers`' workerd while `wrangler deploy` ships wrangler's. A top-level
  override cannot express that: it OVERRIDES the pool's exact pin instead of TRACKING it, so the next
  pool bump would be forced silently back to our number and the pool would run against a wrangler it
  never pinned. Every package that declares wrangler already pinned it exactly, so the override was
  load-bearing only in the direction that hurts; removing it re-resolves to the same single 4.124.0.
  `scripts/check-cloudflare-runtime-pins.mjs` now fails CI when a second copy of any of the three
  appears, which catches the pool bump and every other route to a split as well.
  
  **`@cloudflare/workers-types` is pinned to the workerd date and joins that count.** Its version IS a
  workerd date, so the caret left the types eight days ahead of the runtime, where an API added in the
  gap typechecks green and throws in production. `wrangler@4.124.0` names the right answer itself: its
  own peer range on the package is `^5.20260815.1`, matching `workerd@1.20260815.1`. Pinning the four
  workspace declarations was not enough on its own, which is the part worth knowing: `autoInstallPeers`
  kept filling drizzle-orm's optional peer slot (`>=4`) and wrangler's own, wherever a package declares
  wrangler without the types beside it, from the newest published version, quietly reinstating
  5.20260823.1 beside the pin. That needs the override, and the guard is what makes the duplicate
  visible instead of silent. The published `peerDependencies` range on `@cat-factory/gatekeeper-worker`
  stays wide, as a library's must.
  
  **Stryker 10's floors are re-measured, and kernel's had almost no margin left.** The refresh
  described the major as a Node 20 drop; it also added `emptyExpressionMutator` to the default set,
  enlarging the mutant population, and the floors were last measured under 9.6.1. Re-measured on CI:
  gates 651 -> 669 mutants and 90.78 -> 90.58, spend 396 -> 400 and 97.73 -> 97.25, both absorbed with
  the floor untouched. Kernel took all of it, 7,316 -> 7,908 and 84.23 -> 82.37 against a floor of 82,
  turning a 2.23-point margin into 0.37: one untested module short of a red nightly that would have
  read as a regression rather than as scope growth. Its covered score held (85.79 -> 85.56), so
  nothing stopped being pinned, and the floor drops to 80. Each floor now records the version that
  measured it, and `docs/internal/mutation-testing.md` makes a Stryker major a re-measure, because a
  floor is only a fact about the mutator set behind it.
  
  **The unchanged deploy image was republished, and a guard now stops the next one.** #2076's
  changeset listed `@cat-factory/deploy-harness` while nothing in that package moved, and its version
  IS the deploy image tag. Release #2077 consumed that changeset before the correction could land, so
  `cat-factory-deploy` went 0.2.15 to 0.2.16 with only a CHANGELOG and a version field behind it, and
  every pin rolled to a tag naming a byte-identical image. That is spent; versions do not go
  backwards, so 0.2.16 stands.
  
  What is fixable is the recurrence. `scripts/check-image-harness-changesets.mjs` refuses a changeset
  that versions an image harness when nothing that goes into that image changed on the branch. It is
  the exact converse of `check-runner-image-tag.mjs`, which asks whether a source change bumped the
  tag; neither direction implies the other, and both are silent when violated. The incident replays
  as its first fixture.
  
  Two claims in the previous release's changelog entry are wrong and are corrected here rather than
  rewritten there, since that entry is published history: Stryker 10's only breaking change was not
  the Node 20 drop, and `@cloudflare/workers-types` settles at an exact `5.20260815.1` rather than the
  `^5.20260823.1` that entry names.

## 0.6.23

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
  - @cat-factory/sdk@0.46.0
  - @cat-factory/gatekeeper-bindings@0.28.0

## 0.6.22

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
  - @cat-factory/gatekeeper-bindings@0.27.1
  - @cat-factory/sdk@0.45.1

## 0.6.21

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/sdk@0.45.0
  - @cat-factory/gatekeeper-bindings@0.27.0

## 0.6.20

### Patch Changes

- Updated dependencies [302e05a]
  - @cat-factory/sdk@0.44.0
  - @cat-factory/gatekeeper-bindings@0.26.0

## 0.6.19

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/sdk@0.43.0
  - @cat-factory/gatekeeper-bindings@0.25.0

## 0.6.18

### Patch Changes

- Updated dependencies [0ef48d1]
  - @cat-factory/sdk@0.42.0
  - @cat-factory/gatekeeper-bindings@0.24.0

## 0.6.17

### Patch Changes

- d5c1f1c: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.64`,
  `@ai-sdk/openai@4.0.41`, `@ai-sdk/amazon-bedrock@5.0.55`). The Cloudflare toolchain moves
  together again: `wrangler@4.122.0` and `@cloudflare/vitest-pool-workers@0.21.2`, whose bundled
  wrangler tracks it. `@aws-sdk/client-s3` goes to 3.1109.0 and the SPA's store engine to
  `pinia@4.0.3` / `@pinia/nuxt@1.0.2`.

  `capnweb` moves 0.10.0 to 0.11.0 in the Gatekeeper Worker. The release is additive (stubs as
  stream chunks, exact ArrayBuffer/DataView serialization, URL over RPC) and touches neither
  `RpcTarget` nor `newWorkersRpcResponse`, the only two symbols we import. Its 0.11.1 patch, which
  enforces an ASCII-only dist bundle so a consumer's `btoa()` cannot choke on the runtime, missed
  the release-age window by two hours and is the first thing the next sweep should pick up.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

  - @cat-factory/sdk@0.41.0

## 0.6.16

### Patch Changes

- Updated dependencies [7312e0a]
  - @cat-factory/sdk@0.41.0
  - @cat-factory/gatekeeper-bindings@0.23.0

## 0.6.15

### Patch Changes

- 792ecde: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with (`ai@7.0.62`,
  `@ai-sdk/anthropic@4.0.38` / `openai@4.0.40` / `openai-compatible@3.0.30` /
  `amazon-bedrock@5.0.54`). The Cloudflare toolchain moves together: `wrangler@4.121.0`,
  `@cloudflare/workers-types@5.20260812.1` and `@cloudflare/vitest-pool-workers@0.21.1`, whose only
  change over 0.20.3 is the wrangler and miniflare it bundles, so the pool now carries the same
  wrangler the workspace declares instead of one release behind it.

  `esbuild` gains three scoped `pnpm-workspace.yaml` overrides pinning vite's, tsx's and nitropack's
  loose ranges to the 0.28.1 that wrangler and `@cloudflare/vitest-pool-workers` pin exactly. Without
  them a re-resolve hands vite's optional PEER slot the newer 0.28.2 and the tree gains a second
  esbuild; because pnpm resolves an auto-installed peer without its own `optionalDependencies`, that
  copy never gets its platform binary and esbuild's postinstall aborts the entire install. The
  overrides are deliberately scoped rather than top-level: `drizzle-kit`, `@intlify/bundle-utils` and
  `fontless` declare narrower ranges that a blanket pin would force them out of.

  Held back deliberately: `@changesets/cli` 3.0.0 and, in the frontend, `typescript` 7 (Nuxt 4.5.2
  itself depends on `typescript@6.0.3`). No `minimumReleaseAgeExclude` entries were added: every
  version above already satisfies the gate.

## 0.6.14

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/sdk@0.40.0
  - @cat-factory/gatekeeper-bindings@0.22.0

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
