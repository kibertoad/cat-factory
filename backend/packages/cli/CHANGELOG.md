# @cat-factory/cli

## 0.13.7

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

## 0.13.6

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

## 0.13.5

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

## 0.13.4

### Patch Changes

- 7d899c4: Stop publishing an ephemeral-environment URL nothing can serve, and make a containerized tester
  able to reach one that can.
  
  An acceptance pass deployed a healthy pod, published `http://cf-acc-pr8.127.0.0.1.nip.io`, reported
  the environment `ready`, and then spent fourteen minutes in the tester on curl code 000 before
  failing the run at forty-three minutes. Two independent faults, both of which PR #2075 named and
  left open:
  
  - **The Ingress was claimed by nothing.** It declared `ingressClassName: nginx` on a cluster
    running Traefik. The apiserver accepts that, no controller watches it, `status.loadBalancer`
    stays empty, and readiness (which was the Deployments' rollout and nothing else) still said
    `ready`. The Kubernetes provider now grades a template-derived URL against the cluster's own
    `IngressClass` catalog and reports `failed` / `config_incomplete` naming both the requested class
    and the available ones. It fails only on POSITIVE evidence that no controller can claim the
    Ingress; a missing address is `pending`, never a refusal, and a cluster that will not answer the
    cluster-scoped read passes through byte-for-byte as before. `cat-factory k3s` grants the
    `ingressclasses` read so a cluster it provisions can answer.
  - **A loopback URL is unreachable from an agent container**, whose `127.0.0.1` is its own network
    namespace. The local facade now maps the environment's host to the container's host gateway, so
    one URL means the right thing to the operator's browser and to the agent alike. A container that
    predates its environment is replaced, and a bridged job never takes a warm-pool member (a member
    is re-leased across runs, so one run's per-PR entry would leak into the next). It covers every
    environment a job is handed, not just the frame's own: a live peer service's environment for a
    cross-service test and a frontend flow's resolved backend binding fail identically without it.
    The URLs ride the dispatch OPTIONS as a declared, typed list rather than being dug back out of
    the job body, where they sit three levels down under a wire shape the harness owns.
  
    A URL naming this machine that NO bridge can re-point is reported rather than bridged: a hosts
    entry cannot displace the `127.0.0.1 localhost` line an image ships with, and it is never
    consulted for a bare IP literal. A compose environment publishes `http://localhost:<port>`, so
    bridging it bought nothing while costing every such run its warm-pool member and a container
    replacement. Those runs are pooled again, and the log now says the environment is out of the
    agent's reach instead of leaving it to be discovered as a dead cluster.
  
  Also: the acceptance suite refuses a pass up front when the cluster runs no ingress controller or
  publishes no host port into it, reusing `cat-factory k3s`' probe; its scaffold briefs tell agents to
  leave `ingressClassName` unset so the cluster's default class claims the Ingress; and the run driver
  reports step TRANSITIONS instead of only sampling `currentStep`, so a step that starts and finishes
  between two polls is still named. That last one is why this failure was misread: the `deployer`
  finished in one second against a ten-second poll, so the pass jumped from `reviewer` to
  `tester-api` and the step that published the bad URL never appeared in the log at all.
  
  Alongside them, `/api/v1` serves `skipped` on a run's steps (an additive optional field, OpenAPI
  `1.62.0`). A skipped step's `state` is `done` with no output, which is byte-for-byte a step that
  ran and produced nothing, so following a run's chain could not tell the engine deciding a step was
  unnecessary from the step happening and having nothing to say. The acceptance kit's transition
  reducer already knew how to announce the difference and could not observe it.

## 0.13.3

### Patch Changes

- c7ab5aa: Name a supervised outage the supervisor did not cause, and timestamp every `[supervise]` line.
  
  `cat-factory supervise` reported a self-healed outage as `✔ serving again (after 2 failed
  probe(s))` — a tick reading as a success, on a line with no clock. But if the stack had already
  been answering, reaching that state means something restarted it **underneath** the supervisor: a
  repair of ours resets the counters, so the only way there is for the stack to have gone down and
  come back with nothing of ours in between.
  
  That is the shape of a `node --watch` file-change storm. The watcher cycles the server several
  times in a row, the port is unbound for a few seconds, and any client mid-request dies with
  `ECONNREFUSED` — while nothing crashes, every process involved stays alive, and `/health` answers
  200 again by the time anyone looks. The stack is genuinely healthy afterwards, so the two
  probe-failure lines left behind read as noise, and the outage is indistinguishable from a flaky
  probe.
  
  The recovery is now a **warning** that says what happened, how long it lasted, and that the
  supervisor did not do it, with the likely cause spelled out on the first occurrence only (the
  warn-once rule the dependency ladder already follows), and the running total repeated in a summary
  line at shutdown — the only place those counts stay legible on a supervisor left up for days:
  
  ```text
  [supervise 11:50:53] • health probe failed (1/3)
  [supervise 11:51:03] ⚠ serving again after 19.3s down since the first failed probe, give or
                         take the 10s poll interval (2 failed probe(s)) —
                         unexplained outage #1, no repair of ours caused it
    ↳ something restarted the stack underneath the supervisor. On a `node --watch` deployment this is
      usually a file-change storm: … Check the server log for repeated "Restarting" lines with no
      error between them.
  [supervise 12:31:07] stopped after 241 probe(s): 0 repair(s), 1 unexplained outage(s)
  ```
  
  **Only a stack that had already answered can have been taken down by something else.** A recovery
  where the child has never served since it was started is our own boot binding late, and is reported
  as a slow start naming `--boot-grace` instead. Without that split, a cold boot slower than the grace
  window — and, worse, every repair whose restarted stack is, since a repair re-bases that window —
  recovers as `no repair of ours caused it`, blaming an invisible third party for a gap the supervisor
  had just created itself.
  
  Downtime is measured from the first **counted** failed probe, so a cold boot inside the grace window
  is never reported at all: the port is legitimately unbound while the workspace builds and migrations
  run. Both ends of the resulting window are quantized to the poll interval and the errors point in
  opposite directions, so the figure is the truth ± one poll rather than a floor — at the default 10s
  poll a 100ms blip and a 10s outage render identically. Every rendering therefore names the interval
  it was measured against.
  
  Every `[supervise]` line now carries local `HH:MM:SS`. These lines are read interleaved with the
  supervised server's own structured logs and are usually the only record that a transient outage
  happened at all; without a clock on them, placing the outage in time meant interpolating from
  whichever neighbouring line happened to carry one.
  
  `SuperviseState` gains `notServingSince` and `servedSinceStart`, the `recovered` action gains
  `downMs` and a `cause` the caller must branch on, and `SupervisorOutcome` gains
  `unexplainedOutages` — counted separately from `repairs` because the two have opposite meanings to
  a reader: a repair is the supervisor working, while an unexplained outage is the supervised stack
  cycling on its own. A run that ends with several of them looks healthy by every other measure.

## 0.13.2

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
- dc26bb5: Refuse an ephemeral-environment URL that resolves to the wrong network.
  
  `nip.io` and `sslip.io` answer from the leftmost four-octet run in a hostname and read `-` and `.`
  as the same separator, so a per-PR namespace ending in a separator plus digits contributes an
  address of its own and wins: `cf-env-catalog-api-5.127.0.0.1.nip.io` resolves to `5.127.0.0`. The
  platform's default namespace had exactly that shape for every pull request, and the URL was
  published unverified, so the environment rolled out, reported `ready`, and the failure first
  surfaced at the `tester` step as a connection error naming the cluster rather than the config.
  
  Every environment URL is now graded where every provider's URL is published (the sync provision,
  the async deploy-container finalize, and the status reconcile all settle on one seam beside
  `assertSafeEnvironmentUrl`), so a URL rendered inside a deploy harness or read off a live Ingress
  is checked exactly as one derived in process is. The Kubernetes provider additionally grades its
  RENDERED ingress host before it creates anything, and refuses as `config_incomplete`: the late
  check it replaces ran past the namespace, the registry pull Secret and every applied workload, and
  a failed provision records no `externalId`, so each refusal leaked a namespace nothing could
  reclaim. Grading the rendered host also sees what a parsed URL cannot, since an authority stops at
  the first `/`. The rule is `describeWildcardDnsShift` in `@cat-factory/contracts`, and every remedy
  it offers is re-graded against the rule before being printed (telling someone already using dashes
  to "write the address with dashes" was a description of their broken config, not a fix).
  
  **Behaviour change to defaults, deliberately breaking.** The default per-PR Kubernetes namespace is
  now `cf-env-<repoName>-pr<pullNumber>`, the guided `cat-factory k3s` setup writes
  `cf-env-pr{{pullNumber}}` with a `{{namespace}}.127.0.0.1.nip.io` host (a `{{branch}}` host renders
  `cat-factory/<taskId>`, whose `/` ends the hostname), and the acceptance suite defaults to
  `cf-acc-pr{{pullNumber}}`. New provisions land in differently-named namespaces than before;
  existing environments keep the namespace persisted on their record, so teardown still reclaims
  them. Without this, an operator who left the defaults alone would move from silently wrong to
  hard-failing at the deployer step with no automated fix.
  
  The acceptance `ingress-template` preflight now grades the namespace and host templates COMPOSED,
  once per repository the pass provisions, which is the only way this class of fault is visible.
  
  Corrects the belief that made the failure invisible on both sides, wherever it was still written
  down: `nip.io` does not map `<anything>.127.0.0.1.nip.io` to loopback.

