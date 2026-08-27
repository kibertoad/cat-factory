# @cat-factory/gatekeeper-worker

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

## 0.6.13

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/sdk@0.39.0
  - @cat-factory/gatekeeper-bindings@0.21.0

## 0.6.12

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/sdk@0.38.0
  - @cat-factory/gatekeeper-bindings@0.20.0

## 0.6.11

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/sdk@0.37.0
  - @cat-factory/gatekeeper-bindings@0.19.0

## 0.6.10

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/sdk@0.36.1
  - @cat-factory/gatekeeper-bindings@0.18.1

## 0.6.9

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/sdk@0.36.0
  - @cat-factory/gatekeeper-bindings@0.18.0

## 0.6.8

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/sdk@0.35.0
  - @cat-factory/gatekeeper-bindings@0.17.0

## 0.6.7

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/sdk@0.34.0
  - @cat-factory/gatekeeper-bindings@0.16.0

## 0.6.6

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/sdk@0.33.0
  - @cat-factory/gatekeeper-bindings@0.15.0

## 0.6.5

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/sdk@0.32.0
  - @cat-factory/gatekeeper-bindings@0.14.0

## 0.6.4

### Patch Changes

- Updated dependencies [2428b6b]
  - @cat-factory/gatekeeper-bindings@0.13.0
  - @cat-factory/sdk@0.31.0

## 0.6.3

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/sdk@0.30.1
  - @cat-factory/gatekeeper-bindings@0.12.1

## 0.6.2

### Patch Changes

- 6fcd58e: Drive this Worker's object model with a real Cloudflare OS, and fix what that found.

  **A deployment must set the `allow_irrevocable_stub_storage` compatibility flag.** `createAccount()`
  hands the workspace a stub it PERSISTS, and workerd refuses to store a stub whose target Worker has
  not opted in, so without the flag a perfectly bound, perfectly configured Gatekeeper is discovered
  and then fails on the first account anyone connects. `deploy/gatekeeper/wrangler.toml` now carries
  it, and a deployment that copied the template earlier has to add it by hand. It is not something
  `GET /health` can report, because a Worker cannot read its own compatibility flags; every gatekeeper
  in the Cloudflare OS repository carries it for the same reason, and a `/rpc`-only deployment pays
  nothing for it.

  The leg that found it is `test/os-live/`, run nightly against a pinned partner commit
  (`GATEKEEPER_OS_REF`) in a workflow of its own, so a change on their side can never block a merge
  here. Cloudflare OS's own integration toolkit boots the real `workshop-backend` beside this Worker
  under wrangler's test harness, which is the only thing that can exercise the three seams a hermetic
  suite structurally cannot: the entrypoint NAMES the workspace resolves and never asks this package
  about, the stubs handed over (the persisted account, and a Durable Object class only the workspace's
  machinery can instantiate), and the transcribed protocol in `src/os/protocol.ts`, where a shape that
  has fallen behind still compiles here and fails there. Nothing about the Worker is re-composed for
  it: the harness boots `test/wrangler.jsonc`, the same file the other two suites use, which is why
  that file is now JSONC rather than TOML.

  No behaviour change in the package itself. The transcribed protocol was diffed against the published
  source and is accurate; the three places it is narrower than the contract are now named at the top of
  the file, so the next reader making that comparison does not re-derive it.

## 0.6.1

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/sdk@0.30.0
  - @cat-factory/gatekeeper-bindings@0.12.0

## 0.6.0

### Minor Changes

- 131474a: Push approval cards and run events to a Cloudflare OS workspace through the contract's hook
  lifecycle, verify a share instead of refusing it, and check a call's arguments against what the
  operation declares.

  Sessions gain `approvals_subscribe(callback)`, `runs_subscribe(callback)` and `hooks_bound()`. A
  bind hands the workspace a `CatFactoryHookController` (a fifth named export the deployment's entry
  module must carry) and stores nothing until the workspace enables it; each delivery then asks for a
  fresh callback and is authorized as an observation before it is pushed. A hook is an accelerator
  over `approvals_list()` and `runs_watched()`, which stay the truth: the live half of a registration
  is a stub and cannot be stored, so a push that finds none counts a `missed` on the record rather
  than passing over it, and `hooks_bound()` publishes that beside `live`.

  A registration is identified by WHERE its deliveries land rather than by the id one bind minted, so
  re-binding after an eviction (the documented remedy for a hook gone quiet) re-arms the same hook
  and carries its counters over instead of leaving a dead row behind for good. The fan-out runs
  behind the delivery's acknowledgement with a deadline per push, so a workspace that hangs cannot
  spend the platform's retry budget on a write that already committed. Each push reports an outcome
  that is folded onto the record as it stands afterwards, because a push awaits a call into another
  Worker and the durable object's input gate is open across it. And a terminal run event pushes the
  cards it SETTLED alongside the run itself, so a card-subscribed gadget stops showing decisions
  nobody can answer.

  `addObserver` now admits a share when the observer's own account tier reaches everything the bound
  tier reaches and masks no more, and refuses while the bound tier can read a telemetry sink. The
  observer must hold an account this deployment minted, checked before any tier is resolved: an
  unknown id resolves to the auto-provisioned tier, which is the tier nearly every account here
  holds, so a viewer connected to another vendor would otherwise measure up as identical to the
  owner. The `/rpc` door serves no hooks (it has no approval queue to register one with) and says so.

  Three behaviour changes to know about. `GET /health` answers a new `os.limitations` array beside
  `os.blockers`, carrying what a workspace could install and would find missing: a deployment that
  does not export `CatFactoryHookController` stays discoverable and refuses hooks. An argument an
  operation does not declare is now a refusal on both doors rather than a value dropped on the way
  through, which is a break for any caller that was sending one; the refusal names what the operation
  does take. And the `/webhook` 202 reports what it DISPATCHED (`hooks: { pushes, topics }`) rather
  than what it delivered, because the fan-out no longer runs in front of the acknowledgement and a
  count of pushes nobody has made yet is indistinguishable from a push every hook refused; the
  per-hook counts are on `hooks_bound()`, where they always were.

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/sdk@0.29.0
  - @cat-factory/gatekeeper-bindings@0.11.0

