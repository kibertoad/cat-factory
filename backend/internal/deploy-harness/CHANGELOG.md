# @cat-factory/deploy-harness

## 0.6.3

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

## 0.6.1

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

## 0.5.1

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

## 0.4.0

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

## 0.2.16

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

## 0.2.15

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

## 0.2.13

### Patch Changes

- 3036af7: Rebuild both per-run container images: the shared `node:26-trixie-slim` base moves to the current
  index digest, and the executor image's three bundled agent CLIs move to Pi 0.84.1, Claude Code
  2.1.226 and Codex 0.147.0. The Pi todo/web-tools extensions are already on their newest release
  (2.4.0), so they stay put.

  Both image tags are bumped in this change (`cat-factory-executor:1.105.0`,
  `cat-factory-deploy:0.2.12`): republishing over a live tag does not roll a deployment out.

## 0.2.11

### Patch Changes

- 7cf3e70: Refresh the dependency tree and re-roll both runner images.

  **Registry deps** (direct ranges plus a full lockfile re-resolution, so transitives move to the newest
  release each declared range already admits):

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.47 → ^7.0.51`,
    `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.27 → ^4.0.29`, `@ai-sdk/openai-compatible@^3.0.20 → ^3.0.22`,
    `@ai-sdk/provider@^4.0.4 → ^4.0.5`, `@ai-sdk/amazon-bedrock@^5.0.40 → ^5.0.42`.
  - **Runtime deps**: `hono@^4.12.33 → ^4.13.0`, `@hono/node-server@^2.0.12 → ^2.1.0`,
    `pg-boss@^12.26.4 → ^12.27.0`, `undici@^8.9.0 → ^8.10.0`, `ws@^8.21.1 → ^8.21.2`,
    `@aws-sdk/client-s3@^3.1101.0 → ^3.1102.0`, `nuxt@^4.5.0 → ^4.5.1`.
  - **Tooling**: `oxlint@^1.76.0 → ^1.77.0`, `oxfmt@^0.61.0 → ^0.62.0`, `publint@^0.3.22 → ^0.3.23`,
    `vitest@^4.1.8 → ^4.1.10`, `@cloudflare/workers-types@^5.20260801.1 → ^5.20260804.1`.

  **Runner images** (`@cat-factory/executor-harness` 1.92.1, `@cat-factory/deploy-harness` 0.2.10, with
  all six pinned tags synced):

  - Executor: Claude Code `2.1.220 → 2.1.221`, and the two lockstep Pi extensions
    `rpiv-todo`/`rpiv-web-tools` `2.3.1 → 2.4.0`. Pi stays at `0.83.0` and Codex at `0.146.0`, both
    already the latest. Claude Code `2.1.222` exists but was published inside the release-age window, so
    `2.1.221` is the newest version the supply-chain rule admits.
  - Deploy: `kubectl v1.36.3`, `helm v4.2.3` and `kustomize v5.8.1` are all already the latest, so the
    image moves only for the base re-pin below.
  - Both: the `node:26-trixie-slim` base re-pinned to the current multi-arch index digest.

  No `minimumReleaseAgeExclude` entries were added: every version above already satisfies the gate.

  **Majors**: none were available this sweep except `typescript@6 → 7` for the frontend, which stays on 6
  for the same reason as last time. `vue-tsc@3.3.9` still resolves its compiler through
  `require.resolve('typescript/lib/tsc')`, and TypeScript 7's `exports` map publishes no such entry, so
  the frontend typecheck would fail to resolve at all.

## 0.2.8

### Patch Changes

- bc77cac: Bump the container-harness build toolchains to TypeScript 7.

  The executor-harness and deploy-harness were the last packages still building on
  TypeScript 6 (`^6.0.3`), and their Docker build stages compiled `dist/` with an even
  older standalone `typescript@^5.6.0` / `@types/node@^22.0.0`. Both are now aligned with
  the rest of the monorepo: the package `devDependency` moves to `7.0.2` and each
  Dockerfile build stage to `typescript@^7.0.0` / `@types/node@^26.0.0` (matching the
  runtime `node:26` base), so the published images are actually compiled on TS 7 rather
  than only local dev. The other harness deps (`hono`, `@hono/node-server`, `@types/node`,
  `vitest`) were already on the repo-consistent latest ranges.

  Editing the harness `package.json` + `Dockerfile` re-tags the runner images, so
  `@cat-factory/executor-harness` bumps 1.43.6 -> 1.43.7, `@cat-factory/deploy-harness`
  0.2.6 -> 0.2.7, and all six image-tag pins are synced to match: the
  `deploy/backend/{package.json,wrangler.toml}` refs plus `RECOMMENDED_HARNESS_IMAGE` and
  `RECOMMENDED_DEPLOY_IMAGE` in `@cat-factory/local-server`. The lockfile was also deduped
  to drop redundant duplicate entries.

## 0.2.5

### Patch Changes

- 9577c4a: Fix a batch of native-mode (`LOCAL_NATIVE_AGENTS`) agent-harness bugs:

  - The harnesses (executor + deploy) now shut down gracefully on SIGTERM/SIGINT:
    every running job is aborted (`JobRegistry.abortAll`) so in-flight `claude`/
    `codex`/git/kubectl children are killed instead of being orphaned. Previously a
    dev-server restart left the agent CLI running unsupervised on the developer's
    login. The abort now targets the child's whole process group (POSIX), so the
    CLI's own grandchildren (a shell tool, a build, its git) die with it rather than
    reparenting to init. Shutdown exits as soon as the aborted jobs settle (capped at
    6s) instead of always waiting the fixed window. Both harness servers also honor a
    new `HARNESS_BIND_HOST` env, which the native transport sets to `127.0.0.1` so the
    unsandboxed agent-spawning API is no longer reachable from the LAN (containers keep
    binding all interfaces).
  - The native host-process transport sanitizes the harness child's environment to an
    allow-list (`LOCAL_HARNESS_ENV_ALLOW` extends it), so the orchestrator's secrets
    (DATABASE_URL, ENCRYPTION_KEY, GITHUB_PAT, provider keys) no longer leak into the
    ambient agent's env; the inline ambient CLI runner is sanitized the same way. The
    allow-list keeps the TLS trust-anchor vars (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, ...)
    alongside the proxy vars, so a corporate TLS-terminating proxy still works. The
    deploy transport keeps full inheritance (kubectl/helm need ambient cluster env).
  - Process-lifecycle fixes in `LocalProcessRunnerTransport`: a harness that never
    becomes healthy is killed instead of leaking one process per retry, and
    `shutdown()` racing an in-flight lazy start now kills the child instead of
    resurrecting it. The local/Node graceful-shutdown path now invokes the
    container's `onShutdown`, which stops the native harnesses; that call is isolated
    in its own try so a failing pg-boss/pool teardown can't skip it.
  - `NativeRoutingRunnerTransport` no longer reports a blanket eviction for refs it
    doesn't know: after an orchestrator restart both `poll` and `release` fall back to
    the container leg (which re-finds a per-run container by label), so a still-running
    container job is re-attached / torn down instead of spuriously re-driven or leaked.
  - Config typos are no longer silent: unrecognized `LOCAL_NATIVE_AGENTS` tokens and
    an unrecognized/under-configured `LOCAL_DEPLOY_RUNTIME` now log a boot warning
    (behavior still fails safe).

## 0.2.3

### Patch Changes

- 858799e: Per-service provision types (Phase 2, slice 8): the `KubernetesEnvironmentProvider` render
  path. The provider now implements the `asyncProvision` capability — it builds a
  container-backed deploy job (real `kubectl`/`kustomize`/`helm`) for any config the in-Worker
  REST path can't handle, and maps the harness outcome back into a `ProvisionedEnvironment`.

  - `buildProvisionJob` returns a `deploy`-kind job (`image: 'deploy'`) when the source needs
    rendering (`renderer: 'kustomize'`) or declares helm releases / image overrides / secret
    injections, and `null` (use the synchronous REST `provision()` path) for plain raw
    manifests. Every template is rendered and every `secretRef` is resolved backend-side, so
    the job body the harness receives carries concrete values only.
  - `finalizeProvision` maps the harness's `DeployOutcome` (namespace / url / status) onto a
    `ProvisionedEnvironment`; a failed job becomes a `failed` environment carrying the error.
  - The native REST `status()` path gained the Gateway-API URL resolvers — `gatewayStatus`
    (prefer a concrete listener hostname over the assigned address) and `httpRouteStatus` (the
    route's own hostname, else the parent Gateway's address read in the parentRef's namespace)
    — so a kustomize/Gateway env resolves its URL on ongoing status polls. REST teardown/status
    are otherwise unchanged.
  - Contracts: a `kubernetesProvisionConfigSchema` (the combined cluster + URL + manifest source
    config PLUS the render inputs) is what the deploy adapter consumes; `EnvironmentConnectionService`
    merges the service's render inputs (image overrides, per-environment helm releases, secret
    injections) with the workspace engine config (shared helm releases) at provision time.
  - Kernel: `DeployCloneTarget` + `DeployProvisionInputs` (the clone coordinates + git token + job
    ref the stateless provider can't derive itself) on `ProvisionEnvironmentRequest`, supplied by
    the provisioning service before dispatch.
  - Deploy harness: when per-PR isolation is NOT requested, the harness now reads the namespace the
    built manifests actually declare (an overlay's own `namespace:`) and ensures / monitors /
    reports / tears down THAT namespace instead of the backend's per-PR default — so an
    overlay-pinned (shared) namespace no longer leaves an empty namespace behind with no URL and a
    wrong-target teardown. Image tag bumped to `0.2.2`.
  - A new optional `rolloutTimeoutSeconds` on the kube engine config is forwarded to the deploy
    job (the harness's per-Deployment rollout wait); `buildDeployJobSpec` now fails fast when the
    cluster `apiToken` secret is unset instead of dispatching an unauthenticated job. Same-named
    shared/per-env helm releases are merged by name (service overrides engine — no double install).

  The async deployer lifecycle (dispatch/poll/park) and facade wiring follow in slices 9–10, so
  nothing dispatches a deploy job yet; this slice adds + unit-tests the provider methods.

## 0.2.1

### Patch Changes

- 65768ce: Add a k3d integration suite for the deploy harness that drives `handleDeploy` against a real
  Kubernetes apiserver with the real kubectl/kustomize CLIs: clone → namespace → secret
  injection (a `Secret` and a kustomize `generatorEnvFile` content-hash rewrite) → kustomize
  image/namespace edits → `kubectl apply` → rollout → URL discovery, plus the slow-rollout
  (`provisioning`) and invalid-manifest failure/redaction paths and the `POST /jobs` + `GET