## 0.13.1

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

## 0.13.0

### Minor Changes

- 302e05a: Close the gaps a third-party acceptance suite hit, and fix the 422 our own suite would have hit.

  The kit is published so a deployment can cover its OWN providers, gates and environment backends.
  The first consumer to actually do that came back with thirteen findings, and one of them is a real
  defect here: a task `description` caps at 2,000 characters, both scaffold briefs in
  `backend/internal/acceptance` measure past it (2,507 and 2,697), and scenario 01 passed them straight
  through. The platform's own acceptance pass could not create its first task, and would have found
  that out as a `422` after an operator had created two repositories and wired a workspace.

  `briefFields` now owns the branch, reading the cap from the contracts rather than restating it: over
  it the brief becomes an attached document (this surface's own documented path for spec-sized input),
  under it nothing changes at all. `MAX_TASK_DESCRIPTION_CHARS` is exported so the branch and the route
  cannot disagree.

  The rest of the kit changes are seams a consumer had to re-derive by reading our source. A
  `resource.ts` giving an external RESOURCE the record-before-you-can-observe discipline `resume.ts`
  gives runs, because a teardown needs the provider's id plus what the provision captured and neither
  can be re-derived, so a killed pass leaks a machine nothing on disk can name. `PassOptions.onSettled`,
  so a reclaim report lands INSIDE the closing words rather than after the sentence written to be read
  last. An `unknown` verdict constructor beside its two siblings, and `Prerequisite.probe`, so a check
  reaching a host that is not the deployment still gets kernel's transport classification. A
  `ConfigProblem` export. Provider-neutral evidence prose (`checkEphemeralEnvironment` claimed the
  disposer reclaimed "the namespace", which is false of every non-Kubernetes backend). The console
  password prompt as an opt-in `@cat-factory/acceptance-kit/console-credential` subpath, so the base
  package keeps no terminal code. And the `.env` MERGE half published from `@cat-factory/cli` beside
  the `renderEnvFile` it completes.

  On `/api/v1` (spec `1.57.0`, all additive): `PublicServiceProvisioning` gains a `custom` variant so a
  service pinned to a deployment's own environment backend can be declared and, more importantly, READ
  BACK (the projection dropped what it could not describe, so a pinned service and an unpinned one
  answered identically); `GET /api/v1/environments/connections` closes the write-only loop on handlers,
  reporting BOTH manifest-id fields because the engine matches a pinned service against either and each
  way of registering a handler sets only one; and `GET /api/v1/repos/{owner}/{name}/contents` reads one
  file out of a linked repository, so a caller can grade what a run committed without a second VCS
  credential. That read answers `ref: null` for a request that named none, since the branch the provider
  resolved is not something it learns and the platform's recorded default may be one it invented; `sha`
  is the handle to record. It refuses rather than answering approximately in three cases: past its own
  cap, past the PROVIDER's contents ceiling (`file_too_large` either way, which is also what stops
  GitHub's over-limit `403` reading as a revoked credential), and for bytes that are not UTF-8
  (`file_not_text`, carrying the `sha`).

  Watch for: `provisioning.type` must now be narrowed before `manifestSource` is read, since the public
  union is no longer single-member. A `custom` service patch that omits `manifestPath` CLEARS the stored
  one, which is the only way this surface can express "back to the manifest type's default".
  `RepoFileContent` gains an optional `lossy`, so a `VcsClient` implementation outside this repo should
  set it where it can tell. What was DELIBERATELY not added, and why, is
  `backend/docs/adr/0058-acceptance-kit-consumer-gaps.md`.

## 0.12.1

### Patch Changes

- 9d8fdf6: Wire a registry pull credential into per-PR Kubernetes namespaces on a local cluster.

  A per-PR namespace is created seconds before the manifests are applied, so no pull secret can be
  waiting in it, and a private package was therefore unpullable with no configuration path out. When
  the apiserver names the machine the platform runs on, a provision now writes the run's own git
  credential into the namespace as a `dockerconfigjson` Secret and attaches it to the service
  accounts the manifests run as. Nothing is configured for it; remote clusters are unchanged.

  The gate is kernel's new `isLocalMachineHost`, which the CLI's own `looksLocalCluster` composes
  too: it covers loopback plus the spellings a local kubeconfig actually contains (k3d's wildcard
  `0.0.0.0`, the Docker Desktop host aliases) and still refuses the RFC1918 space.

  Two bounds are stated rather than implied. The credential is the provision's own short-lived git
  token, so it expires about an hour later and nothing renews it: a pull after that needs a
  re-provision. And on the container-render path a kustomize overlay that declares its own namespace
  is skipped, because the namespace is resolved inside the deploy container and there is nowhere to
  place a Secret before dispatch. Both land in the provisioning log as a `registry-auth` step, as
  does every other reason no credential was wired.

  `AsyncProvisionCapability.buildProvisionJob` returns a `Promise` now, so the container-render path
  can prepare the cluster before dispatch. Only the Kubernetes adapter implements it.

## 0.12.0

### Minor Changes

- c0412e9: The acceptance suite now ADOPTS two repositories the operator created instead of bootstrapping
  them, and ships a `configure` command that assembles its `.env`.

  Bootstrapping was the one prerequisite no configuration could satisfy: a PAT connection reports
  `canCreateRepos: false` for every workspace and the App creation path is org-scoped, so on the
  deployment shape the suite's own README offers first, spec 01 could not run at all. It now backs a
  board service with each named repository (`POST /api/v1/services` already takes a `repoId`) and
  scaffolds both through `pl_build` from the same briefs, which also makes an interrupted scaffold
  resume the way an interrupted feature run does. `vcs-connection` stops asking for repository
  creation, `target-repos` gates on both repositories being visible AND adoptable, and a new
  `model-preset` check joins the pinned preset against the model catalog so an undispatchable preset
  is named as one rather than found at the first dispatch. Every task the suite files pins
  `ACCEPTANCE_MODEL_PRESET`, so a pass runs on the model it says it ran on.

  Adoptable is the stricter half of that gate, and it reads `linkedElsewhere` rather than only
  `serviceId`: a whole-repo service homed on another board of the account has no id a
  workspace-scoped surface can return, so the repository row answers `serviceId: null` with the flag
  set, and `POST /api/v1/services` refuses it. An existing link on this board is compared against the
  LEDGER's own service ids, so a resumed pass holding one of the two services cannot silently adopt a
  colleague's other one. The two repository blockers, a monorepo and a foreign home, are refused
  identically by the gate and by the adopt itself.

  `pnpm --filter @cat-factory/acceptance run configure` resolves what the deployment and the
  kubeconfig already know (workspace, connected account, preset library, apiserver, ServiceAccount
  token), asks for the API token and the two repository names, and opens each repository's creation
  page prefilled. It never overwrites a value without naming it and prints neither token.

  `@cat-factory/cli` gains four exports (`readApiServerCommand`, `readTokenCommand`, `decodeToken`,
  `normalizeApiServerUrl`) so the new command asks a kubeconfig the same questions `cat-factory k3s`
  does, and normalises the answer the same way: k3d writes the undialable wildcard bind address
  `https://0.0.0.0:6443` into a kubeconfig, so the read and its rewrite travel together.

  Internal break, as pre-1.0 internals may: a ledger from an earlier pass is not read for its
  `bootstrapJobs`, so a pass interrupted mid-bootstrap under the old shape starts fresh rather than
  re-attaching to a job.

## 0.11.0

### Minor Changes

- 9b3473a: `cat-factory k3s` no longer promises an ingress-derived environment URL it has not established, and
  can recreate a local cluster.

  An ingress-template URL needs two things: an ingress controller inside the cluster, and a host port
  published into it. The command assumed both. It published no host port when creating a k3d cluster
  (k3d forwards only the ports asked for at create time), created kind clusters with neither the port
  mapping nor an ingress controller, and checked nothing at all when reusing an existing cluster. The
  printed summary and the SPA connect-form deep link then named `{{branch}}.127.0.0.1.nip.io` as
  wired. Provisioning still succeeded, because environment readiness is workload readiness, so the
  failure surfaced later at the `tester` step against a URL that answered nothing.

  Now: a create publishes the port (`--ingress-port`, default 80), and every path probes both halves
  and reports one of three outcomes (verified, verified-missing with the fix, or could-not-tell). An
  unestablished ingress withholds the host-template prefill rather than filling the form with a
  promise, and the summary says what is missing and how to get it. Where the cluster is one the CLI
  can name, the port half is settled against the container runtime's own port table, so a host port
  answered by something other than the cluster is reported as the gap it is instead of as ready.

  New `--recreate`: destroy a named k3d/kind cluster and build it again from the current flags, which
  is the only way to change a published host port. It names what is on the cluster before deleting it,
  only ever targets a k3d/kind cluster the CLI can name, and is never selected for you (`--yes` alone
  cannot pick it). `--recreate --runtime k3s` is refused: k3s is a host service, not a cluster this
  command can delete and build again.

  The `ingressTemplate` environment URL source gains an optional `port`, on `/api/v1` (OpenAPI
  `info.version` 1.42.0, so the four SDK clients gain the field) and on the internal handler config
  alike. Additive, and existing configs are unaffected. A non-default host port needs its own carrier
  because the rendered `hostTemplate` is also the Ingress `spec.rules[].host` a service's manifests
  declare, and Kubernetes rejects a `host` with a port in it: folding the port into the template gave
  the right URL and an invalid manifest. Both connect forms gain the field beside the host template.

  Breaking for anyone scripting the CLI hand-off: the deep link now carries `scheme=http` (a local
  ingress controller's TLS is self-signed) plus `ingressPort` for a non-default port, and omits
  `hostTemplate` when the ingress was not verified. `buildK3sHandler` now returns `null` for a
  connection whose ingress was not established (there is no honest `url` block to register), and
  `buildK3sSetupUrl` takes the resolved connection rather than a built handler plus a verification
  flag.

## 0.10.5

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

## 0.10.4

### Patch Changes

- 25c66fe: Open the full URL in the browser on Windows.

  Every link the CLI opens for you carries more than one query parameter, and on Windows all of them
  went through `cmd /c start` with the URL unquoted. cmd splits an unquoted command line on `&`, so
  the browser received only the parameters before the first one and cmd tried to run each remaining
  parameter as a command. `cat-factory k3s` therefore landed on a bare `?infraSetup=local-k3s`: the
  Local k3s connect form opened empty, with none of the apiserver URL, namespace template or ingress
  host template the deep link exists to prefill. The pre-scoped PAT creation links lost their scopes
  the same way.

## 0.10.3

### Patch Changes

- 57a7ecd: Report what actually went wrong when a connection test fails.

  Every "Test connection" button rendered the thrown error's `message`, which on Node is undici's
  generic `fetch failed` wrapper; the real failure hangs off the cause chain. A stopped k3s cluster,
  an untrusted certificate, an unresolvable host and a firewalled port all read identically. A new
  kernel helper flattens the chain into the exact failure and adds a remedy for each cause it
  recognises, wired into the Kubernetes environment + runner probes, the shared HTTP probe behind the
  manifest environment/runner-pool providers, the Cloudflare preview probe, and the Compose probe. An
  unrecognised failure is still reported verbatim, with no hint.

  The failure CLASS also rides the wire as `ConnectionTestResult.failureCause` (a new optional field,
  with the vocabulary in `@cat-factory/contracts`), so the connect forms state what failed in the
  operator's own language and keep the backend's English account, which names the concrete host and
  the remedy, as the detail beneath it.

  A pasted ServiceAccount token is also checked on the field now: a token copied across a wrapped
  terminal line carries a newline that no HTTP header can hold, and it previously surfaced as an
  opaque request failure minutes later. The impossible case blocks Test and Save and is refused by
  the apiserver client; a still-base64 `.data.token` value or a non-JWT shape is an overrulable
  warning, since an apiserver using static bearer tokens accepts arbitrary strings.

  The `cat-factory k3s` deep link now scrolls the Infrastructure window to the Kubernetes section
  instead of opening at the top of the tab, and the CLI no longer lists the ServiceAccount among the
  values to type into a form that has no such field.

## 0.10.2

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

## 0.10.1

### Patch Changes

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

## 0.10.0

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

## 0.9.1

### Patch Changes

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

## 0.9.0

### Minor Changes

- 8c55ed4: Add `cat-factory supervise` — a self-healing watchdog for local dev, and make it the default `dev`
  script for `deploy/local`.

  The failure it fixes is a silent one. Every local deployment runs under `node --watch`, which
  **parks on crash**: it restarts the entry only on a file change, never on a process exit. A laptop
  sleep is the usual trigger — on resume the Postgres connection is gone, the server dies in
  `migrate`, and the watcher settles at "Waiting for file changes before restarting". Nothing is left
  bound to the port, but the wrapper PID is alive and the ready banner scrolled past long ago, so the
  stack _looks_ running. The SPA surfaces it only as a generic "can't reach backend", and it stays
  that way indefinitely, because the one event that would restart it (a file change) is the one event
  that isn't coming.

  `supervise` wraps a dev command and probes the signal that actually distinguishes those states —
  the port is listening **and** `/health` answers 200. Both halves are load-bearing: a parked watcher
  leaves nothing bound, while a server that booted but lost its DB pool still holds the socket and
  fails only the HTTP check. On sustained failure it re-establishes dependencies and restarts the
  child; `--compose-service postgres` brings the database back (the example compose files set no
  restart policy, so anything that stops the container engine leaves it down) and waits for healthy,
  since relaunching against a still-initialising database just crashes again. `--k3s-cluster` does
  the same for a stopped k3d/kind cluster, so a resume doesn't leave the Local k3s environment handler
  aimed at a dead apiserver.

  Two design points worth reviewing:

  **Resume detection outranks the failure threshold.** Timers don't fire while a host is suspended, so
  a tick arriving three poll intervals late means wall-clock time jumped. That triggers an immediate
  repair rather than accumulating the usual three failed probes, and it deliberately overrides an
  active boot-grace window too — a resume is precisely when the stack is most likely already dead, and
  deferring costs another `failureThreshold * pollMs` of downtime to re-learn what we can already tell.

  **A hopeless repair is reported, not retried.** Two cases qualify. A cluster whose restart is blocked
  by a stale cgroup (`runc create failed: … cgroup.procs: device or resource busy` — a state a suspend
  can leave behind) cannot be repaired from inside a supervisor: clearing it requires restarting the
  container _engine_, which would kill every other container, including the database this same
  supervisor depends on. So that case throws `OperatorActionRequiredError`, whose message is printed
  **once** with the actual fix. And a supervised command that never reaches a serving state is capped at
  `maxFailedStarts` restarts, then reported with a non-zero exit — restarting cannot fix a command that
  is simply broken, and any successful probe resets the count so a long-lived stack is never capped.
  Looping on either would reproduce the exact pathology this command exists to end: during the incident
  that motivated this work, a k3d load balancer restarted 518 times against a missing upstream, exiting
  **0** each time, so `docker ps` showed motion and the cluster sat dead for 36 hours.

  **Shutdown belongs to the loop, because the loop owns the child handle.** A signal handler outside it
  can only reach the port, which on POSIX kills the inner listener while leaving the package-manager
  wrapper and its parked `node --watch` alive — a Ctrl-C that orphans exactly the tree this command
  manages. So `SIGINT`/`SIGTERM` abort an `AbortSignal` the loop is sleeping on, and it kills the child
  tree and reaps the port on its way out.

  Two things the design refuses to do quietly. `--runtime k3s` alongside `--k3s-cluster` is **rejected**
  rather than silently supervised as k3d (which would leave the dependency reporting "not ready, will
  retry" forever, with nothing naming the real cause), and a missing `lsof` — absent by default on many
  Linux images — is **announced**, because it silently turns the port reaper into a no-op and brings
  back the `EADDRINUSE` restart loop it exists to prevent. Reaping by port means SIGKILLing a process we
  were never handed, so every kill names the pid and the command behind it.

  The judgement is kept pure in `supervise.ts` (state + observation → next state + action) so every
  transition is table-tested without processes, sockets, or an ambient clock; effects live behind
  seams in `supervise-runtime.ts` and reach the host through the existing `HostShell`, so the cluster
  logic is driven by a scripted fake shell rather than a real cluster. Cluster readiness is judged
  from the apiserver's own version — `kubectl` still prints the client half when the control plane is
  down, which is the shape that would fool a naive exit-code or first-line check.

  `HostShell.run` gains a `cwd`, which the compose dependency passes on every call: compose resolves its
  project file relative to the working directory, so without it `--compose-dir` addressed no project at
  all and reported a permanently un-ready database rather than restoring one.

  Two timing details are load-bearing and both were wrong in a way that only shows up on the path this
  command is FOR. The clock-jump measurement is taken tick-start to tick-start, and `lastTickAt` is
  re-based when a child restarts: a repair runs the whole dependency ladder first, whose budgets are 90s
  (compose) and 120s (apiserver) against a 30s jump threshold, so measuring across it made a
  slow-but-successful recovery read as a suspend — and since resume detection outranks the boot grace,
  the supervisor killed the child it had just started.

  `deploy/local`'s `dev` script is now the supervised one and the bare `node --watch` moves to
  `dev:raw`. The safe path should be the one you get by default; the escape hatch exists because a
  watchdog that restarts the process destroys the parked state you need when you are debugging a
  crash. Note `predev` now also builds `@cat-factory/cli`, so running `pnpm dev` directly inside
  `deploy/local` (bypassing Turbo's `^build`) still resolves the `cat-factory` bin.

## 0.8.6

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

<!-- archived-releases -->

Older releases: [`CHANGELOG-ARCHIVE.md`](./CHANGELOG-ARCHIVE.md).