## 0.5.0

### Minor Changes

- 875daf7: Serve the Cloudflare OS object model, with the workspace's approval queue in front of every call.

  `@cat-factory/gatekeeper-worker` gains four factories a deployment exports under the names the
  workspace resolves: `GatekeeperVendor` (the entrypoint a `GATEKEEPER_*` service binding targets),
  `CatFactoryAccount`, `CatFactoryResource` and `CatFactoryVerifier`. A resource is the paired
  cat-factory workspace, named by a URLPattern over the deployment origin, because the provisioning
  key this Worker holds is scoped to one. On that path each read is authorized before it is MADE (a
  refused observation means the upstream call never happened, which matters most for the reads that
  serve captured agent text) and each write is submitted and performed only when the workspace
  applies it; the tier policy stays the floor underneath. A session owns the queue it was opened
  with: disposing it releases the queue and refuses every action it left undecided, so a resource
  object holds pending work for live sessions only. `/rpc` and the admin routes are unchanged and
  still bearer-gated.

  `GET /health` gains an `os` section reporting whether a Cloudflare OS deployment could discover and
  install this Worker: `{ ok: true, os: { discoverable, blockers } }`, where a blocker is a missing
  object-model export or a policy naming no `autoProvisionedTier`. It is reported rather than folded
  into the status, because a Gatekeeper serving `/rpc` and nothing else is a supported deployment and
  its monitors must not go red on a version bump.

  `@cat-factory/gatekeeper-bindings` gains `SESSION_METHOD_SIGNATURES` (generated, one TypeScript
  method signature per operation) and `renderSessionTypes`, which composes the `.d.ts` a granted
  session serves.

  Policy files gain `autoProvisionedTier`, and a deployment that wants Cloudflare OS discovery must
  set it. It does not inherit from `defaultTier`: a workspace mints accounts with no identity, so no
  account can match a `grants` entry, and sharing one knob would mean turning discovery on also
  widened the `/rpc` door. Existing policies are unaffected and keep working with discovery off.

### Patch Changes

- Updated dependencies [875daf7]
  - @cat-factory/gatekeeper-bindings@0.10.0

## 0.4.3

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
  - @cat-factory/gatekeeper-bindings@0.9.1
  - @cat-factory/sdk@0.28.1

## 0.4.2

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/sdk@0.28.0
  - @cat-factory/gatekeeper-bindings@0.9.0

## 0.4.1

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/sdk@0.27.0
  - @cat-factory/gatekeeper-bindings@0.8.0

## 0.4.0

### Minor Changes