/jobs/{id}` server contract. It reuses the existing `test-k8s` job's k3d cluster + `K8S_IT_*`
  connection and is path-gated so it runs only when the harness changes. Test/CI only — no
  runtime/image behaviour changes.

## 0.2.0

### Minor Changes

- ee76986: New private package `@cat-factory/deploy-harness` (Phase 2, slice 7 — the deploy container
  payload). A slim container image (Node + pinned `kubectl`/`kustomize`/`helm`, no Pi, no
  Docker-in-Docker) that renders a service's Kubernetes manifests and applies them into a
  per-PR namespace — the container-backed deploy adapter the native in-Worker REST path can't
  be (kustomize `secretGenerator` content-hashing and helm rendering need real binaries).

  - Same HTTP contract as `@cat-factory/executor-harness` (`POST /jobs` + `GET /jobs/{id}` +
    the optional `x-harness-secret` gate), so the existing `RunnerTransport` drives both. The
    single dispatchable kind is `deploy`, mirroring kernel's `RunnerDispatchKind`.
  - `handleDeploy` flow: clone the manifests repo → ensure the namespace → write resolved
    secret injections (a `Secret` resource, or a `generatorEnvFile` `.env` into the overlay
    tree) → `kustomize edit set namespace`/`set image` → install `scope: 'shared'` helm
    releases → `kubectl apply -k|-f` → per-environment helm releases → `kubectl rollout
status` → discover the env URL (Gateway / HTTPRoute / Service / Ingress status). It
    returns a structured `DeployOutcome` (namespace, url, status) on the job result's `custom`
    channel for the backend to map into a `ProvisionedEnvironment`.
  - Every templated/secret value arrives ALREADY RESOLVED in the job body — the harness never
    touches the workspace secret bundle. The apiserver token + git token live only for the job
    (an ephemeral kubeconfig / git askpass) and are scrubbed from any surfaced output.

  Private (not published to npm); its multi-arch image is the deploy-time artifact and the
  package `version` is the image tag, exactly like the executor harness. The provider render
  path (slice 8), the async deployer lifecycle (slice 9), and the facade/CF-container wiring
  (slice 10) follow.