- 11f9efa: Public API (`/api/v1`, spec 1.32.0): the two cost and telemetry reads that were reachable only
  from a browser session. Both additive.

  `GET /api/v1/usage/spend` groups a board's spend over a window (`24h` / `7d` / `30d` / `90d`) by
  one dimension: `repo`, `ticket` and `run` are the cost-attribution axes an organisation budgets
  against, and `model` / `agentKind` / `service` / `taskType` slice the same money the other ways.
  `GET /api/v1/usage` answers the budget question and structurally cannot answer this one, since the
  ledger row it aggregates carries no board shape and its window is the current calendar month. The
  long windows are served from the durable `spend_days` rollup, which froze each run's attribution
  while the money was being spent, so a quarterly figure does not move when a service is re-pointed
  at a new repository. `source` and `rolledUpThrough` say which store answered and how far its sweep
  has covered, because a rollup that has never run and a board that spent nothing produce the same
  empty breakdown. There is no `workspace` dimension and no account-wide scope: a workspace-scoped
  key must never learn a sibling board's spend. `rows` is the heaviest `limit` slices (default 100,
  ceiling 500) with `truncated` beside it, because `run` and `ticket` grow with activity rather than
  with a catalog; `totals` aggregates the whole window either way, so a capped answer still reports
  what the board spent and loses only the identity of the tail.

  `GET /api/v1/debug/runs/:runId/llm-export` serves a run's model activity as one self-describing
  bundle, the external counterpart of the app's own export button, for a caller assembling the same
  picture from the overview plus a walk of the call list. It differs from the app's export in the
  half that matters: the rollups are SQL aggregates over every recorded call and do not move with
  `limit`, so a bundle budgeted down to a handful of rows still states what the run actually cost,
  where the internal export folds its numbers from the rows it holds and stops pricing them once
  they are a slice. `truncated` and `order` say that the call rows are a window and which end was
  kept, and `available` says whether the deployment retains LLM telemetry at all, since an unwired
  sink and a run that made no model calls otherwise produce the same document and this one is
  composed to be handed straight to a model.

  The SDK emitters gained the notion of a REQUIRED query parameter, which nothing on the surface had
  until now: the TypeScript client no longer defaults such a query bag to `{}` (a signature promising
  a call the deployment refuses), Python emits it with no default, Go and Java say so on the field
  rather than documenting it as optional, and Java withholds both the no-query call overload and the
  record's empty `none()` factory for such an operation, offering `Query.of(<required>)` instead.
  The MCP and gatekeeper facades refuse a missing required query parameter locally, naming it, the
  way a missing path parameter already was: the reference MCP server forwards a host's arguments
  without validating them against the tool's own input schema, so nothing else was catching it.

  `@cat-factory/gatekeeper-bindings` (breaking, pre-1.0): a binding's `queryParams` is now
  `{ name, required }` records rather than bare names, so a credential-holding front-end can refuse
  what the deployment would refuse instead of forwarding it to collect a 400. Bindings that read
  captured run telemetry carry `telemetrySink`, and the new `TELEMETRY_BINDINGS` export is that list,
  derived from the table. It is what a policy should withhold captured model prompts, tool arguments
  and command output with: all of it sits inside a `read` key's floor, and the hand-typed deny list
  it replaces had already fallen behind the surface, leaving the run LLM export readable by an
  oversight tier that denied every sibling read of the same sink. Generation now fails on a `/debug`
  operation that is not classified either way.

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/sdk@0.26.0
  - @cat-factory/gatekeeper-bindings@0.7.0

## 0.3.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/sdk@0.25.0
  - @cat-factory/gatekeeper-bindings@0.6.0

## 0.3.0

### Minor Changes

- e1e868d: Answer `GET /health` from the whole configuration, not the two bindings the request path happens
  to read

  The documentation sweep on this package claimed `/health` reported "whether the configuration and
  policy compile". It did not. The route returned `{ ok: true }` after assembling a `Gatekeeper`,
  and assembly reads exactly `CAT_FACTORY_BASE_URL`, `PROVISIONING_KEY` and the `STATE` namespace.
  A deployment that never set `WEBHOOK_SECRET`, `OS_SHARED_TOKEN`, `PUBLIC_URL` or `WEBHOOK_ID`
  answered 200 there while `/rpc` refused every call with a 503 and the receiver verified no
  delivery. That is the one answer a health route must never give: a monitor keyed on it agrees the
  deployment is fine.

  The fix was to make the code true rather than to narrow the sentence. `/health` now runs before
  the assembly, checks every binding in one pass, and is green only when the policy also compiles.
  The check is derived from `GatekeeperEnv` through an exhaustive `Record`, so a binding added to
  the interface fails to compile until it says how it is supplied: a binding this check silently
  passed over is a binding whose absence reads as a healthy Gatekeeper.

  One pass rather than the first name the path tripped on, because the operator this serves is
  wiring a deployment: naming one unset binding per redeploy fixes a half-wired Worker one restart
  at a time. Each name now carries the mechanism it actually takes, which the old refusal left
  ambiguous ("set it in wrangler.toml (a var) or with `wrangler secret put` (a credential)") and
  which both READMEs had got wrong in the same direction, telling operators that the secrets live
  in `wrangler.toml`. `wrangler secret put PROVISIONING_KEY` is the whole difference between an
  admin API key in a secret store and one in a git history, so the vars/secrets split is now stated
  once in code and cited by the docs rather than restated by each.

  Behaviour change to watch for: an existing monitor pointed at `/health` on a deployment that was
  never fully wired flips from green to a 503 naming what is unset. That is the report, not a
  regression.

## 0.2.0

### Minor Changes

- ca2a8e3: First release of the Cloudflare OS Gatekeeper machinery as an installable library: the Cap'n Web
  capability surface compiled from `@cat-factory/gatekeeper-bindings`, per-actor API-key minting, the
  verified outbound-webhook receiver and the approval inbox that answers every park a run stops on.

  A deployment supplies only its policy, through `createGatekeeperWorker({ policy })`, and gets the
  policy vocabulary from the runtime-free `@cat-factory/gatekeeper-worker/policy` entry point.
  `deploy/gatekeeper` is the template that installs it; it was previously a copy of all of the above.

  `@cloudflare/workers-types` is a required peer dependency: every type this package publishes is
  stated in terms of the Worker globals, so a consumer without them cannot compile against it.
