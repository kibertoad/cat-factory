# @cat-factory/local-server

## 0.141.4

### Patch Changes

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
- Updated dependencies [82a3b94]
- Updated dependencies [82a3b94]
  - @cat-factory/executor-harness@1.139.0
  - @cat-factory/agents@0.145.0
  - @cat-factory/binary-generators@0.3.12
  - @cat-factory/orchestration@0.288.3
  - @cat-factory/server@0.306.7
  - @cat-factory/node-server@0.215.3

## 0.141.3

### Patch Changes

- 17e29df: Tell an agent what its sandbox contains instead of making every one of them find out.
  
  The dispatch used to instruct every container agent to discover its own environment ("probe for a tool before relying on it"), and every agent obeyed. In one measured run four calls out of a forty-call budget went on it twice over: an architect swept `docker kubectl helm kustomize` and then ran `docker info`, and the coder it handed off to rediscovered the same two answers thirty calls later. The harness holds all of it before the agent's first turn.
  
  Ownership now splits along what each layer can know. The backend keeps the POLICY, which is true whatever the machine contains: no cluster or container-registry credentials, an artifact this environment cannot execute is still a correct artifact, and the limit is never a finding against the work. It names no tooling at all, because it is composed before a transport is chosen and the same job body serves the harness image, a deployment's own image variant and the developer's own machine under `LOCAL_NATIVE_AGENTS`. The harness probes once per job and appends an `ENVIRONMENT INVENTORY` block with the facts.
  
  That block is three-valued, so a probe that failed renders as could-not-be-determined rather than as an absence, and it says in its last line that an unlisted tool is unknown rather than missing. The Docker DAEMON is answered by running `docker info`, never by finding the CLI: the image ships the CLI unconditionally and the rootless daemon it starts best-effort is what a run actually needs, which is why the old `command -v docker` answer was a half-truth.
  
  A daemon that is still STARTING gets the third answer rather than the absence a refused connection looks like. The entrypoint does not wait for the rootless daemon, so a job begins seconds before there is a socket and `docker info` is refused immediately; stating that as "no Docker daemon is reachable" is a prohibition, and it would have landed on machines whose daemon was up moments later. A refusal is now read against `DOCKER_HOST`, which the entrypoint sets whenever anything is meant to serve a daemon here: unset means nothing was coming and the definite absence is correct, set means one short retry and then could-not-be-determined. For the same reason the absent-tools line no longer forbids installation outright, only a system-wide install, because `pnpm` is not on the base image and is routinely the package manager the job's own repository declares.
  
  Composed at ONE point in `handleAgent`, onto the job's own system prompt, so every mode and all three agent CLIs inherit it and none carries it twice. The backend deliberately does not PROMISE the block: an image older than the backend appends none, which is why the sandbox policy keeps a conditional probe clause ("where the platform has stated what this machine holds, take that as given; where it has not, check") rather than dropping the instruction to check. Dropped outright, it read correctly only against a fresh image, and one version behind is the normal state of running a deployment.
  
  Two smaller prompt changes ride along. Every container dispatch now names a tool preference (file tools for file work, the shell for running things), because the models stopped reaching for their file tools on their own: four runs of one task in a three-day window used the write tool zero times, against 26 to 34 times per dispatch a fortnight earlier, rewriting whole files through shell heredocs instead. It is a nudge and nothing may depend on it. And the delivery contract now asks for a commit per coherent chunk rather than leaving the timing open, which bumps the build prompt to `build@v8`: the contract already said commits are published as they are made, but the checkpoint push can only publish what exists, and one killed run had made none in six and a half minutes.
- Updated dependencies [17e29df]
  - @cat-factory/agents@0.144.0
  - @cat-factory/executor-harness@1.137.0
  - @cat-factory/binary-generators@0.3.12
  - @cat-factory/orchestration@0.288.2
  - @cat-factory/server@0.306.6
  - @cat-factory/node-server@0.215.2

## 0.141.2

### Patch Changes

- Updated dependencies [a105803]
  - @cat-factory/executor-harness@1.135.0

## 0.141.1

### Patch Changes

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
- Updated dependencies [71a39dc]
- Updated dependencies [dc12c82]
  - @cat-factory/executor-harness@1.134.0
  - @cat-factory/orchestration@0.288.1
  - @cat-factory/contracts@0.330.0
  - @cat-factory/kernel@0.321.0
  - @cat-factory/binary-generators@0.3.12
  - @cat-factory/server@0.306.5
  - @cat-factory/node-server@0.215.1
  - @cat-factory/agents@0.143.1
  - @cat-factory/gitlab@0.22.12
  - @cat-factory/integrations@0.166.12
  - @cat-factory/prompt-fragments@1.1.8

## 0.141.0

### Minor Changes

- 3ae3386: Carry a companion's unanswered findings to the next producer, stop counting a spend correction as an LLM call, and stop an exponential backoff from stalling a live run.
  
  A companion loop does not only end because the work is clean. Past its first forced round a `major` no longer holds the run, and a person may approve over a `blocker`, so the last verdict's points can be real, unanswered and on the record while the run walks straight past them. Those points now ride the reviewed step's `priorOutputs` entry and reach every later step under the artifact they are about, worded so they cannot read as already handled. Earlier rounds are excluded on purpose: each of those was answered.
  
  `llm_call_metrics` gains `spend_only`. A harness CLI costs each turn's input but leaves its output at the message-start snapshot, so the producer files the shortfall as its own row rather than inflating a measured turn. That row is real spend and is not a call, and `COUNT(*) AS calls` was counting it: one phantom call per dispatch on every subscription-harness step. Token sums are unchanged; call counts drop the row, and so do the `turns_after` windows behind the carry cost, which charged every real turn one carry too many for it.
  
  Which of the two a shortfall row is stays with the PRODUCER, on both paths: it is a spend correction when measured turns were filed beside it and the job's only call record when none were. The container harness states that on the metric (a new `spendOnly`, hence the image bump) rather than leaving the backend to infer it from `standsForJob`, which would have reported every un-narrated container run as zero calls with real spend, or from the batch it was handed, which the live drain splits across polls.
  
  All four Node drive queues now enqueue through one options builder with `retryBackoff: false`. A drive job mostly fails because the worker went away, which the next attempt succeeds at, and nothing else can shorten the delay: the stale-run sweeper reads a `retry`-state job as live and the exclusive singleton no-ops a fresh send.
  
  The default companion rework budget goes from 3 to 4, on every shipped preset including the unattended one.
  
  Opening a LOCAL `node:sqlite` store now reconciles the file's columns against the schema it was handed, adding the ones it is missing. `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so every column added to a shipped schema (`phase`, `turn_index` and now `spend_only`, all on `llm_call_metrics`) reached a fresh database and no other, and an existing file then failed both the inserts and the reads naming it: `summarizeByExecution` backs the live board rollups, so the damage was never confined to the write side. The reconciliation is additive only, and refuses to open on a column SQLite cannot add rather than serving a store that fails one query at a time. D1 and Postgres migrate as before.

### Patch Changes

- Updated dependencies [3ae3386]
  - @cat-factory/contracts@0.329.0
  - @cat-factory/kernel@0.320.0
  - @cat-factory/agents@0.143.0
  - @cat-factory/executor-harness@1.132.3
  - @cat-factory/orchestration@0.288.0
  - @cat-factory/node-server@0.215.0
  - @cat-factory/binary-generators@0.3.11
  - @cat-factory/gitlab@0.22.11
  - @cat-factory/integrations@0.166.11
  - @cat-factory/prompt-fragments@1.1.7
  - @cat-factory/server@0.306.4

## 0.140.9

### Patch Changes

- Updated dependencies [c030a23]
  - @cat-factory/kernel@0.319.1
  - @cat-factory/executor-harness@1.132.1
  - @cat-factory/orchestration@0.287.4
  - @cat-factory/server@0.306.3
  - @cat-factory/node-server@0.214.9
  - @cat-factory/agents@0.142.6
  - @cat-factory/binary-generators@0.3.10
  - @cat-factory/gitlab@0.22.10
  - @cat-factory/integrations@0.166.10
  - @cat-factory/prompt-fragments@1.1.6

## 0.140.8

### Patch Changes

- Updated dependencies [69b9ed4]
  - @cat-factory/kernel@0.319.0
  - @cat-factory/executor-harness@1.132.1
  - @cat-factory/agents@0.142.5
  - @cat-factory/binary-generators@0.3.9
  - @cat-factory/gitlab@0.22.9
  - @cat-factory/integrations@0.166.9
  - @cat-factory/orchestration@0.287.3
  - @cat-factory/prompt-fragments@1.1.5
  - @cat-factory/server@0.306.2
  - @cat-factory/node-server@0.214.8

## 0.140.7

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
- Updated dependencies [abc1af8]
  - @cat-factory/executor-harness@1.132.1
  - @cat-factory/node-server@0.214.7
  - @cat-factory/server@0.306.1

## 0.140.6

### Patch Changes

- Updated dependencies [a8f8d14]
  - @cat-factory/contracts@0.328.0
  - @cat-factory/server@0.306.0
  - @cat-factory/agents@0.142.4
  - @cat-factory/binary-generators@0.3.8
  - @cat-factory/gitlab@0.22.8
  - @cat-factory/integrations@0.166.8
  - @cat-factory/kernel@0.318.1
  - @cat-factory/orchestration@0.287.2
  - @cat-factory/prompt-fragments@1.1.4
  - @cat-factory/node-server@0.214.6
  - @cat-factory/executor-harness@1.131.0

## 0.140.5

### Patch Changes

- Updated dependencies [95f75fc]
  - @cat-factory/agents@0.142.3
  - @cat-factory/binary-generators@0.3.7
  - @cat-factory/orchestration@0.287.1
  - @cat-factory/server@0.305.1
  - @cat-factory/node-server@0.214.5
  - @cat-factory/executor-harness@1.131.0

## 0.140.4

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
  - @cat-factory/orchestration@0.287.0
  - @cat-factory/server@0.305.0
  - @cat-factory/executor-harness@1.131.0
  - @cat-factory/agents@0.142.2
  - @cat-factory/binary-generators@0.3.7
  - @cat-factory/gitlab@0.22.7
  - @cat-factory/integrations@0.166.7
  - @cat-factory/node-server@0.214.4
  - @cat-factory/prompt-fragments@1.1.3

## 0.140.3

### Patch Changes

- Updated dependencies [da77447]
  - @cat-factory/contracts@0.326.0
  - @cat-factory/server@0.304.0
  - @cat-factory/agents@0.142.1
  - @cat-factory/binary-generators@0.3.6
  - @cat-factory/gitlab@0.22.6
  - @cat-factory/integrations@0.166.6
  - @cat-factory/kernel@0.317.1
  - @cat-factory/orchestration@0.286.1
  - @cat-factory/prompt-fragments@1.1.2
  - @cat-factory/node-server@0.214.3
  - @cat-factory/executor-harness@1.129.0

## 0.140.2

### Patch Changes

- Updated dependencies [4125beb]
  - @cat-factory/contracts@0.325.0
  - @cat-factory/kernel@0.317.0
  - @cat-factory/agents@0.142.0
  - @cat-factory/orchestration@0.286.0
  - @cat-factory/server@0.303.0
  - @cat-factory/binary-generators@0.3.5
  - @cat-factory/gitlab@0.22.5
  - @cat-factory/integrations@0.166.5
  - @cat-factory/prompt-fragments@1.1.1
  - @cat-factory/node-server@0.214.2
  - @cat-factory/executor-harness@1.129.0

## 0.140.1

### Patch Changes

- Updated dependencies [1d3c115]
  - @cat-factory/prompt-fragments@1.1.0
  - @cat-factory/executor-harness@1.129.0
  - @cat-factory/agents@0.141.0
  - @cat-factory/kernel@0.316.0
  - @cat-factory/orchestration@0.285.0
  - @cat-factory/server@0.302.0
  - @cat-factory/node-server@0.214.1
  - @cat-factory/binary-generators@0.3.4
  - @cat-factory/gitlab@0.22.4
  - @cat-factory/integrations@0.166.4

## 0.140.0

### Minor Changes

- 432b4e4: Inline use cases: a deployment declares non-container model work, and `/api/v1/use-cases` publishes and runs it.

  A wrapper over the public API (an external content editor, a writing tool) can now generate through
  this deployment rather than beside it. A deployment registers named units of model work on the new
  app-owned `InlineUseCaseRegistry`, injected like every other registry
  (`start({ inlineUseCaseRegistry })`, `startLocal(...)`, the Worker override). Each registration
  NARROWS the models it may run on, declares the parameter form it accepts in the shared descriptor
  vocabulary a reusable operation's brief already uses, and states the temperature / output bounds an
  invocation may steer within.

  Three additive endpoints, surface version 1.59.0: `GET /api/v1/use-cases` (the catalog, `read`),
  `GET /api/v1/use-cases/{useCaseId}` (`read`), and
  `POST /api/v1/use-cases/{useCaseId}/invocations` (`write`), which runs one SYNCHRONOUSLY and answers
  with the text. There is no task, repository, pipeline, container or run behind it, and nothing is
  persisted: the only durable trace is the `llm_call_metrics` row, tagged with the use case's id as
  its agent kind, so an editor's spend is attributable per use case.

  Two behaviours are choices worth knowing before building against it. A model outside the use case's
  declared list, and a model this deployment cannot serve inline, are both REFUSED rather than swapped
  for another, because a narrowed list that substitutes silently is not a narrowing and the caller
  cannot see it happened; each published model carries whether it is servable and which of the two
  causes it is not. And a reply with no usable text answers `503 use_case_empty_reply` rather than a
  `200` carrying an empty string, which an editor would otherwise store as the model's answer.

  An invocation answers to the TIERED budget safeguard (workspace, account and the acting user), for
  the same reason the bug hunt's ranking does: it is a billable model call that no run start gates.
  Discovery does not: it answers on a deployment with no model provider at all, with every model marked
  unavailable, because an empty catalog and a missing surface are different facts. Both read the same
  credential scope, resolved ONCE per request: account- and user-scoped provider keys (and the acting
  user's locally-run endpoints) are in the pool, so a narrower scope would report a model this
  deployment can serve as unconfigured.

  The vendor call is bounded: a per-invocation deadline (2 minutes by default) plus one retry, because
  a synchronous endpoint holding a caller's request open owes a bound on how long. A call the vendor
  did not complete is `503 use_case_generation_failed`; one that ran out of time is `503
use_case_generation_timeout`, its own reason because the caller's move differs.

  The Java/Kotlin SDK's emitter also changes here, and it affects three existing endpoints as well as
  this one. A free-form JSON value (`parameters` on an invocation, `fields` on a task, a task-type
  field's `showWhen.equals`) was generated as an empty marker interface with no implementations, so the
  `Map<String, …>` holding it could not be constructed at all: those parameters are now
  `Map<String, Object>`, which Jackson round-trips, and the three unusable marker types are gone. The
  Go client has always emitted `json.RawMessage` for the same shape.

### Patch Changes

- Updated dependencies [432b4e4]
  - @cat-factory/contracts@0.324.0
  - @cat-factory/kernel@0.315.0
  - @cat-factory/orchestration@0.284.0
  - @cat-factory/server@0.301.0
  - @cat-factory/node-server@0.214.0
  - @cat-factory/agents@0.140.1
  - @cat-factory/binary-generators@0.3.3
  - @cat-factory/gitlab@0.22.3
  - @cat-factory/integrations@0.166.3
  - @cat-factory/prompt-fragments@1.0.92
  - @cat-factory/executor-harness@1.127.1

## 0.139.6

### Patch Changes

- Updated dependencies [9d4b0c2]
  - @cat-factory/agents@0.140.0
  - @cat-factory/server@0.300.0
  - @cat-factory/binary-generators@0.3.2
  - @cat-factory/orchestration@0.283.2
  - @cat-factory/node-server@0.213.2
  - @cat-factory/executor-harness@1.127.1

## 0.139.5

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
  - @cat-factory/agents@0.139.1
  - @cat-factory/binary-generators@0.3.2
  - @cat-factory/contracts@0.323.1
  - @cat-factory/executor-harness@1.127.1
  - @cat-factory/gitlab@0.22.2
  - @cat-factory/integrations@0.166.2
  - @cat-factory/kernel@0.314.1
  - @cat-factory/node-server@0.213.1
  - @cat-factory/orchestration@0.283.1
  - @cat-factory/prompt-fragments@1.0.91
  - @cat-factory/server@0.299.1

## 0.139.4

### Patch Changes

- Updated dependencies [72ecc7c]
  - @cat-factory/agents@0.139.0
  - @cat-factory/contracts@0.323.0
  - @cat-factory/kernel@0.314.0
  - @cat-factory/orchestration@0.283.0
  - @cat-factory/server@0.299.0
  - @cat-factory/node-server@0.213.0
  - @cat-factory/binary-generators@0.3.1
  - @cat-factory/gitlab@0.22.1
  - @cat-factory/integrations@0.166.1
  - @cat-factory/prompt-fragments@1.0.90
  - @cat-factory/executor-harness@1.126.0

## 0.139.3

### Patch Changes

- Updated dependencies [5b281a3]
  - @cat-factory/agents@0.138.0
  - @cat-factory/binary-generators@0.3.0
  - @cat-factory/contracts@0.322.0
  - @cat-factory/gitlab@0.22.0
  - @cat-factory/integrations@0.166.0
  - @cat-factory/kernel@0.313.0
  - @cat-factory/orchestration@0.282.0
  - @cat-factory/server@0.298.0
  - @cat-factory/node-server@0.212.1
  - @cat-factory/prompt-fragments@1.0.89
  - @cat-factory/executor-harness@1.126.0

## 0.139.2

### Patch Changes

- Updated dependencies [53a4c40]
  - @cat-factory/contracts@0.321.0
  - @cat-factory/kernel@0.312.0
  - @cat-factory/orchestration@0.281.0
  - @cat-factory/server@0.297.0
  - @cat-factory/node-server@0.212.0
  - @cat-factory/agents@0.137.1
  - @cat-factory/binary-generators@0.2.7
  - @cat-factory/gitlab@0.21.2
  - @cat-factory/integrations@0.165.6
  - @cat-factory/prompt-fragments@1.0.88
  - @cat-factory/executor-harness@1.126.0

## 0.139.1

### Patch Changes

- 75107ec: Clone from the GitLab instance a hosted deployment is configured for.

  `ResolveRepoOrigin` was supplied by local mode alone, so the Node and Cloudflare facades fell
  through to the `github.com` default and a GitLab-only deployment handed every agent container a
  `https://github.com/<group>/<project>.git` clone URL while gating and merging on GitLab. Both
  facades now derive the clone host and the harness's clone-credential allow-list from
  `GITLAB_API_BASE`, and local mode reads the same derivation instead of its own. The Worker's PR
  verification-report publisher and its deploy clone target join the same origin, and the local
  native transport (`LOCAL_NATIVE_AGENTS`) joins the same allow-list derivation the container
  transport already used.

  Behaviour changes to know about. A `GITLAB_API_BASE` that names no web host now fails the dispatch
  with a message naming the variable, where it previously produced a github.com clone URL; it
  likewise allow-lists no host, where local mode previously fell back to `gitlab.com`. On a mixed
  deployment (a GitHub App beside per-workspace GitLab connections) a repository the projection marks
  as living on the other provider is now refused rather than cloned from the wrong host: the dispatch
  throws naming the repository, and the environments module's block-less repo resolver reports "no VCS
  connection". A run that previously checked out a same-named GitHub project therefore stops instead.

  On a self-hosted runner pool the harness needs `GITHUB_ALLOWED_HOSTS` set to the GitLab host, since
  the pool's containers are the operator's rather than the platform's. It is now in
  `docs/environment-variables.md` and on the website's runner-pool and configuration pages.

  The environments module's block-less repo resolver also stops refusing every caller that names
  `gitlab`. It now refuses only a repository the bound client cannot read, or one whose named provider
  the repo projection disagrees with.

- Updated dependencies [75107ec]
  - @cat-factory/server@0.296.1
  - @cat-factory/node-server@0.211.1
  - @cat-factory/executor-harness@1.126.0

## 0.139.0

### Minor Changes

- 4a3af5a: Close the mothership-mode repository surface: the VCS sync + repo-write half, service CRUD, the
  mount cascade and the last per-workspace reads all go remote, and the agent-kind registry's
  CAPABILITY layer becomes org state a node reads from the mothership.

  **The surface-completion backlog is empty, and the drift guard no longer has a word for it.** Every
  org/durable repository method is now either allow-listed or carries a PERMANENT classification;
  `pending` is gone from the guard's reason vocabulary, so a new repository method must be proxied or
  justified in the same PR rather than parked. What landed: the whole VCS installation + projection
  surface (reads AND the sync/repo-write writes a node's delegated GitHub client earns), service CRUD
  (a mothership-mode node could not create a service frame at all before this), the frame-deletion
  mount cascade, the Kaizen streak write and detail read, the workspace roster reads, the profile
  edit and the sealed test-credential list.

  **Three new scope rules, one of which closes a real cross-tenant hole.** `serviceInsert` binds the
  FRAME BLOCK a service claims (admitting one that does not exist yet, since the service row is
  written first), because `getByFrameBlock` resolves by frame block id alone and a service planted on
  another org's frame redirects that org's runs at a repo the caller controls. `serviceUpdate` and
  `workspaceList` bind the account a patch would re-home a service into, and the candidate list a
  repo-linkage read answers a subset of.

  **The VCS connect/disconnect WRITES stay mothership-internal**, classified `admin` alongside the
  membership and account-lifecycle mutations. They are `integrations.manage` in the service layer, and
  a machine token scopes accounts rather than roles: a plain member of an account holds one, so no row
  binding substitutes for the role check the RPC bypasses. Neither connect path can complete on a node
  regardless (App connect needs an app-JWT call the delegating token source refuses by design; a
  GitLab PAT would be sealed under the node's own key). The id-keyed READS are remote as before.

  **`WorkspaceRepository.accountIdsOf`** is a new batched port method (chunked `IN`, both stores): the
  list-shaped scope rules bound a whole candidate list through a point read per id, which is the N+1
  this layer bans.

  **Six dead port methods are deleted rather than proxied**: the single-service `listByService` on
  five repositories (board composition has gone through the batched `listByServices` for as long as
  the allow-list has existed), `serviceRepository.getByRepo`, `githubInstallationRepository`'s
  `updateCachedToken` (nothing has written that column since the App token cache moved in-process),
  and the unused `DrizzleServiceFrameRepository`. Allow-listing a method no caller invokes buys
  attack surface for nobody.

  The deployment-level tool-server layer travels as the WHOLE declaration set (`DeclaredToolServers`),
  not only its resolved servers: an id the mothership could not resolve is a typo in the org's own
  package, and a node boot-validates nothing it reads remotely, so the dispatch warn is the only place
  it can surface. The union of the local registry and that layer is one exported helper both dispatch
  sites use (the container executor and a consensus panel's withheld-server ceiling).

  **`GET /internal/agent-kinds`** makes the deployment's agent-kind capability layer org state, the
  fourth application of the rule its three siblings established. Unlike them it MERGES with the
  node's own registry rather than replacing it: a kind's executable half (prompts as functions,
  `preOps`/`postOps`, its output parser) cannot cross a wire, so the kind CATALOG stays node-local
  exactly like task types and pipelines, and a step naming an unknown kind still fails loudly at
  admission. What crosses is `assignSkills`/`assignToolServers` (a `SKILL.md` payload, a transport
  plus a credential's NAME), whose absence on a node one build behind is silent: the agent simply
  works without the org's playbook, which reads exactly like an agent that considered the standard
  and moved on. A failed read THROWS rather than answering with an empty layer.

  **Compatibility (internal):** `githubInstallationRepository.updateCachedToken`,
  `serviceRepository.getByRepo` and the five `listByService` methods are removed from their kernel
  ports and both runtimes. Nothing in the tree called them; a deployment that implemented these ports
  itself drops the members. `WorkspaceRepository` gains a required `accountIdsOf`, so such a
  deployment implements one method.

### Patch Changes

- Updated dependencies [4a3af5a]
  - @cat-factory/kernel@0.311.0
  - @cat-factory/agents@0.137.0
  - @cat-factory/orchestration@0.280.0
  - @cat-factory/server@0.296.0
  - @cat-factory/node-server@0.211.0
  - @cat-factory/executor-harness@1.126.0
  - @cat-factory/binary-generators@0.2.6
  - @cat-factory/gitlab@0.21.1
  - @cat-factory/integrations@0.165.5
  - @cat-factory/prompt-fragments@1.0.87

## 0.138.1

### Patch Changes

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

- Updated dependencies [302e05a]
- Updated dependencies [cda15b8]
  - @cat-factory/contracts@0.320.0
  - @cat-factory/kernel@0.310.0
  - @cat-factory/server@0.295.0
  - @cat-factory/gitlab@0.21.0
  - @cat-factory/orchestration@0.279.0
  - @cat-factory/node-server@0.210.1
  - @cat-factory/agents@0.136.0
  - @cat-factory/binary-generators@0.2.5
  - @cat-factory/integrations@0.165.4
  - @cat-factory/prompt-fragments@1.0.86
  - @cat-factory/executor-harness@1.126.0

## 0.138.0

### Minor Changes

- 3afea3a: Let a foundational service declare the credentials a step authenticates to it with, resolve the
  binary-storage precondition from the step rather than the kind, record what post-processed an
  artifact, and publish the pipeline-authoring seam from every facade.

  **A foundational service registered IN CODE may declare `credentials`**, the same
  `capabilityCredentialSchema` a generative integration and an MCP tool server declare. The engine
  projects the declarations of the services a dispatch was briefed on onto
  `AgentRunContext.foundationalCredentials` (key names only), `@cat-factory/server` resolves the
  values through the facade-wired `ToolSecretResolver`, and the brief names the variable from the
  same helper the resolver keys the job body with. `ToolSecretSubject` gains
  `foundational-service`, and the credential CHECKLIST lists the new declarer beside the other two.
  Until now the platform had a credential seam for what MAKES an artifact and none for where it GOES,
  so a step could authenticate to eight vendors and then not to the service it had to store the
  result in.

  **Only the code-registered `builtin` tier may declare one.** The stored write boundary refuses a
  credential on an account or workspace row (`foundational_service_credentials_not_storable`),
  because the shipped resolver reads a declared key off the deployment's own environment: every other
  declarer on the platform is deployment code, and a foundational service is the first one a
  workspace admin can also create over REST. Per-workspace VALUES are unaffected, which is what the
  sealed capability-credential store is for.

  **Breaking, internal wire**: the job body's `generatorSecrets` is now `capabilitySecrets`, since
  two producers share the channel, and the two resolvers became one so that a variable-name conflict
  BETWEEN a generative integration and a catalog service is caught where it is visible (per job, and
  now at boot as `capability_injection_name_collision`). The runner image bumps with it; a deployment
  must roll the new tag before a credential of either kind reaches a job.

  **The `binary-storage` precondition is resolved per STEP.** A kind carrying the trait is held to
  the account's content storage only when its `binaryOutput.storageServiceId` is the platform's own
  asset service (`storesThroughPlatformAssets`, the same fact the in-container upload seam reads).
  `media-generator` on the shipped `pl_media` still demands it; the same kind repointed at an org's
  object service no longer is, where before the refusal named a settings page unrelated to anything
  the run touched. `tester-ui` makes no step-level selection and is unchanged.

  **`binaryOutputArtifact.processedBy`** records what ran over the bytes AFTER the integration
  produced them. A post-processed artifact has two producers and `generator` can name only one:
  naming the integration records a producer of something that is not what was stored, and naming
  nothing loses the vendor attribution. A free string, judged by whoever reads the run, on the same
  terms as `location`.

  **Every facade now exports the pipeline-authoring seam**: `definePipeline` (extracted from the
  built-in catalog, which is authored with it) plus `MEDIA_GENERATOR_AGENT_KIND`,
  `PLATFORM_ASSET_STORAGE_SERVICE_ID`, the two binary traits, the reserved capability tags and the
  option types. A deployment replacing a shipped preset was writing five index-aligned arrays by
  hand, and naming what its step selects meant either a copied string literal or a second dependency
  below the facade.

  **An agent kind can name its OWN container image.** The variant is a slug rather than a
  three-member union: `ui` stays the platform's browser image, and anything else is a deployment's,
  mapped by its runner backend (a Kubernetes pool's `imageVariants`, local Docker's
  `LOCAL_HARNESS_IMAGE_VARIANTS`, a Cloudflare `[[containers]]` class bound as
  `RUNNER_CONTAINER_<VARIANT>` and subclassing the newly-exported `RunContainer`). Boot refuses a
  kind naming `default` or `deploy`, or a name that is not a slug; a backend with no image for a
  variant refuses the dispatch rather than running the default, which for a deployment's own image
  would produce a job silently missing whatever it carried.

  **Bug fix**: the Kubernetes runner pool keyed its pod by run id alone, so a `tester-ui` step
  re-attached to the pod an earlier step created on the base image and ran browser work without a
  browser. It now keys by `containerKeyForRef`, like the Cloudflare and local backends.

  **The open variant name keeps its compile-time guard.** `PLATFORM_IMAGE_VARIANTS` is a literal tuple
  exporting a `PlatformImageVariant` union, `isPlatformImageVariant` narrows to it, and all three
  backends split on that predicate and then switch EXHAUSTIVELY over the platform half. Opening the
  type cost the `never` arm that used to make a new variant fail the build, and the three backends had
  respelled the platform names inline: a fourth published image would have routed into the
  deployment-owned half and been refused as unwired on the one runtime that ships it (the Kubernetes
  pool would have served it the DEFAULT image silently), with nothing failing at compile time.

  **A container key is refused if it cannot be read back** (`container_key_not_reversible`), and the
  Apple `container` adapter refuses a container NAME the same way. Recovering the run behind a key is a
  shape test, because variant names are open and the reader holds no config, so it cannot decide a run
  id whose leading segment is itself a legal variant name: it splits to a run that does not exist, and
  the orphan sweep then deletes a live container. Only the producer can compare against the ref, so
  that is where the check lives. Nothing the platform mints today can trip it; on Apple it also catches
  the name sanitiser collapsing two distinct keys onto one name.

  **A credential injection-name collision is reported ONCE, over every capability registry.** The rule
  moved to contracts (`credentialInjectionCollisions`, beside the injection-name fallback it is about)
  and boot grades it in one section. It was graded per registry as well, so a generator-vs-generator
  pair produced two problems under two codes with two remediations for one variable, while a
  service-vs-service pair was graded by neither, and the cross-registry rule needed BOTH registries
  wired to run at all.

  **Internal break**: the boot-diagnostic code `binary_generator_injection_name_collision` is retired,
  along with kernel's `binaryGeneratorInjectionCollisions`. Every collision is now
  `capability_injection_name_collision`. These are boot log diagnostics, nothing persists or parses
  them, and the message names the same variable and claimants as before.

  **A CONTEXT service's credentials are named to the agent**, in the binary-output brief's scope
  section and in its injected contract file, the way storage's already were. `briefedServiceIds`
  resolves credentials for both id sets, so a context service's value was in the job env while no
  layer named the variable holding it: a bearer-authenticated contract the agent could not call.

  **Fixes** the local facade's harness pins, which stayed at 1.124.0 while the harness went to 1.125.0
  and the job body's `generatorSecrets` became `capabilitySecrets`, so a local install on the default
  pin ran an image that ignored the field and dropped every capability credential. The tag guard now
  verifies EVERY pin location in `scripts/runner-images.mjs`, not just the two under `deploy/backend`.

  **`LOCAL_HARNESS_IMAGE_VARIANTS` names are held to the slug shape** every declaring boundary
  enforces, and a rejected entry is named in a boot warning. `Pixel-Tools=…` parsed into the map,
  matched no declaration a kind could have made, and the dispatch was then refused pointing at the
  variable the operator had already set it in.

### Patch Changes

- Updated dependencies [3afea3a]
  - @cat-factory/contracts@0.319.0
  - @cat-factory/kernel@0.309.0
  - @cat-factory/agents@0.135.0
  - @cat-factory/orchestration@0.278.0
  - @cat-factory/server@0.294.0
  - @cat-factory/node-server@0.210.0
  - @cat-factory/executor-harness@1.126.0
  - @cat-factory/binary-generators@0.2.4
  - @cat-factory/gitlab@0.20.31
  - @cat-factory/integrations@0.165.3
  - @cat-factory/prompt-fragments@1.0.85

## 0.137.0

### Minor Changes

- 3f7d8b2: Support Bifrost as an AI gateway, and make the OpenAI-compatible provider set one table both
  runtimes derive from.

  `bifrost` joins the workspace API-key pool and the model catalog (`bifrost-default`) as the second
  operator-hosted gateway beside LiteLLM: self-hosted software with no public instance, so it is
  proxyable and key-poolable but resolves only once the deployment sets `BIFROST_BASE_URL`. Until then
  its pooled key is inert and its catalog entry reads `available: false`, rather than passing the start
  guard and failing at dispatch. Its catalog default is `openai/gpt-4o`, a real id on any Bifrost whose
  OpenAI provider is configured, because Bifrost names models by their canonical `provider/model` pair
  rather than by operator-coined aliases.

  **The seam it landed through.** `OPENAI_COMPATIBLE_ENDPOINTS` (`@cat-factory/agents`
  `providers/endpoints.ts`) is now the ONE table naming every OpenAI-compatible provider and the
  endpoint it defaults to, `null` marking an operator-hosted one. Everything else is derived from it:
  the built-in base URLs, `UI_CONFIGURABLE_DIRECT_PROVIDERS`, `isProxyableProvider`, the new
  `isOpenAiCompatibleProvider` / `isOperatorHostedGateway` predicates, and the `OperatorHostedGateway`
  union that the base-URL remedy's display names are an exhaustive `Record` over. Adding a provider is
  one entry there, and the compiler finds the rest.

  **Four facade gaps that closed with it**, every one of them silent before:

  - The Node LLM-proxy upstream kept its own provider→env table, which omitted `xai`. A Pi step
    pinned to Grok-direct passed the dispatch guard (`isProxyableProvider('xai')` is true) and then
    failed as "upstream not available". That table is gone; the upstream resolves through
    `baseUrlForNode`, the same resolution the inline path takes.
  - `workers-ai` was the SAME bug from the other side: the dispatch guard is runtime-neutral and
    admits it everywhere, the catalog offers every Cloudflare model once the REST credentials are set,
    and only the Worker (which has the `AI` binding) had a route. A container step on Node died at its
    first proxy call with "Provider 'workers-ai' is not available". Node now forwards it to
    Cloudflare's own OpenAI-compatible endpoint, carrying the account token on the resolved endpoint
    because `workers-ai` owns no pooled key. The proxy prefers an in-process route and falls back to
    the forward path, reporting the provider unavailable only when neither resolves.
  - The Worker's typed env override map was a loose `Record<string, …>` and omitted `xai` too, so the
    documented `XAI_BASE_URL` was consumed by neither facade. It is now total over the shared
    `DirectProvider` union, so a provider missing from it is a type error.
  - That union is the direct providers, not just the OpenAI-compatible ones, which closes
    `ANTHROPIC_BASE_URL`: Node reads env by name and always honoured it, the Worker never declared it.
    The container proxy still refuses `anthropic` (its own SDK dialect would reject an OpenAI-shaped
    body), and refuses it by the table's predicate rather than by "did a base URL resolve", those two
    answers now differing for exactly that provider.

  **Metering**: the shipped `bifrost-default` entry routes `openai/gpt-4o`, so it is priced at that
  model's own direct rate rather than the generic gateway fallback, which would have under-counted it
  about sixteenfold against a workspace budget.

  **For operators**: `BIFROST_BASE_URL` is new (CF + Node). `XAI_BASE_URL` now actually takes effect on
  the Worker, and `ANTHROPIC_BASE_URL` on the Worker at all: a deployment that set either expecting a
  regional or proxied endpoint was silently reaching the public API and will now reach what it
  configured. Both, plus the rest of the `${VENDOR}_BASE_URL` family, are documented in
  `docs/environment-variables.md` and reserved against being named as a capability credential, which
  they were not before. `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` is now read in one place on
  Node, so a whitespace-only value counts as unset everywhere instead of enabling the picker only.

### Patch Changes

- Updated dependencies [3f7d8b2]
  - @cat-factory/agents@0.134.0
  - @cat-factory/contracts@0.318.0
  - @cat-factory/kernel@0.308.0
  - @cat-factory/server@0.293.0
  - @cat-factory/node-server@0.209.0
  - @cat-factory/binary-generators@0.2.3
  - @cat-factory/orchestration@0.277.1
  - @cat-factory/gitlab@0.20.30
  - @cat-factory/integrations@0.165.2
  - @cat-factory/prompt-fragments@1.0.84
  - @cat-factory/executor-harness@1.124.0

## 0.136.1

### Patch Changes

- 2a2b6ef: Reclaim EVERY container a run holds, and stop losing the variant on the way to the container.

  Routing a step to the UI-tester image gave a run a SECOND container, and four of the paths that
  address a run's container by name were still written for a world with exactly one.

  `AsyncAgentExecutor.stopJob` is now `reclaimRun`, taking a `RunReclaimTarget` instead of a job
  handle. It could not be fixed as it stood: the engine synthesised a handle with no `agentKind`, so
  the ref carried no image and every terminal, cancel and supersede path released the ordinary
  container and left the browser one running to its maximum lifetime. Supplying the kind would not
  have been enough either, since a run holds one container per IMAGE and that API reclaims one. The
  engine now hands over every kind the run DISPATCHED (read off the persisted `step.dispatches`, so a
  gate's helper and a replayed reclaim both count) and the executor maps them to the distinct images
  it started.

  Three more places the qualified key was mishandled. The Apple `container` adapter's name sanitiser
  folded `ui:<runId>` onto a name its own inverse read back as a run called `ui-run-1`, so the boot
  orphan sweep classed a live UI container as belonging to no run and deleted it mid-step; the
  variant now round-trips through the name, and `RunContainerSpec.runId` is renamed `containerKey`
  because reading it as a run id is what produced an encoding nothing could reverse.
  `runIdFromContainerKey` stripped ANY prefix before a colon rather than a known variant, which
  truncates a key it never produced into a run id that matches no run: the same data-destroying
  misread it exists to prevent. And the local transport's stop-escalation evicted its cache entry
  under the run id while destroying the container it had resolved under the qualified one, leaving a
  cached handle pointing at a container that no longer exists (`resolve` returns a cached entry
  without probing liveness).

  Two refusals were also less total than they read. The local transport tested only for `ui`, so a
  `deploy` ref silently ran on the agent image where the Worker names the registration mistake; it is
  now exhaustive over the variant union, with the `default:` arm routed through a helper taking
  `never` so a new variant fails the build. And the Cloudflare reaper resolved a row's container class
  BEFORE removing the row, so a `ui` row whose class is no longer bound re-threw on every sweep pass
  for ever: an unbound class is not a transient failure, so that row is dropped, counted apart from
  the kills as `unreachable`, and named once with the binding to restore.

  Watch for: `reclaimRun` replaces `stopJob` on the executor port (internal, no migration), and the
  `live_containers` sweep now returns `{ reaped, unreachable }`.

- Updated dependencies [2a2b6ef]
  - @cat-factory/kernel@0.307.0
  - @cat-factory/server@0.292.0
  - @cat-factory/orchestration@0.277.0
  - @cat-factory/integrations@0.165.1
  - @cat-factory/executor-harness@1.124.0
  - @cat-factory/agents@0.133.3
  - @cat-factory/binary-generators@0.2.2
  - @cat-factory/gitlab@0.20.29
  - @cat-factory/prompt-fragments@1.0.83
  - @cat-factory/node-server@0.208.2

## 0.136.0

### Minor Changes

- 5333319: Route a job to the UI-tester executor image, on every backend, and publish that image.

  The `image: 'ui'` dispatch variant has existed since the visual-confirmation gate landed: the
  `tester-ui` kind declares it, the executor sets it, the job body carries the screenshot-upload
  seam and the reference-design manifest that go with it. Nothing mapped it to an image. On
  Cloudflare and local Docker a browser-driven tester therefore ran on the plain executor image,
  which has no browser, and the repo published no UI image for anything to point at even if it had.

  The variant now travels on the job REF rather than only on the dispatch options, because a
  per-run container backend has to address the same container again on every poll and release, and
  those get no options. `containerKeyForRef` derives the container's identity from it (the run id,
  qualified by the variant), and the executor re-derives the variant from the step's agent kind at
  each site, so a poll from a fresh process after a durable replay lands on the right container with
  nothing remembered in between. Cloudflare gains a `UiTesterContainer` class bound as
  `UI_CONTAINER`; local Docker gains `LOCAL_HARNESS_IMAGE_UI` and a second per-run container.

  **An unwired variant is refused, not downgraded.** Every backend fails the dispatch, naming the
  binding or variable to set, where the Kubernetes pool previously fell back to its default image.
  Falling back is what the variant existed to prevent: the tester runs happily until it needs a
  browser, which is after the checkout, the install and the model's first turns, and reports an
  `abort` no reader can distinguish from an app that would not start. A deployment that has not
  wired the image loses the step, not the diagnosis, and the visual-confirmation gate still runs on
  screenshots a person uploads.

  Two things to watch. The live-container inventory carries the variant (D1 migration 0094) because
  the cron reaper kills through a Durable Object namespace and `idFromName` returns a usable stub in
  any of them: reaping a browser container through the executor class killed nothing and reported
  success. And the local orphan sweep now maps a container key back to its run before asking whether
  that run is live, or every UI container reads as belonging to no run and is swept out from under a
  run mid-step.

  The UI image is published by CI alongside the executor image it layers on, pinned to the same
  version, and is BOOTED before it is pushed: the smoketest starts a container, waits for the
  harness, then drives a real Chromium against a `serve`d page inside it. A build-only gate was not
  enough, which the corepack line this branch already fixed demonstrates: it had been unrunnable
  since the base moved to `node:26` and no build ever failed for it.

### Patch Changes

- 5333319: Move the workspace to pnpm 11.21.0 and install pnpm from the registry rather than through corepack.

  The UI-tester image staged pnpm and yarn with `corepack enable && corepack prepare …`, and that
  line cannot work any more: the base is `node:26-trixie-slim`, and Node stopped shipping corepack,
  so the `Dockerfile.ui` build failed before it reached the tooling it was staging and neither
  manager was landing in the image at all. Both now install from the registry, pnpm at 11.21.0 and
  yarn from `@yarnpkg/cli-dist@4.10.3` (yarn 4 is not published under the bare `yarn` name, which is
  what corepack was covering for). A frontend that declares a different pnpm in `packageManager`
  still gets that one, because pnpm honours the field itself.

  Corepack is gone from the two deploy images as well, where it only ever put pnpm on PATH. They now
  read the version out of the root `packageManager` field, so an image cannot install a pnpm that did
  not write the lockfile it installs from. `@pnpm/exe`, the self-contained build, was tried first and
  rejected: it links `libatomic.so.1`, which `node:24-slim` does not carry, and it would bundle a
  second Node beside the one those images already run on.

  The image tag moves to `cat-factory-executor:1.123.0` across the wrangler config, the publish
  script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
  deployment out. The deploy image is unchanged and keeps `0.2.13`.

- Updated dependencies [5333319]
- Updated dependencies [5333319]
  - @cat-factory/executor-harness@1.124.0
  - @cat-factory/kernel@0.306.0
  - @cat-factory/server@0.291.0
  - @cat-factory/integrations@0.165.0
  - @cat-factory/agents@0.133.2
  - @cat-factory/binary-generators@0.2.1
  - @cat-factory/gitlab@0.20.28
  - @cat-factory/orchestration@0.276.1
  - @cat-factory/prompt-fragments@1.0.82
  - @cat-factory/node-server@0.208.1

## 0.135.0

### Minor Changes

- 053aac8: Ship Nano Banana as the platform's first generative binary integration, and hook the built-in Media
  pipeline to it.

  `@cat-factory/binary-generators` is a new package holding the definition (Google's Gemini image
  models, with the OpenAPI contract a run's agent reads) and `defineBinaryGenerator`, the authoring
  seam a deployment writes its own integrations with. It runs the platform's OWN registration rules at
  import, now shared from kernel (`binaryGeneratorDetailIssues`, `binaryGeneratorInjectionCollisions`)
  rather than reachable only inside orchestration's boot validator.

  Every facade now defaults `binaryGeneratorRegistry` to `binaryGeneratorRegistryWithBuiltins()`, and
  the shipped `pl_media` preset selects `nano-banana`, so a Media task generates images once
  `GEMINI_API_KEY` is set as a capability credential and nothing else is configured.

  **For a deployment that injects its own `binaryGeneratorRegistry`**: an injected instance replaces
  the shipped set rather than merging with it, so `pl_media` would then select an id nothing answers
  to and its runs are refused at admission (`binary_output_generator_invalid`). Start from
  `binaryGeneratorRegistryWithBuiltins()` and register onto that instance, or edit the preset's step.

  On the **Worker**, an injected registry is now registered process-wide by `createApp`, which is what
  carries it to the entry points that take no options. A binary-output step's dispatch brief is
  composed by the durable driver, so before this a deployment's own integrations were absent from
  every brief it built while the platform's shipped one was present.

  `PLATFORM_FOUNDATIONAL_SERVICES` is a new kernel export: the frozen definitions
  `defaultFoundationalServiceRegistry()` seeds from, shared across registries rather than copied per
  one. A caller can now tell the platform's own service from a deployment's replacement of the same
  id, which is what the local facade's mothership boot warnings need. Both of them (the estate and the
  generative integrations) report only what the deployment registered, and report a shipped id a
  deployment REPLACED, which subtracting by id could not see.

### Patch Changes

- Updated dependencies [053aac8]
  - @cat-factory/binary-generators@0.2.0
  - @cat-factory/contracts@0.317.0
  - @cat-factory/kernel@0.305.0
  - @cat-factory/orchestration@0.276.0
  - @cat-factory/node-server@0.208.0
  - @cat-factory/agents@0.133.1
  - @cat-factory/gitlab@0.20.27
  - @cat-factory/integrations@0.164.1
  - @cat-factory/prompt-fragments@1.0.81
  - @cat-factory/server@0.290.1
  - @cat-factory/executor-harness@1.122.0

## 0.134.0

### Minor Changes

- eb5fa75: Add a built-in `media` task type, so generating images (or 3D models, audio, video) is a thing a
  fresh deployment can do rather than a feature it has to build.

  The binary-output machinery already did the hard part: a generating step selects its integrations
  and its content types, an admission pass refuses a selection that cannot deliver them, a
  comparison parks the run so a person keeps the renders worth keeping, and the step's report
  records where every artifact went. All of it was reachable only by a deployment that first
  registered an agent kind, an object store as a foundational service with an OpenAPI document, and
  a pipeline. This ships the defaults: a `media` task type and pipeline purpose, a `media-generator`
  agent kind, a `pl_media` preset with a working selection, and a storage target that exists
  everywhere.

  That target is the platform's own asset storage, registered as the ONE service
  `defaultFoundationalServiceRegistry()` now holds (it returned an empty registry before). Its
  bytes land in the account's binary-artifact store, which a local deployment defaults to the
  filesystem, so an unconfigured laptop runs the whole flow; a deployment with no content storage
  at all is refused up front by the `binary-storage` precondition rather than at the end of a paid
  generation. A deployment that stores assets in its own bucket registers its own service and
  tombstones this one, exactly as it can any other `builtin`.

  Because the platform holds those bytes, it can serve them back: a stored artifact renders in the
  comparison window before the choice and in the step's report after it, with links to open it and
  to save a copy elsewhere. Whether a row renders as a picture is decided from the media type the
  SERVER served the bytes as, not from the optional one the producing agent declared, so an
  undeclared image still previews and a mislabelled bundle still reads as a file.

  Artifacts stored this way are a new `asset` artifact kind and are EXEMPT from the age-based
  retention sweep, which is sized for a run's screenshots and is the wrong clock for the thing the
  run was started to produce. The exemption is why the ingest API also takes an asset BACK: a
  candidate pass stages several files per subject and a person keeps one, and with nothing
  reclaiming an asset on a clock, the rejected renders would accumulate for the life of the
  workspace. `DELETE` on a location reclaims what the same run stored, idempotently.

  `pl_media` is also the first shipped pipeline whose step parks on a binary-candidate comparison,
  which public-API admission could not see: its four park checks read the step CHAIN, and a
  comparison lives in a step's OPTIONS. So a plain `write` key was admitted to start a run that then
  parked on a surface `/api/v1` cannot answer. `parkSurfacesOf` gains that fifth mechanism. Note the
  narrowing: a deployment that authored its own binary-output step with `comparison` and started it
  with a `write` key now gets `pipeline_requires_decide_scope` instead. That is the same disposition
  the human-wait gate and the interview gate each shipped with, and the behaviour it replaces is a
  run that hangs with nothing able to answer it.

  Four things to watch for. `GET /api/v1/runs/{runId}/artifacts` gains an `asset` member in its kind
  enum (public API 1.56.0, additive): a caller pairing screenshots against reference designs must
  filter it out rather than treat it as an unmatched capture. The foundational-services catalog is
  no longer empty by default, so a surface or test that assumed an unregistered deployment resolves
  zero services now sees one. And a single stored asset is capped at 24 MiB, sized by the Worker
  isolate's memory ceiling rather than by preference: the artifact store port takes bytes, so an
  ingest holds two full copies of the file at peak, and raising the cap needs the port and every
  blob backend behind it to take a stream.

### Patch Changes

- Updated dependencies [eb5fa75]
- Updated dependencies [9d8fdf6]
  - @cat-factory/contracts@0.316.0
  - @cat-factory/kernel@0.304.0
  - @cat-factory/agents@0.133.0
  - @cat-factory/orchestration@0.275.0
  - @cat-factory/server@0.290.0
  - @cat-factory/node-server@0.207.0
  - @cat-factory/integrations@0.164.0
  - @cat-factory/gitlab@0.20.26
  - @cat-factory/prompt-fragments@1.0.80
  - @cat-factory/executor-harness@1.122.0

## 0.133.3

### Patch Changes

- Updated dependencies [eb740be]
  - @cat-factory/contracts@0.315.0
  - @cat-factory/kernel@0.303.0
  - @cat-factory/server@0.289.0
  - @cat-factory/orchestration@0.274.0
  - @cat-factory/node-server@0.206.0
  - @cat-factory/agents@0.132.1
  - @cat-factory/gitlab@0.20.25
  - @cat-factory/integrations@0.163.1
  - @cat-factory/prompt-fragments@1.0.79
  - @cat-factory/executor-harness@1.122.0

## 0.133.2

### Patch Changes

- Updated dependencies [7f990ea]
  - @cat-factory/contracts@0.314.0
  - @cat-factory/kernel@0.302.0
  - @cat-factory/integrations@0.163.0
  - @cat-factory/agents@0.132.0
  - @cat-factory/orchestration@0.273.0
  - @cat-factory/server@0.288.0
  - @cat-factory/gitlab@0.20.24
  - @cat-factory/prompt-fragments@1.0.78
  - @cat-factory/node-server@0.205.8
  - @cat-factory/executor-harness@1.122.0

## 0.133.1

### Patch Changes

- Updated dependencies [409238f]
  - @cat-factory/kernel@0.301.0
  - @cat-factory/contracts@0.313.0
  - @cat-factory/agents@0.131.0
  - @cat-factory/executor-harness@1.122.0
  - @cat-factory/gitlab@0.20.23
  - @cat-factory/integrations@0.162.1
  - @cat-factory/orchestration@0.272.1
  - @cat-factory/prompt-fragments@1.0.77
  - @cat-factory/server@0.287.1
  - @cat-factory/node-server@0.205.7

## 0.133.0

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
  - @cat-factory/executor-harness@1.122.0
  - @cat-factory/kernel@0.300.0
  - @cat-factory/contracts@0.312.0
  - @cat-factory/orchestration@0.272.0
  - @cat-factory/integrations@0.162.0
  - @cat-factory/server@0.287.0
  - @cat-factory/agents@0.130.2
  - @cat-factory/gitlab@0.20.22
  - @cat-factory/prompt-fragments@1.0.76
  - @cat-factory/node-server@0.205.6

## 0.132.5

### Patch Changes

- d5c1f1c: Rebuild the executor image on Claude Code 2.1.231. Pi (0.84.1), Codex (0.147.0) and the Pi
  todo/web-tools extensions (2.4.0) are already on their newest release, and `node:26-trixie-slim`
  still resolves to the digest the image is pinned to, so Claude Code is again the only moving part.

  This pin is taken at Claude Code's newest release rather than the newest one 24h past publication:
  it ships several times a week and the harness tracks it closely, so holding it a day behind
  routinely means shipping a known-fixed bug. The exemption covers this ARG alone, is re-made
  explicitly on each bump, and does not extend to Pi, Codex or any workspace dependency, which stay
  under the `minimumReleaseAge` gate. The Dockerfile says so beside the pin.

  The image tag moves to `cat-factory-executor:1.119.0` across the wrangler config, the publish
  script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
  deployment out. The deploy image is unchanged and keeps `0.2.13`.

- Updated dependencies [d5c1f1c]
- Updated dependencies [c67e924]
- Updated dependencies [d5c1f1c]
  - @cat-factory/agents@0.130.1
  - @cat-factory/integrations@0.161.0
  - @cat-factory/kernel@0.299.1
  - @cat-factory/orchestration@0.271.1
  - @cat-factory/contracts@0.311.0
  - @cat-factory/server@0.286.0
  - @cat-factory/executor-harness@1.120.0
  - @cat-factory/node-server@0.205.5
  - @cat-factory/gitlab@0.20.21
  - @cat-factory/prompt-fragments@1.0.75

## 0.132.4

### Patch Changes

- Updated dependencies [056e18d]
  - @cat-factory/contracts@0.310.0
  - @cat-factory/kernel@0.299.0
  - @cat-factory/agents@0.130.0
  - @cat-factory/orchestration@0.271.0
  - @cat-factory/server@0.285.0
  - @cat-factory/gitlab@0.20.20
  - @cat-factory/integrations@0.160.17
  - @cat-factory/prompt-fragments@1.0.74
  - @cat-factory/node-server@0.205.4
  - @cat-factory/executor-harness@1.118.0

## 0.132.3

### Patch Changes

- Updated dependencies [a81879b]
  - @cat-factory/contracts@0.309.0
  - @cat-factory/kernel@0.298.2
  - @cat-factory/agents@0.129.2
  - @cat-factory/gitlab@0.20.19
  - @cat-factory/integrations@0.160.16
  - @cat-factory/orchestration@0.270.2
  - @cat-factory/prompt-fragments@1.0.73
  - @cat-factory/server@0.284.2
  - @cat-factory/node-server@0.205.3
  - @cat-factory/executor-harness@1.118.0

## 0.132.2

### Patch Changes

- 0e1e0fa: Record what a subscription run actually spent, snapshot an inline agent's context, and stop a
  companion loop that has stopped converging.

  Five defects a Kaizen grading surfaced, of which the grader itself correctly diagnosed one.

  **Per-call output tokens were lost on every harness-served call.** Claude Code's `stream-json`
  `assistant` envelopes carry the message-START usage snapshot: the input and cache counts are final,
  `output_tokens` is the handful produced when the message opened, and `stop_reason` is null. The
  reconciliation against the terminal cumulative total was the intended rescue but guarded on whether
  ANY tokens had been reported, which the input side always satisfies, so it stood down and the output
  side stayed at the snapshot. Measured on a real board: a `coder` step recorded 198 output tokens
  against the 14,033 its terminal event reported, an `initiative-analyst` 531 against 30,471, with the
  input side matching exactly (which is what hid it). The shortfall is now computed PER SIDE, and it is
  filed as its OWN row standing for the job rather than added to the last captured turn: a turn grown
  by thousands of tokens it did not produce is a derived number that reads as a measured one on every
  surface showing per-call figures. It is also reconciled against the PARENT loop's calls alone, which
  matters in `ambientAuth` mode, where the CLI streams subagent turns onto the parent's stdout with no
  transcript watcher to own them: those turns were both hiding the shortfall and, being last,
  attracting it. Cost accounting was never affected; per-call telemetry, the observability panel,
  `/api/v1/debug/*` and the step rollups were.

  **A finish reason nobody reported is no longer recorded as `stop`.** Both subscription CLIs expose
  none, and three sites defaulted to `stop` anyway, which asserts the very thing a truncation check
  tries to disprove and made `finishReason === 'length'` unfireable on that whole path. Absent is now
  carried as absent, end to end — including through the AI SDK boundary, whose closed union has no
  "unknown" member, so its `other` placeholder with no vendor string behind it is read back as the
  absence it stands for rather than as a classification.

  **Inline agent kinds recorded no context snapshot at all.** `agent_context_snapshots` had exactly one
  producer, the container executor, so every companion and inline document kind was missing from it.
  The inline executor now files one through the same recorder, on both facades, and the dependency is a
  required key with a nullable value so a facade that forgets it fails to typecheck rather than
  silently recording nothing. The inline SERVICES that call `generateText` directly (the judges, the
  requirements reviewer, Kaizen's own grader) still file none; that is named in the code and the docs
  instead of being implied closed.

  **The Kaizen grader was fed two misleading figures**, and spent two of its six recommendations on
  defects that did not exist. Its digest summed `promptTokens` alone, which is FRESH input by
  definition, reporting 16 where the real input was 332,552; and it rendered a null finish reason as
  `unknown` beside a flat "Truncated calls: 0". It now reports the three input classes, and a
  truncation count carries the number of calls that actually reported a reason on the same line, so a
  "0" measured over one call in eight cannot read as a clean step. Its "no snapshot captured" line also
  stopped guessing a cause, having blamed a switch that was enabled.

  **A companion rework loop now stops when it stops making progress.** `attempts < maxAttempts` bounds
  how long a loop may run and says nothing about whether it is converging: a run re-graded an unchanged
  document to the same 0.76 four times, burning its whole budget. When the producer returns the text it
  was asked to revise AND the rating does not move, the loop stops early and takes the same
  iteration-cap exit, so an attended run parks for a person and an unattended one settles by policy.
  The rule reads a step's reply as its work, so it applies only to producers whose deliverable IS that
  reply: a `coder` pushes commits and may legitimately answer with nothing, which is why its reviewer
  reads the real diff, and a rework a human asked for is excluded too (it spends none of the automatic
  budget). The step records `stalled` beside `exceeded`, since only one of them means the remaining
  rounds were abandoned, and the park says which one it is instead of claiming a limit was hit.

- Updated dependencies [0e1e0fa]
  - @cat-factory/executor-harness@1.118.0
  - @cat-factory/orchestration@0.270.1
  - @cat-factory/contracts@0.308.1
  - @cat-factory/agents@0.129.1
  - @cat-factory/kernel@0.298.1
  - @cat-factory/node-server@0.205.2
  - @cat-factory/server@0.284.1
  - @cat-factory/gitlab@0.20.18
  - @cat-factory/integrations@0.160.15
  - @cat-factory/prompt-fragments@1.0.72

## 0.132.1

### Patch Changes

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

- Updated dependencies [7312e0a]
  - @cat-factory/executor-harness@1.116.0
  - @cat-factory/kernel@0.298.0
  - @cat-factory/contracts@0.308.0
  - @cat-factory/orchestration@0.270.0
  - @cat-factory/agents@0.129.0
  - @cat-factory/server@0.284.0
  - @cat-factory/gitlab@0.20.17
  - @cat-factory/integrations@0.160.14
  - @cat-factory/prompt-fragments@1.0.71
  - @cat-factory/node-server@0.205.1

## 0.132.0

### Minor Changes

- 95408c2: A companion's automatic rework budget is now a risk-policy field instead of a constant in the engine.

  Every other automatic loop reads its ceiling off the task's policy: the CI fixer (`ciMaxAttempts`),
  the iterative requirements review (`maxRequirementIterations`), the Tester's quality gate
  (`maxTesterQualityIterations`), a judge's bounces (`judgeMaxBounces`), the post-release-health watch.
  The companion loop, which has the widest reach of them (every `reviewer`, `architect-companion`,
  `spec-companion` and any pair a deployment registers) and is the one an operator actually watches
  spend container dispatches, was pinned at 3 by `DEFAULT_COMPANION_MAX_ATTEMPTS` with no way to state
  otherwise. `companionMaxReworks` closes that, on both policy tiers (account and workspace) and in the
  policy editor beside the requirement-iteration budget.

  `0` is a real posture rather than a disabled loop: the companion still grades and still writes its
  verdict, and the first verdict below the bar goes straight to the iteration-cap park (or to
  `proceed`, on a policy whose `autonomy` is `unattended`) instead of buying a round. A verdict at or
  above the bar advances, comments and all. That last part is the one place this number changed an
  existing rule rather than parameterising it: a companion's FIRST batch of comments loops the producer
  back whatever it scored, and that rule now asks whether there is a round to spend before it fires.
  Left alone, `0` would have parked every companion step, since a review with nothing at all to say is
  the rare one.

  A step is seeded with the catalog default at run start, where no policy is resolved, so the resolved
  value is adopted onto `step.companion.maxAttempts` at the companion's first grading, the same way the
  Tester's quality budget is adopted on its first report. That read happens once per step, keyed on the
  step having recorded no verdict yet: a human granting an extra round at the cap does it by raising
  that same field (and the grant charges the round immediately), so a later read would report a ceiling
  the step no longer has. Keyed on the attempt count instead, it also fired a second time after a human
  "request changes" on a gated companion, which re-runs the producer while deliberately charging no
  round.

  No behaviour changes by default. The column default and all three built-in seeds carry the 3 the
  engine held, so a stored policy and a freshly seeded one are byte-for-byte identical and no seed
  needed a version bump. The field stays off `/api/v1`, where the risk-policy projection deliberately
  publishes only what decides whether a run can land without a person.

### Patch Changes

- Updated dependencies [95408c2]
  - @cat-factory/contracts@0.307.0
  - @cat-factory/kernel@0.297.0
  - @cat-factory/orchestration@0.269.0
  - @cat-factory/node-server@0.205.0
  - @cat-factory/agents@0.128.2
  - @cat-factory/gitlab@0.20.16
  - @cat-factory/integrations@0.160.13
  - @cat-factory/prompt-fragments@1.0.70
  - @cat-factory/server@0.283.2
  - @cat-factory/executor-harness@1.114.0

## 0.131.2

### Patch Changes

- 792ecde: Rebuild the executor image on Claude Code 2.1.229. Pi (0.84.1), Codex (0.147.0) and the Pi
  todo/web-tools extensions (2.4.0) are already on their newest release, and the shared
  `node:26-trixie-slim` base still resolves to the digest the image is pinned to, so Claude Code is
  the only moving part.

  The image tag is bumped to `cat-factory-executor:1.113.0` across the wrangler config, the publish
  script and `RECOMMENDED_HARNESS_IMAGE`, since republishing over a live tag does not roll a
  deployment out. The deploy image is unchanged and keeps `0.2.13`.

- Updated dependencies [792ecde]
- Updated dependencies [792ecde]
  - @cat-factory/agents@0.128.1
  - @cat-factory/integrations@0.160.12
  - @cat-factory/kernel@0.296.1
  - @cat-factory/node-server@0.204.2
  - @cat-factory/orchestration@0.268.1
  - @cat-factory/executor-harness@1.114.0
  - @cat-factory/server@0.283.1
  - @cat-factory/gitlab@0.20.15
  - @cat-factory/prompt-fragments@1.0.69

## 0.131.1

### Patch Changes

- fc9afb4: Let a binary-output step generate through the agent CLI's own tool, with no vendor API key.

  `BinaryGeneratorDefinition` gains a `transport` discriminator. `api` is the existing shape (a
  metered endpoint the agent's own code calls with an injected credential) and stays the default, so
  every registered integration is unchanged. `harness` is new: the artifact is produced by a tool
  built into the agent CLI the step dispatches under, which today means Codex's `image_gen` — a path
  available ONLY on ChatGPT subscription auth, since an `OPENAI_API_KEY` session is routed to the
  Images API and never offered the tool. A harness-transport definition may declare no `endpoint`,
  `credentials` or `contracts`; the credential rule is the one that matters, because a declared one
  would be an environment variable the deployment believes authenticates something and that nothing
  ever reads.

  Boot validation holds a harness transport to a CLI that actually generates, which today is codex
  alone. "This build runs that CLI" and "that CLI has a generation tool" are different questions, and
  admitting the first lets a definition naming `pi` or `claude-code` pass every check, dispatch with
  the tool flag set, produce nothing, and brief the agent to collect from a directory nothing created.

  Reachability becomes its own admission axis (`generator_harness_unavailable`): a step selecting a
  harness-served integration must resolve to that CLI. The requirement is DERIVED from the step's
  model by the same precedence dispatch uses — including the fall-through past an unresolvable block
  pin and the "subscriptions always win" override, without which the guard refuses a codex-served
  generator on a step that is about to run codex. An unresolved model raises nothing. Notably this is
  NOT a capability flag on the model catalog: whether the tool is offered is decided by the vendor per
  session and per plan tier, so a boolean on a model row would be a guarantee nothing here can verify.
  The pipeline builder states the constraint it cannot check (which CLI serves each candidate, and
  which the current selection needs) as advice, since a pipeline is a template and the model is chosen
  per task.

  The harness redirects codex's output into `.cat-context/binary-output/generated/` before the CLI
  starts, because codex exposes no path for what it generated and its output directory is also where
  the run's decrypted subscription credential lives. It is opt-in per job: the tool bills the leased
  plan at several times an ordinary turn. `generateImages` joins the job-body capability handshake, so
  a runner pool on an older image is refused rather than run blind against a brief that names the
  staging directory regardless. Where the capability genuinely cannot be honoured (an `ambientAuth`
  run has no per-run home to redirect, a filesystem refuses the link) the harness says so in the
  prompt instead of dropping it, and the teardown report tells a late-arriving image apart from one
  that was never reachable.

  Separately, the harness now consumes the job body's `artifactUpload` and surfaces it as
  `ARTIFACT_UPLOAD_URL` / `ARTIFACT_UPLOAD_TOKEN`. The backend has injected that field and served the
  ingest route since the visual-confirmation work while the container parsed neither, so a UI run's
  screenshots were dropped with no error anywhere.

- Updated dependencies [fc56d82]
- Updated dependencies [fc9afb4]
  - @cat-factory/orchestration@0.268.0
  - @cat-factory/contracts@0.306.0
  - @cat-factory/kernel@0.296.0
  - @cat-factory/agents@0.128.0
  - @cat-factory/server@0.283.0
  - @cat-factory/executor-harness@1.112.0
  - @cat-factory/node-server@0.204.1
  - @cat-factory/gitlab@0.20.14
  - @cat-factory/integrations@0.160.11
  - @cat-factory/prompt-fragments@1.0.68

## 0.131.0

### Minor Changes

- edd4fd0: A fourth built-in model preset, **GPT-5.6 Sol** (`mdp_chatgpt`), is seeded for every workspace
  alongside Kimi K2.7, GLM-5.2 and Claude Opus 5, so `claude | chatgpt | kimi` is finally expressible
  as a pin rather than as a note in a config file.

  It needs no new catalog route to be usable. `gpt-5.6-sol` carries an `openrouter` route and a Codex
  `subscription` route, which is the same pair `claude-opus` already had, so `effectiveVariant` lands
  on whichever the workspace holds: an OpenRouter key alone makes the preset dispatchable to a SYSTEM
  API key (a Codex subscription is per-seat and individual-only, so a system token may not spend one),
  and a connected subscription wins where there is one. Deliberately NOT a seeded default on any
  deployment shape: Cloudflare and Node still seed Kimi K2.7, local mode still seeds Claude Opus 5.
  The seed id names a VENDOR rather than a generation (`mdp_chatgpt`, not `mdp_gpt56sol`) so a built-in
  can roll its `baseModelId` forward without becoming a preset nobody selected; argued in ADR 0056.

  **An OpenAI API key is not one of those routes, and the run-start refusal now says which are.**
  `openai` is a first-class poolable provider with its own onboarding copy, so "add an API key for the
  provider" read as a `platform.openai.com` secret key, which cannot make this preset dispatchable.
  `providers_unconfigured` now names each unusable model's DECLARED routes, computed from the catalog by
  the new kernel `declaredModelRouteLabels`: `gpt-5.6-sol (needs OpenRouter or ChatGPT (Codex))`. That
  fixes the misattribution for every subscription-or-gateway-only model rather than for this one, and
  `details.models` still carries the bare ids the SPA and the four SDK clients read.

  **Model presets gained the catalog NAME channel pipelines already had.** The snapshot ships
  `modelPresetCatalogNames` beside `modelPresetCatalogVersions`, built from one `seedModelPresets()`
  read. A brand-new built-in has no stored row to take a name off, which is exactly the state the
  startup advisory offers to fix: without the map the SPA humanises the id, so every board created
  before this release would have been offered "Chatgpt" instead of GPT-5.6 Sol. A new optional field on
  the wire, so an older SPA keeps working off the humanised fallback.

  **The built-in seed is now ONE batched write.** `ModelPresetRepository.upsertMany` (mirrored D1 batch
  and Drizzle transaction, allow-listed for mothership mode) replaces a serial `upsert` per built-in on
  a path that runs at a workspace's first board load, where every shipped built-in used to add a
  round-trip. The single-default invariant is read over the batch: a promoted member demotes every row
  outside it, and each member's own flag stands as written.

  `catalog.test.ts` gains the assertion nothing else could make: every built-in's base model AND every
  per-kind override names a model `MODEL_CATALOG` actually ships. A preset's `baseModelId` is a plain
  string matched at DISPATCH, so a built-in naming a renamed or dropped model typechecks, seeds, lists
  and is selectable, then fails on the first agent step of whichever run picked it. The expectation is
  derived from the catalog rather than hand-listed, so a rename breaks a test instead of a live run. The
  conformance seeding assertion is derived the same way, and now compares the persisted rows against
  the catalog member by member and in order instead of counting them.

  The `acceptance-suite-operator-setup` initiative tracker is retired into
  [ADR 0056](https://github.com/kibertoad/cat-factory/blob/main/backend/docs/adr/0056-acceptance-suite-operator-setup.md),
  its committed scope now complete.

### Patch Changes

- Updated dependencies [edd4fd0]
  - @cat-factory/kernel@0.295.0
  - @cat-factory/contracts@0.305.0
  - @cat-factory/orchestration@0.267.0
  - @cat-factory/server@0.282.0
  - @cat-factory/node-server@0.204.0
  - @cat-factory/executor-harness@1.110.2
  - @cat-factory/agents@0.127.3
  - @cat-factory/gitlab@0.20.13
  - @cat-factory/integrations@0.160.10
  - @cat-factory/prompt-fragments@1.0.67

## 0.130.1

### Patch Changes

- Updated dependencies [36e0c9b]
  - @cat-factory/contracts@0.304.0
  - @cat-factory/orchestration@0.266.0
  - @cat-factory/server@0.281.0
  - @cat-factory/agents@0.127.2
  - @cat-factory/gitlab@0.20.12
  - @cat-factory/integrations@0.160.9
  - @cat-factory/kernel@0.294.1
  - @cat-factory/prompt-fragments@1.0.66
  - @cat-factory/node-server@0.203.1
  - @cat-factory/executor-harness@1.110.2

## 0.130.0

### Minor Changes

- 569181d: Account-scoped risk policies, inherited by every board (ADR 0055).

  A risk policy could only be authored per board, so an organisation with one merge posture had to
  copy it onto every board and keep the copies in step by hand. There is now an ACCOUNT tier: policies
  authored once for a whole account, which every board under it inherits read-only, may CLONE into its
  own library to edit, and may HIDE so no task on that board can pick it. Managed from a new "Risk
  policies" tab in Account settings; a board's own settings panel lists what it inherits above what it
  owns, plus what it is hiding.

  The board's visible library is `account ⊕ workspace` with the board's own row winning a collision,
  and one merged reader answers for the settings editor, every picker and the ENGINE, so a task can pin
  an inherited policy and the run is governed by the posture the picker offered.

  Two internal breaks, both pre-1.0 surfaces:

  - `RiskPolicyRepository` gained a read-only supertype `WorkspaceRiskPolicyReader`, and the engine,
    the two board guards and `resolveRiskPolicy` now hold that instead of the repository
    (`RunMergePolicyDeps` / `ExecutionServiceDependencies` renamed the field to `riskPolicyReader`).
  - `GET /workspaces/:ws/risk-policies` and the board snapshot answer library entries carrying `tier`.

  `GET /api/v1/risk-policies` now lists inherited policies too (an additive behaviour change: the
  response shape is unchanged, and a deployment with no account policies sees exactly what it saw
  before). Editing or deleting an inherited policy answers `409` with
  `details.reason: 'risk_policy_inherited'`; cloning or hiding a board's own policy answers
  `risk_policy_not_inherited`. `GET /workspaces/:ws/risk-policy-suppressions` answers `503`
  `risk_policy_suppressions_unwired` where the store is absent, matching its write routes rather than
  claiming the board hides nothing.

  **Needs a catfactory.ai page before release.** This adds an operator-facing capability anyone can act
  on with no checkout (author account-wide merge postures; clone or hide an inherited one from a board),
  so per ADR 0051 it owes a website page that the repo's CI cannot see. The website PR is not open yet
  and is NOT part of this change.

### Patch Changes

- Updated dependencies [569181d]
  - @cat-factory/contracts@0.303.0
  - @cat-factory/kernel@0.294.0
  - @cat-factory/orchestration@0.265.0
  - @cat-factory/server@0.280.0
  - @cat-factory/node-server@0.203.0
  - @cat-factory/agents@0.127.1
  - @cat-factory/gitlab@0.20.11
  - @cat-factory/integrations@0.160.8
  - @cat-factory/prompt-fragments@1.0.65
  - @cat-factory/executor-harness@1.110.2

## 0.129.1

### Patch Changes

- Updated dependencies [0a85a59]
  - @cat-factory/orchestration@0.264.1
  - @cat-factory/server@0.279.1
  - @cat-factory/node-server@0.202.1
  - @cat-factory/executor-harness@1.110.2

## 0.129.0

### Minor Changes

- 1a0b593: A workspace now states which PIPELINE a run resolves per intake, the way it already states which risk
  policy, and a requirements review's findings are split into the two groups that decide who answers
  them.

  Three changes, one theme: a run nobody is watching should reach a pull request without stopping for a
  person who is not coming, and should stop for one exactly where a person is what the situation needs.

  **Per-scope default pipelines.** `Pipeline.isDefault` and `Pipeline.isUnattendedDefault`, scoped by
  the same `runDefaultScopeFor(intakeOrigin)` the risk-policy default takes, written through the
  `organize` body — the one pipeline write a BUILT-IN accepts, which is what makes a shipped rung
  promotable at all. Only the UNATTENDED scope is seeded: the in-app scope already resolved an answer
  without a flagged row (the interface-mode rung, then catalog order), and seeding one would silently
  overrule the adaptive rung an advanced-mode board runs today. An operator-declared row outranks both.

  The seeded rung is a new built-in, **`pl_unattended`**. It is the adaptive shape with two deliberate
  differences: no `requirements-review`, because the rung a headless caller lands on by default cannot
  open a conversation nobody is there to have; and `human-test` plus `human-review` behind ESTIMATE
  GATES after the guards, because dropping the conversation removes the platform's chance to ask about
  scope, so the oversight is bought back where the evidence is strongest. A caller that wants the
  conversation names `pl_complex` and answers it over `/api/v1/runs/:runId/decisions` or on the ticket.

  `mp_unattended` narrows the three loop budgets its own posture makes cheap (three reviewer passes
  rather than six, two tester-QC iterations, no judge bounce): each is a cap `autonomy: 'unattended'`
  settles as "proceed", so spending it buys the run nothing but tokens. `ciMaxAttempts` is deliberately
  untouched — exhausting it raises `ci_failed`, a park this policy does not answer, so cutting it would
  produce one more stop for a person rather than one fewer. Landing authority is unchanged, and the seed
  is NOT version-bumped: existing workspaces hold a CLONE of their own default there (ADR 0053's
  migration), and a reseed would restore stock ceilings alongside the narrower budgets.

  **The two groups, shown and graded.** The reviewer already classified each finding as answerable from
  practice or needing a product decision; that is now the review window's primary grouping rather than a
  badge on one edge case, with each section saying what its group is. Every Requirement-Writer
  suggestion additionally reports a `confidence`, a different claim from `groundedIn`: that one says
  where the answer came from, this one how sure the Writer is of it (a standard can settle a finding only
  partly; a general practice can be near-universal). Shown as a band on every suggestion.

  **And a run nobody is watching may settle the first group.** Under `autonomy: 'unattended'` the gate
  folds the answers in and carries on when every finding was dismissed, resolved, answered by a person,
  or auto-answered above the policy's new `minAutoAnswerConfidence` floor (default 0.8). One finding in
  the other group, or one graded below the floor, parks the whole review exactly as before, and an
  UNGRADED suggestion clears no floor above zero — so a garbled Writer reply parks the run rather than
  quietly answering it. The step stamps `autoAnsweredByPolicy`, distinct from the existing
  `reviewCapSettledByPolicy`: that one means the loop gave up, this one that it converged on answers
  nobody read. ADR 0053 ruled this out on the grounds that inventing a product judgement is off limits;
  the narrowing that makes it compatible rather than an exception is that TWO independent judgements
  must agree before anything is folded.

  **Under `attended`, nothing about the review changes.** A suggestion there is a draft a person is
  about to read, so grading it changes nothing about who decides.

  Two `/api/v1` additions (`pipelineId` on task creation, and on `GET /pipelines` both a per-row
  `unattendedDefault` and the list-level `unattendedDefaultPipelineId` that is the one to read: the
  resolution has a rung the list cannot show, so a per-row flag alone reports `false` everywhere on a
  workspace whose empty start bodies work). OpenAPI `1.50.0`, plus one behaviour change worth reading
  before upgrading: `POST
/tasks/:taskId/start` with an empty body now STARTS a run for a key that satisfies `decide`, where it
  used to answer `400 pipeline_required`. A `write` key sees no change, deliberately — the seeded rung
  reaches a human test and a human PR review, so offering it to a caller that cannot answer a park
  would trade an actionable "pass a pipelineId" for a 403 about a pipeline it never picked. The refusal
  survives wherever no default resolves.

### Patch Changes

- Updated dependencies [1a0b593]
  - @cat-factory/contracts@0.302.0
  - @cat-factory/kernel@0.293.0
  - @cat-factory/agents@0.127.0
  - @cat-factory/orchestration@0.264.0
  - @cat-factory/server@0.279.0
  - @cat-factory/node-server@0.202.0
  - @cat-factory/gitlab@0.20.10
  - @cat-factory/integrations@0.160.7
  - @cat-factory/prompt-fragments@1.0.64
  - @cat-factory/executor-harness@1.110.2

## 0.128.2

### Patch Changes

- Updated dependencies [7d1477c]
  - @cat-factory/kernel@0.292.2
  - @cat-factory/executor-harness@1.110.2
  - @cat-factory/agents@0.126.8
  - @cat-factory/gitlab@0.20.9
  - @cat-factory/integrations@0.160.6
  - @cat-factory/orchestration@0.263.2
  - @cat-factory/prompt-fragments@1.0.63
  - @cat-factory/server@0.278.2
  - @cat-factory/node-server@0.201.2

## 0.128.1

### Patch Changes

- Updated dependencies [c09ddbe]
  - @cat-factory/agents@0.126.7
  - @cat-factory/kernel@0.292.1
  - @cat-factory/executor-harness@1.110.2
  - @cat-factory/orchestration@0.263.1
  - @cat-factory/server@0.278.1
  - @cat-factory/node-server@0.201.1
  - @cat-factory/gitlab@0.20.8
  - @cat-factory/integrations@0.160.5
  - @cat-factory/prompt-fragments@1.0.62

## 0.128.0

### Minor Changes

- fc4a1e4: A run nobody is watching now finishes instead of waiting on a person who is not coming, and a
  workspace states that posture per intake rather than once for everything.

  Four parks stopped an otherwise-autonomous run, and none of them is a checkpoint anybody asked for:
  a companion at its automatic rework cap, a JUDGE at its bounce cap, an iterative review at its
  reviewer-pass cap, and the Coder's follow-up companion holding the run while any item is undecided.
  Each is the automation reporting that it gave up, and each already offered a person a documented
  "proceed anyway". A run started over `/api/v1`, dispatched from a ticket or fired by a schedule had
  nobody to offer it to, so it waited indefinitely. The headless acceptance suite found this on
  `pl_build`, stopping on an `approval-gate` raised by `architect-companion`.

  A judge's other two parks are deliberately NOT in that set — `onFail: 'park'` is a registration
  asking for a person, and a verdict with no producing step to bounce to never got to try — so
  `disposeJudgeVerdict` now returns a machine-readable `JudgeParkReason` instead of leaving the engine
  to tell them apart by their prose. A review still ASKING questions parks under either posture too:
  the answers are a product judgement, and inventing them is the one thing an unattended policy may
  never do.

  - **`RiskPolicy.autonomy`** (`attended` | `unattended`) decides which way those three go. `attended`
    is byte-for-byte the previous behaviour and is what every existing policy, every custom one, and
    the built-in fallback get. `unattended` takes the "proceed" answer ON THE RECORD:
    `step.companion.capSettledByPolicy` and `followUpItem.dismissedByPolicy` say that policy decided,
    because the last companion verdict already says the producer was below the bar and a run that
    advanced anyway must not read like one whose companion quietly stopped grading.
  - **It never touches a park the PIPELINE asked for.** An approval gate, a `human-test` step, visual
    confirmation, the human/PR review gate, a brainstorm or interview, the fork choice and the input
    gate all stop the run under either value. A companion step that is ALSO gated still raises its
    human approval gate at the cap, because the cap settling is routed through the same pass branch a
    converged companion takes.
  - **A workspace now has TWO default policies.** `isDefault` governs a task somebody started in the
    app; the new `isUnattendedDefault` governs one nothing is watching. Which applies is
    `riskPolicyDefaultScopeFor(intakeOrigin)`, its own `Record` rather than a reuse of
    `isHeadlessIntake` — the two disagree about `schedule`, which is not headless (its reused block
    has no stable place to hold a clarification conversation) and is nonetheless unwatched.
  - **A third built-in, `mp_unattended` ("Unattended delivery")**, seeded as that default. It is
    `Balanced` with one field changed, deliberately: a seed may decide that an unwatched run should
    not wait forever on an automation budget, and may not decide that it gets to land a change an
    operator's own thresholds would have held.
  - **Pinning a task to it is a permission**, not a preference. `refuseRiskPolicySelection` gained a
    `relaxes_run_oversight` arm: `mp_unattended`'s role layer is empty, identical to `Balanced`'s, so
    without it any member could re-point a task onto the seeded policy and remove the human
    checkpoints their workspace's own default raises.
  - **Every grading loop now remembers its own rounds.** `step.companion.verdicts` recorded one verdict
    per cycle and no prompt read it, so a companion re-graded a revised document with no idea what it
    had asked for last time — the loop resampled instead of converging, and a rework budget bought
    nothing. Both sides of the loop now receive the rounds so far (`AgentRunContext.priorReview`,
    folded once in `userPromptFor`, so an inline companion, a container-backed one, a
    deployment-registered one and the producer being reworked all get it), and the 0..1 scale is
    anchored and SHARED with the judge bucket, which had carried its previous verdict all along.

  **Migration, and the one thing to check.** Both facades' migrations materialise `mp_unattended` in
  every existing workspace as a CLONE of that workspace's own default row, with `autonomy` the only
  field changed. Cloning, not seeding stock values: a built-in is editable in place, so a workspace
  that tightened its `Balanced` still holds `id = 'mp_balanced'`, and writing catalog ceilings beside
  it would hand every API-started run there a wider licence to land than its operator granted. Every
  ceiling, budget and per-role restriction is inherited (`dryRunRoles` and `submissionClassesByRole`
  above all). Landing authority does not move underneath anyone; what changes is that such runs stop
  parking on the caps. A deployment that WANTS its API-started runs to keep parking re-points
  `isUnattendedDefault` at a policy whose `autonomy` is `attended`.

  `Balanced` and `Manual review only` are NOT version-bumped. Both new fields land on them as the
  migration's column defaults, so a stored row and a freshly seeded one are identical — advising every
  existing workspace to reseed for a zero-delta change would invite them to overwrite their own edits.

  **Public API (additive, OpenAPI 1.49.0).** `GET /api/v1/risk-policies` gains `isUnattendedDefault`
  and `autonomy`. `isDefault` keeps its exact former meaning, so nothing an existing client was told
  becomes wrong; it was reading about the other scope. A caller predicting whether its own runs can
  reach a terminal state unassisted should read `autonomy` on the `isUnattendedDefault` row.

  **Internal break.** `RiskPolicyRepository.getDefault` takes the scope, and
  `RunMergePolicy.resolve` / the engine's `resolveRiskPolicy` callback take the run. Both are required
  rather than defaulted: a call site that has not decided which kind of run it is resolving for now
  fails to compile, because the alternative reads as correct and silently hands an unwatched run the
  in-app policy.

  Design record: [ADR 0053](../backend/docs/adr/0053-unattended-run-autonomy.md).

### Patch Changes

- Updated dependencies [fc4a1e4]
  - @cat-factory/contracts@0.301.0
  - @cat-factory/kernel@0.292.0
  - @cat-factory/orchestration@0.263.0
  - @cat-factory/server@0.278.0
  - @cat-factory/node-server@0.201.0
  - @cat-factory/agents@0.126.6
  - @cat-factory/gitlab@0.20.7
  - @cat-factory/integrations@0.160.4
  - @cat-factory/prompt-fragments@1.0.61
  - @cat-factory/executor-harness@1.110.0

## 0.127.4

### Patch Changes

- Updated dependencies [ee733ee]
  - @cat-factory/contracts@0.300.0
  - @cat-factory/kernel@0.291.0
  - @cat-factory/orchestration@0.262.0
  - @cat-factory/server@0.277.0
  - @cat-factory/node-server@0.200.0
  - @cat-factory/agents@0.126.5
  - @cat-factory/gitlab@0.20.6
  - @cat-factory/integrations@0.160.3
  - @cat-factory/prompt-fragments@1.0.60
  - @cat-factory/executor-harness@1.110.0

## 0.127.3

### Patch Changes

- Updated dependencies [01086d8]
  - @cat-factory/contracts@0.299.1
  - @cat-factory/integrations@0.160.2
  - @cat-factory/kernel@0.290.1
  - @cat-factory/server@0.276.2
  - @cat-factory/agents@0.126.4
  - @cat-factory/gitlab@0.20.5
  - @cat-factory/orchestration@0.261.2
  - @cat-factory/prompt-fragments@1.0.59
  - @cat-factory/node-server@0.199.3
  - @cat-factory/executor-harness@1.110.0

## 0.127.2

### Patch Changes

- Updated dependencies [1bcdacc]
  - @cat-factory/kernel@0.290.0
  - @cat-factory/executor-harness@1.110.0
  - @cat-factory/agents@0.126.3
  - @cat-factory/gitlab@0.20.4
  - @cat-factory/integrations@0.160.1
  - @cat-factory/orchestration@0.261.1
  - @cat-factory/prompt-fragments@1.0.58
  - @cat-factory/server@0.276.1
  - @cat-factory/node-server@0.199.2

## 0.127.1

### Patch Changes

- Updated dependencies [195b248]
  - @cat-factory/contracts@0.299.0
  - @cat-factory/integrations@0.160.0
  - @cat-factory/orchestration@0.261.0
  - @cat-factory/server@0.276.0
  - @cat-factory/agents@0.126.2
  - @cat-factory/gitlab@0.20.3
  - @cat-factory/kernel@0.289.1
  - @cat-factory/prompt-fragments@1.0.57
  - @cat-factory/node-server@0.199.1
  - @cat-factory/executor-harness@1.110.0

## 0.127.0

### Minor Changes

- bc2478d: A public-API key now has an IDENTITY as well as a scope: a SYSTEM token (the default, unchanged) or
  a PERSONAL token its minter bound to themselves, which can run their own individual-usage
  subscription headlessly. Surface version 1.45.0, additive. Plus two bug fixes that made the old
  behaviour unreadable rather than merely limited.

  **The reported problem.** A workspace whose Claude runs come from a stored personal subscription was
  told by `GET /api/v1/models` that `claude-opus` was `available: false`, which the acceptance suite
  rendered as "no provider wired for it". Both statements are false, and the remedy they imply (add a
  provider key) is for a deployment that was already correct. The model was wired — as a credential
  belonging to a person, which a key-authenticated read is not allowed to see.

  **Two things were genuinely broken, independent of the feature.**

  `resolveWorkspaceCapabilities` did not know about NATIVE ambient execution. A vendor served by the
  host's own `claude`/`codex` CLI login (`LOCAL_NATIVE_AGENTS`) has no credential in either store, and
  the resolver consulted only those two stores, so the catalog and the pipeline-start guard called the
  model unconfigured on the very machine that would have run it. The personal-credential gate, reading
  the same allow-list, had already decided such a vendor needs no unlock: two halves of one decision,
  disagreeing. They now share `isAmbientNativeVendor`, which is where the executor's half already was.

  `GET /api/v1/models` could not say why a personal subscription's model was unavailable. The existing
  `excludesUserScopedModels` flag reports what an answer OMITS, and a subscription model is not omitted
  — it is listed, unjudged, because no user's credential store was consulted. Each row now carries
  `userScoped`, so the distinction is stated where it applies. Widening the response flag instead was
  tried and rejected: with no user resolved the server cannot know whether a personal subscription
  exists, so the honest predicate is "this deployment has `ENCRYPTION_KEY`", which is true nearly
  everywhere. A flag that is always true stops answering its question, and it would have re-pointed a
  published field at a new predicate under the same name.

  **The feature.** `POST /workspaces/:ws/public-api-keys` takes `actsAsSelf`, and the key row carries
  `actsAsUserId`. A personal token's runs record that person as initiator, `GET /api/v1/models`
  resolves under them, and a start/retry/decision call may unlock their subscription by sending
  `X-Personal-Password` — the same header, the same 428, and the same per-run activation the app uses.
  A system token behaves exactly as every key did before, including the `409
individual_model_unsupported` refusal, which is now reserved for the case no password could fix.

  Three properties bound it, and each is a shape rather than a rule to remember. The wire field is a
  BOOLEAN and the server reads the id off the session, so minting a key onto a colleague's
  subscription is unrepresentable rather than merely forbidden; a mint with no signed-in user is
  refused instead of quietly producing an unbound key. Headless provisioning (`POST /api/v1/keys`)
  can never bind, because a provisioning key holds nobody's consent to inherit. And the password is
  stored NOWHERE — not on the row, not in a session — so the binding alone spends nothing and a
  leaked personal token reaches that user's PAT (as a leaked session would) but not their
  subscription.

  A bound key attributes EVERY run it starts, not only the ones needing an unlock. The alternative
  makes one key produce runs under two identities depending on which model a task happened to pin,
  with two credential scopes and two merge-policy roles, and nothing in the request to say which.

  **And a bound run is that person's run all the way through, policy included.** The two public start
  routes resolve the bound user's workspace ROLE and pin it, so a headless start is admitted under the
  same role-scoped merge narrowing and the same dry-run sandbox its holder gets in the app: a key
  cannot land what the person behind it could not. An initiator with no role is not a lenient run, it
  is a run with no policy — which is what the bug-hunt adopt route once shipped, and why
  `runAdmission.coverage.spec.ts` makes every start route CLASSIFY itself. A retry deliberately keeps
  the ORIGINAL run's pinned authority instead (`buildResumedInstance`), because a re-drive is the same
  work under the authority it was first granted, and dropping it would launder a dry run into a live
  one via restart-from-step-0.

  `POST /api/v1/jobs` runs the same personal-credential gate as the board start. Being inline-only
  settles what a public run may DO (no container, no push) and says nothing about whose credential it
  needs: the inline harness leases a personal subscription for every individual-usage vendor, so
  skipping the gate there traded an actionable refusal for a run that dies at its first dispatch.

  Deliberately not lifted: `POST /api/v1/notifications/:id/act`. Its ci-/test-failure arm retries
  through a shared effect that mints no activation, so admitting a bound key there would trade a
  refusal the caller can act on for a run that dies at its first dispatch. Lifting it means threading
  the gate through that effect for the SPA and this surface at once.

  **Answering a park no longer re-derives a credential that is already fresh.** Each re-mint runs
  210k PBKDF2 iterations per vendor, which a human clicking through a run pays once and a headless
  driver answering eight follow-ups would pay eight times in a row — seconds of blocked event loop on
  Node, a CPU-limit kill on workerd. The interaction path now skips the whole gate while the run holds
  an activation with over half its life left, and both facades share one helper, so the SPA gets the
  same. The decision surface's refusal is returned as DATA (a `428` in that surface's own envelope,
  carrying the vendor and reason) rather than thrown, which is the invariant every other gate there
  already keeps.

  **`X-Personal-Password` is declared on the operations that read it**, so it reaches
  `docs/openapi.json` and the four generated clients instead of being discoverable only by getting a 428. Each client also gained a post-construction setter for it, since that is when a caller learns
  it is needed.

  **The acceptance suite** now runs on the operator's own subscription. It prompts for the personal
  password at the terminal on the first call that needs one — never at `configure` time, and never at
  all for a workspace on a provider API key — and holds it in memory only: not the `.env`, not the
  ledger, not the journal, because a copy beside `CAT_FACTORY_API_KEY` would put both halves of a
  two-factor credential in one file. The header then rides every request, since answering a park
  re-mints the run's activation server-side. `configure` and the `model-preset` gate now say "not
  visible to this system token" and name the fix, instead of the wrong one they used to name — read
  off the ROW, so a model that genuinely has no provider still reads as unwired, and an invisible
  workspace default stays SELECTED rather than being quietly swapped for a model nobody chose.

  The prompt opens the CONTROLLING TERMINAL rather than reading `process.stdin`. The suite runs under
  vitest, whose workers are forked with piped stdio, so a prompt built on stdin could never have asked
  anything: the one path this exists for would have thrown "stdin is not a terminal" on every pass. It
  is also stricter than the check it replaces, since a controlling terminal cannot be fed from a pipe
  or a file at all. And the entered password is no longer trimmed: a space is printable ASCII, so a
  legal password with one at either end was being silently altered and then reported as wrong.

### Patch Changes

- Updated dependencies [bc2478d]
  - @cat-factory/contracts@0.298.0
  - @cat-factory/kernel@0.289.0
  - @cat-factory/integrations@0.159.0
  - @cat-factory/server@0.275.0
  - @cat-factory/node-server@0.199.0
  - @cat-factory/agents@0.126.1
  - @cat-factory/gitlab@0.20.2
  - @cat-factory/orchestration@0.260.1
  - @cat-factory/prompt-fragments@1.0.56
  - @cat-factory/executor-harness@1.110.0

## 0.126.0

### Minor Changes

- a634746: A locally-run model can now be given a run's design renders. Its image support resolves in two
  tiers: a table of recognised open-weights families (`KNOWN_LOCAL_MODELS`, so ticking Gemma 4 or Muse
  Glimmer needs no second step), overridden by a per-model declaration on the user's own runner entry
  for anything the table cannot know about.

  The gap was structural rather than a missed case. `acceptsImages` is a per-FLAVOUR fact declared on
  `MODEL_CATALOG`, and a local model has no catalog row: it lives on one person's machine, its id is
  free text, and the OpenAI-compatible `/models` probe the panel discovers models with returns ids and
  nothing else. So every local ref arrived with the modality absent and `resolveDesignImageDelivery`
  answered `unknown_model_image_input` for all of them, forever. That reason exists precisely so this
  would stay visible instead of reading as a text-only model, and the arrival of image-capable local
  models is what turned it from a latent hole into a lost capability.

  The declaration wins over the table on purpose: the person who pulled the weights is the one who
  knows whether they are running a text-only quant, a fine-tune or a re-tagged copy. The table
  therefore carries only families whose SILENCE costs a capability (every member is image-capable; a
  text-only entry would behave identically to an absent one), and a family whose modality depends on
  the size is left out rather than approximated, which is why Gemma 3 is absent while Gemma 4 is
  present. It lives in `@cat-factory/contracts` because the settings panel labels its "not set" option
  with what the table will do and the engine folds the same answer onto the dispatched ref.

  The initiator's declarations are read on EVERY dispatch, because the winning model is not known
  until the shared resolver has walked its sources, so the read goes through a new `AppCaches`
  slice keyed on the user (the endpoint write paths invalidate it). Without that, a deployment with no
  local runners at all still paid a query per step, and a mothership-mode node an extra
  `/internal/persistence` round trip per step.

  Delivery still joins the HARNESS's answer first, and that is what decides where this lands today: a
  local ref names no harness, so a container dispatch runs it on Pi, whose `HARNESS_IMAGE_INPUT` entry
  is `false` and refuses without consulting the ref. The modality is therefore acted on by the inline
  path, and the container path becomes a reader the day an image-carrying harness serves a local model,
  which is a one-line table edit rather than new plumbing. It is resolved for every path regardless,
  because the winning model is not known until the shared resolver has walked its sources.

  `contextTokens` is deliberately NOT declared for a local model, though the same shape could carry it.
  The window a runner serves is a fact about its config rather than about the weights (Ollama's
  `num_ctx` default sits far below what a 128K-window model can do), nothing enforces it for a local
  ref, and stating a number the runner silently ignores would be worse than stating none. The
  truncation trap that follows from that is now written down in `backend/docs/model-support.md`.

  **Internal break:** the endpoint row's enabled-model list changes from `string[]` to a declaration
  array. A row written before this loses its entries on read: bare strings are dropped rather than
  coerced, so the break cannot arrive as a model id of `[object Object]`. The endpoint reports the
  discard (`unreadableModels`) and the panel names it per runner, because a shortened list on its own
  reads exactly like a runner nobody ever enabled a model on and only one of those is fixed by
  re-ticking. The fix is to re-tick the models in "My local runners", which rewrites the whole blob.

### Patch Changes

- Updated dependencies [a634746]
  - @cat-factory/contracts@0.297.0
  - @cat-factory/kernel@0.288.0
  - @cat-factory/integrations@0.158.0
  - @cat-factory/agents@0.126.0
  - @cat-factory/orchestration@0.260.0
  - @cat-factory/server@0.274.0
  - @cat-factory/node-server@0.198.0
  - @cat-factory/gitlab@0.20.1
  - @cat-factory/prompt-fragments@1.0.55
  - @cat-factory/executor-harness@1.110.0

## 0.125.25

### Patch Changes

- Updated dependencies [7893f35]
  - @cat-factory/contracts@0.296.0
  - @cat-factory/integrations@0.157.0
  - @cat-factory/kernel@0.287.0
  - @cat-factory/gitlab@0.20.0
  - @cat-factory/orchestration@0.259.0
  - @cat-factory/server@0.273.0
  - @cat-factory/agents@0.125.8
  - @cat-factory/prompt-fragments@1.0.54
  - @cat-factory/node-server@0.197.8
  - @cat-factory/executor-harness@1.110.0

## 0.125.24

### Patch Changes

- Updated dependencies [07ff467]
  - @cat-factory/contracts@0.295.0
  - @cat-factory/orchestration@0.258.0
  - @cat-factory/server@0.272.0
  - @cat-factory/agents@0.125.7
  - @cat-factory/gitlab@0.19.20
  - @cat-factory/integrations@0.156.1
  - @cat-factory/kernel@0.286.3
  - @cat-factory/prompt-fragments@1.0.53
  - @cat-factory/node-server@0.197.7
  - @cat-factory/executor-harness@1.110.0

## 0.125.23

### Patch Changes

- Updated dependencies [9b3473a]
  - @cat-factory/contracts@0.294.0
  - @cat-factory/integrations@0.156.0
  - @cat-factory/server@0.271.0
  - @cat-factory/agents@0.125.6
  - @cat-factory/gitlab@0.19.19
  - @cat-factory/kernel@0.286.2
  - @cat-factory/orchestration@0.257.2
  - @cat-factory/prompt-fragments@1.0.52
  - @cat-factory/node-server@0.197.6
  - @cat-factory/executor-harness@1.110.0

## 0.125.22

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
  - @cat-factory/integrations@0.155.5
  - @cat-factory/orchestration@0.257.1
  - @cat-factory/server@0.270.1
  - @cat-factory/agents@0.125.5
  - @cat-factory/gitlab@0.19.18
  - @cat-factory/node-server@0.197.5
  - @cat-factory/executor-harness@1.110.0
  - @cat-factory/prompt-fragments@1.0.51

## 0.125.21

### Patch Changes

- Updated dependencies [b25732f]
  - @cat-factory/contracts@0.293.0
  - @cat-factory/server@0.270.0
  - @cat-factory/kernel@0.286.0
  - @cat-factory/orchestration@0.257.0
  - @cat-factory/agents@0.125.4
  - @cat-factory/gitlab@0.19.17
  - @cat-factory/integrations@0.155.4
  - @cat-factory/prompt-fragments@1.0.50
  - @cat-factory/node-server@0.197.4
  - @cat-factory/executor-harness@1.110.0

## 0.125.20

### Patch Changes

- 7119ca7: Warn on board load when the GitHub token a run would use cannot push or open pull requests.

  A personal access token is the operational credential on two deployment shapes: local mode, where
  one token is both the sign-in identity and what every agent step clones, pushes and merges with,
  and a hosted deployment whose run initiator stored a `github_pat`, which outranks the App
  installation on the run path. On both, a token minted without `repo` (or a fine-grained token
  pointed at the wrong repositories) reached its first failure several steps into a pipeline, as a
  403 out of a container, after the run had already spent money. Local mode logged a boot warning
  about it, which is a line in a terminal nobody is looking at; a hosted deployment said nothing at
  all.

  A new `GET /workspaces/:id/github/pat-check` answers what that token can actually do, and the SPA
  raises a banner linking straight to GitHub's token form, pre-filled where GitHub allows it.

  The parts worth reviewing:

  **Which token gets judged, and whether one is judged at all.** The check resolves through the same
  `resolveRunInitiatorToken` the dispatch mint and the engine's GitHub client already share, now
  surfaced on `CoreDependencies`, so a workspace that turned `allowInitiatorPat` off is not nagged
  about a credential none of its runs touch. Re-deriving the gate in the controller was the
  alternative, and it would have been a fourth copy of a security decision that exists to be singular.

  The second half of that question is answered by a new `listWorkspaceRunRepos` seam, the block-free
  counterpart of `resolveRepoTarget`, built beside it on every facade: every repository this board's
  mounted services target. A token is judged only where a run would present it, so a board that
  targets no GitHub repository (bound to GitLab, or nothing linked yet) answers `not_applicable`
  rather than rendering a scope verdict over pipelines that never reach GitHub. The same set is what
  a fine-grained token is probed against, so the probe's cap samples the work rather than the
  alphabet: the repository projection lists everything the connection can see and is ordered by owner
  and name, which no run consults.

  **Per capability, not a boolean.** GitHub reports a classic token's scopes in `x-oauth-scopes` and
  reports nothing whatsoever for a fine-grained one, whose reach is knowable only by probing a
  repository: that answers for push and answers nothing for pull requests or workflows. Each
  capability therefore carries `granted` / `missing` / `unknown`, and only `missing` raises anything.
  Folding `unknown` into either would have meant silencing a real gap or nagging every correctly
  configured fine-grained deployment forever. The fine-grained probe is a capped sample of the
  targeted repositories and says how many it did not read.

  **What a repository read can and cannot establish.** GitHub's repository payload reports the
  authenticated IDENTITY's role, not the grants of the credential presenting it, and a token's reach
  is a subset of its owner's. So `push: false` refutes the token while `push: true` only fails to
  refute it, and only the first is reported as a verdict. The one positive statement available about
  the credential itself is a 404, which GitHub returns rather than a 403 for a repository a
  credential may not see; a 404 on every targeted repository is therefore `missing`, and the report
  names those repositories, which is the fine-grained-token-pointed-at-the-wrong-repositories case
  this feature exists to catch. A single 404 among readable repositories stays `unknown`: it is
  ambiguous with a projection row pointing at a renamed repository, and a stale row must not be
  reported as a broken credential.

  **A throttled token is not a rejected one.** GitHub spells an exhausted primary or secondary rate
  limit with the same 403 it uses to refuse a credential, so the rate-limit markers are read first
  and answer `probe_failed`. Read as a rejection, a throttled board load raises the loudest banner
  the product has and advertises minting a replacement.

  **A classic token with no scopes is a distinct fact from an unreadable one.** GitHub sends
  `x-oauth-scopes` for every classic token, so an empty value states that this one grants nothing.
  Treating an empty header as an absent one classified it as unreadable, which sent it down the
  fine-grained path where a repository read its owner could satisfy reported it as fine. It now
  classifies as a classic token missing everything, and the connect form gained a warning
  (`github_pat_no_scopes`) saying so.

  **The scope list is not on the wire.** Nothing renders it, reads pass the route's permission mount,
  and the one source whose scopes this endpoint could expose is a shared deployment credential.

  **What does not raise the banner.** An unreachable GitHub is `probe_failed`, not a verdict: the
  remedy a permissions banner advertises is wrong and expensive during an upstream blip. A missing
  `workflow` scope is advisory, listed inside the card but never its reason for opening, because
  without it a run still pushes, opens its PR and merges and fails only on changes that touch
  `.github/workflows/*`.

  **Classic versus fine-grained.** The re-mint link carries over the kind of the token being
  replaced, so a deployment that standardised on fine-grained tokens is not pushed back to a classic
  one by a warning. Only the classic form accepts a prefill; GitHub's fine-grained form takes no
  permission parameters at all, so that half is a bare link and the banner names the permissions to
  grant. Saying so is deliberate: a link that silently arrived with nothing selected reads as
  "already done for you".

  **On the SPA side**, the check is single-flighted separately from the connection reads and never
  awaited by them. It is the only one of the three that leaves the deployment, and two modals block
  their open on `probe()`; awaited, an unreachable GitHub held those modals for the full outbound
  timeout to settle a banner they do not render. It follows the door rather than the batch: the
  on-board-open fan-out checks at most once per board, while the deliberate-refresh door re-checks,
  because the surfaces that force a refresh are the ones that just changed what the answer depends
  on. Three panels whose own comments said "probe once so the pickers light up" moved onto
  `ensureProbed`, which is what they meant.

  The required-scope list is now one constant in `@cat-factory/contracts`, read by the local
  facade's boot warning and setup link, its scope classifier, and the SPA — it was two copies before,
  which is two answers to "what should I tick".

- Updated dependencies [7119ca7]
  - @cat-factory/integrations@0.155.3
  - @cat-factory/orchestration@0.256.4
  - @cat-factory/node-server@0.197.3
  - @cat-factory/contracts@0.292.2
  - @cat-factory/server@0.269.3
  - @cat-factory/kernel@0.285.3
  - @cat-factory/agents@0.125.3
  - @cat-factory/gitlab@0.19.16
  - @cat-factory/prompt-fragments@1.0.49
  - @cat-factory/executor-harness@1.110.0

## 0.125.19

### Patch Changes

- Updated dependencies [3dde85c]
  - @cat-factory/integrations@0.155.2
  - @cat-factory/orchestration@0.256.3
  - @cat-factory/server@0.269.2
  - @cat-factory/node-server@0.197.2
  - @cat-factory/executor-harness@1.110.0

## 0.125.18

### Patch Changes

- Updated dependencies [57a7ecd]
  - @cat-factory/integrations@0.155.1
  - @cat-factory/contracts@0.292.1
  - @cat-factory/kernel@0.285.2
  - @cat-factory/orchestration@0.256.2
  - @cat-factory/server@0.269.1
  - @cat-factory/node-server@0.197.1
  - @cat-factory/agents@0.125.2
  - @cat-factory/gitlab@0.19.15
  - @cat-factory/prompt-fragments@1.0.48
  - @cat-factory/executor-harness@1.110.0

## 0.125.17

### Patch Changes

- Updated dependencies [5f6699a]
  - @cat-factory/contracts@0.292.0
  - @cat-factory/integrations@0.155.0
  - @cat-factory/node-server@0.197.0
  - @cat-factory/server@0.269.0
  - @cat-factory/agents@0.125.1
  - @cat-factory/gitlab@0.19.14
  - @cat-factory/kernel@0.285.1
  - @cat-factory/orchestration@0.256.1
  - @cat-factory/prompt-fragments@1.0.47
  - @cat-factory/executor-harness@1.110.0

## 0.125.16

### Patch Changes

- Updated dependencies [22b2459]
- Updated dependencies [2428b6b]
  - @cat-factory/kernel@0.285.0
  - @cat-factory/agents@0.125.0
  - @cat-factory/server@0.268.0
  - @cat-factory/executor-harness@1.110.0
  - @cat-factory/integrations@0.154.0
  - @cat-factory/orchestration@0.256.0
  - @cat-factory/contracts@0.291.0
  - @cat-factory/gitlab@0.19.13
  - @cat-factory/prompt-fragments@1.0.46
  - @cat-factory/node-server@0.196.1

## 0.125.15

### Patch Changes

- Updated dependencies [19baddf]
  - @cat-factory/kernel@0.284.0
  - @cat-factory/agents@0.124.0
  - @cat-factory/orchestration@0.255.0
  - @cat-factory/server@0.267.0
  - @cat-factory/executor-harness@1.108.0
  - @cat-factory/node-server@0.196.0
  - @cat-factory/gitlab@0.19.12
  - @cat-factory/integrations@0.153.12
  - @cat-factory/prompt-fragments@1.0.45

## 0.125.14

### Patch Changes

- Updated dependencies [31f43c1]
  - @cat-factory/contracts@0.290.0
  - @cat-factory/kernel@0.283.0
  - @cat-factory/orchestration@0.254.0
  - @cat-factory/server@0.266.0
  - @cat-factory/agents@0.123.6
  - @cat-factory/gitlab@0.19.11
  - @cat-factory/integrations@0.153.11
  - @cat-factory/prompt-fragments@1.0.44
  - @cat-factory/node-server@0.195.14
  - @cat-factory/executor-harness@1.106.0

## 0.125.13

### Patch Changes

- Updated dependencies [3ff215a]
  - @cat-factory/orchestration@0.253.1
  - @cat-factory/contracts@0.289.1
  - @cat-factory/kernel@0.282.1
  - @cat-factory/agents@0.123.5
  - @cat-factory/server@0.265.1
  - @cat-factory/node-server@0.195.13
  - @cat-factory/gitlab@0.19.10
  - @cat-factory/integrations@0.153.10
  - @cat-factory/prompt-fragments@1.0.43
  - @cat-factory/executor-harness@1.106.0

## 0.125.12

### Patch Changes

- Updated dependencies [e3cf16a]
  - @cat-factory/contracts@0.289.0
  - @cat-factory/kernel@0.282.0
  - @cat-factory/orchestration@0.253.0
  - @cat-factory/server@0.265.0
  - @cat-factory/agents@0.123.4
  - @cat-factory/gitlab@0.19.9
  - @cat-factory/integrations@0.153.9
  - @cat-factory/prompt-fragments@1.0.42
  - @cat-factory/node-server@0.195.12
  - @cat-factory/executor-harness@1.106.0

## 0.125.11

### Patch Changes

- Updated dependencies [83764b5]
  - @cat-factory/contracts@0.288.0
  - @cat-factory/orchestration@0.252.0
  - @cat-factory/server@0.264.0
  - @cat-factory/agents@0.123.3
  - @cat-factory/gitlab@0.19.8
  - @cat-factory/integrations@0.153.8
  - @cat-factory/kernel@0.281.3
  - @cat-factory/prompt-fragments@1.0.41
  - @cat-factory/node-server@0.195.11
  - @cat-factory/executor-harness@1.106.0

## 0.125.10

### Patch Changes

- Updated dependencies [1fbd83c]
- Updated dependencies [00228c6]
  - @cat-factory/orchestration@0.251.1
  - @cat-factory/contracts@0.287.1
  - @cat-factory/kernel@0.281.2
  - @cat-factory/agents@0.123.2
  - @cat-factory/server@0.263.1
  - @cat-factory/node-server@0.195.10
  - @cat-factory/gitlab@0.19.7
  - @cat-factory/integrations@0.153.7
  - @cat-factory/prompt-fragments@1.0.40
  - @cat-factory/executor-harness@1.106.0

## 0.125.9

### Patch Changes

- Updated dependencies [bf473bd]
  - @cat-factory/contracts@0.287.0
  - @cat-factory/orchestration@0.251.0
  - @cat-factory/server@0.263.0
  - @cat-factory/agents@0.123.1
  - @cat-factory/gitlab@0.19.6
  - @cat-factory/integrations@0.153.6
  - @cat-factory/kernel@0.281.1
  - @cat-factory/prompt-fragments@1.0.39
  - @cat-factory/node-server@0.195.9
  - @cat-factory/executor-harness@1.106.0

## 0.125.8

### Patch Changes

- Updated dependencies [4715b74]
- Updated dependencies [8c1d8a6]
  - @cat-factory/contracts@0.286.0
  - @cat-factory/kernel@0.281.0
  - @cat-factory/orchestration@0.250.0
  - @cat-factory/agents@0.123.0
  - @cat-factory/server@0.262.0
  - @cat-factory/gitlab@0.19.5
  - @cat-factory/integrations@0.153.5
  - @cat-factory/prompt-fragments@1.0.38
  - @cat-factory/node-server@0.195.8
  - @cat-factory/executor-harness@1.106.0

## 0.125.7

### Patch Changes

- Updated dependencies [afe1250]
  - @cat-factory/contracts@0.285.0
  - @cat-factory/kernel@0.280.0
  - @cat-factory/agents@0.122.0
  - @cat-factory/orchestration@0.249.0
  - @cat-factory/server@0.261.0
  - @cat-factory/gitlab@0.19.4
  - @cat-factory/integrations@0.153.4
  - @cat-factory/prompt-fragments@1.0.37
  - @cat-factory/node-server@0.195.7
  - @cat-factory/executor-harness@1.106.0

## 0.125.6

### Patch Changes

- e3fdc15: A typing pass that removes the casts a better type, a generic or a guard could carry.

  New in `@cat-factory/contracts`: `parseStoredProviderConfig(schema, raw, label)`, the one place a
  native environment backend re-reads its own config off a stored manifest's `providerConfig`. The
  Kubernetes, Cloudflare and EKS backends used to assert that value; a config written before a schema
  change (or edited in the database) therefore flowed on as a fake-valid object and misbehaved deep
  inside a provision instead of being named at the boundary. Those three now THROW on an off-contract
  stored config where they previously carried on.

  That re-read is split by what the operation USES, which is the difference between a loud refusal
  and an environment nobody can reclaim. Standing one up parses the whole config; tearing one down
  parses only the connection (`kubernetesConnectionConfigSchema` / `eksConnectionConfigSchema` /
  `cloudflareConnectionConfigSchema`), so a `manifestSource`, `url` or `workersSubdomain` that
  stopped matching the contract still fails a provision and can never strand a live namespace or
  preview. The fields the reclaim itself reads stay validated: there is no safe default for which
  cluster to delete from, and none for a GitHub Enterprise API root whose fallback is the public one.

  Behaviour changes worth knowing about:

  - The Worker's bindings are read through `envVar` / `envVars`, which filter by `typeof`. A binding
    that is not a string (a D1 database, a queue, a Durable Object namespace) now reads as absent
    where the previous assertion handed it on as a string.
  - `SlackApiClient.chatPostMessage` takes the rendered `SlackMessageBody` instead of an arbitrary
    `Record<string, unknown>`. `SlackMessageBody` and `DeployJobSpec` are type aliases rather than
    interfaces so they keep the implicit index signature their JSON sinks need.
  - The workspace-RBAC mount tag is read through a shape guard; an unrelated object stored under the
    same symbol no longer reads as a permission gate.

  - `EksEnvironmentProvider` parses its own superset config. It inherited the Kubernetes parse, and
    a valibot object drops entries it does not declare, so `region` / `clusterName` / `stsHost` were
    read off a config that no longer had them: every EKS call was presigning its apiserver token
    against `sts.undefined.amazonaws.com`.
  - The Kubernetes engine form narrows a stored `url.source` through `isKubernetesUrlSource`, a guard
    derived from the contract variant's own members. The discriminant is a closed vocabulary that is
    nonetheless persisted, so a config naming a source this build does not define now falls back to
    the form's default rather than reaching an exhaustive `switch` with no branch for it.

  Everything else is type-level only: typed `queryAll` / `queryOne` helpers behind the local
  `node:sqlite` stores (the row shape is now checked to be one SQLite could produce), a `BadgeColor`
  derived from `UBadge`'s own prop type so the SPA's chip maps agree with the component, and the
  Kubernetes engine form building its config as the contract's discriminated union.

- Updated dependencies [e3fdc15]
  - @cat-factory/contracts@0.284.0
  - @cat-factory/integrations@0.153.3
  - @cat-factory/server@0.260.3
  - @cat-factory/agents@0.121.4
  - @cat-factory/gitlab@0.19.3
  - @cat-factory/kernel@0.279.3
  - @cat-factory/orchestration@0.248.5
  - @cat-factory/prompt-fragments@1.0.36
  - @cat-factory/node-server@0.195.6
  - @cat-factory/executor-harness@1.106.0

## 0.125.5

### Patch Changes

- 3036af7: Refresh every direct and transitive dependency to the newest version the 24h
  `minimumReleaseAge` supply-chain gate admits, staying inside each package's current major.

  The Vercel AI SDK family moves within the majors `workers-ai-provider` pairs with
  (`ai@7.0.58`, `@ai-sdk/*@4.0.36` / `openai-compatible@3.0.27` / `amazon-bedrock@5.0.50`), and the
  Vue singleton pin plus its `@vue/*` overrides move together to 3.5.41 so the SPA still bundles
  exactly one Vue.

- Updated dependencies [3036af7]
- Updated dependencies [3036af7]
  - @cat-factory/agents@0.121.3
  - @cat-factory/integrations@0.153.2
  - @cat-factory/kernel@0.279.2
  - @cat-factory/node-server@0.195.5
  - @cat-factory/orchestration@0.248.4
  - @cat-factory/server@0.260.2
  - @cat-factory/executor-harness@1.106.0
  - @cat-factory/gitlab@0.19.2
  - @cat-factory/prompt-fragments@1.0.35

## 0.125.4

### Patch Changes

- Updated dependencies [de7caaf]
  - @cat-factory/contracts@0.283.1
  - @cat-factory/agents@0.121.2
  - @cat-factory/gitlab@0.19.1
  - @cat-factory/integrations@0.153.1
  - @cat-factory/kernel@0.279.1
  - @cat-factory/orchestration@0.248.3
  - @cat-factory/prompt-fragments@1.0.34
  - @cat-factory/server@0.260.1
  - @cat-factory/node-server@0.195.4
  - @cat-factory/executor-harness@1.104.0

## 0.125.3

### Patch Changes

- f0e1c45: Issue writeback is a `TaskSourceProvider` capability, and GitLab Issues accept webhooks

  The engine's writeback (a comment when the PR opens, comment + resolve on merge, the intake
  pickup claim, a parked review's questions and the acknowledgement of a reply) dispatched on a
  hard-coded `github | jira | linear` chain inside one service. GitLab Issues, a shipped task
  source, therefore had full intake and no way to answer it, and a tracker a deployment registers
  could not have one however it was wired. Providers now declare `writeback`, the outbound mirror
  of the existing `webhook` capability, and the service dispatches through the registry.

  `GitLabIssuesProvider` also gains the inbound half: GitLab echoes a shared secret in
  `x-gitlab-token` rather than signing the body, so its adapter compares that in constant time and
  still fails closed on an empty secret. Board equality is now the source's own rule
  (`TaskSourceProvider.sameBoard`), because GitLab project paths are case-sensitive where every
  other board id folds.

  A writeback adapter declares where it gets its authority (`authenticates`), which decides what an
  unreadable tracker connection costs. Jira and Linear post with the stored bag, so a row that will
  not open takes their writeback with it. GitHub Issues and GitLab Issues authenticate through the
  workspace's VCS installation and read that row only for the inbound reply secret, so they keep
  posting and lose just the reply grammar, which is withheld rather than promised.

  Two internal breaks, per the pre-1.0 policy. The facades' `commentOnGitHubIssue` /
  `closeGitHubIssue` / `labelGitHubIssue` writeback seams are gone (the source resolves its own
  installation now), and a writeback for a workspace with no stored connection REFUSES where the
  Jira and Linear legs used to return quietly: that silent return let the parked-review echo record
  its idempotency marker for a comment the tracker never received.

- Updated dependencies [f0e1c45]
  - @cat-factory/kernel@0.279.0
  - @cat-factory/integrations@0.153.0
  - @cat-factory/gitlab@0.19.0
  - @cat-factory/server@0.260.0
  - @cat-factory/orchestration@0.248.2
  - @cat-factory/node-server@0.195.3
  - @cat-factory/executor-harness@1.104.0
  - @cat-factory/agents@0.121.1
  - @cat-factory/prompt-fragments@1.0.33

## 0.125.2

### Patch Changes

- Updated dependencies [6ad1d8b]
  - @cat-factory/contracts@0.283.0
  - @cat-factory/kernel@0.278.0
  - @cat-factory/agents@0.121.0
  - @cat-factory/gitlab@0.18.15
  - @cat-factory/integrations@0.152.8
  - @cat-factory/orchestration@0.248.1
  - @cat-factory/prompt-fragments@1.0.32
  - @cat-factory/server@0.259.2
  - @cat-factory/node-server@0.195.2
  - @cat-factory/executor-harness@1.104.0

## 0.125.1

### Patch Changes

- Updated dependencies [a596b9c]
  - @cat-factory/contracts@0.282.0
  - @cat-factory/orchestration@0.248.0
  - @cat-factory/kernel@0.277.0
  - @cat-factory/integrations@0.152.7
  - @cat-factory/agents@0.120.2
  - @cat-factory/gitlab@0.18.14
  - @cat-factory/prompt-fragments@1.0.31
  - @cat-factory/server@0.259.1
  - @cat-factory/node-server@0.195.1
  - @cat-factory/executor-harness@1.104.0

## 0.125.0

### Minor Changes

- 2585b2f: Narrow the pipeline builder's saved-pipeline library on the purpose being edited, and make a
  pipeline's purpose mandatory

  The purpose dial narrowed the agent palette beside it and gated the save, but the library in the
  third column listed the whole workspace catalog whatever the draft was for. `pipelineMatchesPurpose`
  is the membership predicate, applied through `narrowPipelineLibrary` alongside the label and archive
  filters. Each of those dials now counts what relaxing IT alone would reveal, so the "Archived (n)"
  toggle no longer promises rows the current purpose is hiding either way, and the purpose hint is
  itself the control that lists every purpose again: the draft's purpose is an authoring field that is
  saved, so browsing past it may not require editing it.

  Breaking change (internal surfaces, pre-1.0). `Pipeline.purpose` is now REQUIRED, which is what lets
  those four narrowings drop their private policies for the pipelines that skipped it:

  - `POST /workspaces/:ws/pipelines` requires `purpose`; `PATCH` still treats it as an optional patch
    field. Not part of `/api/v1`, so no published SDK or external integration is affected.
  - `PipelineRegistry.register` requires it at compile time, so a deployment's own pipeline can no
    longer land unclassified and fall silently out of a narrowed picker. Same for the built-in seed
    catalog, where it was previously only asserted in a test.
  - A row persisted before the field was mandatory still reads: the shared `rowToPipeline` resolves an
    empty column to `build`, which is byte-for-byte the behaviour such a row already had. A stored
    classifier this build cannot NAME passes through untouched instead, and every narrowing predicate
    reads it default-open, because "never set" and "a member this build has no name for" are different
    facts that must not render the same.

### Patch Changes

- Updated dependencies [2585b2f]
  - @cat-factory/contracts@0.281.0
  - @cat-factory/kernel@0.276.0
  - @cat-factory/orchestration@0.247.0
  - @cat-factory/server@0.259.0
  - @cat-factory/node-server@0.195.0
  - @cat-factory/agents@0.120.1
  - @cat-factory/gitlab@0.18.13
  - @cat-factory/integrations@0.152.6
  - @cat-factory/prompt-fragments@1.0.30
  - @cat-factory/executor-harness@1.104.0

## 0.124.6

### Patch Changes

- Updated dependencies [faddbf5]
  - @cat-factory/contracts@0.280.0
  - @cat-factory/agents@0.120.0
  - @cat-factory/orchestration@0.246.0
  - @cat-factory/server@0.258.0
  - @cat-factory/gitlab@0.18.12
  - @cat-factory/integrations@0.152.5
  - @cat-factory/kernel@0.275.4
  - @cat-factory/prompt-fragments@1.0.29
  - @cat-factory/node-server@0.194.6
  - @cat-factory/executor-harness@1.104.0

## 0.124.5

### Patch Changes

- Updated dependencies [8a06abc]
- Updated dependencies [8a06abc]
  - @cat-factory/contracts@0.279.0
  - @cat-factory/server@0.257.0
  - @cat-factory/orchestration@0.245.0
  - @cat-factory/agents@0.119.3
  - @cat-factory/gitlab@0.18.11
  - @cat-factory/integrations@0.152.4
  - @cat-factory/kernel@0.275.3
  - @cat-factory/prompt-fragments@1.0.28
  - @cat-factory/node-server@0.194.5
  - @cat-factory/executor-harness@1.104.0

## 0.124.4

### Patch Changes

- Updated dependencies [11f9efa]
  - @cat-factory/contracts@0.278.0
  - @cat-factory/orchestration@0.244.0
  - @cat-factory/server@0.256.0
  - @cat-factory/agents@0.119.2
  - @cat-factory/gitlab@0.18.10
  - @cat-factory/integrations@0.152.3
  - @cat-factory/kernel@0.275.2
  - @cat-factory/prompt-fragments@1.0.27
  - @cat-factory/node-server@0.194.4
  - @cat-factory/executor-harness@1.104.0

## 0.124.3

### Patch Changes

- Updated dependencies [c44e9d7]
  - @cat-factory/contracts@0.277.0
  - @cat-factory/agents@0.119.1
  - @cat-factory/gitlab@0.18.9
  - @cat-factory/integrations@0.152.2
  - @cat-factory/kernel@0.275.1
  - @cat-factory/orchestration@0.243.1
  - @cat-factory/prompt-fragments@1.0.26
  - @cat-factory/server@0.255.1
  - @cat-factory/node-server@0.194.3
  - @cat-factory/executor-harness@1.104.0

## 0.124.2

### Patch Changes

- Updated dependencies [dfa4a8e]
  - @cat-factory/executor-harness@1.104.0
  - @cat-factory/orchestration@0.243.0
  - @cat-factory/kernel@0.275.0
  - @cat-factory/agents@0.119.0
  - @cat-factory/server@0.255.0
  - @cat-factory/node-server@0.194.2
  - @cat-factory/gitlab@0.18.8
  - @cat-factory/integrations@0.152.1
  - @cat-factory/prompt-fragments@1.0.25

## 0.124.1

### Patch Changes

- Updated dependencies [3e9a6af]
  - @cat-factory/contracts@0.276.0
  - @cat-factory/kernel@0.274.0
  - @cat-factory/orchestration@0.242.0
  - @cat-factory/integrations@0.152.0
  - @cat-factory/server@0.254.0
  - @cat-factory/agents@0.118.1
  - @cat-factory/gitlab@0.18.7
  - @cat-factory/prompt-fragments@1.0.24
  - @cat-factory/node-server@0.194.1
  - @cat-factory/executor-harness@1.102.0

## 0.124.0

### Minor Changes

- a62bcf8: Deliver notifications by email, and add the notification manager that decides which events go to
  which channel.

  The `EmailSender` port, its SendGrid/Resend adapters and the per-account connection have been live
  for a while and were used only for invitations. A new `EmailNotificationChannel` puts them behind
  the same `NotificationChannel` port the in-app and Slack transports implement, so the engine call
  sites that raise notifications are untouched. It resolves recipients from the SAME rules
  `resolveWorkspaceAccess` applies (account membership is the prerequisite, an account admin always
  qualifies, a `workspace_members` row counts only for a still-current account member), reads them in
  three batched queries rather than a point-read per person, and isolates each send so one bad address
  cannot cost every other recipient their notification. An account with no sender connected produces
  zero attempts and zero warnings.

  The manager (`notification_settings`, one row per workspace, D1 ⇄ Drizzle with a conformance suite)
  stores per-type, per-channel OVERRIDES over the shipped defaults, and one service answers both the
  settings API and the delivery gate so the toggle a human sees cannot say something the engine does
  not do. **By default email carries only the high-impact events**: the ones where something is
  stopped until a human acts (`merge_review`, `decision_required`, `ci_failed`, `test_failed`,
  `release_regression`) or the deployment itself is degraded (`platform_health`, `infra_unreachable`,
  `budget_paused`, `key_drift`). The per-step review parks are deliberately off by default — several
  arrive on nearly every task, and mailing them is the firehose that gets a sender's domain filtered.

  Only the channels whose delivery is a plain yes/no are routed here: the in-app push and email.
  Slack and the outbound webhooks answer "which types" where their DESTINATION is declared (a Slack
  route's channel, a webhook endpoint's own `types` filter), so a second switch would be a place to
  look that does not decide. The settings panel says so and links to the Slack routing.

  Delivery now carries WHICH lifecycle edge it reports (`NotificationDeliveryReason`: `raised` /
  `refreshed` / `settled`), because the service re-delivers a card on every transition it makes and
  the transports split hard on what that means. A STATE transport (the in-app push, the outbound
  webhook) takes every edge, so a board holding an open card sees it settle instead of rendering an
  already-made decision as still actionable. An ALERT transport (email, Slack) takes the `raised` edge
  alone: a mailbox and a chat channel cannot render a correction, so a second "Decision needed" after
  the decision was made is simply false. This also corrects Slack, which re-posted on every resolve
  and dismissal before the edge existed, and it is why the escalation sweep's loop over a workspace's
  overdue cards now performs no routing or audience reads at all. **The edge is a required parameter
  and rides the mothership delegation wire**, where it is refused rather than defaulted: the persisted
  row cannot supply it (a raise and an escalation are both `open`), so a node one build behind fails
  loudly instead of mailing the org about decisions already made.

  Two more behaviours to watch for when reviewing. The in-app push is gated too, but only on the raise:
  muting a type stops the live toast, while the card is still persisted, still in the inbox on the next
  snapshot, and still pushed when it settles. And a settings read that FAILS falls back to the shipped
  default and logs, rather than defaulting to deliver-everything (a mailshot) or deliver-nothing (the
  parked run nobody hears about). In the settings panel the same distinction is explicit: a deployment
  with no routing store and a read that broke are separate states, and only the first renders the
  shipped defaults, because saving is a full replace and a grid built from defaults would otherwise
  overwrite overrides nobody had seen.

- fe8ca56: Let a deployment define its own binary artifact stores in code. Implement the kernel
  `BinaryBlobBackend` port, register it on the new app-owned `BinaryStoreRegistry`, and pass the
  registry to `start()` / `startLocal()` / `createWorker({ overrides })`: each registered store then
  appears in the account-settings storage picker beside the platform's `fs` / `db` / `s3` / `r2`
  backends, and the per-account resolver builds it when an account selects it. The registered id is
  stamped onto every artifact row, an account naming a store this build does not register resolves to
  no storage and is named in the log and the settings panel, and the retention sweeps reclaim through
  a custom store like any built-in one.

  On the Worker the registry is held PROCESS-WIDE rather than on the app, alongside the model-provider
  and capability-credential registrations and for the same reason: that runtime builds a container per
  entry point, and the entry points that write and reclaim artifacts (the durable driver, the queue
  consumers, the retention cron) take no overrides. A store must be registered on every process that
  handles its bytes, which in mothership mode means the nodes that write them AND the mothership that
  sweeps them; a mothership-mode node now says so at boot.

  Internal break: `ContentStorageCapability` gains a required `customStores` and `ContentStorageSummary`
  a required `customStoreId`, so a facade or test building either literal must add them (the compile
  error is the point). `BinaryArtifactStorageKind` is now open at the type level, since a registered
  store's id is a legitimate value of the `storage` column.

### Patch Changes

- 2544fb3: Give the five HKDF cipher-info tags their own exported constants beside the services that
  own the sealed data, and import them in both facades instead of re-typing the literals.

  These strings derive the keys that seal provider subscriptions, provider API keys, personal
  subscriptions, local model endpoints and user secrets at rest, so a divergence between the
  two facades produces credentials one seals and the other cannot open, with nothing failing
  loudly. Four of their siblings were already imported constants; these five had been missed.

- 2544fb3: Run the five remaining telemetry conformance suites against the local `node:sqlite` store.

  `defineLlmMetricsSuite`, `defineAgentContextSuite`, `defineAgentSearchQuerySuite`,
  `defineProvisioningLogSuite` and `defineSubscriptionQuotaSuite` each ran against D1 and Postgres
  but never against the store a mothership-mode laptop actually records its own runs in, whose
  coverage was a hand-rolled 813-line sibling. The bespoke describes the suites subsume are deleted;
  what stays is what is local-only (the synchronous batch transaction, the exact prune count, the
  ingest reader). The shared provisioning-log suite also gains the `targetId` filter case the local
  file had and the suite lacked, so all three stores now assert it.

- Updated dependencies [2544fb3]
- Updated dependencies [a62bcf8]
- Updated dependencies [2544fb3]
- Updated dependencies [fe8ca56]
- Updated dependencies [2544fb3]
- Updated dependencies [2544fb3]
- Updated dependencies [2544fb3]
  - @cat-factory/executor-harness@1.102.0
  - @cat-factory/server@0.253.0
  - @cat-factory/kernel@0.273.0
  - @cat-factory/contracts@0.275.0
  - @cat-factory/integrations@0.151.0
  - @cat-factory/orchestration@0.241.0
  - @cat-factory/node-server@0.194.0
  - @cat-factory/agents@0.118.0
  - @cat-factory/gitlab@0.18.6
  - @cat-factory/prompt-fragments@1.0.23

## 0.123.0

### Minor Changes

- 35bc18f: Say what killed a container, on every transport that can run one.

  The post-mortem machinery was wired into exactly one path (the local per-run poll), so on the
  DEPLOYED runtime a container death reached the operator as `Job not found (container evicted or
crashed)` and nothing else. Each of the three remaining transports already held the evidence and
  discarded it at the moment it became the only evidence there was.

  **Cloudflare.** A per-run container recorded only a rollout drain, so an OOM kill recorded
  nothing. It now records `{ exitCode, reason }` for EVERY stop, and the transport attaches it to
  the eviction detail. That state is deliberately a SECOND, independent half of the stop record: the
  churn cause decides the recovery budget (unchanged, so the crash-eviction backstop behaves exactly
  as before), while the exit state decides the detail and is kept for the cause-less deaths, which
  are precisely the ones nobody could diagnose. The two hooks that see a stop now merge onto one
  record instead of overwriting: `onError` recognises the churn and knows no exit code, `onStop`
  knows the exit code and cannot name the churn, and they fire in either order. The merge is bounded
  to observations of ONE stop, since records are not reliably cleared between stops and merging onto
  a stale one would back-date a fresh crash out of its own attribution window. A stop the container
  asked for (its idle reclaim, its shutdown RPC) records no exit, because that code is its own signal
  echoed back; the shutdown also clears the record, so it stays transient rather than outliving the
  run in a per-run Durable Object. And where a cause was recognised, the detail reports the mechanics
  of that stop rather than offering a second cause of death: a reclaim escalating to SIGKILL used to
  read as "most often an out-of-memory kill" directly under a verdict saying the container was
  reclaimed while idle. What this runtime cannot supply is a log tail: a Container's stdout goes to
  the deployment's Workers logs and no API returns it to the Durable Object, so the detail says where
  the output actually is rather than implying it was withheld.

  **Kubernetes.** The pod object outlives its workload (`restartPolicy: Never`), so the kubelet's
  account of the death was one GET away and never read. The 404 poll now reads `state.terminated`,
  falls back to `lastState.terminated` for a container between lives (where a crash loop's real
  cause sits), and adds the pod-level account on top rather than instead, since a kubelet eviction
  under node pressure names itself only there and the container never saw it. That account is read as
  two independent halves: the apiserver does not guarantee a machine-readable `reason` beside its
  prose, and gating the prose on the code renders an evidence-carrying pod as an empty detail. A pod
  that is GONE and a pod that could not be READ are reported as themselves, because an unreachable
  control plane must not read like a clean death.

  **The native host-process transport** was spawned `stdio: 'ignore'`, discarding both the exit code
  and the stderr the harness routes its warn/error lines to. It now keeps a bounded stderr tail
  (nothing is forwarded onward, so the developer's console is as quiet as before) and retains the
  last exit past the process handle, which is dropped before the poll that needs it. Because this
  backend outlives a run, the tail is attached only when the process serving a job is confirmed gone;
  a live process that merely forgot the job says so, the same rule the warm pool follows. "The
  process serving this job" is tracked as a generation rather than as "the process": one death evicts
  every concurrent job, and answering the first eviction re-dispatches, which spawns the replacement
  while the siblings have yet to poll, so without the pairing a sibling is told its harness is
  "still serving other local runs", which is a fact about a different process. The same tail is
  folded lazily into a dispatch that never got the harness healthy, so a harness that will not boot
  at all stops failing with a sentence that names only the symptom.

  Kernel gains `composePostMortem`, the one place the two obligations every such detail carries
  (scrub through `redactSecrets`, then cap and state what was dropped) are implemented, and
  `tailPostMortemMaterial`, which bounds BULK material from the other end: a log's value is at its
  end, so letting one reach the head-keeping cap unbounded keeps the boot chatter and drops the
  crash. The local runtimes' shared log shaping now bounds by characters rather than by lines only,
  which is what a `--tail 50` of an agent echoing a payload needs.

  Internal break: the per-run container's `recentEvictionCause` RPC is replaced by
  `recentStopObservation`, which answers both halves. Worker and container deploy together, so
  nothing spans the change.

- 882b94f: Feed the visual-confirmation gate from the designs a task links. The frames an import retained for
  a linked Figma/Zeplin document now populate the gate's actual-vs-reference gallery on their own, so
  a designer who linked a frame gets screenshot-vs-design comparison with no manual upload at all.

  A reference that was explicitly chosen for a view still wins: an upload is a deliberate act against
  that one task and survives every re-import, while a design render is a projection the next
  body-changing import replaces wholesale. So an upload assigns over the fold, and a view whose
  reference the capture itself named is left alone. Each pair now says which of the two it is showing,
  and says nothing when the capture named its own, because a reference the gate did not source is one
  whose provenance it can only guess at.

  A view name two designs both claim is qualified with its design on BOTH sides rather than just the
  second, the same rule the Figma import applies to a frame name repeated across pages: leaving the
  first bare would hand the plain name to whichever design is listed first, and re-ordering the links
  would then silently re-point a reviewed view at a different screen.

  The gate also states what the linked designs contributed whenever a design is attached, including
  when everything worked, so "no design is linked" stays distinguishable from "one is and it gave
  nothing". The latter carries a per-design reason, since retaining part of a design, failing to
  download it, having no frames at all, and having had nowhere to store them each ask for a different
  fix. That verdict is derived from what the artifact store actually holds rather than from the
  recorded render status alone, so any status claiming retention over an empty shelf reports the
  absence rather than describing a gallery that is not there. The gallery's ceiling on design views is
  shared round-robin across the linked designs instead of being spent in read order, and each design
  that loses frames to it is named, so a design the ceiling shut out cannot read as one with no
  frames.

  Gathering the pairs no longer confuses a gallery ROW with a captured screenshot. A reference-only row
  (a design frame, an uploaded mock) makes a pair too, so a run that captured nothing had been losing
  the warning that gates the gate's approve button behind an acknowledgement, reporting a verified
  gallery of blanks in its run outcome, and summoning reviewers to screenshots that were not there. The
  rule now lives once in `@cat-factory/contracts` and all three ask it.

  `BinaryArtifactStore` grows a batched `listByDocuments`, mirrored D1 ⇄ Drizzle with a conformance
  assertion and allow-listed for mothership mode, so a task linking several designs still costs the
  driver path one read.

### Patch Changes

- Updated dependencies [35bc18f]
- Updated dependencies [882b94f]
- Updated dependencies [f2ead2a]
  - @cat-factory/kernel@0.272.0
  - @cat-factory/integrations@0.150.0
  - @cat-factory/contracts@0.274.0
  - @cat-factory/orchestration@0.240.0
  - @cat-factory/server@0.252.0
  - @cat-factory/node-server@0.193.0
  - @cat-factory/executor-harness@1.100.0
  - @cat-factory/agents@0.117.12
  - @cat-factory/gitlab@0.18.5
  - @cat-factory/prompt-fragments@1.0.22

## 0.122.0

### Minor Changes

- 6e07961: Retain a design document's rendered frames when it is imported. A Figma import now downloads the
  PNGs (the linked frame, or the first six top-level frames of a whole file) and stores them as
  `reference` binary artifacts keyed to the document, on the same shelf the visual-confirmation gate
  already reads from; a re-import that changes the body replaces the previous set wholesale. The
  download is host-pinned to Figma's signed-asset hosts and carries no credential.

  Renders ride a new `DocumentSourceProvider.fetchRenders` port rather than `fetchDocument`, and only
  run on an import that actually writes a body: a design file's version moves on any edit anywhere in
  it, so the dispatch-time freshness ladder re-fetches the text far more often than the pictures
  change.

  A new `documents.render_status` records what became of them (`stored` / `partial` / `none` /
  `failed` / `storage_unavailable`, or null where the question does not apply), because every way of
  ending up with no images is otherwise the same absence. It is derived from what was RETAINED, and
  counts the frames a provider's own cap excluded as unillustrated, so a six-picture pass over a
  twenty-frame file reads as `partial` rather than as a complete design with six screens. A
  deployment with no image storage configured imports the design textually and says so rather than
  downloading bytes it cannot keep; a settings read that FAILS is `failed`, not
  `storage_unavailable`, since telling an operator to configure storage they already have sends them
  to fix the wrong thing.

  A document's renders are exempt from the age-based artifact retention sweep. Age is the right
  lifetime for run debris and the wrong one for a projection of a live row: renders are replaced by
  the next import that changes the body and by nothing else, and an unedited design is never
  re-imported, so a clock-based sweep would leave the row claiming `stored` over an empty set with
  nothing to re-download them.

  Internal break: `binary_artifacts` rows and `documents` rows written before this change carry no
  document keying and no render status. Both self-heal on the next import; nothing needs a backfill.
  `BinaryArtifactMetadataStore.deleteByDocument` is replaced by `deleteByIds`: every id-scoped
  reclaim now names the rows whose bytes it has already removed, so a concurrent import's fresh row
  cannot be deleted out from under its blob.

### Patch Changes

- 9f9c240: Bound a wedged pipeline step on Node, and stop an idle container reclaim from reading as a
  crash. The last two findings of the stuck-run audit.

  **One hang bound, both facades.** `ExecutionConfig.advanceTimeout` (`ADVANCE_TIMEOUT`, default
  `30 minutes`) is now the ceiling on a single `advanceInstance` AND on a single status read: the
  Worker hands it to the durable driver's `step.do` (where it had been a hard-coded constant), and
  Node races it in `driveExecution` through a new injected `DriveOptions.withStepCeiling` seam.
  Node previously had no ceiling at all, and nothing else supplies one: pg-boss heartbeats an
  active job regardless of handler progress, so a hung call left the run `running` with a frozen
  `updated_at`, invisible to the stale-run sweeper, until the queue's expire cap (up to 24h). A
  timed-out advance fails the run rather than retrying in-process, because a second concurrent
  advance would double-drive it; a timed-out poll counts as one unreadable poll against
  `jobPollFailureTolerance`, which is the disposition the Worker has always had for the same
  event.

  **One knob now means one parser.** Every duration knob in `ExecutionConfig` resolves through the
  shared `resolveDurationEnv`, which canonicalises the value both runtimes go on to use. Node's
  own parser knew four of the units Workflows accepts and silently substituted its built-in
  default for the rest, so `ADVANCE_TIMEOUT="1 week"` was a week on Cloudflare and five minutes on
  Node. Values past what a timer can hold, and the calendar units whose length the two runtimes
  would each have to invent, are refused with one warning rather than honoured differently on each
  side.

  **A container that reclaims itself says so.** A per-run Cloudflare Container is kept warm only
  by the driver's job polls, so a poll gap longer than its idle window reclaimed it mid-job; the
  resulting 404 poll was indistinguishable from an OOM and spent the single crash-eviction budget,
  so two hiccups in one step failed a healthy run. The container now records the reclaim cause it
  observed (`idle` alongside the existing `rollout`) and the transport reads it back over one RPC,
  classifying an idle reclaim as `transient` churn with its own operator-facing wording. A record
  is claimed by the polling job rather than deleted, so a retried durable poll reads the same
  answer, and it is dropped when a new job is accepted, so a marker left by a routine idle reclaim
  cannot excuse a later step's genuine crash. The two per-run container classes collapsed onto a
  shared `RunContainer` base carrying this bookkeeping.

  Internal break: the old `rolledOutAt` Durable-Object storage key is gone. A rollout in flight
  across the deploy that ships this loses its attribution and is recovered as a crash instead,
  which costs one eviction on the smaller budget during a single release.

  `DriveConfig` gained a required `advanceTimeoutMs` (`0` disables the ceiling, which is what the
  conformance harness and the unit fakes use), so every construction site declares it.
  `ADVANCE_TIMEOUT` is reserved against capability-credential lookup by exact name, not as an
  `ADVANCE_` family, so a credential key that merely starts with it stays valid.

- Updated dependencies [6e07961]
- Updated dependencies [9f9c240]
  - @cat-factory/kernel@0.271.0
  - @cat-factory/contracts@0.273.0
  - @cat-factory/integrations@0.149.0
  - @cat-factory/orchestration@0.239.0
  - @cat-factory/server@0.251.0
  - @cat-factory/node-server@0.192.0
  - @cat-factory/executor-harness@1.98.0
  - @cat-factory/agents@0.117.11
  - @cat-factory/gitlab@0.18.4
  - @cat-factory/prompt-fragments@1.0.21

## 0.121.0

### Minor Changes

- 6c6dd0c: Bring the document and task source integrations to a mothership-mode node

  Every other connection surface reached mothership mode long ago: environments, observability,
  Slack, runner pools all store their credential as a sealed blob, so only ciphertext crosses the
  persistence RPC and the mothership opens it on request. The document-source and tracker connections
  were the last two outside that, and the reason was mechanical rather than a judgement about how
  sensitive a Figma or Jira token is. Their repositories decrypted INSIDE, which shuts both doors at
  once: a repository that decrypts can only be called by a key-holder, so proxying its read would have
  put a plaintext token on the wire, and it exposes no sealed field, so `/internal/secrets/unseal` had
  nothing to name either. That is why the prerequisite was always "give those repositories a
  sealed-blob read first, and only then a source-table entry".

  The row now carries its envelope. `DocumentConnectionRecord` and `TaskConnectionRecord` split into a
  stored `Sealed*Record` the repository persists and an open record the services read, with a new
  kernel port pair (`DocumentConnectionStore` / `TaskConnectionStore`) as the seam and one shared
  implementation over `createOrgSecretCipher`. All four repositories (D1 and Drizzle, documents and
  tasks) stopped decrypting and became ordinary sealed-blob stores.

  With that in place, `document_source_connection` and `task_source_connection` join the closed
  org-secret table, keyed by `(workspace, source)` under their own HKDF domains, and the persistence
  allow-list widens to the whole of both integrations: the connection repositories and the
  per-workspace source toggle, the document import/link writes and the role-link surface, and the task
  import/link writes including the atomic claim that holds one-task-per-ticket. Batched forms move
  with their point siblings rather than behind them, since `linkBlockMany`/`detachBlocks` are the same
  write as `linkBlock` and a claim whose import cannot land claims nothing.

  The store's surface is deliberately split by how much a caller needs opened rather than how much it
  reads. Listing summaries opens nothing, because a settings panel renders labels and opening a bag
  per connected source would turn one page load into a burst of unseal round trips and fail the whole
  list on the first unopenable row. Connecting and disconnecting read the summary for the same reason
  from the other direction: replacing or removing a connection is the remedy for a bag that has gone
  bad, so neither may be the call that needs the key.

  Dispatch-time document freshness now runs on a mothership-mode node. Its `credentials_unreadable`
  verdict stays a distinct gap and is worth more than it was: it no longer means "this deployment
  structurally cannot read the credentials" on every dispatch of every run, so its remaining causes are
  real faults. Its log line went back to `warn` accordingly.

  How many row identifiers a delegated unseal must carry is now declared once, in kernel's
  `ORG_SECRET_KEY_ARITY`, and enforced by the type system. It previously lived only in the server-side
  bindings table, which is the one part of a binding a caller has to get right and the one table a
  caller in `@cat-factory/integrations` cannot see. `DelegatedSecretRef` became a union over the source
  vocabulary, so a literal is checked against its own source's arity, and `orgSecretRef` is the door
  for a generic caller that never names a member. This matters more than it reads: a deployment with no
  delegate wired ignores the reference entirely, so a malformed one is invisible everywhere except the
  single deployment shape that delegates.

  Two behaviour changes worth knowing about. A credential bag that cannot be opened now raises instead
  of resolving to an empty bag, because an empty bag is indistinguishable from a connection saved with
  no credentials and every caller was re-deriving the difference from whatever the vendor said next. It
  raises a 503 carrying `reason: 'connection_credentials_unreadable'`, so the surfaces that genuinely
  cannot proceed refuse with translated copy rather than a generic server error. And the legacy
  plaintext `credentials` column fallback is gone: a row written before these tables were encrypted at
  all is no longer read as JSON and re-encrypted on the next write, so re-connect the affected source.
  Pre-1.0 internals break rather than grow a compatibility path, and keeping the fallback would have
  meant the unseal endpoint answering for a field that is sometimes not an envelope.

  Raising rather than emptying puts weight on WHO raises and to whom, so the failure is scoped to what
  actually failed. A batched open answers per source: the sources in one call are independent facts
  about independent vendors, and one rejection speaking for all of them would report a run's whole
  document corpus as unreadable because a single shelf entry drifted, or take the reply channel away
  from a healthy ticket because a different tracker's envelope went bad. Both read to an operator as
  the healthy sources being broken. A corpus-wide verdict is now reachable only when the stored-row
  query itself failed, where nothing about any source was learned.

  For the same reason, a surface whose job is to REPAIR an unopenable connection is not allowed to be a
  surface that needs the key. Re-connecting a tracker reads the old bag only to carry the
  platform-owned webhook secret across a vendor-credential rotation; refusing on that read left a
  workspace with no way out of a bad row at all, so it now degrades and says so, and the operator mints
  a fresh secret. Sealing rides the same delegation as opening, which is what keeps that from being a
  silent loss on a transient fault: a node that cannot reach its key service fails the write too, so
  nothing is overwritten. The setup check reports the fault as a verdict instead of failing, and the
  read-only webhook panel states it as a new `credentialsReadable: false` rather than reporting
  `configured: false`, which would send an operator to mint a secret over a bag that still holds the
  live one. Clearing the webhook secret still refuses, because clearing rewrites the bag minus a key
  and proceeding blind would replace the vendor credentials with an empty object.

- 70745b6: Link repositories, merge/pull requests and issues to the instance a workspace is actually
  connected to. A VCS connection (and each connect option) now carries `webUrl`, the browser-facing
  host derived from the provider's configured API base, and the SPA builds every repo link from it
  in the provider's own shape instead of hand-building `https://github.com/...`. A deployment whose
  API base does not name a host withholds those links rather than pointing at the provider's public
  instance. The source-control panel's pull-request vocabulary is provider-keyed, so a GitLab
  workspace sees merge requests.

  `AppConfig.gitlab` is now always present, shaped like its GitHub sibling: `apiBase` is the address
  of the instance a deployment talks to, and `enabled` alone carries the `GITLAB_TOKEN` opt-in for
  the single-token engine connection. Gating the whole config on that token had made the address
  unreadable on a deployment reaching GitLab any other way, so local mode's `GITLAB_PAT` shape got
  no links at all.

  Internal breaks, so a SPA build and a backend must be deployed together: `webUrl` is required on
  the connection and connect-option shapes, and `AppConfig.gitlab` is no longer optional.

### Patch Changes

- Updated dependencies [6c6dd0c]
- Updated dependencies [70745b6]
  - @cat-factory/kernel@0.270.0
  - @cat-factory/contracts@0.272.0
  - @cat-factory/orchestration@0.238.0
  - @cat-factory/integrations@0.148.0
  - @cat-factory/server@0.250.0
  - @cat-factory/node-server@0.191.0
  - @cat-factory/executor-harness@1.98.0
  - @cat-factory/agents@0.117.10
  - @cat-factory/gitlab@0.18.3
  - @cat-factory/prompt-fragments@1.0.20

## 0.120.2

### Patch Changes

- Updated dependencies [55310f6]
- Updated dependencies [55310f6]
  - @cat-factory/contracts@0.271.0
  - @cat-factory/kernel@0.269.0
  - @cat-factory/integrations@0.147.0
  - @cat-factory/server@0.249.0
  - @cat-factory/orchestration@0.237.0
  - @cat-factory/agents@0.117.9
  - @cat-factory/gitlab@0.18.2
  - @cat-factory/prompt-fragments@1.0.19
  - @cat-factory/node-server@0.190.1
  - @cat-factory/executor-harness@1.98.0

## 0.120.1

### Patch Changes

- Updated dependencies [17687a1]
  - @cat-factory/contracts@0.270.0
  - @cat-factory/kernel@0.268.0
  - @cat-factory/integrations@0.146.0
  - @cat-factory/orchestration@0.236.0
  - @cat-factory/server@0.248.0
  - @cat-factory/node-server@0.190.0
  - @cat-factory/agents@0.117.8
  - @cat-factory/gitlab@0.18.1
  - @cat-factory/prompt-fragments@1.0.18
  - @cat-factory/executor-harness@1.98.0

## 0.120.0

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

- 2b74bd0: Let a mothership open the org credentials a mothership-mode node holds no key for

  Mothership mode splits the encryption keys on purpose: a laptop seals its own agent and model
  credentials under a local key, and the mothership's `ENCRYPTION_KEY` never travels. That split is
  what made every sealed-blob repository safe to serve over the persistence RPC, and it is also what
  left those blobs unreadable on the node. A row a hosted teammate wrote is sealed under the
  mothership's key, so a mothership-mode node could save an infrastructure connection and never
  provision with it, save a Datadog connection and never probe with it, and four earlier slices parked
  a surface rather than ship it broken.

  `POST /internal/secrets/unseal` and `POST /internal/secrets/seal` close that. The node names the
  ROW, never the ciphertext: it posts a source from a closed table plus the row's identifiers, and the
  mothership re-reads the authoritative row from its own store, binds the workspace to an account
  exactly as the persistence RPC does, and decrypts under its own key. A compromised node token can
  therefore only ask for a value it could already have read had it held the key, in an account it can
  already reach, which is what keeps this from being a decryption oracle. The seal direction matters
  just as much: a mothership-mode node provisions environments, and a row it sealed locally would be
  unopenable by the mothership's own teardown with nothing saying so until a reclaim failed.

  Consumers reach it through one kernel seam, `createOrgSecretCipher`. With no delegate wired (every
  hosted deployment, and local mode over its own Postgres) it is a pass-through to the facade's own
  cipher, so nothing changes there.

  With provisioning writes now safe to persist, `environmentRegistryRepository.insert`/`update` join
  the persistence allow-list, and so does `softDelete`, the tombstone half every re-provision and
  every reclaim runs. A mothership-mode node therefore provisions, polls and tears down environments
  for real, and the ephemeral-environment self-test runs end to end. Provisioning and teardown take
  the delegate together rather than separately: teardown opens the very provision fields provisioning
  sealed, so a node holding one and not the other could stand infrastructure up and never reclaim it.

  A mothership-mode node may not itself answer the delegation endpoints. They are wired only where a
  facade holds its own main database, because a node's `ENCRYPTION_KEY` is the local key that seals
  its own agent credentials, and sealing an org row under it is the split this change removes.

  Behaviour change worth knowing about on an existing mothership-mode node: rows it previously sealed
  under its LOCAL key are no longer opened locally. Pre-1.0 internals break rather than grow a
  compatibility path, so re-save an affected environment or observability connection; the key-drift
  sweep reports them.

  Deliberately still off, and stated in the tracker: the document/task source connections (their
  repositories decrypt inside, so there is no sealed field for a row-addressed unseal to name), the
  mothership-side Slack residual, and the sealed-blob consumers a mothership-mode node does not
  currently drive. Each is a table entry plus service threading on the same pattern, not a new
  mechanism.

### Patch Changes

- Updated dependencies [01bb6d2]
- Updated dependencies [f0154ce]
- Updated dependencies [eac67c5]
- Updated dependencies [2b74bd0]
  - @cat-factory/contracts@0.269.0
  - @cat-factory/kernel@0.267.0
  - @cat-factory/orchestration@0.235.0
  - @cat-factory/server@0.247.0
  - @cat-factory/integrations@0.145.0
  - @cat-factory/gitlab@0.18.0
  - @cat-factory/executor-harness@1.98.0
  - @cat-factory/node-server@0.189.0
  - @cat-factory/agents@0.117.7
  - @cat-factory/prompt-fragments@1.0.17

## 0.119.2

### Patch Changes

- Updated dependencies [eaab22a]
  - @cat-factory/contracts@0.268.0
  - @cat-factory/kernel@0.266.0
  - @cat-factory/integrations@0.144.0
  - @cat-factory/server@0.246.0
  - @cat-factory/node-server@0.188.0
  - @cat-factory/agents@0.117.6
  - @cat-factory/gitlab@0.17.3
  - @cat-factory/orchestration@0.234.1
  - @cat-factory/prompt-fragments@1.0.16
  - @cat-factory/executor-harness@1.96.0

## 0.119.1

### Patch Changes

- Updated dependencies [74ea2bc]
  - @cat-factory/contracts@0.267.0
  - @cat-factory/kernel@0.265.0
  - @cat-factory/orchestration@0.234.0
  - @cat-factory/server@0.245.0
  - @cat-factory/agents@0.117.5
  - @cat-factory/gitlab@0.17.2
  - @cat-factory/integrations@0.143.1
  - @cat-factory/prompt-fragments@1.0.15
  - @cat-factory/node-server@0.187.2
  - @cat-factory/executor-harness@1.96.0

## 0.119.0

### Minor Changes

- 1c8df4a: Record what the agent's CLI said about the tool servers it loaded, beside what the dispatch decided

  A step's tool-server record has answered one question since it landed: what the platform wired for
  the agent, and what it withheld and why. It cannot answer the other one. A server that passes every
  check, resolves its credential, survives the budget and reaches the container can still fail to come
  up there: a vendor endpoint that 500s, a pinned `npx` package that no longer resolves, a token the
  vendor revoked between dispatch and launch. In every one of those the prompt promises the agent a
  tool that never exists, and the only evidence was the agent mentioning it in prose, if it noticed.

  The claude-code CLI announces its resolved session before its first model call, naming the MCP
  servers it loaded with a status each, plus the flat list of tools it will expose. The harness reads
  that one event and publishes it on the job view; the engine folds it onto the same
  `step.toolServers` record the dispatch wrote, and the step detail renders it on the existing chips.
  Both halves are kept, never merged into one status: the platform withholding a tool and the CLI
  failing to start one are different faults for different people.

  The distinctions this is built out of are the whole point, because each one reads as a healthy
  server if it collapses:

  - **Not observed is not "nothing was loaded."** Codex's CLI publishes no such report, nor does any
    image older than this one, nor a runner pool whose manifest does not map the field. All of them
    leave the record's observed half ABSENT, and the surface then says nothing at all rather than
    accusing every wired server on every deployment one release behind.
  - **Started-with-no-tools is not started.** A server that connects and exposes nothing reaches the
    agent exactly like one that was never wired, and every other signal about it says healthy, so a
    zero tool count gets its own sentence and an uncounted one stays absent.
  - **A status this build cannot map is not a fault.** The CLI's status words are a third party's
    vocabulary; an unrecognised one records as `unknown` and is rendered neutrally, because painting
    it red would send an operator to debug a working integration each time a CLI adds a word.

  Nothing branches on an observation: this is evidence for a person, not a control signal.
  Correspondingly it rides all three poll dispositions rather than just the live one — a job short
  enough to settle between two polls is never seen running, and a job that fails is the one whose
  post-mortem needs this most.

  Runner-pool operators who proxy the executor-harness verbatim gain
  `response.toolServersPath` on the manifest; leaving it unset costs the diagnostic and never
  produces a false one. Ships with runner image 1.95.0.

  On the public surface this is one additive optional field, `observed` on a step's `toolServers` in
  `GET /api/v1/debug/runs/:runId` (spec `1.24.0`), so a consumer written against the previous version
  parses everything it already knew. The one rule it has to carry across is the first distinction
  above: an absent `observed` is "no observation was made", never "the CLI loaded nothing".

### Patch Changes

- Updated dependencies [1c8df4a]
  - @cat-factory/executor-harness@1.96.0
  - @cat-factory/contracts@0.266.0
  - @cat-factory/kernel@0.264.0
  - @cat-factory/orchestration@0.233.0
  - @cat-factory/integrations@0.143.0
  - @cat-factory/server@0.244.0
  - @cat-factory/agents@0.117.4
  - @cat-factory/gitlab@0.17.1
  - @cat-factory/prompt-fragments@1.0.14
  - @cat-factory/node-server@0.187.1

## 0.118.0

### Minor Changes

- 6637bbd: Add GitLab Issues as a task source: import, search and setup check.

  `gitlab` joins `BUILTIN_TASK_SOURCE_KINDS`, so a shop that runs GitLab for both code and issues can
  link an issue onto a board block as agent context instead of connecting a second vendor beside its
  repositories. `GitLabIssuesProvider` stores no credentials of its own: it reads through the
  workspace's existing GitLab connection, the same credentialless shape GitHub Issues has. The
  recurring `bug-intake` schedule, the bug hunt, push intake and ticket writeback are the remaining
  slices ([`docs/initiatives/gitlab-issues-intake.md`](./docs/initiatives/gitlab-issues-intake.md)).

  The public-API `TaskSourceKind` enum gains a member (OpenAPI 1.25.0, SDKs regenerated). Additive on
  a closed vocabulary the clients already tolerate unknown members of, so a consumer built against
  1.24.0 keeps parsing every response it understood.

  Four internal shapes changed, none externally consumed:

  - `VcsClient` / `GitHubClient` gain an optional `searchProjectIssues(connection, ref, query)`.
    GitLab's global issue search accepts no project qualifier, so a repo scope cannot be expressed as
    query text there the way GitHub's `repo:` does; the scope is an argument instead, and the
    predicates ride a `ProjectIssueQuery` the vendor evaluates.
  - `TaskSourceProvider.fetchTask` takes `workspaceId`. A GitLab PAT connection is keyed on the
    workspace, not on the account owning the project, so without it the provider could only scan
    every connection on the deployment for one able to read the id.
  - `TaskSourceProvider` gains an optional `repoScope`, whose PRESENCE declares the source
    repo-backed. One member rather than a flag beside a matcher, because the same fact decides two
    things that must agree: that the source's search is handed a resolved repository, and that the
    workspace's imported rows narrow to one.
  - `TaskSourceState` gains `supportsIntake` and `ridesVcsProvider`, both derived from the registered
    provider: whether it implements the predicate search a schedule fires, and which VCS connection
    it authenticates through (so the settings panel can name the right remedy for an unavailable
    source instead of inferring one).

  Two live bugs are fixed on the way. A workspace connected to GitLab reported **GitHub Issues** as
  available (availability keyed on a connection EXISTING rather than on its provider, and both live in
  one row per workspace), so the source looked connected and its import resolved an empty projection.
  And the recurring-schedule form offered every connected source regardless of whether its provider
  could search on a schedule, which saved a schedule that could never fire.

  Three surfaces that hard-coded `github` are now asked of the registry, which is what makes a
  FOURTH source work rather than merely exist: the search route resolves a repo scope for any source
  declaring `repoScope` (a repo-backed source refuses a null one, so GitLab search was 422ing on
  every query), the imported-issue list narrows every repo-backed source's rows to the service's own
  repository, and the issue-tracker settings panel renders one card per registered source instead of
  one hard-coded card per built-in.

### Patch Changes

- Updated dependencies [6637bbd]
  - @cat-factory/contracts@0.265.0
  - @cat-factory/kernel@0.263.0
  - @cat-factory/gitlab@0.17.0
  - @cat-factory/integrations@0.142.0
  - @cat-factory/server@0.243.0
  - @cat-factory/node-server@0.187.0
  - @cat-factory/agents@0.117.3
  - @cat-factory/orchestration@0.232.1
  - @cat-factory/prompt-fragments@1.0.13
  - @cat-factory/executor-harness@1.94.0

## 0.117.2

### Patch Changes

- Updated dependencies [be9b8dc]
  - @cat-factory/contracts@0.264.0
  - @cat-factory/orchestration@0.232.0
  - @cat-factory/server@0.242.0
  - @cat-factory/agents@0.117.2
  - @cat-factory/gitlab@0.16.19
  - @cat-factory/integrations@0.141.2
  - @cat-factory/kernel@0.262.2
  - @cat-factory/prompt-fragments@1.0.12
  - @cat-factory/node-server@0.186.2
  - @cat-factory/executor-harness@1.94.0

## 0.117.1

### Patch Changes

- Updated dependencies [1025674]
- Updated dependencies [e5f7eb0]
  - @cat-factory/contracts@0.263.0
  - @cat-factory/server@0.241.0
  - @cat-factory/orchestration@0.231.0
  - @cat-factory/agents@0.117.1
  - @cat-factory/gitlab@0.16.18
  - @cat-factory/integrations@0.141.1
  - @cat-factory/kernel@0.262.1
  - @cat-factory/prompt-fragments@1.0.11
  - @cat-factory/node-server@0.186.1
  - @cat-factory/executor-harness@1.94.0

## 0.117.0

### Minor Changes

- 8cbd518: Let a code-registered prompt fragment name a LIVING document.

  A `documentRef` on a deployment-registered fragment used to be refused at boot, because every
  document source authenticated per workspace and there was no deployment-wide credential to read one
  with. A deployment now configures its own (`DOC_SOURCE_<SOURCE>_<FIELD>`, the field names taken from
  each provider's existing connect-form declaration), and a `builtin`-tier `documentRef` resolves
  through a new `DeploymentDocumentResolver` port, version-probed and cached under one
  deployment-wide group so a hundred workspaces folding one standard cost one fetch and one
  invalidation.

  The deployment's own credentials are read from the environment and nothing else. `DOCUMENT_SOURCES`
  governs which sources a WORKSPACE may connect, and `DOCUMENTS_ENABLED` and the connection encryption
  key govern whether tenant connections are stored at all; none of the three has any bearing on a
  standard the deployment configured centrally, whose credentials live in plaintext variables and are
  never persisted. So setting `DOC_SOURCE_NOTION_API_TOKEN` is the whole configuration, with no
  unrelated prerequisite to discover.

  `github` is the exception and it is declared, not inferred: its credential is a workspace's App
  installation, so the new `deploymentScoped` source trait is false for it and both boot validation
  and the provider refuse the scope. Boot now refuses only a `documentRef` this deployment cannot
  serve, naming which of the two causes applies.

  An unreachable source still degrades to the fragment's registered body, but no longer silently: the
  fallback logs a warning naming the fragment, tier and source, because the prompt is byte-identical
  either way and nothing downstream could otherwise tell a stale standard from a current one.

  In mothership mode the credential stays on the mothership and the node reads the resolved body over
  `POST /internal/prompt-fragments/document-bodies`.

  `DocumentSourceProvider.fetchDocument` / `probeVersion` now take `workspaceId: string | null`, where
  `null` is the deployment scope. An internal interface with no external consumers.

- 8cbd518: Make a runtime facade the whole extension surface a deployment needs.

  Each facade now re-exports the CONSTRUCTOR and the types for every app-owned registry it lets a
  deployment inject, not only the option that takes one. `gateRegistry`, `judgeRegistry`,
  `stepResolverRegistry`, `vcsRegistry` and `promptFragmentRegistry` were reachable options with no
  exported way to build a value, so the only route was a direct dependency on `@cat-factory/kernel` /
  `@cat-factory/gates` / `@cat-factory/prompt-fragments`, which publish at exact versions, so
  floating one past what the facade pins resolves a second physical copy and the registration lands
  where nothing reads it. The reusable-operation authoring types (`CustomTaskType`,
  `TaskTypePresentation`, `TaskTypeFieldDescriptor`, `TaskTypeFieldOption`, the shared
  `DescriptorField*` shapes, `PromptFragment`), the four descriptor helpers, the built-in
  `*_PIPELINE_ID` constants and `RegistrationProblem` come with them.

  `start()` / `startLocal()` / `createWorker()` take an `escalateRegistrationWarning` predicate,
  raising selected boot-validation warnings to errors. Boot must WARN on an unresolvable
  `defaultFragmentIds` id because it cannot tell a typo from an account/workspace-tier id that merges
  per workspace at run time; a deployment whose operations reference only fragments it registers
  itself knows that second cause does not apply, and can now say so instead of re-deriving the check
  in its own test suite.

  Additive throughout: no existing registration, option or export changes shape.

- 7a2730a: Fold a board's un-rolled spend inside its own delete, so the durable record ends where the board did

  `spend_days` is deliberately outside the workspace-delete cascade: money already spent is an
  account-level fact, and reclaiming it would shrink last quarter's TCO retroactively and silently.
  Keeping it out of that list was made real by bounding the sweep's rewrite to boards that still
  exist, because `token_usage` IS cascaded and an unbounded window DELETE would otherwise re-fold
  nothing and reclaim the deleted board's most recent days on the sweep's own schedule.

  That bound left the mirror-image gap, which this closes. The sweep reaches only boards that still
  exist, so a board's spend SINCE the last completed rollup day has never been folded when its delete
  begins, and its ledger rows go with the cascade before any later pass could see them. The loss was
  bounded by the sweep interval, permanent, and skewed worst for exactly the boards an operator
  deleted because they were expensive. `WorkspaceService.delete` now runs one final per-workspace fold
  before the cascade, beside the binary-artifact purge and for the same reason: afterwards there is
  nothing left to read.

  Three things make that fold a different shape from a sweep pass, and each was a decision rather than
  a detail:

  - **It walks to now in chunks instead of capping its window.** A sweep can leave a wide catch-up for
    its next pass; this board has no next pass, so the span cap becomes a chunk size rather than a
    truncation. Truncating would have introduced a second, quieter version of the same loss.
  - **It walks newest-first, on a budget, and one bad chunk does not end it.** The walk is unbounded
    by construction (a watermark left stale by an outage plans a ledger-retention's worth of chunks)
    and it runs inside a user's delete request rather than on a cron. Unbounded, on the Worker, it
    stops preserving the board's spend and starts preventing its deletion: the invocation dies before
    the cascade, and the retry reads the same watermark and plans the same walk. So the walk stops at
    `FINAL_SPEND_FOLD_BUDGET_MS` and a failing chunk costs only itself, which makes the ORDER decide
    what survives: newest-first, because every report window this rollup serves is anchored at now
    while the far end of a stale catch-up falls outside even the 90-day one.
  - **It does not touch the coverage marker.** `rolledUpThrough` is deployment-scoped and states how
    far the SWEEP has covered every board at once. One board's final fold covers no other board's
    days, and the marker only ever moves forward, so advancing it there would permanently present
    days nothing folded as covered.
  - **It keeps the still-exists guard anyway.** Called after the cascade the fold reads nothing, and
    an unguarded window DELETE would then reclaim the frozen rows the exclusion exists to keep. The
    guard makes the fold-then-cascade ordering a property of the query rather than of the call site,
    so both halves of "a rewrite may only delete what it can reproduce" live in the same statement.

  The resume point and the ledger-retention horizon are the sweep's own, which is why the pure walk
  (`spendRollupWindow` plus the new `finalSpendFoldPlan`) moved from `@cat-factory/orchestration` into
  kernel: the two callers sit in different layers and restating the horizon rule per caller is exactly
  how the delete path would end up stepping over days a sweep would still have folded. Facades now
  wire `tokenUsageRetentionMs` onto `CoreDependencies` so both derive it from one number.

  The fold is best-effort, which is a trade worth reviewing: refusing the delete on a sick rollup query
  would keep the spend foldable for a retry, but it would also render a reporting outage as a board
  that cannot be deleted. So the delete proceeds and what was not folded is named on one `warn`, whose
  fields keep the causes apart because they need different responses: what the ledger no longer holds
  (already unfoldable before the delete began), what the store refused, what the budget never reached,
  and a resume point that could not be read at all.

### Patch Changes

- Updated dependencies [8cbd518]
- Updated dependencies [8cbd518]
- Updated dependencies [7a2730a]
  - @cat-factory/contracts@0.262.0
  - @cat-factory/kernel@0.262.0
  - @cat-factory/integrations@0.141.0
  - @cat-factory/agents@0.117.0
  - @cat-factory/orchestration@0.230.0
  - @cat-factory/server@0.240.0
  - @cat-factory/node-server@0.186.0
  - @cat-factory/gitlab@0.16.17
  - @cat-factory/prompt-fragments@1.0.10
  - @cat-factory/executor-harness@1.94.0

## 0.116.2

### Patch Changes

- Updated dependencies [f7882cf]
- Updated dependencies [e6aa37d]
- Updated dependencies [aabfb4d]
  - @cat-factory/orchestration@0.229.0
  - @cat-factory/contracts@0.261.1
  - @cat-factory/server@0.239.2
  - @cat-factory/kernel@0.261.0
  - @cat-factory/node-server@0.185.2
  - @cat-factory/agents@0.116.8
  - @cat-factory/gitlab@0.16.16
  - @cat-factory/integrations@0.140.2
  - @cat-factory/prompt-fragments@1.0.9
  - @cat-factory/executor-harness@1.94.0

## 0.116.1

### Patch Changes

- Updated dependencies [9d6bce0]
  - @cat-factory/kernel@0.260.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/agents@0.116.7
  - @cat-factory/gitlab@0.16.15
  - @cat-factory/integrations@0.140.1
  - @cat-factory/orchestration@0.228.1
  - @cat-factory/prompt-fragments@1.0.8
  - @cat-factory/server@0.239.1
  - @cat-factory/node-server@0.185.1

## 0.116.0

### Minor Changes

- 24f76f1: Make the audit log readable, and make revoking a session actually end it

  **Breaking for existing sessions: everyone signs in again once after this deploys.** A session
  token now carries a `gen` claim, and one that carries none is refused rather than admitted. That is
  the deliberate choice: treating an absent claim as "current" would be a permanent bypass of the
  whole revocation mechanism, and it is the hole an attacker would aim at. The cost is a single
  re-login; the alternative is a dual-read path that never goes away. Internal wire shape, pre-1.0,
  per the repo's compatibility policy.

  Two enterprise loose ends, and they are the same story from both ends.

  The audit log has been WRITE-ONLY in the product since it landed. Privileged actions were recorded
  faithfully and there was no way to read them back: no route, no viewer, and no retention, so the
  one table designed to be kept for years was also the one growing without a bound. It now serves a
  keyset-paginated page to account admins and renders in an admin panel, as translated sentences
  composed from the row's machine-readable fields rather than from stored prose — which is what lets
  a row written today read correctly for somebody in another language years later, and what makes an
  action this build no longer declares render as "unrecognised" instead of splicing `undefined` into
  an operator's screen. Names are resolved at render time in one batched read per page, and a name
  that no longer resolves stays null so the id shows: the person being gone is exactly the thing the
  row is kept to record. A failed READ is rendered differently from an empty log at every layer,
  because an audit viewer that reports an outage as "nothing happened" tells an admin the reverse of
  the truth. Retention arrives with its own knob (`AUDIT_EVENT_RETENTION_DAYS`, default 730 days),
  which is the governance half of keeping the log in its own store: it cannot be shortened as a side
  effect of tuning a telemetry window, and the prune takes a cutoff and nothing else, so it can never
  be used to remove the record of one inconvenient thing.

  The other end is enterprise SSO, whose whole offboarding promise is "we disabled them in the
  identity provider and they lost access". A stateless signed session could not deliver that: group
  membership was already re-read on every sign-in, so a removed person could not get a NEW session,
  but the one they were already holding stayed valid until it expired. Each user row now carries a
  session generation that every token is stamped with, so ending every session a person holds is one
  write with nothing to enumerate. An SSO sign-in the directory refuses now cuts their live sessions
  as well as withholding a new one; an admin can do the same for a member who has left or lost a
  laptop (recorded in the audit log, naturally); and anyone can sign themselves out everywhere.

  An SSO refusal only ends existing sessions when the DIRECTORY is what refused. A refusal caused by
  a claim that never arrived (a dropped `groups` scope, a renamed claim name, a provider that stopped
  marking an address verified) still blocks the login, but withholds the revocation: those refusals
  are indistinguishable from "removed from every group", and they fire for everybody at once, so
  treating them as offboardings would turn one configuration regression into a deployment-wide forced
  sign-out.

  Two decisions worth knowing. A role change deliberately does NOT revoke: the RBAC gate re-reads
  roles on the next request and the token carries none, so coupling them would sign a person out of
  every board because their role on one was adjusted. And the check is a NEW read on a path that
  previously touched no store at all — served through the app cache with invalidation on every bump,
  which means the Worker (whose isolates share no invalidation bus, so the entry passes through
  there) pays a real per-request read. That is accepted rather than discovered: a cache with a TTL
  would go on admitting a bearer a peer isolate had already revoked, and "they lost access, within
  the minute" is not the claim an offboarding story can make.

  Still open, and stated so nobody assumes otherwise: run start/stop/retry are not yet audited. That
  half needs the mothership to derive the row from what it observes rather than accept it from a
  node's say-so, since a node cannot be allowed to write events that name their own actor — the
  design question is written up in `docs/initiatives/audit-log-and-session-revocation.md`.

### Patch Changes

- Updated dependencies [24f76f1]
- Updated dependencies [964cfa6]
- Updated dependencies [964cfa6]
  - @cat-factory/contracts@0.261.0
  - @cat-factory/integrations@0.140.0
  - @cat-factory/kernel@0.259.0
  - @cat-factory/orchestration@0.228.0
  - @cat-factory/server@0.239.0
  - @cat-factory/node-server@0.185.0
  - @cat-factory/agents@0.116.6
  - @cat-factory/gitlab@0.16.14
  - @cat-factory/prompt-fragments@1.0.7
  - @cat-factory/executor-harness@1.94.0

## 0.115.1

### Patch Changes

- Updated dependencies [ae44914]
- Updated dependencies [4be3510]
- Updated dependencies [3b89686]
  - @cat-factory/contracts@0.260.0
  - @cat-factory/integrations@0.139.0
  - @cat-factory/server@0.238.0
  - @cat-factory/orchestration@0.227.0
  - @cat-factory/kernel@0.258.0
  - @cat-factory/agents@0.116.5
  - @cat-factory/gitlab@0.16.13
  - @cat-factory/prompt-fragments@1.0.6
  - @cat-factory/node-server@0.184.1
  - @cat-factory/executor-harness@1.94.0

## 0.115.0

### Minor Changes

- 11dae5b: Durable cost attribution: a spend rollup with no retention behind the TCO axes

  The Reports view could already slice spend by repository and by tracker ticket, but it could not
  answer either question durably, and nothing said so. Every attribution past the workspace was
  assembled at READ time from three mutable sources: `token_usage`, pruned at ~13 months;
  `agent_runs`, the row a call reaches the board through, prunable too; and the LIVE
  `services.repo_github_id` / `tasks.linked_block_id` links, which an operator re-points whenever a
  service moves repository or an issue is re-imported. So "what did this repository cost us last
  quarter" gave one answer this month and a different, silently smaller one next year, and the ledger's
  own durable rollup stopped at `(billing, vendor, provider, model)` for the current billing period.

  The retention sweep now materialises `spend_days`: one row per `(workspace, UTC day, run, agent kind,
provider:model, billing, vendor)`, carrying the board shape FROZEN at rollup time: the run, its block
  and title, its service and name, its repository id and `owner/name`, its task type, its ticket ref,
  plus the account and board names. A read of it joins nothing, so nothing downstream can be re-pointed
  or pruned out from under a report. `run` joins `repo` and `ticket` as a spend dimension on both
  sources, so the finest TCO question ("what did that pipeline execution cost") is a grouped query too.

  **It is never pruned, and that is the feature.** A TCO table has to outlive the ledger it was folded
  from; one with a window is just a slower ledger. There is no `deleteOlderThan` on
  `SpendRollupRepository` at all, so the absence is structural rather than an omission a future sweep
  could quietly fill, and the table is excluded from the workspace-delete cascade for the reason
  `audit_events` is: money already spent is an account-level fact that deleting a board does not undo.
  Keeping it out of that list is only half of keeping it, though, because the sweep rewrites a trailing
  window by deleting it and re-folding `token_usage`, which IS cascaded: for a deleted board the re-fold
  reads nothing, so an unbounded window DELETE would have reclaimed its most recent days on the sweep's
  own schedule with no further operator action. The rewrite is therefore scoped to workspaces that still
  exist, which is the general rule that a rewrite may only delete what it can reproduce. What makes the
  whole thing affordable is the grain. A run writes hundreds of ledger rows and a handful of these, so
  the table grows with run volume, never call volume. The arithmetic is written down in
  `backend/docs/storage-and-retention.md` §1c rather than left to be re-derived.

  Reports routes by window: `24h`/`7d` still scan the ledger (millisecond-exact, and a sweep cadence
  would show there as a missing tail), `30d`/`90d` read the rollup. Mixing sources inside one window was
  rejected: every breakdown partitions the same rows and the totals fold from one of them, so a hybrid
  would leave the tiles and the cards describing different data. The freshness cost is stated rather
  than hidden: the projection carries `source` and `rolledUpThrough`, and the panel renders "no rollup
  yet" / "the rollup is behind" / "complete through <date>", because an un-materialised rollup and an
  account that spent nothing produce the same empty breakdown.

  Worth a reviewer's attention: the fold has to REPRODUCE the ledger read's two fan-out guards (the
  pre-aggregated service label over colliding frame block ids, and the deterministic lowest-ref pick for
  a block linked from two tickets) rather than merely resemble them, or an account's spend would change
  the moment a reader switched from `7d` to `30d`; the conformance suite asserts every dimension of the
  rollup equals the ledger's answer on the same fixture, and then deletes the ledger, the runs and the
  tickets and asserts the rollup is unchanged, and it does the same after deleting the boards themselves,
  which is the only way to see that the account scope rides the row's own frozen `account_id` rather than
  a `workspaces` join.

  Unlike the daily run rollup, the pass resumes from its own watermark instead of a fixed lookback,
  because a day missed here is missing from the only durable record of it. Each pass is span-capped, and
  the first pass backfills 90 days so the longest window is not under-reported for a quarter while
  looking complete. That backfill bound is deliberately NOT reused as the catch-up horizon: it answers
  how much history a deployment adopts on its first pass, whereas a resumed pass has no such choice and
  the ledger still holds every day since the watermark, so the horizon follows
  `TOKEN_USAGE_RETENTION_DAYS` instead. Past the ledger's own retention there is nothing left to fold, and
  the pass logs the span it gave up on, because a high-water mark structurally cannot represent a hole.
  `rolledUpThrough` is the last COMPLETE day rather than the newest one written, since a sweep firing at
  noon folds a day that keeps accruing after it returns; the panel measures its lag against the same day
  boundary, so the verdict does not swing with the hour the report was opened. Ordering in the sweep is a
  correctness property, not style: the rollup reads `token_usage`, so it runs before the prune that
  bounds it, and it now shares that prune's window so the catch-up walk cannot step over days the next
  statement is about to delete.

### Patch Changes

- Updated dependencies [11dae5b]
  - @cat-factory/contracts@0.259.0
  - @cat-factory/kernel@0.257.0
  - @cat-factory/orchestration@0.226.0
  - @cat-factory/node-server@0.184.0
  - @cat-factory/agents@0.116.4
  - @cat-factory/gitlab@0.16.12
  - @cat-factory/integrations@0.138.3
  - @cat-factory/prompt-fragments@1.0.5
  - @cat-factory/server@0.237.1
  - @cat-factory/executor-harness@1.94.0

## 0.114.4

### Patch Changes

- 11a2966: Say which tool servers a step actually had, on the step

  A run whose agent kind declares MCP tool servers could drop any of them for seven different
  reasons, and until now every one of those was stated in two places nobody looks: the agent's own
  system prompt, and one backend `warn` line. From the outside a run that quietly went without its
  issue tracker was indistinguishable from a run whose agent simply chose not to use it, which is the
  question an adopting deployment asks first and the platform could not answer.

  **A dispatch now records what it decided on the step** (`PipelineStep.toolServers`): the servers it
  wired (id, label, transport, and the narrowed `allowedTools` where the definition set one), the ones
  it dropped each with its reason, and the agent kind those lists belong to. The step detail renders
  them as chips, with translated copy per reason in every locale, and hides itself when the record
  holds nothing (a kind that declares no tool servers, which is every step on a deployment that
  registers none).

  The kind is stamped by the engine as it folds, from the same parameter that feeds `step.dispatches`,
  because a step's own kind is routinely not what ran: a `ci` gate escalates to `ci-fixer`, a tester
  hands off to `fixer`, a two-phase coder dispatches twice. Each of those resolves its own
  declarations and overwrites the record, so without the stamp the chips would credit one agent's
  capabilities to another. The step detail names whose they are whenever the two differ.

  **Recorded on the STEP rather than on the agent-context telemetry snapshot**, which is where the
  same facts sat inside an untyped `extras` bag. The snapshot is double-gated behind
  `LLM_RECORD_PROMPTS` and the per-workspace `storeAgentContext`, and pruned on the telemetry
  retention window, so a surface reading it would be blank on any deployment that simply has prompt
  recording off. "Which tools did this step have" is an ordinary question about a run, not an opt-in
  debugging artifact. It also costs no telemetry migration: the run row already carries its steps as
  JSON.

  **Public API (additive, `info.version` 1.21.0):** each step of `GET /api/v1/debug/runs/:runId` now
  carries the same record, so a diagnosing reader can tell "the agent never had the tool" from "the
  agent had it and did not call it", which the tool-call trajectory alone cannot show. The snapshot's
  `extras.toolServers` / `extras.unavailableToolServers` keep being served, deprecated, projected from
  the step's own record so the two cannot disagree; the removal window is in `backend/docs/public-api.md`.

  It is written at dispatch and never re-derived, for the same reason the model and the leased
  subscription token are: the poll site rebuilds the job handle from the step alone, and whether a
  server was servable depended on the resolved harness plus the facade's secret and OAuth resolvers at
  that moment. A workspace that fills in a missing credential an hour later must not make a step that
  ran without the tool read as one that had it. Absent and both-lists-empty stay different states:
  absent is "no container dispatch recorded here", both-empty is "a dispatch ran and its kind declared
  none".

  **The unavailability vocabulary moved to `@cat-factory/contracts`, and kernel's
  `UnavailableToolServer['reason']` is now typed against it.** The SPA cannot see kernel, so leaving
  the union there would have made the run surface's copy a hand-written duplicate of a closed list,
  and a member added on one side only renders as a blank chip. Which member a dispatch picks is still
  decided in kernel. Internal break: the seven reason strings are unchanged, but the type now aliases
  `ToolServerUnavailableReason`.

  **Tool servers and capability credentials also gain their first cross-runtime assertions.** The
  conformance harness could not reach either, because the suite runs a `FakeAgentExecutor` that
  composes no job body, and the values are write-only on every wire. `ConformanceApp.toolServerDispatch()`
  (built by `makeToolServerDispatchProbe` over each facade's OWN container) drives the same
  `resolveToolServers` a dispatch does with the chain that facade actually composed, so a facade that
  wired its per-workspace credential store behind the deployment environment (or not at all) now
  fails a test instead of handing its agents an unauthenticated server. It asserts a stored credential
  reaching the job body under its declared channel, an unstored one dropping the server as
  `missing_secret` in the same resolution (the per-KEY composition rule), and a Pi run dropping
  everything as `harness_unsupported`.

  What this does NOT answer is a server that was wired and whose CLI failed to start it anyway: that
  needs the agent CLI's own startup report, which is a harness change and therefore a runner-image
  bump. It is the remaining half of the tracker's slice 5; the probe already diagnoses the same
  condition interactively.

- Updated dependencies [6076cf1]
- Updated dependencies [2fdb08d]
- Updated dependencies [11a2966]
  - @cat-factory/agents@0.116.3
  - @cat-factory/kernel@0.256.0
  - @cat-factory/orchestration@0.225.0
  - @cat-factory/server@0.237.0
  - @cat-factory/contracts@0.258.0
  - @cat-factory/node-server@0.183.3
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/gitlab@0.16.11
  - @cat-factory/integrations@0.138.2
  - @cat-factory/prompt-fragments@1.0.4

## 0.114.3

### Patch Changes

- Updated dependencies [00bff05]
  - @cat-factory/contracts@0.257.0
  - @cat-factory/orchestration@0.224.0
  - @cat-factory/server@0.236.0
  - @cat-factory/agents@0.116.2
  - @cat-factory/gitlab@0.16.10
  - @cat-factory/integrations@0.138.1
  - @cat-factory/kernel@0.255.1
  - @cat-factory/prompt-fragments@1.0.3
  - @cat-factory/node-server@0.183.2
  - @cat-factory/executor-harness@1.94.0

## 0.114.2

### Patch Changes

- Updated dependencies [ab0c228]
  - @cat-factory/contracts@0.256.0
  - @cat-factory/kernel@0.255.0
  - @cat-factory/integrations@0.138.0
  - @cat-factory/orchestration@0.223.0
  - @cat-factory/server@0.235.0
  - @cat-factory/agents@0.116.1
  - @cat-factory/gitlab@0.16.9
  - @cat-factory/prompt-fragments@1.0.2
  - @cat-factory/node-server@0.183.1
  - @cat-factory/executor-harness@1.94.0

## 0.114.1

### Patch Changes

- Updated dependencies [184d263]
- Updated dependencies [ee6ce7c]
  - @cat-factory/agents@0.116.0
  - @cat-factory/orchestration@0.222.0
  - @cat-factory/kernel@0.254.0
  - @cat-factory/contracts@0.255.0
  - @cat-factory/server@0.234.0
  - @cat-factory/node-server@0.183.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/gitlab@0.16.8
  - @cat-factory/integrations@0.137.2
  - @cat-factory/prompt-fragments@1.0.1

## 0.114.0

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
  - @cat-factory/prompt-fragments@1.0.0
  - @cat-factory/kernel@0.253.0
  - @cat-factory/contracts@0.254.0
  - @cat-factory/orchestration@0.221.0
  - @cat-factory/agents@0.115.0
  - @cat-factory/server@0.233.0
  - @cat-factory/node-server@0.182.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/gitlab@0.16.7
  - @cat-factory/integrations@0.137.1

## 0.113.4

### Patch Changes

- Updated dependencies [5202fb9]
  - @cat-factory/integrations@0.137.0
  - @cat-factory/orchestration@0.220.0
  - @cat-factory/kernel@0.252.0
  - @cat-factory/contracts@0.253.0
  - @cat-factory/server@0.232.0
  - @cat-factory/node-server@0.181.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/agents@0.114.7
  - @cat-factory/gitlab@0.16.6

## 0.113.3

### Patch Changes

- @cat-factory/node-server@0.180.2

## 0.113.2

### Patch Changes

- Updated dependencies [e845d65]
  - @cat-factory/kernel@0.251.0
  - @cat-factory/server@0.231.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/agents@0.114.6
  - @cat-factory/gitlab@0.16.5
  - @cat-factory/integrations@0.136.2
  - @cat-factory/orchestration@0.219.1
  - @cat-factory/node-server@0.180.1

## 0.113.1

### Patch Changes

- Updated dependencies [4c071ec]
  - @cat-factory/contracts@0.252.0
  - @cat-factory/kernel@0.250.0
  - @cat-factory/orchestration@0.219.0
  - @cat-factory/server@0.230.0
  - @cat-factory/node-server@0.180.0
  - @cat-factory/agents@0.114.5
  - @cat-factory/gitlab@0.16.4
  - @cat-factory/integrations@0.136.1
  - @cat-factory/executor-harness@1.94.0

## 0.113.0

### Minor Changes

- 3fbc87e: Failing-call-first debugging: pin what broke, and let both drill-downs narrow to it

  The observability panel already held everything needed to diagnose a run, and asked an operator to
  find it by scrolling. Worse, one whole failure class had nowhere to be found from: a tool that
  errors executes INSIDE the container, so the model call that requested it still records `ok` with a
  clean finish reason. Every LLM number on the panel, and every rollup on the debug overview, reads
  healthy right up to the moment the run dies. The remote-debugging doc named this as a known
  limitation ("tool-execution errors are rows, but no rollup counts them"); this closes it on both
  surfaces.

  **The panel opens with the failure.** A pinned section above the lists carries the run's structured
  `failure` record (kind, message, hint, the step it died on) beside the last model call that failed
  and the last tool call that failed, each with a count of the earlier ones and a jump into the list.
  It appears whenever there is something to pin rather than only on `status === 'failed'`: a run still
  in flight whose calls are already erroring is exactly the one worth interrupting.

  The two evidence rows are shown in a fixed order and are deliberately NOT ranked against each other.
  They come from different clocks (a call's recorded `createdAt`, a tool span's harness-stamped
  `startedAt`), so "which happened last" is not a comparison this can make honestly, and a confident
  wrong ordering is worse than none in a section whose whole job is to be believed.

  **When nothing failing can be pinned, it says which of four things that means.** A sink's read
  FAILED (nothing can be concluded, and this outranks the rest); both sinks answered and nothing
  failed (the cause left no row: look at the engine); neither sink recorded anything (the run died
  before any agent work); or one answered with rows and the other did not. A single "no failures
  found" would render a clean bill of health over a run that died with no telemetry at all, which is
  the same false picture in the opposite direction. A read still in flight is none of the four: the
  section withholds every verdict until both sinks have answered.

  **Both drill-downs narrow by outcome.** The model-call list gets `All / Failed / Cut short / OK`
  with live counts, split that way because a failed call and a truncated one need different fixes
  (transport, proxy or spend-gate trouble versus an output-limit conversation). The tool-call
  trajectory is a new panel view with `All / Failed / OK`, keeping trajectory order under every
  filter: reading the failures in sequence is what tells one tool that failed and was worked around
  from an edit loop stuck repeating the same failing call.

  On the public API (OpenAPI `1.14.0`): `GET /api/v1/debug/runs/:runId/tool-calls` takes
  `?outcome=ok|error`, composing with both orders and with `?jobId=`.
  `failure_outside_model_calls` now states what the trajectory actually holds instead of pointing at
  it unconditionally.

  **That parameter REPLACES the `?ok=true|false` filter published in `1.13.0`, which is a breaking
  change taken deliberately as a minor.** `?ok=` shipped one release ago, has no known consumer, and
  two drill-downs answering the same question under two spellings is the wart this change exists to
  remove: an operator who learned `?outcome=` on the model-call list should not have to discover that
  the tool-call list spells it differently. A picklist also lets the set gain a member (a timeout, a
  refusal) where `true|false` could only be retyped. Had there been an adopter, the honest shape would
  have been `?ok=` served beside `?outcome=` for a release window, not a rename.

  The run's failure count stays on the `toolCalls` rollup (`totals.failures`) rather than being copied
  onto `sinks.toolCalls`: both come out of ONE `(agentKind, tool)` aggregate pass, and a second copy
  could only be a second read of the same rows, which is how a `failed` above its own `count` gets
  published.

  The narrowing is applied IN SQL on all three stores, which is the part that makes it correct rather
  than convenient: the trajectory read is bounded to a PREFIX of the run, so a filter applied after
  the read would report no failures on any run whose failures came after its opening moves. Internal
  break: the trajectory/page queries gain an `ok?: boolean` field, and the panel's per-run counts are
  folded from `AgentToolCallRepository.summarizeByExecution` rather than counted by a query of their
  own.

  **The panel obeys the same prefix rule the stores do.** It reads the sink through two
  workspace-scoped routes rather than one. `tool-call-failures` is the headline, made on open: the
  run's exact `{ total, failed }` from the store's aggregate pass, plus the failing rows narrowed in
  SQL. `tool-calls` is the browse view, loaded only when the trajectory is opened, because it carries
  every captured argument and result the run produced. Folding them into one read would either make
  the headline wait on megabytes or make its counts a statement about the run's opening moves wearing
  the run's name, and the second is the same false all-clear from the other direction. The trajectory
  now reports `truncated`, and a bounded view says so on screen instead of presenting a prefix as
  everything the run did.

  **One classification, in one place.** `LLM_WARNING_FINISH_REASONS`, the `ok | warning | error`
  vocabulary and the rule that produces it now live once in `@cat-factory/contracts`. Four copies
  existed: kernel's `LlmCallOutcomeFilter`, orchestration's `classifyCall`, the debug wire's
  `debugCallOutcomeSchema`, and a hand-written list in the SPA. All four now alias or re-export the
  one definition, so a member added to the vocabulary cannot exist in the badge and not in the filter.
  Internal break: `classifyCall`/`isWarningFinishReason` are exported from `@cat-factory/orchestration`
  as `classifyLlmCallOutcome`/`isLlmWarningFinishReason`.

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
  - @cat-factory/orchestration@0.218.0
  - @cat-factory/server@0.229.0
  - @cat-factory/node-server@0.179.0
  - @cat-factory/executor-harness@1.94.0
  - @cat-factory/integrations@0.136.0
  - @cat-factory/agents@0.114.4
  - @cat-factory/gitlab@0.16.3

## 0.112.1

### Patch Changes

- Updated dependencies [6ccc104]
  - @cat-factory/integrations@0.135.0
  - @cat-factory/orchestration@0.217.1
  - @cat-factory/server@0.228.1
  - @cat-factory/node-server@0.178.1
  - @cat-factory/executor-harness@1.92.2

## 0.112.0

### Minor Changes

- e7e27ee: Publish the verification report onto a multi-repo run's PEER pull requests, scoped per repo

  A cross-service run opens one pull request per repo it changed; only the own-service one carried a
  report, so a reviewer on a connected service's PR saw none of the run's evidence. Every pull request
  now gets one, and each is composed for the pull request it lands on.

  The reports are deliberately not identical. Run-scoped evidence (the CI gate's aggregate verdict, the
  tester, the judges, the environments, the merge decision) is reported on all of them, because it
  governs the whole set. The three sections that are statements about the own-service repo (pre-PR
  validation, the bugfix reproduction proof and the `spec/` requirement join) are withheld from a peer's
  copy, with a note naming the own-service PR where they live: restating them would attribute one repo's
  evidence to another repo's diff.

  The report payload gains an optional `scope` (`PR_VERIFICATION_REPORT_VERSION` 7, OpenAPI 1.15.0),
  which is additive: absent means the own-service PR, exactly as before. `GET /api/v1/runs/:runId/report`
  keeps answering the complete own-service copy.

  Publishing to N pull requests costs what publishing to one did. `resolveTargets` is the only
  addressing step a settlement runs, the run-scoped evidence is read once and layered per pull request,
  and a resolved target carries its own repo and connection so the write reads nothing. The multi-repo
  repo resolver also reads the workspace's repo projection through the same per-workspace cache as the
  singular one, which it did not before (harmless while its only caller was dispatch, a full uncached
  re-list once the report started calling it on every settled step).

  `hostMarkdown` gains `link`/`cellLink`, the boundary for a link TARGET: an unusable or non-`http(s)`
  URL renders as plain text instead of a link. The existing helpers only ever covered link text, and a
  peer report links to a pull-request URL the harness reported.

  Internal break: the `PrVerificationReportPublisher` port replaces `resolveTarget` with `resolveTargets`,
  `publish` takes `(workspaceId, target, section)` (no block id, since it no longer resolves anything),
  and `PrReportTarget` gains a required `connection`. The `no_pull_request` / `no_repo` skip reasons are
  gone with the resolution they described: nowhere to publish is an empty `resolveTargets`.

### Patch Changes

- Updated dependencies [e7e27ee]
  - @cat-factory/contracts@0.250.0
  - @cat-factory/kernel@0.248.0
  - @cat-factory/orchestration@0.217.0
  - @cat-factory/server@0.228.0
  - @cat-factory/node-server@0.178.0
  - @cat-factory/agents@0.114.3
  - @cat-factory/gitlab@0.16.2
  - @cat-factory/integrations@0.134.1
  - @cat-factory/executor-harness@1.92.2

## 0.111.2

### Patch Changes

- Updated dependencies [cad3408]
- Updated dependencies [eee42e9]
- Updated dependencies [cad3408]
  - @cat-factory/server@0.227.0
  - @cat-factory/integrations@0.134.0
  - @cat-factory/node-server@0.177.3
  - @cat-factory/executor-harness@1.92.2
  - @cat-factory/orchestration@0.216.1

## 0.111.1

### Patch Changes

- Updated dependencies [53cd697]
  - @cat-factory/contracts@0.249.0
  - @cat-factory/kernel@0.247.0
  - @cat-factory/integrations@0.133.0
  - @cat-factory/orchestration@0.216.0
  - @cat-factory/server@0.226.0
  - @cat-factory/agents@0.114.2
  - @cat-factory/gitlab@0.16.1
  - @cat-factory/node-server@0.177.2
  - @cat-factory/executor-harness@1.92.2

## 0.111.0

### Minor Changes

- 6d3f784: Local mode takes its source-control token from the sign-in screen

  A local deployment with no `GITHUB_PAT` / `GITLAB_PAT` used to send a developer to the right
  token page and then have nowhere to put the result: the token had to go into `.env`, followed by
  a restart. The sign-in screen now accepts it directly, and it becomes the deployment's own
  credential (sealed on the machine under `ENCRYPTION_KEY`), live for the next dispatch, gate probe
  and repo read. `.env` still wins where it is set, and closes the browser flow.

  `@cat-factory/server` additionally exports `githubRepoOrigin`, the clone origin a dispatch already
  fell back to, so a facade whose own resolver handles only the non-GitHub case can delegate the
  GitHub half instead of restating the URL.

  Internal breaks in the affected packages: `VcsIdentityEntry.configuredToken` and
  `CoreDependencies.sharedStackCloneToken` are now getters, `buildGitLabEngineClient` takes a token
  or a getter, and the local facade's `createLocalGitHubClient` / `createLocalGitLabClient` take a
  token getter and always return a client (an unconfigured deployment REFUSES on use, naming the
  fix, rather than presenting no client at all).

### Patch Changes

- Updated dependencies [6d3f784]
  - @cat-factory/kernel@0.246.0
  - @cat-factory/server@0.225.0
  - @cat-factory/contracts@0.248.0
  - @cat-factory/gitlab@0.16.0
  - @cat-factory/integrations@0.132.0
  - @cat-factory/orchestration@0.215.0
  - @cat-factory/executor-harness@1.92.2
  - @cat-factory/agents@0.114.1
  - @cat-factory/node-server@0.177.1

## 0.110.1

### Patch Changes

- Updated dependencies [0937581]
- Updated dependencies [250b7dc]
  - @cat-factory/contracts@0.247.0
  - @cat-factory/kernel@0.245.0
  - @cat-factory/server@0.224.0
  - @cat-factory/node-server@0.177.0
  - @cat-factory/agents@0.114.0
  - @cat-factory/orchestration@0.214.0
  - @cat-factory/gitlab@0.15.43
  - @cat-factory/integrations@0.131.1
  - @cat-factory/executor-harness@1.92.2

## 0.110.0

### Minor Changes

- 7f5ed08: Aggregate tool-execution failures: a rollup, a signal and an `?ok=` filter

  A failed tool call was a row nowhere counted. The trajectory sink recorded each one (`ok: false`,
  with what the tool returned), and nothing above it added them up: the run overview reported only how
  many tool calls the run made, no filter narrowed a page to the failures, and no signal was derived
  from them. That is the one class of failure the LLM telemetry beside it structurally cannot see: a
  rejected edit or a non-zero command is a perfectly healthy model call whose result came back bad, so
  a run stuck re-running a broken tool reports a clean model side and an inexplicable death. Finding
  it meant paging the whole trajectory and reading each row's `ok` by eye.

  `AgentToolCallRepository.summarizeByExecution` is now the one GROUP BY, at the `(agentKind, tool)`
  grain, and it REPLACES the bare `countByExecution`: the overview's `sinks.toolCalls.count`, its new
  `toolCalls` rollup and both of that rollup's breakdowns are folds over the same cells, so a count and
  a breakdown that disagree is not a representable state. The grain keeps both halves deliberately,
  because the finding is the CONCENTRATION: one agent kind retrying one tool is a stuck loop, the same
  count scattered over nine tools is an agent exploring, and either axis alone folds that away. Every
  level carries `failureRate` beside its counts (34 of 36 and 34 of 3,600 are the same number and
  opposite diagnoses) and a run that called no tools reports it as `null` rather than a clean 0%, which
  would file "nothing happened" beside "everything worked".

  Two signals ride it, and their severities carry the difference between them. `tool_calls_failed` is
  an `info` reporting the run-wide count with its ratio: a failing tool call is the ordinary shape of
  an agent loop (a test that fails before it is fixed, a `grep` that matches nothing), so as a warning
  it would fire on most healthy runs and cost the severity ordering the thing it is for.
  `tool_retry_loop` is the `warning`, firing only where the failures concentrate on one
  `(agentKind, tool)` cell that is both mostly-failing and has failed enough times to not be a single
  bad command. It selects among the cells that QUALIFY rather than testing the run's most-failed one,
  which is not the same thing: ranking first would hide a fixer wedged 5-for-5 on `apply_patch` behind
  a coder's 6 failures across 100 healthy `bash` calls, silently missing the run the sink exists for.
  `failure_outside_model_calls` now reads the sink before deciding where to send the reader: failing
  tool calls to start at, a recorded loop with none in it (so what is left is the engine), or no
  trajectory at all — which is unrecorded rather than uneventful, and was previously indistinguishable
  from a clean one.

  Public API 1.12.0 → 1.13.0, additive: `?ok=true|false` on `GET /api/v1/debug/runs/:runId/tool-calls`
  (both orders, applied in SQL, because a caller filtering a page itself has already spent that page's
  `limit` on the calls that worked) and the `toolCalls` block on the run overview. The four SDK clients
  and the MCP facade are regenerated. Worth a reviewer's attention: `countByExecution` is gone from the
  kernel port, so all three telemetry stores, the mothership read-through and its bounded-read table
  move together, and the new aggregate is classified `telemetry` in the drift guard rather than routed
  over the persistence RPC.

  No migration, and the aggregate is knowingly costlier than the COUNT it replaces: the existing run
  index served that count without touching the table, while grouping reads `agent_kind`, `tool` and
  `ok` off each row. A covering index would buy that back and is the wrong trade here: this sink is
  append-hot (a row per tool call of every run) and the aggregate runs once per debug overview, so a
  fifth index would tax the hot path for the rare read. Either way the scan is bounded by one run's
  rows.

- 4e4d1b4: OAuth for external MCP tool servers, so the OAuth-first hosted ecosystem (Linear, Atlassian,
  Figma, Slack's remote server) is reachable at all. A remote (`http`) declaration may now carry
  `oauth`: the `authorization_code` grant, which a `secrets.manage` holder completes once per board
  from the Infrastructure window, and `client_credentials`, which needs no human and covers an
  internal or partner server. Endpoints are discovered per the MCP authorization spec (RFC 9728 →
  RFC 8414 → OIDC discovery) with a declaration override, PKCE and the RFC 8707 `resource` indicator
  are always used, and the grant is sealed per (workspace, server) and refreshed on the dispatch
  path. The access token rides the job body's header channel only, never a prompt or the telemetry
  snapshot.

  Two new unavailability reasons (`oauth_not_connected`, `oauth_token_failed`) and the matching probe
  verdicts keep "nobody connected", "the connection stopped working" and "no credential configured"
  apart, since each sends an operator somewhere different. New table `mcp_oauth_grants` on both
  runtimes (D1 migration 0082 ⇄ a Drizzle migration), in the mothership `remote` bucket and in the
  workspace-delete cascade. Interactive grants need `MCP_OAUTH_REDIRECT_URL` set to the deployment's
  public app URL followed by `/mcp-oauth-callback` and `ENCRYPTION_KEY` for the sealed store; without
  either, an OAuth server is stated to its agent as unavailable rather than dispatched without a
  token.

  The vendor's redirect lands on the SPA, which re-presents the `code` and `state` to a session-gated
  `POST /mcp/oauth/complete`. A backend route receiving the redirect directly could not be gated:
  sessions are bearer tokens and a third-party browser navigation carries none, so it would have to
  sit outside the default-deny session gate, and the "same user who started the flow" and "still
  holds `secrets.manage`" checks would never execute. Routing it through the app is what makes both
  enforceable.

### Patch Changes

- Updated dependencies [ec96387]
- Updated dependencies [7f5ed08]
- Updated dependencies [4e4d1b4]
  - @cat-factory/contracts@0.246.0
  - @cat-factory/kernel@0.244.0
  - @cat-factory/integrations@0.131.0
  - @cat-factory/orchestration@0.213.0
  - @cat-factory/server@0.223.0
  - @cat-factory/node-server@0.176.0
  - @cat-factory/agents@0.113.0
  - @cat-factory/gitlab@0.15.42
  - @cat-factory/executor-harness@1.92.2

## 0.109.2

### Patch Changes

- Updated dependencies [10e7a15]
- Updated dependencies [ca213b1]
  - @cat-factory/contracts@0.245.0
  - @cat-factory/orchestration@0.212.0
  - @cat-factory/node-server@0.175.0
  - @cat-factory/agents@0.112.6
  - @cat-factory/gitlab@0.15.41
  - @cat-factory/integrations@0.130.2
  - @cat-factory/kernel@0.243.1
  - @cat-factory/server@0.222.2
  - @cat-factory/executor-harness@1.92.2

## 0.109.1

### Patch Changes

- Updated dependencies [d69115d]
  - @cat-factory/contracts@0.244.0
  - @cat-factory/kernel@0.243.0
  - @cat-factory/orchestration@0.211.0
  - @cat-factory/node-server@0.174.0
  - @cat-factory/agents@0.112.5
  - @cat-factory/gitlab@0.15.40
  - @cat-factory/integrations@0.130.1
  - @cat-factory/server@0.222.1
  - @cat-factory/executor-harness@1.92.2

## 0.109.0

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
  - @cat-factory/server@0.222.0
  - @cat-factory/node-server@0.173.0
  - @cat-factory/contracts@0.243.0
  - @cat-factory/orchestration@0.210.0
  - @cat-factory/integrations@0.130.0
  - @cat-factory/executor-harness@1.92.2
  - @cat-factory/agents@0.112.4
  - @cat-factory/gitlab@0.15.39

## 0.108.1

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

- Updated dependencies [7cf3e70]
  - @cat-factory/executor-harness@1.92.2
  - @cat-factory/agents@0.112.3
  - @cat-factory/integrations@0.129.1
  - @cat-factory/kernel@0.241.1
  - @cat-factory/node-server@0.172.1
  - @cat-factory/orchestration@0.209.1
  - @cat-factory/server@0.221.1
  - @cat-factory/gitlab@0.15.38

## 0.108.0

### Minor Changes

- e7867db: Run evidence and key provisioning on `/api/v1`, and a trajectory link on the PR report

  Everything the platform captured about a run was reachable only from a browser session. A consumer
  whose job is to JUDGE a run (a trial harness deciding whether to accept a change, an evaluation
  pipeline scoring a fleet) could scrape the fenced JSON block out of a pull-request body and read
  `/api/v1/debug/*`, and that was all: the captured screenshots were unreachable, and a run with no
  pull request (a headless job, a run that failed before it pushed) had no evidence surface at all.
  Getting a key at all still needed a browser.

  Three additions, all `/api/v1`:

  - **`GET /runs/:runId/report`** serves the engine's verification report: the SAME bundle it writes
    onto the pull request, composed on read by the same code, so the two can never disagree about
    what a run proved. It answers for runs that never opened a pull request, and it does not consult
    the `publishPrVerificationReport` opt-out, which is a statement about writing onto someone else's
    pull request rather than about reading your own evidence back.
  - **`GET /runs/:runId/artifacts`** and **`GET /artifacts/:artifactId/blob`** list a run's captured
    artifacts and stream their bytes, at `read` scope, with the content type clamped to the image
    allow-list exactly as the session-authed route does. An account with no blob backend gets a 503,
    never an empty list. The blob operation declares every media type it can answer with (the image
    allow-list plus an `application/octet-stream` fallback) rather than one standing in for the rest,
    so a client generated from the spec can switch on the response honestly.
  - **`GET|POST|DELETE /keys`** provisions keys headlessly at `admin` scope. Two enforced bounds make
    that safe: a key minted here can never reach the `admin` rung minting requires (so the chain is
    one link long), and revoking a key now revokes every key it minted, on this surface and in the
    app alike. Otherwise a leaked provisioning key would survive its own revocation.

  Refusals across the three evidence reads carry `error.details.reason`, so causes needing different
  reactions stay apart: `run_not_found`, `artifact_not_found`, `artifact_blob_missing` (the row
  outlived its bytes, which is a storage fault rather than a bad request) and
  `binary_artifact_storage_unconfigured`.

  The **PR verification report** gained the links a machine needs: `observability.trajectoryUrl` (the
  run's tool calls in the order the agents made them) and `observability.reportUrl` (this report,
  served live), both rendered in the prose as well as carried in the JSON, and both built from the
  deployment's public BACKEND url. Report payload version 5 → 6.

  Worth knowing when upgrading:

  - **The report shape is now part of the STABLE public surface.** It is served verbatim on
    `/api/v1`, so from here it grows additively and never renames or retypes in place.
  - **A new `created_by_key_id` column** on `public_api_keys` (D1 migration `0081`, its Drizzle
    mirror, plus an index), which carries the provenance of a headless mint and is what the
    revocation cascade follows. The app's key panel renders it, so a provisioned key no longer reads
    as one whose minter is unknown.
  - **The SDK chain learned binary responses.** An operation whose success body was neither JSON nor
    SSE previously generated as a method that returned NOTHING; the IR now marks it `binary`, each
    of the four transports hands the bytes back in its own idiom, and an unrecognised media type
    fails generation instead of silently discarding a body.
  - **A container wiring bug is fixed on both facades**: the HTTP layer's binary-artifact store
    resolver was built from account settings while the engine's came from `CoreDependencies`, so an
    override reached one side of the app and not the other.

### Patch Changes

- Updated dependencies [e7867db]
- Updated dependencies [00c4d94]
  - @cat-factory/contracts@0.242.0
  - @cat-factory/kernel@0.241.0
  - @cat-factory/integrations@0.129.0
  - @cat-factory/orchestration@0.209.0
  - @cat-factory/server@0.221.0
  - @cat-factory/node-server@0.172.0
  - @cat-factory/agents@0.112.2
  - @cat-factory/gitlab@0.15.37
  - @cat-factory/executor-harness@1.92.0

## 0.107.2

### Patch Changes

- Updated dependencies [c5a1a16]
  - @cat-factory/contracts@0.241.0
  - @cat-factory/kernel@0.240.0
  - @cat-factory/orchestration@0.208.0
  - @cat-factory/server@0.220.0
  - @cat-factory/agents@0.112.1
  - @cat-factory/gitlab@0.15.36
  - @cat-factory/integrations@0.128.1
  - @cat-factory/node-server@0.171.2
  - @cat-factory/executor-harness@1.92.0

## 0.107.1

### Patch Changes

- Updated dependencies [dd90c1e]
- Updated dependencies [289b3de]
- Updated dependencies [dd90c1e]
- Updated dependencies [dd90c1e]
  - @cat-factory/contracts@0.240.0
  - @cat-factory/agents@0.112.0
  - @cat-factory/orchestration@0.207.0
  - @cat-factory/server@0.219.0
  - @cat-factory/kernel@0.239.0
  - @cat-factory/integrations@0.128.0
  - @cat-factory/gitlab@0.15.35
  - @cat-factory/node-server@0.171.1
  - @cat-factory/executor-harness@1.92.0

## 0.107.0

### Minor Changes

- a675c63: MCP maturation slice 4: a declared tool server can now be TESTED, and the deployment's tool servers are
  finally visible without reading its source.

  Until now the only way to learn whether a wired MCP tool server actually works was to start a run and
  read the agent's own prompt. Boot validation rules on the DECLARATION and a dispatch reports what it
  DROPPED, but a server that survives both — servable harness, allowed transport, credential present —
  could still be a dead url, a rotated token or a typo'd tool name, and every one of those surfaced as an
  agent quietly doing worse work without the tool it was promised.

  Two new `secrets.manage`-gated routes under `/workspaces/:ws`: `GET /tool-servers` lists every
  registered server (which agent kinds get it, which harnesses can serve it, which credentials it asks
  for by name, whether it can be probed at all), and `POST /tool-servers/:id/test` speaks `initialize` +
  `tools/list` to it for real. The Infrastructure window's "Capability credentials" tab renders the
  inventory with a Test button per row, above the credential checklist those credentials belong to.

  What makes the verdict worth having is that the probe resolves credentials through the SAME composed
  chain a dispatch uses: the per-workspace store in front of the deployment environment, per key, with
  the reserved-key floor applied before the resolver is asked. So the answer is about THIS board rather
  than about whoever set the deployment's variable, and the probe can never be the one path that resolves
  a platform configuration variable and ships it to a third party. The result names a CAUSE rather than a
  boolean, split by the fix each needs: a missing credential and a rejected one are different rows, and
  "no answer at all" is kept apart from "answered with a status" because one is the network and the other
  is usually the token or the path.

  Three things it deliberately refuses rather than approximating. A `stdio` server runs inside the run
  container, a loopback url means "beside the agent in its own container", and the backend is neither of
  those places — so those rows say why instead of offering a button, because a probe that reached for the
  nearest thing it could talk to would answer about the backend's own machine, and a SUCCESS there would
  mislead more than a failure. The third is the `allowedTools` reconciliation: the probe is the first
  thing in the platform that can check a declared tool name against reality (every other layer holds it
  to a NAME pattern, which a well-formed typo passes), and when the server's tool list came back
  paginated past the probe's page bound the check reports itself as unchecked rather than calling a
  working tool missing.

  A redirect is followed, and each hop is held to the transport rule and to the DECLARED ORIGIN while a
  credential is riding. That matches what a run does rather than exceeding it: the Web platform removes
  `Authorization` on a cross-origin redirect, so an agent's own MCP client reaches such a hop
  unauthenticated, and a probe that forwarded the token would report on a request no run makes while
  handing a workspace's credential to whatever the redirect names. The row names the origin change, so
  the fix reads as the declaration naming the final url. A server needing no credential is followed
  across origins as before.

  Two smaller fixes ride along. `McpSecretRef` gains `usage`, the operator-facing note the credential
  checklist has always had a field for and only the generative-integration half ever populated — so a
  tool server's row can finally say which token type and scopes a key wants. And the checklist's READ was
  documented as `secrets.manage`-gated in three places while its mount let every member's GET through:
  `requireWorkspacePermission` passes GET/HEAD by design, so both surfaces now mount the
  explicitly-named `requireWorkspacePermissionIncludingReads`, with a cross-runtime RBAC assertion each.
  Both mount it on their OWN path patterns rather than `'*'`: a `'*'` mount inside a routed Hono
  sub-app lands on `/workspaces/:workspaceId/*` and can refuse a sibling controller's routes, which is
  survivable while only writes are gated and an outage once reads are.

  `ServerContainer` gains `toolSecretResolver`, the composed credential chain itself, beside the
  `toolSecretEnvironmentFallback` description it already carried; a facade that wires the chain now
  surfaces both. `AgentKindRegistry` gains `allToolServers()`, the complement of
  `kindsWithCapabilities()` and the only way to see a registration attached to no kind at all — a state
  that previously passed every check while its credentials sat in the operator's checklist as keys no
  dispatch would ever ask for. Kernel gains `isLoopbackMcpHttpUrl` beside `isAllowedMcpHttpUrl`, a
  separate predicate on purpose: one rules on the scheme, the other on where the server lives.

  No harness change, so no runner-image bump.

### Patch Changes

- Updated dependencies [4e5640d]
- Updated dependencies [a675c63]
  - @cat-factory/kernel@0.238.0
  - @cat-factory/orchestration@0.206.0
  - @cat-factory/server@0.218.0
  - @cat-factory/node-server@0.171.0
  - @cat-factory/contracts@0.239.0
  - @cat-factory/agents@0.111.0
  - @cat-factory/executor-harness@1.92.0
  - @cat-factory/gitlab@0.15.34
  - @cat-factory/integrations@0.127.1

## 0.106.2

### Patch Changes

- Updated dependencies [2c7d17d]
- Updated dependencies [aa62acf]
  - @cat-factory/kernel@0.237.0
  - @cat-factory/orchestration@0.205.0
  - @cat-factory/node-server@0.170.0
  - @cat-factory/contracts@0.238.0
  - @cat-factory/integrations@0.127.0
  - @cat-factory/server@0.217.0
  - @cat-factory/executor-harness@1.92.0
  - @cat-factory/agents@0.110.9
  - @cat-factory/gitlab@0.15.33

## 0.106.1

### Patch Changes

- Updated dependencies [99be350]
  - @cat-factory/contracts@0.237.0
  - @cat-factory/orchestration@0.204.0
  - @cat-factory/server@0.216.0
  - @cat-factory/agents@0.110.8
  - @cat-factory/gitlab@0.15.32
  - @cat-factory/integrations@0.126.3
  - @cat-factory/kernel@0.236.1
  - @cat-factory/node-server@0.169.1
  - @cat-factory/executor-harness@1.92.0

## 0.106.0

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

- Updated dependencies [8511a90]
- Updated dependencies [c9c1dd3]
  - @cat-factory/server@0.215.0
  - @cat-factory/contracts@0.236.0
  - @cat-factory/kernel@0.236.0
  - @cat-factory/orchestration@0.203.0
  - @cat-factory/node-server@0.169.0
  - @cat-factory/executor-harness@1.92.0
  - @cat-factory/agents@0.110.7
  - @cat-factory/gitlab@0.15.31
  - @cat-factory/integrations@0.126.2

## 0.105.5

### Patch Changes

- Updated dependencies [6b9f696]
  - @cat-factory/kernel@0.235.1
  - @cat-factory/executor-harness@1.90.0
  - @cat-factory/agents@0.110.6
  - @cat-factory/gitlab@0.15.30
  - @cat-factory/integrations@0.126.1
  - @cat-factory/orchestration@0.202.1
  - @cat-factory/server@0.214.1
  - @cat-factory/node-server@0.168.1

## 0.105.4

### Patch Changes

- Updated dependencies [cec0c3e]
  - @cat-factory/contracts@0.235.0
  - @cat-factory/kernel@0.235.0
  - @cat-factory/integrations@0.126.0
  - @cat-factory/orchestration@0.202.0
  - @cat-factory/server@0.214.0
  - @cat-factory/node-server@0.168.0
  - @cat-factory/agents@0.110.5
  - @cat-factory/gitlab@0.15.29
  - @cat-factory/executor-harness@1.90.0

## 0.105.3

### Patch Changes

- Updated dependencies [8cbf1a7]
  - @cat-factory/contracts@0.234.0
  - @cat-factory/integrations@0.125.0
  - @cat-factory/server@0.213.0
  - @cat-factory/agents@0.110.4
  - @cat-factory/gitlab@0.15.28
  - @cat-factory/kernel@0.234.2
  - @cat-factory/orchestration@0.201.2
  - @cat-factory/node-server@0.167.2
  - @cat-factory/executor-harness@1.90.0

## 0.105.2

### Patch Changes

- Updated dependencies [ee6601e]
  - @cat-factory/contracts@0.233.0
  - @cat-factory/orchestration@0.201.1
  - @cat-factory/server@0.212.1
  - @cat-factory/agents@0.110.3
  - @cat-factory/gitlab@0.15.27
  - @cat-factory/integrations@0.124.1
  - @cat-factory/kernel@0.234.1
  - @cat-factory/node-server@0.167.1
  - @cat-factory/executor-harness@1.90.0

## 0.105.1

### Patch Changes

- Updated dependencies [937d4af]
  - @cat-factory/contracts@0.232.0
  - @cat-factory/kernel@0.234.0
  - @cat-factory/orchestration@0.201.0
  - @cat-factory/server@0.212.0
  - @cat-factory/integrations@0.124.0
  - @cat-factory/node-server@0.167.0
  - @cat-factory/agents@0.110.2
  - @cat-factory/gitlab@0.15.26
  - @cat-factory/executor-harness@1.90.0

## 0.105.0

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
  - @cat-factory/server@0.211.0
  - @cat-factory/node-server@0.166.0
  - @cat-factory/contracts@0.231.0
  - @cat-factory/orchestration@0.200.0
  - @cat-factory/executor-harness@1.90.0
  - @cat-factory/agents@0.110.1
  - @cat-factory/gitlab@0.15.25
  - @cat-factory/integrations@0.123.6

## 0.104.1

### Patch Changes

- 1f14793: Documentation cleanup and consistency: neutral naming across docs, code comments,
  example fixtures and historical changelog entries, with the OpenAPI spec and
  generated SDK clients regenerated so their description strings match. No behaviour
  or API change.
- 2619d79: MCP maturation slice 1: every declared tool server is either served or STATED.

  A dispatch now checks the running harness's MCP TRANSPORTS, not just whether it speaks MCP, so an
  `http` server on a Codex run (whose client is stdio-only) is dropped under a new
  `transport_unsupported` reason instead of being advertised in the prompt and then silently skipped by
  the harness's TOML writer. Boot validation and the capability-credential checklist now enumerate
  `AgentKindRegistry.kindsWithCapabilities()` (every kind declaring a capability on its own
  registration, plus every kind named by `assignSkills` / `assignToolServers`), so a server attached to
  a built-in such as `coder` reaches the same refusals and the same operator checklist as a registered
  kind's own. New checks: a transport/harness combination no run could serve, an `allowedTools` entry
  that is not a single tool name (the harness joins the list with commas), and a per-dispatch server
  budget, both dimensions of which warn at boot and drop the excess under `over_budget` at dispatch.
  The harness exempts `mcp__*` calls from the no-edit progress bound and bounds them with their own
  `JOB_MAX_CONSECUTIVE_MCP_CALLS` streak, plus a `JOB_MAX_CONSECUTIVE_NON_ACTION_CALLS` backstop shared
  by every no-edit-exempt family (each per-family streak resets on a call outside its family, so
  interleaving two of them was bounded only by the job's wall-clock ceiling).

  OPERATORS UPGRADING: capabilities attached by `assignSkills` / `assignToolServers` were previously
  not boot-validated at all, so a declaration that is now an ERROR (a cleartext off-loopback endpoint,
  a reserved credential key, an unregistered id, a malformed server id or tool name) turns a
  deployment that used to start into one that refuses to. That is the intent of the change, and each
  message names the kind and the declaration to fix.

  INTERNAL BREAK: `UnavailableToolServer['reason']` gains `transport_unsupported` and `over_budget`, so
  a deployment rendering that union exhaustively must map them. Runner image bumped to 1.89.0.

- Updated dependencies [1f14793]
- Updated dependencies [2619d79]
  - @cat-factory/contracts@0.230.1
  - @cat-factory/kernel@0.232.0
  - @cat-factory/agents@0.110.0
  - @cat-factory/server@0.210.0
  - @cat-factory/orchestration@0.199.0
  - @cat-factory/integrations@0.123.5
  - @cat-factory/node-server@0.165.1
  - @cat-factory/executor-harness@1.90.0
  - @cat-factory/gitlab@0.15.24

## 0.104.0

### Minor Changes

- e7e4404: Reusable operations, slice 2: one descriptor-driven form vocabulary behind both surfaces that have
  one, and a custom task type's collected values are now checked against what it declares.

  An initiative preset and a custom task type had grown the same feature twice, and the task type was
  the poorer copy: four input types against eight, no defaults, no conditional visibility, no shared
  validation, and two near-identical Vue renderers. So a form an org could express as a preset was
  unexpressible as an operation, and nothing but the create form enforced a `required` marker or an
  option list. `contracts/src/form-fields.ts` is now the union both draw on (the field shape, the
  filled-value bag, and the pure visibility / validation / sanitization / prose-rendering rules), with
  each surface declaring only which input types it admits. `password` is excluded for a task type by
  construction rather than by convention: a collected value is folded into prompts, projected onto the
  board snapshot and captured in telemetry, so a secret belongs in the capability-credential store.

  `taskTypeFields.custom` widens from `string | number` to the shared bag (adding booleans and
  multi-select `string[]`), and the prompt fold renders the new shapes through the same renderer the
  form review uses, so a multi-select reads as its option captions rather than its stored enum values.
  Rows are read back through an unvalidated JSON parse, so nothing existing breaks and there is nothing
  to migrate. Two INTERNAL breaks ride along, in the bounds the shared bag carries that the old
  untyped record did not: a bag KEY is now capped at 80 characters and a string VALUE at 2000, so a
  value longer than that (only reachable through a bespoke `formPanel`, since a declared `maxLength`
  cannot exceed the same bound) is refused on the way in.

  `BoardService.addTask` now validates a registered type's bag against its descriptor and freezes only
  the declared, currently-visible answers, so one rule covers the SPA, the internal API and (from the
  public-API slice) a headless caller. An ABSENT bag is checked against an empty one, because a
  required field is unanswered whether the caller sent `custom: {}` or no `custom` key at all: a check
  the caller can opt out of by sending nothing is not a check. **Behaviour change for a deployment
  that registers an operation with required fields**: any path creating such a task without its
  parameters (an initiative item's `spawn`, a script) now gets a 422 where it previously created a
  task whose operation brief was empty. Three cases still deliberately pass through unchecked: a
  built-in type (schema-typed fields, already validated), a type this process does not register (a
  supported row, since task types are node-local by design and degrading data must not brick
  creation), and a descriptor declaring a bespoke `formPanel`, which owns its own bag.

  The richer vocabulary brings new ways for a descriptor to break itself, so boot validation now
  refuses a create form that structurally cannot be filled: a duplicate field key, an optionless
  `select`/`checkbox-group`, or a `showWhen` gating a field on a key the type does not declare (which
  would hide that field forever). Each is fully known from the registration and silent at run time,
  unlike a `defaultFragmentIds` id, which stays a warning because a tenant-tier fragment is invisible
  at boot. Both surfaces are held to that bar by one checker, so an initiative preset's create form is
  validated at boot for the first time (all three facades pass the registry).

  Behaviour change worth reviewing: a custom task type's `select` field renders as a dropdown rather
  than a button row, since it is now the shared renderer, and a form with many options needed that
  anyway. The path-invalid message moved from `initiative.create.pathInvalid` to `common.pathInvalid`,
  carrying each locale's existing translation.

  One unfilled value is now dropped rather than frozen, on both surfaces. Validation short-circuits on
  a value that says nothing, so a `false` on a text field, a blank string or an empty multi-select
  reached the freeze having passed no type check; sanitization now drops them, which stops a
  wrong-typed answer reaching agents as the operation's own brief (`notes: false` rendered as
  `Notes: No`). The one exception is an explicit `false` on a `checkbox`, which is the opt-OUT of a
  default-ON toggle and the one unfilled value that is an answer.

### Patch Changes

- Updated dependencies [e7e4404]
  - @cat-factory/contracts@0.230.0
  - @cat-factory/kernel@0.231.0
  - @cat-factory/orchestration@0.198.0
  - @cat-factory/node-server@0.165.0
  - @cat-factory/agents@0.109.2
  - @cat-factory/gitlab@0.15.23
  - @cat-factory/integrations@0.123.4
  - @cat-factory/server@0.209.1
  - @cat-factory/executor-harness@1.88.0

## 0.103.3

### Patch Changes

- Updated dependencies [10e0341]
- Updated dependencies [10e0341]
  - @cat-factory/contracts@0.229.0
  - @cat-factory/kernel@0.230.0
  - @cat-factory/orchestration@0.197.0
  - @cat-factory/server@0.209.0
  - @cat-factory/node-server@0.164.0
  - @cat-factory/agents@0.109.1
  - @cat-factory/gitlab@0.15.22
  - @cat-factory/integrations@0.123.3
  - @cat-factory/executor-harness@1.88.0

## 0.103.2

### Patch Changes

- Updated dependencies [fccb1df]
  - @cat-factory/contracts@0.228.0
  - @cat-factory/kernel@0.229.0
  - @cat-factory/agents@0.109.0
  - @cat-factory/orchestration@0.196.0
  - @cat-factory/gitlab@0.15.21
  - @cat-factory/integrations@0.123.2
  - @cat-factory/server@0.208.2
  - @cat-factory/node-server@0.163.2
  - @cat-factory/executor-harness@1.88.0

## 0.103.1

### Patch Changes

- Updated dependencies [437a0c6]
  - @cat-factory/contracts@0.227.0
  - @cat-factory/integrations@0.123.1
  - @cat-factory/agents@0.108.3
  - @cat-factory/gitlab@0.15.20
  - @cat-factory/kernel@0.228.1
  - @cat-factory/orchestration@0.195.3
  - @cat-factory/server@0.208.1
  - @cat-factory/node-server@0.163.1
  - @cat-factory/executor-harness@1.88.0

## 0.103.0

### Minor Changes

- 43fd5c0: Route platform-health alerts to the workspace's outbound webhook as their own event family, so
  on-call tooling can be paged by the deployment watching itself.

  A workspace's registered endpoint gains an `alertEvents` filter beside `types` and `runEvents`,
  carrying `platform_health.firing` when the health sweep's set of tripped conditions changes and
  `platform_health.resolved` when it observes the account recover. Empty means none, like
  `runEvents`: subscribing a receiver to alerts is always explicit.

  The `platform_health` notification CARD could already be named in the `types` filter, and for a
  human overseer it still should be. It is not safe to page on: a card is re-delivered when a human
  acts on it or dismisses it, which is indistinguishable on the wire from the sweep clearing it
  because the deployment recovered. These edges come from the sweep's own verdict, and carry each
  condition's observed value and threshold (which the card deliberately omits, since its payload is
  its dedup identity).

  Each delivery is identified by `<cardId>:<event>:<transition>[:<reasons>]`, where the transition
  ordinal is counted on the card row itself. Neither simpler key works: a condition set recurs within
  one incident (`{A}` → `{A,B}` → `{A}`), so keying on the set drops the page saying it subsided,
  while keying on a timestamp pages twice whenever two of the deployment's sweepers observe one
  transition. `occurredAt` is the sweep's own observation of the transition rather than anything read
  off the card, whose `createdAt` is preserved across a re-raise and so names when the incident
  opened.

  Internal break: `NotificationWebhookRecord` gains a required `alertEvents` field, and the
  `notification_webhooks` table gains an `alert_events` column on both runtimes. Existing rows
  default to `[]`, so every registered endpoint keeps its current behaviour byte-for-byte.

  The `platform_health` notification payload gains an optional `platformAlertTransition`, which
  carries that ordinal and so also lets a caller reading `GET /api/v1/notifications` line a card up
  against the alert deliveries it received. That is an ADDITIVE public-API change: the OpenAPI
  `info.version` goes to 1.3.0 and the four SDK clients plus the MCP facade regenerate, with no
  existing field renamed, retyped or removed. A card written before this ships carries no ordinal and
  its next transition simply starts the count at 1.

### Patch Changes

- Updated dependencies [43fd5c0]
  - @cat-factory/kernel@0.228.0
  - @cat-factory/contracts@0.226.0
  - @cat-factory/integrations@0.123.0
  - @cat-factory/server@0.208.0
  - @cat-factory/node-server@0.163.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/agents@0.108.2
  - @cat-factory/gitlab@0.15.19
  - @cat-factory/orchestration@0.195.2

## 0.102.1

### Patch Changes

- Updated dependencies [0456066]
  - @cat-factory/contracts@0.225.0
  - @cat-factory/kernel@0.227.0
  - @cat-factory/agents@0.108.1
  - @cat-factory/gitlab@0.15.18
  - @cat-factory/integrations@0.122.2
  - @cat-factory/orchestration@0.195.1
  - @cat-factory/server@0.207.1
  - @cat-factory/node-server@0.162.1
  - @cat-factory/executor-harness@1.88.0

## 0.102.0

### Minor Changes

- cc17221: Price the three input token classes at their own rates and surface the resulting cost on the run
  and debug surfaces.

  `ModelPrice` gains `cacheReadPerMillion` / `cacheWritePerMillion`, derived from the base input
  rate where an entry names neither. This fixes a spend-gate defect as well as adding a display:
  the ledger previously metered every input token at the fresh rate, so a cache-read-dominated run
  was priced at roughly ten times its real cost and could exhaust a budget it had barely touched.

  The telemetry stores now aggregate one grain finer (`agentKind, phase, provider, model`) so a
  run's rollup can be priced while the model is still attached, and `priceRollupCells` folds the
  model away again, returning the `(agentKind, phase)` cells every consumer already read, now
  carrying `costEstimate`. That collapsed cell is its own type (`LlmRollupCell`), so a reader
  cannot ask it which model it was: after the fold there is no single answer. An unpriceable slice
  reports `null` rather than `0`, and a total containing one propagates that null instead of
  reporting a partial sum as complete.

  Public API (`/api/v1`), additive, `info.version` 1.1.0 → 1.2.0: the debug run overview's LLM
  rollups carry `costEstimate` and the block carries `costCurrency`. The four SDK clients are
  regenerated; the Python and Java manifests are bumped so the new models publish.

  The run's LLM-metrics export now states whether it is `truncated`. It is capped at the newest
  1000 calls, and a cost folded from that slice would be a smaller number that still reads as the
  run's total, so a truncated bundle reports null costs rather than pricing the part it holds.

### Patch Changes

- Updated dependencies [f1a6cb3]
- Updated dependencies [cc17221]
- Updated dependencies [889a497]
- Updated dependencies [3605630]
  - @cat-factory/orchestration@0.195.0
  - @cat-factory/contracts@0.224.0
  - @cat-factory/kernel@0.226.0
  - @cat-factory/agents@0.108.0
  - @cat-factory/node-server@0.162.0
  - @cat-factory/server@0.207.0
  - @cat-factory/gitlab@0.15.17
  - @cat-factory/integrations@0.122.1
  - @cat-factory/executor-harness@1.88.0

## 0.101.3

### Patch Changes

- Updated dependencies [bbc51fa]
- Updated dependencies [36b1853]
  - @cat-factory/orchestration@0.194.0
  - @cat-factory/integrations@0.122.0
  - @cat-factory/node-server@0.161.1
  - @cat-factory/server@0.206.0
  - @cat-factory/contracts@0.223.0
  - @cat-factory/kernel@0.225.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/agents@0.107.1
  - @cat-factory/gitlab@0.15.16

## 0.101.2

### Patch Changes

- Updated dependencies [413095f]
  - @cat-factory/contracts@0.222.0
  - @cat-factory/kernel@0.224.0
  - @cat-factory/agents@0.107.0
  - @cat-factory/orchestration@0.193.0
  - @cat-factory/server@0.205.0
  - @cat-factory/node-server@0.161.0
  - @cat-factory/gitlab@0.15.15
  - @cat-factory/integrations@0.121.2
  - @cat-factory/executor-harness@1.88.0

## 0.101.1

### Patch Changes

- Updated dependencies [04e44f8]
  - @cat-factory/contracts@0.221.0
  - @cat-factory/kernel@0.223.0
  - @cat-factory/orchestration@0.192.0
  - @cat-factory/server@0.204.0
  - @cat-factory/node-server@0.160.0
  - @cat-factory/agents@0.106.8
  - @cat-factory/gitlab@0.15.14
  - @cat-factory/integrations@0.121.1
  - @cat-factory/executor-harness@1.88.0

## 0.101.0

### Minor Changes

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
  - @cat-factory/orchestration@0.191.0
  - @cat-factory/contracts@0.220.0
  - @cat-factory/kernel@0.222.0
  - @cat-factory/integrations@0.121.0
  - @cat-factory/server@0.203.0
  - @cat-factory/node-server@0.159.0
  - @cat-factory/agents@0.106.7
  - @cat-factory/gitlab@0.15.13
  - @cat-factory/executor-harness@1.88.0

## 0.100.1

### Patch Changes

- Updated dependencies [1106c93]
  - @cat-factory/contracts@0.219.0
  - @cat-factory/orchestration@0.190.0
  - @cat-factory/server@0.202.0
  - @cat-factory/agents@0.106.6
  - @cat-factory/kernel@0.221.1
  - @cat-factory/gitlab@0.15.12
  - @cat-factory/integrations@0.120.1
  - @cat-factory/node-server@0.158.1
  - @cat-factory/executor-harness@1.88.0

## 0.100.0

### Minor Changes

- f63145d: A deployment can now declare its capability-credential chain store-ONLY, and the operator surface
  describes the chain that was actually composed instead of asserting a default beside it.

  `capabilityCredentialEnvironmentFallback: false` on any facade (`start` / `startLocal` /
  `createWorker`) composes the per-workspace sealed store with no environment resolver behind it. That
  is the multi-tenant shape: with the fallback on, a workspace that has typed nothing silently
  authenticates its runs as whoever set the deployment's variable and bills that vendor account, which
  is the single-tenant answer the store exists to replace. The default is unchanged, because whether a
  hosted deployment should ship store-only is a product call.

  The chain is now composed once, at each facade's composition root, by `buildToolSecretChain`, which
  returns the resolver together with what it consults. The credential checklist reads that rather than
  hard-coding "the environment may still answer", so a blank row means the same thing on the surface
  and in the dispatch path. Both executor builders take that composed chain as a REQUIRED dependency:
  the only default they could have carried is the deployment environment alone, which silently drops
  the per-workspace store, and a default is only safe where the safe answer is the convenient one.

  Compatibility breaks, none of which affect a deployment using the documented facade seams:

  - `environmentFallback` on the capability-credentials view is optional rather than always present,
    and absent is a real answer: a deployment that supplied its own `ToolSecretResolver` replaced the
    chain, so whether it reads the environment is not knowable here, and both guesses fail silently in
    opposite directions.
  - The Worker's process-wide `registerToolSecretResolverFactory` is replaced by
    `registerToolSecretPolicy({ createResolver?, environmentFallback? })`.
  - `resolveToolSecrets` is required on `WorkerExecutorDeps` and `NodeContainerExecutorDeps`. Only a
    deployment assembling an executor without its facade's composition root passed neither; it now
    calls `buildToolSecretChain` itself, which is also what gets it the description the credential
    checklist renders.

### Patch Changes

- Updated dependencies [f63145d]
- Updated dependencies [3b88f66]
  - @cat-factory/contracts@0.218.0
  - @cat-factory/server@0.201.0
  - @cat-factory/node-server@0.158.0
  - @cat-factory/orchestration@0.189.0
  - @cat-factory/integrations@0.120.0
  - @cat-factory/kernel@0.221.0
  - @cat-factory/agents@0.106.5
  - @cat-factory/gitlab@0.15.11
  - @cat-factory/executor-harness@1.88.0

## 0.99.2

### Patch Changes

- Updated dependencies [7f86f07]
- Updated dependencies [7f86f07]
  - @cat-factory/contracts@0.217.0
  - @cat-factory/integrations@0.119.0
  - @cat-factory/server@0.200.0
  - @cat-factory/kernel@0.220.0
  - @cat-factory/node-server@0.157.1
  - @cat-factory/agents@0.106.4
  - @cat-factory/gitlab@0.15.10
  - @cat-factory/orchestration@0.188.3
  - @cat-factory/executor-harness@1.88.0

## 0.99.1

### Patch Changes

- Updated dependencies [87161e8]
  - @cat-factory/contracts@0.216.0
  - @cat-factory/kernel@0.219.0
  - @cat-factory/server@0.199.0
  - @cat-factory/node-server@0.157.0
  - @cat-factory/agents@0.106.3
  - @cat-factory/gitlab@0.15.9
  - @cat-factory/integrations@0.118.1
  - @cat-factory/orchestration@0.188.2
  - @cat-factory/executor-harness@1.88.0

## 0.99.0

### Minor Changes

- 96ad850: Per-workspace capability credentials: the secrets a tool server or generative binary integration
  declares are now stored per TENANT, sealed at rest, instead of only being read off the deployment's
  environment.

  An environment variable is a single-tenant answer: one process serves many workspaces, so one
  variable served them all: every tenant's runs authenticated as whoever set it, no tenant could bring
  its own vendor account, and rotating one tenant's key was a redeploy that rotated everyone's. Every
  other credential in the platform is already a per-tenant sealed row; capabilities were the subsystem
  that had not caught up.

  New: `capability_credentials` (D1 + Postgres), `CapabilityCredentialsService`,
  `createWorkspaceToolSecretResolver` / `composeToolSecretResolvers`, and a `secrets.manage`-gated
  `/workspaces/:workspaceId/capability-credentials` surface that lists which credentials the
  deployment's registered capabilities DECLARE alongside which this workspace has stored. Deleting a
  board reclaims its stored credentials with the rest of its workspace-scoped rows.

  No behaviour change for an existing deployment: the environment resolver is composed BEHIND the
  store per key, so a workspace that has stored nothing resolves exactly as before. The SPA panel is
  the next slice; the API is usable now.

- 96ad850: Close the tool-secret boundary, and give `ToolSecretResolver` a facade seam.

  **Behaviour break (deliberate).** A capability credential (a tool server's `secretKeys`, a
  generative binary integration's `credential.key`) may no longer be LOOKED UP BY an environment
  variable the platform itself reads. Such a definition names both the key it wants and the endpoint
  that key is sent to, so `{ key: 'ENCRYPTION_KEY', usage: 'Authorization: Bearer <value>' }` was a
  registration that booted clean and injected the deployment's master sealing key into a
  prompt-injectable agent process. It is now refused at declaration (a schema issue for a generative
  integration, a `reserved_credential_key` boot error for a tool server) and again at dispatch, where
  the capability is reported to the agent as unavailable: a tool server under its own
  `reserved_secret` reason, kept apart from `missing_secret` because the two need opposite fixes.

  **New `envName`.** The floor binds the LOOKUP key alone. A declaration that needs a specific
  variable in the process it configures sets `envName` beside its `key`
  (`{ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }`), and that name is held
  only to the narrower toolchain rule, since it reads nothing. Without the split the reserved
  families would make the commonest MCP servers unusable with no workaround open to a deployment,
  because `GITHUB_`, `SLACK_` and `AWS_` cover names the platform does not read and a vendor's own
  SDK does. A deployment that named a platform variable as its lookup key now fails at boot rather
  than silently; a deployment that needs the vendor's name in the process keeps it via `envName`.

  **New seam.** `startLocal`, `start` and `createWorker` each take a `createToolSecretResolver`
  factory, defaulting to the platform's own chain (the per-workspace credential store in front of
  `createEnvToolSecretResolver(env)`). Reaching the port used to mean abandoning the facade and
  reassembling the boot sequence, so the per-workspace credential store the port was designed for,
  and the `allowKeys` bound its own documentation recommended, were both unreachable. On the Worker
  the option registers the resolver process-wide (`registerToolSecretResolverFactory`), because a
  Worker builds a container per entry point and container agents are dispatched by the durable
  driver, which sees no option held on the app.

  Also: the Node executor's default env resolver now reads the injected `env` rather than
  `process.env` directly, so an embedded boot or a test that supplies one is no longer bypassed.

### Patch Changes

- Updated dependencies [96ad850]
- Updated dependencies [96ad850]
  - @cat-factory/contracts@0.215.0
  - @cat-factory/kernel@0.218.0
  - @cat-factory/integrations@0.118.0
  - @cat-factory/server@0.198.0
  - @cat-factory/node-server@0.156.0
  - @cat-factory/agents@0.106.2
  - @cat-factory/orchestration@0.188.1
  - @cat-factory/gitlab@0.15.8
  - @cat-factory/executor-harness@1.88.0

## 0.98.1

### Patch Changes

- Updated dependencies [4c26c01]
  - @cat-factory/contracts@0.214.0
  - @cat-factory/kernel@0.217.0
  - @cat-factory/orchestration@0.188.0
  - @cat-factory/server@0.197.0
  - @cat-factory/agents@0.106.1
  - @cat-factory/gitlab@0.15.7
  - @cat-factory/integrations@0.117.2
  - @cat-factory/node-server@0.155.1
  - @cat-factory/executor-harness@1.88.0

## 0.98.0

### Minor Changes

- 924c6f9: Let a mothership-mode node read the deployment's generative binary integrations from the mothership instead of from its own build.

  `BinaryGeneratorRegistry` shipped registry-only, which meant a mothership deployment — two processes — had to register its integrations on both entry points, with the copies matching only while both ran the same build. A local node one build behind is the normal state of running one, and the resulting failure was both loud and misattributed: the pipeline builder's picker is fed from the workspace snapshot the mothership serves, so a human selects an integration from the product's own picker and every run of that step is then refused by the node with `unknown_generator` — naming a step configuration that is correct, with the half-wired deployment invisible in the message.

  The new kernel `BinaryGeneratorSource` port (`views()` + batched `documentsFor(ids)`) mirrors `FoundationalBuiltinSource` file for file: `GET /internal/binary-generators` (+ `POST .../contracts`) is machine-token gated, mounted on both facades, and reads this process's OWN registry; `HttpBinaryGeneratorSource` throws on every unreadable outcome — a transport error, a refusal, the 404 of a mothership older than the node — rather than answering with an empty set. A mothership-mode node injects it and no longer consults its own registry for a run, warning at boot naming any ids it will ignore; the registry is still boot-validated and is what the route serves when the process is itself a mothership.

  The disposition differs from the estate's in the one place that matters. Those integrations gate ADMISSION, not just prompt enrichment, so an unreachable source is re-thrown as a 503-shaped, retryable `binary_generators_unreachable` and never softened to an empty set — which would refuse correctly configured steps as `unknown_generator` for the duration of an outage. That refusal carries translated copy of its own: user-reachable 503 reasons now live in a `UNAVAILABLE_REASONS` union with an exhaustive `Record` in the SPA, because the status class's generic wording ("this deployment has not configured the capability") is the same misattribution one layer up.

  The best-effort readers keep their own dispositions. The dispatch brief injects nothing, which the trait guidance already defines as "do not attempt any upload; report it". The settled-step read-back records the artifacts and the storage-side verdict — both resolve against the workspace catalog, which an unreachable mothership says nothing about — and marks only the generative judgement withheld, via a new `BinaryOutputReport.generatorsUnverified` rendered as its own warning line. An empty `unknownGenerators` means "every claimed id checked out", so the two may not be spelled alike.

  Within one dispatch the two halves of a selection share ONE `views()` read (`memoizeBinaryGeneratorViews`), scoped to that read wave and discarded with it — one round trip instead of two, with no staleness window to reason about. The workspace snapshot's projection joins the board-load read wave rather than following it, for the same reason.

  The workspace snapshot's picker projection reads the same source, because routing only the engine would have moved the drift to the surface that OFFERS the id rather than removing it. It carries a new `binaryGeneratorsUnavailable` flag for the state a list cannot express: an empty picker is a claim about the deployment's build, and acting on it during an outage sends someone to the wrong repository. The SPA renders that as its own message and disables the selector rather than reporting the selection as invalid.

  Version floor: a node on this release needs a mothership new enough to serve the route. An older one answers 404, which surfaces as an outage rather than as a deployment that registers nothing.

### Patch Changes

- Updated dependencies [924c6f9]
  - @cat-factory/contracts@0.213.0
  - @cat-factory/kernel@0.216.0
  - @cat-factory/agents@0.106.0
  - @cat-factory/orchestration@0.187.0
  - @cat-factory/server@0.196.0
  - @cat-factory/node-server@0.155.0
  - @cat-factory/gitlab@0.15.6
  - @cat-factory/integrations@0.117.1
  - @cat-factory/executor-harness@1.88.0

## 0.97.0

### Minor Changes

- 233e279: Register generative binary integrations (image / music / video generation APIs) in a deployment's own code, and let binary-generating agent steps select them.

  `BinaryGeneratorRegistry` is a new app-owned registry beside the foundational-service one: an integration declares the content types it produces (`image | audio | video | 3d | document`), its media types, endpoint, API contracts and the credential it needs BY NAME. A step picks from it via `stepOptions.binaryOutput.generatorIds` and states the content types it must deliver via `.modalities`; run admission refuses an unregistered id or an uncovered content type under the new `binary_output_generator_invalid` conflict reason. The agent's `.cat-context/binary-output/brief.md` now leads with a Generation section describing each integration, and the credential value reaches only that job's agent process (job body `generatorSecrets`), never a prompt or the telemetry snapshot.

  All three facades take the registry as their own DI option (`binaryGeneratorRegistry`), so a deployment registers integrations on Node and local exactly as on the Worker, and each facade boot-validates the instance it was handed. A new `registry-seams` guard derives the app-owned registry set from `CoreDependencies` and holds each one to a declared route, so the next registry cannot land threaded on one runtime and inert on another.

  The SPA follows the shapes through: the binary-output step picker offers the generative selection (from the workspace snapshot's new `binaryGenerators`, identity only — never a credential key name) and mirrors both new refusals inline, and the report names the integration that produced each artifact plus any the deployment does not register.

  Breaking, pre-1.0: `PipelineStep.binaryOutputs` gains a required `unknownGenerators` array, so reports recorded before this change no longer parse — an affected step's declaration record is re-created on its next run. `ToolSecretResolver.resolve` takes a discriminated `subject` (`tool-server` | `binary-generator`) in place of `serverId`; a deployment implementing that port per workspace must update its signature, and one passing `allowKeys` to the env-backed default must extend the list to cover its integrations' credential keys or they resolve to nothing.

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
  - @cat-factory/agents@0.105.0
  - @cat-factory/orchestration@0.186.0
  - @cat-factory/server@0.195.0
  - @cat-factory/node-server@0.154.0
  - @cat-factory/executor-harness@1.88.0
  - @cat-factory/integrations@0.117.0
  - @cat-factory/gitlab@0.15.5

## 0.96.2

### Patch Changes

- Updated dependencies [87ed4f9]
  - @cat-factory/contracts@0.211.0
  - @cat-factory/server@0.194.0
  - @cat-factory/agents@0.104.3
  - @cat-factory/gitlab@0.15.4
  - @cat-factory/integrations@0.116.4
  - @cat-factory/kernel@0.214.1
  - @cat-factory/orchestration@0.185.2
  - @cat-factory/node-server@0.153.2
  - @cat-factory/executor-harness@1.86.2

## 0.96.1

### Patch Changes

- 3435bd1: Drop the version-pinned model ids from the harness's `model` doc comment. It read
  `e.g. claude-opus-4-8 / gpt-5.5-codex` — and `gpt-5.5-codex` was never a valid Codex slug,
  so the example pointed at a model that cannot run. A pinned example rots on every vendor
  release for no benefit: the field's contract is "the vendor's own id, not a catalog id",
  which the comment now states directly instead of illustrating.

  Comment-only, but it lands under `executor-harness/src`, so the image tag is bumped
  (1.86.0 → 1.86.1) with the three pins synced. **Publishing still requires
  `pnpm image:publish` + `pnpm deploy` from `deploy/backend`** — reusing a tag does not roll
  out, which is the whole reason the tag moves.

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

- Updated dependencies [3435bd1]
- Updated dependencies [3435bd1]
  - @cat-factory/executor-harness@1.86.2
  - @cat-factory/kernel@0.214.0
  - @cat-factory/node-server@0.153.1
  - @cat-factory/agents@0.104.2
  - @cat-factory/gitlab@0.15.3
  - @cat-factory/integrations@0.116.3
  - @cat-factory/orchestration@0.185.1
  - @cat-factory/server@0.193.1

## 0.96.0

### Minor Changes

- 70b4339: Serve a mothership-mode node's run telemetry back down from the mothership when its own store holds
  none. Telemetry is local-first, captured on the laptop and pruned there on a short window, with a
  finished run's rows carried up by the ingest sweep — both halves of which are about the WRITE
  direction. What that left was a node rendering two kinds of run blank: one whose local rows had been
  pruned, and (the larger case the plan under-stated) one that was never local at all. A mothership-mode
  SPA shows the whole org's board, so most runs a developer opens were driven by a hosted teammate or
  another laptop, and every one of them showed an empty observability panel, a zero token rollup and no
  web-search log — with nothing anywhere reporting a problem, because that is exactly what a run which
  spent nothing looks like.

  `POST /internal/telemetry/read` is the ingest's dual: a machine-authed, account-scoped endpoint
  serving a CLOSED table of per-method-bounded, run-scoped reads. It is its own endpoint rather than
  allow-listed persistence-RPC methods for ADR 0009's reason plus a sharper one — the persistence
  registry resolves a repository WHOLE, so admitting a telemetry repo's reads there would route its
  hot-path writes over the network, which is the entire thing the local-first bucket exists to prevent.
  `listByExecution` is deliberately absent from the table on all three sinks (no cursor, so it is the
  un-resumable bulk read the bucket forbids); the node drains the paged reads instead, which is what
  the two new kernel port methods are for. An over-cap limit is refused, never clamped, and the
  scope-bound workspace is stamped as the call's first argument rather than trusted from the caller.

  On the laptop the rule is local-wins where local is WHOLE — not merely where it is non-empty. The
  distinction is a third blank-run case: the prune deletes by capture time, so a run straddling the
  cutoff keeps its newer rows and loses its older ones, and the store then answers, with nothing
  looking missing, with a strict subset. A short list is bad and the rollup is worse, because a token
  total that is simply too low carries no hint that it is short. A subset is undetectable after the
  fact, so the prune records it as it happens and that record is what makes a local answer
  authoritative: lists stitch across the two stores on the shared keyset, while counts and the rollup
  come wholly from the mothership, since a partial local aggregate and a complete remote one cannot be
  merged. Capture is not decorated at all. A failed fallback throws rather than degrading back into the
  empty answer it was called to replace — the one hot-path caller already treats a metrics read as
  best-effort, so an outage costs a board counter and never a run, and the aggregate reads carry a
  short round-trip budget precisely because that caller awaits them on the emit path.

  A page inside its row cap can still serialize past the response backstop, so that is treated as
  routine rather than as a fault: the mothership still refuses rather than shortening (a truncated page
  is one the node would treat as complete), but under its own code, and the drain re-asks smaller on
  the same cursor, losing nothing. It terminates because the backstop is derived from the two capture
  ceilings rather than picked — a one-row page can never be refused for size.

  Compatibility break: `LlmCallMetricRepository` and `AgentContextSnapshotRepository` each gain a
  required `listRunPage` method, so an out-of-tree implementation of either port must add it. The local
  telemetry store gains a `telemetry_pruned_runs` table, created on open; an existing store simply
  starts recording from its next prune, and until then reports itself complete, which is the same
  answer it gave before.

### Patch Changes

- Updated dependencies [70b4339]
  - @cat-factory/kernel@0.213.0
  - @cat-factory/orchestration@0.185.0
  - @cat-factory/server@0.193.0
  - @cat-factory/node-server@0.153.0
  - @cat-factory/executor-harness@1.86.0
  - @cat-factory/agents@0.104.1
  - @cat-factory/gitlab@0.15.2
  - @cat-factory/integrations@0.116.2

## 0.95.0

### Minor Changes

- f31c644: Serve the foundational-service catalog's `builtin` tier over the mothership machine API. A
  mothership deployment is two processes, so a code-registered estate had to be registered on both
  entry points and the copies matched only while both ran the same build — with a local node one
  build behind being the normal case, and the skew silent (a run's catalog simply omits a service,
  which reads like an Architect judging it irrelevant).

  The tier is now read through the kernel `FoundationalBuiltinSource` port: the in-process registry by
  default, `GET /internal/foundational-services` (+ the batched
  `POST /internal/foundational-services/contracts`) on a mothership-mode node, which no longer consults
  its own registry and warns at boot naming any ids it ignores. The remote read throws rather than
  answering with an empty tier — on the 404 from a mothership older than the node, and on a 200 whose
  payload it cannot read — and the injected context files STATE that outage rather than being omitted
  (`FoundationalCatalogRead` / `FoundationalIndexRead` gain an `unavailable` variant), so a best-effort
  dispatch cannot turn the throw back into "no shared services are registered".

  Compatibility break (pre-1.0, no shim): `FoundationalServiceCatalogService` takes `builtins`
  (a `FoundationalBuiltinSource`) in place of `registry`; wrap a registry with
  `registryBuiltinSource(registry)`. `CoreDependencies.foundationalServiceRegistry` and the facade
  options are unchanged.

### Patch Changes

- 4ac6960: Refresh the dependency tree — direct and transitive — to the latest versions that satisfy the `minimumReleaseAge` supply-chain gate, staying within each dependency's compatible major.

  - **AI SDK family** (held to the major that pairs with `workers-ai-provider`): `ai@^7.0.37 → ^7.0.47`, `@ai-sdk/anthropic`/`@ai-sdk/openai@^4.0.2x → ^4.0.27`, `@ai-sdk/openai-compatible@^3.0.14 → ^3.0.20`, `@ai-sdk/provider@^4.0.3 → ^4.0.4`, `@ai-sdk/amazon-bedrock@^5.0.32 → ^5.0.40`.
  - **Runtime deps**: `pg-boss@^12.26.3 → ^12.26.4`, `@aws-sdk/client-s3@^3.1095.0 → ^3.1101.0`, `@nuxtjs/i18n@^10.5.0 → ^10.6.0`, `@vueuse/core@^14.3.0 → ^14.4.0`.
  - **Tooling**: `wrangler@^4.114.0 → ^4.118.0`, `@cloudflare/workers-types@^5.20260726.1 → ^5.20260801.1`, `oxlint@^1.75.0 → ^1.76.0`, `oxfmt@^0.60.0 → ^0.61.0`, `knip@^6.29.0 → ^6.31.0`, `turbo@^2.10.7 → ^2.10.8`, `vue-tsc@^3.3.8 → ^3.3.9`, `@playwright/test@^1.62.0 → ^1.62.1`, `@types/node@^26.1.1 → ^26.1.2`, `@types/pg@^8.20.0 → ^8.20.3`.

  No `minimumReleaseAgeExclude` entries were added: every bump above already satisfies the gate. The `@cat-factory/executor-harness` and `@cat-factory/deploy-harness` deps are deliberately untouched, since they feed the published runner images and bumping them is a separate image-bumping change. `hono`'s declared range therefore stays at `^4.12.32` (sherif requires one version workspace-wide, and the harness declares it) while the lockfile still resolves 4.12.33 within that range.

- Updated dependencies [f31c644]
- Updated dependencies [4ac6960]
- Updated dependencies [4ac6960]
- Updated dependencies [874d684]
  - @cat-factory/kernel@0.212.0
  - @cat-factory/agents@0.104.0
  - @cat-factory/orchestration@0.184.0
  - @cat-factory/server@0.192.0
  - @cat-factory/node-server@0.152.0
  - @cat-factory/executor-harness@1.86.0
  - @cat-factory/integrations@0.116.1
  - @cat-factory/contracts@0.210.1
  - @cat-factory/gitlab@0.15.1

## 0.94.2

### Patch Changes

- 769a3d9: Close the PR-deep-review parity gap on GitLab: `FetchGitLabClient` now implements
  `listChangedFiles`, `getPullRequestHeadRef`, `getPullRequestHeadSha` and `createReview`. All four
  are optional on the `VcsClient` port and every consumer degrades silently without them, so a
  GitLab deployment previously ran the review flow to completion while the merge track record
  classified every run `unknown` (never matching a per-class merge rule) and the selected findings
  never reached the merge request. Cross-provider conformance now asserts their presence.

  Two breaking shapes ride along, both because a provider that cannot answer must say so rather than
  answer zero:

  - **`GitHubChangedFile.additions` / `deletions` are now `number | null`.** Null means the host did
    not report a count — GitLab withholds the hunk the counts are derived from for an oversized diff,
    and these render straight into the reviewer's prompt, where `+0/-0` describes a file nobody
    touched. GitHub still reports a real `0` for a binary it cannot line-count, and the conformance
    suite pins both. A consumer folding null to `0` must now do so deliberately. GitHub's own mapper
    moves to `githubProjection.toChangedFileProjection` (`@cat-factory/integrations`) so the decision
    sits beside its GitLab counterpart rather than inline in the fetch client.
  - **`logger` is REQUIRED on the GitLab facade builders** (`buildGitLabEngineClient`,
    `buildGitLabConnectClient`, `registerGitLab`) and is kernel's `Logger` rather than a bespoke
    `{ warn }`. It was optional, and consequently no composition root passed one — leaving the page-cap
    truncation warning unreachable in production, on the very reads a review is sliced from. The local
    facade now builds its client through the shared `buildGitLabEngineClient` instead of assembling the
    same pair by hand, so it cannot miss the next thing that builder gains.

- Updated dependencies [769a3d9]
  - @cat-factory/gitlab@0.15.0
  - @cat-factory/kernel@0.211.0
  - @cat-factory/agents@0.103.0
  - @cat-factory/integrations@0.116.0
  - @cat-factory/server@0.191.2
  - @cat-factory/node-server@0.151.2
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/orchestration@0.183.1

## 0.94.1

### Patch Changes

- Updated dependencies [be7135c]
  - @cat-factory/server@0.191.1
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/node-server@0.151.1

## 0.94.0

### Minor Changes

- 876ee2d: Foundational services gain a deployment tier, honest operation indexing, and set-level contract
  validation.

  A deployment can now register its shared-capability estate in CODE, on the app-owned
  `FoundationalServiceRegistry` injected like `PipelineRegistry` / `TaskTypeRegistry`. Registrations
  resolve as the catalog's lowest-precedence `builtin` tier — no rows, so they are present from a
  workspace's first request and cannot drift from the definitions — and are validated at boot against
  the same schema and document checks the REST write boundary applies. An account or workspace row of
  the same id still wins, and either tier can suppress an inherited service: the suppression
  sub-resource is now mounted at BOTH scopes, since an account inherits the deployment tier exactly as
  a board inherits its account's.

  A contract set is validated as a SET rather than per document: a set declared as a TypeScript
  contract format must contain at least one document referencing that library, so the schema modules a
  contract imports can be registered as what they are. A `files`-mode repo source does the same for
  the modules its link explicitly names; folder and directory scans are unchanged.

  Contract MODULE operations are indexed. A `@toad-contracts/core` module is read statically
  (`method` + a literal/template `pathResolver`), and what the extractor could not read is reported
  through `omittedOperations` rather than passing as a complete list. Where a format is not read at
  all, that is now stated instead of rendering as "declares no operations".

  Kernel gains `isContractModulePath`, so a caller asking whether a file could be part of a contract
  module GRAPH reads the same extension list `detectContractFormat` branches on instead of declaring
  its own.

  The enforced capability tags (`asset-storage`, `generation-context`) moved to
  `@cat-factory/contracts` so registrants and the SPA import the same vocabulary, and the write
  boundary refuses a tag that misses one by case or separators.

  Breaking, and deliberate: the merged catalog read (`GET /workspaces/:ws/foundational-services/resolved`)
  no longer carries `ownerKind`, `sourceId`, `sourcePath`, `pinnedCommit`, `createdAt` or `updatedAt` —
  a `builtin` entry has none of them, and filling them with placeholders would read as fact. Those
  fields remain on the per-tier management read. Existing stored `toad-contract` rows keep their empty
  operation index until their next upload or repo sync re-indexes them.

### Patch Changes

- Updated dependencies [73708cf]
- Updated dependencies [876ee2d]
  - @cat-factory/contracts@0.210.0
  - @cat-factory/kernel@0.210.0
  - @cat-factory/integrations@0.115.0
  - @cat-factory/orchestration@0.183.0
  - @cat-factory/server@0.191.0
  - @cat-factory/node-server@0.151.0
  - @cat-factory/agents@0.102.0
  - @cat-factory/gitlab@0.14.23
  - @cat-factory/executor-harness@1.84.0

## 0.93.8

### Patch Changes

- Updated dependencies [0a1170e]
  - @cat-factory/contracts@0.209.0
  - @cat-factory/kernel@0.209.0
  - @cat-factory/agents@0.101.0
  - @cat-factory/gitlab@0.14.22
  - @cat-factory/integrations@0.114.4
  - @cat-factory/orchestration@0.182.2
  - @cat-factory/server@0.190.3
  - @cat-factory/node-server@0.150.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.7

### Patch Changes

- Updated dependencies [d320539]
  - @cat-factory/contracts@0.208.0
  - @cat-factory/kernel@0.208.0
  - @cat-factory/agents@0.100.0
  - @cat-factory/node-server@0.150.0
  - @cat-factory/gitlab@0.14.21
  - @cat-factory/integrations@0.114.3
  - @cat-factory/orchestration@0.182.1
  - @cat-factory/server@0.190.2
  - @cat-factory/executor-harness@1.84.0

## 0.93.6

### Patch Changes

- Updated dependencies [9e5f785]
  - @cat-factory/contracts@0.207.0
  - @cat-factory/kernel@0.207.0
  - @cat-factory/agents@0.99.0
  - @cat-factory/orchestration@0.182.0
  - @cat-factory/gitlab@0.14.20
  - @cat-factory/integrations@0.114.2
  - @cat-factory/server@0.190.1
  - @cat-factory/node-server@0.149.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.5

### Patch Changes

- 8fbc0b5: Serve the repo-sourced Claude Skills library (ADR 0024) over the mothership-mode persistence RPC —
  catalog reads and the repo-sync surface alike — so a local node with no main database can list,
  sync and RUN a skill.

  This was not a blank panel. `skillResolver` is a hard dependency for a `skill` step (and for the
  declared `{ catalogSkillId }` capabilities of ADR 0029), so an un-routed skill catalog failed the
  dispatch, and it failed partially: a skill with no sibling resources resolved from the catalog
  alone while one with resources threw out of the resource fetch, so the feature read as wired. The
  sync half went remote too — unlike the prompt-fragment library, whose sync stays mothership-owned
  because "a mothership node has no GitHub client", a mothership node now reaches GitHub by token
  delegation, so its skill link/sync/unlink routes were live and broken rather than absent.

  Adds a `skillSource` scope rule: the sync methods carry a source id and nothing else, so nothing
  positional binds them; it resolves the source's owning account server-side (memoised, sharing its
  read with the dispatched call). The global `skillSourceRepository.listByRepo` — the push-webhook
  reverse lookup across every account — stays mothership-internal.

  Adds `accountFieldUpsert` alongside it, for a record-keyed write whose conflict key is the record's
  `id` rather than its `accountId`. `accountField` binds only the account a record DECLARES, which is
  sufficient only while the row is stored under that account — an `ON CONFLICT (id) DO UPDATE` that
  does not re-`SET account_id` instead writes whichever row already holds that id, under its own
  account. The new rule binds the stored row too, so a token scoped to one account can no longer name
  another's source id and repoint their link at a repo it controls (whose `SKILL.md` bodies the other
  tenant's next sync would fold into their catalog as agent instructions); an absent row is a create
  and still passes.

  A misconfiguration now also reports itself correctly: the persistence controller's per-request memo
  overrides are applied only for repositories the deployment actually wires, so a mothership without
  the library answers `... is not wired` instead of a scope 404 that reads as a missing row.

  `GitHubInstallationRepository` gains `listActiveForAccount`, the account-scoped form of the cron
  `listActive`. The account-tier installation lookup every repo-sourced library resolves its GitHub
  credential through read EVERY tenant's installations and filtered in JS — unexposable over an
  account-scoped machine API, and unbindable by any scope rule since the method takes no arguments.
  The narrowing ("bound to the account directly, or to one of its own boards") now runs in SQL on
  both runtimes, ordered so they pick the same row, and the resolver makes one query where it made
  two.

  Both ends of a mothership deployment must have the skill/fragment library enabled: the mothership
  reflects the skill repositories into its machine-API registry only when its own library is
  configured, exactly as it does for fragments.

- Updated dependencies [8fbc0b5]
  - @cat-factory/kernel@0.206.0
  - @cat-factory/agents@0.98.0
  - @cat-factory/server@0.190.0
  - @cat-factory/node-server@0.149.0
  - @cat-factory/integrations@0.114.1
  - @cat-factory/orchestration@0.181.1
  - @cat-factory/contracts@0.206.1
  - @cat-factory/executor-harness@1.84.0
  - @cat-factory/gitlab@0.14.19

## 0.93.4

### Patch Changes

- Updated dependencies [5511cdc]
  - @cat-factory/contracts@0.206.0
  - @cat-factory/kernel@0.205.0
  - @cat-factory/agents@0.97.0
  - @cat-factory/integrations@0.114.0
  - @cat-factory/orchestration@0.181.0
  - @cat-factory/server@0.189.0
  - @cat-factory/node-server@0.148.0
  - @cat-factory/gitlab@0.14.18
  - @cat-factory/executor-harness@1.84.0

## 0.93.3

### Patch Changes

- Updated dependencies [1441041]
- Updated dependencies [1441041]
  - @cat-factory/contracts@0.205.0
  - @cat-factory/kernel@0.204.0
  - @cat-factory/orchestration@0.180.0
  - @cat-factory/node-server@0.147.0
  - @cat-factory/agents@0.96.1
  - @cat-factory/gitlab@0.14.17
  - @cat-factory/integrations@0.113.9
  - @cat-factory/server@0.188.1
  - @cat-factory/executor-harness@1.84.0

## 0.93.2

### Patch Changes

- Updated dependencies [0b52df7]
  - @cat-factory/contracts@0.204.0
  - @cat-factory/kernel@0.203.0
  - @cat-factory/agents@0.96.0
  - @cat-factory/orchestration@0.179.0
  - @cat-factory/server@0.188.0
  - @cat-factory/node-server@0.146.0
  - @cat-factory/gitlab@0.14.16
  - @cat-factory/integrations@0.113.8
  - @cat-factory/executor-harness@1.84.0

## 0.93.1

### Patch Changes

- Updated dependencies [b816b6d]
  - @cat-factory/executor-harness@1.84.0

## 0.93.0

### Minor Changes

- 9c6ce7a: Mothership mode: carry a finished run's telemetry up to the mothership.

  Telemetry on a mothership-mode node is captured locally, which until now meant it stayed there: a
  hosted teammate opening a run a developer drove saw an empty observability panel, zero token
  rollups and no web-search log, and the rows vanished when the node's short retention window came
  round. A new machine-authed `POST /internal/telemetry/ingest` (mounted on both facades, gated and
  account-scoped exactly like the persistence RPC) accepts a bounded batch of a run's captured rows,
  and a background sweep on the node uploads each run once it has gone quiet.

  The mothership STAMPS the batch's scope-bound workspace and run onto every row it stores, so a node
  can only ever file telemetry for a run in a workspace it can already reach. Appends are idempotent
  by row id — a new `recordMany` on the three run-scoped telemetry ports, mirrored across D1, Drizzle
  and the local `node:sqlite` store — which is what makes a lost-ack chunk safely retryable.

  Note the deliberate asymmetry between `record` and `recordMany`: only the batch append ignores a
  duplicate id, because only the batch is retried. A batch over the per-request caps is refused
  rather than truncated, since the node treats a success as "this range is stored".

  That last rule is what makes the sweep's success path load-bearing, so two things follow from it.
  A node with no machine token yet rejects with the new `MachineTokenUnavailableError` instead of
  resolving an empty result, which would have read as "this run had no rows" and let the local prune
  delete telemetry that never left the laptop. And batches are budgeted by BYTES as well as row
  count, because the mothership refuses on either — a page built to the row cap alone could sit
  permanently over the body cap. A row too large to post even by itself is skipped and reported
  rather than retried into a stall.

### Patch Changes

- Updated dependencies [9c6ce7a]
  - @cat-factory/kernel@0.202.0
  - @cat-factory/server@0.187.0
  - @cat-factory/node-server@0.145.0
  - @cat-factory/executor-harness@1.82.0
  - @cat-factory/agents@0.95.1
  - @cat-factory/gitlab@0.14.15
  - @cat-factory/integrations@0.113.7
  - @cat-factory/orchestration@0.178.1

## 0.92.2

### Patch Changes

- Updated dependencies [54e6a45]
- Updated dependencies [08e9bcc]
- Updated dependencies [a7aae8a]
  - @cat-factory/agents@0.95.0
  - @cat-factory/contracts@0.203.0
  - @cat-factory/orchestration@0.178.0
  - @cat-factory/server@0.186.0
  - @cat-factory/kernel@0.201.1
  - @cat-factory/integrations@0.113.6
  - @cat-factory/node-server@0.144.2
  - @cat-factory/gitlab@0.14.14
  - @cat-factory/executor-harness@1.82.0

## 0.92.1

### Patch Changes

- Updated dependencies [16fd126]
  - @cat-factory/orchestration@0.177.1
  - @cat-factory/integrations@0.113.5
  - @cat-factory/node-server@0.144.1
  - @cat-factory/server@0.185.2
  - @cat-factory/executor-harness@1.82.0

## 0.92.0

### Minor Changes

- 8c40f33: Record an inline harness-CLI step's model calls PER CALL and LIVE, instead of one lumped row at exit.

  A local-mode document run reported **0 model calls for eight minutes** and then, when it was killed,
  **one row of zero tokens** beside a failure message stating it had burned 896.7k. Both readings came
  from the same cause: an inline step served by a harness CLI is not one model call. `doc-researcher`
  on a host `claude` login runs a whole tool loop — a measured run made 16 calls over 8 minutes —
  behind ONE `doGenerate`, and the instrumentation middleware wrapped around that boundary can only
  ever see the boundary.

  Three consequences, each a different way of being wrong about the same run:

  - **One row for sixteen calls.** `message_count` 2 and `tool_count` 0 on a row whose loop used tools
    throughout, `total_ms` 497316 for "one call", and the fifteen intermediate turns' bodies nowhere.
    The container inline transport dropped its per-call metrics for the same reason: nothing on
    `InlineCliResult` could carry them.
  - **Nothing at all until the subprocess exits.** `wrapGenerate` is a post-hoc hook with no
    `wrapStream` sibling, and the spawn settles only in `child.on('close')`. So the run was dark for
    its whole duration — precisely when someone is watching it.
  - **Zeros whenever it was killed.** The middleware's error path has no usage to attach (a rejection
    carries none), so the row read `total_tokens 0`. What the run spent survived only inside the free
    text of `error_message`, through a deliberately lossy formatter — `896.7k` is not recoverable as an
    integer even in principle.

  **The model now files its own calls, and the middleware stands down.** `CliInlineLanguageModel` takes
  the facade's `InlineLlmCallRecorder` and records each call the CLI reports the moment it arrives, then
  declares `reportsOwnLlmCalls` so `InstrumentedModelProvider` returns it unwrapped — two producers for
  one call would double every token in the step's rollup, and of the two the middleware's is the less
  truthful. The model is ASKED rather than a facade told, because the instrumentation is composed
  OUTSIDE the wrap that substitutes the model (it has to be, or it sees nothing that wrap serves) and
  cannot know what the inner wrap returned.

  **The per-call fold is imported, not re-implemented.** Claude Code emits one envelope per content
  BLOCK, each repeating that call's usage, so folding by `message.id` first is the difference between 31
  calls and 117 — a measured 1.47M tokens inflated to 5.53M. The container harness had already solved
  that, along with the prompt-transcript reconstruction and the routing of subagent turns off the
  parent's chain; local carried a lesser copy of only the usage half, which is exactly why the two
  paths disagreed about how many calls a step had made. `@cat-factory/executor-harness` now exports
  that fold as the `./claude-call-aggregator` subpath and local drives it, so there is ONE
  implementation.

  **Sharing it made the backend a second DRIVER of a reconstruction that had only ever run in a
  container**, and two of its properties are memory rules there rather than niceties. The transcript is
  retained only to `MAX_TRANSCRIPT_CHARS` (512 KiB, the store's own body cap — past that the retention
  could only ever be thrown away), stating what it stopped retaining rather than ending mid-conversation;
  and assembling bodies at all is a switch, off when `LLM_RECORD_PROMPTS` is. Unlike every other body,
  these are BUILT rather than merely passed as a thunk — the growing history, re-serialised per call — so
  a body the store will drop has to be refused at the source. Unbounded, this is the same fault
  `OUTPUT_TAIL_RETAIN_CHARS` already refuses one screen away: hundreds of MB parked in the orchestrator
  process, on precisely the runs worth diagnosing.

  Also: the tag-then-scope attribution precedence is now one shared `resolveInlineAttribution`, since
  two producers apply it; `InlineLlmCall` carries an optional `turnIndex`, real for a harness-CLI call
  and absent for a plain `generateText`; every row names the model the CLI says SERVED that call
  (`call.model ?? requested`, as `makeHarnessCallRecorder` already did — cost is derived per row from
  `(model, token classes)`, and a CLI serves some calls with a cheaper model of its own); and
  `ModelProviderResolverWrapDeps.recordInlineCall` is required-but-nullable, so a facade that FORGOT it
  fails at typecheck rather than shipping a deployment that silently reports no model activity.

  Degradations are stated rather than papered over. The step-level row carries the SHORTFALL — the
  terminal cumulative usage minus what the per-call rows accounted for — which covers three cases with
  one rule: a CLI that narrates nothing (`codex exec`) gets the single row the SDK boundary knows, a
  fully-narrated step gets none (one there would double every token), and a PART-narrated step gets the
  remainder rather than losing it. That last case is why it is a shortfall and not a lump: an older CLI
  build, or a turn that errored before reporting usage, leaves a step whose uncosted turns would
  otherwise simply vanish. An uncosted turn is never filed as a zero-token row, and that rule lives with
  the model, so it holds for the host CLI's stream and a container job's terminal metrics alike. A killed
  step still gets one `ok: false` row at the ordinal after its last completed call, with zero tokens,
  which is now TRUE of it: it stands for the interrupted call, and everything the run really spent is
  already on record. Every fold step is isolated, because the reader runs inside the spawn's `stdout`
  listener and its flush on the killed path runs BEFORE the failure is enriched with the burn clause.

  **Deliberately still open:** the spend LEDGER. `token_usage` is written from the agent result on the
  success path only, so a failed step writes no ledger row on either transport and the budget rollups
  stay blind to what it burned. Closing that needs the failure-path recording seam in orchestration,
  covering the container path in the same change — not a fourth pass over the inline provider.

  `@cat-factory/executor-harness` now emits declarations (`declaration: true`), because the new subpath
  is a `dist` import rather than the compile-only source `./embed` is.

### Patch Changes

- Updated dependencies [8c40f33]
  - @cat-factory/executor-harness@1.82.0
  - @cat-factory/node-server@0.144.0
  - @cat-factory/orchestration@0.177.0
  - @cat-factory/agents@0.94.0
  - @cat-factory/kernel@0.201.0
  - @cat-factory/server@0.185.1
  - @cat-factory/gitlab@0.14.13
  - @cat-factory/integrations@0.113.4

## 0.91.4

### Patch Changes

- Updated dependencies [9d303f0]
  - @cat-factory/contracts@0.202.0
  - @cat-factory/kernel@0.200.0
  - @cat-factory/orchestration@0.176.0
  - @cat-factory/server@0.185.0
  - @cat-factory/agents@0.93.0
  - @cat-factory/node-server@0.143.0
  - @cat-factory/gitlab@0.14.12
  - @cat-factory/integrations@0.113.3
  - @cat-factory/executor-harness@1.80.0

## 0.91.3

### Patch Changes

- Updated dependencies [0bffe55]
- Updated dependencies [1cd9d73]
  - @cat-factory/contracts@0.201.0
  - @cat-factory/kernel@0.199.0
  - @cat-factory/orchestration@0.175.0
  - @cat-factory/server@0.184.0
  - @cat-factory/node-server@0.142.4
  - @cat-factory/agents@0.92.0
  - @cat-factory/gitlab@0.14.11
  - @cat-factory/integrations@0.113.2
  - @cat-factory/executor-harness@1.80.0

## 0.91.2

### Patch Changes

- Updated dependencies [cfda954]
- Updated dependencies [d9789f9]
  - @cat-factory/node-server@0.142.3
  - @cat-factory/kernel@0.198.0
  - @cat-factory/agents@0.91.0
  - @cat-factory/orchestration@0.174.0
  - @cat-factory/contracts@0.200.0
  - @cat-factory/executor-harness@1.80.0
  - @cat-factory/gitlab@0.14.10
  - @cat-factory/integrations@0.113.1
  - @cat-factory/server@0.183.1

## 0.91.1

### Patch Changes

- Updated dependencies [123ac6f]
  - @cat-factory/agents@0.90.0
  - @cat-factory/contracts@0.199.0
  - @cat-factory/executor-harness@1.80.0
  - @cat-factory/integrations@0.113.0
  - @cat-factory/kernel@0.197.0
  - @cat-factory/orchestration@0.173.0
  - @cat-factory/server@0.183.0
  - @cat-factory/node-server@0.142.2
  - @cat-factory/gitlab@0.14.9

## 0.91.0

### Minor Changes

- 550a7fe: Supervise an inline host-CLI run by how long it is STUCK, not by how long it works.

  `spawnCliExec` armed one 300s timer at spawn and never touched it again, so the budget bounded the
  whole run: an inline step was killed for being SLOW rather than for being stuck, with nothing a
  deployment could set to say otherwise. The observed failure is a `doc-researcher` on the ambient
  `claude` CLI killed at exactly 5 minutes having made 53 model calls, burned 2.9M tokens and run 24
  tool calls — legitimate work, mid-turn — and every retry died the same way, so the step could never
  complete. That also made it permanently unaccounted for: usage reaches `token_usage` from a call
  that COMPLETED, so a step that dies on every attempt records nothing however much it spent, which
  is what "the run shows zero model calls" actually meant.

  Two budgets now, because "hung" and "long" are different failures with opposite fixes:

  - an **idle** window (`LOCAL_INLINE_CLI_IDLE_TIMEOUT_MS`, default 300000) re-armed by every chunk on
    either stream, so it measures the gap between bytes. `stream-json` narrates a healthy `claude`
    continuously, so silence this long is a real symptom while elapsed time never was.
  - an absolute **ceiling** (`LOCAL_INLINE_CLI_MAX_TIMEOUT_MS`, default 3600000) for the run that
    narrates forever and therefore never looks idle — the one case an idle window cannot bound.

  Both still reject as a `timeout` (unchanged for callers), but they say different things: the idle
  kill names the silence it overran, the ceiling kill names the ceiling and the variable that raises
  it. The idle message drops the redundant silence clause it would otherwise restate. The FIRST kill
  wins: every trigger stays armed until the child closes, so an abort landing inside the SIGKILL
  grace period used to overwrite the reason and surface a supervised kill as a user cancellation.

  New in `@cat-factory/server`: `parseTimerEnvMs`, the validator for an env var that becomes a
  `setTimeout` delay, beside the `parseNumericEnv` it is deliberately stricter than. A plain numeric
  knob is right to accept `0` / `-1` / `1.5`; a timer budget is not, and neither is a value above
  `MAX_TIMER_DELAY_MS` (2147483647) — Node truncates a larger delay to **1ms** rather than saturating,
  so the number an operator types meaning "effectively no ceiling" is exactly the one that would kill
  every supervised run within milliseconds, while reporting the enormous ceiling it claims to have
  hit. Every unusable spelling now warns and defers to the built-in default.

  The incoherent-pair warning (a ceiling below the idle window makes the idle watchdog unreachable, so
  a stuck CLI is reported as a slow one and the operator raises the wrong number) now compares the
  EFFECTIVE budgets rather than only the explicitly-set ones — lowering just the ceiling is the likelier
  single-knob edit, and gating on both being present let exactly that case through in silence.

### Patch Changes

- Updated dependencies [550a7fe]
  - @cat-factory/server@0.182.0
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/node-server@0.142.1

## 0.90.4

### Patch Changes

- Updated dependencies [99412e2]
  - @cat-factory/contracts@0.198.0
  - @cat-factory/kernel@0.196.0
  - @cat-factory/integrations@0.112.0
  - @cat-factory/server@0.181.0
  - @cat-factory/node-server@0.142.0
  - @cat-factory/agents@0.89.1
  - @cat-factory/gitlab@0.14.8
  - @cat-factory/orchestration@0.172.1
  - @cat-factory/executor-harness@1.78.0

## 0.90.3

### Patch Changes

- Updated dependencies [1904eb8]
  - @cat-factory/kernel@0.195.0
  - @cat-factory/agents@0.89.0
  - @cat-factory/orchestration@0.172.0
  - @cat-factory/server@0.180.0
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/gitlab@0.14.7
  - @cat-factory/integrations@0.111.2
  - @cat-factory/node-server@0.141.1

## 0.90.2

### Patch Changes

- f9db6a6: Record the inline LLM calls that local mode serves from a host CLI, and stop filing run-scoped
  inline calls under a null execution id.

  The inline `llm_call_metrics` feeder was applied as the innermost provider wrap, so local mode's
  subscription-inline harness — which answers a Claude Code / Codex ref with its own
  `CliInlineLanguageModel` rather than delegating — was invisible to it. With `LOCAL_NATIVE_INLINE`
  on (the default), every inline step on a host `claude`/`codex` login recorded zero calls while the
  same step on a metered API model recorded fine. Separately, ten of the twelve inline call sites
  tagged only the workspace, so their rows landed with `execution_id = NULL`: in the store, but
  absent from every run-scoped read.

  Attribution also no longer trusts a settled run: `resolveBlockRunContext` drops the execution id
  once the run is terminal (keeping the initiator), because `block.executionId` is the block's LAST
  run rather than necessarily a live one. A stale id would report an inline call's spend against a
  finished run's rollup, and unlike a null nothing about a wrong-but-plausible id looks wrong.

  Compatibility breaks (pre-1.0, no shims):

  - `createScopedModelProviderResolver` no longer takes `instrument`, and the instrumentation and
    concurrency-limiter wraps are no longer exported individually. Apply the new
    `wrapResolverWithTelemetry(resolver, { instrument, limiter })` on top of the resolver — after any
    facade wrap that can substitute a resolved model. It owns the ORDER of the two wraps, which is
    load-bearing and which nothing in the type system holds: reversed, the composition still
    type-checks and still records every non-substituted call. Replace a `wrapResolverWithLimiter`
    call with the `limiter` field (build it with `vendorConcurrencyLimiterFromEnv`; it stays a
    pass-through when nothing is capped).
  - `createNodeModelProviderResolver` builds the BASE resolver only; its `instrument` and
    `workspaceSettingsRepository` parameters are gone, and the env-built trace-sink instrument it
    used to fall back to is now the exported `inlineInstrumentFromEnv(env, workspaceBodiesEnabled)`.
    A deployment assembling its own container composes the two — and MUST: a caller that merely drops
    the removed arguments compiles fine and silently stops instrumenting its inline calls.
  - `InlineInstrumentation` is now exported from `agents/modelProviderResolver` rather than derived
    from `ScopedModelProviderOptions['instrument']` (same shape, same import path from the package
    root).
  - `FragmentBriefService.resolveBriefs` takes its run on an options object (`{ executionId }`)
    rather than as a third positional argument.
  - `@cat-factory/agents` additionally exports `LimitedModelProvider`, so a facade wiring test can
    assert the wrapper it composed.

- Updated dependencies [f9db6a6]
  - @cat-factory/server@0.179.0
  - @cat-factory/node-server@0.141.0
  - @cat-factory/agents@0.88.0
  - @cat-factory/kernel@0.194.0
  - @cat-factory/orchestration@0.171.1
  - @cat-factory/executor-harness@1.78.0
  - @cat-factory/gitlab@0.14.6
  - @cat-factory/integrations@0.111.1

## 0.90.1

### Patch Changes

- 28ad35a: Respect the target repository's own pull-request template: a PR-opening coding dispatch now finds
  it and the agent fills it in, instead of the platform's free-form briefing.

  Neither GitHub nor GitLab applies a template to an API-created pull request — that only happens for
  a human opening one in the web form — so the platform's pull requests were the only ones on a repo
  silently missing the structure its reviewers expect, with nothing failing or warning to say so.

  The harness discovers the template from the checkout it already has (`.github/PULL_REQUEST_TEMPLATE.md`
  and GitHub's root/`docs/` and multi-template-directory variants, plus GitLab's
  `.gitlab/merge_request_templates/`; case-insensitive, both hosts' conventions probed whatever the
  repo's provider) and folds it into the prompt of the agent that just did the work, which writes its
  `.cat-pr-description.md` as the filled template. Where the template asks for something the platform's
  briefing guidance does not, the template wins. Repos shipping no template are byte-for-byte
  unaffected.

  A filled template's headings are the REPO's, so the sentinel is read back with the leading-`#` title
  rule switched off: a template whose first heading is its only level-1 one would otherwise have that
  heading lifted as the pull request's title, replacing the platform's own and deleting the heading
  from the body. A template symlinked out of the checkout is refused rather than read, since this is
  the one repo-chosen path the harness reads without the agent asking for it.

  A directory holding SEVERAL templates with no `default` is deliberately left alone: that directory
  exists so a human can choose per pull request, and picking one arbitrarily would file every run's
  work under whichever name sorts first while looking deliberate.

  Bumps the runner image to `1.77.0` (harness `src/**` changed).

- Updated dependencies [28ad35a]
  - @cat-factory/executor-harness@1.78.0

## 0.90.0

### Minor Changes

- be7fe66: Let a deployment declare its infra dependencies in code: `startNode`/`startLocal` take
  `seedSharedStacks`, and a compose layer can now be an inline document or a file in another repo.

  A `StackRecipe`'s and a `SharedStack`'s `composeFiles` entries are now `ComposeFileRef`s — a bare
  in-repo path (unchanged, still the common case) or an explicit `ComposeSource`: `inline` (the
  compose document itself) or `repo` (a path in another `owner/name`, read without cloning it). A
  stack whose layers are all inline / foreign owns no repository, so `SharedStack.cloneUrl` is
  nullable.

  An `inline` layer may name where it is materialized, and that path is host-escape guarded on every
  path that accepts one: a layer that would land outside the checkout is refused when the shared
  stack is SAVED (`details.reason: 'compose_layer_escapes_checkout'`) and again before any layer is
  read or written, alongside the recipe path's existing pre-daemon check.

  Breaking (pre-1.0): `SharedStack.cloneUrl` is `string | null` rather than `string`, and
  `composeFiles` entries widen from `string` to `string | ComposeSource`. D1 migration `0070`
  rebuilds `shared_stacks` to relax the `clone_url` NOT NULL; the Drizzle mirror does the same. No
  data changes — every existing row keeps its clone URL and its plain-path layers.

### Patch Changes

- Updated dependencies [be7fe66]
  - @cat-factory/contracts@0.197.0
  - @cat-factory/kernel@0.193.0
  - @cat-factory/integrations@0.111.0
  - @cat-factory/orchestration@0.171.0
  - @cat-factory/node-server@0.140.0
  - @cat-factory/agents@0.87.2
  - @cat-factory/gitlab@0.14.5
  - @cat-factory/server@0.178.2
  - @cat-factory/executor-harness@1.76.2

## 0.89.0

### Minor Changes

- 65e0299: Make a killed inline CLI run account for what it spent.

  A local-mode `doc-researcher` step failed with `claude timed out after 300000ms` and nothing else.
  Four attempts had actually run — 31 model calls, 1.47M tokens, 1.32M of it cache-read — and every
  one of them was billed and recorded nowhere: a failed step writes no `token_usage` row on either
  transport. So the run read as idle. `agent_runs` sat at `rev=1`, no container was alive, no usage
  existed, and the only surviving account of what the agent had done was the CLI's own session
  transcript under the developer's `~/.claude`. Concluding "it was working the whole time" took
  mining that transcript by hand.

  Two gaps lined up. The watchdog and abort paths rejected with the bare fact that the budget had
  elapsed, discarding the stdout they were holding — the same defect the previous fix addressed for
  the non-zero-exit path and left untouched on these two. And the runner took `--output-format json`,
  whose single result object exists only if the CLI reaches the END, so a killed run had no usage to
  recover even in principle.

  **The inline `claude` runner streams.** `--output-format stream-json --verbose`, as the container
  harness already runs it, instead of the one-shot `json`. The terminal `result` event carries the
  same fields the single object did, so the success path is unchanged and still treats the CLI's own
  cumulative figure as authoritative; the difference is that a killed run now leaves a partial stream
  to account for itself with.

  **Every bad end carries its evidence.** `spawnCliExec` rejects with a `CliExecFailure` naming how
  the run died (`timeout` / `aborted` / `exit`), and the vendor runner appends what its fold observed:
  `claude timed out after 300000ms; silent for 69s; burned 1.45M tokens (1.40M cache-read) across 2
model calls`. When the model was never reached it says `no model call completed` — the distinction
  the old message could not make, and the first fork in the road between a stalled CLI and one that
  never got going. The enriched throw stays a `CliExecFailure`, so `reason` is readable on the error a
  caller catches and not only one link down the `cause` chain.

  **The stream is CONSUMED, never buffered.** `spawnCliExec` grew a `CliExecOptions.onLine` observer;
  supplying one replaces body retention, and the claude runner feeds a stateful `ClaudeStreamFold`
  that holds a bounded summary (per-call usage, the terminal event) rather than the stream. That is
  load-bearing rather than tidy: `stream-json` output is unbounded in a way the one-shot `json` object
  never was — every assistant envelope, every `tool_use` input and every tool_result, for as long as
  the watchdog allows — and this runner bypasses permissions, so a stalled tool-using run would have
  parked hundreds of MB in the orchestrator process, on precisely the runs this change exists to
  diagnose. Only a bounded tail is kept, for the failure message. The container harness's `streamCli`
  retains no body for the same reason. Because the fold outlives the rejection, the evidence no longer
  has to ride on the error — which is also why the failure carries no output.

  Two consequences of parsing what used to be an opaque body. Both streams are decoded with
  `setEncoding('utf8')` rather than per-`Buffer`, since a multi-byte character split across a chunk
  boundary decodes to replacement characters and these lines are handed to `JSON.parse` — one unlucky
  boundary would have silently dropped an event, and its usage, from the fold. And the final line is
  flushed on close, because it has no terminator in the two cases that matter: a clean run whose
  terminal `result` event is the last thing written, and a killed one cut mid-JSON.

  **Silence is measured rather than inferred from the exit.** Mirroring the container harness's
  breadcrumb and its 30s threshold, so a fast failure gains no true-but-useless "said nothing"
  clause. The wording claims only what this channel supports — the child's own stdout/stderr — so it
  says "silent", not the harness's "no activity", which also counts keep-alive beats.

  Envelopes are folded by `message.id` before summing. Claude Code emits one envelope per CONTENT
  BLOCK, each repeating that one call's `usage`, so summing per envelope multiplies the burn: on the
  run above, 117 envelopes carried 31 real calls and the naive sum inflated 1.47M tokens to 5.53M
  (3.8x). `docs/initiatives/token-burn-instrumentation.md` records the container harness falling into
  exactly this trap; `claude-call-aggregator.ts` is the fix it landed. Only usage that PARSES is
  folded, so the call count means "calls that reported a burn" — counting envelopes that merely
  carried a `usage` key would produce "burned 0 tokens across 3 model calls", contradicting the
  `no model call completed` branch it sits beside.

  Behaviour change worth flagging: local mode now invokes `claude` with `--output-format stream-json
--verbose`. A CLI build that doesn't support the streaming format would fail where it previously
  succeeded.

  Deliberately still open: the tokens are SURFACED, not ledgered. A failed step writes no
  `token_usage` row on either transport, so the spend gate and quota rollups remain blind to them.
  Closing that needs a failure-path recording seam in orchestration, which should cover the container
  path in the same change rather than growing this one.

## 0.88.9

### Patch Changes

- Updated dependencies [83fd037]
  - @cat-factory/kernel@0.192.0
  - @cat-factory/contracts@0.196.0
  - @cat-factory/orchestration@0.170.0
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/agents@0.87.1
  - @cat-factory/gitlab@0.14.4
  - @cat-factory/integrations@0.110.5
  - @cat-factory/server@0.178.1
  - @cat-factory/node-server@0.139.1

## 0.88.8

### Patch Changes

- Updated dependencies [7248b72]
- Updated dependencies [449d856]
  - @cat-factory/contracts@0.195.0
  - @cat-factory/kernel@0.191.0
  - @cat-factory/agents@0.87.0
  - @cat-factory/orchestration@0.169.0
  - @cat-factory/server@0.178.0
  - @cat-factory/node-server@0.139.0
  - @cat-factory/gitlab@0.14.3
  - @cat-factory/integrations@0.110.4
  - @cat-factory/executor-harness@1.76.2

## 0.88.7

### Patch Changes

- 4ecb25c: Record inline (non-proxied) LLM calls into `llm_call_metrics`, so an inline agent step's model
  activity is visible in-app instead of only in an external trace backend.

  `InstrumentedModelProvider` was the one LLM feeder that wrote to no repository: it called
  `traceSink.recordGeneration` and nothing else. So every inline call site — the judges, consensus,
  the requirements writer, the fragment selector, the fork chat, and the inline agent kinds
  (`doc-researcher`, `doc-outliner`, the document interviewer) — was invisible to
  `ObservabilityPanel`, to a step's token rollup and to `/api/v1/debug/*`. A run made entirely of
  inline steps reported zero model activity no matter what it spent, on the surfaces an operator
  actually opens. This is the coverage half of C2 in `docs/initiatives/observability-logging-gaps.md`
  (slice 5.6); its privacy half landed earlier.

  The provider now has a second exit, the kernel `InlineLlmCallRecorder` port, implemented by
  orchestration's `makeInlineCallRecorder` over the same `LlmObservabilityService` the proxy and the
  subscription harnesses already feed — so all three producers converge on one store rather than a
  third recording path being invented.

  Two things a reviewer should look at closely. First, the provider takes **exactly one** exit per
  call: the service behind the recorder performs the trace-sink fan-out itself, so a recorded call
  must not also be emitted to the provider's own sink — doing both would double every inline
  generation on Langfuse/OTel. Because that invariant binds two objects a facade could easily build
  from different sinks (which typechecks, and merely splits the trace), neither facade assembles the
  pair: `createInlineInstrumentation` composes both exits from one sink instance, and leaves the
  provider's `traceSink` as the fallback for a call carrying no `workspaceId` (the metric store is
  workspace-scoped, so such a call has no row to be filed under — the same deliberate fail-open the
  body gate already takes for an untagged call). Second, bodies now reach the recorder ungated: the
  service applies the identical `LLM_RECORD_PROMPTS` + `storeAgentContext` gate from the same kernel
  factory, plus `redactSecrets` and the prompt delta chain. Re-gating in the provider was rejected
  because it would withhold text the store is entitled to keep and restore the two-places-one-rule
  shape that produced C2's privacy half in the first place; instead the bodies cross as thunks and
  `record` resolves its gate before touching one, so a prompts-off deployment never serialises a
  prompt that is about to be discarded.

  **A second, pre-existing instance of C2's privacy half is fixed here too.** On both runtimes
  `makeHarnessCallRecorder`'s `LlmObservabilityService` was built with no `workspaceSettingsRepository`,
  and an absent repository makes `createStoreAgentContextGate` a constant `true` — so a subscription
  harness's full `stream-json` prompt and response were retained for a workspace that had explicitly
  opted out. It went unnoticed because that failure is silent by construction: nothing errors, the
  rows simply keep their bodies. Both facades now thread the repository. Existing rows are not
  rewritten; the fix applies from the next recorded call.

  The row mapping deliberately reports what an inline call does not know rather than filling
  proxy-shaped fields with plausible values: `turnIndex` null, `httpStatus` null, `phase` `''`,
  `streaming` false, and `upstreamMs === totalMs` so the derived overhead is a real 0. Conformance
  pins each of those on both runtimes' real stores, since each is one a store could quietly flatten.
  Anything reading these rows should expect inline calls in the unattributed `phase=""` slice —
  `backend/docs/debug-api.md` and the `investigate-telemetry` skill now say so.

  **A live bug on the existing trace-sink path is fixed on the way through:** the inline feeder read
  `finishReason` as a bare string, but the current AI-SDK spec reports it as `{ unified, raw }` — so
  every inline call has been exporting `finishReason: null`, which reads in telemetry as "the
  provider didn't say" rather than as a parse miss. It survived because the tests fed the reader a
  hand-rolled result carrying the shape the reader wanted; they now drive the SDK's own
  `MockLanguageModelV3` through a real `generateText`, which is what surfaced it. Both provider test
  suites are consolidated into the one beside the class (they had drifted into two packages).

  Behaviour note: an `InstrumentedModelProvider` built with neither exit wired now throws at
  construction. Nothing in-tree does that, and it would previously have been a silent no-op wrapper
  that still satisfied the facades' wiring assertions.

- Updated dependencies [4ecb25c]
  - @cat-factory/kernel@0.190.0
  - @cat-factory/agents@0.86.0
  - @cat-factory/orchestration@0.168.0
  - @cat-factory/server@0.177.0
  - @cat-factory/node-server@0.138.0
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/gitlab@0.14.2
  - @cat-factory/integrations@0.110.3

## 0.88.6

### Patch Changes

- Updated dependencies [7ed2bc0]
  - @cat-factory/contracts@0.194.0
  - @cat-factory/kernel@0.189.0
  - @cat-factory/agents@0.85.0
  - @cat-factory/orchestration@0.167.0
  - @cat-factory/server@0.176.0
  - @cat-factory/node-server@0.137.0
  - @cat-factory/gitlab@0.14.1
  - @cat-factory/integrations@0.110.2
  - @cat-factory/executor-harness@1.76.2

## 0.88.5

### Patch Changes

- 2d43c1f: Run the executor-harness and smoketest-harness unit suites in CI.

  The unit lane is `pnpm -r run test:run`, and neither package defined that alias — so 560
  executor-harness tests and 15 smoketest-harness tests had never run in CI. Their
  `benchmark-harness` / `deploy-harness` siblings each carry an alias identical to their own `test`
  script for exactly this reason, and there is no history of it being removed from either laggard,
  so this reads as an omission rather than a decision.

  Only `test:acceptance` ran before, in the Container acceptance lane, which covers the Docker
  end-to-end path and none of the unit surface: the watchdogs, the failure classifier, the
  call-metric aggregator, git auth/checkout/PR, redaction, the progress guard, validation and the
  reproduction proof.

  Both default vitest configs are already unit-only and offline (`include: ['test/*.test.ts']`, with
  the Docker suite in its own config), so they belong in that lane as-is.

  `package.json` is an executor image source, so the harness version and its three pins move with
  it — no source under `src/` changed, so the new image is byte-identical in behaviour to the one
  it replaces.

- Updated dependencies [2d43c1f]
- Updated dependencies [85efc27]
- Updated dependencies [9794c19]
  - @cat-factory/executor-harness@1.76.2
  - @cat-factory/contracts@0.193.0
  - @cat-factory/kernel@0.188.0
  - @cat-factory/orchestration@0.166.0
  - @cat-factory/server@0.175.0
  - @cat-factory/gitlab@0.14.0
  - @cat-factory/agents@0.84.2
  - @cat-factory/integrations@0.110.1
  - @cat-factory/node-server@0.136.1

## 0.88.4

### Patch Changes

- 5b19dab: Make a silently-failing agent run say what happened.

  An agent step failed in local mode with `claude exited with code 1: ` — the exit code, a colon,
  and nothing after it — plus `Phase timings: starting=0s, clone=1s, agent=564s. Failed in agent
phase; no tool had completed yet`. Every piece of evidence that would have identified it was
  either discarded or unreachable: no watchdog had fired (so it was not classified as a hang), the
  cold-start diagnostic recorded at the 120s mark had no consumer outside the container log, the
  CLI's session transcript died with its per-run config home, and the container was removed the
  moment the job settled. The retry succeeded, which is the worst outcome for diagnosis — nothing
  left to inspect and no reason to believe it won't recur.

  Three things now carry the evidence the harness already had:

  **A bad CLI exit carries the CLI's own report.** Both agent CLIs report a terminal failure on
  STDOUT inside their event stream — Claude Code's `result` event, Codex's last agent message — and
  leave stderr EMPTY. `streamCli` rejected with the stderr tail alone, so an upstream refusal (quota,
  rate limit, a provider outage the CLI retried out on) was rendered as an exit code and a dangling
  colon, while the explanation sat in a local variable only the success path read. The rejection now
  folds that report in, says `(no stderr output)` rather than trailing off, and names the SIGNAL when
  one killed the process instead of rendering "code null" — which is the first fork in the road
  between "the CLI gave up" and "something killed the container".

  **The failure detail says how quiet the run had gone.** Exit status cannot distinguish a crash
  from a stall: both are non-zero with an empty stderr. Phase timing plus silence can. The
  breadcrumb now adds `silent for 564s`, or `no activity at all in 564s` when the run never
  produced a byte — suppressed under 30s, and on an inactivity kill whose own message already states
  the window it waited out, so it appears only where it changes the diagnosis. It is worded as
  ACTIVITY rather than agent output because that is what the channel carries: the activity-silent
  phases (dependency install, pre-PR validation, the reproduction proof, the frontend stand-up) feed
  it synthetic keep-alive beats to hold the inactivity watchdog off, so a run that beat every 30s
  through its install and then died has been heard from even though the agent never spoke.

  **The cold-start diagnostic reaches the run.** ADR 0026 D4 asks for it to be surfaced on the step;
  it was recorded on the job view and logged in the container, where a developer reading a failed run
  in the SPA never sees it. It is now folded into the failure `detail`, the one failure field the
  backend already carries onto the step — no new field on every transport hop. Surfacing it on a
  still-RUNNING view (the early warning) stays open as observability-logging-gaps slice 5.5.

  The local runtime's native inline runner had the same defect in miniature: it runs
  `claude -p --output-format json`, whose error JSON also lands on stdout, and its non-zero-exit
  branch kept only stderr — so the in-band `is_error` check its caller performs was unreachable
  exactly when the CLI exited non-zero. It now reports whichever stream spoke, scrubbed through
  `redactSecrets` at the emit site: that message carries raw command output, and on this path stdout
  holds the model's own text, which is strictly more exposed than the stderr the sibling in the
  container harness was already redacting.

  **`describeProcessExit` is a new kernel export**, the shared sentence for how a subprocess ended.
  The `null`-code-means-signal distinction is operational knowledge rather than formatting, and it
  was about to exist in two hand-written copies; a third and fourth transport (pooled runner, K8s
  pod, native host process) report process exits too and should inherit it rather than rediscover
  it. The executor-harness keeps a pinned copy because the container image can depend on no
  workspace package — the same arrangement `host-markdown` has, held equal by a conformity test.

  Behaviour change to be aware of: the non-zero-exit message shape is different (`(no stderr
output)`, a `killed by SIGKILL` variant, an appended report). Nothing classifies on it — the
  backend reads the structured `failureCause`, and the string-fallback classifiers were deleted in
  error-message-coverage I5 — but a human-facing string that appeared in past runs has changed.

  Deliberately NOT changed: the failure still classifies as the generic `agent` cause. `llm-upstream`
  exists and is documented as exactly this case, but the only signal available for it is the CLI's
  `result` prose plus a `subtype` whose vocabulary is not contractual — classifying on that would
  reintroduce the string matching I5 deleted, and a wrong structured cause is worse than a generic
  one because the backend acts on it. Surfacing the report is what makes the follow-up decidable.

- Updated dependencies [57e1195]
- Updated dependencies [5b19dab]
- Updated dependencies [5b19dab]
  - @cat-factory/executor-harness@1.76.0
  - @cat-factory/contracts@0.192.0
  - @cat-factory/kernel@0.187.0
  - @cat-factory/integrations@0.110.0
  - @cat-factory/orchestration@0.165.0
  - @cat-factory/server@0.174.0
  - @cat-factory/node-server@0.136.0
  - @cat-factory/agents@0.84.1
  - @cat-factory/gitlab@0.13.36

## 0.88.3

### Patch Changes

- Updated dependencies [e087b40]
  - @cat-factory/contracts@0.191.0
  - @cat-factory/kernel@0.186.0
  - @cat-factory/agents@0.84.0
  - @cat-factory/orchestration@0.164.0
  - @cat-factory/server@0.173.0
  - @cat-factory/node-server@0.135.0
  - @cat-factory/gitlab@0.13.35
  - @cat-factory/integrations@0.109.6
  - @cat-factory/executor-harness@1.74.0

## 0.88.2

### Patch Changes

- 0eacaa2: Move private package registries into the Infrastructure window, and stop requiring package scopes.

  The registries a checkout installs from are part of where agent containers RUN, not an optional
  external system a workspace links in, so they are now a tab of the Infrastructure window
  (alongside Agent containers / Test environments / Shared stacks) rather than an Integrations-hub
  row with a modal of its own. The tab still gates on the module's own probe, so an unconfigured
  backend shows no dead tab. `ui.infrastructureTab` is typed against the window's full tab
  vocabulary rather than the two provider-connection kinds, so the non-connection tabs (shared
  stacks, package registries) are reachable by deep link instead of only by opening the window and
  clicking across.

  Package scopes are now OPTIONAL on an entry, and leaving them empty is often the right answer: an
  npmrc scope mapping is all-or-nothing, so routing `@org` to a private registry makes every
  `@org/*` package resolve from it — which breaks an organisation that publishes part of that scope
  publicly. A scope-less entry still emits the registry host's `_authToken` line, which is all a
  checkout needs whenever the ROUTING is already settled elsewhere: the repository commits its own
  `.npmrc` (project config wins over the user config the harness writes), single dependencies carry
  a named-registry prefix (`"@acme/private": "gh:^1.0.0"` — pnpm >= 11.1.0, pnpm/pnpm#11324), or the
  vendor simply IS the default registry, where a scope mapping back to `registry.npmjs.org` was
  always a no-op and only the credential was missing. The form explains this next to the field and
  previews the scopes it parsed, so an empty save reads as deliberate rather than as a field that
  silently swallowed what was typed.

  Compatibility: a scope-less entry needs harness image `1.73.0` or newer. Note the blast radius —
  an older image does not skip the entry, it fails `parseJob`, so EVERY container dispatch in that
  workspace dies (`packageRegistries[i].scopes must be a non-empty array`), not just dependency
  installs. The backend has no signal for what image a pool pins, so this cannot be gated
  server-side: a self-hosted runner pool must be updated before a workspace configures a scope-less
  entry. Deployments on the managed image are carried by the pin bump in this release.

  Also: a package-registries read that fails for any reason OTHER than the module being
  unconfigured now propagates instead of being swallowed, so the panel reports it. Previously a
  `503` (no module) and an unreachable backend both rendered as an empty, silent surface — and with
  the panel behind an availability-gated tab, the second case had no surface at all.

- Updated dependencies [0eacaa2]
  - @cat-factory/contracts@0.190.0
  - @cat-factory/executor-harness@1.74.0
  - @cat-factory/orchestration@0.163.1
  - @cat-factory/agents@0.83.1
  - @cat-factory/gitlab@0.13.34
  - @cat-factory/integrations@0.109.5
  - @cat-factory/kernel@0.185.1
  - @cat-factory/server@0.172.2
  - @cat-factory/node-server@0.134.2

## 0.88.1

### Patch Changes

- Updated dependencies [1fa8ef7]
  - @cat-factory/orchestration@0.163.0
  - @cat-factory/kernel@0.185.0
  - @cat-factory/agents@0.83.0
  - @cat-factory/server@0.172.1
  - @cat-factory/node-server@0.134.1
  - @cat-factory/executor-harness@1.72.0
  - @cat-factory/gitlab@0.13.33
  - @cat-factory/integrations@0.109.4

## 0.88.0

### Minor Changes

- 8251a99: Give every request and every container job a correlation id.

  Both facades now mount a shared request middleware as their FIRST middleware — ahead of CORS and
  the per-request container build, so a CORS denial and the Worker's misconfiguration fallback are
  covered too. It adopts a bounded, safe `X-Request-Id` from the caller or mints one, echoes it on
  the response, puts it in **every error envelope**, binds `{ requestId, method, path }` on a
  request-scoped child logger, and emits one line per request: `info` on success, `warn` on a 4xx
  (naming the mapped error code), `error` on a 5xx. Previously only unexpected 500s were logged at
  all, so a 4xx spike — a validation regression, an RBAC denial, a conflict loop — left no
  server-side trace and a user report had nothing to join against. `/health` and `/ready` drop to
  `debug` when they succeed, so an orchestrator's probes don't bury the request stream.

  `X-Request-Id` is allow-listed inbound (so a caller that already has an id propagates it rather
  than the backend minting a second one for the same request) and newly EXPOSED outbound, so a
  browser can read it off the response.

  The **misconfiguration fallback backend** is covered on every facade. The Worker inherits the
  middleware because it serves the fallback from inside `createApp`, but Node/local swap in the
  whole `createMisconfiguredApp` — so that app mounts it itself, or the one deployment shape an
  operator is actively debugging is the only one serving requests with no id and no request line.

  Across the workflow↔container seam, `workspaceId` and `executionId` now ride the agent job body
  and the harness binds them onto its per-job logger beside `jobId` — the two halves of a run
  previously shared no id and were stitched only by a job-id naming convention. This covers EVERY
  dispatcher of the `agent` kind, not just the execution path: `ContainerRepoBootstrapper` and
  `ContainerEnvConfigRepairer` hand-build their bodies, and a bootstrap is a first-class agent run
  (same table, same retry surface), so leaving them out would have left their containers' logs
  joinable to nothing. Neither has a separate execution row, so the job id doubles as the run id.

  `ContainerAgentExecutor` gained a bound logger and logs the seam's transitions (dispatched /
  dispatch-failed / poll-failed / running at `debug` / settled). A dispatch OR poll that throws is
  now reported: those are the failure classes nothing downstream can account for, because the job
  either never gets a handle or the transport fault is recorded against no job at all.

  Only the request PATHNAME is ever logged, never the raw URL, and a client-supplied id is refused
  unless it is short and `[\w\-=]+` — both are untrusted text going straight into a log stream, and
  query strings carry the WebSocket `?ticket=` and OAuth `?code=`. An unexpected fault's STACK is
  scrubbed with `redactSecrets` in its own right, not just its message: a stack's first line is
  `Error: <message>` verbatim, so attaching it raw beside the scrubbed `err` would republish
  exactly what the scrub just removed.

### Patch Changes

- Updated dependencies [8251a99]
  - @cat-factory/server@0.172.0
  - @cat-factory/node-server@0.134.0
  - @cat-factory/executor-harness@1.72.0

## 0.87.1

### Patch Changes

- f0be8a7: Retire the three shapes that let phase 2's defects happen, without changing behaviour.

  Both durable drivers now fail a run through one shared `RunFailure` value
  (`failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`) instead of positional
  arguments each assembles itself. Every one of those parameters carried a default, so a driver
  that stopped short still compiled and recorded `null` — which is how the Cloudflare driver came
  to drop `AgentFailure.reason` on every path while its runtime-neutral twin forwarded it. An
  omitted field is now a typecheck failure.

  Controllers guard through two shared total accessors, `requireCapability` and `requireUser`
  (`@cat-factory/server`'s `http/guards.ts`, the siblings of `param()`, and exported from the
  package root alongside `param`). The per-controller `requireX(c): Module | null` forced every
  route to restate `if (!x) return unavailable()`, and 51 controllers had each declared their own
  copy of the thrower to satisfy it; making the accessor total deletes the guard line at ~300 call
  sites. Each has an `assert*` twin for a route that needs a capability wired but reads nothing off
  it, so the guard never reads as a discardable no-op statement.

  `createStoreAgentContextGate` moves to `@cat-factory/kernel` (`StoreAgentContextGate`) and is
  now the single implementation of the per-workspace body-capture rule, shared by the proxied
  (`LlmObservabilityService`) and inline (`InstrumentedModelProvider`) paths. Phase 2 gave the
  inline path a gate but wrote the rule a second time in a second package, leaving the two free to
  drift apart exactly as they had.

  Breaking (pre-1.0, no migration): `createStoreAgentContextGate` is no longer exported from
  `@cat-factory/server` — import it from `@cat-factory/kernel`. Its dependency shape is unchanged.

- Updated dependencies [f0be8a7]
  - @cat-factory/kernel@0.184.0
  - @cat-factory/server@0.171.0
  - @cat-factory/agents@0.82.4
  - @cat-factory/orchestration@0.162.0
  - @cat-factory/node-server@0.133.1
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/gitlab@0.13.32
  - @cat-factory/integrations@0.109.3

## 0.87.0

### Minor Changes

- a8cc6b2: Roll a run's model spend up by the PHASE that spent it, so "why did this small task cost a million
  tokens" is a breakdown rather than a guess. The per-call phase axis already existed; what was
  missing was the aggregate that reads it.

  Each phase reports its turns, the three input classes, its output, and a **carry cost**: each
  call's total input counted once for every later turn in the SAME conversation that had to re-send
  it. That is the figure a plain token sum cannot produce — it separates a phase that read a lot from
  a phase that made everything after it expensive, which is precisely the distinction between "trim
  the prompt" and "cut the turns". It is a proxy: comparable between one run's phases, meaningless as
  an absolute.

  It surfaces two ways, both folds over one aggregate: `step.metrics.byPhase` on every pipeline step
  (pushed live, rendered as a run-level table in the model-activity panel) and `llm.byPhase` on the
  remote debugging overview (`GET /api/v1/debug/runs/:runId`), ordered costliest-first. The
  unattributed `""` phase is always a row, never a dropped one — a run metered by a channel with no
  phase concept must not read as a run that spent nothing outside the agent.

  Compatibility break: `LlmCallMetricSummary` (the `LlmCallMetricRepository.summarizeByExecution`
  row) is now keyed by `(agentKind, phase)` rather than by `agentKind` alone, and carries
  `carryCostTokens`. Consumers fold it with the new kernel helpers (`foldRollupTotals`,
  `foldRollupsByAgentKind`, `foldRollupsByPhase`) instead of indexing it directly. No migration: the
  aggregate reads only columns that already exist on both telemetry stores.

### Patch Changes

- Updated dependencies [a8cc6b2]
  - @cat-factory/contracts@0.189.0
  - @cat-factory/kernel@0.183.0
  - @cat-factory/orchestration@0.161.0
  - @cat-factory/node-server@0.133.0
  - @cat-factory/agents@0.82.3
  - @cat-factory/gitlab@0.13.31
  - @cat-factory/integrations@0.109.2
  - @cat-factory/server@0.170.1
  - @cat-factory/executor-harness@1.70.0

## 0.86.0

### Minor Changes

- ac832b9: Add a read-only remote run-debugging API (`/api/v1/debug/*`) so an agent outside the browser can
  diagnose a run: a keyset-paginated run index, a per-run overview (steps, per-sink availability +
  counts, SQL-aggregated LLM rollups, precomputed diagnostic signals), and bounded drill-downs into
  the run's model calls, agent-context dispatches, performed web searches and provisioning event log.

  Bodies are opt-in and byte-budgeted, sliced in SQL so an un-previewed page reads no body bytes at
  all, and every truncation reports what it left out. The surface needs only a `read`-scope public API
  key.

  Root-causing is server-side work, not client-side paging: the LLM-call list takes a `?contains=`
  body search (SQL LIKE/ILIKE, case-insensitive, wildcards literal) whose matched rows report a
  per-body `matchOffset`; point reads take `?bodyOffset=` so the middle and tail of a large body are
  reachable (every body slice now also states its `offset`); the call point read's `?view=messages`
  parses the stored prompt delta into per-message rows with independent budgets; and the overview
  gains a `failure_outside_model_calls` signal pointing a failed-run-with-clean-calls investigation
  at tool execution, which records no calls of its own.

  Spend is attributable, not just countable: every call row carries the `phase` that spent it (the
  agent's own edit loop, a pre-PR validation repair round, a reproduction-proof repair round, …) and
  its `turnIndex` within that job, and `?phase=` narrows the page in SQL like `?agentKind=` does. So
  "the pipeline did work this task never needed" is one request rather than a client-side grouping over
  the whole run. The EMPTY phase is a queryable value, not "no filter" — it selects the unattributed
  slice (an older harness image, an inline call, the un-phased proxy path), which is otherwise
  unreachable; and `turnIndex` stays `null` rather than 0 where the producing channel has no turn
  concept, so a proxied call is never faked into "the first turn".

  All four bounded reads land in the local `node:sqlite` telemetry store too, so the surface works
  unchanged in mothership mode, where telemetry is local-first and these pages never cross the machine
  RPC (routing a page over a long run would be exactly the bulk read that bucket exists to forbid).

  Compatibility break: `ProvisioningLogQuery.before` (a bare `createdAt` keyset) is replaced by a
  composite `cursor: { createdAt, id }`, and the matching `?before=` query param is removed from
  `GET /workspaces/:ws/provisioning-logs` (the SPA never sent it). The old form dropped rows sharing
  a millisecond between pages, which is the common case for a log written in bursts.

### Patch Changes

- Updated dependencies [ac832b9]
  - @cat-factory/contracts@0.188.0
  - @cat-factory/kernel@0.182.0
  - @cat-factory/orchestration@0.160.0
  - @cat-factory/server@0.170.0
  - @cat-factory/node-server@0.132.0
  - @cat-factory/agents@0.82.2
  - @cat-factory/gitlab@0.13.30
  - @cat-factory/integrations@0.109.1
  - @cat-factory/executor-harness@1.70.0

## 0.85.2

### Patch Changes

- Updated dependencies [22d82ac]
  - @cat-factory/contracts@0.187.0
  - @cat-factory/kernel@0.181.0
  - @cat-factory/integrations@0.109.0
  - @cat-factory/server@0.169.0
  - @cat-factory/agents@0.82.1
  - @cat-factory/gitlab@0.13.29
  - @cat-factory/orchestration@0.159.2
  - @cat-factory/node-server@0.131.1
  - @cat-factory/executor-harness@1.70.0

## 0.85.1

### Patch Changes

- e18cfa2: Error identity now survives the trip from where a failure happens to where a user reads it.

  A run that dies on a thrown error carries that error's machine-readable `details.reason` onto
  its `AgentFailure` on both runtimes — previously the Cloudflare driver dropped `reason` on every
  path (and the container post-mortem `detail` on evictions), so the SPA's remedies could never
  fire in production. The wire vocabulary gains `UnavailableError` (503), `UnauthorizedError`
  (401) and `RateLimitedError` (429), and the 113 hand-rolled error envelopes across the HTTP
  layer are migrated onto it, so a 503/401/429 can now carry a `reason` code at all.

  Breaking (pre-1.0, no migration): `POST /signup` now answers 409 (`conflict`) for an
  already-registered email and 422 (`validation`) for a rejected password, instead of flattening
  both onto 400. The LLM proxy no longer returns the raw upstream exception text on a failed
  in-process call, and every proxy error envelope now carries a `code`.

  Privacy fix: inline (non-proxied) LLM calls now honour the per-workspace `storeAgentContext`
  opt-out before shipping prompt/response bodies to an external trace sink, matching the proxied
  path. A workspace that had opted out was still exporting its inline bodies to Langfuse/OTel.

- Updated dependencies [e18cfa2]
- Updated dependencies [01d4b6c]
  - @cat-factory/kernel@0.180.0
  - @cat-factory/server@0.168.0
  - @cat-factory/agents@0.82.0
  - @cat-factory/orchestration@0.159.1
  - @cat-factory/node-server@0.131.0
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/gitlab@0.13.28
  - @cat-factory/integrations@0.108.1

## 0.85.0

### Minor Changes

- b75a08a: Stamp every `llm_call_metrics` row with the run PHASE that spent it and its TURN ordinal, so a
  run's token burn can be attributed to the slice that caused it — the agent's own edit loop, a
  pre-PR validation repair round, a reproduction-proof repair round — instead of piling into one
  figure per agent kind (token-burn instrumentation, slice 2).

  The phase comes from whoever owns the boundary, never from a downstream guess: the harness's job
  registry stamps it on each streamed call as it is emitted, and the Pi path — whose calls are
  metered server-side by the proxy — carries it on the URL Pi is pointed at
  (`${proxyBaseUrl}/phase/<phase>`, rewritten per pass), since Pi makes those requests from a config
  with no per-request header to set. The proxy therefore serves completions on a second, optional
  phase-tagged path; the plain path is unchanged and its calls are recorded as unattributed.

  The backend advertises that route on the job body (`proxyPhasePath`, the same shape as
  `webSearch`) and the harness tags the URL only when told, so an image paired with an older backend
  — a runner pool pins its own harness image, and `LOCAL_HARNESS_IMAGE` overrides the recommended
  pin — falls back to the plain path instead of posting every model call to a 404.

  `LlmCallMetric` gains `phase: string` (`''` = unattributed, a real slice of the rollup rather
  than a dropped row) and `turnIndex: number | null` (the harness's job-scoped `seq`; NULL where the
  producing channel has no turn concept, so a proxied call is never faked into "turn 0").
  `HarnessCallMetric` gains an optional `phase`, read leniently off a runner pool's envelope.
  Both telemetry stores gain the two columns (D1 `0004_llm_call_phase_turn` ⇄ a Drizzle migration);
  existing rows keep the unattributed default and are not backfilled — the table is pruned to a
  3-day window, so they churn out on their own.

- 56128e2: Mothership mode: telemetry is now local-first, so a mothership-mode run finally produces the
  observability it is supposed to.

  Previously the five telemetry repositories resolved to the remote registry, where none of their
  methods is (or should be) allow-listed: every write came back `unknown_method` — swallowed by the
  best-effort recorders — and every read came back empty, so the observability panel, the per-step
  token rollups, the web-search log and the provisioning "View logs" surfaces were blank on a
  mothership-mode node with nothing failing anywhere.

  A mothership-mode node now writes and reads its per-call LLM metrics, agent-context snapshots,
  performed web searches, provisioning log and modeled subscription quota cycles in its own
  `node:sqlite` telemetry store (`telemetry.sqlite`, override `LOCAL_MOTHERSHIP_TELEMETRY_DB`), and
  prunes it to the deployment's configured retention windows. The bucket is composed into the
  repository registry once (`createRemoteRepositoryRegistry`'s new `localFirst` map), so every
  consumer resolves it with no per-consumer wiring.

  Two boundary changes ride with it:

  - `tokenUsageRepository.record` is now remotely callable, under a new `usageRecord` scope rule. The
    spend ledger has the telemetry write profile but is the org's budget safeguard, and the spend gate
    already reads its rollups remotely — a laptop-local ledger would leave local runs invisible to the
    budget they must answer to. The rule pins the row's denormalized `accountId`/`userId` to the
    caller, so a node cannot inflate another account's or teammate's budget.
  - `llmCallMetricRepository.summarizeByExecution` is no longer remotely callable: it was a run-path
    stopgap against the mothership's telemetry store, which holds none of a laptop's calls, so it
    could only ever report zeros for the run that produced them.

  Batch-ingesting a finished run's telemetry up to the mothership (so hosted teammates can read it,
  and it survives the local prune) is the remaining half of this initiative slice.

### Patch Changes

- 3057db1: Carry the `phase` / `turnIndex` telemetry axes through the mothership-mode local sqlite store.
  The axes and the store landed in separate PRs that were each green alone, so `main` was left
  unable to build the local runtime.
- Updated dependencies [b75a08a]
- Updated dependencies [56128e2]
- Updated dependencies [3057db1]
  - @cat-factory/executor-harness@1.70.0
  - @cat-factory/contracts@0.186.0
  - @cat-factory/kernel@0.179.0
  - @cat-factory/integrations@0.108.0
  - @cat-factory/orchestration@0.159.0
  - @cat-factory/server@0.167.0
  - @cat-factory/node-server@0.130.0
  - @cat-factory/agents@0.81.1
  - @cat-factory/gitlab@0.13.27

## 0.84.2

### Patch Changes

- Updated dependencies [9d965c9]
- Updated dependencies [8a9f311]
  - @cat-factory/contracts@0.185.0
  - @cat-factory/kernel@0.178.0
  - @cat-factory/agents@0.81.0
  - @cat-factory/integrations@0.107.3
  - @cat-factory/server@0.166.2
  - @cat-factory/node-server@0.129.1
  - @cat-factory/orchestration@0.158.0
  - @cat-factory/gitlab@0.13.26
  - @cat-factory/executor-harness@1.68.0

## 0.84.1

### Patch Changes

- Updated dependencies [58e06a2]
  - @cat-factory/contracts@0.184.0
  - @cat-factory/kernel@0.177.0
  - @cat-factory/orchestration@0.157.0
  - @cat-factory/node-server@0.129.0
  - @cat-factory/agents@0.80.1
  - @cat-factory/gitlab@0.13.25
  - @cat-factory/integrations@0.107.2
  - @cat-factory/server@0.166.1
  - @cat-factory/executor-harness@1.68.0

## 0.84.0

### Minor Changes

- 65b87c1: Agent kinds can now declare CAPABILITIES: the skills they apply (procedural playbooks — bundled in
  the deployment's own package, or referenced from the account's repo-synced catalog) and the tool
  servers they may call (MCP, stdio or HTTP). Both are registered on the same app-owned
  `AgentKindRegistry` and referenced by id from any number of kinds, or attached to a BUILT-IN kind
  with `assignSkills` / `assignToolServers`. Tool-server credentials are declared by name and
  resolved at dispatch through the new kernel `ToolSecretResolver` port (both facades wire the
  deployment-environment resolver by default), so a value never reaches a prompt or the run's
  telemetry snapshot. See `backend/docs/adr/0029-agent-kind-capabilities.md`.

  BREAKING (pre-1.0, no migration): `AgentRunContext.skill` is now `skills` (an array),
  `PipelineStep.skillVersion` is now `skillVersions`, and the harness job body's `skill` field is now
  `skills` alongside the new `mcpServers`.

  OPERATORS — self-hosted runner pools must be moved to the `1.67.0` harness image. A pool still
  running an older image parses the job body with the old singular `skill` field, so the new
  `skills` array is dropped on the floor. On Pi/codex that degrades quietly (their prompt still
  carries the folded-in instructions), but a leased-credential claude-code run is told in its prompt
  that the skill "is installed for this step" while nothing was installed — a blind run rather than a
  failed one. `mcpServers` is dropped the same way, which surfaces as an agent that was promised
  tools it does not have.

  SECURITY NOTE for a deployment that installs agent packages it did not author: a tool-server
  definition names both the credential it wants and the endpoint it talks to, and the default
  `createEnvToolSecretResolver` will resolve any key off the deployment environment. On the Worker
  that is a real widening (`env` is not otherwise ambient to a registration). Pass
  `createEnvToolSecretResolver(env, { allowKeys: [...] })` to confine it.

### Patch Changes

- Updated dependencies [65b87c1]
- Updated dependencies [df48cb0]
  - @cat-factory/executor-harness@1.68.0
  - @cat-factory/orchestration@0.156.0
  - @cat-factory/contracts@0.183.0
  - @cat-factory/agents@0.80.0
  - @cat-factory/kernel@0.176.0
  - @cat-factory/server@0.166.0
  - @cat-factory/node-server@0.128.0
  - @cat-factory/gitlab@0.13.24
  - @cat-factory/integrations@0.107.1

## 0.83.0

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
  - @cat-factory/executor-harness@1.66.0
  - @cat-factory/contracts@0.182.0
  - @cat-factory/kernel@0.175.0
  - @cat-factory/agents@0.79.0
  - @cat-factory/integrations@0.107.0
  - @cat-factory/orchestration@0.155.0
  - @cat-factory/server@0.165.0
  - @cat-factory/node-server@0.127.0
  - @cat-factory/gitlab@0.13.23

## 0.82.3

### Patch Changes

- 5abcb9e: Drain the remaining silent promise drops in the backend and stop them regrowing. Every
  `.catch(() => {})` in `backend/packages` and `backend/runtimes` now goes through
  `runBestEffort`, so a swallowed failure leaves one `warn` naming the operation with its cause
  attached, and `scripts/check-silent-catch.mjs` fails CI on a new one (a drop that genuinely needs
  no report annotates itself with `// silent-catch-ok: <reason>`). The guard counts every spelling
  of an empty handler, including a body holding only a comment — which caught two further drops:
  the mothership event relay (`HttpMachineEventClient.publish`, which additionally now treats a
  REFUSED publish as a failure rather than a delivery, so an expired machine token stops reading as
  success) and the web-search query recorder.

  `RepoOpContext` gains a required `logger`, which closes the spec-promotion hole: a tester run that
  verified requirements but promoted none used to be indistinguishable from one that had nothing to
  promote. `RunDispatcher`, `DeployerStepController` and `InitiativeLoopService` gain the logger they
  previously had no way to report through — so an issue-writeback drop, a leaked provisioning lease
  and a permanently-failing initiative tick are all visible now. `ExecutionWorkflow` binds its run
  correlation once with `logger.child` and scrubs its poll-failure causes with `redactSecrets`.

- Updated dependencies [c47eb66]
- Updated dependencies [5abcb9e]
  - @cat-factory/integrations@0.106.0
  - @cat-factory/contracts@0.181.0
  - @cat-factory/kernel@0.174.0
  - @cat-factory/server@0.164.0
  - @cat-factory/agents@0.78.0
  - @cat-factory/orchestration@0.154.0
  - @cat-factory/node-server@0.126.3
  - @cat-factory/gitlab@0.13.22
  - @cat-factory/executor-harness@1.64.4

## 0.82.2

### Patch Changes

- bead6df: Stop two ways a run could sit wedged with nothing left to move it.

  A self-hosted runner pool that lost a job now says so. A poll that 404s (or 410s), and a scheduler
  status that names a reclaimed runner (`evicted` / `preempted` / `oomkilled` / `node_lost` / …), are
  read as the RUNNER going away rather than the job failing, so the step is re-dispatched instead of
  burning the run's whole ~70-minute poll budget and dying `timeout`. A job-level failure vocabulary
  (`error` / `cancelled` / `timeout` / …) and a success vocabulary (`completed` / `succeeded` / …)
  likewise end the poll loop honestly; a status word that matches nothing still keeps the driver
  waiting, since wrongly killing a live run is the worse mistake. A pool is asked to route stickily
  by job id, so an eviction recovery now dispatches under a FRESH id (as the deploy path already
  did) — reusing it would have routed the retry back to the job whose runner just died, making the
  recovery a no-op for pool-backed runs.

  A manifest that defines no `release` template — or no status path — reports the gap on its
  connection test in Settings, and logs it once at registration. Each gap crosses the wire as a
  code, so the SPA renders translated copy rather than backend prose.

  The merge-review and pipeline-complete notifications are now raised BEFORE the block flips to
  `pr_ready`. Raising second meant that if the card failed to raise, the run failed but the task was
  already sitting in `pr_ready` with an empty inbox: a PR-ready task with no review action and
  nothing to re-drive it.

  Breaking for anyone importing them directly: `runnersLogic.mapJobState` is replaced by
  `runnersLogic.classifyJobStatus`, which returns `{ state, evicted? }`;
  `runnersLogic.manifestWarnings` and `RunnerBackendProvider.warnings` return
  `{ code, message }` objects rather than strings. The `(container evicted or crashed)` wording every
  transport had copied is now kernel's `CONTAINER_EVICTION_ERROR`.

- Updated dependencies [bead6df]
  - @cat-factory/integrations@0.105.0
  - @cat-factory/contracts@0.180.0
  - @cat-factory/kernel@0.173.0
  - @cat-factory/orchestration@0.153.1
  - @cat-factory/server@0.163.2
  - @cat-factory/node-server@0.126.2
  - @cat-factory/agents@0.77.1
  - @cat-factory/gitlab@0.13.21
  - @cat-factory/executor-harness@1.64.4

## 0.82.1

### Patch Changes

- Updated dependencies [a04f609]
  - @cat-factory/agents@0.77.0
  - @cat-factory/orchestration@0.153.0
  - @cat-factory/server@0.163.1
  - @cat-factory/node-server@0.126.1
  - @cat-factory/executor-harness@1.64.4

## 0.82.0

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

- Updated dependencies [71ea4ec]
- Updated dependencies [68f0edd]
- Updated dependencies [71ea4ec]
- Updated dependencies [6dbd864]
  - @cat-factory/orchestration@0.152.0
  - @cat-factory/contracts@0.179.0
  - @cat-factory/kernel@0.172.0
  - @cat-factory/agents@0.76.0
  - @cat-factory/integrations@0.104.0
  - @cat-factory/server@0.163.0
  - @cat-factory/node-server@0.126.0
  - @cat-factory/gitlab@0.13.20
  - @cat-factory/executor-harness@1.64.4

## 0.81.2

### Patch Changes

- Updated dependencies [3260f2d]
  - @cat-factory/executor-harness@1.64.4
  - @cat-factory/agents@0.75.2
  - @cat-factory/orchestration@0.151.1
  - @cat-factory/server@0.162.1
  - @cat-factory/node-server@0.125.1

## 0.81.1

### Patch Changes

- 9d8fe9b: Close the lost-update race on the iterative-review stores (race-condition audit 2.5).

  A requirements / clarity / brainstorm review is ONE JSON blob holding every finding, and every mutation used to load it, edit one item and force-write the whole row back. Two writers inside that window — two people answering different findings, a dismissal landing inside the (slow) incorporation LLM call, the Requirement-Writer's fill pass racing a human accept — left only the last writer's edit. Because incorporation refuses to run while any finding is still `open`, a lost dismissal wedged the loop on a finding that was in fact settled.

  - **`rev` + `compareAndSwap` on all three review stores** (D1 migration `0065` ⇄ Drizzle): the conditional write lands only while the stored revision still matches the one the caller read, and never inserts, so a review a fresh run replaced can't be resurrected.
  - **Every read-modify-write routes through `mutateReview`** (load → apply → CAS, reloading and RE-APPLYING the mutation on the winner's snapshot when it loses), including the two paths that held a snapshot across an LLM call (`incorporate`, `reReview`) and all four recommendation paths.
  - **`deleteByBlock` + `upsert` is replaced by an atomic `replaceForBlock` / `replaceForBlockStage`**, a single conflict-targeted upsert against a new UNIQUE index on `(workspace_id, block_id[, stage])` (D1 migration `0066` ⇄ Drizzle, healing pre-existing duplicates before constraining). Two review runs for one block could previously interleave their delete/insert pairs and leave TWO live reviews, so the window loaded one while the parked run's decision keyed to the other. The racy delete method is removed from the port (and the mothership persistence allow-list) so it can't be reintroduced.
  - **A contended give-up throws `ReviewContendedError`** (new, a `ConflictError` subclass): a 409 for an HTTP caller, and a re-drive signal for the durable driver, whose incorporation cycle mutation carries the output of an LLM call the run has already paid for.

  Compatibility break (pre-1.0, no shim): the `RequirementReviewRepository` / `ClarityReviewRepository` / `BrainstormSessionRepository` ports drop `deleteByBlock`/`deleteByBlockStage` and gain `compareAndSwap` + `replaceForBlock`/`replaceForBlockStage`; the review wire shapes gain `rev`. Existing rows read as `rev = 0`, which is exactly what the new column defaults to. Migration `0066` DELETES duplicate live reviews for a block (keeping the newest, the one `getByBlock` already returned) before adding the constraint — the superseded duplicates were unreachable.

- Updated dependencies [15905ab]
- Updated dependencies [9d8fe9b]
  - @cat-factory/executor-harness@1.64.2
  - @cat-factory/agents@0.75.1
  - @cat-factory/contracts@0.178.0
  - @cat-factory/kernel@0.171.0
  - @cat-factory/orchestration@0.151.0
  - @cat-factory/server@0.162.0
  - @cat-factory/node-server@0.125.0
  - @cat-factory/gitlab@0.13.19
  - @cat-factory/integrations@0.103.3

## 0.81.0

### Minor Changes

- 2ed7b50: Complete mothership-mode real-time in both directions, and fix the fan-out read that made every mothership-mode publish fail.

  - **Inbound event subscription (`GET /internal/events/subscribe/:workspaceId`).** A mothership-mode node can now RECEIVE org activity, not just publish it — a hosted teammate's run, or a peer laptop's, animates the local board live instead of waiting for a manual refresh. The mothership side is not a new fan-out: the machine-authed handshake is handed to the SAME per-workspace realtime transport the browser stream uses (`gateways.realtime.upgrade`), so a subscribed node is just another socket in the workspace's room and the Cloudflare Durable Object needed no change. Authorisation is the shared `authorizeMachineSubscribe` (machine-audience pin first, then capability, then the workspace → account scope with a uniform 404), reached by the Worker through the shared controller and by Node from its HTTP-server `upgrade` listener — the same split, and the same reason, as the browser stream's `?ticket=`.
  - **Demand-driven on the laptop.** `MothershipEventSubscriber` holds one upstream stream per workspace with at least one local subscriber, driven by a new room-transition seam on `NodeRealtimeHub`; an idle node holds none, and it never needs to enumerate the org's workspaces. Inbound events are broadcast to the bare hub (never back through the layered propagator, which would re-publish them upstream), and the node's stable `?cid=` is now stamped as the outbound publish's `originConnectionId` — replacing the originating tab's id, which means nothing on the mothership — so a node's own events are not fanned back down to it.
  - **The subscription keeps itself honest.** Liveness is client-driven because the two mothership runtimes disagree about who provides it: a Node mothership pings at the protocol level and reaps a dead socket, while a Cloudflare mothership's hibernating Durable Object never pings — so a half-open socket there would never fire `close` and the workspace would stay dark indefinitely while the node still believed it was subscribed. The subscriber therefore heartbeats and drops a socket that has been silent past an idle deadline, treating any inbound frame (its `"ping"` auto-answered at the Cloudflare edge, or Node's own protocol ping) as proof of life. A refused handshake is now reported rather than swallowed, rate-limited so an unbounded retry stays visible without flooding, and the reconnect backoff is jittered so a fleet doesn't retry in lockstep after a mothership restart.
  - **Fix: `workspaceMountRepository.listWorkspaceIdsMountingBlock` was not remotely callable.** `FanOutEventPublisher` calls it on EVERY engine event publish, and a mothership-mode node wires the same decorator, so the call came back `unknown_method`, the remote proxy threw, and the rejection propagated out of the run-state emit. It is now allow-listed under the `workspace` rule (it returns workspace ids only, and a service can only be mounted inside its own account). `blockRepository.countActiveInternal` is allow-listed alongside it, completing the headless public-API surface whose paginated reads were already remote.
  - The persistence allow-list moved into its own module (`persistence/rpc-allowlist.ts`) — same exported name and import path, but the initiative's fast-growing surface no longer shares a file with the stable protocol.

### Patch Changes

- Updated dependencies [2ed7b50]
  - @cat-factory/server@0.161.0
  - @cat-factory/node-server@0.124.0
  - @cat-factory/executor-harness@1.64.0

## 0.80.6

### Patch Changes

- Updated dependencies [cf2779a]
- Updated dependencies [5e5d409]
  - @cat-factory/contracts@0.177.0
  - @cat-factory/agents@0.75.0
  - @cat-factory/executor-harness@1.64.0
  - @cat-factory/server@0.160.0
  - @cat-factory/kernel@0.170.0
  - @cat-factory/orchestration@0.150.1
  - @cat-factory/gitlab@0.13.18
  - @cat-factory/integrations@0.103.2
  - @cat-factory/node-server@0.123.1

## 0.80.5

### Patch Changes

- Updated dependencies [1947062]
  - @cat-factory/contracts@0.176.0
  - @cat-factory/kernel@0.169.0
  - @cat-factory/orchestration@0.150.0
  - @cat-factory/server@0.159.0
  - @cat-factory/node-server@0.123.0
  - @cat-factory/agents@0.74.1
  - @cat-factory/gitlab@0.13.17
  - @cat-factory/integrations@0.103.1
  - @cat-factory/executor-harness@1.62.0

## 0.80.4

### Patch Changes

- Updated dependencies [fb71506]
  - @cat-factory/executor-harness@1.62.0
  - @cat-factory/agents@0.74.0
  - @cat-factory/server@0.158.0
  - @cat-factory/orchestration@0.149.2
  - @cat-factory/node-server@0.122.4

## 0.80.3

### Patch Changes

- Updated dependencies [1c12289]
  - @cat-factory/contracts@0.175.0
  - @cat-factory/kernel@0.168.0
  - @cat-factory/integrations@0.103.0
  - @cat-factory/agents@0.73.2
  - @cat-factory/gitlab@0.13.16
  - @cat-factory/orchestration@0.149.1
  - @cat-factory/server@0.157.3
  - @cat-factory/node-server@0.122.3
  - @cat-factory/executor-harness@1.60.0

## 0.80.2

### Patch Changes

- Updated dependencies [55747c5]
  - @cat-factory/contracts@0.174.0
  - @cat-factory/orchestration@0.149.0
  - @cat-factory/agents@0.73.1
  - @cat-factory/gitlab@0.13.15
  - @cat-factory/integrations@0.102.2
  - @cat-factory/kernel@0.167.1
  - @cat-factory/server@0.157.2
  - @cat-factory/node-server@0.122.2
  - @cat-factory/executor-harness@1.60.0

## 0.80.1

### Patch Changes

- Updated dependencies [cab85c5]
  - @cat-factory/contracts@0.173.0
  - @cat-factory/agents@0.73.0
  - @cat-factory/kernel@0.167.0
  - @cat-factory/orchestration@0.148.0
  - @cat-factory/server@0.157.1
  - @cat-factory/gitlab@0.13.14
  - @cat-factory/integrations@0.102.1
  - @cat-factory/node-server@0.122.1
  - @cat-factory/executor-harness@1.60.0

## 0.80.0

### Minor Changes

- 8afa4ae: Inbound tracker webhooks: push-driven issue intake, and answering a parked requirements review
  from the ticket.

  Two asymmetries in the task-source layer close together, because they share a transport.

  **1. Intake was pull-only.** An issue entered the system when a recurring `bug-intake` schedule
  fired or a human imported it, so intake latency was the schedule interval and every idle poll cost
  a tracker API call. A new receiver — `POST /webhooks/tasks/:source/:workspaceId` — copies the
  GitHub VCS webhook path step for step: verify HMAC over the RAW body before any parse, ack 202
  fast, hand the parsed event to the facade's queue (a Cloudflare Queue on the Worker ⇄ the pg-boss
  `tracker.sync` queue on Node), and fall back to inline handling when neither is bound.

  **2. The question loop was half-duplex.** `postReviewQuestions` already posted a parked review's
  findings onto the linked issue, each with its stable id — but answers could only arrive in-app or
  over `/api/v1/runs/:runId/decisions`, so a reporter who lives in Jira had to switch surfaces.
  Those ids were designed for exactly this reply path; it is now built. This completes slice 2b of
  `docs/initiatives/headless-clarification-loop.md`.

  **A qualifying issue event FIRES the matching schedule; it does not re-implement intake.** The
  tempting shape — "the event names an issue, so import and link it" — forks a second intake path
  that would drift from `BugIntakeService`'s predicate handling, batched dedup, replace-link, pickup
  mark and block seeding. Instead a pure `issueEventMatchesIntake` predicate decides whether the
  event qualifies for a schedule's `issueIntake` config, and a match calls the same `fire` the cron
  sweeper calls. Consequences, all deliberate: the fired run may pick a **different, older** issue
  than the one that triggered it (intake is oldest-first fair queueing — the webhook drains the queue
  promptly, it does not reorder it); overlap protection is inherited, so a burst of deliveries cannot
  start a second run over a parked one; and the trigger is **non-forced**, so an on-demand schedule is
  never webhook-fired and an individual-usage model still refuses — `force` is the human run-now lever
  and a webhook has no human present. The predicate deliberately **fails open** on a field the payload
  omits: a false positive costs one no-op run, a false negative costs silent intake latency.

  **The recurring schedule is unchanged and stays on** as the reconciliation sweep for missed
  deliveries — the same webhook + sweeper duality as GitHub sync + `sweepStuckRuns`. Push is the fast
  path, never the only path.

  **Ticket replies use an explicit grammar, never natural-language guessing:**

  ```
  @cat-factory answer <itemId> <free text to end of line>
  @cat-factory dismiss <itemId>
  @cat-factory proceed | stop | extra-round
  ```

  Only lines whose first token is the trigger are interpreted, so a human can answer and discuss in
  one comment; an `answer` continues onto following lines until the next trigger. A comment with no
  trigger line is ignored entirely. Every mutation routes through the SAME service methods the SPA
  and `PublicDecisionController` call (`RequirementReviewService.replyToItem` / `setItemStatus`, then
  `executionService.requirementsReview.{incorporate,proceed,resolveExceeded}`), so the park's
  CAS/approval-id arbitration and the task's merge-preset knobs apply identically — there is no
  parallel mutation path into the engine. A reply that leaves nothing open auto-incorporates, and the
  issue gets a follow-up comment naming what was applied, what is still outstanding, and what was
  rejected and why.

  **Configuration is per connection and needs no new table.** The webhook secret rides the
  connection's existing sealed credential bag, managed through
  `GET|POST|PATCH|DELETE /workspaces/:ws/task-sources/:source/webhook` (behind `integrations.manage`)
  and returned exactly once. `POST` mints or rotates; `PATCH` edits the reply allow-list WITHOUT
  rotating, because tightening that list is what an operator does when a tracker turns out to be more
  public than they thought and answering it with a silently rotated secret would take deliveries down
  until they re-pasted it into the vendor. The workspace rides the URL path because a tracker delivery carries no
  installation id to resolve one from, and scanning every workspace's connections for one whose
  secret verifies would be a deployment-wide N+1 on every unauthenticated POST. **An unconfigured
  secret fails closed** — an empty HMAC key is one an attacker also has.

  Reply text is untrusted third-party input, and on a public repo anyone can write it. Three layers:
  the platform's own comments are refused first — by the vendor bot flag where there is one, and by
  a structural marker check everywhere, since Linear flags no bots and the default allow-list admits
  any author (an acknowledgement that could re-enter its own ingest is an unbounded comment loop, not
  a duplicate: each carries a fresh comment id, so the ingest claim cannot stop it). Then the
  connection's optional `webhookReplyAllow` list — an
  unauthorized reply is dropped **silently**, with no follow-up, because replying would confirm the
  hook exists and hand an attacker an oracle. Reply text becomes `item.reply`, the same field the SPA
  writes, capped and `redactSecrets`-scrubbed before it persists; the grammar has no verb reaching
  outside the review. Everything rendered back crosses kernel's `hostMarkdown` boundary, exactly like
  the PR verification report.

  Idempotency is an atomic claim on a new `tracker_comment_ingests` table
  (`(workspace, source, externalId, commentId)`, D1 ⇄ Drizzle), taken **before** anything is applied
  — every tracker redelivers and every queue retries, so without it one reporter comment would answer
  the same finding twice. It copies the `review_question_posts` design verbatim, including its answer
  to "what if the claimer dies": a `failed` row is re-claimable, `applied` is terminal, and a
  `pending` one is re-claimable once abandoned. A claim that ERRORS propagates rather than being read
  as "already ingested" — the apply is idempotent precisely so the queue can retry it, and swallowing
  the error would drop a reporter's answer while reporting a successful dedup. Both stores are pinned
  by a new cross-runtime parity
  suite, alongside conformance assertions that drive the whole receiver → gateway → service chain on
  each facade.

  Providers own their vendor parsing behind a new optional `TaskSourceProvider.webhook` capability
  (Jira, Linear and GitHub Issues ship one), exactly as VCS providers own theirs; a source without it
  never receives deliveries. Design, decisions and the per-slice checklist:
  `docs/initiatives/tracker-webhook-intake.md`.

### Patch Changes

- Updated dependencies [8afa4ae]
  - @cat-factory/contracts@0.172.0
  - @cat-factory/kernel@0.166.0
  - @cat-factory/integrations@0.102.0
  - @cat-factory/orchestration@0.147.0
  - @cat-factory/server@0.157.0
  - @cat-factory/node-server@0.122.0
  - @cat-factory/agents@0.72.3
  - @cat-factory/gitlab@0.13.13
  - @cat-factory/executor-harness@1.60.0

## 0.79.2

### Patch Changes

- Updated dependencies [200fb4d]
  - @cat-factory/kernel@0.165.1
  - @cat-factory/server@0.156.2
  - @cat-factory/agents@0.72.2
  - @cat-factory/gitlab@0.13.12
  - @cat-factory/integrations@0.101.4
  - @cat-factory/orchestration@0.146.2
  - @cat-factory/node-server@0.121.2
  - @cat-factory/executor-harness@1.60.0

## 0.79.1

### Patch Changes

- Updated dependencies [323b6cf]
  - @cat-factory/integrations@0.101.3
  - @cat-factory/orchestration@0.146.1
  - @cat-factory/server@0.156.1
  - @cat-factory/node-server@0.121.1
  - @cat-factory/executor-harness@1.60.0

## 0.79.0

### Minor Changes

- f0e9bab: Public API (`/api/v1`) Tier 2: a new `GET /jobs` list, and bounded keyset pagination + filters on
  the service-task list.

  - **`GET /api/v1/jobs`** (new, `read`-scoped) lists the workspace's headless initiative jobs,
    newest first, with `?limit=` / `?cursor=` / `?status=` / `?since=`. It closes the gap where an
    integration that lost its stored job ids — a restart, a redeploy — could never re-discover its
    own in-flight runs, since `GET /jobs/:id` needs an id it no longer has. Scoped exactly like the
    single-job read: the `internal`-anchor predicate is applied **in SQL** (a join to the anchor
    block), so an external key can never enumerate the workspace's ordinary board runs.
  - **`GET /api/v1/services/:serviceId/tasks`** gains `?limit=` / `?cursor=` / `?status=`. It was
    previously unbounded: it read the ENTIRE board and filtered the service subtree in JS, so a
    large service returned every task in one response and paid a full board read per request. The
    bound, the subtree and the status filter now all live in SQL.

  **Breaking wire change:** `GET /api/v1/services/:serviceId/tasks` now returns **at most 50 tasks
  per response** (previously: all of them) and carries a new required `nextCursor` field. A caller
  that relied on one response containing every task must now page until `nextCursor` is null.
  `GET /api/v1/jobs`'s default page is 25; both accept `?limit=` up to a hard ceiling of 100.

  Pagination is **keyset, not offset** — an external caller polls, so an offset page shifts under
  concurrent inserts and a row created between two pages either repeats or is skipped and never
  seen again. The cursor is opaque on the wire and carries the `(sortKey, id)` composite, so a burst
  of runs sharing a millisecond pages correctly instead of losing the ties. A malformed cursor is a
  `400 invalid_cursor`, never a silent re-serve of page 1.

  Job ordering is chronological (`created_at DESC`). **Task ordering is by the stable block id, not
  chronological**, and there is deliberately no `since` filter on the task list: the `blocks` table
  carries no creation timestamp, so a time filter would have to be faked. See
  `docs/initiatives/public-api-expansion.md` for what adding one would cost.

  Backed by two new repository port methods — `ExecutionRepository.listInternal` and
  `BlockRepository.listServiceTasks` — implemented on **both** the D1 and Drizzle stores and pinned
  by new cross-runtime conformance assertions, so a store that ordered differently, dropped the
  `internal` join, or mishandled the keyset fails a test rather than silently mis-serving an
  integration. Each resolves its scope in ONE query (the `internal` anchor join; the frame's modules
  as a subquery rather than a bound id list, which D1's 100-parameter ceiling would reject on a
  service with ~96 modules).

  Two adjacent fixes the lists depend on:

  - `ExecutionInstance.createdAt` is now projected from the `agent_runs.created_at` COLUMN instead of
    the run's `detail` JSON, and an insert adopts the instance's own stamp. The two used to be
    separate `clock.now()` calls milliseconds apart, so a keyset cursor minted from the entity named
    a position slightly ahead of the row it pointed at — silently skipping any run inserted in that
    window whenever two starts landed in the same millisecond. The redundant `detail.createdAt` is
    gone (stale copies on existing rows are simply ignored, then dropped on the next write).
  - `BoardService.addTask` now enforces the same containment rule `canReparent` applies on a move: a
    task may only be created under a service frame or a module. A task parented to an `epic` /
    `initiative` grouping node was structurally orphaned — invisible to any reader that resolves a
    service subtree, including this task list.

  The `human-test` / `visual-confirmation` gate step-state schemas moved out of
  `contracts/src/execution.ts` into their own `human-verdict-gates.ts` module (re-exported from the
  package root, so no import path changes): merging `main` pushed `execution.ts` past the file-size
  budget, and the two human-verdict gates are the cohesive seam — they share a `rounds` history and a
  transient `pendingAction` that the polling gates' `GateStepState` does not have.

### Patch Changes

- Updated dependencies [0f7cba1]
- Updated dependencies [f0e9bab]
  - @cat-factory/orchestration@0.146.0
  - @cat-factory/contracts@0.171.0
  - @cat-factory/kernel@0.165.0
  - @cat-factory/server@0.156.0
  - @cat-factory/node-server@0.121.0
  - @cat-factory/agents@0.72.1
  - @cat-factory/gitlab@0.13.11
  - @cat-factory/integrations@0.101.2
  - @cat-factory/executor-harness@1.60.0

## 0.78.1

### Patch Changes

- Updated dependencies [45fddb6]
  - @cat-factory/orchestration@0.145.1
  - @cat-factory/server@0.155.1
  - @cat-factory/node-server@0.120.1
  - @cat-factory/executor-harness@1.60.0

## 0.78.0

### Minor Changes

- 640cadd: Judges: a registry seam for deployment-authored rubric evaluators that can block or bounce a run.

  Three engine paths already shared one shape — an LLM produces a structured assessment, the engine
  compares it to a per-task threshold, and the run advances, parks or escalates (requirements
  auto-pass, the `merger`, `on-call`). That latent "verdict gate" family is now promoted into a
  **fourth step-taxonomy bucket**: agents / polling gates / one-shot engine steps / **judges**.

  A judge step runs an LLM assessment of the run's work against a **rubric**, and the engine
  compares the verdict's score to the task's merge preset before disposing: advance, park for a
  human, **bounce** the producing step with the findings as its rework brief, or fail the run.
  Adding one is a registry entry, not a copy of the machinery — the same promise `registerGate`
  makes for polling gates.

  - **`JudgeRegistry`** (`@cat-factory/kernel`, app-owned + empty by default) threaded through
    `CoreDependencies.judgeRegistry` beside `gateRegistry`. A registration supplies only its
    differentiators: the rubric, an optional `parseVerdict`, `threshold`/`attemptBudget` read off
    the preset, `onFail` (`park` / `bounce` / `fail`) and `bounceTargets`.
  - **One generic driver** in the engine owns the state machine, threshold comparison, park,
    bounce budget, persistence and emission. All live state rides `step.judge` — no side table, so
    it is runtime-symmetric by construction.
  - **No per-facade wiring**: the verdict producer is an injectable `JudgeAssessor` whose default
    is built from the model-provider dependencies every facade already wires. An
    absent/disabled assessor makes every judge step a **pass-through**, so existing pipelines are
    byte-for-byte unchanged.
  - Two new merge-preset knobs, `judgeMinScore` (default 0.7) and `judgeMaxBounces` (default 1),
    mirrored D1 ⇄ Drizzle. The built-in presets' seed version bumps to 5, so existing workspaces
    are advised to reseed.
  - A rubric's per-workspace override is an ordinary **prompt-library fragment**
    (`JudgeRubric.fragmentId`), so the feature adds no rubric storage.
  - The verdict is a first-class section of the **PR verification report**, rendered through the
    `hostMarkdown` helpers and scrubbed like every other model-authored field.
  - A parked verdict is answerable from the SPA's new judge window **and** from
    `POST /api/v1/runs/:runId/decisions/judge/resolve` — both call the same service method.

  The `merger` is deliberately NOT rewritten onto this: it owns terminal block status and a real,
  credential-bearing merge, and stays a privileged built-in. See
  `docs/initiatives/judge-registry.md`.

### Patch Changes

- Updated dependencies [583fc80]
- Updated dependencies [640cadd]
  - @cat-factory/orchestration@0.145.0
  - @cat-factory/contracts@0.170.0
  - @cat-factory/kernel@0.164.0
  - @cat-factory/agents@0.72.0
  - @cat-factory/integrations@0.101.1
  - @cat-factory/server@0.155.0
  - @cat-factory/node-server@0.120.0
  - @cat-factory/gitlab@0.13.10
  - @cat-factory/executor-harness@1.60.0

## 0.77.3

### Patch Changes

- 968a214: Bugfix reproduction proof — the harness verification phase (Phase B)

  The container now RUNS the reproduction declaration Phase A threaded to it, so a bugfix run
  carries captured evidence that the defect was real instead of the model's own claim that it was.
  Between the agent settling and the pull request opening, the harness runs the declared check
  against two trees of the same clone and computes the verdict from the exit codes:

  - **`reproduced`** — red on the pre-fix tree, green on the tree the PR opens from. The only shape
    that is proof.
  - **`inconclusive`** — every other shape (green at base ⇒ the check does not demonstrate the
    defect; red at both ⇒ the change does not fix it, or the environment is broken), recorded
    honestly with both captured outputs and a one-line note saying which.

  **Symmetry is the safety property.** A non-zero exit at the base proves nothing on its own — a
  missing toolchain, an uninstalled dependency, or an unrelated pre-existing breakage all produce
  one. Both phases therefore run in freshly-created `git worktree` checkouts with the SAME setup
  command and the byte-identical declared test files (applied path-by-path onto the base tree, never
  a whole-tree checkout, which would drag the fix across and green it). An environmental defect
  fails both and is reported as `inconclusive`, never as proof. Red-for-the-wrong-_reason_ is not
  detected — both outputs ride the report precisely so a human can see why the base was red.

  **A failed verification is a REPAIR, not a run failure.** The captured output goes back to the
  agent — with an explicit rule against weakening the reproduction — while budget remains, and
  exhausting it degrades to `inconclusive` with the PR still opening. Deliberately a different
  disposition from pre-PR validation, which opens nothing: a red check means the WORK is broken; an
  unproven reproduction means the EVIDENCE is weak, which is a reviewer's call. A setup failure
  spends no repair rounds at all, since the agent cannot change a setup command it did not declare.

  Also in this slice:

  - The verdict reaches the engine both LIVE (`RunnerJobView.reproductionReport`, republished with a
    fresh timestamp each round so a failed verification is visible while the loop still runs) and
    terminally, on the success path, the failure path, and through a self-hosted runner pool (a new
    `reproductionReportPath` response-manifest mapping, so a pool-backed run is not left with a
    silently missing section).
  - The proof runs BEFORE the pre-PR validation loop, so validation stays the last thing to touch
    the tree and "only a green checkout opens a PR" is preserved unconditionally.
  - Per-job by construction: the worktree root is a fresh `mkdtemp` and every command, cwd and
    environment arrives as an argument, so two concurrent bugfix runs on the ONE local-native host
    process cannot check out over each other's base trees — which would surface as a false verdict
    on a pull request, not a crash. Pinned by a concurrency test.
  - A declared test file that was never `git add`ed is reported as such (the proof runs against
    committed trees, and the push would miss it too) instead of yielding a verdict computed without
    the reproduction in it.

  What the verdict will and will not claim:

  - **A green pre-fix tree no longer blames the test when the tree is not actually fix-free.** A
    resumed run's pre-fix tree is the work branch as it stood when the pass started — which, after a
    mid-run eviction, already carries that same step's committed partial fix. The check then passes
    there for a reason unrelated to the test, so the proof probes (on a green base only, memoised)
    whether the tree carries non-test work, reports that instead of "your test does not demonstrate
    the defect", and spends no repair round. An unavailable answer degrades to the plain diagnosis.
  - **Declared test paths are refused for git pathspec magic** (`:(glob)`, `*`, `?`, `[…]`) as well
    as traversal, in both the engine's sanitizer and the harness's own. `--` stops a path being read
    as a revision but not as a pathspec, so a glob would apply most of the final tree onto the base
    worktree and green it — turning a good reproduction into a false "the test does not capture the
    defect", from model-authored input.
  - **Two identical failures read as an environment problem, not an ineffective fix**, and two
    timeouts read as a watchdog kill. Neither is evidence for "the change does nothing".
  - **A timed-out tree spends no repair round**, joining setup failures and the prior-work base: in
    all three the agent is not what is wrong, so a round can only add cost.
  - **The phase carries a wall-clock ceiling** (`REPRODUCTION_TOTAL_BUDGET_MS`, 45m) on top of the
    attempt budget. Attempts multiply two full tree runs each, and the phase's own heartbeat
    deliberately stops the job inactivity watchdog from firing, so nothing else bounded it.
    Exceeding it settles `inconclusive` with its own note — a cost limit, never a verdict.
  - **The `repro-test` prompt now states that both runs happen in a fresh checkout** and that
    `setupCommand` is required when the tests need an install or build to run there. Omitting it is
    the most common way the proof ends up proving nothing.

  Both pre-PR verification phases now spawn through one shared `runCapturedCommand` seam (watchdog,
  abort handling, exit-code conventions, scrub-then-bound capture) instead of two near-verbatim
  copies, and the capture keeps a small margin so a secret straddling the rolling cut is still whole
  when it is scrubbed.

  Unconfigured means unchanged: no `reproduction` on the job body ⇒ the harness's existing path,
  byte for byte.

  Runner image bumped to `1.59.0`. The PR-report section that renders this is Phase C.

  Design + phase checklist: `docs/initiatives/bugfix-reproduction-proof.md`.

- Updated dependencies [968a214]
  - @cat-factory/executor-harness@1.60.0
  - @cat-factory/integrations@0.101.0
  - @cat-factory/contracts@0.169.0
  - @cat-factory/server@0.154.0
  - @cat-factory/orchestration@0.144.0
  - @cat-factory/agents@0.71.0
  - @cat-factory/node-server@0.119.3
  - @cat-factory/gitlab@0.13.9
  - @cat-factory/kernel@0.163.1

## 0.77.2

### Patch Changes

- 829a905: Refresh dependencies (direct + transitive) and bump the coding-agent CLIs baked into the
  runner image.

  - **Runner image (`@cat-factory/executor-harness`, image tag `1.57.0`)**: Pi
    `0.80.6 → 0.82.1`, Claude Code `2.1.207 → 2.1.220`, Codex `0.144.1 → 0.145.0`, and the
    two Pi extensions `@juicesharp/rpiv-todo` / `@juicesharp/rpiv-web-tools`
    `1.20.0 → 2.1.0`. The todo extension's v2 tool result keeps the `details.tasks[]` shape
    (`subject` + `pending`/`in_progress`/`completed`/`deleted` status) that
    `parseTodoProgress` reads, so live subtask progress is unaffected. The image pins in
    `deploy/backend` (`package.json` + `wrangler.toml`) and
    `RECOMMENDED_HARNESS_IMAGE` are synced to the new tag.
  - **Workspace dependencies**: refreshed the whole lockfile within the declared ranges, so
    transitive dependencies move up too. Direct bumps include `ai` 7.0.37, `@ai-sdk/*`
    (anthropic 4.0.21, openai 4.0.20, amazon-bedrock 5.0.32), `hono` 4.12.32,
    `@hono/node-server` 2.0.12, `pg-boss` 12.26.3, `undici` 8.9.0, `wrangler` 4.114.0,
    `@cloudflare/workers-types`, `@cloudflare/vitest-pool-workers` 0.18.8,
    `@aws-sdk/client-s3` 3.1095.0, `@playwright/test` 1.62.0 and `turbo` 2.10.7. Every
    version picked is the newest that already satisfies the `minimumReleaseAge` supply-chain
    gate, and the AI-SDK family stays inside the majors that pair with `workers-ai-provider`
    (`ai@^7`, `@ai-sdk/*@^4`). No third-party entries were added to
    `minimumReleaseAgeExclude`. The frontend's `typescript@^6` pin is left alone (Nuxt /
    `vue-tsc` toolchain).

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

- Updated dependencies [143e6bb]
- Updated dependencies [829a905]
- Updated dependencies [829a905]
  - @cat-factory/orchestration@0.143.1
  - @cat-factory/executor-harness@1.58.0
  - @cat-factory/agents@0.70.1
  - @cat-factory/integrations@0.100.2
  - @cat-factory/kernel@0.163.0
  - @cat-factory/server@0.153.1
  - @cat-factory/node-server@0.119.2
  - @cat-factory/gitlab@0.13.8

## 0.77.1

### Patch Changes

- Updated dependencies [c95600b]
  - @cat-factory/orchestration@0.143.0
  - @cat-factory/contracts@0.168.0
  - @cat-factory/agents@0.70.0
  - @cat-factory/kernel@0.162.0
  - @cat-factory/server@0.153.0
  - @cat-factory/node-server@0.119.1
  - @cat-factory/gitlab@0.13.7
  - @cat-factory/integrations@0.100.1
  - @cat-factory/executor-harness@1.56.0

## 0.77.0

### Minor Changes

- df9ca7d: Merge track record: reviewer-effort tags, deterministic change-class classification, and
  per-class auto-merge rules on merge presets.

  The merge decision no longer runs purely on the `merger` agent's self-assessment. Every merge
  decision now persists one row in a new `merge_track_records` table (full D1 ⇄ Drizzle parity)
  carrying the run's **change class**, the merger's scores, the outcome (`pending_review` →
  `auto_merged` / `human_merged` / `external_merged` / `rejected`), and a nullable **reviewer-effort
  tag** (`none` / `minor` / `major`). Per-class rollups are single SQL aggregates behind
  `GET /workspaces/:ws/merge-track-records/rollups`.

  - **Classification** is deterministic backend TypeScript over ONE VCS call (`RepoFiles.listChangedFiles`
    → the pure `classifyChangedFiles`), so it needs no harness change or runner-image bump and works
    identically on a GitLab deployment. Classes are risk-ranked (`docs` < `test` < `dependency` <
    `config` < `source` < `schema`) and a mixed diff takes the highest-ranked class present. An
    unreadable diff yields `unknown`, which never matches a per-class rule.
  - **Per-class rules** on a merge preset: `always` auto-merge, `never` auto-merge, or fall back to the
    score ceilings — resolved with `autoMergeEnabled: false` as the master switch a rule can never
    override.
  - **Effort capture** at the existing decision points: `POST /notifications/:id/act` takes an optional
    `reviewEffort` (one-tap confirm-and-tag, preselected from whether the run's PR review recorded
    findings), `POST /workspaces/:ws/merge-track-records/:id/effort` tags out of band, and a PR merged
    directly on the provider is detected from the webhook ingest and nudged with a dismissible
    `merge_tag_request` card. Tagging is never mandatory: an untagged merge records a null tag.
  - Classification and record writes are **best-effort side channels** — a failure in any part of this
    feature can never fail or block a merge.

  A merge decision's record carries the run's **provider-neutral repo identity** (`repoId` +
  `provider`), captured from the run-repo resolution the classification already performs. That is what
  makes a record attributable: external-merge detection can only look a record up by
  `(repoId, prNumber)`, since a webhook delivery knows nothing else about the run.

  **BREAKING (backend API):** `RepoTarget` (`@cat-factory/server`) and `RunRepoContext`
  (`@cat-factory/kernel`) gain a required `repoId` plus an optional `provider`, in the neutral
  `VcsRepoRef` vocabulary. Both are produced in exactly one place each, so a deployment that builds
  its own `ResolveRepoTarget` / `ResolveRunRepoContext` must supply the id; the compiler points at
  every site.

  A contract route whose request body is ALL-optional now mounts the new `optionalJsonBody`
  middleware (`@cat-factory/server`). A declared `requestBodySchema` otherwise makes the transport
  REQUIRE a body — the validator reads `c.req.json()` before the schema is consulted — so a route that
  merely gained an optional field would start rejecting the body-less calls it had always accepted.
  `POST /blocks/:blockId/merge` and `POST /notifications/:id/act` keep working with no body at all.

  **BREAKING (wire shape):** `RiskPolicy` gains a required `classRules` field (a partial map from
  change class to `thresholds` / `always` / `never`). Per the pre-1.0 policy there is no dual-read
  shim: persisted rows take the `'{}'` column default, which resolves to "use the score ceilings" for
  every class — i.e. byte-for-byte the previous behaviour — but any external consumer of the preset
  wire shape must account for the new field. The built-in preset seeds bump to version 4, so existing
  workspaces are offered a reseed. `notificationTypeSchema` also gains `merge_tag_request`, and
  `MergeDecision.reason` gains `class_auto_merge` / `class_requires_review`; both are closed unions a
  consumer may be switching on exhaustively.

### Patch Changes

- Updated dependencies [df9ca7d]
  - @cat-factory/contracts@0.167.0
  - @cat-factory/kernel@0.161.0
  - @cat-factory/orchestration@0.142.0
  - @cat-factory/integrations@0.100.0
  - @cat-factory/server@0.152.0
  - @cat-factory/node-server@0.119.0
  - @cat-factory/agents@0.69.10
  - @cat-factory/gitlab@0.13.6
  - @cat-factory/executor-harness@1.56.0

## 0.76.2

### Patch Changes

- 600a8ad: Headless clarification loop: questions out to the linked tracker issue (slice 2a). When a run
  started through `/api/v1` parks its requirements review on open findings, its questions can now
  be posted onto the task's linked GitHub/Jira/Linear issue — each rendered with the stable finding
  id that `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply` takes — so the
  clarification reaches whoever requested the work instead of waiting in an inbox nobody headless
  can see.

  Opt-in per workspace via the new `writebackQuestionsOnPark` tracker setting, with the usual
  per-task `trackerQuestionsOnPark` override; both are exposed in the issue-tracker settings panel
  and the task inspector alongside the existing PR-open/PR-merge writeback toggles. Tasks started in
  the app are deliberately unaffected: the echo fires only for runs whose recorded intake origin is
  `public-api`, and their clarification surface remains the in-app review window.

  The post is driven from the durable execution driver, whose steps replay, so it is made idempotent
  by an atomic claim on a new workspace-scoped `review_question_posts` table keyed by
  `(workspace, review, iteration, issue)` — taken before the comment is attempted, so neither a
  replay nor a crash mid-post can double-post onto an issue a human is reading. A failed post is
  recorded with its error and retried on the next replay rather than being swallowed, and a claim
  abandoned by a poster that died mid-post is re-takeable after `REVIEW_QUESTION_POST_CLAIM_TTL_MS`
  so that iteration's questions are not silently lost. The park is committed before the outbound
  call, so a slow or unavailable tracker can never delay the state change that makes the run
  answerable.

  The comment body is model-authored text landing on a host-parsed (often public) surface, so it is
  rendered through the same untrusted-text boundary as the PR verification report — auto-link
  triggers defused so a finding cannot notify a real account or cross-link an unrelated issue, code
  fences balanced, and secrets scrubbed. That boundary moved from `@cat-factory/orchestration` into
  `@cat-factory/kernel` as the `hostMarkdown` namespace to serve both consumers.

  Breaking (pre-1.0, no migration): `TrackerSettings` gains a required `writebackQuestionsOnPark`
  field and `IssueWritebackProvider` gains a required `postReviewQuestions` method, so a deployment
  with its own implementation of either must add them; `ReviewQuestionPostRepository.claim` takes a
  claim window rather than a bare timestamp; and the `commentOnGitHubIssue` writeback seam must now
  THROW when it cannot resolve the target issue instead of returning quietly (returning is the
  seam's promise that the comment landed). New tables/columns are created by the Cloudflare D1
  migration `0062` and the generated Node Drizzle migration.

- Updated dependencies [600a8ad]
  - @cat-factory/kernel@0.160.0
  - @cat-factory/contracts@0.166.0
  - @cat-factory/integrations@0.99.0
  - @cat-factory/orchestration@0.141.0
  - @cat-factory/server@0.151.0
  - @cat-factory/node-server@0.118.0
  - @cat-factory/agents@0.69.9
  - @cat-factory/gitlab@0.13.5
  - @cat-factory/executor-harness@1.56.0

## 0.76.1

### Patch Changes

- Updated dependencies [3949f82]
  - @cat-factory/contracts@0.165.0
  - @cat-factory/integrations@0.98.0
  - @cat-factory/server@0.150.0
  - @cat-factory/agents@0.69.8
  - @cat-factory/gitlab@0.13.4
  - @cat-factory/kernel@0.159.1
  - @cat-factory/orchestration@0.140.1
  - @cat-factory/node-server@0.117.1
  - @cat-factory/executor-harness@1.56.0

## 0.76.0

### Minor Changes

- 1f8ca48: Let a deployment declare environment-handler seeds so infra handlers are registered programmatically instead of via the SPA.

  A deployment can now pass `seedEnvironmentHandlers` (a list of `RegisterHandlerInput`) to `start()` / `startLocal()`. The server idempotently ensures each seed's `environment_connections` handler exists for **every existing workspace at boot** (a best-effort, fire-and-forget backfill over `workspaceService.list(null)`) and for **each newly-created workspace** (`WorkspaceService.create`), so a service's declared provision type resolves a handler with no manual Infrastructure → Test environments step. Seeding is idempotent (a handler already present for a `(provisionType, manifestId)` is skipped) and per-seed fault-tolerant (a bad seed is logged and skipped, never crashing boot or workspace creation).

  New: the `EnvironmentHandlerSeeder` kernel port, the deployment-neutral `createEnvironmentHandlerSeeder` (`@cat-factory/integrations`), a late-bound `getEnvironmentHandlerSeeder` dependency on `WorkspaceService`, an `environmentHandlerSeeder` handle on the container, and the exported `backfillEnvironmentHandlerSeeds` runtime helper.

### Patch Changes

- Updated dependencies [1f8ca48]
  - @cat-factory/kernel@0.159.0
  - @cat-factory/integrations@0.97.0
  - @cat-factory/orchestration@0.140.0
  - @cat-factory/node-server@0.117.0
  - @cat-factory/agents@0.69.7
  - @cat-factory/gitlab@0.13.3
  - @cat-factory/server@0.149.1
  - @cat-factory/executor-harness@1.56.0

## 0.75.0

### Minor Changes

- 5a58b9d: Pre-PR validation: configurable check commands run in the container before a PR is opened.

  A service frame can now declare validation commands (install / lint / test / build). After the
  coder settles, the executor-harness runs them against the checkout **before** opening a pull
  request; a failure is handed back to the agent with the captured output and the loop retries
  under a per-service attempt budget (default 3). Only a passing checkout opens a PR — an
  exhausted budget fails the step with the last captured output and opens nothing, so broken
  lint/tests never become public PR churn.

  - New per-service config store (`validation_configs`, D1 ⇄ Drizzle) resolved up the frame chain,
    managed via `GET|PUT|DELETE /workspaces/:ws/services/:blockId/validation-checks` and a new
    service-inspector panel.
  - The resolved commands ride the job body (no transport-specific wiring), so this works
    identically on the Cloudflare container, a self-hosted runner pool, and local container/native.
  - Command output is truncated and secret-scrubbed, surfaced live on the step while the repair
    loop runs and persisted on `PipelineStep.validation` for observability.
  - Unconfigured services are unaffected: no commands resolved, no loop, no job-body field.

  BREAKING for self-hosted runner pools only: a pool that wants the LIVE repair-loop view should
  map the new `validationReportPath` in its response manifest (the terminal result envelope is
  forwarded without any manifest change).

  Review follow-ups in this PR:

  - The check loop now feeds the run's inactivity watchdog. `JOB_INACTIVITY_MS` (default 10 min) is
    tighter than a single command's own watchdog (default 15 min), so a legitimately slow
    `install`/`test`/`build` previously aborted the whole run as "inactivity" instead of reporting a
    validation failure.
  - Repair prompts now name any NEW files left un-`git add`ed. The checks run against the working
    tree but only tracked edits are pushed, so an unadded file could take the loop green on work the
    pull request would never contain.
  - Checks resolve from the service frame the engine already walked to, instead of re-deriving it —
    removing two block reads from every agent dispatch.

### Patch Changes

- Updated dependencies [5a58b9d]
  - @cat-factory/executor-harness@1.56.0
  - @cat-factory/contracts@0.164.0
  - @cat-factory/kernel@0.158.0
  - @cat-factory/integrations@0.96.0
  - @cat-factory/orchestration@0.139.0
  - @cat-factory/server@0.149.0
  - @cat-factory/node-server@0.116.0
  - @cat-factory/agents@0.69.6
  - @cat-factory/gitlab@0.13.2

## 0.74.2

### Patch Changes

- 55e0a85: Headless clarification loop over the public API (slice 1). A run started through `/api/v1`
  can now include the requirements-review loop instead of being refused at admission: a new
  `/api/v1/runs/:runId/decisions` surface lists a run's parked human decisions (review findings
  with stable item ids, iteration/cap, the incorporated document; the proposed implementation
  forks) and answers them — reply, dismiss, incorporate, re-review, proceed, resolve-exceeded,
  choose a fork. Every route delegates to the SAME service methods the SPA controllers call, so
  the park's optimistic-concurrency arbitration and the task's merge-preset knobs apply
  identically whichever surface answers first.

  **Breaking:** the public-API scope ladder gains a `decide` rung between `write` and `admin`
  (`read ⊂ write ⊂ decide ⊂ admin`). Answering a parked decision — and starting a headless run
  on a pipeline that can park at all — requires it; a `write` key sees exactly the previous
  behaviour, refusal included. Existing keys keep their stored scope, so a `write` key that
  should now answer decisions must be re-minted as `decide`.

  Also in this slice: `POST /api/v1/jobs/:id/cancel` (an abandoned park can always be cleared,
  so the in-flight cap stays recoverable — there is deliberately no run-killing park timeout);
  a `decision` frame on both public SSE streams, which now stay open across a park; a new
  per-workspace outbound **notification webhook** (`GET|PUT|DELETE
/workspaces/:ws/notification-webhook`) delivered HMAC-signed as a `NotificationChannel`
  alongside in-app and Slack, so a headless caller learns of a park by push rather than
  polling; and `ExecutionInstance.intakeOrigin` (`ui` | `public-api`), recorded so slice 2 can
  push clarification questions to a tracker issue for headless-origin runs only. A UI-started
  task's behaviour is unchanged throughout.

  The webhook endpoint is held to the same SSRF guard as the other operator-supplied-URL
  integrations, at both boundaries: registration rejects a private/internal/cloud-metadata host,
  and delivery goes through the shared `safeFetch` so the guard re-runs on every redirect hop
  (a public endpoint cannot 302 the signed body at an internal target). Two new optional env
  vars, `NOTIFICATION_WEBHOOK_ALLOW_URL_HOSTS` / `NOTIFICATION_WEBHOOK_ALLOW_HTTP_URLS`, widen
  it for a receiver on an internal host or a developer's `localhost`; they are scoped to
  webhooks alone, so they never widen the runner-pool or environment guard. One delivery is
  bounded by a total wall-clock budget rather than an attempt count, because the notification
  fan-out is awaited by the engine step that raises it. The webhook counts as an EXTERNAL
  notification channel, so under mothership mode the mothership — which holds the key its
  signing secret is sealed with — is the side that delivers it.

  Also exported: `assertSafePublicUrl`, the provider-neutral URL guard now shared by the
  environment, runner-pool and notification-webhook integrations (previously an
  environment-labelled private function), so an SSRF bypass is fixed in one place for all of
  them.

  See `docs/initiatives/headless-clarification-loop.md`.

- Updated dependencies [ddcdcd8]
- Updated dependencies [55e0a85]
  - @cat-factory/orchestration@0.138.0
  - @cat-factory/kernel@0.157.0
  - @cat-factory/contracts@0.163.0
  - @cat-factory/integrations@0.95.0
  - @cat-factory/server@0.148.0
  - @cat-factory/node-server@0.115.0
  - @cat-factory/agents@0.69.5
  - @cat-factory/gitlab@0.13.1
  - @cat-factory/executor-harness@1.54.0

## 0.74.1

### Patch Changes

- ecd68c5: PR verification report — the ENGINE now maintains a structured verification report on each
  run's pull request, so a reviewer sees captured facts instead of the agent's own "tests pass"
  prose. It carries the `ci` gate's aggregated verdict (per-check-run names/conclusions +
  `ci-fixer` attempt count), the tester step's structured report, the `deployer` step's
  ephemeral-environment lifecycle (per-frame outcomes + teardown state), the `merger`'s scored
  assessment and the engine's resolved merge decision, run metadata (task, linked tracker issues,
  repo/provider, pipeline, per-step agent kind + resolved model), and a deep link into the run's
  observability panel — as human-readable markdown plus a fenced JSON block validated by the new
  `prVerificationReportSchema`.

  It is written as a marker-delimited region of the PR description and updated **idempotently in
  place**, so a retry or re-run rewrites it instead of appending a second copy, and the agent's own
  description is preserved. Composition happens as each step settles (an engine hook, not a new
  pipeline step), so a run that fails or parks part-way still leaves its evidence on the PR, and a
  section whose producing step didn't run says so explicitly rather than silently vanishing.

  Everything the report interpolates is agent- or human-authored, and a pull-request description is
  a PARSED, potentially PUBLIC surface, so the text boundary is explicit: every free-text field is
  scrubbed with the same `redactSecrets` the telemetry store uses, and every interpolation
  neutralises the host's auto-link triggers (`#123` / `@name` / `!123`, and a closing keyword in
  front of an issue URL — which would otherwise CLOSE that issue when the PR merges), folds
  newlines inside table cells, and balances any code fence the agent left open so the fenced JSON
  block stays extractable. Lists are capped, and what was capped is named in the report's own
  `truncations` log rather than silently shortened.

  New per-workspace setting **`publishPrVerificationReport`** (default on, mirrored D1 ⇄ Drizzle
  with a migration on both runtimes): a workspace that would rather keep its CI verdicts, test
  outcomes and environment URLs off the pull request can decline. Turning it off stops future
  writes; a report already on a PR is left as it is.

  Provider-neutral: it publishes through the facade's ENGINE VCS client, so a GitLab deployment
  gets the report on its merge-request description too. **Breaking for port implementors:**
  `GitHubClient` and `VcsClient` gain a required `getPullRequestBody` method (the read half of the
  read-splice-write upsert), and `PrVerificationReportPublisher` gains a required `resolveTarget`
  (the engine states the repo/provider the ADAPTER resolved, never the run's last dispatch — which
  on a multi-repo task is a peer repo, not the repo whose PR is being written to). Wiring is per facade (Worker ⇄ Node/local) alongside the existing
  merge/mergeability providers; with no VCS client wired the engine behaves exactly as before.
  The SPA gains a narrow boot-time deep-link replay (`?ws=…&block=…&run=…&view=observability`) so
  the report's observability link resolves.

- Updated dependencies [ecd68c5]
  - @cat-factory/contracts@0.162.0
  - @cat-factory/kernel@0.156.0
  - @cat-factory/orchestration@0.137.0
  - @cat-factory/server@0.147.0
  - @cat-factory/gitlab@0.13.0
  - @cat-factory/node-server@0.114.0
  - @cat-factory/agents@0.69.4
  - @cat-factory/integrations@0.94.1
  - @cat-factory/executor-harness@1.54.0

## 0.74.0

### Minor Changes

- 16c98f3: Mothership mode: delegate notification DELIVERY to the mothership.

  A mothership-mode local node persists its notification rows on the mothership but holds none of
  the org's external delivery credentials (the Slack bot token is sealed with the mothership's
  encryption key, which never reaches a laptop), so a `merge_review` / `ci_failed` /
  `release_regression` raised by a local run landed in the inbox and never reached the team's Slack.

  Adds the machine-authed `POST /internal/notifications/deliver`, mounted on BOTH facades behind the
  same audience pin + account scoping as the persistence RPC. The wire carries identifiers only
  (`{ workspaceId, notificationId }`) — the mothership re-reads the row from its own workspace-scoped
  store and delivers THAT, so a node can never inject forged notification text into the org's Slack.
  Each facade wires the new `ServerContainer.machineNotificationDelivery` seam with its EXTERNAL
  channels only; the in-app frame for a laptop-raised notification already arrives over the real-time
  upstream relay, so it is never double-pushed. A deployment with no external channel serves a 503.

  On the consumer side, `composeMothership` builds a `RemoteNotificationChannel` (same base URL +
  per-request machine token as the persistence RPC; a token-less node skips the round-trip) and
  `buildLocalContainer` threads it into `buildNodeContainer`'s new `notificationChannels` option, so
  it composes alongside the local in-app push with no engine change. Delivery stays best-effort: an
  unreachable mothership is logged, never propagated into the state transition that raised the row.

### Patch Changes

- Updated dependencies [16c98f3]
  - @cat-factory/server@0.146.0
  - @cat-factory/node-server@0.113.0
  - @cat-factory/executor-harness@1.54.0

## 0.73.8

### Patch Changes

- 1ffa4fe: Split every product function above 300 lines along cohesive, behaviour-neutral seams so the
  `max-lines-per-function` ratchet reaches step 2 (400 → 300) and `max-lines` drops to its new floor
  (2802 → 2648). The engine's `ExecutionService` constructor now composes its gate windows + review
  subjects through sibling factories (`gate-window-controllers.ts`), `createCore` through
  `container/engine-collaborators.ts` + `container/engine-dependent-modules.ts`, the Node composition
  root through `container-core-deps.ts` + `container-foundation.ts`, the Worker's container assembly
  through an in-file `buildWorkerCoreDependencies`, and six Pinia stores through per-group action
  factories under `stores/{execution,auth,github,initiative,board,workspace}/`, and the Node
  `selectNodeGitHubDeps` selector through the `buildNodeIssueWriteback` +
  `buildNodeGitHubModuleDeps` siblings. No behaviour change.
- Updated dependencies [1ffa4fe]
  - @cat-factory/orchestration@0.136.1
  - @cat-factory/node-server@0.112.1
  - @cat-factory/server@0.145.1
  - @cat-factory/executor-harness@1.54.0

## 0.73.7

### Patch Changes

- 7c6bd77: Per-workspace GitLab PAT connect flow (backend, GitLab UI-parity slice 2a). A hosted
  deployment can now connect a workspace to GitLab by pasting a personal access token: the
  token is validated against the account's identity, sealed at rest (a new `access_token`
  column on `github_installations`, mirrored across D1 + Drizzle), and the workspace's repos
  are browsed / linked / synced through the SAME GitHub-shaped projection surface. A new
  `ProviderRoutingGitHubClient` routes each installation-keyed call to the App or GitLab client
  by the connection's stored provider, so a deployment can serve GitHub App and GitLab PAT
  workspaces side by side. New endpoints: `GET|POST|DELETE /workspaces/:ws/gitlab/connection`
  (503 until GitLab connect is wired). The connect UI is a follow-up slice.
- Updated dependencies [7c6bd77]
  - @cat-factory/kernel@0.155.0
  - @cat-factory/contracts@0.161.0
  - @cat-factory/gitlab@0.12.0
  - @cat-factory/integrations@0.94.0
  - @cat-factory/server@0.145.0
  - @cat-factory/orchestration@0.136.0
  - @cat-factory/node-server@0.112.0
  - @cat-factory/agents@0.69.3
  - @cat-factory/executor-harness@1.54.0

## 0.73.6

### Patch Changes

- Updated dependencies [0e2799e]
- Updated dependencies [696da88]
- Updated dependencies [239788a]
  - @cat-factory/kernel@0.154.2
  - @cat-factory/server@0.144.6
  - @cat-factory/gitlab@0.11.22
  - @cat-factory/integrations@0.93.0
  - @cat-factory/node-server@0.111.6
  - @cat-factory/agents@0.69.2
  - @cat-factory/contracts@0.160.1
  - @cat-factory/orchestration@0.135.5
  - @cat-factory/executor-harness@1.54.0

## 0.73.5

### Patch Changes

- Updated dependencies [770f926]
  - @cat-factory/agents@0.69.1
  - @cat-factory/integrations@0.92.1
  - @cat-factory/kernel@0.154.1
  - @cat-factory/orchestration@0.135.4
  - @cat-factory/server@0.144.5
  - @cat-factory/node-server@0.111.5
  - @cat-factory/gitlab@0.11.21
  - @cat-factory/executor-harness@1.54.0

## 0.73.4

### Patch Changes

- ad4c999: Fix per-job state leaking across concurrent native (`LOCAL_NATIVE_AGENTS`) runs, and stop
  native runs writing into the developer's own home directory.

  Native mode already ran jobs in parallel — one long-lived harness host process starts every job
  immediately, each in its own throwaway clone. But three pieces of per-job state were staged in
  process- or HOME-globals, which are only per-job when the process is. That holds for a container
  and not for the shared native host process, whose `HOME` is the developer's own:

  - **`~/.npmrc` was written, and deleted.** Every agent job configures private-registry auth, and
    a job with no registry entries cleared the file — correct for a reused warm-pool container,
    destructive against the developer's real npm config, on essentially every native run. A native
    job now gets its own npmrc under a per-job directory, pointed at by `npm_config_userconfig` and
    seeded from the developer's file so their registries and proxy still apply. Theirs is never
    written and never removed.
  - **A repo-sourced Claude Skill was installed into `~/.claude/skills/<name>/`.** It outlived the
    run in the developer's personal setup, and two concurrent jobs carrying same-named skills from
    different repos overwrote each other. The native install now happens only into an isolated
    `CLAUDE_CONFIG_DIR`; an ambient run reads the skill from the checkout's `.cat-context/skill/`,
    the same fallback codex always used. The prompt follows: `renderSkillForHarness` now keys off
    ambient auth as well as the harness, so such a run gets the skill's instructions folded in
    rather than a pointer to an install that never happened.
  - **The Tester's secrets were set on `process.env` and restored afterwards.** Two overlapping
    Tester runs in one harness process would read each other's values, and whichever finished
    first would delete the other's mid-run. They now ride explicit child env
    (`RunOptions.agentEnv` → `SubscriptionRunOptions.extraEnv`) merged at spawn, so the agent's
    shell tools still read them as `$KEY` with no shared mutable state.

  Container behaviour is unchanged throughout.

  Two consequences of the npmrc move are handled with it: the stand-up/validation commands the
  HARNESS spawns (rather than the agent) are passed the job env explicitly, so they keep the job's
  registry auth on the native path; and the developer's own credentials, now seeded into the job's
  npmrc, are registered for output redaction alongside the job's. Note `npm_config_userconfig` is
  honoured by npm and pnpm but not yarn, so a yarn checkout on the native path sees only the
  developer's own registries.

- Updated dependencies [ad4c999]
  - @cat-factory/executor-harness@1.54.0
  - @cat-factory/server@0.144.4
  - @cat-factory/node-server@0.111.4

## 0.73.3

### Patch Changes

- Updated dependencies [4ceb622]
  - @cat-factory/orchestration@0.135.3
  - @cat-factory/server@0.144.3
  - @cat-factory/node-server@0.111.3
  - @cat-factory/executor-harness@1.52.2

## 0.73.2

### Patch Changes

- 45f21eb: Lint tightening: ratchet oxlint `max-lines-per-function` (product ceiling) from 632 to 400.

  Split every product function above 400 lines along cohesive, behaviour-neutral seams, clearing
  the entire >400 band. The offenders were the DI composition-root builders and other assembly
  god-functions: the Worker `buildContainer`, `buildNodeContainer`, orchestration `createCore`,
  local `buildLocalContainer`, the Worker `scheduled` cron handler, the server public-API
  `registerTaskRoutes`, and the `pipelines` / `environmentWizard` Pinia store setups. Each was
  carved into a cohesive collaborator (a sibling `container-*`/`stores/*` factory or an in-file
  registrar), following the existing extraction precedents; the two tight-budget composition roots
  (Worker + orchestration `container.ts`) used sibling-file moves so their `check-file-size`
  allowances ratchet down rather than up. The test-glob override (2453) is unchanged.

- Updated dependencies [45f21eb]
  - @cat-factory/orchestration@0.135.2
  - @cat-factory/server@0.144.2
  - @cat-factory/node-server@0.111.2
  - @cat-factory/executor-harness@1.52.2

## 0.73.1

### Patch Changes

- ce1ce11: Cut the pr-reviewer's token burn, and fix slice progress reading 0% for a whole review.

  **Slice progress.** The harness derived progress from tool names the Claude Code CLI no longer
  emits: subagent dispatch is `Agent` (the shipped `sdk-tools.d.ts` has no `TaskInput` at all), and
  the plan arrives as `TaskCreate`/`TaskUpdate` rather than `TodoWrite`. Both matchers missed, so a
  437-turn parallel review reported no slices and no progress. The slice tracker now matches `Agent`
  alongside the legacy `Task`, and a new `progress.ts` reads both plan vocabularies — `TaskCreate`
  needs the tool result too, since the CLI mints the task id there.

  **Token burn.** Measured on a ~450-file review: 437 turns, 39.5M cache-read tokens. Cost is
  turns × context, so anything loaded early is re-paid on every later turn.

  - Agent kinds can now declare `standardsDelivery: 'context-files'`: their resolved best-practice
    standards are NOT folded into the system prompt. `pr-reviewer` takes this and writes them as
    one `.cat-context/standard-<id>.md` file each. Folding charged the parent for every standard on
    every turn (~3.7M tokens) while the slice subagents that actually review the code never received
    them and worked from the parent's paraphrase — so `fragmentAdherence` was rated from a summary
    rather than the standard's text. The reviewer's adherence guidance now points at those files
    (not "folded into this prompt above"), and if the standards preOp couldn't run (GitHub unwired)
    the engine falls back to folding so a review never loses its standards through both channels.
    `composeBlockSystemPrompt`'s delivery argument is now required, so no call site (consensus
    included) can silently re-fold a `context-files` kind's standards. Two standard ids that
    sanitize to the same filename no longer collide (a short id hash disambiguates), so the harness
    can't drop one.
  - `pr-diff.md` now leads with a change-shape rollup and a deterministic suggested slicing
    (`planSlices`, size-capped), and inlines patches only when the whole diff fits one pass. A
    partially-inlined large diff was carried on every turn and bypassed anyway — the slice subagents
    ran 141 git calls and referenced it once.
  - Existing review comments are grouped by file under a path index, so a slice greps its own
    threads instead of the parent reading all of them into context.
  - The reviewer prompt now states the context discipline explicitly (ranged reads, never re-read,
    never dump a whole file, don't read a slice you are about to delegate, keep slices small) and
    tells it to dispatch slice subagents on a cheaper model.

- Updated dependencies [ce1ce11]
  - @cat-factory/executor-harness@1.52.2
  - @cat-factory/agents@0.69.0
  - @cat-factory/server@0.144.1
  - @cat-factory/orchestration@0.135.1
  - @cat-factory/node-server@0.111.1

## 0.73.0

### Minor Changes

- 93496b0: Stream per-call LLM telemetry while a run is in flight, and stop losing the cause of death when a local container dies mid-run.

  A `pr-reviewer` run whose container died 18 minutes in surfaced no slices and no calls — not a subagent-handling regression, but three separate gaps that together made the run unfalsifiable: its telemetry was never written, its container logs were deleted before anyone could read them, and the error it did report described a symptom of the cleanup path rather than the failure.

  - **Per-call telemetry now streams.** The harness buffers each model call as its CLI yields it and drains it on the next poll (`RunnerJobView.callMetrics`, drain-on-read like `spans`/`followUps`); `ContainerAgentExecutor.pollJob` records it immediately. It previously arrived only on the terminal `RunnerJobResult.callMetrics`, so a run that died mid-flight reported ZERO calls no matter how many tokens it had spent — precisely the run worth inspecting. Subagent calls stream too, which matters most: that is where a long review spends its tokens and where the parent stream goes quiet. A call whose tokens are not final yet is the one exception: a CLI that reports only a cumulative total is costed at the end (`attributeCumulativeUsage`), and since a streamed call is already recorded, such a call is withheld until it is complete rather than stored as a zero-token row.

  - **Recording a call twice is now a no-op instead of a duplicate row.** Each metric carries a job-scoped `HarnessCallMetric.seq` stamped by the harness and stable across both channels, so the live drain and the terminal list mint the same `<jobId>-hc-<seq>` id, and `LlmCallMetricRepository.record` ignores an id it already holds (`onConflictDoNothing` on Drizzle, `ON CONFLICT(id) DO NOTHING` on D1 — targeted at the id, so neither store silently swallows a genuinely malformed row). First write wins deliberately — an upsert would recompute a row's stored prompt delta against a chain tip that has since moved on. The executor also skips re-offering a call the live drain already stored, so the terminal write costs one round-trip per NEW call instead of re-walking the whole list. A self-hosted runner pool opts into the live channel with the new `callMetricsPath` response mapping.

  - **A promptless call can no longer break the prompt-delta chain.** `latestChainTip` now ignores rows with `messageCount === 0` (a subagent call carries no re-sendable request transcript). Those interleave with the parent's calls in record order now that telemetry streams live, and a tip that can't be chained onto made every following parent call store its whole prompt instead of a delta — losing the compression the chain exists for on exactly the subagent-heavy runs it matters most for.

  - **An exited container no longer blocks its own replacement (local mode).** `DockerRuntimeAdapter.endpoint()` let `docker port`'s non-zero exit ("no public port '8080/tcp' published for …") escape, but `find()` returns exited containers by design and `resolve()` reads an endpoint-less container as absent. The throw therefore skipped the remove-and-recreate recovery in `dispatchPerRun` and surfaced that CLI line as the run's recorded cause of death. A dead container now resolves to `undefined` per the port contract; a fault against a still-RUNNING container still throws, so the spin-up path keeps its fail-fast diagnostic.

  - **A container that dies mid-run leaves a post-mortem.** The poll now captures the container's exit state (new `ContainerRuntimeAdapter.exitState()`, including whether the runtime OOM-killed it) plus a tail of its own logs onto the failed view's `detail`, and the engine carries that through `recoverContainerEviction` onto the recorded failure. `release()` removes the container as the run settles, so this was the only surviving record of why the harness process went away — and it was being thrown away. Container logs were previously captured only on the spin-up path, never for a container that died after a healthy start. Since a re-dispatch also removes the dead container, the FIRST death's post-mortem is retained on the step (`PipelineStep.firstEvictionDetail`) and folded into the failure alongside the last one — with a crash budget of 1, the first death is usually what explains the run. The text is secret-scrubbed before it is persisted.

  Not addressed here: a PR review's `slices` are still written only when the reviewer job completes, so a killed review still shows none. That is a work-product persistence change, not an observability one.

### Patch Changes

- Updated dependencies [93496b0]
  - @cat-factory/executor-harness@1.52.0
  - @cat-factory/kernel@0.154.0
  - @cat-factory/contracts@0.160.0
  - @cat-factory/orchestration@0.135.0
  - @cat-factory/integrations@0.92.0
  - @cat-factory/server@0.144.0
  - @cat-factory/node-server@0.111.0
  - @cat-factory/agents@0.68.4
  - @cat-factory/gitlab@0.11.20

## 0.72.2

### Patch Changes

- 15249df: Opt-in, per-workspace review-debt friction on task creation.

  When a workspace enables it, authoring a new task is frictioned while finished work sits unreviewed:
  past a soft warn threshold (count of tasks parked on human review) creating a task requires an
  explicit acknowledgement, and in `enforce` mode it is refused outright once too many tasks are in
  review (by count) or one has waited too long (by age). Off by default — zero behaviour change for
  workspaces that don't enable it.

  - **Debt is derived from the existing open-notification signal** — no new "in review" state. A new
    closed `REVIEW_WAIT_NOTIFICATION_TYPES` constant + the pure `assessReviewFriction` verdict live in
    `@cat-factory/contracts`, so the SPA pre-warns with the SAME function the backend enforces with.
  - **Enforced server-side** in `BoardService.addTask` behind optional settings/notifications seams
    (pass-through when unwired or off); a `review_debt_warn` / `review_debt_blocked` 409 drives the
    friction dialog, and an acknowledgement can never tunnel through a hard block.
  - **Four new `workspace_settings` fields** (mode + warn count + two nullable hard-block triggers),
    mirrored across D1 and Drizzle with cross-runtime conformance coverage.
  - **Frontend**: a "Review friction" settings group, the friction dialog (with a "go review" deep
    link), a pre-warn debt badge on the add-task affordance, and copy localized in every locale.

  Full design: `backend/docs/review-debt-friction.md`.

- Updated dependencies [15249df]
  - @cat-factory/contracts@0.159.0
  - @cat-factory/kernel@0.153.0
  - @cat-factory/orchestration@0.134.0
  - @cat-factory/node-server@0.110.0
  - @cat-factory/agents@0.68.3
  - @cat-factory/gitlab@0.11.19
  - @cat-factory/integrations@0.91.2
  - @cat-factory/server@0.143.2
  - @cat-factory/executor-harness@1.50.18

## 0.72.1

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

- Updated dependencies [8254367]
  - @cat-factory/executor-harness@1.50.18
  - @cat-factory/orchestration@0.133.2
  - @cat-factory/integrations@0.91.1
  - @cat-factory/server@0.143.1
  - @cat-factory/agents@0.68.2
  - @cat-factory/node-server@0.109.1

## 0.72.0

### Minor Changes

- 2323df1: Enable/disable + pinned default for the two credential pools (subscription tokens and
  direct-provider API keys).

  A pool can hold several credentials "for the same thing" — several subscription tokens per
  (workspace, vendor), or several API keys per (scope, provider). Previously the only lever was
  delete, and selection was pure usage-aware rotation. Now each credential carries two lifecycle
  flags, editable via a new `PATCH` endpoint (`{ enabled?, isDefault? }`):

  - **Enable / disable** — a disabled credential stays in the pool (still listed and
    re-enablable) but is never leased and no longer makes its vendor/provider "configured", so
    the model picker and pipeline-start guard treat an all-disabled provider as unconfigured.
  - **Pinned default** — one credential per group can be pinned as the preferred one; it is
    leased in preference to usage-aware rotation. At most one default per group (setting one
    clears the prior), and a disabled default is ignored (leasing falls back to rotation among
    the remaining enabled credentials).

  New wire fields `enabled` / `isDefault` on `apiKeySchema` + `vendorCredentialSchema`; new
  `PATCH /workspaces/:ws/vendor-credentials/:id`, `PATCH …/api-keys/:id` (workspace + `/me` +
  account scopes). Persisted as `enabled` / `is_default` columns mirrored across all three stores
  (D1, Drizzle/Postgres, and the local `node:sqlite` credential store), with the lease/list
  queries filtering disabled and ordering the default first. The **LLM Vendors** UI gains a
  default toggle + an enable/disable switch per credential. A new cross-runtime conformance suite
  asserts the enable/disable + default behaviour against every store.

  This is an additive, backwards-compatible schema change: existing credentials read as enabled
  and not-default, so behaviour is unchanged until an operator opts in.

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/contracts@0.158.0
  - @cat-factory/kernel@0.152.0
  - @cat-factory/integrations@0.91.0
  - @cat-factory/server@0.143.0
  - @cat-factory/node-server@0.109.0
  - @cat-factory/agents@0.68.1
  - @cat-factory/gitlab@0.11.18
  - @cat-factory/orchestration@0.133.1
  - @cat-factory/executor-harness@1.50.16

## 0.71.4

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/contracts@0.157.0
  - @cat-factory/kernel@0.151.0
  - @cat-factory/agents@0.68.0
  - @cat-factory/orchestration@0.133.0
  - @cat-factory/server@0.142.0
  - @cat-factory/integrations@0.90.0
  - @cat-factory/executor-harness@1.50.16
  - @cat-factory/gitlab@0.11.17
  - @cat-factory/node-server@0.108.4

## 0.71.3

### Patch Changes

- Updated dependencies [da0b83b]
  - @cat-factory/executor-harness@1.50.14
  - @cat-factory/agents@0.67.9
  - @cat-factory/orchestration@0.132.3
  - @cat-factory/server@0.141.3
  - @cat-factory/node-server@0.108.3

## 0.71.2

### Patch Changes

- 2cfae1e: Internal refactor (lint complexity/size ratchet — `complexity` 60 → 40): extract cohesive helpers
  from the ten functions above cyclomatic complexity 40 so each lands under the new ceiling, all
  behaviour-neutral. No public API, wire shape, or runtime behaviour changes; verified by the
  server / orchestration / agents unit suites and the node config specs (the cross-runtime
  conformance + worker suites run in CI).

  - `@cat-factory/server`: `buildRegisteredAgentBody` split into `buildCodingAgentBody` /
    `buildExploreAgentBody`; `toRunResult` into `coerceCustomResult` / `mapPushOrPrResult`;
    `ContainerAgentExecutor.pollJob`'s subscription/quota usage feedback moved into
    `recordSubscriptionUsageOnce` / `recordSubscriptionQuotaUsageOnce`; the workspace snapshot
    handler's optional-field spread ladder folded into a `definedFields` helper.
  - `@cat-factory/orchestration`: `AgentContextBuilder.buildContext`'s `block` sub-payload extracted
    into `buildBlockPayload`.
  - `@cat-factory/agents`: `coerceInitiativePlan`'s section loops extracted into
    `coerceInitiativePhases` / `coerceInitiativeItems` / `coerceInitiativeDecisions`.
  - `@cat-factory/node-server`: `buildAuthConfig`'s enablement prelude + fail-fast guards extracted
    into `resolveNodeAuthEnablement`.
  - `@cat-factory/worker`: `loadAuthConfig`'s enablement prelude extracted into `resolveAuthEnablement`.
  - `@cat-factory/executor-harness`: `parseAgentJob` split into `parseAgentOutputSpec` /
    `parseAgentPrSpec` / `assembleAgentJob`. Touches the runner image, so its tag is bumped
    (1.50.11) and the three pins re-synced.
  - `@cat-factory/local-server`: carries the re-synced `RECOMMENDED_HARNESS_IMAGE` pin.

- Updated dependencies [2cfae1e]
  - @cat-factory/server@0.141.2
  - @cat-factory/orchestration@0.132.2
  - @cat-factory/agents@0.67.8
  - @cat-factory/node-server@0.108.2
  - @cat-factory/executor-harness@1.50.12

## 0.71.1

### Patch Changes

- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
- Updated dependencies [3c7d62b]
  - @cat-factory/contracts@0.156.0
  - @cat-factory/integrations@0.89.0
  - @cat-factory/kernel@0.150.0
  - @cat-factory/agents@0.67.7
  - @cat-factory/gitlab@0.11.16
  - @cat-factory/orchestration@0.132.1
  - @cat-factory/server@0.141.1
  - @cat-factory/node-server@0.108.1
  - @cat-factory/executor-harness@1.50.10

## 0.71.0

### Minor Changes

- 916278b: feat(frontend-extension-mechanism slice B): custom task types — a deployment-registered work
  item (an "incident", "pentest", "compliance-audit") is now a first-class create-task choice +
  card badge, symmetric with custom agent kinds, with zero host edits.

  - **Contracts.** `taskTypeSchema` / `createTaskTypeSchema` widen from a closed picklist to
    `picklist ∪ namespaced` (`<ns>:<name>`) — the shape `presentation.resultView` already uses. The
    result-view-only `NAMESPACED_RESULT_VIEW_ID_PATTERN` is generalized into a shared `primitives.ts`
    atom (`NAMESPACED_ID_PATTERN` / `isNamespacedId` / `namespacedIdSchema`) reused across every
    extension surface. New `customTaskTypeSchema` (+ `taskTypeFieldDescriptorSchema`), a sparse
    `taskTypeFields.custom` bag for descriptor values, and `workspaceSnapshot.customTaskTypes`.
  - **Kernel.** App-owned `TaskTypeRegistry` (`defaultTaskTypeRegistry()`, empty), mirroring
    `AgentKindRegistry`/`PipelineRegistry`; `defaultPipelineIdForTaskType` consults it after the
    built-in map.
  - **Orchestration.** `CoreDependencies.taskTypeRegistry` threaded into `BoardService` + re-exposed
    on `Core`; `validateRegistrations` gains task-type checks (namespaced id, `formPanel`,
    `defaultPipelineId` resolves).
  - **Server + all three facades.** Snapshot projects `customTaskTypes` (shared `WorkspaceController`);
    the Worker / Node / local facades build, install, validate, and re-export the registry (a
    `taskTypeRegistry` option on `createApp`/`start`/`startLocal`).
  - **Frontend (`@cat-factory/app`).** A `taskTypes` slot + a `useTaskTypesStore` (cloning the
    agents-store merge → `taskTypeMeta` read-model); `buildAgentCapabilitiesManifest` generalized to
    one `buildWorkspaceCapabilitiesManifest(kinds, taskTypes)` carrying both slots (agents store's
    `hydrateCustomKinds` → `hydrateCapabilities`). `AddTaskModal` merges custom types into its picker
    and renders their descriptor fields (or a `taskTypeFormPanels`-paired section) into
    `taskTypeFields.custom`; `TaskCard` shows a type badge via `taskTypeMeta` (unregistered
    namespaced types degrade to the `feature` presentation).

  Cross-runtime conformance asserts the backend round-trip on both runtimes; the `deploy/frontend`
  `acme:security` module dogfoods a CODE-shipped `acme:incident` task type end to end (e2e).

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/contracts@0.155.0
  - @cat-factory/kernel@0.149.0
  - @cat-factory/orchestration@0.132.0
  - @cat-factory/server@0.141.0
  - @cat-factory/node-server@0.108.0
  - @cat-factory/agents@0.67.6
  - @cat-factory/gitlab@0.11.15
  - @cat-factory/integrations@0.88.18
  - @cat-factory/executor-harness@1.50.10

## 0.70.27

### Patch Changes

- 1bcb223: Internal refactor (lint complexity/size ratchet — `max-lines-per-function` step 1.5, 1000 → 632):
  split the product functions above the new ceiling along cohesive seams, all behaviour-neutral. No
  public API, wire shape, or runtime behaviour changes.

  - `@cat-factory/kernel`: `seedPipelines` split into three module-level catalog builders it composes.
  - `@cat-factory/server`: `publicApiController` / `authController` split into per-route-group registrars
    (mirroring `registerCoreControllers`'s mount groups).
  - `@cat-factory/app`: the `board` Pinia store's write operations extracted into `stores/board/`
    factories (`createBoardMutations` / `createBoardRemoval`) over a shared `BoardWriteContext`.
  - `@cat-factory/node-server`: `buildNodeContainer` split into `assembleNodeCoreDependencies` +
    `projectNodeServerContainer` (the `CoreDependencies` object and the `ServerContainer` projection).
  - `@cat-factory/local-server`: `buildLocalContainer`'s `buildNodeContainer` options extracted into
    `buildLocalNodeOptions`.

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5
  - @cat-factory/server@0.140.7
  - @cat-factory/node-server@0.107.26
  - @cat-factory/agents@0.67.5
  - @cat-factory/gitlab@0.11.14
  - @cat-factory/integrations@0.88.17
  - @cat-factory/orchestration@0.131.7
  - @cat-factory/executor-harness@1.50.10

## 0.70.26

### Patch Changes

- Updated dependencies [e86e95b]
  - @cat-factory/orchestration@0.131.6
  - @cat-factory/server@0.140.6
  - @cat-factory/node-server@0.107.25
  - @cat-factory/executor-harness@1.50.10

## 0.70.25

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/contracts@0.154.2
  - @cat-factory/kernel@0.148.4
  - @cat-factory/server@0.140.5
  - @cat-factory/orchestration@0.131.5
  - @cat-factory/integrations@0.88.16
  - @cat-factory/agents@0.67.4
  - @cat-factory/gitlab@0.11.13
  - @cat-factory/node-server@0.107.24
  - @cat-factory/executor-harness@1.50.10

## 0.70.24

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/executor-harness@1.50.10
  - @cat-factory/kernel@0.148.3
  - @cat-factory/agents@0.67.3
  - @cat-factory/server@0.140.4
  - @cat-factory/gitlab@0.11.12
  - @cat-factory/integrations@0.88.15
  - @cat-factory/orchestration@0.131.4
  - @cat-factory/node-server@0.107.23

## 0.70.23

### Patch Changes

- Updated dependencies [b1d1e2c]
  - @cat-factory/orchestration@0.131.3
  - @cat-factory/agents@0.67.2
  - @cat-factory/server@0.140.3
  - @cat-factory/node-server@0.107.22
  - @cat-factory/executor-harness@1.50.8

## 0.70.22

### Patch Changes

- 021f2a0: Make a parallel-subagent review observable and correctly metered (ADR 0026 D2.1/D3/D4).

  - D2.1: the Claude Code runner now derives slice progress from the parent stream's `Task`
    dispatches + their tool_results (which DO appear there), so a subagent-driven review no
    longer sits at 0% — per-slice progress surfaces without a parent TodoWrite plan.
  - D3: a best-effort watcher tails the CLI's `subagents/*.jsonl` transcripts while the run is
    live, feeding the inactivity heartbeat (so a quiet-but-alive review stops looking wedged)
    and summing each subagent turn's token usage into the run's `usage` + per-call telemetry —
    the subagent cost that was previously invisible.
  - D4: a short cold-start watchdog (`JOB_COLD_START_MS`, default 120s, 0 to disable) records a
    structured diagnostic when a job produces no output early — without killing it — plus a
    one-line assertion that the pre-seeded onboarding keys landed, logged with the CLI version.

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/executor-harness@1.50.8
  - @cat-factory/contracts@0.154.1
  - @cat-factory/kernel@0.148.2
  - @cat-factory/server@0.140.2
  - @cat-factory/integrations@0.88.14
  - @cat-factory/node-server@0.107.21
  - @cat-factory/agents@0.67.1
  - @cat-factory/gitlab@0.11.11
  - @cat-factory/orchestration@0.131.2

## 0.70.21

### Patch Changes

- 90a0c1b: Namespace local-mode containers per installation (ADR 0026 D5). Every managed job + warm-pool container is now tagged with a stable, secret-derived install id (a Docker `cat-factory.install` label; the Apple `container` name prefix), and the reaper/adopter/enumerations filter strictly on it. A machine running two local installs against one container daemon can no longer adopt, reap, or re-lease a neighbour's container — closing the warm-pool cross-install `HARNESS_SHARED_SECRET` poisoning vector.
- Updated dependencies [90a0c1b]
  - @cat-factory/orchestration@0.131.1
  - @cat-factory/server@0.140.1
  - @cat-factory/node-server@0.107.20
  - @cat-factory/executor-harness@1.50.6

## 0.70.20

### Patch Changes

- Updated dependencies [7e1f841]
  - @cat-factory/executor-harness@1.50.6

## 0.70.19

### Patch Changes

- Updated dependencies [a14fe03]
  - @cat-factory/contracts@0.154.0
  - @cat-factory/agents@0.67.0
  - @cat-factory/orchestration@0.131.0
  - @cat-factory/server@0.140.0
  - @cat-factory/gitlab@0.11.10
  - @cat-factory/integrations@0.88.13
  - @cat-factory/kernel@0.148.1
  - @cat-factory/node-server@0.107.19
  - @cat-factory/executor-harness@1.50.4

## 0.70.18

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/orchestration@0.130.0
  - @cat-factory/contracts@0.153.0
  - @cat-factory/kernel@0.148.0
  - @cat-factory/server@0.139.0
  - @cat-factory/gitlab@0.11.9
  - @cat-factory/agents@0.66.7
  - @cat-factory/node-server@0.107.18
  - @cat-factory/integrations@0.88.12
  - @cat-factory/executor-harness@1.50.4

## 0.70.17

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3
  - @cat-factory/server@0.138.16
  - @cat-factory/agents@0.66.6
  - @cat-factory/gitlab@0.11.8
  - @cat-factory/integrations@0.88.11
  - @cat-factory/orchestration@0.129.11
  - @cat-factory/node-server@0.107.17
  - @cat-factory/executor-harness@1.50.4

## 0.70.16

### Patch Changes

- Updated dependencies [1614e62]
  - @cat-factory/agents@0.66.5
  - @cat-factory/orchestration@0.129.10
  - @cat-factory/server@0.138.15
  - @cat-factory/node-server@0.107.16
  - @cat-factory/executor-harness@1.50.4

## 0.70.15

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/contracts@0.152.2
  - @cat-factory/kernel@0.147.2
  - @cat-factory/server@0.138.14
  - @cat-factory/orchestration@0.129.9
  - @cat-factory/agents@0.66.4
  - @cat-factory/gitlab@0.11.7
  - @cat-factory/integrations@0.88.10
  - @cat-factory/node-server@0.107.15
  - @cat-factory/executor-harness@1.50.4

## 0.70.14

### Patch Changes

- 26f7c18: Lint ratchet: `max-statements` from its pinned baseline (157) down below 60 (no behavioural
  change).

  Every function above 50 statements is split along a cohesive seam so the `.oxlintrc.json`
  `max-statements` ceiling can drop from 157 to 50. All extractions are behaviour-neutral (moved
  code verbatim into well-named helpers, destructured at the top so the remaining bodies are
  unchanged; verified by the package unit suites and the cross-runtime conformance suites on real
  Postgres/workerd in CI):

  - **`createUiModals`** (`app/stores/ui/modals.ts`, 157): the flat bag of modal refs + open/close
    handlers is grouped into cohesive sub-factories (`createHealthAdvisoryModals`,
    `createDocumentTaskModals`, `createIntegrationPanelModals`, `createSettingsModals`,
    `createInfraModals`, `createAiOnboardingModals`, `createMiscModals`) composed behind the shared
    hub came-from markers; the returned public surface is unchanged.
  - **the LLM proxy handler** (`server/modules/llmProxy/LlmProxyController.ts`, 108): the workers-ai
    ceiling, the in-process dispatch, upstream resolution (local runner vs the DB-backed key pool),
    and the response relay are extracted into `applyWorkersAiCeiling` / `dispatchInProcess` /
    `resolveUpstreamTarget` / `relayUpstream` behind a per-call `ProxyCallContext`.
  - **`registerCoreControllers`** (`server/app.ts`, 77): the controller mounts split into
    `registerRootControllers` / `registerWorkspaceControllers` / `registerWebhookControllers`
    (exact mount order preserved).
  - **`resolveAuxiliaryRepos`** (`server/agents/ContainerAgentExecutor.ts`, 75),
    **`checkEntityCallScope`** (`server/persistence/rpc.ts`, 63), and the screenshot handler
    (`server/modules/artifacts/HarnessArtifactController.ts`, 51) are split along their existing
    seams.
  - **`provisionRecipe`** (`integrations/modules/compose/ComposeEnvironmentProvider.ts`, 94):
    decomposed into `preflightRecipe` / `readRecipeComposeFiles` / `materializeRecipeEnvFiles` /
    `runComposeBuildAndUp` / `runRecipeStepsAndGate` / `resolvePreviewUrl`. `bringUp`
    (`SharedStackService.ts`, 60), `buildKubernetesRecommendation` /
    `detectFrontendConfig` (`environments/*-detect.logic.ts`, 58/52) split similarly.
  - **`buildNodeContainer`** (`node/container.ts`, 63), the stale-run sweeper `tick`
    (`node/execution/pgBossRunner.ts`, 54), `bootServer` (`node/server.ts`, 53), and
    `buildLocalContainer` (`local/container.ts`, 51) extract cohesive sub-builders / sweeper
    closures.
  - **the coder container callbacks** (`executor-harness/src/coding-agent.ts`, 67/63) extract
    `prepareCodingCheckout` / `finalizeCodingRun` / `prepareMultiRepoCheckouts` /
    `pushMultiRepoLegs`. The harness image tag is bumped accordingly.
  - **orchestration**: `createCore` (`container.ts`, 71), the `RunDispatcher` step handlers
    (66/60), `SandboxRunService` (59), and `CompanionController` (56) split along cohesive seams.

- Updated dependencies [26f7c18]
  - @cat-factory/server@0.138.13
  - @cat-factory/orchestration@0.129.8
  - @cat-factory/integrations@0.88.9
  - @cat-factory/node-server@0.107.14
  - @cat-factory/executor-harness@1.50.4

## 0.70.13

### Patch Changes

- e4efb5f: Lint ratchet: `complexity` step 1 (141 → 60; no behavioural change).

  Every function above cyclomatic-complexity 60 is split along a cohesive seam so the
  `.oxlintrc.json` `complexity` ceiling can drop from its pinned baseline (141) to the first
  real step (60). All extractions are behaviour-neutral (verified by the server + orchestration
  unit suites and the node/local config tests; the cross-runtime conformance suites cover the
  `FakeAgentExecutor` + config paths on real Postgres/workerd in CI):

  - **`loadNodeConfig`** (`node/config.ts`, 141): the giant `AppConfig`-assembly function is
    decomposed into cohesive per-section builders (`resolveProviderCaps`, `buildAgentRouting`,
    `buildGithubConfig`, `buildAuthConfig`, `buildEmailConfig`, `buildEnvironmentsConfig`,
    `buildRunnersConfig`, `buildRetentionConfig`, `buildLangfuseConfig`, `buildOtelConfig`,
    `buildExecutionConfig`).
  - **`dispatchPersistenceCall`** (`server/persistence/rpc.ts`, 101): the scope-rule enforcement
    switch is lifted into `checkCallScope`, then split again into `checkEntityCallScope` (the
    block/service/user/owner resolver kinds) + a shared `checkOwnerPairScope`, keeping the two
    switches jointly exhaustive over `ScopeRule`.
  - **`buildJobBody`** (`server/agents/ContainerAgentExecutor.ts`, 75): the multi-repo fan-out /
    conflict-resolver / merger-combined-diff / reference-repo+branch resolution is extracted into
    `resolveAuxiliaryRepos`.
  - **`FakeAgentExecutor.run`** (conformance, 68): the decision/blueprints/spec-writer/companion
    cluster moves into `runProducerKinds`.
  - **`buildNodeContainer`** (`node/container.ts`, 64): the app-owned registry resolution + EKS
    registration moves into `resolveNodeAppRegistries`.
  - **`buildLocalContainer`** (`local/container.ts`, 66): the provider-agnostic PAT/VCS-client/
    repo-origin resolution moves into `resolveLocalVcs`.
  - **`pollAgentJobInner`** (`orchestration/RunDispatcher.ts`, 61): the running-poll fold becomes
    `applyRunningFold` and the gate-helper re-probe becomes `reprobeGateAfterHelper`.

- Updated dependencies [e4efb5f]
  - @cat-factory/server@0.138.12
  - @cat-factory/orchestration@0.129.7
  - @cat-factory/node-server@0.107.13
  - @cat-factory/executor-harness@1.50.2

## 0.70.12

### Patch Changes

- Updated dependencies [6a6c6df]
  - @cat-factory/node-server@0.107.12

## 0.70.11

### Patch Changes

- 972a1bd: Lint ratchet: complete `max-params` (20 → 6, its final target; no behavioural change).

  Refactored every function above the target from a long positional list to a bundled
  argument, walking the `.oxlintrc.json` ceiling down 20 → 10 → 8 → 6:

  - **DI builders → dependency objects:** the Node `buildNodeContainerExecutor`
    (`NodeContainerExecutorDeps`), the Worker `selectAgentExecutor` / `buildContainerExecutor`
    (a shared `WorkerExecutorDeps`), `buildResolveTransport`, and `selectEnvConfigRepairer`.
  - **Loop-invariant step context → one object:** the deployer fan-out (`DeployerFanOut`
    threaded through `advanceDeployerFrames` / `settleDeployerFrame` / `settleDeployerFailure` /
    `completeDeployerStep`), the companion `applyAssessment` grading bundle, the Tester
    `failTester` failure bundle, and the gate `dispatchGateHelper` helper bundle.
  - **`ExecutionService.start(...)` trailing options → `RunStartOptions`** (new
    `runStartOptions.ts`, keeping `ExecutionService.ts` under the `max-lines` ceiling), updated
    at every call site.
  - **Callback / identity bundles:** `GitHubSyncService.syncResource` handlers,
    `RequirementReviewService.runWriterForChunk` (resolved model + grounding),
    `EnvironmentConnectionService.runProviderValidate` repo target, `SkillSourceService.syncSkillDir`
    dir descriptor, and the executor-harness `streamCli` CLI descriptor.

  The executor-harness bump republishes the runner image (its `streamCli` refactor touches
  `src/**`); the three image-tag pins + `RECOMMENDED_HARNESS_IMAGE` are synced to `1.50.1`.

- Updated dependencies [972a1bd]
  - @cat-factory/orchestration@0.129.6
  - @cat-factory/integrations@0.88.8
  - @cat-factory/agents@0.66.3
  - @cat-factory/server@0.138.11
  - @cat-factory/node-server@0.107.11
  - @cat-factory/executor-harness@1.50.2

## 0.70.10

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1
  - @cat-factory/node-server@0.107.10
  - @cat-factory/integrations@0.88.7
  - @cat-factory/agents@0.66.2
  - @cat-factory/gitlab@0.11.6
  - @cat-factory/orchestration@0.129.5
  - @cat-factory/server@0.138.10
  - @cat-factory/executor-harness@1.50.0

## 0.70.9

### Patch Changes

- Updated dependencies [2d97b16]
  - @cat-factory/orchestration@0.129.4
  - @cat-factory/agents@0.66.1
  - @cat-factory/server@0.138.9
  - @cat-factory/node-server@0.107.9
  - @cat-factory/executor-harness@1.50.0

## 0.70.8

### Patch Changes

- Updated dependencies [8b6fa53]
  - @cat-factory/orchestration@0.129.3
  - @cat-factory/node-server@0.107.8
  - @cat-factory/server@0.138.8
  - @cat-factory/executor-harness@1.50.0

## 0.70.7

### Patch Changes

- Updated dependencies [a10bfdf]
- Updated dependencies [a10bfdf]
  - @cat-factory/server@0.138.7
  - @cat-factory/executor-harness@1.50.0
  - @cat-factory/kernel@0.147.0
  - @cat-factory/agents@0.66.0
  - @cat-factory/orchestration@0.129.2
  - @cat-factory/node-server@0.107.7
  - @cat-factory/gitlab@0.11.5
  - @cat-factory/integrations@0.88.6

## 0.70.6

### Patch Changes

- Updated dependencies [7aab031]
  - @cat-factory/orchestration@0.129.1
  - @cat-factory/agents@0.65.5
  - @cat-factory/server@0.138.6
  - @cat-factory/node-server@0.107.6
  - @cat-factory/executor-harness@1.48.1

## 0.70.5

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/orchestration@0.129.0
  - @cat-factory/kernel@0.146.0
  - @cat-factory/contracts@0.152.1
  - @cat-factory/server@0.138.5
  - @cat-factory/node-server@0.107.5
  - @cat-factory/agents@0.65.4
  - @cat-factory/gitlab@0.11.4
  - @cat-factory/integrations@0.88.5
  - @cat-factory/executor-harness@1.48.1

## 0.70.4

### Patch Changes

- Updated dependencies [e679977]
  - @cat-factory/contracts@0.152.0
  - @cat-factory/orchestration@0.128.0
  - @cat-factory/agents@0.65.3
  - @cat-factory/gitlab@0.11.3
  - @cat-factory/integrations@0.88.4
  - @cat-factory/kernel@0.145.1
  - @cat-factory/server@0.138.4
  - @cat-factory/node-server@0.107.4
  - @cat-factory/executor-harness@1.48.1

## 0.70.3

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/contracts@0.151.0
  - @cat-factory/kernel@0.145.0
  - @cat-factory/orchestration@0.127.0
  - @cat-factory/agents@0.65.2
  - @cat-factory/gitlab@0.11.2
  - @cat-factory/integrations@0.88.3
  - @cat-factory/server@0.138.3
  - @cat-factory/node-server@0.107.3
  - @cat-factory/executor-harness@1.48.1

## 0.70.2

### Patch Changes

- Updated dependencies [2138e45]
  - @cat-factory/integrations@0.88.2
  - @cat-factory/orchestration@0.126.1
  - @cat-factory/server@0.138.2
  - @cat-factory/node-server@0.107.2
  - @cat-factory/executor-harness@1.48.1

## 0.70.1

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/contracts@0.150.0
  - @cat-factory/kernel@0.144.0
  - @cat-factory/orchestration@0.126.0
  - @cat-factory/server@0.138.1
  - @cat-factory/node-server@0.107.1
  - @cat-factory/agents@0.65.1
  - @cat-factory/gitlab@0.11.1
  - @cat-factory/integrations@0.88.1
  - @cat-factory/executor-harness@1.48.1

## 0.70.0

### Minor Changes

- 6709dc4: Migrate the last module-global plugin registries to app-owned DI (the registry-DI initiative):
  pipelines, VCS providers, provider tokens, and agent traits now ride the composition root's
  injected instances instead of a process-wide `Map`, removing the `clear*()` test cruft and the
  phantom-`Map` hazard for separately-published adapter packages (e.g. `@cat-factory/gitlab`).

  **Breaking (pre-1.0, no back-compat):** the following free functions are removed in favour of the
  app-owned registry instances a facade injects:

  - **Pipelines** (`@cat-factory/kernel`): `registerPipeline` / `registerPipelines` /
    `registeredPipelines` / `clearRegisteredPipelines` / `mergeRegisteredPipelines` →
    `PipelineRegistry` (`register` / `registerMany` / `registered` / `merge`) + `defaultPipelineRegistry()`.
    `seedPipelines(registry?)` now takes the registry (the no-arg form returns the built-in catalog).
  - **VCS providers** (`@cat-factory/kernel`): `registerVcsProvider` / `getVcsProvider` /
    `resolveVcsProvider` / `requireVcsProvider` / `isVcsProviderRegistered` / `registeredVcsProviders` /
    `clearVcsProviders` → `VcsProviderRegistry` + `defaultVcsRegistry()` (a required `ServerContainer`
    field, so facade parity is type-enforced). `@cat-factory/gitlab`'s `registerGitLab` now takes the
    registry as its first argument.
  - **Provider tokens** (`@cat-factory/kernel`): `wireProvider` / `getProvider` / `isProviderWired` /
    `requireProvider` / `clearProviders` → `ProviderRegistry` + `defaultProviderRegistry()`, read by the
    gate machine's `GateContext` (which gains `isProviderWired`). The `@cat-factory/gates` `wireX` /
    `applyGateProviders` / `warnUnwiredGates` handles take the registry as their first argument;
    `clearGateProviders` is no longer needed by a facade (a fresh registry per build starts empty).
  - **Agent traits** (`@cat-factory/agents`): `registerAgentTrait` / `registerAgentTraits` /
    `registeredAgentTrait` / `clearRegisteredAgentTraits` / `assignAgentTraits` /
    `clearAssignedAgentTraits` are folded onto the app-owned `AgentKindRegistry`
    (`registerTrait` / `registerTraits` / `traitDefinition` / `assignTraits` / `assignedTraitsFor`);
    `traitsFor` / `hasTrait` / `traitGuidanceFor` keep their signatures. `@cat-factory/consensus`'s
    `registerConsensusTraits` now takes the registry as its first argument.

### Patch Changes

- Updated dependencies [009bc97]
- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/integrations@0.88.0
  - @cat-factory/server@0.138.0
  - @cat-factory/node-server@0.107.0
  - @cat-factory/contracts@0.149.0
  - @cat-factory/kernel@0.143.0
  - @cat-factory/orchestration@0.125.0
  - @cat-factory/agents@0.65.0
  - @cat-factory/gitlab@0.11.0
  - @cat-factory/executor-harness@1.48.1

## 0.69.20

### Patch Changes

- Updated dependencies [4dbf0fc]
  - @cat-factory/orchestration@0.124.2
  - @cat-factory/server@0.137.10
  - @cat-factory/node-server@0.106.11
  - @cat-factory/executor-harness@1.48.1

## 0.69.19

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0
  - @cat-factory/integrations@0.87.0
  - @cat-factory/agents@0.64.2
  - @cat-factory/gitlab@0.10.22
  - @cat-factory/orchestration@0.124.1
  - @cat-factory/server@0.137.9
  - @cat-factory/node-server@0.106.10
  - @cat-factory/executor-harness@1.48.1

## 0.69.18

### Patch Changes

- f34ddf1: Move the **gate** and **step-resolver** registries onto the app-owned DI seam
  (`docs/initiatives/registry-di-migration.md`), the same pattern as the agent-kind /
  backend registries. The two engine-extension registries the `RunDispatcher` reads are no
  longer module-global `Map`s populated by import side effect.

  - **kernel** now exposes `GateRegistry` / `defaultGateRegistry()` and `StepResolverRegistry`
    / `defaultStepResolverRegistry()` classes. The free functions `registerGate` /
    `registeredGateFactories` / `clearRegisteredGates` and `registerStepResolver` /
    `registeredStepResolverFactories` / `clearRegisteredStepResolvers` are **removed**
    (breaking — pre-1.0, no shim). Registration is now `registry.register(kind, factory)` on
    the app-owned instance the composition root injects.
  - **`@cat-factory/gates`** — `registerBuiltinGates(registry)` now takes the app-owned
    `GateRegistry` and the **module-load side-effect registration is gone** (the
    `registerBuiltinGates()` band-aid the registry-DI initiative called out). A new
    `gateRegistryWithBuiltins()` factory returns a fresh registry pre-loaded with the suite in one
    call — the seam a facade uses (`overrides.gateRegistry ?? gateRegistryWithBuiltins()`) so the
    empty-default hazard is unrepresentable; `registerBuiltinGates` stays for installing into an
    already-held instance.
  - **orchestration** threads `gateRegistry` + `stepResolverRegistry` through
    `CoreDependencies` → `ExecutionService` → `RunDispatcher` (defaulted so existing
    construction sites don't break), re-exposes `gateRegistry` on `Core`, and
    `validateRegistrations` now takes the gate registry to cross-check.
  - The three **facades** build the registries, install the built-in gates, and inject the
    same instance into `createCore` + the boot-time validation — kept symmetric and covered by
    the cross-runtime conformance suite (the custom-gate + step-resolver assertions now inject
    the registries via `makeApp`).

  Provider tokens and the pipeline registry remain module-global (the next slices of the
  initiative). Deployment packages that registered gates/resolvers via the free functions must
  switch to registering by reference on the injected instances (see
  `@cat-factory/example-custom-agent`'s `registerExampleCustomAgents`).

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0
  - @cat-factory/orchestration@0.124.0
  - @cat-factory/node-server@0.106.9
  - @cat-factory/agents@0.64.1
  - @cat-factory/gitlab@0.10.21
  - @cat-factory/integrations@0.86.6
  - @cat-factory/server@0.137.8
  - @cat-factory/executor-harness@1.48.1

## 0.69.17

### Patch Changes

- Updated dependencies [37c642f]
  - @cat-factory/agents@0.64.0
  - @cat-factory/server@0.137.7
  - @cat-factory/orchestration@0.123.8
  - @cat-factory/node-server@0.106.8
  - @cat-factory/executor-harness@1.48.1

## 0.69.16

### Patch Changes

- Updated dependencies [ea64461]
  - @cat-factory/agents@0.63.0
  - @cat-factory/server@0.137.6
  - @cat-factory/orchestration@0.123.7
  - @cat-factory/node-server@0.106.7
  - @cat-factory/executor-harness@1.48.1

## 0.69.15

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1
  - @cat-factory/integrations@0.86.5
  - @cat-factory/orchestration@0.123.6
  - @cat-factory/server@0.137.5
  - @cat-factory/node-server@0.106.6
  - @cat-factory/agents@0.62.13
  - @cat-factory/gitlab@0.10.20
  - @cat-factory/executor-harness@1.48.1

## 0.69.14

### Patch Changes

- Updated dependencies [edfd2f8]
- Updated dependencies [d675cc5]
  - @cat-factory/orchestration@0.123.5
  - @cat-factory/server@0.137.4
  - @cat-factory/node-server@0.106.5
  - @cat-factory/executor-harness@1.48.1

## 0.69.13

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0
  - @cat-factory/orchestration@0.123.4
  - @cat-factory/contracts@0.148.1
  - @cat-factory/agents@0.62.12
  - @cat-factory/gitlab@0.10.19
  - @cat-factory/integrations@0.86.4
  - @cat-factory/server@0.137.3
  - @cat-factory/node-server@0.106.4
  - @cat-factory/executor-harness@1.48.1

## 0.69.12

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
  - @cat-factory/agents@0.62.11
  - @cat-factory/executor-harness@1.48.1
  - @cat-factory/integrations@0.86.3
  - @cat-factory/kernel@0.139.3
  - @cat-factory/node-server@0.106.3
  - @cat-factory/orchestration@0.123.3
  - @cat-factory/server@0.137.2
  - @cat-factory/gitlab@0.10.18

## 0.69.11

### Patch Changes

- Updated dependencies [1f5f5bc]
  - @cat-factory/contracts@0.148.0
  - @cat-factory/orchestration@0.123.2
  - @cat-factory/agents@0.62.10
  - @cat-factory/gitlab@0.10.17
  - @cat-factory/integrations@0.86.2
  - @cat-factory/kernel@0.139.2
  - @cat-factory/server@0.137.1
  - @cat-factory/node-server@0.106.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.10

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/server@0.137.0
  - @cat-factory/contracts@0.147.1
  - @cat-factory/kernel@0.139.1
  - @cat-factory/integrations@0.86.1
  - @cat-factory/node-server@0.106.1
  - @cat-factory/executor-harness@1.47.0
  - @cat-factory/agents@0.62.9
  - @cat-factory/gitlab@0.10.16
  - @cat-factory/orchestration@0.123.1

## 0.69.9

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/contracts@0.147.0
  - @cat-factory/kernel@0.139.0
  - @cat-factory/orchestration@0.123.0
  - @cat-factory/integrations@0.86.0
  - @cat-factory/server@0.136.0
  - @cat-factory/node-server@0.106.0
  - @cat-factory/agents@0.62.8
  - @cat-factory/gitlab@0.10.15
  - @cat-factory/executor-harness@1.47.0

## 0.69.8

### Patch Changes

- Updated dependencies [60c0a1e]
- Updated dependencies [f444062]
  - @cat-factory/contracts@0.146.0
  - @cat-factory/orchestration@0.122.0
  - @cat-factory/integrations@0.85.4
  - @cat-factory/server@0.135.0
  - @cat-factory/agents@0.62.7
  - @cat-factory/gitlab@0.10.14
  - @cat-factory/kernel@0.138.1
  - @cat-factory/node-server@0.105.1
  - @cat-factory/executor-harness@1.47.0

## 0.69.7

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/contracts@0.145.0
  - @cat-factory/orchestration@0.121.0
  - @cat-factory/server@0.134.0
  - @cat-factory/kernel@0.138.0
  - @cat-factory/node-server@0.105.0
  - @cat-factory/agents@0.62.6
  - @cat-factory/gitlab@0.10.13
  - @cat-factory/integrations@0.85.3
  - @cat-factory/executor-harness@1.47.0

## 0.69.6

### Patch Changes

- Updated dependencies [5924903]
  - @cat-factory/contracts@0.144.0
  - @cat-factory/server@0.133.0
  - @cat-factory/node-server@0.104.0
  - @cat-factory/agents@0.62.5
  - @cat-factory/gitlab@0.10.12
  - @cat-factory/integrations@0.85.2
  - @cat-factory/kernel@0.137.1
  - @cat-factory/orchestration@0.120.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.5

### Patch Changes

- 74c21ab: feat: repo-sourced Claude Skills — freshness automation (slice 4)

  Keep a running pipeline from ever executing a stale skill, without the management
  surface having to resync by hand (docs/initiatives/repo-skills.md, final slice):

  - **Push-webhook fan-out.** A verified `push` webhook to a repo that skill sources are
    linked to now enqueues a targeted `skill-source-resync` job per affected source, so its
    skills are refreshed shortly after the upstream change. One indexed
    `SkillSourceRepository.listByRepo(owner, name)` lookup (new port method, D1 ⇄ Drizzle
    with a conformance assertion; the `skill_sources(repo_owner, repo_name)` index was
    already in place) drives the fan-out; the enqueue rides the existing GitHub-sync queue
    through a new `GitHubWebhookIngest.queueSkillResync` seam (Cloudflare Queue ⇄ Node
    pg-boss), and the async consumer runs `SkillSourceService.sync` for the one source
    (a source unlinked between enqueue and processing is swallowed, not retried forever).
  - **Dispatch-time self-verifying probe.** At skill-step dispatch, `SkillRunResolver` now
    probes the source dir's head commit; if it advanced since the last sync it re-syncs so
    the run uses current instructions. It never fails the run — any probe/re-sync error
    degrades to the last-synced record (a run may be at most one push behind, never broken),
    and it's a no-op on the common unchanged path (one `latestCommitSha` read).

  Together with the push fan-out this is the layered freshness story: the webhook keeps the
  account catalog warm, and the dispatch probe is the correctness backstop for deployments
  with no sync queue (local/dev) or a missed delivery. Backend-only; no harness/image change.

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0
  - @cat-factory/server@0.132.0
  - @cat-factory/agents@0.62.4
  - @cat-factory/integrations@0.85.1
  - @cat-factory/orchestration@0.120.1
  - @cat-factory/node-server@0.103.1
  - @cat-factory/gitlab@0.10.11
  - @cat-factory/executor-harness@1.47.0

## 0.69.4

### Patch Changes

- Updated dependencies [27f0ea2]
  - @cat-factory/orchestration@0.120.0
  - @cat-factory/server@0.131.0
  - @cat-factory/node-server@0.103.0
  - @cat-factory/executor-harness@1.47.0

## 0.69.3

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/contracts@0.143.0
  - @cat-factory/kernel@0.136.0
  - @cat-factory/integrations@0.85.0
  - @cat-factory/server@0.130.0
  - @cat-factory/node-server@0.102.0
  - @cat-factory/orchestration@0.119.0
  - @cat-factory/agents@0.62.3
  - @cat-factory/gitlab@0.10.10
  - @cat-factory/executor-harness@1.47.0

## 0.69.2

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0
  - @cat-factory/contracts@0.142.0
  - @cat-factory/orchestration@0.118.0
  - @cat-factory/node-server@0.101.0
  - @cat-factory/agents@0.62.2
  - @cat-factory/gitlab@0.10.9
  - @cat-factory/integrations@0.84.12
  - @cat-factory/server@0.129.2
  - @cat-factory/executor-harness@1.47.0

## 0.69.1

### Patch Changes

- Updated dependencies [e618bf5]
  - @cat-factory/contracts@0.141.0
  - @cat-factory/server@0.129.1
  - @cat-factory/agents@0.62.1
  - @cat-factory/gitlab@0.10.8
  - @cat-factory/integrations@0.84.11
  - @cat-factory/kernel@0.134.1
  - @cat-factory/orchestration@0.117.1
  - @cat-factory/node-server@0.100.1
  - @cat-factory/executor-harness@1.47.0

## 0.69.0

### Minor Changes

- be6e109: Workspace RBAC (slice 3): resolve effective workspace access in the shared auth gate.

  `mountAuthGate` now resolves a signed-in caller's effective workspace role once (via the
  new `loadWorkspaceAccess` helper over the kernel `resolveWorkspaceAccess` decision) and
  publishes it on the request context as `workspaceAccess`. A denied board returns the
  existing 404 shape (existence is never leaked); a resolved-but-insufficient write hits the
  **viewer write floor** — any non-GET method requires at least `member`, with the read-only
  `POST /workspaces/:ws/events/ticket` mint allowlisted — returning `403 forbidden`. The
  account-admin escape hatch and the legacy owner-only board are preserved byte-for-byte.

  `WorkspaceVisibility` is extended (unrestricted account boards, an admin-account escape
  hatch, an explicit-membership branch, and legacy-owned boards) and enforced SQL-side in
  both the D1 and Drizzle `listVisible`; `AccountService.accessibleAccountScopes` derives the
  member/admin account sets from the single existing membership read. `GET /workspaces`
  annotates each board with the caller's effective `viewerRole` via one batched member-row
  read, and the board snapshot (GET + create) carries the resolved `access` (role +
  permissions). `WorkspaceService.create` auto-enrolls the creator as a workspace admin. The
  `workspace_members` repository is now wired into both runtime facades' containers. Cross-
  runtime conformance asserts the 404 invisibility, the viewer floor + ticket allowlist, the
  escape hatch, and list filtering over the real HTTP gate on both D1 and Postgres.

### Patch Changes

- 32a0720: feat: repo-sourced Claude Skills — executable pipeline step (slice 2)

  Make a synced repo-sourced Claude Skill runnable as a pipeline step
  (docs/initiatives/repo-skills.md):

  - **One generic `skill` agent kind** (`container-coding`, `noChangesTolerated`,
    `pr-or-work` clone), parametrized per step by a new `stepOptions.skillId` — not a
    dynamic kind per skill. Pipeline save (and run-start re-validation) rejects a `skill`
    step that names no skill.
  - **`SkillRunResolver`** resolves the picked skill at dispatch: the persisted
    instructions from the account catalog plus the sibling resource bodies fetched at the
    skill's immutable pinned commit (per-file + total caps; oversized/binary files are
    referenced by repo path instead). The run never depends on a live GitHub fetch — a
    fetch failure degrades a resource to a path reference rather than failing the run.
    Wired into the engine as `skillResolver` in `AgentContextBuilder` (a skill step
    dispatched with the library unconfigured fails loudly rather than running blank), and
    the run step is pinned with `skillVersion: { skillId, commit, sha }`.
  - **Harness-aware rendering** in `ContainerAgentExecutor`: the resolved skill travels as
    a dedicated top-level `skill` job-body field (never a context file). The
    executor-harness materialises it natively into `CLAUDE_CONFIG_DIR/skills/<name>/` for
    the claude-code subscription harness (so the CLI loads it), and under
    `.cat-context/skill/` for the Pi/codex harnesses (whose prompt carries the folded-in
    instructions).
  - Bumps `@cat-factory/executor-harness` (native claude-code skills write) and the pinned
    runner image tag in the Node/local facades.

- 54e117e: GitLab UI parity (pre-slice): carry a `provider` VCS discriminator on the repo/connection
  projection.

  The GitLab-parity SPA work (provider-aware labels, icons, host/URL shapes) needs a
  `provider: VcsProvider` (`'github' | 'gitlab'`) it can read off the data. This adds that
  field to the `GitHubRepo` / `GitHubConnection` / `GitHubAvailableRepo` wire types and the
  kernel `GitHubInstallation`, and persists it symmetrically on both runtimes' projection
  tables (D1 migration `0051_vcs_provider.sql` + a Drizzle migration + both sets of mappers).
  The tables keep their GitHub names — the entity-rename fold is separate, acknowledged Phase-1
  work.

  `provider` is a per-connection fact: a connection records it (`GitHubInstallationService.connect`
  → `'github'`; local mode's `AutoProvisioningInstallationRepository` → the deployment's provider,
  `'gitlab'` for a GitLab-PAT deployment), and the repos reached through it inherit it (the sync
  service stamps `installation.provider`, the bootstrapper and CLI `linkRepo` stamp their own).
  Rows written before the column default to `'github'`. A cross-runtime conformance suite
  (`defineVcsProviderSuite`) asserts the round-trip on both stores. No SPA behaviour changes yet;
  this unblocks the presentation-switch slices.

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/contracts@0.140.0
  - @cat-factory/kernel@0.134.0
  - @cat-factory/agents@0.62.0
  - @cat-factory/orchestration@0.117.0
  - @cat-factory/server@0.129.0
  - @cat-factory/executor-harness@1.47.0
  - @cat-factory/integrations@0.84.10
  - @cat-factory/node-server@0.100.0
  - @cat-factory/gitlab@0.10.7

## 0.68.7

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0
  - @cat-factory/contracts@0.139.0
  - @cat-factory/orchestration@0.116.0
  - @cat-factory/server@0.128.0
  - @cat-factory/node-server@0.99.0
  - @cat-factory/agents@0.61.2
  - @cat-factory/gitlab@0.10.6
  - @cat-factory/integrations@0.84.9
  - @cat-factory/executor-harness@1.45.0

## 0.68.6

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/contracts@0.138.0
  - @cat-factory/kernel@0.132.0
  - @cat-factory/server@0.127.1
  - @cat-factory/node-server@0.98.1
  - @cat-factory/agents@0.61.1
  - @cat-factory/gitlab@0.10.5
  - @cat-factory/integrations@0.84.8
  - @cat-factory/orchestration@0.115.1
  - @cat-factory/executor-harness@1.45.0

## 0.68.5

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0
  - @cat-factory/contracts@0.137.0
  - @cat-factory/agents@0.61.0
  - @cat-factory/orchestration@0.115.0
  - @cat-factory/server@0.127.0
  - @cat-factory/node-server@0.98.0
  - @cat-factory/gitlab@0.10.4
  - @cat-factory/integrations@0.84.7
  - @cat-factory/executor-harness@1.45.0

## 0.68.4

### Patch Changes

- 1869ad3: Add a "Ralph loop" task type: a persistent retry-until-done coding loop whose exit condition is
  a programmatic validation command the harness runs against the checkout (exit 0 = done), bounded
  by a per-task iteration budget and surviving restarts.

  Each iteration is a fresh-context container-coding run that works the task spec; the harness then
  runs the task's configured `ralph.validationCommand` (bounded timeout, redacted output tail) and
  reports the verdict on the run result — never a model self-report. The engine (`RalphController` +
  a `ralph-verdict` step-completion interceptor, modelled on the Tester→Fixer loop) re-dispatches a
  fresh iteration on a failing verdict until it passes or the `ralph.maxIterations` budget (default 10) is spent, then hands off to a human. Loop state rides the persisted `step.ralph` (no
  migration), so a mid-loop run is re-driven from where it was by both durable drivers + sweepers.

  - New `ralph` agent kind (the reusable loop-body primitive) + the `pl_ralph` pipeline
    (`ralph → conflicts → ci → merger`) + a `ralph` task type (a one-click creation entry point).
  - The validation command + iteration budget are per-task agent config; `AgentConfigDescriptor`
    gained `text`/`number` control types for them.
  - Cross-runtime conformance coverage (loop completes / exhausts / refuses to start unconfigured)
    and pure-logic unit tests.

  Breaking: none (pre-1.0; `taskType` / `step.ralph` / the descriptor types are additive). The
  executor-harness image is bumped for the new in-container validation capability.

- Updated dependencies [1869ad3]
  - @cat-factory/contracts@0.136.0
  - @cat-factory/kernel@0.130.0
  - @cat-factory/agents@0.60.0
  - @cat-factory/server@0.126.0
  - @cat-factory/orchestration@0.114.0
  - @cat-factory/executor-harness@1.45.0
  - @cat-factory/gitlab@0.10.3
  - @cat-factory/integrations@0.84.6
  - @cat-factory/node-server@0.97.4

## 0.68.3

### Patch Changes

- Updated dependencies [06a094a]
  - @cat-factory/contracts@0.135.0
  - @cat-factory/server@0.125.0
  - @cat-factory/agents@0.59.2
  - @cat-factory/gitlab@0.10.2
  - @cat-factory/integrations@0.84.5
  - @cat-factory/kernel@0.129.2
  - @cat-factory/orchestration@0.113.2
  - @cat-factory/node-server@0.97.3
  - @cat-factory/executor-harness@1.43.8

## 0.68.2

### Patch Changes

- Updated dependencies [6dc444e]
  - @cat-factory/server@0.124.0
  - @cat-factory/node-server@0.97.2
  - @cat-factory/executor-harness@1.43.8

## 0.68.1

### Patch Changes

- Updated dependencies [bd0a42a]
  - @cat-factory/server@0.123.1
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/node-server@0.97.1

## 0.68.0

### Minor Changes

- 745de02: feat(mothership): real-time upstream publish (the outbound half of PR 2's real-time both directions)

  A mothership-mode local node runs the engine on the laptop but delegates org/durable state to the
  mothership. Until now its engine events (a run advancing, a board change, a notification) never
  reached the mothership's real-time fan-out, so a hosted teammate watching the same shared board
  couldn't see the local node's activity live. This adds the upstream channel.

  - `@cat-factory/server`: a new machine-authed `POST /internal/events/publish` endpoint
    (`eventsRelayController`) + the `MachineEventRelay` seam on `ServerContainer` + the
    `HttpMachineEventClient`. Mounted on both facades; account-scoped and default-deny exactly like
    the persistence RPC (a workspace outside the token's scope is a uniform 404). The verbatim-forwarded
    payload is size-capped (413 above the ceiling) so a compromised node can't inject an unbounded frame.
  - `@cat-factory/node-server`: `LocalMachineEventRelay` delivers a relayed event into the facade's
    own real-time sink (the hub / layered propagator); attached whenever a realtime sink is wired.
  - `@cat-factory/worker`: `DurableObjectMachineEventRelay` delivers a relayed event into the
    per-workspace `WorkspaceEventsHub` Durable Object — the symmetric Cloudflare side.
  - `@cat-factory/local-server`: `MothershipWebSocketPropagator` (a `WebSocketPropagator` adapter,
    reusing the existing cross-node seam) forwards the local node's engine events upstream; it is
    layered over the hub in mothership mode so every event fans to the laptop's own SPA AND the
    mothership.

  Scope: this is the OUTBOUND direction only. The INBOUND subscribe leg (the local node receiving org
  events raised on the mothership / by peer laptops) is a distinct, runtime-shaped follow-up — see
  `docs/initiatives/mothership-mode.md`.

### Patch Changes

- Updated dependencies [745de02]
- Updated dependencies [6108525]
- Updated dependencies [6108525]
  - @cat-factory/server@0.123.0
  - @cat-factory/node-server@0.97.0
  - @cat-factory/orchestration@0.113.1
  - @cat-factory/kernel@0.129.1
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/agents@0.59.1
  - @cat-factory/gitlab@0.10.1
  - @cat-factory/integrations@0.84.4

## 0.67.7

### Patch Changes

- Updated dependencies [6227908]
  - @cat-factory/node-server@0.96.1

## 0.67.6

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

- Updated dependencies [bc77cac]
- Updated dependencies [1b90387]
  - @cat-factory/executor-harness@1.43.8
  - @cat-factory/server@0.122.0
  - @cat-factory/node-server@0.96.0

## 0.67.5

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/agents@0.59.0
  - @cat-factory/kernel@0.129.0
  - @cat-factory/contracts@0.134.0
  - @cat-factory/orchestration@0.113.0
  - @cat-factory/server@0.121.0
  - @cat-factory/gitlab@0.10.0
  - @cat-factory/node-server@0.95.2
  - @cat-factory/integrations@0.84.3
  - @cat-factory/executor-harness@1.43.6

## 0.67.4

### Patch Changes

- Updated dependencies [9e9127f]
  - @cat-factory/contracts@0.133.0
  - @cat-factory/orchestration@0.112.0
  - @cat-factory/server@0.120.0
  - @cat-factory/agents@0.58.1
  - @cat-factory/gitlab@0.9.1
  - @cat-factory/integrations@0.84.2
  - @cat-factory/kernel@0.128.1
  - @cat-factory/node-server@0.95.1
  - @cat-factory/executor-harness@1.43.6

## 0.67.3

### Patch Changes

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

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0
  - @cat-factory/server@0.119.0
  - @cat-factory/node-server@0.95.0
  - @cat-factory/contracts@0.132.0
  - @cat-factory/agents@0.58.0
  - @cat-factory/orchestration@0.111.0
  - @cat-factory/gitlab@0.9.0
  - @cat-factory/integrations@0.84.1
  - @cat-factory/executor-harness@1.43.6

## 0.67.2

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/contracts@0.131.0
  - @cat-factory/kernel@0.127.0
  - @cat-factory/agents@0.57.0
  - @cat-factory/orchestration@0.110.0
  - @cat-factory/integrations@0.84.0
  - @cat-factory/server@0.118.0
  - @cat-factory/gitlab@0.8.1
  - @cat-factory/node-server@0.94.8
  - @cat-factory/executor-harness@1.43.6

## 0.67.1

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/contracts@0.130.0
  - @cat-factory/kernel@0.126.0
  - @cat-factory/agents@0.56.0
  - @cat-factory/orchestration@0.109.0
  - @cat-factory/server@0.117.0
  - @cat-factory/gitlab@0.8.0
  - @cat-factory/integrations@0.83.3
  - @cat-factory/node-server@0.94.7
  - @cat-factory/executor-harness@1.43.6

## 0.67.0

### Minor Changes

- 86bbd18: Resolve the local `container` deploy runner's image automatically — `LOCAL_DEPLOY_IMAGE` is now an
  escape hatch, not a mandatory companion.

  - **local-server:** `LOCAL_DEPLOY_RUNTIME=container` now works out of the box with no other
    variable. The deploy-harness image defaults to `RECOMMENDED_DEPLOY_IMAGE` — the version this
    backend release supports, kept in lockstep with the Worker's `wrangler.toml` pin and the
    deploy-harness `version` by the runner-image-tag sync (`scripts/sync-runner-image-tags.mjs`), so
    every facade resolves the SAME supported deploy image. This mirrors how `LOCAL_HARNESS_IMAGE`
    defaults to `RECOMMENDED_HARNESS_IMAGE`. `LOCAL_DEPLOY_IMAGE` is retained ONLY as an override to
    pin a custom/older build or a private-registry mirror (container mode no longer breaks boot when
    it is unset — only `native` still requires its `LOCAL_DEPLOY_HARNESS_ENTRY` companion).
  - **cli:** `cat-factory init`/`env` now steer to the one-line `container` mode in the generated
    `.env` (and the scaffolded `.env.example`), documenting `LOCAL_DEPLOY_IMAGE` as an escape hatch
    with an auto-resolved default. `cat-factory k3s`, after provisioning a local cluster connection,
    now also points the user at enabling the deploy runner (`LOCAL_DEPLOY_RUNTIME=container`) so a
    guided Kubernetes-test-environment setup no longer stops one step short and fails mid-run with
    "no deploy runner wired".

## 0.66.0

### Minor Changes

- d38d6c2: Make the local Kubernetes deploy runner explicit and its misconfiguration loud.

  - **local-server (BREAKING for `LOCAL_DEPLOY_RUNTIME`):** `LOCAL_DEPLOY_RUNTIME` no longer
    defaults to `native`. It is unset ⇒ deploy stays unwired (the normal "no Kubernetes test
    environments" state); set explicitly to `native` or `container` to wire it. A mode set WITHOUT
    its mandatory companion variable (`LOCAL_DEPLOY_HARNESS_ENTRY` for `native`,
    `LOCAL_DEPLOY_IMAGE` for `container`) — or an unrecognised value — now BREAKS boot with an
    actionable config error instead of warning and silently degrading to an unwired deploy that
    only failed mid-run. `native` was the more brittle, higher-privilege mode, so it must be chosen
    deliberately rather than fallen into.
  - **integrations:** the `deploy_runner_unwired` provisioning failure message now spells out each
    facade's exact setting and, for local mode, both modes' companion variables and how they differ.
  - **cli:** `cat-factory init` and `cat-factory env` now document the three `LOCAL_DEPLOY_*`
    variables in the generated `.env` (and the scaffolded `.env.example`), commented out — deploy is
    unused by default, and no companion var is written active since a lone mode breaks boot.

### Patch Changes

- Updated dependencies [d38d6c2]
  - @cat-factory/integrations@0.83.2
  - @cat-factory/orchestration@0.108.1
  - @cat-factory/server@0.116.1
  - @cat-factory/node-server@0.94.6
  - @cat-factory/executor-harness@1.43.6

## 0.65.15

### Patch Changes

- 5fa0a8e: perf(github): fix the slow add-service repo picker search on the local (workspace-PAT) path

  The "add service from repo" typeahead stalled for seconds per keystroke when local mode's
  `GITHUB_PAT` backed the picker: `PatGitHubClient.searchInstallationRepos` re-walked the
  PAT's entire `GET /user/repos` set — up to 20 SEQUENTIAL pages — on every search request,
  with nothing cached (the counterpart viewer-PAT branch was already fixed, but the
  workspace-credential branch kept its own older serial walk).

  - `PatGitHubClient.listInstallationRepos` now delegates to the shared
    `FetchGitHubClient.listReposForToken` walk (page 1 reveals the page count via
    `Link: rel="last"`, the remaining pages fetch concurrently — ~2 round-trips instead of
    up to 20 serial ones) and re-stamps the rows as workspace-wide (`linkedVia: 'app'`).
    Note the enumeration cap is now the shared walk's 10 pages (1000 repos, flagged
    `truncated`) instead of the old silent 20.
  - New `AppCaches.patInstallationRepos` slice (grouped/keyed by installation id, 60s TTL;
    pass-through on the Worker's isolate-safe profile): the picker typeahead filters a
    cached complete enumeration in memory instead of re-walking `/user/repos` per
    keystroke. The blank browse-all stays live/uncached. The local PAT is env-fixed per
    boot, so there is no swap-write to invalidate on — the short TTL is the coherence
    story, mirroring `viewerRepos`.
  - `GitHubSyncService.listAvailableRepos` now runs its three independent reads (the
    tracked-projection list, the App-side lookup, the viewer-PAT expansion) as one
    concurrent wave instead of serially, so a cold PAT enumeration no longer stacks on top
    of the App lookup's latency.

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/contracts@0.129.0
  - @cat-factory/kernel@0.125.0
  - @cat-factory/agents@0.55.0
  - @cat-factory/orchestration@0.108.0
  - @cat-factory/server@0.116.0
  - @cat-factory/integrations@0.83.1
  - @cat-factory/gitlab@0.7.71
  - @cat-factory/node-server@0.94.5
  - @cat-factory/executor-harness@1.43.6

## 0.65.14

### Patch Changes

- 806811c: Node/local boot de-serialization (app-startup initiative, items 2/5/6). The Node facade brings up its five pg-boss consumers (execution / bootstrap / env-config-repair / env-test / github-sync) as one `Promise.all` wave instead of awaiting them serially — each is an independent queue with no ordering dependency, so this collapses ~10 back-to-back DB round trips on the boot path to ~2 (kept after `boss.start()` and before listen, invariant unchanged). The best-effort Redis reachability probe (`warnIfRedisUnreachable`) and local mode's GitHub PAT probe are now fire-and-forget (`warnIfRedisUnreachableInBackground` / `warnOnGitHubPatProblemInBackground`) rather than awaited, so a set-but-down Redis bus no longer stalls boot for ~3.5s and a slow github.com round-trip no longer precedes `start()`. Both probes still log their single warning if/when they resolve; the local runtime `--version` preflight stays awaited (it gates limited mode).
- Updated dependencies [806811c]
  - @cat-factory/node-server@0.94.4

## 0.65.13

### Patch Changes

- Updated dependencies [3f3031a]
  - @cat-factory/orchestration@0.107.10
  - @cat-factory/server@0.115.1
  - @cat-factory/node-server@0.94.3
  - @cat-factory/executor-harness@1.43.6

## 0.65.12

### Patch Changes

- Updated dependencies [ca9ea20]
  - @cat-factory/integrations@0.83.0
  - @cat-factory/server@0.115.0
  - @cat-factory/orchestration@0.107.9
  - @cat-factory/node-server@0.94.2
  - @cat-factory/executor-harness@1.43.6

## 0.65.11

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0
  - @cat-factory/integrations@0.82.0
  - @cat-factory/server@0.114.0
  - @cat-factory/orchestration@0.107.8
  - @cat-factory/node-server@0.94.1
  - @cat-factory/agents@0.54.12
  - @cat-factory/gitlab@0.7.70
  - @cat-factory/executor-harness@1.43.6

## 0.65.10

### Patch Changes

- c28f89e: Add boot-phase timers to the backend startup path (app-startup initiative, item 1). `bootServer`
  now brackets each phase (config, migrate, pg-boss start, container build, bus, worker registration,
  listen) with `performance.now()` and logs one structured `cat-factory node server ready in N ms`
  line with the per-phase breakdown; local mode times its own preflights (container-runtime probe,
  GitHub PAT probe) the same way. New `startBootClock` helper is exported from `@cat-factory/node-server`.
  Pure instrumentation — no behavioural change.
- Updated dependencies [c28f89e]
  - @cat-factory/node-server@0.94.0

## 0.65.9

### Patch Changes

- 6c4bcef: fix(infra-setup): stop the false "test environment not configured" nag in local mode, and make the remaining nag actionable

  Local mode on a Docker-family runtime stands the Tester's dependencies up with the
  zero-config in-container `local-compose` backend, so a missing ephemeral-environment
  _provider_ connection is not actually a setup gap there. The infra-setup projection
  now gates the `ephemeralEnvironments` area on a new
  `ephemeralEnvironmentsRequireProvider` container flag (derived from the deployment's
  test-env capability via `testEnvHasZeroConfigDefault`) — exactly like
  `agentExecutorRequiresRunnerPool` gates the executor area — so the banner stays quiet
  where docker-compose already works and only fires where a provider is genuinely
  mandatory (the Worker, stock Node, and local Apple `container`).

  Where the nag still applies, its copy now tells the user what to do: open Test
  environments and connect a Kubernetes cluster or a custom HTTP environment provider.

- Updated dependencies [6c4bcef]
- Updated dependencies [6c4bcef]
  - @cat-factory/contracts@0.128.2
  - @cat-factory/kernel@0.123.3
  - @cat-factory/integrations@0.81.20
  - @cat-factory/server@0.113.9
  - @cat-factory/node-server@0.93.9
  - @cat-factory/agents@0.54.11
  - @cat-factory/gitlab@0.7.69
  - @cat-factory/orchestration@0.107.7
  - @cat-factory/executor-harness@1.43.6

## 0.65.8

### Patch Changes

- Updated dependencies [b34ab46]
- Updated dependencies [b34ab46]
  - @cat-factory/executor-harness@1.43.6
  - @cat-factory/server@0.113.8
  - @cat-factory/orchestration@0.107.6
  - @cat-factory/node-server@0.93.8

## 0.65.7

### Patch Changes

- Updated dependencies [90a7fb3]
  - @cat-factory/integrations@0.81.19
  - @cat-factory/server@0.113.7
  - @cat-factory/orchestration@0.107.5
  - @cat-factory/node-server@0.93.7
  - @cat-factory/executor-harness@1.43.4

## 0.65.6

### Patch Changes

- Updated dependencies [c1028cc]
  - @cat-factory/orchestration@0.107.4
  - @cat-factory/server@0.113.6
  - @cat-factory/node-server@0.93.6
  - @cat-factory/executor-harness@1.43.4

## 0.65.5

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/executor-harness@1.43.4
  - @cat-factory/kernel@0.123.2
  - @cat-factory/contracts@0.128.1
  - @cat-factory/agents@0.54.10
  - @cat-factory/gitlab@0.7.68
  - @cat-factory/integrations@0.81.18
  - @cat-factory/orchestration@0.107.3
  - @cat-factory/server@0.113.5
  - @cat-factory/node-server@0.93.5

## 0.65.4

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/orchestration@0.107.2
  - @cat-factory/kernel@0.123.1
  - @cat-factory/server@0.113.4
  - @cat-factory/node-server@0.93.4
  - @cat-factory/agents@0.54.9
  - @cat-factory/gitlab@0.7.67
  - @cat-factory/integrations@0.81.17
  - @cat-factory/executor-harness@1.43.2

## 0.65.3

### Patch Changes

- Updated dependencies [85bf0ef]
  - @cat-factory/server@0.113.3
  - @cat-factory/node-server@0.93.3
  - @cat-factory/executor-harness@1.43.2

## 0.65.2

### Patch Changes

- Updated dependencies [17c6808]
  - @cat-factory/server@0.113.2
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/node-server@0.93.2

## 0.65.1

### Patch Changes

- Updated dependencies [e4c5abe]
- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0
  - @cat-factory/orchestration@0.107.1
  - @cat-factory/server@0.113.1
  - @cat-factory/integrations@0.81.16
  - @cat-factory/agents@0.54.8
  - @cat-factory/gitlab@0.7.66
  - @cat-factory/node-server@0.93.1
  - @cat-factory/executor-harness@1.43.2

## 0.65.0

### Minor Changes

- 1e684b7: Add a "Test environment creation" diagnostic to the service inspector. A developer can now
  run the whole ephemeral-environment lifecycle against a throwaway branch — create branch →
  provision → tear down → delete branch — and see the live stage plus the final success/failure
  (and the stage it failed at), with guaranteed cleanup even on error.

  Modelled as a durable, observable run (its own `environment_test_runs` table on both facades)
  driven by a Cloudflare Workflow on the Worker and pg-boss on Node, with live `envTest` events
  pushed to the SPA. Adds the `RepoFiles.deleteBranch` port method (implemented once in the shared
  server layer) so the throwaway branch is reclaimed through the existing checkout-free seam.

  The always-cleans-up contract is enforced on every path: the branch is persisted before
  dispatch (a dispatch failure can't orphan it), a failed deploy view releases the runner and
  finalizes so cleanup tears down partial infra, a stop mid-provision aborts the in-flight
  deploy job, and the run's synthetic environment-registry row is always reclaimed. The
  provisioning config is pinned on the run record at dispatch, terminal writes are guarded
  (`updateIfRunning`, first-writer-wins vs the stop button), and both runtimes gain an env-test
  stale-run sweep plus self-finalization on poll-budget exhaustion so a run whose driver dies
  can never show `running` forever. The SPA store reconciles snapshots and live events by
  `updatedAt` so a stale refresh can't regress or drop a run's state.

  Schema change (no backwards-compatible migration, per project policy): a new
  `environment_test_runs` table is added to both the D1 (`0050_environment_test_runs.sql`) and
  Postgres/Drizzle schemas.

- 1e684b7: Mothership-mode GitHub support + remote persistence for environment self-test runs.

  **GitHub token delegation.** The mothership now serves a machine-authed
  `POST /internal/github/installation-token` (mounted on both facades, like the persistence
  RPC): a mothership-mode local node presents its machine token and an installation id, the
  call is rate-limited per node (fixed window on the token's signed `nodeId`) and
  account-scoped off the installation's own account binding (live row + `accountId` in the
  token scope, uniform 404 otherwise), and the mothership's GitHub App mints a short-lived
  installation token **repo-scoped via `repository_ids`** to the live App-linked
  `github_repos` projection for that installation (`user_pat`-linked rows excluded; no
  linked repos ⇒ 404) — never an installation-wide token, and never served from or written
  into the engine's unscoped token cache. Every mint/denial/failure is audit-logged with
  the node + user ids (the new kernel port method backing the scoping read is
  `RepoProjectionRepository.listByInstallation`, mirrored D1 ⇄ Drizzle). A mothership-mode
  local node with no `GITHUB_PAT` now consumes these tokens through the new
  `DelegatedAppTokenSource` — wiring the push/clone token mint AND a full `FetchGitHubClient`
  (gates, merge, repo-link, `resolveRunRepoContext`/RepoFiles) off the org's GitHub App, with
  the App private key never leaving the mothership. An explicitly configured PAT still wins;
  `GITHUB_PAT` is now optional in mothership mode.

  **Environment self-test remote persistence.** The `environment_test_runs` store is now on
  the mothership persistence allow-list (`get`/`update`/`listRunningByWorkspace` workspace-
  scoped, record-based `insert` bound on the run's `workspaceId` field), so a mothership-mode
  node persists and lists its self-test runs remotely instead of failing with
  `unknown_method`. Its former blocker — the self-test's GitHub branch create/delete — is
  served by the delegation endpoint above. A FULL mothership-mode self-test still waits on
  the provisioning writes (`environmentRegistryRepository.insert`/`update`, the
  secrets-delegation slice); until then the run fails cleanly at the provisioning stage with
  cleanup.

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/contracts@0.128.0
  - @cat-factory/kernel@0.122.0
  - @cat-factory/orchestration@0.107.0
  - @cat-factory/integrations@0.81.15
  - @cat-factory/server@0.113.0
  - @cat-factory/node-server@0.93.0
  - @cat-factory/agents@0.54.7
  - @cat-factory/gitlab@0.7.65
  - @cat-factory/executor-harness@1.43.2

## 0.64.38

### Patch Changes

- Updated dependencies [5a3fe5d]
- Updated dependencies [2a13ece]
  - @cat-factory/server@0.112.10
  - @cat-factory/node-server@0.92.21
  - @cat-factory/kernel@0.121.8
  - @cat-factory/integrations@0.81.14
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/agents@0.54.6
  - @cat-factory/gitlab@0.7.64
  - @cat-factory/orchestration@0.106.8

## 0.64.37

### Patch Changes

- 3ce997d: Structured container-eviction signal (error-message initiative I1). A container eviction is now
  carried on a typed `RunnerJobView.evicted` field (`'crash'` | `'transient'`, the new
  `ContainerEvictionKind`) minted by every runner transport (Cloudflare, the shared local
  `harnessHttp`, the local container/pool/process/native-routing transports, and Kubernetes/EKS),
  forwarded through `AgentJobUpdate`, and read by the execution / bootstrap / env-config-repair
  consumers via the new `evictionKindOf` extractor. The `(container evicted or crashed)` sentinel +
  the transient marker are PRESERVED as the fallback for an older producer, so nothing that still
  matches the string breaks — the structured field is simply the load-bearing signal now, replacing
  the regex as the primary classification channel.
- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7
  - @cat-factory/orchestration@0.106.7
  - @cat-factory/server@0.112.9
  - @cat-factory/integrations@0.81.13
  - @cat-factory/agents@0.54.5
  - @cat-factory/gitlab@0.7.63
  - @cat-factory/node-server@0.92.20
  - @cat-factory/executor-harness@1.43.2

## 0.64.36

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6
  - @cat-factory/orchestration@0.106.6
  - @cat-factory/server@0.112.8
  - @cat-factory/agents@0.54.4
  - @cat-factory/gitlab@0.7.62
  - @cat-factory/integrations@0.81.12
  - @cat-factory/node-server@0.92.19
  - @cat-factory/executor-harness@1.43.2

## 0.64.35

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/executor-harness@1.43.2
  - @cat-factory/agents@0.54.3
  - @cat-factory/contracts@0.127.1
  - @cat-factory/gitlab@0.7.61
  - @cat-factory/integrations@0.81.11
  - @cat-factory/kernel@0.121.5
  - @cat-factory/node-server@0.92.18
  - @cat-factory/orchestration@0.106.5
  - @cat-factory/server@0.112.7

## 0.64.34

### Patch Changes

- 5dd16d3: Elaborate two boot-time connectivity failures with actionable remedies (error-message coverage
  A11/A12):

  - **A11 (Node):** a loopback Postgres connection that's refused or reset at boot now reports the
    fix on the misconfigured screen — including the Windows/Docker-Desktop `localhost`→IPv6 `::1`
    footgun and the `127.0.0.1` workaround — instead of dying with a raw `ECONNRESET`. A non-loopback
    (remote) database being briefly unreachable is deliberately left to crash-and-retry.
  - **A12 (Local):** a set-but-invalid `GITHUB_PAT` is validated once at boot (a best-effort
    `GET /user`) and, when it's expired/revoked/under-scoped, warned about with the same pre-scoped
    token-creation link the missing-PAT warning already uses — instead of failing opaquely on the
    first clone/push/PR later.

- Updated dependencies [5dd16d3]
  - @cat-factory/node-server@0.92.17

## 0.64.33

### Patch Changes

- Updated dependencies [e68c958]
- Updated dependencies [90553c8]
  - @cat-factory/integrations@0.81.10
  - @cat-factory/node-server@0.92.16
  - @cat-factory/server@0.112.6
  - @cat-factory/orchestration@0.106.4
  - @cat-factory/executor-harness@1.43.0

## 0.64.32

### Patch Changes

- Updated dependencies [e61c980]
  - @cat-factory/server@0.112.5
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/node-server@0.92.15

## 0.64.31

### Patch Changes

- 4810353: Structured, elaborated container/runner dispatch failures (error-message coverage initiative,
  items D1/I2). A `dispatch()` rejection used to throw a bare `Container dispatch failed (HTTP n)`
  string that named the symptom but not the cause, and downstream consumers decided "was this a
  dispatch failure?" by regex-matching `/dispatch failed/i` — so error IDENTITY rode a string, and a
  self-hosted-pool fault (`Runner pool … → <status>`, a different wording) fell through and was
  mislabelled a `preflight` error.

  - **I2** — new kernel `DispatchError` (`domain/dispatch-errors.ts`) carries the HTTP `status` as a
    structured field, thrown by every transport `dispatch()`: `CloudflareContainerTransport`,
    `KubernetesRunnerTransport`, the local `postHarnessJob` (both local transports), and
    `RunnerPoolTransport` (which re-wraps the pool provider's `RunnerPoolApiError`, carrying its
    status). `BootstrapService`, `EnvConfigRepairService`, and the execution engine
    (`classifyDispatchFailure`) now classify via `instanceof` / the `isDispatchFailure` extractor,
    with the legacy `/dispatch failed/i` message shape kept only as a fallback. This fixes the pool
    dispatch fault being mislabelled `preflight`.
  - **D1** — a 404 from the harness `/jobs` route (the deployed executor-harness image predates the
    route because its tag was never bumped, so new containers run stale code) now elaborates with the
    stale-image cause + the republish-under-a-fresh-tag remedy and a link to the release rules. The
    raw `<label> dispatch failed (HTTP n): <body>` first line is preserved verbatim (still greppable,
    still matched by the fallback regex); the cause + remedy is only appended.

  No behaviour changes beyond error message text and failure classification. No executor-harness
  image change (the dispatch signal is minted by in-repo transports).

- Updated dependencies [4810353]
- Updated dependencies [327a1ef]
  - @cat-factory/kernel@0.121.4
  - @cat-factory/orchestration@0.106.3
  - @cat-factory/integrations@0.81.9
  - @cat-factory/node-server@0.92.14
  - @cat-factory/agents@0.54.2
  - @cat-factory/gitlab@0.7.60
  - @cat-factory/server@0.112.4
  - @cat-factory/executor-harness@1.43.0

## 0.64.30

### Patch Changes

- Updated dependencies [6fc42ed]
- Updated dependencies [b7ca24a]
  - @cat-factory/server@0.112.3
  - @cat-factory/node-server@0.92.13
  - @cat-factory/executor-harness@1.43.0

## 0.64.29

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3
  - @cat-factory/orchestration@0.106.2
  - @cat-factory/server@0.112.2
  - @cat-factory/node-server@0.92.12
  - @cat-factory/agents@0.54.1
  - @cat-factory/gitlab@0.7.59
  - @cat-factory/integrations@0.81.8
  - @cat-factory/executor-harness@1.43.0

## 0.64.28

### Patch Changes

- Updated dependencies [3b3bdc8]
  - @cat-factory/server@0.112.1
  - @cat-factory/integrations@0.81.7
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/node-server@0.92.11
  - @cat-factory/orchestration@0.106.1

## 0.64.27

### Patch Changes

- Updated dependencies [6a4feb9]
  - @cat-factory/node-server@0.92.10

## 0.64.26

### Patch Changes

- Updated dependencies [d1a4129]
  - @cat-factory/contracts@0.127.0
  - @cat-factory/agents@0.54.0
  - @cat-factory/orchestration@0.106.0
  - @cat-factory/server@0.112.0
  - @cat-factory/gitlab@0.7.58
  - @cat-factory/integrations@0.81.6
  - @cat-factory/kernel@0.121.2
  - @cat-factory/node-server@0.92.9
  - @cat-factory/executor-harness@1.43.0

## 0.64.25

### Patch Changes

- df7a489: De-duplicate the GitHub reconcile pass across the two facades, and make every Node
  periodic sweep non-overlapping through a single seam.

  **Reconcile hoist (audit item 4).** `reconcileStaleRepos` and its two gone-installation
  classifiers were duplicated verbatim between the Worker's `sync-consumer.ts` and the Node
  `githubReconcile.ts` (the Node copy's own comment said "Mirrors the Worker's classification"),
  with no shared test — so a change to one would silently diverge (one runtime stops tombstoning
  dead installations while the other keeps working). The pass now lives once in
  `@cat-factory/server` (`reconcileStaleRepos` + `GitHubReconcileDeps`), and each facade supplies
  only its per-repo driver: the Worker enqueues on `GITHUB_SYNC_QUEUE` (or direct-syncs when
  unbound), Node direct-syncs inline. The classifiers moved verbatim (their regex→structured-code
  conversion is tracked separately as error-message-coverage I7). The 30-minute staleness window
  is now the shared exported `GITHUB_RECONCILE_STALE_MS` (previously defined independently per
  facade), and all reconcile logs — the per-repo lines AND the Worker's cron summary — now use a
  single `sweep: 'github-reconcile'` field on both facades. The Worker's queue-less direct-sync
  fallback also builds its DI container once per pass instead of once per stale repo.

  **Non-overlapping Node sweepers (audit item 6).** The DB-heavy `initiativeLoop`, `recurring`,
  and notification-escalation sweeps ran unguarded `setInterval` timers, so a pass that outlasted
  its interval could be stacked — and two concurrent `runDue` passes could both observe "no active
  run" and double-spawn. All eight Node sweeps (kaizen, github-reconcile, initiative loop,
  recurring, notification escalation, environment TTL, and both retention sweeps) now go through
  one `startSweeper` helper built on `toad-scheduler`: `preventOverrun` is the non-overlap guard,
  `runImmediately` the run-once-first behaviour, and the `AsyncTask` error handler the best-effort
  logging (each sweep names its task, so scheduler-surfaced errors identify their sweep), and
  `unref` keeps the sweep timers from holding the process alive — the same contract as the
  hand-rolled `setInterval(...).unref()` timers this replaced. A new sweeper physically cannot
  forget the guard. Adds a `toad-scheduler` (^4.1.0) dependency to `@cat-factory/node-server`.

- Updated dependencies [df7a489]
  - @cat-factory/server@0.111.0
  - @cat-factory/node-server@0.92.8
  - @cat-factory/executor-harness@1.43.0

## 0.64.24

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1
  - @cat-factory/server@0.110.5
  - @cat-factory/gitlab@0.7.57
  - @cat-factory/orchestration@0.105.6
  - @cat-factory/agents@0.53.6
  - @cat-factory/integrations@0.81.5
  - @cat-factory/node-server@0.92.7
  - @cat-factory/executor-harness@1.43.0

## 0.64.23

### Patch Changes

- f4482c7: Reclaim a deleted board's binary artifacts (screenshots + reference images) — BOTH the
  metadata rows AND the heavy blob bytes — so they no longer leak forever.

  The artifact retention sweeps only ever iterate LIVE workspaces (`listVisible`), and
  `binary_artifacts` is deliberately excluded from the SQL workspace-delete cascade (dropping
  the metadata row without the bytes would strand the blob in object storage forever — the row
  is the only handle on its key). So before this change, deleting a board orphaned both the
  metadata rows and their backing R2 / S3 / filesystem bytes with nothing to reclaim them —
  unbounded object-storage cost with no surfacing.

  `BinaryArtifactStore` gains `deleteByWorkspace(workspaceId)` (backed by new
  `listByWorkspace` / `deleteByWorkspace` metadata-store methods, mirrored D1 ⇄ Drizzle),
  reusing the same fail-safe blobs-first-then-rows ordering as `pruneOlderThan`: a blob whose
  delete throws keeps its metadata row so a later retry can still reach the bytes rather than
  orphaning them. `WorkspaceService.delete` now purges through this port (best-effort — a
  storage outage can't wedge the board delete) before the row cascade runs. The cross-runtime
  binary-artifact conformance suite asserts the reclaim removes every artifact's rows + bytes,
  scoped to the workspace, on both D1 and Postgres. (system-audit-improvements initiative,
  item 3.)

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0
  - @cat-factory/server@0.110.4
  - @cat-factory/node-server@0.92.6
  - @cat-factory/agents@0.53.5
  - @cat-factory/gitlab@0.7.56
  - @cat-factory/integrations@0.81.4
  - @cat-factory/orchestration@0.105.5
  - @cat-factory/executor-harness@1.43.0

## 0.64.22

### Patch Changes

- Updated dependencies [cc6d554]
  - @cat-factory/agents@0.53.4
  - @cat-factory/server@0.110.3
  - @cat-factory/orchestration@0.105.4
  - @cat-factory/node-server@0.92.5
  - @cat-factory/executor-harness@1.43.0

## 0.64.21

### Patch Changes

- 22a4d9e: Complete the workspace-delete cascade so a board delete no longer orphans rows forever.
  Both facades' `WorkspaceRepository.delete` previously cleared only ~7 tables
  (blocks/pipelines/agent_runs/environments/services/mounts), leaving every other
  workspace-scoped table (`notifications`, `requirement_reviews`, the review / session /
  settings / connection / preset tables, the GitHub projection, …) permanently orphaned on
  a normal board delete — invisible today, unbounded cost tomorrow.

  The cascade is now driven by a single shared kernel list, `WORKSPACE_SCOPED_TABLES`, that
  both the D1 (Cloudflare) and Drizzle (Node/local) facades iterate, so the two runtimes
  cannot drift and a newly-added workspace-scoped table can't silently miss the cascade.
  Per-facade static completeness guards make a new table impossible to forget: the Node guard
  introspects the Drizzle/Postgres schema and the Worker guard introspects the real migrated
  D1, each failing if any `workspace_id` table is neither listed nor explicitly acknowledged
  as a special case (the D1 guard also covers the Cloudflare-only `live_containers` table the
  Drizzle schema can't see). A cross-runtime conformance assertion proves a deleted board
  leaves no rows behind on both D1 and Postgres.

  Deliberately out of scope (unchanged): `binary_artifacts` (its blob bytes must be reclaimed
  through the `BinaryBlobBackend` port at the service layer — a follow-up slice), the
  bespoke `services` / mount re-home handling, and the isolated `telemetry` / `sandbox` /
  `provisioning` schemas (separate stores reclaimed by their own retention sweeps; telemetry
  is a physically separate D1 database on the Worker). (system-audit-improvements initiative,
  item 2.)

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0
  - @cat-factory/node-server@0.92.4
  - @cat-factory/agents@0.53.3
  - @cat-factory/gitlab@0.7.55
  - @cat-factory/integrations@0.81.3
  - @cat-factory/orchestration@0.105.3
  - @cat-factory/server@0.110.2
  - @cat-factory/executor-harness@1.43.0

## 0.64.20

### Patch Changes

- dbfe2e8: Boot-time structured warnings for three previously-silent misconfigurations (error-message
  coverage initiative, items A5/A9/A10). Each is a single greppable WARN naming the offending
  var, its consequence, and a doc link — behaviour is unchanged (the conditions were, and stay,
  non-fatal); they were just invisible until the first dispatch failed.

  - **A5** — the Node facade's container agent executor is disabled when a prerequisite is
    missing (`PUBLIC_URL`, `AUTH_SESSION_SECRET`, a runner backend, or a GitHub token source),
    but the service still boots "healthy" and repo-operating steps (coder/mocker/tester/merger/…)
    failed only at dispatch, deep in a request. It now logs at boot exactly which prerequisite is
    missing, so the gap is visible up front (the Worker already throws a `configProblem` here).
  - **A9** — an unrecognised `LOCAL_CONTAINER_RUNTIME` value silently fell back to `docker`; the
    local preflight now names the rejected value, the accepted set
    (`docker`/`podman`/`orbstack`/`colima`/`apple`), and the fallback taken.
  - **A10** — a half-set `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` pair silently disabled
    Cloudflare Workers AI (over REST) on the Node facade; config load now names which half is set
    and which is missing.

  Adds a `localMode` section anchor to `@cat-factory/server`'s `ENV_VARS_ANCHORS` so the A9
  warning deep-links the local-mode env-var docs.

- Updated dependencies [dbfe2e8]
  - @cat-factory/server@0.110.1
  - @cat-factory/node-server@0.92.3
  - @cat-factory/executor-harness@1.43.0

## 0.64.19

### Patch Changes

- 8d65179: Boot-time configuration validation for three previously-opaque failures (error-message
  coverage initiative, items A2/A4/A6):

  - **A2** — the system `ENCRYPTION_KEY` is now validated at config load on every facade
    (present, valid base64, decoding to a full AES-256 key) via a shared
    `requireEncryptionKey` helper in `@cat-factory/server`, wired into the Node and Worker
    config loaders and reused by local mode. A malformed key fails with an actionable,
    doc-linked message on the misconfigured screen instead of lazily deep inside the first
    cipher build (a bare "must decode to at least 32 bytes" or an opaque `atob` error).
  - **A4** — the Cloudflare Worker's primary `DB` binding is guarded by `requireDb` at
    container build, mirroring `requireTelemetryDb`, so an unbound/misnamed binding fails
    fast with a `[[d1_databases]]` remedy rather than NPE-ing deep in the first repository
    call.
  - **A6** — an invalid `DB_SCHEMA` / `DB_MIGRATIONS_SCHEMA` on the Node facade now throws a
    `ConfigValidationError`, so it reaches the "backend misconfigured" fallback screen
    instead of hard-crashing the process with an opaque message.

- a5dcf7d: Prune resolved notifications on the retention sweep. The `notifications` table was
  never pruned on either facade (upsert/escalate only, no delete), so resolved
  (acted/dismissed) cards accumulated without bound on a table read on the snapshot hot
  path. A new `NotificationRepository.deleteResolvedOlderThan(cutoff)` port method
  (mirrored D1 ⇄ Drizzle) is wired into both facades' retention sweeps under a new
  `RetentionConfig.notificationsMs` window (`NOTIFICATION_RETENTION_DAYS`, default 90
  days). Only terminal rows past the window are deleted — `open` cards (the actionable
  inbox) are never touched. Covered by a new cross-runtime notification conformance
  suite. (system-audit-improvements initiative, item 1.)
- Updated dependencies [8d65179]
- Updated dependencies [a5dcf7d]
  - @cat-factory/server@0.110.0
  - @cat-factory/node-server@0.92.2
  - @cat-factory/kernel@0.119.0
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/agents@0.53.2
  - @cat-factory/gitlab@0.7.54
  - @cat-factory/integrations@0.81.2
  - @cat-factory/orchestration@0.105.2

## 0.64.18

### Patch Changes

- 5072999: Boot-time configuration problems now carry a documentation link. Each `ENV_HELP`
  entry embeds a stable in-repo doc URL (built through a new centralized `DOCS`
  helper in `@cat-factory/server`), the operator log appends a `Docs:` line, and the
  "backend misconfigured" screen renders a "View documentation" link per problem.
  This establishes the doc-URL convention for the error-message coverage initiative
  (item A1).
- Updated dependencies [5072999]
  - @cat-factory/contracts@0.126.0
  - @cat-factory/server@0.109.0
  - @cat-factory/node-server@0.92.1
  - @cat-factory/agents@0.53.1
  - @cat-factory/gitlab@0.7.53
  - @cat-factory/integrations@0.81.1
  - @cat-factory/kernel@0.118.1
  - @cat-factory/orchestration@0.105.1
  - @cat-factory/executor-harness@1.43.0

## 0.64.17

### Patch Changes

- Updated dependencies [25ac984]
  - @cat-factory/node-server@0.92.0

## 0.64.16

### Patch Changes

- 2eb0cfd: Make database migrations fail safe and recover cleanly.

  Motivated by a `0.63 → 0.64` upgrade that bricked boot: a database whose drizzle-kit 1.0
  migration ledger (in its own `drizzle` schema) had outlived its `public` tables — the classic
  ledger↔schema split left by a hand `DROP SCHEMA public CASCADE` — hit a bare
  `42P01 relation "accounts" does not exist` deep inside the new FK migration, with no
  remediation path.

  - **Boot drift-guard + wrapped errors (Node).** `migrate()` now probes for the ledger↔schema
    split up front (ledger non-empty but anchor tables `public.accounts`/`public.workspaces`
    missing) and throws a clear `DbSchemaInconsistentError`, and wraps any apply failure in a
    `MigrationFailedError` mapping the pg code (`42P01`/`23503`/`42P07`) to a human cause + the
    recovery command. Boot runs `migrate()` before `boss.start()` (no longer racing them in a
    `Promise.all`) so the migration error is the clean top-level rejection.
  - **`db:reset` recovery command (Node).** `pnpm --filter @cat-factory/node-server db:reset`
    drops all app-owned schemas together — the app schema, `telemetry`, `sandbox`,
    `provisioning`, the migration ledger, and pg-boss's queue schema — so the ledger can never
    outlive the data. This is the sanctioned recovery; never hand-drop `public` alone (that is
    what causes the split). **DESTRUCTIVE** — it deletes all data in `DATABASE_URL`.
  - **Configurable schemas for a shared database (Node).** New optional env vars, all defaulting
    to the prior behaviour: `DB_SCHEMA` relocates the default (`public`) app tables via the
    connection `search_path` (for databases with no usable `public`); `DB_MIGRATIONS_SCHEMA` moves
    the drizzle migration ledger off the top-level `drizzle` schema so it can't collide with
    another drizzle-using service's `drizzle.__drizzle_migrations`; `DB_PGBOSS_SCHEMA` moves
    pg-boss's queue schema. `db:reset` honours the same vars. The named app schemas
    (`telemetry`/`sandbox`/`provisioning`) remain fixed.
  - **Self-healing FK migrations (both runtimes).** The `ON DELETE RESTRICT` FK migrations now
    delete/NULL pre-existing orphans before `ADD CONSTRAINT`, so a database old enough to predate
    the FKs migrates instead of hard-failing on `23503`. Applied symmetrically to the Postgres
    `20260709061125_old_santa_claus` migration and the D1
    `0046_user_identity_foreign_keys.sql` rebuild. **Breaking:** editing these already-shipped
    migrations changes their content; a database that already applied the originals should recover
    via `db:reset` (only experimental installs exist pre-1.0). Orphaned rows are deleted — losing
    that stale data is acceptable (backwards compatibility is a non-goal).
  - **Test-pollution hardening.** The Node/local/mothership test harnesses now require a
    per-vitest-worker database (they refuse to run against the base `DATABASE_URL`) and use the
    `postgres` maintenance database for the admin `CREATE DATABASE` connection, so running the
    suite can never pollute or desync a developer's dev database.

- Updated dependencies [2eb0cfd]
  - @cat-factory/node-server@0.91.1

## 0.64.15

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/contracts@0.125.0
  - @cat-factory/kernel@0.118.0
  - @cat-factory/agents@0.53.0
  - @cat-factory/orchestration@0.105.0
  - @cat-factory/integrations@0.81.0
  - @cat-factory/server@0.108.0
  - @cat-factory/node-server@0.91.0
  - @cat-factory/gitlab@0.7.52
  - @cat-factory/executor-harness@1.43.0

## 0.64.14

### Patch Changes

- Updated dependencies [4b8fc5f]
  - @cat-factory/executor-harness@1.43.0
  - @cat-factory/server@0.107.10
  - @cat-factory/node-server@0.90.11

## 0.64.13

### Patch Changes

- Updated dependencies [e254ef5]
  - @cat-factory/orchestration@0.104.1
  - @cat-factory/server@0.107.9
  - @cat-factory/node-server@0.90.10
  - @cat-factory/executor-harness@1.41.0

## 0.64.12

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/orchestration@0.104.0
  - @cat-factory/contracts@0.124.1
  - @cat-factory/kernel@0.117.6
  - @cat-factory/server@0.107.8
  - @cat-factory/node-server@0.90.9
  - @cat-factory/agents@0.52.9
  - @cat-factory/gitlab@0.7.51
  - @cat-factory/integrations@0.80.6
  - @cat-factory/executor-harness@1.41.0

## 0.64.11

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5
  - @cat-factory/server@0.107.7
  - @cat-factory/orchestration@0.103.1
  - @cat-factory/node-server@0.90.8
  - @cat-factory/agents@0.52.8
  - @cat-factory/gitlab@0.7.50
  - @cat-factory/integrations@0.80.5
  - @cat-factory/executor-harness@1.41.0

## 0.64.10

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/contracts@0.124.0
  - @cat-factory/orchestration@0.103.0
  - @cat-factory/kernel@0.117.4
  - @cat-factory/server@0.107.6
  - @cat-factory/node-server@0.90.7
  - @cat-factory/agents@0.52.7
  - @cat-factory/gitlab@0.7.49
  - @cat-factory/integrations@0.80.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.9

### Patch Changes

- Updated dependencies [87f835a]
  - @cat-factory/server@0.107.5
  - @cat-factory/node-server@0.90.6
  - @cat-factory/executor-harness@1.41.0

## 0.64.8

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3
  - @cat-factory/orchestration@0.102.8
  - @cat-factory/server@0.107.4
  - @cat-factory/node-server@0.90.5
  - @cat-factory/agents@0.52.6
  - @cat-factory/gitlab@0.7.48
  - @cat-factory/integrations@0.80.3
  - @cat-factory/executor-harness@1.41.0

## 0.64.7

### Patch Changes

- Updated dependencies [a650396]
  - @cat-factory/orchestration@0.102.7
  - @cat-factory/server@0.107.3
  - @cat-factory/node-server@0.90.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.6

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2
  - @cat-factory/contracts@0.123.1
  - @cat-factory/orchestration@0.102.6
  - @cat-factory/server@0.107.2
  - @cat-factory/node-server@0.90.3
  - @cat-factory/agents@0.52.5
  - @cat-factory/gitlab@0.7.47
  - @cat-factory/integrations@0.80.2
  - @cat-factory/executor-harness@1.41.0

## 0.64.5

### Patch Changes

- cb7fd14: Validate the personal-subscription password cache against an 8h expiry buffer on every
  gated action (start / confirm / retry), so the user is prompted to re-enter early — while
  they are present at the action — instead of the key lapsing mid-pipeline and surfacing as a
  broken run that asks for a retry.

  - Frontend (`@cat-factory/app`): a cached key with under 8h of runway left is withheld on
    the first attempt of a gated action, so the server's existing `428 credential_required`
    gate re-challenges and the modal refreshes the full window. The mid-run confirm actions
    (resolve decision / approve step / request changes / resolve-exceeded) now flow through
    the same `withCredential` prompt path as start/retry.
  - Backend (`@cat-factory/server`): **behavior change** — the run-interaction endpoints
    (resolve decision / approve / request changes / resolve-exceeded) now hard-gate for
    individual-usage runs (mint a fresh activation via `personalGateForRun`, 428 when the
    password is needed but absent/withheld) instead of a silent best-effort re-mint, so an
    early re-entry can be surfaced mid-run. The `remintActivations` helper is removed.
  - `@cat-factory/integrations`: removed the now-unused `PersonalSubscriptionService.refreshActivations`.
  - `@cat-factory/kernel` + the runtime facades (`@cat-factory/worker`, `@cat-factory/node-server`,
    `@cat-factory/local-server`): dropped the now-dead `SubscriptionActivationRepository.refresh`
    port method and its D1 / Drizzle / SQLite implementations — its only caller
    (`refreshActivations`) is gone, so activations are now only ever minted at full TTL via
    `activateForRun`, never TTL-extended in place.

- Updated dependencies [cb7fd14]
  - @cat-factory/server@0.107.1
  - @cat-factory/integrations@0.80.1
  - @cat-factory/kernel@0.117.1
  - @cat-factory/node-server@0.90.2
  - @cat-factory/executor-harness@1.41.0
  - @cat-factory/orchestration@0.102.5
  - @cat-factory/agents@0.52.4
  - @cat-factory/gitlab@0.7.46

## 0.64.4

### Patch Changes

- Updated dependencies [c5d8fa1]
  - @cat-factory/node-server@0.90.1

## 0.64.3

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0
  - @cat-factory/integrations@0.80.0
  - @cat-factory/server@0.107.0
  - @cat-factory/node-server@0.90.0
  - @cat-factory/agents@0.52.3
  - @cat-factory/gitlab@0.7.45
  - @cat-factory/orchestration@0.102.4
  - @cat-factory/executor-harness@1.41.0

## 0.64.2

### Patch Changes

- Updated dependencies [51869b8]
- Updated dependencies [2924e32]
  - @cat-factory/kernel@0.116.0
  - @cat-factory/orchestration@0.102.3
  - @cat-factory/agents@0.52.2
  - @cat-factory/gitlab@0.7.44
  - @cat-factory/integrations@0.79.3
  - @cat-factory/server@0.106.3
  - @cat-factory/node-server@0.89.3
  - @cat-factory/executor-harness@1.41.0

## 0.64.1

### Patch Changes

- Updated dependencies [ddb0b68]
  - @cat-factory/node-server@0.89.2
  - @cat-factory/orchestration@0.102.2
  - @cat-factory/server@0.106.2
  - @cat-factory/executor-harness@1.41.0

## 0.64.0

### Minor Changes

- 57979b0: feat(local): fail loudly when the executor harness version doesn't match the backend

  Add a version handshake so a stale or mismatched executor is surfaced clearly and early
  instead of as a cryptic downstream error (the class of bug where a since-removed git flag
  reappears in an old image and breaks every authenticated clone/push with `fatal: unable to
get password from user`).

  - The harness now self-reports its version on `/health` (baked into the image as a file next
    to `dist/`, since the image ships no `package.json`; read from `package.json` in native/npm
    installs).
  - Both local runner transports (per-run/pooled container and native host process) verify the
    running harness against the version this backend build is matched to
    (`RECOMMENDED_HARNESS_IMAGE`) as soon as it becomes healthy. A mismatch — or a harness too
    old to report a version at all — fails the dispatch with an actionable message (re-pull the
    image / update the package). A custom override (`LOCAL_HARNESS_IMAGE` / `LOCAL_HARNESS_ENTRY`)
    downgrades the mismatch to a warning, mirroring the boot-time custom-image notice.

  Bumps the executor-harness image tag (harness `src/**` + `Dockerfile` changed) and the local
  mode pin to `cat-factory-executor:1.40.0`.

### Patch Changes

- Updated dependencies [a51a498]
- Updated dependencies [57979b0]
  - @cat-factory/orchestration@0.102.1
  - @cat-factory/kernel@0.115.1
  - @cat-factory/node-server@0.89.1
  - @cat-factory/executor-harness@1.41.0
  - @cat-factory/server@0.106.1
  - @cat-factory/agents@0.52.1
  - @cat-factory/gitlab@0.7.43
  - @cat-factory/integrations@0.79.2

## 0.63.0

### Minor Changes

- b83bcc8: Requirements review UX + per-task risk policy rename + document default pipeline.

  **Requirements review — per-finding recommendation guidance & inline recommendations.** Each
  finding now has an explicit 3-way selector (Answer / Dismiss / Recommend) in place of the old
  button row. Typing an answer marks the finding "You answered"; choosing **Recommend** carries
  whatever you typed over as **per-finding guidance** that steers the Requirement Writer's
  suggestion (shown on-screen as guidance, not saved as the answer). Recommendations now render
  **inline inside their source finding card** — generating spinner, the ready suggestion with
  accept/reject/re-request — instead of a separate section below. The request-recommendations wire
  contract changes from `{ itemIds, note }` to `{ items: [{ itemId, note? }] }` so each finding in a
  batch can steer the Writer differently.

  **Auto-recommendation on every round.** Auto-recommendation now also runs after an off-path
  re-review (not only the pipeline-driven incorporation cycle), so every iteration round that
  introduces new questions gets its auto-answerable findings pre-answered.

  **"Merge threshold preset" renamed to "Risk policy".** The per-task/per-workspace preset governs
  merge ceilings, CI-fixer attempts, requirement/tester iteration caps and release-health watch — a
  broader risk-management surface than "merge". It is renamed to **Risk policy** across the wire
  contracts, kernel/domain types, services, HTTP routes (`/workspaces/:ws/merge-presets` →
  `/risk-policies`), repositories, and the SPA (store/util/panel/i18n). `Block.mergePresetId` →
  `Block.riskPolicyId`. Iteration caps stay on the policy (per your risk-management model) — no
  functional change. The physical DB table/column names are retained internally (mapped to the new
  domain names), so there is no data migration.

  **Document tasks default to the document pipeline.** A `taskType: 'document'` task now defaults to
  the document-authoring pipeline (`pl_document`) instead of the full-build pipeline, which produces
  no code and needs no spec/tests. Overridable per task as before.

### Patch Changes

- a0c6934: Token-usage tracking for BOTH metered API traffic and flat-rate subscription harnesses
  (usage-and-quota-tracking initiative, Part A). The `token_usage` spend ledger gains a
  `billing` discriminator (`metered` | `subscription`) + `vendor` column, and subscription
  harness usage (Claude Code / Codex / GLM / pooled Kimi & DeepSeek) — previously kept out of
  the ledger entirely — is now recorded durably for reporting. The budget gate is unchanged:
  every spend rollup (`status` / `isOverBudget` / the account & user tiers) filters
  `billing = 'metered'`, so a flat-rate quota call is counted for the usage report but never
  inflates spend or trips a budget.

  New `GET /workspaces/:ws/usage` returns the current period's usage broken down by
  `(billing, vendor, provider, model)`, surfaced in a new "Usage" tab in Workspace Settings
  (both metered and subscription usage, with per-model progress bars). Subscription cost is
  illustrative (the equivalent metered-API cost), never billed.

  D1 migration `0044_usage_billing.sql` ⇄ the Drizzle schema + generated migration; the
  cross-runtime conformance suite pins the metered-vs-subscription split on both stores. No
  data migration — existing rows default to `metered`.

  (The `@cat-factory/executor-harness` bump is a test-only type fix — its fake
  `TokenUsageRepository` gains the new `usageBreakdownForWorkspace` method; nothing in the
  runner image changed.)

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/contracts@0.123.0
  - @cat-factory/kernel@0.115.0
  - @cat-factory/agents@0.52.0
  - @cat-factory/orchestration@0.102.0
  - @cat-factory/server@0.106.0
  - @cat-factory/node-server@0.89.0
  - @cat-factory/executor-harness@1.39.3
  - @cat-factory/gitlab@0.7.42
  - @cat-factory/integrations@0.79.1

## 0.62.0

### Minor Changes

- 0f3c88b: feat(testing): sealed sensitive test credentials, delivered to the Tester out of band

  Add a SEALED per-service store for sensitive testing credentials (e.g. a third-party API
  token a Tester needs), the sibling of the non-sensitive test-credential pools. Values are
  encrypted at rest by the facade `SecretCipher` (info tag `cat-factory:test-secrets`, mirroring
  `observability_connections`) and delivered to the Tester container **out of band**: decrypted at
  dispatch, carried on a dedicated job-body field the agent-context snapshot allow-list omits, and
  injected by the harness as container environment variables the agent reads (`$KEY`). The tester
  prompt advertises only each secret's key + description (never the value). Per service frame,
  resolved up the frame chain like release-health config; mirrored across both runtimes (D1 +
  Drizzle) with a cross-runtime conformance assertion.

  New API: `GET|PUT|DELETE /workspaces/:ws/services/:blockId/test-secrets` (values write-only).

  This is Slice C of the tester-environment-access initiative; the Test Data Seeder agent
  (Slice D) is a tracked follow-up. See docs/initiatives/tester-environment-access.md.

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/contracts@0.122.0
  - @cat-factory/kernel@0.114.0
  - @cat-factory/agents@0.51.0
  - @cat-factory/integrations@0.79.0
  - @cat-factory/orchestration@0.101.0
  - @cat-factory/server@0.105.0
  - @cat-factory/node-server@0.88.0
  - @cat-factory/executor-harness@1.39.2
  - @cat-factory/gitlab@0.7.41

## 0.61.10

### Patch Changes

- ed77be6: Initiative-preset registry → app-owned DI (slice 5 of the custom-initiative-definitions
  initiative; registry-DI-migration "Initiative presets" row). The module-global initiative-preset
  registry is replaced by an app-owned `InitiativePresetRegistry` instance the composition root news,
  threads through `CoreDependencies`, and re-exposes on `Core` — mirroring the agent-kind registry.
  This removes the shared process state and the external-adapter module-identity gotcha: a deployment
  registers its own presets by reference on the instance the facade injects.

  BREAKING: the free `@cat-factory/kernel` exports `registerInitiativePreset`,
  `registerInitiativePresets`, `getInitiativePreset`, `allInitiativePresets`,
  `initiativePresetDescriptors`, and `clearRegisteredInitiativePresets` are removed. Use the new
  `InitiativePresetRegistry` class (kernel) + `defaultInitiativePresetRegistry()` factory
  (`@cat-factory/agents`, preloads the built-in generic / docs-refresh / tech-migration presets)
  instead, and inject it via the facade's composition seam — `createApp({ overrides: {
initiativePresetRegistry } })` on the Worker, or the `initiativePresetRegistry` option on `start()`
  / `startLocal()`. `registerDocsRefreshPreset` / `registerTechMigrationPreset` now take the registry
  as a parameter (no bottom-of-module self-registration). No data migration — pre-1.0, no back-compat.

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0
  - @cat-factory/agents@0.50.0
  - @cat-factory/orchestration@0.100.2
  - @cat-factory/server@0.104.2
  - @cat-factory/node-server@0.87.10
  - @cat-factory/contracts@0.121.2
  - @cat-factory/gitlab@0.7.40
  - @cat-factory/integrations@0.78.8
  - @cat-factory/executor-harness@1.39.0

## 0.61.9

### Patch Changes

- 7ee2530: Internal cleanup: prune dead/needless exports flagged by knip (no runtime behaviour
  change). ~110 findings resolved — genuinely-dead symbols deleted (e.g. the unused
  `ENVIRONMENT_ANALYSIS_PIPELINE_ID` / `INITIATIVE_BREAKDOWN_PIPELINE_ID` pipeline-id
  constants, `isCiStatusProviderWired`, `parseApiKeyProvider`, unused re-export members of
  the runtime facade barrels), and the `export` keyword dropped from symbols only used
  inside their own module (repository classes, config constants, helper types). Also tidied
  stale `knip.jsonc` baseline entries (removed no-longer-needed `ignore` / `ignoreDependencies`
  and dead entry-glob patterns).

  The residual knip warnings are now all DELIBERATE: the neutral `VcsClient` port type
  re-export barrel, the Worker config-type barrel, the `providerEndpoints` base-URL group,
  and a couple of types that must stay exported for declaration emit. Since backwards
  compatibility is a non-goal pre-1.0, the removed exports (which nothing imported) are
  dropped outright rather than deprecated.

- Updated dependencies [7ee2530]
  - @cat-factory/agents@0.49.3
  - @cat-factory/integrations@0.78.7
  - @cat-factory/kernel@0.112.1
  - @cat-factory/orchestration@0.100.1
  - @cat-factory/server@0.104.1
  - @cat-factory/node-server@0.87.9
  - @cat-factory/gitlab@0.7.39
  - @cat-factory/executor-harness@1.39.0

## 0.61.8

### Patch Changes

- f25d5e2: Complete the two deferred service-connections Phase 4 multi-repo follow-ups.

  **Conflict-resolver peer targeting.** The `conflicts` gate now ESCALATES a conflict on a
  connected involved service's PEER repo (previously it declined escalation and fast-failed the run
  to a manual give-up). The gate still tags which repo conflicted (`conflictTarget`); the engine
  threads that onto the dispatched `conflict-resolver`'s context, and the container executor points
  the (single-repo) resolver at THAT peer repo — resolving its target, cloning its PR (work) branch,
  and merging the peer's base in — instead of always the task's own service. An own-repo conflict is
  unchanged (no `frameId` ⇒ the own service is the implicit target). Handles the peer-only case (own
  service unchanged, so no own PR) by pinning the resolve branch to the shared work branch.

  **Merger combined-diff.** The `merger` now scores the COMBINED cross-repo change on a multi-repo
  task instead of only the own-repo diff. Driven by the PRs that actually exist
  (`block.peerPullRequests`), it clones each peer PR's repo as a read-only sibling checkout at its PR
  branch (full history) alongside the own service, and a "Multi-repo pull request" prompt section
  plus the reworked merger prompts instruct it to diff each repo against its base and return ONE
  blended complexity/risk/impact assessment covering the whole change. The read-only multi-repo
  explore harness path gained per-peer `cloneBranch` selection and honours the job's `full` flag (a
  new container capability — the executor-harness image is bumped), so the bug-investigator's
  base-branch fan-out is unchanged while the merger checks each peer out at its PR head.

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0
  - @cat-factory/orchestration@0.100.0
  - @cat-factory/server@0.104.0
  - @cat-factory/executor-harness@1.39.0
  - @cat-factory/agents@0.49.2
  - @cat-factory/gitlab@0.7.38
  - @cat-factory/integrations@0.78.6
  - @cat-factory/node-server@0.87.8

## 0.61.7

### Patch Changes

- Updated dependencies [9aa9e19]
  - @cat-factory/contracts@0.121.1
  - @cat-factory/orchestration@0.99.1
  - @cat-factory/agents@0.49.1
  - @cat-factory/gitlab@0.7.37
  - @cat-factory/integrations@0.78.5
  - @cat-factory/kernel@0.111.1
  - @cat-factory/server@0.103.1
  - @cat-factory/node-server@0.87.7
  - @cat-factory/executor-harness@1.37.2

## 0.61.6

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0
  - @cat-factory/agents@0.49.0
  - @cat-factory/server@0.103.0
  - @cat-factory/orchestration@0.99.0
  - @cat-factory/contracts@0.121.0
  - @cat-factory/gitlab@0.7.36
  - @cat-factory/integrations@0.78.4
  - @cat-factory/node-server@0.87.6
  - @cat-factory/executor-harness@1.37.2

## 0.61.5

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/orchestration@0.98.1
  - @cat-factory/agents@0.48.5
  - @cat-factory/server@0.102.1
  - @cat-factory/kernel@0.110.1
  - @cat-factory/node-server@0.87.5
  - @cat-factory/executor-harness@1.37.2
  - @cat-factory/gitlab@0.7.35
  - @cat-factory/integrations@0.78.3

## 0.61.4

### Patch Changes

- 090ca89: Local mode now advertises the `cat-factory env` CLI when it fails to boot for a missing or invalid
  mandatory config value. The misconfiguration fallback (both the terminal log and the SPA's "backend
  misconfigured" screen) prepends a one-step remedy — `npx @cat-factory/cli env` generates a
  ready-to-run local-mode `.env` with every required value at once — above the per-variable remedies,
  so a developer can fix the whole file in one command instead of satisfying each secret/URL by hand.

  It covers every mandatory value: the three crypto secrets validated by `applyLocalDefaults`
  (`AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`, `HARNESS_SHARED_SECRET`) and `DATABASE_URL`, which is
  validated inside the reused Node boot. The Node facade's `start()` gains an optional
  `augmentConfigProblems` seam that layers the facade-specific advice onto the problems it catches
  itself; the hosted Node/Worker facades pass nothing, so their remedies are unchanged.

- Updated dependencies [090ca89]
  - @cat-factory/node-server@0.87.4

## 0.61.3

### Patch Changes

- Updated dependencies [a2db337]
- Updated dependencies [a2db337]
  - @cat-factory/orchestration@0.98.0
  - @cat-factory/agents@0.48.4
  - @cat-factory/contracts@0.120.0
  - @cat-factory/kernel@0.110.0
  - @cat-factory/server@0.102.0
  - @cat-factory/node-server@0.87.3
  - @cat-factory/gitlab@0.7.34
  - @cat-factory/integrations@0.78.2
  - @cat-factory/executor-harness@1.37.2

## 0.61.2

### Patch Changes

- Updated dependencies [35636d5]
- Updated dependencies [35636d5]
  - @cat-factory/node-server@0.87.2
  - @cat-factory/agents@0.48.3
  - @cat-factory/orchestration@0.97.2
  - @cat-factory/server@0.101.2
  - @cat-factory/executor-harness@1.37.2

## 0.61.1

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1
  - @cat-factory/node-server@0.87.1
  - @cat-factory/agents@0.48.2
  - @cat-factory/gitlab@0.7.33
  - @cat-factory/integrations@0.78.1
  - @cat-factory/orchestration@0.97.1
  - @cat-factory/server@0.101.1
  - @cat-factory/executor-harness@1.37.2

## 0.61.0

### Minor Changes

- 8728bf7: Capture per-run diagnostics on `agent_runs` for after-the-fact investigation. Each run now
  records a `diagnostics` object (riding in the run's `detail` JSON, like `notes`/`frontendBindings`)
  with the most recent container-step dispatch context — `agentKind`, resolved `model`, the `repo`
  (owner/name/baseBranch/provider), the **execution backend** (`local-native` vs `local-container`
  vs `runner-pool` vs `cloudflare-container` — the datum that distinguishes a native host-process run
  from a sandboxed container), and the control-plane host `platform`. The backend is reported by the
  runner transport (a new optional `RunnerTransport.backend` / `RunnerJobView.backend`, stamped by
  the shared job client; the native/container router stamps its per-job leg).

  Also preserves the harness's fine-grained failure `cause` (`git` / `api` / `no-usable-output` /
  `no-changes`) on the failure's machine-readable `reason` instead of collapsing it to the coarse
  `agent` kind — so a push/clone failure reads as `git`, not a generic agent error, without grepping
  the transcript. No schema migration (the diagnostics ride in the existing `detail` column; the
  cause rides on the existing `failure.reason`); mirrored across both runtimes with a cross-runtime
  conformance round-trip assertion.

- 7157908: Expose the seeded default model preset as a programmatic override on the deploy-app boot
  seams, so a deployment can change its out-of-the-box default without editing library code.

  - `start({ defaultModelPresetId })` (Node) and `startLocal({ defaultModelPresetId })` (local)
    now accept the catalog id of the built-in preset a fresh workspace is seeded with as its
    default; it is forwarded to `buildNodeContainer` / `buildLocalContainer` (both the Postgres
    and mothership local paths). The Worker already honours `defaultModelPresetId` via
    `createApp`'s / `buildContainer`'s `overrides`; that read is now explicit rather than
    relying on the trailing spread.
  - `MODEL_PRESET_SEED_IDS` and `DEFAULT_MODEL_PRESET_ID` are re-exported from all three facade
    packages, so a wrapper can name a preset (`.kimi` / `.glm` / `.claude`) without a direct
    `@cat-factory/kernel` import.

  Applied only at the first seed of a workspace, so a user's later manual default choice is
  always preserved. Facade defaults are unchanged (Node/Cloudflare → Kimi K2.7, local → Claude
  Opus 4.8). Documented in the `deploy/{node,local,backend}` READMEs.

- 7157908: Model presets now support reseeding, mirroring pipelines and merge presets, plus a new
  built-in "Claude Opus 4.8" preset (everything `claude-opus`).

  - Built-in model presets carry stable catalog ids (`mdp_kimi` / `mdp_glm` / `mdp_claude`)
    and a monotonic `version`. The workspace snapshot ships `modelPresetCatalogVersions`, and
    `POST /workspaces/:ws/model-presets/:id/reseed` restores a built-in to the current catalog
    (adopt an update, repair drift, or materialise a new built-in that appeared). The SPA gains
    a once-per-session "model preset updates" advisory (reseed / add) like the pipeline and
    merge-preset ones.
  - The seeded workspace DEFAULT preset is now a deployment fact: Cloudflare and Node default to
    Kimi K2.7 (Cloudflare-runnable on the bare baseline), local mode defaults to Claude Opus 4.8
    (local runs subscription models via the ambient CLI / a leased personal credential). The
    deployment default is applied only at first seed, so a user's later manual default choice is
    always preserved.

  Breaking (pre-1.0, no migration): model presets gain a nullable `version` column
  (D1 `0043_model_preset_versioning`; Drizzle migration). Workspaces seeded before this change
  hold the old index-based preset ids (`mdp-seed-0/1`); they are treated as custom presets, and
  the three stable built-ins are offered via the reseed advisory rather than migrated in place.

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
- Updated dependencies [7157908]
  - @cat-factory/contracts@0.119.0
  - @cat-factory/kernel@0.109.0
  - @cat-factory/server@0.101.0
  - @cat-factory/orchestration@0.97.0
  - @cat-factory/integrations@0.78.0
  - @cat-factory/node-server@0.87.0
  - @cat-factory/agents@0.48.1
  - @cat-factory/gitlab@0.7.32
  - @cat-factory/executor-harness@1.37.2

## 0.60.4

### Patch Changes

- 42b5e76: Fix authenticated git clone/push failing with `fatal: unable to get password from user`. The
  non-interactive-auth hardening added `-c credential.interactive=false` to every git invocation,
  but modern git (≥ 2.47 — the executor image and host git) honors `credential.interactive` and
  treats invoking `GIT_ASKPASS` as interactive, so it skipped the harness askpass entirely and
  never sent the PAT — breaking every authenticated push on both the native and container paths (a
  public base repo still clones anonymously, so it only surfaced at push, looking intermittent).
  The flag is removed; the emptied credential-helper list plus `GIT_TERMINAL_PROMPT=0` /
  `GCM_INTERACTIVE=never` already defeat the Git Credential Manager popup it was meant to guard
  against. Bumps the runner image (and the local-mode pin) to `cat-factory-executor:1.37.1`.
- Updated dependencies [42b5e76]
  - @cat-factory/executor-harness@1.37.2

## 0.60.3

### Patch Changes

- Updated dependencies [629cf90]
  - @cat-factory/node-server@0.86.8

## 0.60.2

### Patch Changes

- Updated dependencies [4775c40]
  - @cat-factory/agents@0.48.0
  - @cat-factory/orchestration@0.96.3
  - @cat-factory/server@0.100.2
  - @cat-factory/node-server@0.86.7
  - @cat-factory/executor-harness@1.37.0

## 0.60.1

### Patch Changes

- Updated dependencies [f97d5d3]
  - @cat-factory/agents@0.47.0
  - @cat-factory/orchestration@0.96.2
  - @cat-factory/server@0.100.1
  - @cat-factory/node-server@0.86.6
  - @cat-factory/executor-harness@1.37.0

## 0.60.0

### Minor Changes

- b3bd653: Make `HARNESS_SHARED_SECRET` a mandatory, stable local-mode secret and a required runner-transport parameter.

  Local mode previously let the runner transports mint a RANDOM `HARNESS_SHARED_SECRET` per process when the env var was unset. That value is the inbound-auth secret between the orchestrator and its agent containers, so after a restart, polls against a container still running from before the restart failed auth (not mapped to eviction) and the run flapped instead of re-attaching.

  Now:

  - `applyLocalDefaults` REQUIRES `HARNESS_SHARED_SECRET` (min 16 chars) and fails loudly at boot with a clear, actionable error when it is missing/blank/too-short, exactly like `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`.
  - `sharedSecret` is now a REQUIRED constructor argument on `LocalContainerRunnerTransport`, `LocalProcessRunnerTransport`, and `LocalPreviewTransport` — the random per-process fallback is gone. The `*FromEnv` factories read it via the new `requireHarnessSharedSecret(env)`.
  - `pnpm secrets` (deploy/local) now emits `HARNESS_SHARED_SECRET` alongside the other two, and `deploy/local/.env.example` documents it.

  BREAKING (local mode): a local deployment with no `HARNESS_SHARED_SECRET` set now fails at boot instead of running with an unstable per-process secret. Set a stable value (via `pnpm secrets`) before upgrading.

### Patch Changes

- cb088c7: Cap concurrent inline (non-container) LLM calls to a subscription/shared-pool vendor so a burst
  can't overwhelm it. A new `VendorConcurrencyLimiter` + `LimitedModelProvider` decorator
  (`@cat-factory/agents`) gates each resolved subscription-vendor model behind an in-process
  per-vendor semaphore, keyed by `subscriptionVendorForRef(ref)`. It is applied as the outermost
  resolver wrap in every facade via `wrapResolverWithLimiter` (`@cat-factory/server`), mirroring the
  existing `InstrumentedModelProvider` shape, so no inline call site changes. Both the buffered
  (`wrapGenerate`) and streaming (`wrapStream`) inline paths are gated — a stream holds its permit
  until it ends — and a queued call whose request is aborted releases its slot instead of
  head-of-line blocking. Only the five subscription vendors (`claude`/`codex`/`glm`/`kimi`/`deepseek`)
  are capped; API-key vendors and Cloudflare pass through untouched.

  Configured by `LLM_SUBSCRIPTION_MAX_CONCURRENCY` (default 3 per vendor; a
  `LLM_SUBSCRIPTION_MAX_CONCURRENCY_<VENDOR>` overrides that one vendor and always wins). Any value
  `<= 0` is uncapped, so setting the default to `0` uncaps every vendor that has no explicit
  per-vendor override (to turn the feature off entirely, leave the per-vendor overrides unset too).
  The limiter is
  in-process only — one per Node process (per container/tenant) or per Worker isolate, which is the
  scope of a single inline fan-out (a consensus panel, the requirements recommendation writer, a
  sandbox sweep). It bounds in-flight concurrency, not requests-per-minute, and does not coordinate
  across replicas/isolates; global rate-limiting stays out of scope. Because inline subscription
  refs are degraded to a pool/API-key provider before resolve on Node/Worker, the cap primarily
  bites in local mode (the prewarmed-container inline subscription backend keeps the ref) and is a
  wired pass-through elsewhere.

- Updated dependencies [cb088c7]
- Updated dependencies [b3bd653]
  - @cat-factory/agents@0.46.0
  - @cat-factory/server@0.100.0
  - @cat-factory/node-server@0.86.5
  - @cat-factory/orchestration@0.96.1
  - @cat-factory/executor-harness@1.37.0

## 0.59.4

### Patch Changes

- Updated dependencies [09a1c85]
  - @cat-factory/agents@0.45.0
  - @cat-factory/orchestration@0.96.0
  - @cat-factory/server@0.99.8
  - @cat-factory/node-server@0.86.4
  - @cat-factory/executor-harness@1.37.0

## 0.59.3

### Patch Changes

- Updated dependencies [785576b]
  - @cat-factory/agents@0.44.1
  - @cat-factory/orchestration@0.95.3
  - @cat-factory/server@0.99.7
  - @cat-factory/node-server@0.86.3
  - @cat-factory/executor-harness@1.37.0

## 0.59.2

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/agents@0.44.0
  - @cat-factory/kernel@0.108.0
  - @cat-factory/orchestration@0.95.2
  - @cat-factory/server@0.99.6
  - @cat-factory/node-server@0.86.2
  - @cat-factory/gitlab@0.7.31
  - @cat-factory/integrations@0.77.8
  - @cat-factory/executor-harness@1.37.0

## 0.59.1

### Patch Changes

- @cat-factory/agents@0.43.1
- @cat-factory/orchestration@0.95.1
- @cat-factory/server@0.99.5
- @cat-factory/node-server@0.86.1
- @cat-factory/executor-harness@1.37.0

## 0.59.0

### Minor Changes

- 44fafa4: Inline subscription LLM steps can now run inside a prewarmed local container on a leased
  subscription credential (initiative phase C2). The executor-harness gains a one-shot `inline`
  job kind that runs `claude -p` / `codex exec` with no checkout and returns the completion text +
  usage; the local `LocalContainerRunnerTransport` leases a warm pool member to serve it. The
  local inline resolver now selects the developer's host CLI when its binary is present (ambient,
  unmetered) and otherwise the container backend on a leased credential — personal per-run
  activation for an individual vendor (Claude/Codex/GLM), a pooled token otherwise (Kimi/DeepSeek).
  This lets a subscription-only preset run its inline reviewers/brainstorm/estimator even when the
  host has no `claude`/`codex` binary and in mothership mode, and extends inline coverage to the
  non-native claude-code vendors.

  Mechanics: `ModelScope` gains an `executionId` run dimension and `resolveScopedModelProvider`
  takes the full scope; the inline callers (the iterative reviewers, the doc/initiative
  interviewers, the tester quality companion, Kaizen, and the AI/consensus agent executors) thread
  the run's execution + initiator so the container backend can lease the right credential.
  `buildNodeContainer`'s `wrapModelProviderResolver` seam now receives the subscription lease
  closures. Bumps the executor-harness image tag (the harness `inline` kind is new image code).

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/executor-harness@1.37.0
  - @cat-factory/node-server@0.86.0
  - @cat-factory/orchestration@0.95.0
  - @cat-factory/kernel@0.107.0
  - @cat-factory/agents@0.43.0
  - @cat-factory/server@0.99.4
  - @cat-factory/gitlab@0.7.30
  - @cat-factory/integrations@0.77.7

## 0.58.3

### Patch Changes

- Updated dependencies [cd60892]
  - @cat-factory/orchestration@0.94.0
  - @cat-factory/server@0.99.3
  - @cat-factory/node-server@0.85.10
  - @cat-factory/executor-harness@1.35.0

## 0.58.2

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/agents@0.42.0
  - @cat-factory/kernel@0.106.0
  - @cat-factory/orchestration@0.93.1
  - @cat-factory/server@0.99.2
  - @cat-factory/node-server@0.85.9
  - @cat-factory/gitlab@0.7.29
  - @cat-factory/integrations@0.77.6
  - @cat-factory/executor-harness@1.35.0

## 0.58.1

### Patch Changes

- Updated dependencies [f7f9a9e]
  - @cat-factory/orchestration@0.93.0
  - @cat-factory/server@0.99.1
  - @cat-factory/node-server@0.85.8
  - @cat-factory/executor-harness@1.35.0

## 0.58.0

### Minor Changes

- e3cfd61: Run inline LLM steps on a subscription-only model by default in local and mothership mode.

  A preset that pins everything to a subscription-only model (e.g. `claude-opus`) used to be
  refused at pipeline start with `preset_unsatisfiable` unless you also enabled
  `LOCAL_NATIVE_AGENTS`, which runs whole container agents unsandboxed. The inline steps
  (requirements reviewer, brainstorm, task-estimator, inline document kinds) are one-shot text
  calls with no repo checkout or tools, so they now run on the developer's ambient `claude` /
  `codex` CLI by default, via a dedicated `LOCAL_NATIVE_INLINE` flag (default on) that is
  decoupled from the container-native opt-in. Set `LOCAL_NATIVE_INLINE=off` to disable, or list a
  subset (e.g. `claude-code`) to restrict which vendors are inline-eligible. Only the native
  vendors (`claude` / `codex`) are eligible; a non-native vendor reusing the `claude-code` harness
  (GLM / Kimi / DeepSeek) still degrades to a provider model for inline steps.

## 0.57.7

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/agents@0.41.0
  - @cat-factory/kernel@0.105.0
  - @cat-factory/integrations@0.77.5
  - @cat-factory/contracts@0.118.0
  - @cat-factory/orchestration@0.92.0
  - @cat-factory/server@0.99.0
  - @cat-factory/node-server@0.85.7
  - @cat-factory/gitlab@0.7.28
  - @cat-factory/executor-harness@1.35.0

## 0.57.6

### Patch Changes

- 8f7af8e: Make ephemeral-environment provisioning DETECTION more universal — so it adapts to repos that
  follow different conventions than the stack-recipes pilot (different names, paths, tech stack). The
  changes are additive in the sense that detection can only ever surface MORE — it never removes or
  changes an existing detection, and a repo with no monorepo service-container dirs resolves exactly
  as before. Note the one behavioural change below: the env-template scan now also looks one level into
  `services/*`/`apps/*`/`packages/*`, so a monorepo that keeps per-service templates there will now
  surface them as low-confidence, user-confirmed `recipe.envFiles` where it previously surfaced none.

  - **Injectable detection conventions (deployment config).** A deployment can extend the built-in
    compose file names/dirs, seed dirs, and env-template dirs via the `ENVIRONMENTS_DETECTION_CONVENTIONS`
    JSON env var, threaded additively (built-ins always win; canonical compose names stay
    highest-priority) through `CoreDependencies.detectionConventions` into BOTH the service-provisioning
    detector (`EnvironmentConnectionService`) and the shared-stack detector (`SharedStackService`). New
    `parseDetectionConventions` + `EnvironmentsConfig.detectionConventions` (`@cat-factory/server`,
    parsed by both facades) and the exported `DetectionConventions` type (`@cat-factory/integrations`).
  - **Env-template detection now scans one level into monorepo service-container dirs** (`services/*`,
    `apps/*`, `packages/*`), so a per-service `*-dist`/`.example` template outside the compose dir (the
    pilot's documented `services/app/` gap) is surfaced — still bounded by the existing read budget.
    This is on by default (not gated behind conventions), so any monorepo with a compose file AND
    per-service templates newly gets those as `recipe.envFiles`; they are low-confidence and confirmed
    in the wizard before anything is materialized.
  - **The environment setup wizard elevates the "run deep analysis" nudge** when a repo ships its own
    imperative bring-up CLI/Makefile the deterministic scan can't read (`@cat-factory/app`), pointing the
    user at the LLM analyst — the intended universality mechanism for stack-specific imperative steps.

- Updated dependencies [8f7af8e]
- Updated dependencies [8f7af8e]
  - @cat-factory/integrations@0.77.4
  - @cat-factory/server@0.98.3
  - @cat-factory/orchestration@0.91.1
  - @cat-factory/node-server@0.85.6
  - @cat-factory/executor-harness@1.35.0

## 0.57.5

### Patch Changes

- Updated dependencies [4a3e536]
  - @cat-factory/orchestration@0.91.0
  - @cat-factory/contracts@0.117.0
  - @cat-factory/server@0.98.2
  - @cat-factory/node-server@0.85.5
  - @cat-factory/agents@0.40.13
  - @cat-factory/gitlab@0.7.27
  - @cat-factory/integrations@0.77.3
  - @cat-factory/kernel@0.104.4
  - @cat-factory/executor-harness@1.35.0

## 0.57.4

### Patch Changes

- Updated dependencies [18a9cb5]
  - @cat-factory/contracts@0.116.1
  - @cat-factory/agents@0.40.12
  - @cat-factory/gitlab@0.7.26
  - @cat-factory/integrations@0.77.2
  - @cat-factory/kernel@0.104.3
  - @cat-factory/orchestration@0.90.1
  - @cat-factory/server@0.98.1
  - @cat-factory/node-server@0.85.4
  - @cat-factory/executor-harness@1.35.0

## 0.57.3

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/contracts@0.116.0
  - @cat-factory/orchestration@0.90.0
  - @cat-factory/server@0.98.0
  - @cat-factory/kernel@0.104.2
  - @cat-factory/agents@0.40.11
  - @cat-factory/gitlab@0.7.25
  - @cat-factory/integrations@0.77.1
  - @cat-factory/node-server@0.85.3
  - @cat-factory/executor-harness@1.35.0

## 0.57.2

### Patch Changes

- Updated dependencies [802fc05]
  - @cat-factory/orchestration@0.89.0
  - @cat-factory/integrations@0.77.0
  - @cat-factory/contracts@0.115.0
  - @cat-factory/server@0.97.2
  - @cat-factory/node-server@0.85.2
  - @cat-factory/agents@0.40.10
  - @cat-factory/gitlab@0.7.24
  - @cat-factory/kernel@0.104.1
  - @cat-factory/executor-harness@1.35.0

## 0.57.1

### Patch Changes

- a869ae9: Initiative presets — slice 2: the per-run gate-override engine seam.

  - **orchestration** (`ExecutionService.start`): a new optional `gatesOverride` argument — one
    boolean per pipeline step, indexed by the pipeline's ORIGINAL step index exactly like
    `pipeline.gates` — that REPLACES the pipeline's declared approval gates for a single run. It is
    copied onto the run's steps (`requiresApproval`, `gatesOverride?.[i] ?? pipeline.gates?.[i]`), so
    a retry/restart — which re-drive the STORED steps — preserve it with no extra persistence. A
    length that doesn't match the pipeline's step count is rejected up front (a `ValidationError`)
    before any side effects. Absent ⇒ today's behaviour byte-for-byte.
  - **orchestration** (`InitiativeLoopService`): a spawned item's preset-authored `spawn.gates` is
    threaded straight into `ExecutionService.start` as that run's gate override, so a spawned task
    gates (or doesn't) per the preset's human-review mapping instead of the pipeline default.

  Conformance: a new `startExecution` harness probe (start a run through the real `ExecutionService`
  with an optional gate override — a path no HTTP route exposes) plus shared assertions that an
  override flips a step's approval gate on/off, round-trips `requiresApproval` through each store, and
  rejects a mismatched-length override — run identically on the Cloudflare (D1) and Node/local
  (Postgres) facades.

- Updated dependencies [a869ae9]
  - @cat-factory/orchestration@0.88.0
  - @cat-factory/node-server@0.85.1
  - @cat-factory/server@0.97.1
  - @cat-factory/executor-harness@1.35.0

## 0.57.0

### Minor Changes

- 6198b08: Missing mandatory env vars / bindings now produce human-readable, actionable startup errors AND a
  graceful degraded backend instead of an opaque crash.

  - **Shared structured config errors.** A new `ConfigValidationError` (carrying a list of
    `ConfigProblem { key, summary, remedy }`) plus a canonical `ENV_HELP` description table and a
    `requireEnv` helper live in `@cat-factory/server`. Every facade's startup throw for a mandatory
    variable (`DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, a configured auth provider,
    `TELEMETRY_DB`, `AGENT_MODELS`, the container-executor prerequisites) now routes through it, so the
    message reads the same across Node, local, and the Worker and always says what the variable is for
    and how to fill it. A `ConfigProblem` never carries a secret value.

  - **Graceful misconfiguration fallback backend.** Instead of exiting (which left the SPA on a generic
    "can't reach the backend" panel with no clue what was wrong), a facade that hits a
    `ConfigValidationError` at boot now serves a minimal fallback app (`createMisconfiguredApp`) on the
    normal port: `GET /auth/config` returns an auth-disabled config carrying the problem list, `/health`
    stays 200 (`status: misconfigured`, so an orchestrator doesn't crash-loop it), and every other route
    503s with the structured problems. Wired symmetrically in all three runtimes — Node/local
    `serveMisconfigured`, the Worker's per-request build (which recovers automatically once bindings are
    fixed).

  - **Dedicated frontend error screen.** The SPA's boot handshake now recognises the `misconfigured`
    field and renders `BackendMisconfiguredScreen` — a per-variable list of name + meaning + remedy with
    a reload button — instead of the login/board. Fully translated across all locales.

### Patch Changes

- Updated dependencies [6198b08]
- Updated dependencies [37d1517]
  - @cat-factory/contracts@0.114.0
  - @cat-factory/server@0.97.0
  - @cat-factory/node-server@0.85.0
  - @cat-factory/kernel@0.104.0
  - @cat-factory/integrations@0.76.0
  - @cat-factory/orchestration@0.87.0
  - @cat-factory/agents@0.40.9
  - @cat-factory/gitlab@0.7.23
  - @cat-factory/executor-harness@1.35.0

## 0.56.0

### Minor Changes

- 14eac27: Add an account-wide model-family allow/block policy. An account admin can constrain which
  LLM families their teams run (block/allow lists over families like DeepSeek, Qwen, Claude,
  OpenAI), gated to the Cloudflare / remote-Node / mothership runtimes (never plain local
  mode). The policy is evaluated against `(family, effective-route provider)`, so a
  residency-guaranteed route (`trustedProviders`, e.g. Bedrock) can exempt an otherwise-blocked
  family — data-residency risk is a property of the serving route, not the model weights.
  Region-grouped built-in presets (USA / Europe / China / Other) ship as apply-in templates.

  Stored on the existing per-account settings config blob (no migration). Enforced through a
  single choke point (`ProviderCapabilities`): the `/models` catalog flags blocked models
  (`available: false` + `policyBlocked: true`) and the pipeline start guard refuses them
  (`model_policy_blocked`). The per-account policy read is cached via a new `accountModelPolicy`
  slice of the app cache seam (`AppCaches`), invalidated on the account-settings write.

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/contracts@0.113.0
  - @cat-factory/kernel@0.103.0
  - @cat-factory/server@0.96.0
  - @cat-factory/orchestration@0.86.0
  - @cat-factory/node-server@0.84.0
  - @cat-factory/agents@0.40.8
  - @cat-factory/gitlab@0.7.22
  - @cat-factory/integrations@0.75.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.4

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/contracts@0.112.0
  - @cat-factory/kernel@0.102.0
  - @cat-factory/integrations@0.75.0
  - @cat-factory/orchestration@0.85.0
  - @cat-factory/server@0.95.0
  - @cat-factory/agents@0.40.7
  - @cat-factory/gitlab@0.7.21
  - @cat-factory/node-server@0.83.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.3

### Patch Changes

- 23f7342: Mothership mode: give the four remaining `local-sqlite` bucket repositories a `node:sqlite` home on
  the laptop, so the subscription features and the local-mode settings panel work in mothership mode
  (previously their services were OFF for lack of a database).

  - The local credential store (`credentialStore.ts`) gains three sealed-credential repositories —
    `SqliteProviderSubscriptionTokenRepository` (the per-workspace pooled Claude Code / Codex / GLM
    subscription tokens), `SqlitePersonalSubscriptionRepository` (per-user individual-usage
    credentials, the outer double-encryption blob), and `SqliteSubscriptionActivationRepository`
    (their short-lived per-run, system-key-only copies). A new `localSettingsStore.ts` holds the
    local-mode operational settings singleton (`SqliteLocalSettingsRepository`), kept out of the
    credential store so its "only credentials" invariant holds.
  - All mirror their `D1*` SQL (D1 is SQLite) and stay LOCAL for the same reason the API-key pool
    does: the tokens are leased + decrypted by the LOCAL container executor with the LOCAL key, so
    they must never traverse the machine API to the mothership.
  - New `NodeContainerOptions` credential-override seams (`providerSubscriptionTokenRepository` /
    `personalSubscriptionRepository` / `subscriptionActivationRepository`, mirroring the existing
    `providerApiKeyRepository` seam) let `buildNodeSubscriptionService` /
    `buildNodePersonalSubscriptionService` build without a `db`; the activation repo is threaded once
    and shared by both its consumers (the personal-subscription service's mint + the engine core's
    clear-on-completion). `localSettingsService` is built in the local facade from the local-sqlite
    repo when there is no `db`.

- Updated dependencies [23f7342]
- Updated dependencies [fdba1ea]
  - @cat-factory/node-server@0.83.0
  - @cat-factory/contracts@0.111.0
  - @cat-factory/integrations@0.74.0
  - @cat-factory/orchestration@0.84.0
  - @cat-factory/agents@0.40.6
  - @cat-factory/gitlab@0.7.20
  - @cat-factory/kernel@0.101.2
  - @cat-factory/server@0.94.3
  - @cat-factory/executor-harness@1.35.0

## 0.55.2

### Patch Changes

- Updated dependencies [6a701ef]
  - @cat-factory/integrations@0.73.6
  - @cat-factory/orchestration@0.83.2
  - @cat-factory/server@0.94.2
  - @cat-factory/node-server@0.82.2
  - @cat-factory/executor-harness@1.35.0

## 0.55.1

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/contracts@0.110.1
  - @cat-factory/kernel@0.101.1
  - @cat-factory/orchestration@0.83.1
  - @cat-factory/integrations@0.73.5
  - @cat-factory/agents@0.40.5
  - @cat-factory/gitlab@0.7.19
  - @cat-factory/server@0.94.1
  - @cat-factory/node-server@0.82.1
  - @cat-factory/executor-harness@1.35.0

## 0.55.0

### Minor Changes

- c66362f: Remove the `ENVIRONMENTS_ENABLED` deployment flag; the ephemeral-environment
  integration now assembles wherever the shared `ENCRYPTION_KEY` is set, the same
  "always on where the key is present" model as the document/task sources.

  The flag was a footgun: it defaulted off and its only effect was to make the whole
  integration silently inert (auto-detect 503ing with `unavailable`) even when the real
  prerequisites — an encryption key plus a registered per-workspace connection — were
  present. Whether a workspace provisions anything is already governed by whether it
  connects a provider and whether its pipeline includes a `deployer`/`tester` step, so to
  keep environments out of a pipeline you simply omit those steps. `EnvironmentsConfig`
  drops its `enabled` field and the module gates on `encryptionKey` presence in all three
  runtimes.

  Breaking: `ENVIRONMENTS_ENABLED` is no longer read; remove it from deployment config
  (setting it has no effect). The inspector's dedicated "ephemeral environments aren't
  enabled" auto-detect panel is removed with it, since that off state no longer exists.

### Patch Changes

- Updated dependencies [c66362f]
  - @cat-factory/server@0.94.0
  - @cat-factory/node-server@0.82.0
  - @cat-factory/executor-harness@1.35.0

## 0.54.0

### Minor Changes

- cc74273: Add an optional `backendRegistries` seam to `startLocal()`, threaded into `buildLocalContainer`
  on both the Postgres and mothership boot paths (mirroring the existing `agentKindRegistry` seam).

  This lets a deployment that registers a custom environment/runner backend by reference (e.g. an
  in-house ephemeral-environment provider) call `startLocal()` — and inherit its boot preflights
  (harness-image refresh, container-runtime probe, PAT/auth warnings) — instead of re-implementing
  the boot path with `start()` + `buildLocalContainer` by hand, which silently forgoes those
  preflights (notably the recommended-executor-image pull at boot). Absent → unchanged (the
  built-in-only default `manifest` + `kubernetes`).

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/contracts@0.110.0
  - @cat-factory/kernel@0.101.0
  - @cat-factory/orchestration@0.83.0
  - @cat-factory/server@0.93.0
  - @cat-factory/agents@0.40.4
  - @cat-factory/gitlab@0.7.18
  - @cat-factory/integrations@0.73.4
  - @cat-factory/node-server@0.81.1
  - @cat-factory/executor-harness@1.35.0

## 0.53.0

### Minor Changes

- 9ea1e77: Tiered spend budgets (account / workspace / user) with operator hard caps.

  Budgets are now tracked and enforced across three tiers: the existing per-workspace
  monthly limit, a per-account limit, and a per-user limit. A run pauses when any applicable
  tier is exhausted. All three tiers are configurable and visible in the Budget settings
  screen.

  Two new environment variables (`BUDGET_MAX_MONTHLY_PER_ACCOUNT`,
  `BUDGET_MAX_MONTHLY_PER_USER`), read by the Node and Cloudflare config loaders, set
  operator hard ceilings on the account/user tiers; the UI cannot exceed a configured cap and
  shows it on the budget screen. See `docs/environment-variables.md` and
  `docs/initiatives/tiered-budgets.md`.

  Breaking (pre-1.0, no data migration): the `token_usage` ledger gains nullable
  `account_id`/`user_id` columns (existing rows are unattributed and excluded from the new
  account/user rollups until re-metered); `TokenUsageRecord`, `RecordUsageInput`, and
  `SpendPricing` gained fields; `SpendService.isOverBudget` now takes an optional tier scope.
  A new `user_settings` table and `GET/PUT /user-settings` endpoint carry the user-tier
  budget.

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/contracts@0.109.0
  - @cat-factory/kernel@0.100.0
  - @cat-factory/orchestration@0.82.0
  - @cat-factory/server@0.92.0
  - @cat-factory/node-server@0.81.0
  - @cat-factory/agents@0.40.3
  - @cat-factory/gitlab@0.7.17
  - @cat-factory/integrations@0.73.3
  - @cat-factory/executor-harness@1.35.0

## 0.52.4

### Patch Changes

- e66accb: Stack recipes & shared stacks (slice 7): make the Deployer the sole docker-compose provisioner + the environment setup wizard scaffolding.

  **Deployer becomes the single docker-compose provisioner (the compose-centralization follow-up owed by this slice).** Now that the setup wizard can save a `docker-compose` handler, docker-compose is provisioned by the single Deployer step through a workspace handler, exactly like `kubernetes`/`custom` — the in-container (DinD) bring-up is retired from the run-mode decision:

  - `decideTesterInfra` (`tester-infra.logic.ts`): `docker-compose` is handler-based (drops the `localTestInfraSupported`/`hasComposePath` inputs and the `limited-local`/`compose-unconfigured` reasons).
  - `needsDeployerBeforeConsumer` + `ExecutionService.assertTesterInfraConfigured`'s `needsHandler` now cover `docker-compose`, so a compose chain that reaches a tester with no resolvable handler is refused at run start (fail-fast, same as k8s/custom) instead of dead-ending.
  - `testerInfraSpec` (`@cat-factory/server`): `docker-compose` targets the Deployer-provisioned env (`environment: 'ephemeral'`); the `local`/`composePath` branch is gone.
  - (The harness's in-container `docker compose up` is now unreachable and retired in a later image-bumping slice.)

  **Environment setup wizard.** The guided detect → review → preflight → save flow the compose-centralization depends on: `EnvironmentSetupWizard.vue` (stepper shell over the `environmentWizard` store — detection, opt-in deep analysis via `pl_environment_analysis` with live provenance-merged review, compose-file/profile/seed candidate pickers, a raw-recipe editor, the preflight checklist, save the workspace compose handler + the frame recipe, and an optional trial provision with live provisioning logs), a docker-compose service-inspector nudge, a SideBar entry, the mount in `pages/index.vue`, and the `environmentWizard` i18n namespace across all 8 locales. Backed by the `preflights` API + store (`POST /workspaces/:ws/preflights/run`) and the `provisionEnvironment` API. (The `data-testid`-only e2e spec is deferred — it needs a fake `ProvisioningRepoReader` e2e seam so detection returns a canned recommendation with GitHub off; tracked in the slice-7 checklist.)

  Breaking (pre-1.0, acceptable): a `docker-compose` service reaching a tester/human-test with no configured compose handler is now refused at run start rather than falling back to an in-container compose bring-up.

  Review follow-ups in the same slice: the `environmentWizard` store now fully resets per-frame state when re-targeted (`selectFrame` no longer leaves a prior frame's `saved`/service/port behind), resolves the analyst run by preferring a live/succeeded instance over a bare `.at(-1)` (so a retry's dead predecessor can't mask the successful run), validates the exposed port before registering the handler, and surfaces a real (non-503) preflight failure instead of swallowing it. The now-dead `localTestInfraSupported` dependency (its only reads were removed with the DinD path) is dropped from `CoreDependencies`/`ExecutionService` and the local facade's wiring, and the stale DinD doc comments on `assertTesterInfraConfigured` / `testerInfraSpec` are corrected.

- Updated dependencies [e66accb]
  - @cat-factory/orchestration@0.81.0
  - @cat-factory/server@0.91.0
  - @cat-factory/contracts@0.108.1
  - @cat-factory/node-server@0.80.5
  - @cat-factory/executor-harness@1.35.0
  - @cat-factory/agents@0.40.2
  - @cat-factory/gitlab@0.7.16
  - @cat-factory/integrations@0.73.2
  - @cat-factory/kernel@0.99.1

## 0.52.3

### Patch Changes

- Updated dependencies [9cc02a0]
  - @cat-factory/integrations@0.73.1
  - @cat-factory/orchestration@0.80.1
  - @cat-factory/server@0.90.3
  - @cat-factory/node-server@0.80.4
  - @cat-factory/executor-harness@1.35.0

## 0.52.2

### Patch Changes

- Updated dependencies [1afa003]
- Updated dependencies [f91b99d]
  - @cat-factory/kernel@0.99.0
  - @cat-factory/orchestration@0.80.0
  - @cat-factory/integrations@0.73.0
  - @cat-factory/contracts@0.108.0
  - @cat-factory/agents@0.40.1
  - @cat-factory/gitlab@0.7.15
  - @cat-factory/server@0.90.2
  - @cat-factory/node-server@0.80.3
  - @cat-factory/executor-harness@1.35.0

## 0.52.1

### Patch Changes

- Updated dependencies [eef8612]
- Updated dependencies [bf31df7]
  - @cat-factory/integrations@0.72.1
  - @cat-factory/contracts@0.107.0
  - @cat-factory/agents@0.40.0
  - @cat-factory/kernel@0.98.0
  - @cat-factory/orchestration@0.79.1
  - @cat-factory/server@0.90.1
  - @cat-factory/node-server@0.80.2
  - @cat-factory/gitlab@0.7.14
  - @cat-factory/executor-harness@1.35.0

## 0.52.0

### Minor Changes

- 6f9d935: Stack recipes & shared stacks (slice 6): preflight prerequisite checks with guided remediation.

  A stack recipe can now declare machine `prerequisites: PreflightRef[]` — automated PROBE + human REMEDIATION checks for the inherently-manual one-time machine setup a complex compose repo needs (docker daemon reachable, free disk / RAM, container-registry login state, VPN reachability, mkcert CA, hosts-file entries, an env-file secrets marker). They are re-run at provision start: a failing REQUIRED check fails the provision fast with its copy-paste remediation in the provisioning log, instead of a mystery deep inside a 40-image pull (a non-required check is advisory — a warning). A `POST /workspaces/:ws/preflights/run` endpoint runs an arbitrary set of checks for the setup wizard's live re-check.

  - Contracts: `PreflightCheckId` / `PreflightParams` / `PreflightRef` / `PreflightResult` (`preflights.ts`) + `prerequisites` on `stackRecipeSchema`; the `runPreflightsContract` route.
  - Kernel: the runtime-bound `PreflightHostProbes` seam + `PreflightProbeOutcome`, and a `runPreflights` seam on `ProvisionEnvironmentRequest`.
  - Integrations: `PreflightService` (runtime-neutral orchestration over the probe seam) + provision-start enforcement in `ComposeEnvironmentProvider`.
  - Server: `PreflightController`.
  - Local facade: `createDockerPreflightProbes` (the host probes over the docker CLI + `node:*`), wired only where the compose runtime is (a Docker-family host daemon). The probes are runtime-bound (local facade only, the documented compose exception); the declaration + API are runtime-neutral and the recipe rides the existing `provisioning` blob, so there is no migration. On the Worker / plain Node the preflight API 503s and a recipe that declares prerequisites fails loudly at provision.

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/contracts@0.106.0
  - @cat-factory/kernel@0.97.0
  - @cat-factory/integrations@0.72.0
  - @cat-factory/orchestration@0.79.0
  - @cat-factory/server@0.90.0
  - @cat-factory/agents@0.39.4
  - @cat-factory/gitlab@0.7.13
  - @cat-factory/node-server@0.80.1
  - @cat-factory/executor-harness@1.35.0

## 0.51.2

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [e5b9462]
- Updated dependencies [dd6df12]
  - @cat-factory/contracts@0.105.0
  - @cat-factory/kernel@0.96.0
  - @cat-factory/server@0.89.0
  - @cat-factory/orchestration@0.78.0
  - @cat-factory/node-server@0.80.0
  - @cat-factory/integrations@0.71.0
  - @cat-factory/agents@0.39.3
  - @cat-factory/gitlab@0.7.12
  - @cat-factory/executor-harness@1.35.0

## 0.51.1

### Patch Changes

- 35f499c: Fix local-mode CORS + two SPA regressions

  - **local-server:** default `ENVIRONMENT=local` in `applyLocalDefaults`, and pass the
    localized env (not the raw one) into `start()`. The shared app's CORS middleware reads
    `ENVIRONMENT` / `CORS_ALLOWED_ORIGINS` directly off the env, and the raw env was being
    passed through, so the server default-DENIED CORS and the SPA on `:3000` failed with
    "can't reach backend" until an operator hand-set `CORS_ALLOWED_ORIGINS`. Local mode now
    reflects the SPA origin out of the box (auth is a bearer header, credentials mode off).
  - **app:** import the `CreateInitiativeModal` component in `index.vue` — it was referenced
    in the template but never imported, so Vue logged "Failed to resolve component".
  - **app:** stop sending an empty `?kind=` query when describing an infra provider without a
    concrete backend kind. The empty string was read as a real (unknown) backend kind and
    rejected with 422; the request now omits the param so the server falls back to the
    workspace's stored/default kind.

## 0.51.0

### Minor Changes

- accb8ec: feat(docs): attach read-only reference repositories to a document-authoring task

  Let a document-type task carry a list of **reference repositories** the `doc-writer` agent clones
  READ-ONLY while it drafts, so it can reuse existing solutions in those repos as a reference. The
  writer is already containerized (`container-coding`), so no interim step is needed — the reference
  repos become extra sibling checkouts it may read but can never write to.

  - **Read-only by construction.** Reference repos flow through a NEW `referenceRepos` block field,
    separate from the writable `involvedServiceIds`/`fanOutMultiRepo` path. The harness job spec
    carries no branch/PR fields for a reference, the multi-repo coder clones it at its base branch
    with no work branch, and the push phase skips it — three independent layers, so a reference repo
    is structurally impossible to push to. Its clone URL is host-allowlisted like every other repo.
  - **Any accessible repo, by name fragment.** A reference need not be a board service or in the
    workspace's synced projection: the inspector picker reuses the SAME server-side, debounced repo
    search as the add-service modal (extracted into a shared `useRepoSearch` composable), so any repo
    the workspace's VCS connection or the signed-in user's PAT can reach can be attached.
  - **Provider-neutral by construction.** The `ReferenceRepo` identity mirrors the kernel's VCS
    vocabulary (`repoId` / `owner` / `name` / `defaultBranch` / `connectionId`, per `VcsRepoRef` /
    `VcsConnectionRef`) rather than GitHub-specific names, and the clone URL + provider come from the
    deployment-level `ResolveRepoOrigin` seam the primary already rides — so a GitLab deployment
    clones references from GitLab with no extra wiring.
  - **Deduped against the primary.** A reference pointing at the doc task's own repo (or a duplicate
    attachment) is dropped by the shared sibling-checkout key, so it can't collide with an existing
    clone directory and fail the run.
  - **Symmetric persistence.** New `reference_repos` JSON column on `blocks`, mirrored across the D1
    and Drizzle stores with a cross-runtime conformance round-trip assertion.

  Bumps `@cat-factory/executor-harness` (new read-only reference-leg support in the coding harness) —
  the runner image tag pins and `RECOMMENDED_HARNESS_IMAGE` are bumped in lockstep.

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/contracts@0.104.0
  - @cat-factory/kernel@0.95.0
  - @cat-factory/server@0.88.0
  - @cat-factory/orchestration@0.77.0
  - @cat-factory/executor-harness@1.35.0
  - @cat-factory/node-server@0.79.0
  - @cat-factory/agents@0.39.2
  - @cat-factory/gitlab@0.7.11
  - @cat-factory/integrations@0.70.1

## 0.50.0

### Minor Changes

- cd435d1: Shared stacks (stack-recipes-and-shared-stacks initiative, slice 4): a workspace-scoped,
  long-lived compose stack a per-PR consumer environment attaches to over an external network
  (the acme-shared-services shape). Adds the `SharedStack` contract + `SharedStackRepository`
  port, the D1 ⇄ Drizzle `shared_stacks` table with a cross-runtime conformance round-trip, a
  `SharedStackService` lifecycle (CRUD everywhere + host-Docker `ensureUp`/`teardown` on the local
  facade, reusing the compose recipe-runner), the `GET|POST|PATCH|DELETE /workspaces/:ws/shared-stacks`
  (+ `ensure-up`/`teardown`) controller, and a "Shared stacks" panel in the Infrastructure window.
  Bringing a stack up is local-facade-bound (host daemon), the documented compose exception to
  runtime symmetry; persistence stays fully symmetric.

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/contracts@0.103.0
  - @cat-factory/kernel@0.94.0
  - @cat-factory/integrations@0.70.0
  - @cat-factory/orchestration@0.76.0
  - @cat-factory/server@0.87.0
  - @cat-factory/node-server@0.78.0
  - @cat-factory/agents@0.39.1
  - @cat-factory/gitlab@0.7.10
  - @cat-factory/executor-harness@1.34.12

## 0.49.0

### Minor Changes

- c435c09: Local mode ships an on-by-default self-hosted SearXNG web-search upstream.

  Web search for container agents is a backend proxy (`/v1/web-search/search`) that resolves its
  upstream from the run's per-account settings — so local mode previously had no web search until a
  developer hand-entered keys. This adds a **deployment-level trusted default upstream** the proxy
  falls back to when the account has none, and wires a self-hosted SearXNG as that default in local
  mode (on by default, disable with `LOCAL_WEB_SEARCH=off`).

  - **server**: `SearxngWebSearchUpstream` gains a `trusted` flag that trusts only the deployment's
    own configured origin (its base URL — which may be loopback/LAN — and same-origin redirects)
    while a CROSS-origin redirect stays SSRF-guarded, so a trusted-but-compromised upstream can't
    pivot to an internal/metadata host; redirect/credential-stripping/byte-cap protection is
    unchanged. New `createDefaultWebSearchUpstream(...)` (trusted counterpart to
    `createWebSearchUpstream`). `ServerContainer` gains optional `defaultWebSearchUpstream`, which
    `WebSearchProxyController` uses as the fallback when the account resolves no upstream (the
    account path still wins and stays SSRF-guarded; neither ⇒ the unchanged empty-result degrade).
  - **node-server & worker**: both facades build the default from `WEB_SEARCH_BRAVE_API_KEY` /
    `WEB_SEARCH_SEARXNG_URL` / `WEB_SEARCH_SEARXNG_API_KEY`, surface it on the container, and
    advertise Pi's `web_search` tool whenever a default exists (or the account has keys). A stock
    Node **or Cloudflare** deployment can now set a deployment-wide default (Brave or a public
    self-hosted SearXNG); each facade carries a proxy-fallback parity test.
  - **local-server**: `applyLocalDefaults` points `WEB_SEARCH_SEARXNG_URL` at the local SearXNG
    (`http://localhost:8080`) unless `LOCAL_WEB_SEARCH=off`; the `deploy/local` docker-compose gains a
    pinned `searxng` service (behind a `web-search` profile) + a `settings.yml` enabling the JSON API.

  The only Cloudflare-specific gap is the loopback-SearXNG story (no localhost container on workerd),
  which is inherently local-only; the runtime-neutral Brave/public-SearXNG default is now symmetric.

### Patch Changes

- Updated dependencies [c435c09]
  - @cat-factory/server@0.86.0
  - @cat-factory/node-server@0.77.0
  - @cat-factory/executor-harness@1.34.12

## 0.48.0

### Minor Changes

- 076d02f: feat(documents): interactive document-review sessions (doc-task WS5)

  Between the outline and the draft, a document-authoring run now converses with the requester
  instead of a single binary approve/revise gate. A new inline `doc-interviewer` step (inserted
  after `doc-outliner` in `pl_document`, replacing the outline's human gate) asks a small batch of
  clarifying questions about scope, audience and structure, parks the run on the standard durable
  decision-wait while the human answers through a dedicated window, and iterates (up to a round
  cap) until it synthesizes a refined **authoring brief** the `doc-writer`/`doc-finalizer` start
  from (folded into their context via the agent-context builder).

  The park/answer/resume/advance spine is now a shared `InterviewGateController<TEntity>`
  parameterized by an `InterviewGateKind` strategy; both the document interviewer and the
  interactive-planning (initiative) interviewer ride it, so the two gates can't drift. A document
  task has no owning entity row, so its transcript is persisted in its own `doc_interview_sessions`
  table — mirrored across D1 ⇄ Drizzle with a cross-runtime conformance assertion. The interview
  window is wired through the universal result-view seam (`doc-interview`) and updates live over a
  new `docInterview` workspace event. Pass-through when no interviewer model is wired, so document
  pipelines run unchanged.

  Hardening: a re-run of a document task now clears the block's prior session before interviewing
  (so it starts clean instead of reusing a stale, already-converged one), the converged brief is
  folded only into the two kinds that consume it (`doc-writer`/`doc-finalizer`), and a non-final
  interviewer pass that returns neither questions nor a brief fails the run loudly instead of
  silently skipping the interview with an empty brief.

  Breaking: `pl_document` bumps to version 3 (the reseed offer), and its step indices shift (the
  interviewer is inserted at index 2), so in-flight runs on the old shape should be restarted.

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
- Updated dependencies [77bc73c]
  - @cat-factory/agents@0.39.0
  - @cat-factory/integrations@0.69.1
  - @cat-factory/kernel@0.93.0
  - @cat-factory/orchestration@0.75.0
  - @cat-factory/server@0.85.0
  - @cat-factory/node-server@0.76.0
  - @cat-factory/contracts@0.102.0
  - @cat-factory/executor-harness@1.34.12
  - @cat-factory/gitlab@0.7.9

## 0.47.0

### Minor Changes

- 029a689: feat(environments): stack-recipe execution engine (shared-stacks initiative, slice 3)

  Teach the Docker Compose environment provider to run a declarative STACK RECIPE — the imperative
  bring-up of a complex multi-repo/multi-service stack (the acme-main pilot) expressed as data.
  The recipe is service-owned (`ServiceProvisioning.recipe`, landed slice 1) and now reaches the
  provider: `resolveProviderForType` folds it into the compose handler's `providerConfig.recipe` at
  provision time (the compose analogue of merging a kube `manifestSource`), so the provider keys
  purely on the persisted, merged config. Runtime-bound to the local facade (needs a host daemon) —
  the documented compose exception to runtime symmetry; the contracts + persistence stay symmetric.

  - **Multi-`-f` layering + profiles + env files** — `recipe.composeFiles` are read, `{{var}}`-
    rendered, host-escape-checked and port-neutralized per layer (concurrent per-PR stacks never
    collide), then written beside their originals in the checkout and passed as ordered `-f`s;
    `recipe.composeProfiles` drives `COMPOSE_PROFILES`; `recipe.envFiles` materialize committed
    templates into their gitignored targets before `up` (`.env.dev.local-dist` → `.env.dev.local`).
  - **Setup-step runner** — ordered `setupSteps` after `up -d` (no `--wait` — readiness is the
    recipe gate, since these stacks rarely declare healthchecks): `compose-exec` (composer install,
    migrations, cache warmup; seed import pipes a `.sql` dump via stdin), `copy-file`, `wait-http`,
    `wait-file` (container `test -f` or checkout), and the opt-in `host-command` (refused unless the
    workspace handler sets `allowHostCommands`). Each step has its own timeout budget.
  - **Terminal health gate** — `compose-healthy` (default, poll `ps`), `http`, or `compose-exec`
    (e.g. `bin/console monitor:health`), polled until it passes or its budget elapses.
  - **Per-step provisioning log** — the provider streams a `recordStep` entry per step (env file,
    `up`, each setup step, health gate) into the environment provisioning log, so the "View logs"
    drawer shows which step is running / died. Any step's failure tears the half-up stack down for a
    clean retry and surfaces the step's own error as the deployer step's `lastError`.

  New optional `ComposeRuntime` seams (implemented by the local docker-CLI runtime): `compose`
  stdin-streaming, `copyCheckoutFile`, `checkoutFileExists`, `hostCommand`. All compose safety lines
  carry over (host-escape guard on every recipe path, `include:`/cross-file `extends`/`privileged`
  refused). Fixture-driven unit tests cover the new pure helpers and the provider recipe flow
  (layering, env files, steps, stdin seed, HTTP gate, host-command opt-in, failure teardown).
  Recipe `teardownSteps` execution is deferred (the recipe schema carries them; `down -v` remains
  the teardown for now).

### Patch Changes

- Updated dependencies [029a689]
- Updated dependencies [029a689]
  - @cat-factory/contracts@0.101.1
  - @cat-factory/integrations@0.69.0
  - @cat-factory/kernel@0.92.0
  - @cat-factory/agents@0.38.2
  - @cat-factory/gitlab@0.7.8
  - @cat-factory/orchestration@0.74.3
  - @cat-factory/server@0.84.3
  - @cat-factory/node-server@0.75.3
  - @cat-factory/executor-harness@1.34.10

## 0.46.2

### Patch Changes

- Updated dependencies [f6399cf]
  - @cat-factory/integrations@0.68.0
  - @cat-factory/orchestration@0.74.2
  - @cat-factory/server@0.84.2
  - @cat-factory/node-server@0.75.2
  - @cat-factory/executor-harness@1.34.10

## 0.46.1

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/contracts@0.101.0
  - @cat-factory/kernel@0.91.0
  - @cat-factory/agents@0.38.1
  - @cat-factory/gitlab@0.7.7
  - @cat-factory/integrations@0.67.1
  - @cat-factory/orchestration@0.74.1
  - @cat-factory/server@0.84.1
  - @cat-factory/node-server@0.75.1
  - @cat-factory/executor-harness@1.34.10

## 0.46.0

### Minor Changes

- 773695b: feat(documents): workspace-linked template + exemplar documents per DocKind (doc-task WS1 items 2–4)

  A workspace can now point a document kind at its OWN template and example documents, reusing
  the existing documents integration end-to-end (no new fetch machinery). A single `role`
  (`template` | `exemplar`) + `docKind` tag on the projected `documents` row — sitting alongside
  the block-scoped `linkedBlockId` anchor — models both:

  - **Template** (singular per kind): its parsed section headings REPLACE the built-in skeleton
    for that kind. Resolved through one shared seam (`resolveDocTemplate`) that BOTH the
    doc-authoring prompts (via the engine-resolved `block.docTemplateBody`) and the `doc-quality`
    gate provider go through, so the writer and the gate never check against different sections.
  - **Exemplars** (multi-valued per kind): "good examples to emulate" surfaced to the author
    agents alongside a new set of built-in curated exemplars.

  The `documents` table gains nullable `role`/`doc_kind` columns (D1 migration ⇄ Drizzle schema +
  generated migration), with new `DocumentRepository` role methods mirrored across both stores and
  asserted by the cross-runtime conformance suite. The Node facade's Drizzle migration is the
  merge node that collapses the two pre-existing divergent snapshot leaves. New workspace-scoped
  routes (`GET`/`POST /document-role-links`, `POST /document-role-links/remove`) back a
  per-DocKind template/exemplar management panel in the Integrations hub (i18n in all 8 locales).

  Breaking (pre-1.0, acceptable): the `documents` projection wire shape gains `role`/`docKind`
  fields; stale rows simply carry nulls.

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/contracts@0.100.0
  - @cat-factory/kernel@0.90.0
  - @cat-factory/agents@0.38.0
  - @cat-factory/integrations@0.67.0
  - @cat-factory/orchestration@0.74.0
  - @cat-factory/server@0.84.0
  - @cat-factory/node-server@0.75.0
  - @cat-factory/gitlab@0.7.6
  - @cat-factory/executor-harness@1.34.10

## 0.45.5

### Patch Changes

- Updated dependencies [3981bbb]
  - @cat-factory/contracts@0.99.0
  - @cat-factory/agents@0.37.2
  - @cat-factory/gitlab@0.7.5
  - @cat-factory/integrations@0.66.1
  - @cat-factory/kernel@0.89.1
  - @cat-factory/orchestration@0.73.1
  - @cat-factory/server@0.83.2
  - @cat-factory/node-server@0.74.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.4

### Patch Changes

- Updated dependencies [cfcb6c7]
- Updated dependencies [48f9d97]
  - @cat-factory/kernel@0.89.0
  - @cat-factory/contracts@0.98.0
  - @cat-factory/orchestration@0.73.0
  - @cat-factory/integrations@0.66.0
  - @cat-factory/node-server@0.74.0
  - @cat-factory/agents@0.37.1
  - @cat-factory/gitlab@0.7.4
  - @cat-factory/server@0.83.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.3

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0
  - @cat-factory/agents@0.37.0
  - @cat-factory/server@0.83.0
  - @cat-factory/node-server@0.73.0
  - @cat-factory/gitlab@0.7.3
  - @cat-factory/integrations@0.65.3
  - @cat-factory/orchestration@0.72.1
  - @cat-factory/executor-harness@1.34.10

## 0.45.2

### Patch Changes

- 13a284f: Bug-triage pipeline (phase G): the `repro-test` Reproduction Test Automation agent. A new
  structured `container-coding` agent kind writes one or more tests that fail for the reported
  reason and commits them onto the run's shared work branch (seeding it for the coder, which opens
  the one PR containing both the reproduction test and the fix) — or concedes `not_reproducible`
  without failing the run. Conceding and reproduced outcomes both advance to the coder; a
  post-completion resolver folds the `{ outcome, testPaths, notes }` assessment into the step
  output so the coder reads it, and a `BUG_FIX_GUIDANCE` prompt fragment reframes the coder's
  objective around the pre-existing failing test (fix the issue, don't merely make the test pass).

  Enabling changes: `AgentStepSpec` gains `opensPr` / `noChangesTolerated` (container-coding) so a
  kind can seed the work branch without opening a PR and tolerate a no-op; the executor-harness
  coding path now parses a structured JSON outcome (`custom`) alongside the pushed commit; the
  harness image is bumped to `1.34.9`. The runtime-neutral `@cat-factory/server` package keeps its
  Web-standard `src` surface (no `@types/node`) while typing the one cross-runtime Node built-in it
  uses (`AsyncLocalStorage`) via a local ambient shim, with node-using tests typechecked under a
  separate project.

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0
  - @cat-factory/agents@0.36.0
  - @cat-factory/orchestration@0.72.0
  - @cat-factory/server@0.82.0
  - @cat-factory/executor-harness@1.34.10
  - @cat-factory/gitlab@0.7.2
  - @cat-factory/integrations@0.65.2
  - @cat-factory/node-server@0.72.2

## 0.45.1

### Patch Changes

- Updated dependencies [102c049]
  - @cat-factory/contracts@0.97.0
  - @cat-factory/agents@0.35.0
  - @cat-factory/gitlab@0.7.1
  - @cat-factory/integrations@0.65.1
  - @cat-factory/kernel@0.86.1
  - @cat-factory/orchestration@0.71.1
  - @cat-factory/server@0.81.1
  - @cat-factory/node-server@0.72.1
  - @cat-factory/executor-harness@1.34.8

## 0.45.0

### Minor Changes

- 49b498a: Registry DI migration — the agent-kind registry becomes app-owned (no module global).

  Continues the [registry-DI initiative](docs/initiatives/registry-di-migration.md): the
  plugin-style agent-kind registry (`registerAgentKind` into a module-level `Map`) is replaced by
  an app-owned **`AgentKindRegistry`** instance the composition root news once
  (`defaultAgentKindRegistry()`, pre-loaded with the built-in `bug-investigator` / document /
  initiative kinds), threads through the single `CoreDependencies` object, and re-exposes on the
  `Core` + `ServerContainer` for the HTTP snapshot projection. Module identity stops mattering, the
  external-adapter "phantom Map" gotcha is gone, and tests get a fresh instance instead of
  `clearRegisteredAgentKinds()`. This also fixes the phase-F worker-shard conformance flake at its
  root: the shared suite's `clearRegisteredAgentKinds()` used to wipe the built-in kinds for the
  rest of a single-module run.

  **BREAKING** — the free module-global seams are removed from `@cat-factory/agents` (and the
  facade re-exports): `registerAgentKind`/`registerAgentKinds`, `registered*` (`registeredAgentKind`,
  `registeredAgentStep`, `registeredKindRequiresContainer`, `registeredSystemPrompt`,
  `registeredUserPrompt`, `registeredConfigContributions`, `registeredPreOps`, `registeredPostOps`,
  `registeredAgentPresentation`, `registeredStructuredOutput`, `registeredWebResearchHint`,
  `registeredAgentTuning`, `registeredAgentKinds`), and `clearRegisteredAgentKinds`. Instead export
  the `AgentKindRegistry` class + `defaultAgentKindRegistry()` factory; the pure prompt/catalog fns
  (`systemPromptFor`/`userPromptFor`/`traitsFor`/`hasTrait`/`agentTuningFor`/`configContributionsFor`/
  `configContributionCatalog`/`webResearchGuidanceFor`/`isInlineModelStep`) now take a `registry`
  argument, and a deployment registers custom kinds **by reference** on the instance it injects into
  `buildContainer` / `start()` / `startLocal()` (the `agentKindRegistry` seam), exactly like the
  backend-registries pilot. The runtimes stay symmetric and the cross-runtime conformance suite
  injects a pre-loaded registry to assert a custom kind resolves identically on every facade.

  Also fixes a warm-pool bug in the executor-harness: the read-only multi-repo explore fan-out
  (`runExploreMode`) was gated on `!job.persistentCheckout`, so a `bug-investigator` dispatched to a
  warm local pool (which injects `persistentCheckout: true` on every job) silently dropped its peer
  repos and only saw the primary. The guard is dropped — `runMultiRepoExplore` uses its own
  ephemeral workspace, so the flag is harmlessly ignored.

- 49b498a: Service connections Phase 3 — multi-repo coding. The implementer now fans a cross-service
  change out across every connected involved-service repo, not just the task's own. A new
  `resolveRepoTargets` resolves the task's own repo PLUS each involved service's repo, deduped
  by repo (two services in one monorepo collapse into a single checkout with both
  subdirectories noted; a service co-located in the primary's own repo rides the own-service
  PR). `ContainerAgentExecutor` builds a `peerRepos` job body + a "Multi-repo workspace" prompt
  section for the `coder` kind and works at the repo root so it can reach every involved
  subtree. The executor-harness clones each peer repo as a SIBLING checkout under one workspace
  root, runs the agent once across all of them, and opens one PR per repo it actually changed.
  The own-service PR stays on `block.pullRequest`; the peer PRs are recorded on the new
  `block.peerPullRequests` (`AgentRunResult.peerPullRequests` → engine → JSON column, mirrored
  on D1 + Drizzle), with an `allPullRequests(block)` helper for the multi-repo-aware readers.
  Peer clone URLs are host-allowlisted exactly like the primary. Bumps the runner image
  (`peerRepos` job field + sibling-checkout flow).

### Patch Changes

- 49b498a: Bug-triage pipeline, Phase F — structured, multi-repo investigation + clarification.

  The `bug-investigator` is upgraded from a thin prose role into a STRUCTURED, read-only,
  multi-repo `container-explore` kind whose triage drives the downstream `clarity-review` gate,
  and the gate learns to seed itself from that triage instead of running its own first LLM pass.
  Same kind id, so the existing `pl_bugfix` preset inherits the upgrade.

  - **Structured `bug-investigator`** (`@cat-factory/agents`): registered via the public
    `registerAgentKind` seam (the `security-auditor` shape) with a lenient valibot
    `bugInvestigation` schema — `clarity` (`clear` | `needs_clarification`), `summary`, ranked
    `rootCauseHypotheses`, `affectedRepos`, `suggestedReproductions`, and `questions`
    (non-empty only when clarification is needed). Its structured object lands on `step.custom`
    (rendered by the stock `generic-structured` view); a built-in post-completion resolver renders
    a prose digest onto `step.output` so downstream steps read the investigation via `priorOutputs`.
    The old prose ROLE entry is removed.
  - **Read-only multi-repo checkouts** (`@cat-factory/server` + `@cat-factory/executor-harness`,
    image bump): the multi-repo fan-out gate now also fires for `bug-investigator`, and the
    container-explore job body threads `peerRepos` + the multi-repo prompt section. The harness
    gains a read-only `runMultiRepoExplore` path — it clones the primary repo PLUS every connected
    involved-service repo as SIBLING checkouts, runs the agent once at the workspace root, and
    makes NO edits / commits / PR (a read-only peer carries no `newBranch`/`pr`) — so a
    cross-service bug is traced across every repo it touches. `PeerRepoSpec.newBranch` is now
    optional (present for the coding fan-out, absent for the read-only one).
  - **Clarity gate seeding + auto-pass** (`@cat-factory/orchestration`): when a structured
    investigator ran upstream, the `clarity-review` gate seeds DETERMINISTICALLY from its triage —
    no reviewer LLM — auto-passing on `clarity === 'clear'` (advance, no human park, no
    notification) and seeding one blocking finding per `question` on `needs_clarification` (park
    for a human, exactly as an LLM reviewer pass would). Because the seed needs no model, the gate
    now activates whenever the clarity store is wired, and the review/incorporate/re-review LLM
    paths degrade gracefully when unwired. Mirrors the requirements-review auto-pass pattern.
  - **Tracker echo on park** (`@cat-factory/kernel` port + `@cat-factory/integrations`): a new
    best-effort `IssueWritebackProvider.postQuestions` echoes the open questions as a comment on
    the block's linked tracker issue when the gate parks — answers still arrive in-app (the tracker
    comment is an echo, not a channel). Not gated on the workspace writeback settings, and a
    tracker outage never fails the run.
  - **Conformance**: a two-facade suite drives the investigator → clarity gate flow — `clear`
    auto-passes straight through to the next step with the digest recorded, and
    `needs_clarification` parks one finding per question then resumes on dismiss-all + proceed.

  The runner image is bumped for the read-only multi-repo explore path; the three hand-maintained
  image-tag pins are synced.

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/contracts@0.96.0
  - @cat-factory/kernel@0.86.0
  - @cat-factory/integrations@0.65.0
  - @cat-factory/orchestration@0.71.0
  - @cat-factory/server@0.81.0
  - @cat-factory/gitlab@0.7.0
  - @cat-factory/node-server@0.72.0
  - @cat-factory/agents@0.34.0
  - @cat-factory/executor-harness@1.34.8

## 0.44.4

### Patch Changes

- 1f6d9fc: Cache the workspace GitHub repo projection through the app caching seam
  (caching-layer initiative, slice 3). A new `AppCaches.repoProjection` group cache
  (grouped and keyed by workspace id) serves the whole-projection re-list that the
  block→repo resolver (`buildResolveRepoTarget`) runs on every agent dispatch and
  every durable poll tick, replacing a live `repoProjectionRepository.list` per
  resolution with a per-workspace cached read.

  Coherence is invalidation-driven: every projection write drops the workspace
  group after it commits — `GitHubSyncService` (repo link / monorepo-flag / the
  exact-set write + tombstone / the link-time full re-stamp, fanned out per
  workspace), `BoardService.addServiceFromRepo` (the monorepo-flag write on the
  import-existing-repo path), `WebhookService` (the `installation_repositories`
  removed tombstone), and `ContainerRepoBootstrapper` (projecting a freshly
  bootstrapped repo). `GitHubSyncService.syncRepo` only invalidates on a `full`
  (link-time) pass — an incremental resync re-stamps `syncedAt` alone, which the
  resolver never reads, so invalidating there would only churn the cache. The
  installation lookup and the tree-depth-bounded block ancestry walk stay live, so
  a block reparent or a service repo-link change needs no cache invalidation.

  The cache is pass-through on the Cloudflare Worker's isolate-safe profile (our own
  mutable D1 state, no cross-isolate invalidation bus), so the Worker reads the
  projection live. Local mode is likewise pass-through: it seeds the projection via
  the out-of-process `link-repo` CLI and runs single-node with no invalidation bus,
  so an in-memory TTL'd entry could serve a pre-link projection. So the cache is
  active on the multi-node-capable Node facade only. Absent a cache (tests /
  harnesses) every resolve lists live, unchanged.

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0
  - @cat-factory/server@0.80.0
  - @cat-factory/integrations@0.64.0
  - @cat-factory/orchestration@0.70.1
  - @cat-factory/node-server@0.71.3
  - @cat-factory/agents@0.33.1
  - @cat-factory/gitlab@0.6.12
  - @cat-factory/executor-harness@1.34.4

## 0.44.3

### Patch Changes

- Updated dependencies [8eaa3f2]
  - @cat-factory/agents@0.33.0
  - @cat-factory/orchestration@0.70.0
  - @cat-factory/server@0.79.4
  - @cat-factory/node-server@0.71.2
  - @cat-factory/executor-harness@1.34.4

## 0.44.2

### Patch Changes

- Updated dependencies [e5ddaa4]
- Updated dependencies [6213771]
  - @cat-factory/kernel@0.84.0
  - @cat-factory/integrations@0.63.0
  - @cat-factory/agents@0.32.0
  - @cat-factory/orchestration@0.69.1
  - @cat-factory/node-server@0.71.1
  - @cat-factory/gitlab@0.6.11
  - @cat-factory/server@0.79.3
  - @cat-factory/executor-harness@1.34.4

## 0.44.1

### Patch Changes

- 9bac054: Caching initiative pilot (docs/initiatives/caching-layer.md, rows 0-1): introduce the
  app-level caching seam and adopt it for the per-dispatch fragment-catalog resolve.

  - New published package `@cat-factory/caching`: `createAppCaches(options)` builds the
    named, typed in-memory read-through caches (layered-loader `GroupLoader`, LRU + TTL)
    behind the new kernel `AppCaches`/`GroupCacheHandle` port. Redis is only ever an
    invalidation bus, never a data tier; with no notification factory injected the
    loaders are bare in-memory. The package deep-imports only layered-loader's in-memory
    machinery so ioredis never enters the module graph outside the Node facade's
    REDIS_URL-gated wiring.
  - `FragmentLibraryService.resolveCatalog` now reads through the fragment-catalog cache
    (group = workspace id), and every fragment write path — create / update / remove /
    createFromDocument / refresh / the run-time document-body re-resolve / fragment-source
    sync + unlink — invalidates it after commit (`invalidateCatalogTier`). The
    `ResolvedCatalogEntry` type moved to `@cat-factory/kernel` so the port can name it.
  - Node facade: `start()` builds the process-wide cache bag; when `REDIS_URL` is set,
    each cache gets its own `cat-factory:cache:<name>` notification channel (prefix
    overridable via the new `REDIS_CACHE_CHANNEL_PREFIX` env var) over dedicated
    ioredis publisher/subscriber clients, so peers drop their in-memory entries on every
    write — the same gating and resilience pattern as the realtime propagator. Local
    mode stays bare in-memory (single-node by construction).
  - Cloudflare Worker: wired with the ISOLATE-SAFE profile — the fragment catalog (mutable
    cross-instance state) is pass-through, since an isolate has no cross-isolate
    invalidation bus. Documented in the caching package README.
  - Conformance: new `defineCacheSuite` asserts write-then-read coherence of the resolved
    catalog on all three runtimes (Worker/Node/local).
  - Staleness probes for the upcoming git-backed slices, on layered-loader 14.5.3's new
    in-memory `isEntryStillCurrentFn` support: a cache profile may set
    `ttlLeftBeforeRefreshInMsecs`, and `GroupCacheHandle.get` accepts an optional per-read
    `isStillCurrent` probe — entries entering the refresh window get their TTL bumped when
    the probe reports the source unmoved, and fall back to a full background reload
    otherwise. `layered-loader` (maintainer-owned) is now excluded unversioned from the
    `minimumReleaseAge` supply-chain gate, like the `@cat-factory/*` namespace.

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0
  - @cat-factory/agents@0.31.0
  - @cat-factory/orchestration@0.69.0
  - @cat-factory/node-server@0.71.0
  - @cat-factory/gitlab@0.6.10
  - @cat-factory/integrations@0.62.1
  - @cat-factory/server@0.79.2
  - @cat-factory/executor-harness@1.34.4

## 0.44.0

### Minor Changes

- 6c1efd1: Docker Compose ephemeral envs: opt-in build-from-source mode.

  The Docker Compose environment backend was checkout-free / image-pull only and hard-rejected
  `build:`, host bind mounts, relative `env_file`, and `privileged`, so an app repo that builds
  its own images (e.g. a .NET + Angular + SQL Server stack) could not become a per-PR preview env.

  A new opt-in `build` mode (workspace handler `providerConfig.build`, mirrored advisory
  `ServiceProvisioning.composeBuild`) clones the PR head into a per-project working tree, writes
  the isolation-safe rewritten compose beside the original inside the checkout, and runs
  `docker compose build` + `up --wait`. In build mode `build:`, in-checkout relative bind mounts,
  and relative `env_file`s are honored. Image mode is unchanged and remains the default.

  Host-escape refusal is uniform across EVERY path-bearing reference, not just bind mounts: bind
  sources, `env_file`s, the `build:` context, and top-level `secrets:`/`configs:` `file:` sources are
  all run through `escapesCheckout`, which now also catches UNC/backslash-absolute paths, a
  separator-buried `../` source (`sub/../../../etc`, previously mis-read as a named volume), and an
  unresolved `${VAR}` interpolation (expands to an arbitrary host path at runtime). `include:` and
  cross-file `extends: { file }` are refused outright in both modes — the daemon merges those files
  from disk, so their services would otherwise slip a privileged container / host bind / pinned port
  past the parse-based guard. `privileged: true` stays refused.

  The `ComposeRuntime` seam gains optional `checkout`/`writeCheckoutFile` (implemented in the local
  facade via a shallow, token-authenticated git clone); `ProvisionEnvironmentRequest` gains a LAZY
  `clone` resolver (a thunk) invoked only by the build-mode provider that actually needs a working
  tree — so image-mode compose / custom / k8s-sync provisions no longer mint a short-lived VCS token
  they never use (reusing the deploy clone-target seam, memoized so one provision never mints twice).
  Build mode registers only on the docker-family local runtime — the documented runtime-bound
  exception. Build timeout is separate from the health-wait bound (`buildTimeoutMinutes`).

  Auto-detection is now content-aware: a compose stack that declares `build:` is detected and
  recommended in build-from-source mode (previously it was recommended blindly and then failed at
  provision time).

  The compose environment connect form gains an "Image source" selector (pull pre-built vs build
  from source) and a build-timeout field; the misleading "image-based stacks only" copy is removed.

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/contracts@0.95.0
  - @cat-factory/kernel@0.82.0
  - @cat-factory/integrations@0.62.0
  - @cat-factory/agents@0.30.5
  - @cat-factory/gitlab@0.6.9
  - @cat-factory/orchestration@0.68.1
  - @cat-factory/server@0.79.1
  - @cat-factory/node-server@0.70.1
  - @cat-factory/executor-harness@1.34.4

## 0.43.0

### Minor Changes

- 6edcce0: Personal-PAT repo access + fail-closed board redaction, and removal of the legacy repo→block link.

  - **Expand the repo picker with your own PAT (all facades).** A user's stored GitHub PAT
    (`user_secrets` kind `github_pat`) now surfaces repos it can reach beyond the workspace's GitHub
    App grant — even on the hosted Cloudflare/Node facades. Linking one creates a **personal service**
    (`GitHubRepo.linkedVia === 'user_pat'`); runs against it already use the initiator's PAT.
  - **Fail-closed frame redaction.** A service frame backed by a repo linked via another member's PAT
    is hidden from members who can't reach it: the board snapshot scrubs the frame to just its
    internal id + a "Permission denied" placeholder and drops its subtree. Access is a fail-closed
    per-user projection (`github_user_repo_access`), refreshed when a user enumerates their PAT repos
    and cleared when they remove their PAT — no live GitHub call on the snapshot path.
  - **New:** `github_repos.linked_via` column + `github_user_repo_access` table (mirrored D1 ⇄
    Drizzle, with a cross-runtime conformance suite); kernel `UserRepoAccessRepository` port and
    optional `GitHubClient.listReposForToken`/`getRepoForToken`; `Block.accessDenied` +
    `GitHubAvailableRepo.personal` wire fields.

  **Breaking (pre-1.0, no migration):** the legacy `github_repos.block_id` repo↔frame link is removed
  — the account-owned `Service` (`getByFrameBlock` → `repoGithubId`) is now the SOLE repo↔frame
  linkage. `RepoProjectionRepository.linkBlock` and `GitHubRepo.blockId` are gone; `resolveRepoTarget`
  now requires a `serviceRepository`; the `RepoBootstrapper` port's `linkRepoToBlock` is replaced by
  `projectBootstrappedRepo` (the caller binds the frame's `Service`). Existing rows' `block_id` is
  dropped; repos remain reachable through their `Service`.

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/contracts@0.94.0
  - @cat-factory/kernel@0.81.0
  - @cat-factory/integrations@0.61.0
  - @cat-factory/server@0.79.0
  - @cat-factory/orchestration@0.68.0
  - @cat-factory/node-server@0.70.0
  - @cat-factory/gitlab@0.6.8
  - @cat-factory/agents@0.30.4
  - @cat-factory/executor-harness@1.34.4

## 0.42.1

### Patch Changes

- @cat-factory/node-server@0.69.1

## 0.42.0

### Minor Changes

- dbde3b8: Cross-node WebSocket propagation for the Node facade (optional Redis adapter).

  The Node facade's real-time transport (`NodeRealtimeHub`) is an in-process, single-node socket
  registry: an event published on the node that processed a run only reaches browsers connected to
  THAT node. A horizontally-scaled Node deployment spreads browsers and background work across
  several nodes, so an event produced on one node has to reach a browser attached to another.

  This adds that reach as a **layered propagator** with pluggable cross-node adapters. Publishing an
  event fans it to the local hub AND to each configured adapter; an adapter carries it to peer nodes,
  which apply it to their own local hubs. **Redis pub/sub is the first adapter** — a Postgres
  LISTEN/NOTIFY or NATS adapter would implement the same `WebSocketPropagator` port with no other
  changes.

  - `ioredis` is an **optional dependency**, imported dynamically only when `REDIS_URL` is set. With
    no bus configured (single-replica Node, and **local mode**, which is always single-node) the
    layer is exactly the bare hub with zero overhead and no extra dependency — the default.
  - Config: `REDIS_URL` enables it; `REDIS_REALTIME_CHANNEL` (default `cat-factory:realtime`) and
    `REALTIME_NODE_ID` (default a random uuid, used to drop a node's own echoes) tune it.
  - The engine's event publisher now writes through a narrow `LocalEventSink` seam that both the bare
    hub and the layered propagator implement, so no other code differs between single- and multi-node.

  The Worker facade needs none of this: its real-time transport is a globally-addressed
  `WorkspaceEventsHub` Durable Object (one per workspace across the whole deployment), so cross-node
  propagation is inherent to the platform — this is a genuine Node-only concern, not a facade gap.

### Patch Changes

- Updated dependencies [dbde3b8]
  - @cat-factory/node-server@0.69.0

## 0.41.5

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/contracts@0.93.0
  - @cat-factory/kernel@0.80.0
  - @cat-factory/orchestration@0.67.0
  - @cat-factory/server@0.78.0
  - @cat-factory/node-server@0.68.0
  - @cat-factory/agents@0.30.3
  - @cat-factory/gitlab@0.6.7
  - @cat-factory/integrations@0.60.2
  - @cat-factory/executor-harness@1.34.4

## 0.41.4

### Patch Changes

- Updated dependencies [1d738f7]
  - @cat-factory/contracts@0.92.0
  - @cat-factory/orchestration@0.66.0
  - @cat-factory/server@0.77.0
  - @cat-factory/node-server@0.67.0
  - @cat-factory/agents@0.30.2
  - @cat-factory/gitlab@0.6.6
  - @cat-factory/integrations@0.60.1
  - @cat-factory/kernel@0.79.1
  - @cat-factory/executor-harness@1.34.4

## 0.41.3

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/contracts@0.91.0
  - @cat-factory/kernel@0.79.0
  - @cat-factory/integrations@0.60.0
  - @cat-factory/orchestration@0.65.0
  - @cat-factory/server@0.76.0
  - @cat-factory/node-server@0.66.0
  - @cat-factory/agents@0.30.1
  - @cat-factory/gitlab@0.6.5
  - @cat-factory/executor-harness@1.34.4

## 0.41.2

### Patch Changes

- Updated dependencies [0477068]
  - @cat-factory/server@0.75.2
  - @cat-factory/node-server@0.65.2
  - @cat-factory/executor-harness@1.34.4

## 0.41.1

### Patch Changes

- Updated dependencies [4a59f45]
  - @cat-factory/server@0.75.1
  - @cat-factory/node-server@0.65.1
  - @cat-factory/executor-harness@1.34.4

## 0.41.0

### Minor Changes

- b928904: Service connections Phase 2 — multi-env provisioning. A `deployer` step now fans out over
  the task's own service frame PLUS each connected involved-service frame, provisioning one
  ephemeral environment per frame (dispatched provider-before-consumer, parked between), each
  keyed per `(blockId, frameId)` so the fan-out no longer clobbers itself. Already-ready peers
  are injected into a later provision as `{{input.peerEnvUrls}}`, the agent context gains
  `involvedServices` (title + connection description + the peer's live env URL, read-time
  stale-filtered), and the Tester infra spec gains a `peerEnvironments` map so a cross-service
  integration test can reach a peer's real environment.

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/orchestration@0.64.0
  - @cat-factory/contracts@0.90.0
  - @cat-factory/kernel@0.78.0
  - @cat-factory/integrations@0.59.0
  - @cat-factory/agents@0.30.0
  - @cat-factory/server@0.75.0
  - @cat-factory/node-server@0.65.0
  - @cat-factory/executor-harness@1.34.4
  - @cat-factory/gitlab@0.6.4

## 0.40.8

### Patch Changes

- Updated dependencies [7fa7578]
- Updated dependencies [f372f4e]
  - @cat-factory/contracts@0.89.0
  - @cat-factory/kernel@0.77.0
  - @cat-factory/orchestration@0.63.0
  - @cat-factory/server@0.74.0
  - @cat-factory/node-server@0.64.2
  - @cat-factory/agents@0.29.1
  - @cat-factory/gitlab@0.6.3
  - @cat-factory/integrations@0.58.1
  - @cat-factory/executor-harness@1.34.2

## 0.40.7

### Patch Changes

- Updated dependencies [6917962]
  - @cat-factory/server@0.73.1
  - @cat-factory/executor-harness@1.34.2
  - @cat-factory/node-server@0.64.1

## 0.40.6

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/contracts@0.88.0
  - @cat-factory/kernel@0.76.0
  - @cat-factory/agents@0.29.0
  - @cat-factory/integrations@0.58.0
  - @cat-factory/server@0.73.0
  - @cat-factory/orchestration@0.62.0
  - @cat-factory/node-server@0.64.0
  - @cat-factory/gitlab@0.6.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.5

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/contracts@0.87.0
  - @cat-factory/kernel@0.75.0
  - @cat-factory/agents@0.28.0
  - @cat-factory/orchestration@0.61.0
  - @cat-factory/server@0.72.0
  - @cat-factory/node-server@0.63.0
  - @cat-factory/gitlab@0.6.1
  - @cat-factory/integrations@0.57.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.4

### Patch Changes

- Updated dependencies [cc924a9]
  - @cat-factory/agents@0.27.1
  - @cat-factory/orchestration@0.60.4
  - @cat-factory/server@0.71.2
  - @cat-factory/node-server@0.62.2
  - @cat-factory/executor-harness@1.34.2

## 0.40.3

### Patch Changes

- Updated dependencies [803fa76]
  - @cat-factory/server@0.71.1
  - @cat-factory/executor-harness@1.34.2
  - @cat-factory/node-server@0.62.1

## 0.40.2

### Patch Changes

- 7b8b04f: Pin the local browsable-preview host port to the app's serve port so the preview origin is a deterministic `http://localhost:<servePort>` — the same origin `frontendOriginsForService` injects into a bound backend's CORS allow-list. Previously the preview published to an ephemeral host port and formed its URL via `docker port` (`http://127.0.0.1:<random>`), a different origin, so a developer browsing the preview was CORS-blocked when the app called the live backend. `RunContainerSpec.publishPorts` gains an optional pinned `host`, and a new `ContainerRuntimeAdapter.publishesToLocalhost` flag distinguishes the Docker family (pinnable localhost origin) from Apple `container` (reached at the container's own IP).

## 0.40.1

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0
  - @cat-factory/contracts@0.86.0
  - @cat-factory/agents@0.27.0
  - @cat-factory/server@0.71.0
  - @cat-factory/gitlab@0.6.0
  - @cat-factory/node-server@0.62.0
  - @cat-factory/integrations@0.57.1
  - @cat-factory/orchestration@0.60.3
  - @cat-factory/executor-harness@1.34.2

## 0.40.0

### Minor Changes

- 7fd6a19: Import-from-repo picker: find and link accessible repos in realtime instead of enumerating the whole installation and filtering in memory. The old path listed every installation repo (capped at a bounded page count) then substring-filtered client-of-the-cap — so on a wide App install a repo beyond that window returned "no matches" for a repo you actually had access to, and every keystroke re-fetched all pages. Two new `GitHubClient` primitives fix it end to end: `searchInstallationRepos` issues one bounded, account-scoped GitHub search per query, and `getRepoById` point-reads the picked repo by id when linking it (so a repo surfaced by search from beyond the enumeration cap links instead of spuriously 409-ing). Blank-query browse-all is unchanged; PAT (local) and GitLab connections filter their bounded token listing. When an installation has no resolvable account to scope the GitHub search to, the App adapter filters its own bounded listing rather than running an unscoped global search (which would surface arbitrary, unlinkable public repos).

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0
  - @cat-factory/server@0.70.0
  - @cat-factory/integrations@0.57.0
  - @cat-factory/gitlab@0.5.0
  - @cat-factory/agents@0.26.18
  - @cat-factory/orchestration@0.60.2
  - @cat-factory/node-server@0.61.2
  - @cat-factory/executor-harness@1.34.2

## 0.39.2

### Patch Changes

- Updated dependencies [96cff56]
  - @cat-factory/executor-harness@1.34.2

## 0.39.1

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/contracts@0.85.0
  - @cat-factory/kernel@0.72.0
  - @cat-factory/orchestration@0.60.1
  - @cat-factory/agents@0.26.17
  - @cat-factory/gitlab@0.4.45
  - @cat-factory/integrations@0.56.5
  - @cat-factory/server@0.69.1
  - @cat-factory/node-server@0.61.1
  - @cat-factory/executor-harness@1.34.0

## 0.39.0

### Minor Changes

- b78adf5: Private package registries: workspace-scoped npm registry credentials (npm private
  orgs + GitHub Packages) that agent containers use to resolve private dependencies on
  checkout.

  - **Storage**: one `package_registry_connections` row per workspace (D1 migration 0034
    ⇄ Drizzle mirror) holding a single sealed JSON array of entries
    (`{ id, ecosystem: 'npm', vendor: 'npmjs' | 'github-packages', scopes, token }`,
    cipher tag `cat-factory:package-registries`) plus a non-secret summary (vendor +
    scopes + token tail). Ecosystem-discriminated so pip/maven/cargo are later additive.
  - **API**: `GET|POST /workspaces/:ws/package-registries`, `DELETE …/:entryId`
    (`PackageRegistriesController`, 503 when the module is unwired). Tokens are
    write-only — the list view never returns them; edit = delete + re-add. Only one
    entry per vendor is allowed (a 409 otherwise): the harness renders a single
    host-keyed `_authToken` per registry, so a duplicate token would be silently
    dropped — put every scope for a vendor on its one entry. Tokens are validated as a
    single opaque printable-ASCII string (no spaces/control characters) so a token can't
    inject extra `~/.npmrc` lines.
  - **Dispatch**: `ContainerAgentExecutor` + `ContainerRepoBootstrapper` accept a
    `resolvePackageRegistries` seam (wired in both facades from the same store) and
    forward the decrypted entries as a `packageRegistries` field on every container job
    body, like `ghToken`. The registry host is derived backend-side from the fixed
    vendor set. A resolution failure fails the dispatch rather than silently running
    without auth. The agent-context snapshot's allow-list projection excludes the field.
  - **UI**: a "Private package registries" panel in the Integrations hub
    (`PackageRegistriesPanel.vue`) — vendor preset + scopes + write-only token, entries
    listed from the redacted summary.
  - **Conformance**: a new suite section asserts add → redacted list → decrypted
    dispatch resolution → remove identically on D1 and Postgres.

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
- Updated dependencies [b78adf5]
  - @cat-factory/contracts@0.84.0
  - @cat-factory/orchestration@0.60.0
  - @cat-factory/kernel@0.71.0
  - @cat-factory/server@0.69.0
  - @cat-factory/executor-harness@1.34.0
  - @cat-factory/node-server@0.61.0
  - @cat-factory/agents@0.26.16
  - @cat-factory/gitlab@0.4.44
  - @cat-factory/integrations@0.56.4

## 0.38.12

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/contracts@0.83.0
  - @cat-factory/kernel@0.70.2
  - @cat-factory/orchestration@0.59.2
  - @cat-factory/server@0.68.2
  - @cat-factory/node-server@0.60.2
  - @cat-factory/agents@0.26.15
  - @cat-factory/gitlab@0.4.43
  - @cat-factory/integrations@0.56.3
  - @cat-factory/executor-harness@1.32.0

## 0.38.11

### Patch Changes

- 0d51638: Boundary hardening:

  - **Local mode** now enforces a minimum strength on the required crypto secrets at config
    load: `AUTH_SESSION_SECRET` must be ≥32 characters (local mode defaults the auth gate open,
    so a weak secret would leave session/proxy/machine tokens forgeable) and `ENCRYPTION_KEY`
    must decode to a full 32-byte key (surfaced early instead of deep in the first cipher build).
  - **GitHub webhook verifier** fails closed when the webhook secret is unset (previously it would
    import an empty HMAC key and compare), matching the GitLab verifier.
  - **CORS** no longer reflects an arbitrary Origin by default outside development: an unset
    `CORS_ALLOWED_ORIGINS` reflects any origin only when `ENVIRONMENT` is an explicitly
    recognised development value (`development`/`dev`/`test`/`testing`/`local`/`e2e`). An
    unset, unknown, or production `ENVIRONMENT` default-denies (fails safe), so a deployment
    that forgets BOTH `ENVIRONMENT` and `CORS_ALLOWED_ORIGINS` no longer silently reflects.
    An explicit `*` still opts into reflect-all.

- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
- Updated dependencies [0d51638]
  - @cat-factory/integrations@0.56.2
  - @cat-factory/server@0.68.1
  - @cat-factory/node-server@0.60.1
  - @cat-factory/kernel@0.70.1
  - @cat-factory/orchestration@0.59.1
  - @cat-factory/executor-harness@1.32.0
  - @cat-factory/agents@0.26.14
  - @cat-factory/gitlab@0.4.42

## 0.38.10

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/executor-harness@1.32.0
  - @cat-factory/kernel@0.70.0
  - @cat-factory/orchestration@0.59.0
  - @cat-factory/server@0.68.0
  - @cat-factory/node-server@0.60.0
  - @cat-factory/agents@0.26.13
  - @cat-factory/gitlab@0.4.41
  - @cat-factory/integrations@0.56.1

## 0.38.9

### Patch Changes

- Updated dependencies [5ce03c6]
- Updated dependencies [5ce03c6]
  - @cat-factory/contracts@0.82.0
  - @cat-factory/integrations@0.56.0
  - @cat-factory/server@0.67.0
  - @cat-factory/executor-harness@1.31.12
  - @cat-factory/agents@0.26.12
  - @cat-factory/gitlab@0.4.40
  - @cat-factory/kernel@0.69.8
  - @cat-factory/orchestration@0.58.1
  - @cat-factory/node-server@0.59.4

## 0.38.8

### Patch Changes

- Updated dependencies [7f9d215]
- Updated dependencies [05d1b08]
  - @cat-factory/kernel@0.69.7
  - @cat-factory/orchestration@0.58.0
  - @cat-factory/server@0.66.7
  - @cat-factory/node-server@0.59.3
  - @cat-factory/integrations@0.55.0
  - @cat-factory/agents@0.26.11
  - @cat-factory/gitlab@0.4.39
  - @cat-factory/executor-harness@1.31.10

## 0.38.7

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

- Updated dependencies [9577c4a]
- Updated dependencies [4955639]
  - @cat-factory/executor-harness@1.31.10
  - @cat-factory/node-server@0.59.2
  - @cat-factory/agents@0.26.10
  - @cat-factory/orchestration@0.57.7
  - @cat-factory/server@0.66.6

## 0.38.6

### Patch Changes

- Updated dependencies [4a7a3f1]
  - @cat-factory/contracts@0.81.3
  - @cat-factory/server@0.66.5
  - @cat-factory/orchestration@0.57.6
  - @cat-factory/agents@0.26.9
  - @cat-factory/gitlab@0.4.38
  - @cat-factory/integrations@0.54.3
  - @cat-factory/kernel@0.69.6
  - @cat-factory/node-server@0.59.1
  - @cat-factory/executor-harness@1.31.8

## 0.38.5

### Patch Changes

- 6347d0e: Fix opaque "Failed to open PR (HTTP 422): No commits between ..." run failure when a
  coding run resumes a work branch that has nothing ahead of its base (e.g. its earlier PR
  was merged with a merge commit, leaving the branch reachable from base and its best-effort
  delete skipped).

  - `runCodingAgent` no longer treats a resumed branch as work unconditionally: when the
    branch has no new commits this pass, it confirms the branch is actually ahead of the PR
    base (new `branchAheadOfBase`, tri-state so an undeterminable result keeps the prior
    resume-is-work behaviour) and records a clean no-op otherwise.
  - `openPullRequest` now maps GitHub's `422 "No commits between ..."` to a no-op (returns
    `null`) instead of a hard `HarnessFailure`, as a backstop.

  Image-bumping: `@cat-factory/executor-harness` → 1.31.7 with the three runner-image pins
  synced.

- Updated dependencies [4e82496]
- Updated dependencies [6347d0e]
- Updated dependencies [6439181]
- Updated dependencies [6347d0e]
  - @cat-factory/node-server@0.59.0
  - @cat-factory/server@0.66.4
  - @cat-factory/executor-harness@1.31.8

## 0.38.4

### Patch Changes

- Updated dependencies [6243bea]
  - @cat-factory/contracts@0.81.2
  - @cat-factory/integrations@0.54.2
  - @cat-factory/server@0.66.3
  - @cat-factory/agents@0.26.8
  - @cat-factory/gitlab@0.4.37
  - @cat-factory/kernel@0.69.5
  - @cat-factory/orchestration@0.57.5
  - @cat-factory/node-server@0.58.6
  - @cat-factory/executor-harness@1.31.6

## 0.38.3

### Patch Changes

- Updated dependencies [fc8df61]
- Updated dependencies [fc8df61]
  - @cat-factory/agents@0.26.7
  - @cat-factory/server@0.66.2
  - @cat-factory/node-server@0.58.5
  - @cat-factory/orchestration@0.57.4
  - @cat-factory/executor-harness@1.31.6

## 0.38.2

### Patch Changes

- 9468b90: Force fully non-interactive git auth in the harness so native local mode never triggers a Git
  Credential Manager popup. Every git invocation now empties the host credential-helper list
  (`-c credential.helper=`) and disables interactive credential backends, so git falls back to the
  harness's own askpass PAT instead of the host's GCM — which on Windows either stole focus with a
  stray auth window or, when modal, hung the git command (clone/fetch/push) until it timed out. A
  per-command git timeout is now surfaced as an explicit stall (naming the likely causes) rather
  than a contentless "Command failed", and a genuine git failure now folds in git's stderr.

  Bumps the executor-harness image tag (and the matched `RECOMMENDED_HARNESS_IMAGE` pin) to 1.31.5.

- Updated dependencies [9468b90]
  - @cat-factory/executor-harness@1.31.6

## 0.38.1

### Patch Changes

- Updated dependencies [986ed0e]
  - @cat-factory/executor-harness@1.31.4

## 0.38.0

### Minor Changes

- 063ef2b: Local native mode: default `LOCAL_HARNESS_ENTRY` to a bundled harness (no more manual path)

  Native execution (`LOCAL_NATIVE_AGENTS`) previously required `LOCAL_HARNESS_ENTRY` to be set
  to a filesystem path to the executor-harness server entry, which only existed inside a full
  monorepo checkout — so consumers installing `@cat-factory/*` from npm had no stable target.

  - `@cat-factory/executor-harness` is now **published** (was `private`). Its `.` export is the
    zero-dependency `dist/server.js` HTTP server that native mode spawns via `node <entry>`.
  - `@cat-factory/local-server` now depends on it and **auto-resolves** the entry via
    `require.resolve('@cat-factory/executor-harness')` when `LOCAL_HARNESS_ENTRY` is unset — so a
    fresh install runs native mode out of the box, mirroring how an unset `LOCAL_HARNESS_IMAGE`
    falls back to the pinned recommended image. Setting `LOCAL_HARNESS_ENTRY` still overrides it
    (for a custom or source-checkout build).
  - `cat-factory init` (`@cat-factory/cli`) no longer treats the entry as required: it is written
    commented (optional override) and the "set it before starting" warnings are gone.

### Patch Changes

- Updated dependencies [2a91615]
- Updated dependencies [063ef2b]
- Updated dependencies [063ef2b]
  - @cat-factory/contracts@0.81.1
  - @cat-factory/orchestration@0.57.3
  - @cat-factory/integrations@0.54.1
  - @cat-factory/server@0.66.1
  - @cat-factory/executor-harness@1.31.2
  - @cat-factory/agents@0.26.6
  - @cat-factory/gitlab@0.4.36
  - @cat-factory/kernel@0.69.4
  - @cat-factory/node-server@0.58.4

## 0.37.3

### Patch Changes

- Updated dependencies [67d3876]
  - @cat-factory/contracts@0.81.0
  - @cat-factory/integrations@0.54.0
  - @cat-factory/server@0.66.0
  - @cat-factory/agents@0.26.5
  - @cat-factory/gitlab@0.4.35
  - @cat-factory/kernel@0.69.3
  - @cat-factory/orchestration@0.57.2
  - @cat-factory/node-server@0.58.3

## 0.37.2

### Patch Changes

- 63cf6de: Performance: batch reads, parallelize independent awaits, and push work into SQL on hot paths.

  - `GET /workspaces/:id` (the board-load endpoint) now fetches its ~15 independent snapshot
    ingredients concurrently instead of serially, so its latency is the slowest read rather
    than the sum of every round-trip; the create-workspace route parallelizes its spend +
    infra-setup reads the same way.
  - Agent-context reference lookups (Jira keys / GitHub refs / URLs) run concurrently on the
    per-step dispatch path; run-start model-default resolutions run concurrently per agent kind.
  - New batched port methods, mirrored on both runtimes with conformance coverage:
    `BlockRepository.findByIds` (cross-workspace dependency resolution — one chunked query
    instead of a point-read per id, also allow-listed for mothership mode),
    `NotificationRepository.escalateStaleOpen` (the escalation sweep is now one
    `UPDATE … RETURNING` statement instead of a load-filter-upsert loop), and
    `GitHubInstallationRepository.listByInstallationIds` (connect-UI annotation).
  - GitHub webhook fan-out resolves linked workspaces via the existing batched
    `linkedWorkspaces` read instead of a per-workspace point-read on every delivery.
  - The Node Drizzle GitHub projections write chunked multi-row upserts (matching the D1
    twins' `db.batch`) instead of one round-trip per row, and their list reads run
    `ORDER BY`/`LIMIT` in SQL (NULLS LAST for D1 parity) instead of sorting full result
    sets in JS.
  - `autoStartDependents` hoists the invariant workspace-pipeline read out of its loop and
    stops re-fetching blocks it already holds.
  - Session/WS-ticket/machine-token verification reuses a memoized `HmacSigner` per secret,
    so `crypto.subtle.importKey` no longer runs on every request (`signerFor` export).
  - The Cloudflare Workflows drivers (execution / bootstrap / env-config-repair) build the
    DI container once per wake instead of once per `step.do` poll tick.

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2
  - @cat-factory/orchestration@0.57.1
  - @cat-factory/contracts@0.80.1
  - @cat-factory/node-server@0.58.2
  - @cat-factory/integrations@0.53.2
  - @cat-factory/server@0.65.2
  - @cat-factory/agents@0.26.4
  - @cat-factory/gitlab@0.4.34

## 0.37.1

### Patch Changes

- 120de05: feat(testing): pipeline-builder toggle + Test Report surfacing for the test quality companion (PR 2)

  Completes the test quality-control (QC) companion (see
  `docs/initiatives/tester-quality-companion.md`) with its authoring + observability surfaces:

  - **Pipeline builder**: a per-Tester-step toggle (enabled by default) turns the QC companion
    off, and an optional estimate-gating panel runs the coverage audit only on tasks whose
    estimate clears a threshold (mirroring the companion-gating panel). The estimator-required
    hint now covers QC gating too.
  - **Test Report window**: a "Coverage review" section renders each QC verdict (adequate /
    gaps-found, the reviewer's feedback + concrete gaps, model, timestamp) plus the loop budget
    and a "budget spent" badge — so a report that greenlit only after a QC-driven re-run shows
    why it looped.
  - **Persistence fix**: the pipeline create/update/clone API + `PipelineService` now thread
    `testerQuality` (and the sibling `followUps`, which had the same latent gap) end-to-end, so a
    custom pipeline's builder toggle actually persists instead of being silently stripped by the
    request-body validator. This includes the persistence layer itself: new `follow_ups` +
    `tester_quality` JSON columns on the `pipelines` table, mirrored D1 (migration
    `0032_pipeline_companion_toggles`) ⇄ Drizzle (schema + generated migration), written by both
    repos and read by the shared `rowToPipeline` mapper. A QC estimate gate is validated like
    companion gating (a threshold must be set and a `task-estimator` must run earlier).
  - **Conformance**: the full QC loop (audit → loop the Tester on gaps → conclude on an adequate
    report) is now driven through an injected deterministic reviewer on every runtime, asserting
    the verdicts + counters persist identically across D1 and Drizzle. A separate round-trip
    assertion saves a custom pipeline with a `followUps` opt-out + a gated `testerQuality` config
    and re-reads it from the store, so the new columns can't silently drop the toggles on either
    runtime.

  All new user-facing copy is translated across every shipped locale.

- Updated dependencies [120de05]
  - @cat-factory/contracts@0.80.0
  - @cat-factory/orchestration@0.57.0
  - @cat-factory/kernel@0.69.1
  - @cat-factory/node-server@0.58.1
  - @cat-factory/agents@0.26.3
  - @cat-factory/gitlab@0.4.33
  - @cat-factory/integrations@0.53.1
  - @cat-factory/server@0.65.1

## 0.37.0

### Minor Changes

- dcc8b32: Browsable frontend preview — transport dispatch + `PreviewService` + controller + stop (slice 5c of
  the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  Wire the harness `preview` mode (slice 5b) end to end: a `frontend` frame can now be built and
  served on a HOST-reachable URL for a browsable preview, and stopped again. New pieces:

  - A new optional `PreviewTransport` kernel port — the per-runtime half that publishes a served
    app's port to an ephemeral host port and keeps the container alive past the build job. The local
    facade wires the real one over its Docker/Podman/OrbStack/Colima/Apple adapter (a second
    published port read back with `docker port` / the container IP); the Worker never wires it.
  - A runtime-neutral `PreviewService` (start / get / stop) that persists the running preview like an
    ephemeral `environments` row keyed by the `frontend` frame (reusing the existing table + soft-delete
    stop path — no new migration), plus a `PreviewController` mounting
    `GET|POST|DELETE /workspaces/:ws/frames/:frameId/preview`, gated server-side on the
    `frontendPreview.supported` capability (503 on the Worker).
  - The cross-runtime conformance suite drives the full start → serve → stop lifecycle on both Postgres
    runtimes with a fake transport, pinning the ephemeral-env-row persistence parity.

  Notes:

  - `frontendPreview.supported` now tracks whether a preview transport is actually wired: a stock Node
    build (runner pool, no host-port-publish primitive) advertises `false`, so the SPA never offers a
    Start button that would 503; local mode (and any facade injecting a `previewTransport`) advertises
    `true`.
  - Preview rows share the `environments` table but carry a dedicated `preview` discriminator (outside
    `provisionTypeSchema`), so the environment subsystem filters them out of its generic listing +
    block-resolution paths — a preview never leaks into the deployer-env UI or tester env resolution.
  - `PreviewService.get` re-polls a `ready` preview so a vanished/evicted container stops reporting a
    stale, unreachable URL (it flips to `failed`); a healthy preview whose URL merely can't be
    re-derived keeps its authoritative persisted URL.

  Local/node differentiator; the SPA surface (the clickable URL + a stop button on the frame inspector)
  lands in slice 5d. The harness is unchanged (no runner-image bump).

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/orchestration@0.56.0
  - @cat-factory/node-server@0.58.0
  - @cat-factory/integrations@0.53.0
  - @cat-factory/contracts@0.79.0
  - @cat-factory/kernel@0.69.0
  - @cat-factory/server@0.65.0
  - @cat-factory/agents@0.26.2
  - @cat-factory/gitlab@0.4.32

## 0.36.4

### Patch Changes

- Updated dependencies [16ee6cc]
- Updated dependencies [16ee6cc]
  - @cat-factory/orchestration@0.55.1
  - @cat-factory/contracts@0.78.1
  - @cat-factory/kernel@0.68.1
  - @cat-factory/server@0.64.4
  - @cat-factory/node-server@0.57.2
  - @cat-factory/agents@0.26.1
  - @cat-factory/gitlab@0.4.31
  - @cat-factory/integrations@0.52.2

## 0.36.3

### Patch Changes

- Updated dependencies [6da6637]
  - @cat-factory/server@0.64.3
  - @cat-factory/node-server@0.57.1

## 0.36.2

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/contracts@0.78.0
  - @cat-factory/kernel@0.68.0
  - @cat-factory/agents@0.26.0
  - @cat-factory/orchestration@0.55.0
  - @cat-factory/node-server@0.57.0
  - @cat-factory/gitlab@0.4.30
  - @cat-factory/integrations@0.52.1
  - @cat-factory/server@0.64.2

## 0.36.1

### Patch Changes

- Updated dependencies [08be94c]
  - @cat-factory/orchestration@0.54.1
  - @cat-factory/server@0.64.1
  - @cat-factory/node-server@0.56.1

## 0.36.0

### Minor Changes

- 6c51e31: Run inline LLM steps through the ambient Claude Code / Codex CLI in local mode, and refuse to
  start a pipeline whose model preset can't satisfy every step.

  - **Local inline harness execution**: with native agents enabled (`LOCAL_NATIVE_AGENTS`), the
    inline steps (requirements reviewer, brainstorm, task-estimator, inline document kinds) now run
    on the developer's ambient `claude`/`codex` subscription CLI as a host subprocess — the inline
    analogue of the existing container ambient-auth path. Previously a subscription-only preset
    (e.g. Claude Opus) degraded these inline steps to the routing default and failed against an
    unconfigured provider (the confusing "requirements reviewer (qwen:qwen3-max) failed" error).
    Implemented via a new AI-SDK `CliInlineLanguageModel` (`@cat-factory/agents`) wired into the
    local model provider; `inlineModelRef` now keeps an ambient-eligible harness ref instead of
    degrading it. The consensus executor (an inline path) threads the same predicate, so a
    subscription-only consensus participant model is kept inline in local mode too.
  - **Preset satisfiability guard**: the pipeline-start guard now checks INLINE steps against
    inline-usability, not just container-usability. A subscription-only model that satisfies the
    container agents but can't run the inline reviewers (and this deployment has no inline harness)
    is refused up front with a new `preset_unsatisfiable` conflict reason and an actionable message,
    instead of failing mid-run. The SPA maps the new reason to a translated toast.

  Breaking: `inlineModelRef` gains an optional third `opts` argument; the `ConflictReason` wire
  union gains `preset_unsatisfiable`.

### Patch Changes

- 9e93fe8: feat(frontend): `frontendPreview` infrastructure capability + preview-toggle gate (slice 5a of the
  frontend-preview + in-context UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A browsable frontend preview keeps a built app served on a host-reachable URL, which needs a
  long-lived host serve — so it is a genuine local/node differentiator. The Worker only runs the
  self-contained UI-test container (built, tested, and torn down with the run), so it cannot host one.
  Until now the `frontendConfig.previewEnabled` toggle (shipped as scaffolding in slice 2) was offered
  on every runtime and read by nothing.

  This lands the capability that makes the toggle honest, and gates it in the SPA where a preview can't
  run. The long-lived build+serve-kept-alive mechanic itself is the remaining slice 5b.

  - **New capability axis** on the `/auth/config` `infrastructureCapabilities` descriptor:
    `frontendPreview: { supported: boolean }`, built by the shared `buildInfrastructureCapabilities`
    so all three facades emit the same shape. Value is a per-facade differentiator — Worker `false`,
    Node + local `true`.
  - **SPA gate**: `FrontendConfig.vue` reads `infrastructure.frontendPreview.supported` (defaulting
    true until the auth handshake resolves) and disables the `previewEnabled` checkbox with an
    explanatory hint (`inspector.frontendConfig.previewUnsupported`, translated across every locale)
    when unsupported. The stored config is left untouched, so a `previewEnabled` flag authored on
    local/node is simply inert when served from the Worker (no migration; pre-1.0 breakage rules).
  - **Conformance** pins that the axis is present + boolean on every facade (its value is a
    differentiator); the Worker `auth.spec` pins `false`, the Node `auth-gate.spec` pins `true`.

- 9b26ff1: feat(frontend): key a deployer's ephemeral env by its service FRAME so a live `service` binding
  resolves (slice 4b of the frontend-preview + in-context UI-testing initiative,
  docs/initiatives/frontend-preview-ui-testing.md).

  A `frontend` frame's `service` binding names a service FRAME id, but a `deployer` keyed its
  ephemeral env only under the task `block_id` it ran on — so `resolveFrontendConfig`'s
  `handle === serviceBlockId` match never hit and a live-service binding fell back to WireMock even
  when the backend's env was up (the deferred keying gap slices 3/4 flagged).

  The env now also records the resolved service `frame_id` (the deployer's block walked up to its
  enclosing frame), and the frontend binding resolution matches handles on THAT. The task-keyed
  `block_id` — and the same-block deployer→tester env projection that reads it — is unchanged; this
  is an additive column, not a re-key.

  - **New `frame_id` column** on `environments`, mirrored D1 (`0030_environment_frame_id.sql`) ⇄
    Drizzle (`environments.frame_id` + generated migration), threaded through `EnvironmentRecord`,
    the `EnvironmentHandle` wire shape, and both registry repos.
  - **Keying**: `RunDispatcher.deployerProvisionArgs` resolves the service frame id via the shared
    frame walk and passes it on `ProvisionArgs.frameId`; the provisioning service persists it on both
    the provisioned and the failed-record paths.
  - **Resolution**: `AgentContextBuilder.resolveFrontendConfig` indexes the single `listHandles` read
    by `handle.frameId` (still one batch read, no per-binding point read), so a `service` binding
    resolves to its live ephemeral URL — and the frontend UI-test infra gate is satisfied instead of
    refusing the run.
  - **Conformance**: a new cross-runtime assertion provisions a service frame's env via a `deployer`,
    then a UI-tester run against a frontend bound to that frame STARTS (the mirror of the existing
    no-live-service refusal), pinning both the `frame_id` D1 ⇄ Drizzle round-trip and the
    frame-keyed resolution.

- e0aa45e: Self-contained frontend UI-test infra (slice 3 of the frontend-preview + in-context
  UI-testing initiative, docs/initiatives/frontend-preview-ui-testing.md).

  A `tester-ui` running on a task under a `type: 'frontend'` frame now builds and serves the
  frontend, stands WireMock up for its OTHER backend upstreams, and drives the UI tests against
  the two together — all as localhost processes in the one container (no Docker-in-Docker), so
  it works on Cloudflare and Apple `container` too.

  - **Harness**: a new `frontend` variant of the tester infra spec (`kind: 'frontend'`) that
    installs, builds (injecting the resolved backend URLs at build time, or a `window.env` shim
    for runtime injection), starts WireMock seeded from the frontend repo's mappings dir, serves
    the built app, health-checks it, and points the agent at it. The `ui` image gains pnpm/yarn
    (corepack), a static file server (`serve`), and a headless JRE + WireMock standalone
    (executor-harness image bumped to 1.28.0).
  - **Backend**: `AgentRunContext` carries a resolved `frontend` slice (the frame's
    `frontendConfig` plus its backend bindings resolved to concrete upstreams — a bound service's
    live ephemeral env URL for the service under test, else a WireMock mock). The engine's
    `testerInfraSpec` turns it into the harness spec, and the tester-infra start gate refuses a
    frontend UI test only when it binds a live-backend `service` with none actually live (a
    mock-only / no-backend frontend passes — WireMock + the static server fully stand it up).
    Empty-envVar bindings are filtered.
  - **Hardening** (review follow-ups): the harness's WireMock / serve child processes get an
    `'error'` listener (a spawn failure is captured, not an uncaught crash of the job server),
    WireMock is now health-checked alongside the served app (a dead mock becomes a prompt note,
    not a test-time ECONNREFUSED), reserved env-var names (`PATH`, `NODE_OPTIONS`, …) are dropped
    from the injected build env, and a configured `servePort` that collides with a reserved
    in-container port (8080 harness job server, 8089 WireMock) falls back to the default. The
    inspector's servePort placeholder now shows 4173. Shared `pathExists` / log-capture helpers
    are de-duplicated in the harness. The frontend UI-test gate's batch env read
    (`environmentRegistryRepository.listByWorkspace`) is added to the mothership remote-persistence
    allow-list so the gate resolves in mothership mode.
  - **Hardening (second review round)**: the frontend stand-up now feeds the run's inactivity
    watchdog with a heartbeat while it installs/builds/serves — a real frontend's `install` +
    `build` can exceed the 10-min inactivity window, and the (activity-silent) stand-up would
    otherwise be killed mid-build with a misleading "likely hung". `serveMode: 'command'` now also
    forwards the resolved backend URLs (`env`) to the serve process, so a runtime-reading
    dev/preview server sees them (previously only `PORT` was passed). Reserved env-var names are
    now also dropped in the backend infra-spec builder (defence in depth, not just the harness).
    The `mockMappingsPath` docs + inspector hint clarify WireMock's `--root-dir` layout (stubs go
    in a `mappings/` subfolder), and the env-injection hint notes the build-tool prefix caveat
    (e.g. Vite only exposes `VITE_*`). The UI-tester prompt flags a live-backend CORS failure as an
    infra gap rather than an app defect.
  - **Hardening (third review round)**: the frontend stand-up now runs in the run's SERVICE
    SUBTREE (`workDir`), not the clone root — a monorepo frontend's `package.json` / `outputDir` /
    `mocks/` live under its own subdirectory, so installing, building, serving and seeding WireMock
    from the repo root would have targeted the wrong directory (the docker-compose stand-up still
    runs at the root, where its repo-relative `composePath` resolves). The harness now bounds
    frontend `servePort` / `wiremockPort` to 1..65535 at its untrusted-body boundary (an
    out-of-range port can never bind, so it falls back to the default). The reserved-env filter —
    in BOTH the harness parse and the backend infra-spec builder — grows the `NODE_EXTRA_CA_CERTS`
    / `BASH_ENV` / `ENV` / `SHELL` / `IFS` names plus the `npm_config_*` and `GIT_*` FAMILIES, so a
    binding that reconfigures the package manager, git, or the TLS trust store during the build is
    dropped rather than injected. Runtime env injection under `serveMode: 'command'` now warns
    (the `window.env` shim is only served in static mode; the forwarded `env` covers the command
    server), and a failed shim write is logged instead of silently swallowed. `AgentContextBuilder`
    gains `resolveServiceFrame` so the frontend-config resolution reuses the frame row the walk
    already loaded instead of re-fetching it. Fixes the `Lint & format` failure (an unnecessary
    `?? {}` empty-fallback spread in the serve env).
  - **Hardening (fourth review round)**: the reserved-env family filter (`npm_config_*` / `GIT_*`)
    now matches **case-insensitively** in BOTH the harness parse and the backend infra-spec builder —
    npm reads its config env with a case-insensitive `/^npm_config_/i`, so `NPM_CONFIG_REGISTRY`
    (upper/mixed case) is honoured just like `npm_config_registry`; a case-sensitive prefix match
    would have let the upper-cased form slip through and reconfigure the package manager during the
    build. The frontend serve/WireMock health-check now also aborts an in-flight probe on the run's
    own abort signal (not just the per-attempt timeout). The stale `envInjectionHint` translation is
    synced across all locales, and the missed-translation class is now guarded in CI (see the app
    note). The agent prompt-note assembly and the frontend `installCommand` are extracted as pure
    helpers with unit coverage.

  `@cat-factory/app`: sync the `envInjectionHint` hint across all locales (the `en` update noting
  the build-tool prefix caveat, e.g. Vite only exposes `VITE_*`, had been left untranslated). A new
  CI **locale-parity guard** now fails a PR that changes an `en.json` message key without changing
  the same key in every other locale, so translations can't silently go stale.

  BREAKING (pre-1.0): the harness `AgentInfraSpec` is now a discriminated union
  (`service` | `frontend`); the default backend-service tester shape is unchanged.

- Updated dependencies [9e93fe8]
- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [edf4e69]
- Updated dependencies [f21279e]
- Updated dependencies [ab7d589]
- Updated dependencies [6c51e31]
- Updated dependencies [456a992]
- Updated dependencies [1d2684f]
- Updated dependencies [33687cf]
  - @cat-factory/contracts@0.77.0
  - @cat-factory/server@0.64.0
  - @cat-factory/node-server@0.56.0
  - @cat-factory/kernel@0.67.0
  - @cat-factory/integrations@0.52.0
  - @cat-factory/orchestration@0.54.0
  - @cat-factory/agents@0.25.0
  - @cat-factory/gitlab@0.4.29

## 0.35.6

### Patch Changes

- Updated dependencies [3135ae8]
  - @cat-factory/gitlab@0.4.28
  - @cat-factory/node-server@0.55.3
  - @cat-factory/server@0.63.3

## 0.35.5

### Patch Changes

- Updated dependencies [39534d6]
  - @cat-factory/server@0.63.2
  - @cat-factory/node-server@0.55.2

## 0.35.4

### Patch Changes

- Updated dependencies [eab2b60]
  - @cat-factory/server@0.63.1
  - @cat-factory/node-server@0.55.1

## 0.35.3

### Patch Changes

- Updated dependencies [762fe66]
  - @cat-factory/contracts@0.76.0
  - @cat-factory/server@0.63.0
  - @cat-factory/node-server@0.55.0
  - @cat-factory/agents@0.24.16
  - @cat-factory/gitlab@0.4.27
  - @cat-factory/integrations@0.51.4
  - @cat-factory/kernel@0.66.1
  - @cat-factory/orchestration@0.53.2

## 0.35.2

### Patch Changes

- fb53662: Recover and surface stalled runs instead of letting them spin `running` forever.

  A run whose durable driver was lost (a crashed/restarted orchestrator that left its
  pg-boss advance job orphaned-`active`) previously stayed `running` indefinitely with no
  error: the Node stale-run sweeper's re-`send` is a silent no-op while the `exclusive`
  singleton is still held, so the run was never recovered or flagged.

  - **Sweeper now reclaims orphaned advance jobs.** It classifies each stale run's advance
    job by pg-boss's own heartbeat (`live` / `orphaned` / `missing`); an orphaned job (dead
    worker, frozen heartbeat) is deleted to free its singletonKey before re-driving, so a
    bare re-send no longer no-ops onto a dead job. Runs on boot too (immediate reconcile),
    not just on the interval.
  - **Hard-stall backstop.** A run orphaned past a deadline (`STALE_RUN_HARD_FAIL_MINUTES`,
    default 60) that recovery can't resume is failed with the new `stalled`
    `AgentFailureKind` — surfaced by the existing failure banner + retry (a new "Run stalled"
    title) instead of spinning silently. Symmetric on the Cloudflare cron sweeper.
  - **Orphaned local containers are reaped at boot** — a still-running per-run container
    whose run has since gone terminal/away (its `release()` never ran) is removed, via a new
    `AgentRunRepository.liveRunIds` batch query + a `ContainerRuntimeAdapter.listRunContainers`.
  - **Harness structured-repair retries transient failures.** The last-ditch structured-output
    repair call now retries HTTP 429 / 5xx / network errors with exponential backoff honoring
    `Retry-After`, so a transient rate-limit no longer turns a recoverable parse into a hard
    `no structured result` run failure. (executor-harness image bumped to 1.27.5.)

  Breaking (internal): `AgentRunRepository.listStale` now returns `StaleAgentRun` (adds
  `updatedAt`) and gains `liveRunIds`; both D1 and Drizzle repos implement them.

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0
  - @cat-factory/contracts@0.75.0
  - @cat-factory/orchestration@0.53.1
  - @cat-factory/node-server@0.54.3
  - @cat-factory/agents@0.24.15
  - @cat-factory/gitlab@0.4.26
  - @cat-factory/integrations@0.51.3
  - @cat-factory/server@0.62.3

## 0.35.1

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/contracts@0.74.0
  - @cat-factory/kernel@0.65.0
  - @cat-factory/orchestration@0.53.0
  - @cat-factory/agents@0.24.14
  - @cat-factory/gitlab@0.4.25
  - @cat-factory/integrations@0.51.2
  - @cat-factory/server@0.62.2
  - @cat-factory/node-server@0.54.2

## 0.35.0

### Minor Changes

- 0ef76af: Local mode now pins the executor-harness image to the version it was released against and
  refreshes it at boot, so a rerun can't launch a stale — or, via a mutable `:latest`, a
  too-new — harness image (versions aren't guaranteed compatible across the image/backend
  boundary).

  - `LOCAL_HARNESS_IMAGE` is now **optional**: unset resolves to the backend-matched
    `RECOMMENDED_HARNESS_IMAGE` (`resolveHarnessImage`), so a stock deployment runs the
    matched image out of the box.
  - `startLocal()` refreshes the resolved image during its runtime preflight (best-effort;
    falls back to the local copy if the registry is unreachable). Disable with
    `LOCAL_HARNESS_IMAGE_REFRESH=off`. Auto-refresh is skipped on the Apple `container`
    runtime (its CLI verbs differ).
  - An explicit image that differs from the matched pin — or is a mutable tag — is warned
    about at boot.

  Release note: bump `RECOMMENDED_HARNESS_IMAGE` in lockstep with the harness image.

## 0.34.2

### Patch Changes

- Updated dependencies [d4d4cbc]
  - @cat-factory/server@0.62.1
  - @cat-factory/integrations@0.51.1
  - @cat-factory/node-server@0.54.1
  - @cat-factory/orchestration@0.52.1

## 0.34.1

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/contracts@0.73.0
  - @cat-factory/kernel@0.64.0
  - @cat-factory/integrations@0.51.0
  - @cat-factory/server@0.62.0
  - @cat-factory/orchestration@0.52.0
  - @cat-factory/node-server@0.54.0
  - @cat-factory/agents@0.24.13
  - @cat-factory/gitlab@0.4.24

## 0.34.0

### Minor Changes

- 70e321b: Mothership mode: mint the machine token from a whitelisted login and cache it locally, so
  `LOCAL_MOTHERSHIP_TOKEN` is now a headless/CI override instead of a hard requirement.

  A mothership (either facade) serves `POST /auth/machine-token`, which exchanges the caller's
  mothership SESSION for a `machine`-audience token scoped to the user's accounts (derived from
  `accountService.listForUser`; a `requestedAccountIds` hint may only NARROW that set, never widen
  it). The single production mint helper `mintMachineToken` (`@cat-factory/server`) replaces the
  hand-rolled test copy.

  The local facade adds a `node:sqlite` machine-token cache and a local-only
  `POST /local/mothership/connect` proxy: the SPA signs the user into the mothership (OAuth),
  captures the returned session from the redirect fragment, and hands it to its own node, which
  exchanges it for the opaque machine token (cached locally), mints a LOCAL session for the same
  user, and returns it so the SPA is signed in. `composeMothership` now resolves the token per
  request (env override → unexpired cached token → none), so a token-less node boots inert and the
  SPA can drive the login rather than the boot throwing. The login screen gains a "Sign in via
  mothership" affordance behind `localMode.mothership` (i18n across all locales).

  A mothership now honours a post-login `redirect` back to a loopback host (`localhost`,
  `127.0.0.0/8`, `::1`) in `pickPostLoginRedirect`, so the "Sign in via mothership" round-trip lands
  back on the local node without an operator allowlisting every dev port (a redirect to the caller's
  own machine is not a token-exfiltration vector). A failed connect exchange now surfaces an error on
  the login screen instead of silently returning to the sign-in button, and each connect lets the
  mothership assign the node id (a reconnect as a different user never inherits the previous user's
  id).

  Config: `AUTH_MACHINE_TOKEN_TTL_MS` (default 30 days) sets the machine-token lifetime on both
  facades.

### Patch Changes

- Updated dependencies [70e321b]
  - @cat-factory/contracts@0.72.0
  - @cat-factory/server@0.61.0
  - @cat-factory/agents@0.24.12
  - @cat-factory/gitlab@0.4.23
  - @cat-factory/integrations@0.50.2
  - @cat-factory/kernel@0.63.4
  - @cat-factory/orchestration@0.51.7
  - @cat-factory/node-server@0.53.8

## 0.33.4

### Patch Changes

- 37c488f: Internal refactor of mothership-mode code (no behaviour change): share one `node:sqlite` open
  helper between the local credential store and work queue, make `statusForPersistenceError` a
  lookup table, inline the trivial mothership db-path wrappers, bind `pickRepoSource` through a
  local `sourced` helper (collapsing the repeated `remoteRepos`/`db` wiring, including the five
  GitHub projection repos) in the Node container, and centralize the mothership-vs-Postgres
  persistence decision in the local container behind a single `resolveLocalPersistence` helper.
- Updated dependencies [37c488f]
  - @cat-factory/node-server@0.53.7
  - @cat-factory/server@0.60.3

## 0.33.3

### Patch Changes

- Updated dependencies [b744822]
- Updated dependencies [c40736e]
  - @cat-factory/integrations@0.50.1
  - @cat-factory/orchestration@0.51.6
  - @cat-factory/server@0.60.2
  - @cat-factory/node-server@0.53.6

## 0.33.2

### Patch Changes

- Updated dependencies [77c6842]
  - @cat-factory/contracts@0.71.0
  - @cat-factory/integrations@0.50.0
  - @cat-factory/agents@0.24.11
  - @cat-factory/gitlab@0.4.22
  - @cat-factory/kernel@0.63.3
  - @cat-factory/orchestration@0.51.5
  - @cat-factory/server@0.60.1
  - @cat-factory/node-server@0.53.5

## 0.33.1

### Patch Changes

- 79a0f48: Wire the programmatic custom provision-type catalog (`CustomManifestTypeRegistry`)
  into every facade so a code-registered `custom` manifest type is actually visible.
  Previously a deployment/provider package could register a custom manifest type, but
  no runtime constructed or injected the registry, so `listCustomTypes` always saw an
  empty registered set — the type never appeared in the infrastructure custom-type
  editor or the per-service provisioning picker.

  `customManifestTypeRegistry` now belongs to `BackendRegistries` (built by
  `createBackendRegistries()`), and the Cloudflare + Node facades thread it into
  `createCore` (local inherits via `buildNodeContainer`). A deployment registers a
  type by reference — `registries.customManifestTypeRegistry.register({ manifestId,
label, … })` — exactly like a custom environment/runner backend. The cross-runtime
  conformance suite now asserts a registered type surfaces in the handlers bundle
  (`source: 'registered'`) on both runtimes.

- 91f876b: Mothership-mode tech-debt cleanup (functionality-preserving): rename the persistence
  allow-list export `PILOT_PERSISTENCE_METHODS` → `REMOTE_PERSISTENCE_METHODS` (it is the
  functional surface, no longer a pilot) and drop the unused `accountField` `ScopeRule` kind
  that was defined but never allow-listed or exercised. Also refresh stale comments/docs that
  predated the Phase-3 merge gate (which is now MET): the `MothershipComposition.repos` JSDoc,
  the `buildNodeContainer` `db: undefined` service-matrix note, and the mothership-mode tracker
  banner. No runtime behavior change.
- Updated dependencies [79a0f48]
- Updated dependencies [91f876b]
  - @cat-factory/integrations@0.49.0
  - @cat-factory/node-server@0.53.4
  - @cat-factory/server@0.60.0
  - @cat-factory/orchestration@0.51.4

## 0.33.0

### Minor Changes

- cc01f1e: Mothership mode: durable SQLite execution work queue (initiative PR 2).

  The best-effort in-memory `InProcessWorkRunner` is replaced by the durable `SqliteWorkRunner`,
  backed by a file-based `node:sqlite` work queue (default `~/.cat-factory/work-queue.sqlite`,
  override with `LOCAL_MOTHERSHIP_WORK_DB`). A mothership-mode local node has no Postgres/pg-boss,
  so it drives runs in-process — but the queue now persists the "this run needs driving" intent, so
  a crash or restart re-drives what was in flight (boot-time orphan reset + a periodic recovery
  poll). It mirrors pg-boss's `exclusive` advance queue (one row per run, mid-drive signal
  coalescing, deferred gate re-polls, a poison-attempt cap), reusing the same `executionRuntime()`
  timing derivation.

## 0.32.3

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/contracts@0.70.1
  - @cat-factory/kernel@0.63.2
  - @cat-factory/integrations@0.48.2
  - @cat-factory/server@0.59.2
  - @cat-factory/agents@0.24.10
  - @cat-factory/gitlab@0.4.21
  - @cat-factory/orchestration@0.51.3
  - @cat-factory/node-server@0.53.3

## 0.32.2

### Patch Changes

- Updated dependencies [66a8c71]
  - @cat-factory/integrations@0.48.1
  - @cat-factory/orchestration@0.51.2
  - @cat-factory/server@0.59.1
  - @cat-factory/node-server@0.53.2

## 0.32.1

### Patch Changes

- Updated dependencies [b4c7e60]
  - @cat-factory/contracts@0.70.0
  - @cat-factory/integrations@0.48.0
  - @cat-factory/server@0.59.0
  - @cat-factory/agents@0.24.9
  - @cat-factory/gitlab@0.4.20
  - @cat-factory/kernel@0.63.1
  - @cat-factory/orchestration@0.51.1
  - @cat-factory/node-server@0.53.1

## 0.32.0

### Minor Changes

- f568a8c: Add a built-in "Manual review only" merge-threshold preset and reseeding for the
  merge-preset catalog (mirroring pipelines).

  - "Manual review only" sets a new `autoMergeEnabled: false` flag, so the `merger` step
    never auto-merges a task using it — every PR is routed to a human `merge_review`
    notification regardless of the assessment scores. The flag is editable on any preset via
    a toggle in the Merge thresholds settings.
  - Built-in merge presets now carry a stable id (`mp_balanced`, `mp_manual_review`) and a
    monotonic `version`. The workspace snapshot ships `mergePresetCatalogVersions`, and the
    SPA surfaces a once-per-session startup advisory when a built-in preset is outdated or a
    new built-in appeared upstream, offering a one-click reseed
    (`POST /workspaces/:ws/merge-presets/:id/reseed`).

  Breaking (pre-1.0, no migration): `merge_threshold_presets` gains `auto_merge_enabled`
  (default on) and `version` columns (D1 + Drizzle). First read of a workspace's presets now
  seeds the whole built-in catalog (Balanced + Manual review only), not just the default.

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0
  - @cat-factory/contracts@0.69.0
  - @cat-factory/orchestration@0.51.0
  - @cat-factory/server@0.58.0
  - @cat-factory/node-server@0.53.0
  - @cat-factory/agents@0.24.8
  - @cat-factory/gitlab@0.4.19
  - @cat-factory/integrations@0.47.1

## 0.31.2

### Patch Changes

- Updated dependencies [41203db]
  - @cat-factory/contracts@0.68.0
  - @cat-factory/integrations@0.47.0
  - @cat-factory/server@0.57.0
  - @cat-factory/agents@0.24.7
  - @cat-factory/gitlab@0.4.18
  - @cat-factory/kernel@0.62.4
  - @cat-factory/orchestration@0.50.1
  - @cat-factory/node-server@0.52.2

## 0.31.1

### Patch Changes

- Updated dependencies [3ec9c90]
  - @cat-factory/server@0.56.1
  - @cat-factory/node-server@0.52.1

## 0.31.0

### Minor Changes

- cb9e2e3: Per-service provision types (Phase 2, slice 10): facade wiring for the async, container-backed
  Kubernetes deploy lifecycle + the local-mode native-CLI deploy transport. A `deployer` step whose
  manifests need rendering (kustomize/helm/Gateway-API) now stands its environment up in a real
  deploy container (or, locally, the host CLIs) on every runtime — slice 9's `deployJobClient` /
  `resolveDeployCloneTarget` seams are no longer unwired. The synchronous raw-manifest REST path is
  unchanged.

  - **Cloudflare Worker**: a new `DeployContainer` Durable Object (per-run, the separate
    deploy-harness image — `kubectl`/`kustomize`/`helm`) bound as `DEPLOY_CONTAINER`, with its
    `[[containers]]` block + binding + a `v4` migration in both wranglers and the class exported from
    the worker entry. The `image: 'deploy'` dispatch routes here while agent jobs stay on
    `ExecutionContainer`. `selectDeployDeps` wires a deploy-dedicated `RunnerJobClient` (over the
    deploy namespace) + `resolveDeployCloneTarget` when the binding + GitHub App are present.
  - **Node**: wires the default pool-backed `deployJobClient` (`new RunnerJobClient(resolveTransport)`)
    - a `resolveDeployCloneTarget` built from the App token mint, both overridable by a sibling facade.
      The self-hosted runner pool now forwards the `image` dispatch option (the generic
      `RunnerPoolTransport` + `HttpRunnerPoolProvider` expose it as a first-class `{{input.image}}`
      variable, and the native Kubernetes runner config gains an `imageDeploy` variant) so a pool pulls
      the deploy-harness image for `image: 'deploy'`.
  - **Local**: a new `NativeCliDeployTransport` (`LOCAL_DEPLOY_RUNTIME=native|container`). `native`
    (default) runs the deploy harness as a host process driving the developer's own
    `kubectl`/`kustomize`/`helm`; `container` runs the deploy image per job, keyed by its own job id so
    it never collides with the run's agent container. The clone target is inherited from Node's default
    (PAT mint + GitLab-aware origin).
  - **Shared**: `@cat-factory/server` exports `makeResolveDeployCloneTarget` (compose a deploy clone
    resolver from a repo-target walk + token mint, with a per-facade clone-URL override).
  - **Conformance**: the cross-runtime suite drives the engine's async render path on every facade —
    it forwards the provider's `deploy` kind + `image: 'deploy'` option through the wired client, polls
    a stubbed view, and finalizes — asserting the finalized record round-trips through each facade's
    real registry repo to an identical `ProvisionedEnvironment` on D1 and Postgres. (The per-facade
    transport selection is out of this runtime-neutral suite's scope; only local's selection has a
    dedicated unit test today.)

### Patch Changes

- Updated dependencies [cb9e2e3]
  - @cat-factory/contracts@0.67.0
  - @cat-factory/integrations@0.46.0
  - @cat-factory/orchestration@0.50.0
  - @cat-factory/server@0.56.0
  - @cat-factory/node-server@0.52.0
  - @cat-factory/agents@0.24.6
  - @cat-factory/gitlab@0.4.17
  - @cat-factory/kernel@0.62.3

## 0.30.2

### Patch Changes

- Updated dependencies [1e55e77]
  - @cat-factory/contracts@0.66.1
  - @cat-factory/integrations@0.45.0
  - @cat-factory/orchestration@0.49.0
  - @cat-factory/agents@0.24.5
  - @cat-factory/gitlab@0.4.16
  - @cat-factory/kernel@0.62.2
  - @cat-factory/server@0.55.2
  - @cat-factory/node-server@0.51.2

## 0.30.1

### Patch Changes

- Updated dependencies [ecf4cc1]
  - @cat-factory/contracts@0.66.0
  - @cat-factory/orchestration@0.48.2
  - @cat-factory/agents@0.24.4
  - @cat-factory/gitlab@0.4.15
  - @cat-factory/integrations@0.44.1
  - @cat-factory/kernel@0.62.1
  - @cat-factory/server@0.55.1
  - @cat-factory/node-server@0.51.1

## 0.30.0

### Minor Changes

- f9678df: Mothership mode: the no-Postgres local boot SPINE (initiative slice 1b). A local node can now
  boot with `LOCAL_MOTHERSHIP_URL` set and NO local database: it composes the remote (RPC-backed)
  org repositories + a local `node:sqlite` credential store (sealed with the LOCAL key; the
  mothership's `ENCRYPTION_KEY` never reaches the machine) and drives runs with an in-process work
  runner instead of pg-boss.

  NOT yet functional end-to-end — keep the mothership PR a DRAFT. The pilot allow-list exposes only
  the six core domain repositories remotely, but a board load and a run reach many more org repos
  (mounts, settings, presets, notifications, projections, …) plus stores still built from the
  now-absent local `db`, so those paths currently throw. Routing the full repository surface through
  the remote registry + widening the server allow-list (with the per-method account/role scope rules
  that boundary needs) is the gating phase in `docs/initiatives/mothership-mode.md`; this work must
  not merge until that phase lands. See the tracker for the per-repo task list.

  - `@cat-factory/server`: `createRemoteRepositoryRegistry(client)` — a drift-proof, full-surface
    remote repository set (a `Proxy` that lazily forwards any accessed repository to one RPC), so a
    mothership-mode node backs its entire `CoreRepositories` surface remotely with no per-repo
    wiring. The server-side allow-list still gates which repo+method actually executes.
  - `@cat-factory/node-server`: `buildNodeContainer` now tolerates `db: undefined` — the per-user
    Postgres services (subscriptions, user secrets, OpenRouter catalog) turn themselves off, the
    API-key pool + local-model endpoints accept injected repositories, and the composite `repos`
    is required in that mode. Re-exports the execution driver + realtime pieces the local
    mothership boot reuses.
  - `@cat-factory/local-server`: `composeMothership` wires the remote repos + the local credential
    store; `buildLocalContainer` composes them with `db: undefined`, injects the credential repos,
    and drives runs with the new in-process `WorkRunner` (the no-pg-boss analogue, serialized per
    execution); `startLocal()` takes the dedicated no-Postgres boot path automatically when
    `LOCAL_MOTHERSHIP_URL` is set.
  - `@cat-factory/contracts`: `localModeConfig.mothership` is surfaced to the SPA so the UI can
    label what is stored locally vs delegated to the mothership.

  Login-based machine-token minting also lands later (a static `LOCAL_MOTHERSHIP_TOKEN` is used for
  now). Pre-1.0, no back-compat: the standard siloed-Postgres local mode is unchanged when
  `LOCAL_MOTHERSHIP_URL` is unset.

### Patch Changes

- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [f9678df]
- Updated dependencies [858799e]
  - @cat-factory/server@0.55.0
  - @cat-factory/node-server@0.51.0
  - @cat-factory/contracts@0.65.0
  - @cat-factory/orchestration@0.48.1
  - @cat-factory/kernel@0.62.0
  - @cat-factory/integrations@0.44.0
  - @cat-factory/agents@0.24.3
  - @cat-factory/gitlab@0.4.14

## 0.29.0

### Minor Changes

- 9bb75b0: Per-service provision types (slices 3 + 4): the deployer engine step + run-details recording,
  and the per-type handler controllers + container wiring.

  Slice 3 — engine step:

  - The `deployer` step now resolves the SERVICE frame's declared `provisioning` and routes to the
    workspace handler for its type (merging the service's manifest source). A service declaring
    `infraless` records a no-op step output (nothing provisioned); an undeclared service falls
    through to the legacy single-connection path. The resolved provision type + engine are recorded
    on the `EnvironmentRecord` (success and failed paths) and surfaced on the step output
    (`Provision type:` / `Engine:` lines + `model: environment:<engine>:<providerId>`).
  - `EnvironmentProvisioningService.provision` gains an `initiatedBy` arg and a
    `resolveUserHandlerOverrides` seam: in local mode the run initiator's per-user handler
    overrides layer over the workspace handlers.

  Slice 4 — controllers + wiring:

  - New per-type infra handler HTTP surface on `EnvironmentController` (workspace-scoped): a batched
    `GET …/environments/handlers` bundle (handlers + custom-type catalog), `POST …/handlers`,
    `PATCH …/handlers/:provisionType/secrets`, `DELETE …/handlers/:provisionType`, plus custom-type
    CRUD (`PUT|DELETE …/environments/custom-types/:manifestId`).
  - New **local-mode-only** `EnvironmentUserHandlerController` mounted at the root
    (`GET /me/environment-handlers/:workspaceId`, `PUT|DELETE …/:provisionType`), backed by the new
    `EnvironmentUserHandlerService`. The service + per-user overrides are wired ONLY by the local
    facade (Worker/Node 503 the controller and ignore user overrides), enforced purely by container
    wiring.
  - `customManifestTypeRepository` is wired on all three facades (workspace catalog CRUD);
    `environmentUserHandlerRepository` only on the local facade.
  - The handler validation/lowering is extracted to a shared `buildInfraHandlerFields` helper used by
    both the workspace and per-user stores. Cross-runtime conformance asserts the per-type handler
    CRUD + custom-type CRUD + the `infraless` deployer no-op on every facade.

### Patch Changes

- Updated dependencies [9bb75b0]
  - @cat-factory/contracts@0.64.0
  - @cat-factory/integrations@0.43.0
  - @cat-factory/orchestration@0.48.0
  - @cat-factory/server@0.54.0
  - @cat-factory/node-server@0.50.0
  - @cat-factory/agents@0.24.2
  - @cat-factory/gitlab@0.4.13
  - @cat-factory/kernel@0.61.1

## 0.28.1

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/server@0.53.0
  - @cat-factory/contracts@0.63.0
  - @cat-factory/kernel@0.61.0
  - @cat-factory/node-server@0.49.0
  - @cat-factory/agents@0.24.1
  - @cat-factory/gitlab@0.4.12
  - @cat-factory/integrations@0.42.1
  - @cat-factory/orchestration@0.47.1

## 0.28.0

### Minor Changes

- f383515: Per-service provision types (slice 2c — tester collapse). **Breaking:** the per-task/per-service
  `local` vs `ephemeral` Tester toggle is gone. A service's declared `provisioning` config now
  drives the Tester's infra entirely, so these are removed (BC is a non-goal — stale rows/columns
  are simply dropped):

  - the `Block` fields `defaultTestEnvironment`, `testComposePath`, `noInfraDependencies` (folded
    into `provisioning.type` / `provisioning.composePath`) — dropped from the contract, the shared
    block mapper, and the D1 (`0026_drop_tester_env_columns.sql`) + Drizzle block columns;
  - the `tester.environment` agent-config descriptor (`@cat-factory/agents`) and its prompt/job-body
    consumers — the Tester's run mode is now derived from the service's provision type;
  - the `delegateTestEnvToProvider` workspace setting (+ its D1/Drizzle column) and the local-facade
    `resolveTesterFallbackDefault` / `resolveRequireEnvironmentProvider` wiring.

  The start-time Tester gate is rewritten: it passes for an `infraless` (or undeclared) service,
  refuses a `docker-compose` service on a runtime that can't nest containers OR with no compose
  path declared (`tester_infra_unsupported` — "limited mode" / "nothing to stand up"), and requires
  a resolvable workspace handler for a `kubernetes`/`custom` service (`provision_type_unhandled`, via
  the new `EnvironmentConnectionService.resolveHandlerForType` /
  `EnvironmentProvisioningService.canProvision` seam). The Tester's run mode (the `infra` job spec +
  the prompt run-mode line, kept in lock-step) is derived from the provision type AND the run's
  provisioned environment: a service that actually provisioned an env URL (e.g. via a `deployer`
  step) tests against it regardless of declared type, and an undeclared service runs with no infra.
  The agent-executor `service` context carries `provisioning` instead of the three legacy fields. The
  service inspector replaces the local/ephemeral toggle with a provision-type selector.

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0
  - @cat-factory/contracts@0.62.0
  - @cat-factory/agents@0.24.0
  - @cat-factory/orchestration@0.47.0
  - @cat-factory/integrations@0.42.0
  - @cat-factory/server@0.52.0
  - @cat-factory/node-server@0.48.0
  - @cat-factory/gitlab@0.4.11

## 0.27.4

### Patch Changes

- Updated dependencies [d21588d]
  - @cat-factory/node-server@0.47.0

## 0.27.3

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0
  - @cat-factory/contracts@0.61.0
  - @cat-factory/agents@0.23.4
  - @cat-factory/gitlab@0.4.10
  - @cat-factory/integrations@0.41.1
  - @cat-factory/orchestration@0.46.1
  - @cat-factory/server@0.51.3
  - @cat-factory/node-server@0.46.1

## 0.27.2

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0
  - @cat-factory/contracts@0.60.0
  - @cat-factory/integrations@0.41.0
  - @cat-factory/orchestration@0.46.0
  - @cat-factory/node-server@0.46.0
  - @cat-factory/agents@0.23.3
  - @cat-factory/gitlab@0.4.9
  - @cat-factory/server@0.51.2

## 0.27.1

### Patch Changes

- 6009266: Refresh dependencies to their latest release-age-compliant versions: the Vercel AI
  SDK family within its `workers-ai-provider`-compatible majors (`ai` 6.0.214,
  `@ai-sdk/anthropic` 3.0.89, `@ai-sdk/openai` 3.0.77, `@ai-sdk/openai-compatible`
  2.0.54, `@ai-sdk/amazon-bedrock` 4.0.124), `drizzle-orm`/`drizzle-kit` 1.0.0-rc.4,
  and `yaml` 2.9.0, plus refreshed transitive resolutions.
- Updated dependencies [6009266]
  - @cat-factory/agents@0.23.2
  - @cat-factory/integrations@0.40.1
  - @cat-factory/kernel@0.57.1
  - @cat-factory/orchestration@0.45.3
  - @cat-factory/node-server@0.45.1
  - @cat-factory/server@0.51.1
  - @cat-factory/gitlab@0.4.8

## 0.27.0

### Minor Changes

- 1c326f9: Add the mothership-mode local `node:sqlite` credential store (the consumer-side foundation
  of the mothership-mode initiative). In mothership mode a local node keeps NO main database
  (org/durable state is forwarded to the hosted mothership over the persistence RPC), but the
  agent/model credentials stay on the developer's machine, sealed with the LOCAL key so the
  mothership's `ENCRYPTION_KEY` never reaches the laptop. This ships their persistence: a
  file-based `node:sqlite` store implementing the two `local-sqlite` bucket ports,
  `SqliteProviderApiKeyRepository` (the direct-vendor API-key pool, with usage-window rotation
  and atomic lease-least-used) and `SqliteLocalModelEndpointRepository` (per-user local model
  endpoints), behind a `createLocalCredentialStore(path)` factory. The schema and behaviour
  mirror the Drizzle/D1 repositories column-for-column so a mothership-mode node pools and
  rotates keys identically to a Postgres one. Not yet wired into `buildLocalContainer`: the
  `LOCAL_MOTHERSHIP_URL` composition switch + no-Postgres boot land in the next slice.

## 0.26.1

### Patch Changes

- Updated dependencies [bd23c46]
- Updated dependencies [bd23c46]
- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/node-server@0.45.0
  - @cat-factory/server@0.51.0
  - @cat-factory/contracts@0.59.0
  - @cat-factory/kernel@0.57.0
  - @cat-factory/integrations@0.40.0
  - @cat-factory/agents@0.23.1
  - @cat-factory/gitlab@0.4.7
  - @cat-factory/orchestration@0.45.2

## 0.26.0

### Minor Changes

- 2ac148d: Add a Docker Compose ephemeral-environment backend (the Checkbox-style preview-env mechanic).

  `composeEnvironmentBackend(runtime)` (new in `@cat-factory/integrations`) is an
  `EnvironmentProvider` that stands the PR repo's own `docker-compose.yml` up on a local Docker
  daemon under a per-PR `COMPOSE_PROJECT_NAME`, publishes the configured web service's port to an
  ephemeral host port, returns `http://localhost:<port>` for the Tester/`deployer` flow, and tears
  the project down on TTL. It rides the contract's generic environment-backend manifest member (no
  new config variant, no migration): the flat config lives in the stored manifest's `providerConfig`,
  written by the descriptor-driven connect form.

  To make the per-PR isolation real, the repo compose file is read checkout-free and **rewritten
  into one project file** before `up`: every service's published host port is forced ephemeral (so
  two concurrent per-PR stacks can't collide on a pinned host port — an additive `-f` overlay can't
  strip the base's mapping), the probed service is guaranteed to publish its port, and references
  this checkout-free backend can't honor — `build:` contexts, host bind mounts, relative `env_file`s,
  and `privileged` services — are **refused up front** with a clear reason instead of silently
  mis-mounting. An **auto-teardown TTL** is collected on the connect form (`ttlMinutes`, default
  2h; `0` = never) so a forgotten preview env is swept off the host instead of leaking containers +
  volumes. `testConnection` now probes the daemon (`compose ls`), not just the CLI, and every daemon
  call is time-bounded so a wedged daemon can't hang a provision/status/teardown. Default project
  names are disambiguated by block id so two workspaces sharing a repo name + PR number can't
  collide, and `status` reads `ps -a` so a brief container recreate doesn't flip a healthy env to
  `failed`.

  The local facade (`@cat-factory/local-server`) registers it by reference, closing over the host
  docker CLI, on the Docker-family runtimes only (Apple `container`, the plain Node service, and the
  Cloudflare Worker have no host docker daemon, so they don't register it — the documented
  runtime-bound asymmetry). The infrastructure picker (`@cat-factory/app`) surfaces it on the "Where
  test environments run" axis with actionable "when to use this" guidance and a local-only caveat.

  v1 supports self-contained image-based compose stacks (a service that builds from source, or that
  needs host bind mounts / relative env files, needs a full checkout — a follow-up). No
  backwards-compat concerns: this is a net-new opt-in backend.

### Patch Changes

- Updated dependencies [2ac148d]
  - @cat-factory/integrations@0.39.0
  - @cat-factory/orchestration@0.45.1
  - @cat-factory/server@0.50.3
  - @cat-factory/node-server@0.44.3

## 0.25.15

### Patch Changes

- Updated dependencies [5fd0ffa]
  - @cat-factory/orchestration@0.45.0
  - @cat-factory/contracts@0.58.0
  - @cat-factory/agents@0.23.0
  - @cat-factory/server@0.50.2
  - @cat-factory/node-server@0.44.2
  - @cat-factory/gitlab@0.4.6
  - @cat-factory/integrations@0.38.1
  - @cat-factory/kernel@0.56.1

## 0.25.14

### Patch Changes

- Updated dependencies [1ff013f]
  - @cat-factory/server@0.50.1
  - @cat-factory/orchestration@0.44.1
  - @cat-factory/node-server@0.44.1

## 0.25.13

### Patch Changes

- f9a173f: Fix three concurrency hazards in the backend with database-native primitives.

  - **Optimistic concurrency on execution runs.** `agent_runs` gains a monotonic `rev`
    column; the execution repo's `upsert` bumps it on every write and a new
    `compareAndSwap` performs a guarded conditional write. The in-place human-action handlers
    (resolve decision / request changes / reject / request-human-review-fix / resume-paused)
    now go through a `mutateInstance` retry helper, so a double-submit or a write that raced
    the durable driver is re-applied on fresh state instead of silently clobbering the other
    writer (lost update). (`retry` / `restart-from-step` mint a fresh run id, so the same-row
    hazard is structurally absent there.)
  - **Atomic API-key pool lease.** The non-transactional `listForPool → chooseToken →
markLeased` is replaced by a single atomic select-and-mark (`leaseLeastUsed`: Postgres
    `FOR UPDATE SKIP LOCKED`; D1 a single serialised write), so two concurrent dispatches
    can no longer grab the same key before usage is recorded.
  - **Notification open-card dedup.** A partial unique index on
    `(workspace_id, block_id, type) WHERE status='open'` plus an atomic
    `upsertOpenForBlock` replaces the racy `findOpenByBlock` read-before-write, so two
    concurrent raises can't stack duplicate open cards. `upsertOpenForBlock` returns the
    CANONICAL persisted row, so when a concurrent raise wins the insert the loser delivers
    and returns that row's id rather than a phantom id (which would show a duplicate inbox
    card and 404 when acted on).

  BREAKING (pre-1.0, no data migration): `agent_runs` adds a non-null `rev` column and the
  `notifications` table adds a partial unique index, mirrored across the D1 and Drizzle
  migrations. The `ExecutionRepository`, `ProviderApiKeyRepository` and
  `NotificationRepository` ports each gain a method.

- Updated dependencies [f9a173f]
  - @cat-factory/contracts@0.57.0
  - @cat-factory/kernel@0.56.0
  - @cat-factory/server@0.50.0
  - @cat-factory/orchestration@0.44.0
  - @cat-factory/integrations@0.38.0
  - @cat-factory/node-server@0.44.0
  - @cat-factory/agents@0.22.6
  - @cat-factory/gitlab@0.4.5

## 0.25.12

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4
  - @cat-factory/orchestration@0.43.4
  - @cat-factory/integrations@0.37.1
  - @cat-factory/node-server@0.43.12
  - @cat-factory/agents@0.22.5
  - @cat-factory/gitlab@0.4.4
  - @cat-factory/server@0.49.6

## 0.25.11

### Patch Changes

- Updated dependencies [0dd9532]
  - @cat-factory/server@0.49.5
  - @cat-factory/node-server@0.43.11

## 0.25.10

### Patch Changes

- 21b2096: Make the environment-backend and runner-backend registries app-owned (DI) instead of
  module-global Maps. This is the pilot for the registry-DI migration
  (`docs/initiatives/registry-di-migration.md`): the composition root now constructs each
  registry instance via `createBackendRegistries()` and injects it through
  `CoreDependencies`; a deployment registers a custom backend by reference
  (`registry.register(provider)`), so registration no longer depends on the adapter and
  server sharing the same `@cat-factory/integrations` module instance.

  BREAKING (`@cat-factory/integrations`): the module-global free functions
  `registerEnvironmentBackend` / `environmentBackend` / `registeredEnvironmentBackendKinds`
  / `environmentBackendKinds` / `findRepairCapableProvider` and their runner-backend
  equivalents (`registerRunnerBackend` / `runnerBackend` / `registeredRunnerBackendKinds`
  / `runnerBackendKinds`) are removed. Use the new `EnvironmentBackendRegistry` /
  `RunnerBackendRegistry` classes (methods `register` / `get` / `kinds` / `labelled`, plus
  `findRepairCapable` on the env registry), the `defaultEnvironmentBackendRegistry()` /
  `defaultRunnerBackendRegistry()` factories, or the unified `createBackendRegistries()`.

- Updated dependencies [21b2096]
  - @cat-factory/integrations@0.37.0
  - @cat-factory/orchestration@0.43.3
  - @cat-factory/server@0.49.4
  - @cat-factory/node-server@0.43.10
  - @cat-factory/contracts@0.56.1
  - @cat-factory/agents@0.22.4
  - @cat-factory/gitlab@0.4.3
  - @cat-factory/kernel@0.55.3

## 0.25.9

### Patch Changes

- Updated dependencies [123336c]
  - @cat-factory/server@0.49.3
  - @cat-factory/node-server@0.43.9

## 0.25.8

### Patch Changes

- Updated dependencies [7536092]
  - @cat-factory/node-server@0.43.8

## 0.25.7

### Patch Changes

- Updated dependencies [4ec514a]
  - @cat-factory/server@0.49.2
  - @cat-factory/node-server@0.43.7

## 0.25.6

### Patch Changes

- ad5d3e0: Collapse the Infrastructure settings into one flat backend list per tab. The "Agent
  containers" and "Test environments" tabs each now show a single radio list of concrete
  destinations (built-in · Kubernetes cluster · custom HTTP pool/provider) with a one-line
  description, instead of stacking a "where it runs" radio above a separate "runner/environment
  backend" dropdown. Selecting a cluster/pool reveals its connect form inline.

  Adds a low-config **Local Kubernetes (k3s)** preset (local mode, agent containers) that
  prefills the Kubernetes runner form for a local k3s cluster — the operator only pastes a
  ServiceAccount token. To support it, the Kubernetes runner form gains the
  `insecureSkipTlsVerify` toggle, and the infrastructure capability descriptor surfaces the
  local deployment's executor image (`suggestedExecutorImage`, from `LOCAL_HARNESS_IMAGE`) so
  the preset's image is prefilled. No backend behavior change was needed — the Kubernetes
  apiserver validator already permits loopback hosts and self-signed TLS.

  Also moves the manifest editor's "currently stored secrets" indication next to the secret
  inputs so it's clear whether a value is already saved.

  BREAKING (pre-1.0, internal): removes the `settings.providerConnection.backend.*` and
  `settings.providerConnection.advancedManifest.*` i18n keys (the old in-form backend
  dropdown + collapsed-manifest disclosure are gone).

- Updated dependencies [ad5d3e0]
  - @cat-factory/contracts@0.56.0
  - @cat-factory/server@0.49.1
  - @cat-factory/agents@0.22.3
  - @cat-factory/gitlab@0.4.2
  - @cat-factory/integrations@0.36.1
  - @cat-factory/kernel@0.55.2
  - @cat-factory/orchestration@0.43.2
  - @cat-factory/node-server@0.43.6

## 0.25.5

### Patch Changes

- Updated dependencies [4897078]
  - @cat-factory/contracts@0.55.0
  - @cat-factory/integrations@0.36.0
  - @cat-factory/server@0.49.0
  - @cat-factory/node-server@0.43.5
  - @cat-factory/agents@0.22.2
  - @cat-factory/gitlab@0.4.1
  - @cat-factory/kernel@0.55.1
  - @cat-factory/orchestration@0.43.1

## 0.25.4

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/gitlab@0.4.0
  - @cat-factory/kernel@0.55.0
  - @cat-factory/server@0.48.4
  - @cat-factory/node-server@0.43.4
  - @cat-factory/contracts@0.54.0
  - @cat-factory/orchestration@0.43.0
  - @cat-factory/agents@0.22.1
  - @cat-factory/integrations@0.35.4

## 0.25.3

### Patch Changes

- Updated dependencies [b76f303]
  - @cat-factory/orchestration@0.42.1
  - @cat-factory/server@0.48.3
  - @cat-factory/node-server@0.43.3

## 0.25.2

### Patch Changes

- 48a3df6: Surface the per-run container's live lifecycle in a container agent's details, and bring
  the API Tester window to parity with the Coder.

  Previously a container-backed step showed a "Spinning up container…" badge that simply
  **vanished** once the container was up, leaving a blank "working" state — you couldn't tell
  whether the agent was still preparing the checkout or already making model calls, and there
  was no way to see which container the run was on or whether it was up / errored / gone.

  - **Live phase.** The executor-harness now exposes its current lifecycle phase
    (`starting` → `clone` → `agent` → `push`) on the running job view — the same marker that
    already drove the stuck-run breadcrumb. The engine threads it through
    (`RunnerJobView` / `AgentJobUpdate`) onto the step so the details show WHAT the container
    is doing: "Preparing workspace" vs "Agent running" vs "Pushing changes".
  - **Container identity + address.** The transport now attaches the container's id (the
    Cloudflare Durable Object id; the local Docker container id) and, where one exists, its
    reachable URL (the local host URL) — so a run's details name WHERE it runs.
  - **Explicit lifecycle status.** Steps carry a `container` projection
    (`starting` / `up` / `errored`, with `destroyed` derived once the run's container is
    reclaimed), so the details say whether the container is spinning up, running, errored, or
    gone — instead of inferring it from a run-level failure.
  - **API Tester parity.** The Tester result window now reuses the same observability the
    Coder's step detail shows — the container lifecycle (status / phase / id / url), the
    ephemeral environment status, and the run's infrastructure attempts + logs — alongside its
    test report, instead of the report alone. The Tester (and the human-test / visual-confirm
    gate helpers) now surface the cold-boot `starting` window before the agent comes up, like
    the Coder, rather than jumping straight to "running".
  - **The legacy `startingContainer` boolean is removed** in favour of the richer `container`
    projection everywhere (no dual-signal path): every container-backed step — including the
    gate helpers — now reports its lifecycle through `container`. (Stale persisted steps simply
    drop the field; backwards compatibility is a non-goal.)

  Bumps the `@cat-factory/executor-harness` image to `1.24.0` (and the matching tag in
  `deploy/backend`).

- 48a3df6: Fix the Tester→Fixer loop, make fixer runs inspectable, and let the Tester abort a run.

  Three related issues in the API/UI Tester flow:

  - **The Tester never actually re-ran after a Fixer round, so the step was marked "done"
    regardless of the outcome.** The harness keys each job by `run + agentKind` and re-attaches
    to an existing entry rather than re-running (replay idempotency). A container-reusing
    transport (a warm local pool / a self-hosted runner pool) keeps that registry alive across
    rounds — reclaiming a pooled member does NOT destroy it — so a re-dispatched Tester
    re-attached to its FIRST round's completed job and silently replayed the stale report. Each
    re-dispatch within a run now carries a per-round **dispatch epoch** folded into the harness
    job id (`AgentRunContext.dispatchEpoch`), so the re-test always runs anew. Also covers the
    CI/conflicts gate fixer loops, which share the same re-dispatch shape. Defensively, a report
    with any failed outcome can no longer be greenlit (a failed check is treated as a blocker).
    The conformance suite now models a pooled container so the loop is exercised faithfully.

  - **Fixer companion runs were opaque.** A Tester step now keeps an append-only `attemptLog`
    of its fixer rounds (what each round was handed + how it ended), rendered as an inspectable
    timeline in the test report window instead of only a bare "N/M fix" count.

  - **The Tester can now ABORT a run instead of looping the fixer.** When the change cannot be
    meaningfully tested — its ephemeral environment never came up, a required dependency is
    missing — the Tester sets `abort: { reason }` on its report (or the engine auto-aborts when
    the step's ephemeral environment is in a `failed` state). The run stops, the block is left
    blocked (retryable), and a human-actionable notification is raised — the fixer is NOT
    dispatched, since it cannot provision infrastructure.

  This is a breaking change to the persisted Tester step state and the test-report wire shape
  (new `attemptLog` / `abort` fields); per the project's pre-1.0 policy, stale in-flight runs
  may simply break rather than migrate.

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0
  - @cat-factory/contracts@0.53.0
  - @cat-factory/orchestration@0.42.0
  - @cat-factory/server@0.48.2
  - @cat-factory/agents@0.22.0
  - @cat-factory/node-server@0.43.2
  - @cat-factory/gitlab@0.3.9
  - @cat-factory/integrations@0.35.3

## 0.25.1

### Patch Changes

- Updated dependencies [614e985]
  - @cat-factory/integrations@0.35.2
  - @cat-factory/orchestration@0.41.4
  - @cat-factory/server@0.48.1
  - @cat-factory/node-server@0.43.1

## 0.25.0

### Minor Changes

- 0577404: feat: move infrastructure configuration into its own top-level navbar menu. Agent-container execution + Tester environments + (local mode) the warm-container pool / checkout reuse now live in a dedicated tabbed "Infrastructure" window reached from the navbar, instead of being buried in the Integrations hub and a separate "Local mode" entry. The old bare "delegate to runner pool" toggle is replaced by a clear execution-backend selector that reflects the backends available for THIS deployment (local Docker host / Cloudflare Containers / self-hosted runner pool) and which is active — driven by a new symmetric `infrastructure` capability descriptor on `GET /auth/config` (set by every facade; asserted by the cross-runtime conformance suite). The raw-JSON runner manifest editor is kept but collapsed behind an "Advanced: custom API-based scheduler" disclosure, since the common backends don't need it.

### Patch Changes

- Updated dependencies [0577404]
  - @cat-factory/contracts@0.52.0
  - @cat-factory/server@0.48.0
  - @cat-factory/node-server@0.43.0
  - @cat-factory/agents@0.21.17
  - @cat-factory/gitlab@0.3.8
  - @cat-factory/integrations@0.35.1
  - @cat-factory/kernel@0.53.1
  - @cat-factory/orchestration@0.41.3

## 0.24.0

### Minor Changes

- 69558f9: Add a Kubernetes-based ephemeral-environment provider, selected per workspace through an
  env-backend registry that mirrors the runner-pool backends.

  The ephemeral-environment connection is now discriminated by a `kind` field (`manifest` =
  the generic BYO HTTP management API, `kubernetes` = native per-PR namespaces), resolved
  through a `registerEnvironmentBackend` provider-registry seam — so a native backend is a
  single registry entry + a config variant + a UI form, with no new table/service/controller.

  The Kubernetes backend applies an operator-authored set of k3s/Kubernetes manifests into a
  per-PR namespace over the kube-apiserver (server-side apply), reusing the Kubernetes runner
  backend's shared apiserver client (Bearer ServiceAccount token + custom-CA TLS). Manifests
  are read checkout-free from either the PR repo (co-located) or a separate repo; the URL is
  derived from an ingress host template or read back from an applied Service/Ingress
  LoadBalancer (k3s Traefik / ServiceLB). It is wired symmetrically into the Cloudflare and
  Node facades (the Worker rejects a custom-CA config it can't honor), and local mode can
  point at a developer-run local k3s (its env URL-safety policy is widened to loopback/LAN).
  See `backend/docs/local-k3s-environments.md`.

  BREAKING (pre-1.0):

  - The `environments/connection` register/test wire shape now takes a discriminated `config`
    instead of a bare `manifest`, and the `environment_connections` table gains a `kind`
    column (existing rows backfill to `manifest`).
  - The `EnvironmentProvider` provision request gains optional `runRepo` / `resolveRepoFiles`
    seams (additive).
  - The deployment-wide environment-provider injection option
    (`buildNodeContainer({ environmentProvider })` / `startLocal({ environmentProvider })`) is
    removed — native adapters register via `registerEnvironmentBackend` instead.

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/contracts@0.51.0
  - @cat-factory/kernel@0.53.0
  - @cat-factory/integrations@0.35.0
  - @cat-factory/server@0.47.0
  - @cat-factory/node-server@0.42.0
  - @cat-factory/orchestration@0.41.2
  - @cat-factory/agents@0.21.16
  - @cat-factory/gitlab@0.3.7

## 0.23.1

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0
  - @cat-factory/contracts@0.50.1
  - @cat-factory/server@0.46.3
  - @cat-factory/orchestration@0.41.1
  - @cat-factory/integrations@0.34.1
  - @cat-factory/agents@0.21.15
  - @cat-factory/gitlab@0.3.6
  - @cat-factory/node-server@0.41.2

## 0.23.0

### Minor Changes

- 40f687d: Surface container/environment spin-up breakages on the agent step instead of hanging or hiding them.

  - **Local Docker mode fails fast.** `LocalContainerRunnerTransport` now aborts the
    container start the moment the container has exited (or a CLI call fails) instead of
    spinning for the full ready timeout, and the thrown error carries the real Docker
    stderr plus a tail of the container's own logs — so a broken daemon / failed image
    pull / crashing entrypoint shows the root cause in the step's failure card and the
    provisioning-logs drawer within one poll rather than ~60s of "spinning up container".
    Adds a `logs()` method to the `ContainerRuntimeAdapter` seam (Docker + Apple adapters).

  - **Kubernetes runner fails fast on doomed pods.** `KubernetesRunnerTransport` now
    detects terminal container start-up reasons (`ImagePullBackOff`/`ErrImagePull`/
    `InvalidImageName`/`CreateContainerConfigError`/`CrashLoopBackOff`/…) and aborts the
    readiness wait immediately with the pod's real `reason: message` as a hard `dispatch`
    failure — instead of polling the full 120s and then mis-tagging a deterministic failure
    (e.g. a bad image) as a recoverable "evicted" that the engine re-drives into the same
    120s hang. The recoverable timeout/terminated paths are also enriched with the latest
    pod-status detail so a stuck pod is no longer a bare "not ready within 120000ms".

  - **Custom EnvironmentProvider failures are stored and displayed.** A failed `deployer`
    provision (the provider threw, or returned `status:'failed'`) is now a real, displayed
    step failure: the errored environment (with the provider's verbatim `lastError`) is
    persisted and stamped onto the step, and the run records a new `environment`
    `AgentFailureKind` — instead of a green step with the error buried in its prose output.
    A provider that reports `status:'failed'` WITHOUT throwing can now carry its verbatim
    reason on the new optional `ProvisionedEnvironment.error` field (`@cat-factory/kernel`),
    which surfaces as the step's `lastError` instead of a generic "Provisioning failed". The
    failure is terminal + surfaced for one-click retry (NOT auto-retried), deliberately
    symmetric with the `dispatch` (container-failed-to-start) failure.

  **Breaking shape change:** `agentFailureKindSchema` gains the `environment` member.
  Pre-1.0, no migration — stale failure rows simply don't use the new kind.

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/contracts@0.50.0
  - @cat-factory/kernel@0.51.0
  - @cat-factory/integrations@0.34.0
  - @cat-factory/orchestration@0.41.0
  - @cat-factory/agents@0.21.14
  - @cat-factory/gitlab@0.3.5
  - @cat-factory/server@0.46.2
  - @cat-factory/node-server@0.41.1

## 0.22.2

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/contracts@0.49.0
  - @cat-factory/kernel@0.50.0
  - @cat-factory/integrations@0.33.0
  - @cat-factory/node-server@0.41.0
  - @cat-factory/server@0.46.1
  - @cat-factory/orchestration@0.40.2
  - @cat-factory/agents@0.21.13
  - @cat-factory/gitlab@0.3.4

## 0.22.1

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/contracts@0.48.0
  - @cat-factory/kernel@0.49.0
  - @cat-factory/integrations@0.32.0
  - @cat-factory/server@0.46.0
  - @cat-factory/node-server@0.40.0
  - @cat-factory/orchestration@0.40.1
  - @cat-factory/agents@0.21.12
  - @cat-factory/gitlab@0.3.3

## 0.22.0

### Minor Changes

- e3b3540: feat(environments): durable, asynchronous environment-provider config-repair agent

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  re-validation still fails) and the caller passed `allowAgentFallback`, the engine dispatches a
  coding agent that fixes the provider's config file in an existing repo and pushes the fix back.
  That repair is now a **durable, asynchronous, observable run** — modelled exactly on the
  "bootstrap repo" flow — instead of being awaited synchronously inside the `bootstrapRepo` HTTP
  request (a ~20-minute in-request poll loop that could not survive on the Cloudflare Worker).

  - The repair is its own `kind='env-config-repair'` run in the unified `agent_runs` table (no DB
    migration — the table is kind-scoped), driven durably by **Cloudflare Workflows**
    (`EnvConfigRepairWorkflow`) ⇄ **Node pg-boss** (`env-config-repair.advance` queue), and
    re-driven by the existing cron / stale-run sweeper on either runtime. Local mode inherits the
    pg-boss driver via `buildNodeContainer`.
  - `ContainerEnvConfigRepairer` (`@cat-factory/server`) is reworked into the kernel
    `EnvConfigRepairer` port (`startRepair`/`pollRepair`/`stopRepair`) — dispatch returns
    immediately; the durable runner polls. It still dispatches a plain `coding` job (no `bootstrap`
    block, no PR, no force-push), distinct from the repo-bootstrap flow.
  - `bootstrapRepo` now **starts** the repair run and returns immediately with `usedAgent:true`,
    `repairJobId`, and `ok:false` (pending); the new `EnvConfigRepairService` re-validates the repo
    on completion (via a callback into `EnvironmentConnectionService`, where the decrypted secrets +
    manifest config live) and records the terminal `ok`/`issues`. In PR mode the fix is targeted at
    the config PR branch, not the target branch.
  - The run is observable: progress/outcome is pushed as an `env-config-repair` workspace event and
    carried on the workspace snapshot (`envConfigRepairJobs`); the SPA holds it in the agentRuns
    store and rides the unified `agent-runs` retry/stop endpoints (the new kind supports both —
    retry re-starts a fresh run from the failed job's coords). There is no board block — a repair is
    surfaced only on the infrastructure-providers surface that triggered it.
  - Wired symmetrically across the Cloudflare, Node and local facades, with a cross-runtime
    conformance assertion (`driveEnvConfigRepair` + a fake `EnvConfigRepairer`) that drives a repair
    to `succeeded` with the post-repair validation recorded on both D1 and Postgres. Gated on the
    container prerequisites plus a provider that supports `describeRepairAgent`, so a stock
    deployment running the generic manifest provider is unchanged.
  - The original bootstrap `inputs` (which shape the repair agent's prompt) are persisted on the
    run record (internal, never on the wire), so a retry re-dispatches a fresh run with the SAME
    prompt context via `EnvConfigRepairService.retry` instead of dropping them.

  Breaking (pre-1.0, no migration): the `dispatchConfigRepair` /
  `CoreDependencies.dispatchEnvConfigRepair` seam is replaced by the `EnvConfigRepairer` /
  `EnvConfigRepairRunner` / `EnvConfigRepairJobRepository` ports + `Core.envConfigRepair`; any
  in-flight synchronous repair shape is obsolete.

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/contracts@0.47.0
  - @cat-factory/kernel@0.48.0
  - @cat-factory/server@0.45.0
  - @cat-factory/integrations@0.31.0
  - @cat-factory/orchestration@0.40.0
  - @cat-factory/node-server@0.39.0
  - @cat-factory/agents@0.21.11
  - @cat-factory/gitlab@0.3.2

## 0.21.1

### Patch Changes

- Updated dependencies [704c99e]
  - @cat-factory/integrations@0.30.0
  - @cat-factory/contracts@0.46.0
  - @cat-factory/server@0.44.0
  - @cat-factory/node-server@0.38.0
  - @cat-factory/orchestration@0.39.2
  - @cat-factory/agents@0.21.10
  - @cat-factory/gitlab@0.3.1
  - @cat-factory/kernel@0.47.2

## 0.21.0

### Minor Changes

- 2961b05: Meaningfully widen GitLab support in local mode — a `GITLAB_PAT` deployment now drives the
  real agent workflow, not just sign-in:

  - **`@cat-factory/gitlab`** adds `asGitHubClient(...)`, a `VcsClient`→`GitHubClient` adapter so
    any provider-neutral VCS client (e.g. `FetchGitLabClient`) satisfies the legacy `GitHubClient`
    port the engine's CI gate, merger and repo-read paths still consume.
  - **`@cat-factory/server`** resolves a run's repo origin (clone URL + provider) through an
    injectable `resolveRepoOrigin` seam and stamps the provider onto the dispatched job, instead
    of hardcoding a `github.com` clone URL. The default stays GitHub, so the Worker/Node facades
    are unchanged; a GitLab deployment supplies a GitLab origin so containers clone the right host
    and open merge requests. Without this the clone URL was always github.com, so a GitLab repo
    could never be cloned by an agent container.
  - **`@cat-factory/node-server`** threads `resolveRepoOrigin` through `NodeContainerOptions` to
    the container executor (default GitHub), so a sibling facade can supply a GitLab origin.
  - **`@cat-factory/local-server`** wires a GitLab PAT symmetrically to the GitHub PAT: the agent
    containers' git clone/push token falls back to `GITLAB_PAT`; the CI gate, mergeability, real
    merge and repo-link flows read through a PAT-backed `FetchGitLabClient` (adapted to
    `GitHubClient`); the agent containers clone the configured GitLab host + open merge requests
    (via `resolveRepoOrigin`); and the GitLab host is added to the harness clone/push allow-list
    (`GITHUB_ALLOWED_HOSTS`) so the container doesn't reject the GitLab clone URL. A GitLab-only
    local deployment is now a first-class source-control backend. Set `GITLAB_API_BASE` for a
    self-managed instance. The boot warning and the cross-provider `vcs-conformance` test cover
    both providers.
  - **`@cat-factory/executor-harness`** opens a GitLab **merge request** (not a GitHub PR) when the
    job's `repo.provider` is `gitlab` (set authoritatively by the server, so a self-managed GitLab
    on an arbitrarily-named host is routed correctly), falling back to host inference from the
    clone URL. The REST base + project path are derived from the host, and an already-open MR is
    reused on a resumed run. The GitHub path is unchanged. (The runner image must be republished
    for this to take effect in a deployed worker.)

### Patch Changes

- Updated dependencies [2961b05]
  - @cat-factory/node-server@0.37.0
  - @cat-factory/server@0.43.0
  - @cat-factory/gitlab@0.3.0

## 0.20.1

### Patch Changes

- Updated dependencies [5ad45de]
  - @cat-factory/orchestration@0.39.1
  - @cat-factory/server@0.42.1
  - @cat-factory/node-server@0.36.1

## 0.20.0

### Minor Changes

- 3d0b85c: feat(environments): wire the live environment-provider config-repair agent (PR #416 increment 2)

  When mechanical config bootstrap can't produce a valid provider config (`needsAgent`, or the
  post-commit re-validation still fails) and the caller passed `allowAgentFallback`, the engine now
  dispatches a coding agent that clones the target repo at the write branch, fixes the provider's
  config file in place, and pushes the fix back onto the same branch — then `EnvironmentConnectionService`
  re-validates.

  - New `ContainerEnvConfigRepairer` (`@cat-factory/server`) dispatches a plain `coding` job via the
    shared `RunnerJobClient`/`RunnerTransport` (no `bootstrap` block, no PR) and awaits it. It is
    distinct from the repo-bootstrap flow — it never reinitialises history or force-pushes.
  - The `dispatchConfigRepair` / `CoreDependencies.dispatchEnvConfigRepair` seam now returns `void`
    (it only pushes the fix); re-validation moved into `EnvironmentConnectionService`, where the
    decrypted secrets + manifest config live.
  - Wired symmetrically across the Cloudflare and Node facades (local inherits via `buildNodeContainer`),
    gated on the container prerequisites plus an injected provider that supports `describeRepairAgent`,
    so a stock deployment running the generic manifest provider is unchanged.

### Patch Changes

- Updated dependencies [3d0b85c]
  - @cat-factory/server@0.42.0
  - @cat-factory/integrations@0.29.0
  - @cat-factory/orchestration@0.39.0
  - @cat-factory/node-server@0.36.0

## 0.19.5

### Patch Changes

- c2ec53b: Local mode: env-PAT sign-in that's remembered across restarts.

  Local-mode sign-in is now purely **provider selection** — a "Sign in with configured
  GitHub/GitLab PAT" button for whichever of `GITHUB_PAT` / `GITLAB_PAT` is set in env. The
  paste-a-token textarea is **removed**: a pasted token only ever resolved an identity (it never
  became the operational clone/push token, which comes from env), so it was a dead-end. When
  neither PAT is configured, the login screen shows an informational notice (with scopes-preset
  token-creation links) instead of an empty form; email/password sign-in is unchanged.

  The chosen provider (a non-secret label — never the token) is remembered in `localStorage`, so
  on a later load the SPA silently re-mints a session from the env PAT without showing the login
  screen. Logout clears it (so logout sticks, no re-login loop); a transient/expiry 401 keeps it
  so the next load re-mints rather than bouncing to the login screen. The PAT never leaves the
  server.

  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY` are now **required** in local mode (no longer
  auto-generated per process). The per-process auto-generation was the original cause of "re-enter
  the PAT every restart" — a fresh session secret each boot invalidated the persisted session, and
  a fresh encryption key orphaned credentials sealed at rest. Boot now **fails loudly** with an
  actionable message when either is unset. A new `pnpm secrets` script in `deploy/local` prints
  both in the correct format (cross-platform, no `openssl` needed) to paste into `.env`.

  **Breaking (pre-1.0, no migration):**

  - the `localMode.patLogin.available` field is removed from the auth-config wire shape; only
    `configured` + `setupUrls` remain.
  - local mode no longer auto-generates `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY`; both must be set
    in the environment (generate via `pnpm secrets`).

- Updated dependencies [c2ec53b]
  - @cat-factory/contracts@0.45.1
  - @cat-factory/server@0.41.1
  - @cat-factory/agents@0.21.9
  - @cat-factory/gitlab@0.2.2
  - @cat-factory/integrations@0.28.1
  - @cat-factory/kernel@0.47.1
  - @cat-factory/orchestration@0.38.1
  - @cat-factory/node-server@0.35.5

## 0.19.4

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0
  - @cat-factory/contracts@0.45.0
  - @cat-factory/integrations@0.28.0
  - @cat-factory/server@0.41.0
  - @cat-factory/orchestration@0.38.0
  - @cat-factory/node-server@0.35.4
  - @cat-factory/agents@0.21.8
  - @cat-factory/gitlab@0.2.1

## 0.19.3

### Patch Changes

- Updated dependencies [0784fe0]
- Updated dependencies [0784fe0]
  - @cat-factory/orchestration@0.37.3
  - @cat-factory/server@0.40.3
  - @cat-factory/node-server@0.35.3

## 0.19.2

### Patch Changes

- Updated dependencies [5e54936]
- Updated dependencies [5e54936]
  - @cat-factory/orchestration@0.37.2
  - @cat-factory/server@0.40.2
  - @cat-factory/node-server@0.35.2

## 0.19.1

### Patch Changes

- Updated dependencies [cc101a7]
  - @cat-factory/orchestration@0.37.1
  - @cat-factory/server@0.40.1
  - @cat-factory/node-server@0.35.1

## 0.19.0

### Minor Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

- 56e6ce6: Local mode: sign in with a source-control PAT (GitHub or GitLab) or email/password.

  Local mode previously ran fully anonymous (dev-open, no user), so per-user features —
  personal subscriptions, your own API keys — failed with 401 ("Sign in to manage …") with
  no way to sign in. Local mode now establishes a real identity:

  - A new provider-agnostic `VcsIdentityResolver` port (kernel) turns a raw PAT into a
    neutral identity (the provider's stable numeric user id — the SAME subject GitHub OAuth
    uses, so a PAT login and an OAuth login resolve to one canonical user). GitHub and GitLab
    resolvers ship in `@cat-factory/server` / `@cat-factory/gitlab`; adding an Nth provider is
    one more resolver entry, no endpoint or UI changes.
  - A new `POST /auth/pat` endpoint (served only where resolvers are wired — local mode)
    mints a session for the account a PAT belongs to. The local login screen offers one-click
    "Continue with GitHub/GitLab" when a `GITHUB_PAT`/`GITLAB_PAT` is configured, an inline
    "paste a PAT" form otherwise, and email/password sign-in (enabled by default in local
    mode, with open signup on the developer's own machine).
  - The SPA now requires sign-in in local mode (anonymous use can't store per-user
    credentials); the session is honored even though the API otherwise runs dev-open.
  - `'gitlab'` is now an identity provider. Identities remain collision-safe via the
    `(provider, subject)` key: a GitHub user and a GitLab user with the same numeric id, and
    a password account (keyed on email), are always distinct.

  Also adds a guard on the per-user credential forms (personal subscriptions, your own API
  keys): when there is genuinely no signed-in user (a non-local deployment running with auth
  disabled), the inputs are blocked with a clear notice instead of accepting data that can't
  be saved.

  BREAKING (local mode only): existing anonymously-created local boards have no owner, so
  after upgrading they become inaccessible once sign-in is required — recreate them under
  your signed-in account. (Pre-1.0, no data migration.)

### Patch Changes

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/orchestration@0.37.0
  - @cat-factory/kernel@0.46.0
  - @cat-factory/contracts@0.44.0
  - @cat-factory/integrations@0.27.0
  - @cat-factory/server@0.40.0
  - @cat-factory/node-server@0.35.0
  - @cat-factory/gitlab@0.2.0
  - @cat-factory/agents@0.21.7

## 0.18.11

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/integrations@0.26.5
  - @cat-factory/orchestration@0.36.5
  - @cat-factory/node-server@0.34.8
  - @cat-factory/contracts@0.43.3
  - @cat-factory/kernel@0.45.5
  - @cat-factory/server@0.39.8
  - @cat-factory/agents@0.21.6

## 0.18.10

### Patch Changes

- Updated dependencies [fb339db]
  - @cat-factory/contracts@0.43.2
  - @cat-factory/agents@0.21.5
  - @cat-factory/integrations@0.26.4
  - @cat-factory/kernel@0.45.4
  - @cat-factory/orchestration@0.36.4
  - @cat-factory/server@0.39.7
  - @cat-factory/node-server@0.34.7

## 0.18.9

### Patch Changes

- Updated dependencies [7d219ab]
  - @cat-factory/server@0.39.6
  - @cat-factory/node-server@0.34.6

## 0.18.8

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3
  - @cat-factory/orchestration@0.36.3
  - @cat-factory/server@0.39.5
  - @cat-factory/node-server@0.34.5
  - @cat-factory/agents@0.21.4
  - @cat-factory/integrations@0.26.3

## 0.18.7

### Patch Changes

- Updated dependencies [1a349b5]
  - @cat-factory/server@0.39.4
  - @cat-factory/node-server@0.34.4

## 0.18.6

### Patch Changes

- Updated dependencies [80e5fc9]
  - @cat-factory/server@0.39.3
  - @cat-factory/node-server@0.34.3

## 0.18.5

### Patch Changes

- Updated dependencies [c11a0cc]
  - @cat-factory/agents@0.21.3
  - @cat-factory/contracts@0.43.1
  - @cat-factory/integrations@0.26.2
  - @cat-factory/kernel@0.45.2
  - @cat-factory/orchestration@0.36.2
  - @cat-factory/server@0.39.2
  - @cat-factory/node-server@0.34.2

## 0.18.4

### Patch Changes

- Updated dependencies [5363166]
- Updated dependencies [5363166]
  - @cat-factory/orchestration@0.36.1
  - @cat-factory/kernel@0.45.1
  - @cat-factory/server@0.39.1
  - @cat-factory/node-server@0.34.1
  - @cat-factory/agents@0.21.2
  - @cat-factory/integrations@0.26.1

## 0.18.3

### Patch Changes

- Updated dependencies [eab73b8]
- Updated dependencies [eab73b8]
  - @cat-factory/contracts@0.43.0
  - @cat-factory/kernel@0.45.0
  - @cat-factory/integrations@0.26.0
  - @cat-factory/orchestration@0.36.0
  - @cat-factory/server@0.39.0
  - @cat-factory/node-server@0.34.0
  - @cat-factory/agents@0.21.1

## 0.18.2

### Patch Changes

- Updated dependencies [67c7196]
  - @cat-factory/orchestration@0.35.1
  - @cat-factory/server@0.38.1
  - @cat-factory/node-server@0.33.2

## 0.18.1

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/contracts@0.42.0
  - @cat-factory/kernel@0.44.0
  - @cat-factory/agents@0.21.0
  - @cat-factory/orchestration@0.35.0
  - @cat-factory/server@0.38.0
  - @cat-factory/integrations@0.25.2
  - @cat-factory/node-server@0.33.1

## 0.18.0

### Minor Changes

- bbafec9: Add `@cat-factory/gitlab`: the opt-in GitLab VCS provider, the proof-of-concept
  second backend for the provider-neutral VCS abstraction. It implements the
  neutral `VcsClient` (repo/branch/MR/issue/CI reads + writes over the GitLab REST
  v4 API), a `VcsWebhookVerifier` + `VcsWebhookMapper` (constant-time
  `X-Gitlab-Token` check; `Merge Request`/`Issue`/`Push`/`Pipeline` hooks →
  neutral events), and a `VcsProvisioningClient`, and registers itself via
  `registerGitLab()` → `registerVcsProvider('gitlab')`. Depends only on
  `@cat-factory/kernel` + `@cat-factory/contracts`. Also refines the kernel
  `VcsWebhookMapper` port to take the resolved connection as a parameter.

  The provider is now WIRED into all runtime facades (single-token model, mirroring
  local-mode's PAT): a `GITLAB_TOKEN` (+ optional `GITLAB_API_BASE` /
  `GITLAB_CONNECTION_ID` / `GITLAB_WEBHOOK_SECRET`) enables it, the Worker + Node
  facades call `registerGitLab()` at container build (local inherits Node), and a
  new provider-neutral webhook receiver `POST /vcs/:provider/webhooks`
  (`@cat-factory/server`) verifies the signature against the registered
  `VcsWebhookVerifier`, maps the delivery via the registered `VcsWebhookMapper`, and
  hands the neutral event to the optional `VcsWebhookSink` kernel port. Adds a
  `GitLabConfig` to `AppConfig` and `vcsWebhookSink` to the server container.

  Bug fixes to the GitLab adapter: mergeability now prefers `detailed_merge_status`
  and only maps a genuine `conflict` to the `dirty` state the conflicts gate
  escalates on (a non-conflict block — CI pending, unresolved discussions, behind
  target — no longer spuriously spawns a conflict-resolver); `commitFiles` pins the
  commit parent via `start_sha` when `baseSha` is given; `getFileContent` resolves
  the project default branch instead of an unreliable `HEAD`; listing truncation at
  the page cap is now surfaced via an optional logger; the webhook mapper takes an
  injected `Clock` (deterministic timestamps) and reads the issue author.

  NOT yet migrated: the existing execution consumers (`resolveRepoTarget`, the
  CI/mergeability/merger/repo-files providers, the `github_*` projection
  persistence) still key on the GitHub installation id — projecting a neutral
  webhook event into provider-aware persistence is the remaining strangler step.

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0
  - @cat-factory/server@0.37.0
  - @cat-factory/node-server@0.33.0
  - @cat-factory/agents@0.20.3
  - @cat-factory/integrations@0.25.1
  - @cat-factory/orchestration@0.34.1

## 0.17.11

### Patch Changes

- Updated dependencies [63e2177]
  - @cat-factory/contracts@0.41.0
  - @cat-factory/integrations@0.25.0
  - @cat-factory/orchestration@0.34.0
  - @cat-factory/node-server@0.32.0
  - @cat-factory/agents@0.20.2
  - @cat-factory/kernel@0.42.2
  - @cat-factory/server@0.36.3

## 0.17.10

### Patch Changes

- Updated dependencies [6903cd7]
  - @cat-factory/orchestration@0.33.0
  - @cat-factory/server@0.36.2
  - @cat-factory/node-server@0.31.2

## 0.17.9

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/contracts@0.40.1
  - @cat-factory/kernel@0.42.1
  - @cat-factory/agents@0.20.1
  - @cat-factory/integrations@0.24.1
  - @cat-factory/orchestration@0.32.1
  - @cat-factory/server@0.36.1
  - @cat-factory/node-server@0.31.1

## 0.17.8

### Patch Changes

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
  - @cat-factory/server@0.36.0
  - @cat-factory/node-server@0.31.0
  - @cat-factory/contracts@0.40.0
  - @cat-factory/agents@0.20.0
  - @cat-factory/orchestration@0.32.0
  - @cat-factory/integrations@0.24.0

## 0.17.7

### Patch Changes

- Updated dependencies [b5231b0]
  - @cat-factory/contracts@0.39.0
  - @cat-factory/kernel@0.41.0
  - @cat-factory/agents@0.19.0
  - @cat-factory/orchestration@0.31.0
  - @cat-factory/server@0.35.0
  - @cat-factory/node-server@0.30.0
  - @cat-factory/integrations@0.23.5

## 0.17.6

### Patch Changes

- Updated dependencies [6d829bb]
  - @cat-factory/contracts@0.38.0
  - @cat-factory/kernel@0.40.0
  - @cat-factory/orchestration@0.30.0
  - @cat-factory/server@0.34.0
  - @cat-factory/node-server@0.29.0
  - @cat-factory/agents@0.18.5
  - @cat-factory/integrations@0.23.4

## 0.17.5

### Patch Changes

- Updated dependencies [714b7c9]
  - @cat-factory/contracts@0.37.0
  - @cat-factory/kernel@0.39.0
  - @cat-factory/orchestration@0.29.0
  - @cat-factory/server@0.33.0
  - @cat-factory/node-server@0.28.0
  - @cat-factory/agents@0.18.4
  - @cat-factory/integrations@0.23.3

## 0.17.4

### Patch Changes

- Updated dependencies [efbd910]
  - @cat-factory/contracts@0.36.0
  - @cat-factory/server@0.32.2
  - @cat-factory/agents@0.18.3
  - @cat-factory/integrations@0.23.2
  - @cat-factory/kernel@0.38.1
  - @cat-factory/orchestration@0.28.3
  - @cat-factory/node-server@0.27.4

## 0.17.3

### Patch Changes

- Updated dependencies [ae7bfcd]
  - @cat-factory/node-server@0.27.3

## 0.17.2

### Patch Changes

- Updated dependencies [692ccb4]
- Updated dependencies [692ccb4]
  - @cat-factory/server@0.32.1
  - @cat-factory/agents@0.18.2
  - @cat-factory/node-server@0.27.2
  - @cat-factory/orchestration@0.28.2

## 0.17.1

### Patch Changes

- Updated dependencies [a4ea607]
  - @cat-factory/contracts@0.35.0
  - @cat-factory/kernel@0.38.0
  - @cat-factory/server@0.32.0
  - @cat-factory/agents@0.18.1
  - @cat-factory/integrations@0.23.1
  - @cat-factory/orchestration@0.28.1
  - @cat-factory/node-server@0.27.1

## 0.17.0

### Minor Changes

- 76543fa: Add a **Human Review gate** — an opt-in pipeline step (`human-review`, pipeline `pl_pr_review`
  "Build & PR review") that watches a task's PR for a human code review on GitHub and loops the
  existing `fixer` agent to address feedback:

  - Advances once the PR meets GitHub's required approvals (read from branch protection) with no
    unresolved review threads.
  - Dispatches the `fixer` to address outstanding review threads (immediately when approved; after a
    per-task grace window otherwise), then resolves each handed thread on GitHub via the GraphQL
    review-thread API so the next probe sees it cleared. A reviewer re-opening a thread re-triggers a fix.
  - Waits indefinitely for the human (re-arming, never auto-failing), surfacing a `human_review`
    notification while it waits.
  - A human can request a freeform fix at any time from the gate window
    (`POST /workspaces/:ws/blocks/:blockId/human-review/request-fix`), dispatched immediately.

  Built as a registry gate in `@cat-factory/gates` (new `PullRequestReviewProvider` port +
  `GitHubPullRequestReviewProvider`, wired in every facade) reusing the generic gate driver, plus
  small generic engine seams: `pollExhaustion: 'rearm'`, a `GateDefinition.onHelperComplete` side-effect
  hook, and a `pendingFix` manual-inject path. Adds a per-task `humanReviewGraceMinutes` merge-preset
  knob (D1 ⇄ Drizzle migration). The cross-runtime conformance suite asserts the gate on every runtime.

  Review hardening:

  - Branch-protection's required-approval count is read against the PR's **actual base branch**
    (`pulls/{n}.base.ref`), not the repo default — so a PR into a stricter protected branch is gated
    against its own rule instead of silently defaulting to 1.
  - A **stalled fixer** (no progress on an unchanged head while feedback is outstanding) now raises a
    `human_review` notification instead of waiting silently/invisibly forever.
  - The awaiting-approval `human_review` card carries the run's `executionId`, so the inbox deep-links
    into the gate window (the "request a fix here" affordance) instead of merely selecting the block.
  - The thread-resolve reconcile is scoped strictly to threads the gate itself handed the fixer
    (retained until confirmed resolved) — a **third-party review bot's** open thread is never silently
    closed, and its feedback isn't mistaken for the fixer's own.
  - `requestHumanReviewFix` rejects (409) when the gate has no review provider / async executor wired,
    instead of accepting a request it would silently drop.
  - The static branch-protection read is cached on the gate state after the first probe, so an
    indefinite wait no longer re-reads it every poll.

  **Breaking:** `FIXER_AGENT_KIND` moved from `@cat-factory/orchestration`'s `ci.logic` to
  `@cat-factory/kernel` (re-exported from `ci.logic` for existing call sites); the `merge_threshold_presets`
  table gains a non-null `human_review_grace_minutes` column.

### Patch Changes

- Updated dependencies [76543fa]
  - @cat-factory/kernel@0.37.0
  - @cat-factory/contracts@0.34.0
  - @cat-factory/server@0.31.0
  - @cat-factory/agents@0.18.0
  - @cat-factory/orchestration@0.28.0
  - @cat-factory/integrations@0.23.0
  - @cat-factory/node-server@0.27.0

## 0.16.0

### Minor Changes

- 17adf4c: Local mode: warm container pool + checkout reuse, and optional native (host-process)
  execution of the developer's installed Claude Code / Codex CLI.

  **Warm pool + persistent checkout (default off = unchanged):** the local runner transport
  can keep idle harness containers warm and lease one — preferring a member that already holds
  the run's repo — instead of cold-starting a container per run. A leased member reuses a
  stable per-repo checkout (`git reset --hard` + a keep-list clean sweep that preserves
  dependency caches like `node_modules`, then `fetch` + switch branch) rather than cloning from
  scratch. New harness job field `persistentCheckout` drives this; it is set only by the local
  pool transport, so every other runtime keeps the ephemeral fresh-clone path byte-for-byte.
  Pooling is Docker-family only (the new `capabilities.pooling`); Apple `container` keeps the
  per-run path.

  **Configured in the UI + DB, not env:** the warm-pool sizing (size / pre-warm / max / idle
  timeout) and the per-repo checkout-reuse knobs (workspace root + dep-cache keep list) are a
  new per-deployment singleton (`local_settings`, Postgres/Drizzle only — local-mode-only, so
  no D1 mirror) exposed through a dedicated **"Local mode"** settings panel
  (Integrations → Local mode), served by a new `GET|PUT /local-settings` controller wired only
  on the local facade (503 elsewhere). This REPLACES the env vars `LOCAL_POOL_SIZE`,
  `LOCAL_POOL_MIN_WARM`, `LOCAL_POOL_MAX`, `LOCAL_POOL_IDLE_TTL_MS`, `HARNESS_WORKSPACE_ROOT`,
  `HARNESS_CLEAN_KEEP` (no longer read). The container transport forwards the checkout knobs to
  the harness container as `HARNESS_*` env. Breaking: those env vars are dropped — set the
  values in the UI instead.

  **Native execution (`LOCAL_NATIVE_AGENTS`, default off):** an allow-list of subscription
  harnesses (`claude-code,codex`) to run as a host process (new `LocalProcessRunnerTransport`)
  driving the developer's OWN installed `claude` / `codex` CLI with its ambient login (new
  harness `ambientAuth` mode) — no leased credential, no personal-credential gate for those
  vendors. Native applies ONLY to a listed harness's NATIVE vendor (Anthropic `claude` /
  OpenAI `codex`): a non-native vendor that reuses the `claude-code` harness (GLM/Kimi/DeepSeek
  carries its own base URL) and proxy/`pi` models are NOT run unsandboxed on the host — they
  keep the sandboxed per-run container path (so they still lease their real credential and
  still need `LOCAL_HARNESS_IMAGE`). Gated, local-facade-only, with the explicit no-sandbox /
  own-subscription trade documented. Requires `LOCAL_HARNESS_ENTRY`. The Tester's local
  docker-compose infra is reported unsupported in native mode for now (host-compose +
  git-worktree isolation are a follow-up phase).

  Breaking: none (all paths default off). The executor-harness image is bumped (1.16.0) for
  the new `persistentCheckout` / `ambientAuth` handling.

### Patch Changes

- Updated dependencies [17adf4c]
  - @cat-factory/node-server@0.26.0
  - @cat-factory/server@0.30.0
  - @cat-factory/integrations@0.22.0
  - @cat-factory/contracts@0.33.0
  - @cat-factory/kernel@0.36.0
  - @cat-factory/orchestration@0.27.1
  - @cat-factory/agents@0.17.2

## 0.15.0

### Minor Changes

- eb48652: Local-mode infrastructure delegation + native runner-adapter seam.

  Local mode now lets a workspace opt, independently, into delegating its container agents
  and/or its Tester ephemeral environments to an external service instead of running
  everything on the host container runtime. Two new per-workspace settings drive it
  (`delegateAgentsToRunnerPool`, `delegateTestEnvToProvider`, both default off), surfaced as
  toggles on the Ephemeral environments screen (local mode only) and enabled only once the
  respective provider — a self-hosted runner pool / an environment provider — is registered.

  - **Agents**: when delegated, container jobs dispatch to the workspace's registered runner
    pool instead of host Docker (a clean 409 at start, and the existing dispatch error, when
    delegated with no pool registered).
  - **Environments**: the toggle sets the local-mode default Tester environment — `local`
    (host Docker / DinD) by default, `ephemeral` (the provider) when on; per-service / per-task
    choices still win. An `ephemeral` run is refused at start when delegated with no provider
    connected.
  - **Native runner-adapter seam**: an injected `runnerPoolProvider` now drives the actual
    dispatch transport on both the Cloudflare and Node facades (falling back to the generic
    `HttpRunnerPoolProvider`), fully symmetric with `environmentProvider`. A wrapper can thus
    ship one package implementing `EnvironmentProvider` + `RunnerPoolProvider` (e.g. an in-house platform) to
    serve both concerns with native code on every runtime.

  BREAKING (pre-1.0, internal): an un-pinned Tester task in local mode now defaults to the
  `local` (DinD) environment instead of `ephemeral`. New `workspace_settings` columns are
  added on both runtimes (D1 migration + Drizzle migration); local mode now defaults
  `ENVIRONMENTS_ENABLED=true` so the env module assembles for the opt-in.

### Patch Changes

- Updated dependencies [eb48652]
- Updated dependencies [518aff7]
  - @cat-factory/contracts@0.32.0
  - @cat-factory/kernel@0.35.0
  - @cat-factory/orchestration@0.27.0
  - @cat-factory/node-server@0.25.0
  - @cat-factory/agents@0.17.1
  - @cat-factory/server@0.29.1

## 0.14.2

### Patch Changes

- Updated dependencies [9f7ee39]
- Updated dependencies [81b60d4]
  - @cat-factory/contracts@0.31.0
  - @cat-factory/kernel@0.34.0
  - @cat-factory/agents@0.17.0
  - @cat-factory/orchestration@0.26.0
  - @cat-factory/server@0.29.0
  - @cat-factory/node-server@0.24.0

## 0.14.1

### Patch Changes

- Updated dependencies [4dd6e97]
  - @cat-factory/agents@0.16.1
  - @cat-factory/server@0.28.1
  - @cat-factory/orchestration@0.25.1
  - @cat-factory/node-server@0.23.1

## 0.14.0

### Minor Changes

- ea59e91: Add the Kaizen agent: a post-run, continuous-improvement reviewer (toggleable per
  workspace, never a pipeline-builder step) that grades each completed agent step on how
  smooth/efficient vs confused/chaotic the interaction was and recommends prompt/model
  improvements.

  - After a run completes, the engine schedules a grading per completed agent step
    (skipping verified combos); a background sweep (Cloudflare cron / Node interval) runs
    the inline LLM grade. The grader's model is configured in Model Configuration like
    every other agent (the hidden-from-palette `kaizen` kind).
  - A `(promptVersion, agentKind, model)` combo that grades strongly (>=4) with no
    recommendations five times in a row is marked **verified** and is no longer graded.
  - New persisted tables `kaizen_gradings` + `kaizen_verified_combos` (D1 ⇄ Drizzle parity,
    asserted by a new cross-runtime conformance suite) and a per-workspace `kaizenEnabled`
    setting (a new `workspace_settings.kaizen_enabled` column).
  - New read API (`GET /workspaces/:ws/kaizen`, `GET /workspaces/:ws/executions/:id/kaizen`),
    a `kaizen` real-time event, a Kaizen screen (grading history + verified combos), and
    per-step grading status (scheduled/running/complete + results) inside the run window —
    never on the board.
  - A step with neither a provided-context snapshot nor any recorded LLM calls (e.g. prompt
    recording is off deployment-wide) is settled `failed` rather than graded blind, so a
    guessed grade can't advance a combo toward a bogus `verified`.
  - The Worker Kaizen sweep gains an in-isolate re-entrancy guard (mirroring the Node
    sweeper) so overlapping passes don't race the per-combo streak update.

### Patch Changes

- Updated dependencies [ea59e91]
  - @cat-factory/contracts@0.30.0
  - @cat-factory/kernel@0.33.0
  - @cat-factory/agents@0.16.0
  - @cat-factory/orchestration@0.25.0
  - @cat-factory/server@0.28.0
  - @cat-factory/node-server@0.23.0

## 0.13.4

### Patch Changes

- Updated dependencies [18f6b3b]
  - @cat-factory/server@0.27.2
  - @cat-factory/orchestration@0.24.2
  - @cat-factory/node-server@0.22.2

## 0.13.3

### Patch Changes

- Updated dependencies [4849c66]
- Updated dependencies [b82304e]
  - @cat-factory/server@0.27.1
  - @cat-factory/contracts@0.29.0
  - @cat-factory/kernel@0.32.0
  - @cat-factory/orchestration@0.24.1
  - @cat-factory/node-server@0.22.1
  - @cat-factory/agents@0.15.2

## 0.13.2

### Patch Changes

- Updated dependencies [765cc42]
  - @cat-factory/kernel@0.31.0
  - @cat-factory/contracts@0.28.0
  - @cat-factory/orchestration@0.24.0
  - @cat-factory/server@0.27.0
  - @cat-factory/node-server@0.22.0
  - @cat-factory/agents@0.15.1

## 0.13.1

### Patch Changes

- Updated dependencies [52d886a]
  - @cat-factory/kernel@0.30.0
  - @cat-factory/contracts@0.27.0
  - @cat-factory/agents@0.15.0
  - @cat-factory/orchestration@0.23.0
  - @cat-factory/node-server@0.21.1
  - @cat-factory/server@0.26.1

## 0.13.0

### Minor Changes

- a639189: Observability for ephemeral-environment and container provisioning.

  - **Unified provisioning event log.** A new append-only log records every attempt to
    spin up / tear down throwaway infrastructure — ephemeral environments
    (provision/teardown/status) and the runner-pool / per-run containers
    (dispatch/release/poll-failure) — with the outcome and the verbatim provider/runtime
    error on failure. Surfaced via `GET /workspaces/:ws/provisioning-logs` and a "View
    logs" button in the ephemeral-environment provider and self-hosted runner-pool config
    panels.
  - **Env lifecycle in run details.** An agent run's step now carries the ephemeral
    environment it runs against (spinning up / running / shut down / errored + URL/expiry
    - exact error), shown in the step detail (notably for the Tester).
  - **Container-start failures.** When a container/runner never accepts the job, the run
    details now say "Container failed to start" and show the exact provider/runtime error
    (a `dispatch`-kind failure) instead of a generic "Run failed". A run's step detail also
    has an "Infrastructure attempts" drawer (filtered by execution id) that surfaces that
    run's container/runner/env spin-up + tear-down attempts.
  - **Secret redaction.** The verbatim provider/runtime error and structured detail are
    scrubbed at the single recorder choke point before they are persisted/served — bearer
    tokens, `Authorization`/`x-api-key` header echoes, credentialed URLs, and recognisable
    token shapes (`sk-`/`ghp_`/`AKIA`/JWT) are replaced with `[REDACTED]` while the
    surrounding context (field name, URL host, token scheme) is kept for diagnosis.

  **Breaking / operational:** the provisioning log lives in a PHYSICALLY SEPARATE store to
  isolate its high write churn. The Cloudflare Worker needs a new `PROVISIONING_DB` D1
  binding (its own `migrations-provisioning` dir — create the database and apply its
  migrations); when absent, the feature is simply off. The Node service uses a dedicated
  `provisioning` Postgres schema, created with `CREATE SCHEMA IF NOT EXISTS` by `migrate()`
  on boot (the DB role needs `CREATE` on the database — the same privilege the app already
  uses to create its `public` tables). Retention is governed by `PROVISIONING_LOG_RETENTION_DAYS`
  (default 14). Catching a container dispatch error at the dispatch site means a transient
  dispatch blip is now a terminal `dispatch` failure (retry from the failure card) rather
  than relying on a Workflows step retry.

### Patch Changes

- Updated dependencies [a639189]
  - @cat-factory/kernel@0.29.0
  - @cat-factory/contracts@0.26.0
  - @cat-factory/orchestration@0.22.0
  - @cat-factory/server@0.26.0
  - @cat-factory/node-server@0.21.0
  - @cat-factory/agents@0.14.9

## 0.12.2

### Patch Changes

- Updated dependencies [ed3a673]
  - @cat-factory/contracts@0.25.1
  - @cat-factory/orchestration@0.21.1
  - @cat-factory/server@0.25.1
  - @cat-factory/agents@0.14.8
  - @cat-factory/kernel@0.28.1
  - @cat-factory/node-server@0.20.1

## 0.12.1

### Patch Changes

- Updated dependencies [69d2270]
  - @cat-factory/orchestration@0.21.0
  - @cat-factory/server@0.25.0
  - @cat-factory/node-server@0.20.0
  - @cat-factory/contracts@0.25.0
  - @cat-factory/kernel@0.28.0
  - @cat-factory/agents@0.14.7

## 0.12.0

### Minor Changes

- 3546e3d: Move operator/integration config out of environment variables into encrypted, UI-editable
  DB settings. DB is now the source of truth — the moved env vars are **removed** (no
  fallback), so the listed vars below no longer have any effect.

  **Per-workspace budget (Workspace settings → Budget).** A workspace's spend currency,
  monthly limit, and per-model price overrides now live on the `workspace_settings` row.
  The spend safeguard resolves each workspace's effective pricing (base table + overrides)
  behind a short-TTL cache, scoping the budget gate to the workspace's own usage
  (`SpendService.status`/`isOverBudget` now take a `workspaceId`; new
  `TokenUsageRepository.totalsSinceForWorkspace`). **Behaviour change:** spend is metered +
  gated per workspace, not deployment-wide; a workspace with no budget inherits the built-in
  default (~100 EUR/month). Removes env: `SPEND_MONTHLY_LIMIT`, `SPEND_CURRENCY`,
  `SPEND_MODEL_PRICES`. A budget of `0` is intentional ("no PAID spend"): metered runs are
  refused **up front** at start/retry with a clear `409` (not just a silent mid-run pause),
  while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS (flat-rate quota) keep
  running since they incur no metered cost — so `0` is the "local-/subscription-only" setting.
  The over-budget exemption (previously subscription-only) now also covers local-runner steps,
  inline and container alike. The hot-path per-workspace rollup is indexed
  (`idx_token_usage_workspace` on `(workspace_id, created_at)`, both runtimes).

  **Per-workspace incident enrichment (service inspector → Post-release health).** PagerDuty

  - incident.io credentials are sealed in a new per-workspace `incident_enrichment_connections`
    table (one grouped blob) and resolved/decrypted at enrichment time by a new
    `WorkspaceIncidentEnrichmentProvider`. Removes env: `PAGERDUTY_API_TOKEN`,
    `PAGERDUTY_FROM_EMAIL`, `INCIDENTIO_API_KEY`. The write API is three-state per provider
    group (omit ⇒ keep, `null` ⇒ clear, value ⇒ set) so one vendor can be removed without
    wiping the other.

  **Per-account integration secrets (Account settings → Deployment integrations, admin only).**
  The Slack app OAuth credentials and the container web-search upstream keys (Brave /
  SearXNG) now live in a new per-account `account_settings` table (one sealed secrets blob,
  HKDF tag `cat-factory:account-settings`), behind an admin-gated
  `GET|PUT /accounts/:id/settings`. Resolved dynamically: Slack OAuth at connect time, the
  web-search upstream per run (off the container session's account id). The executor now
  advertises the container `web_search` tool to a run **only when its account actually has
  keys** (so an agent is never handed a tool that always fails); a run with no upstream gets
  an empty result set rather than a hard `503`. Removes env:
  `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URL`, `WEB_SEARCH_BRAVE_API_KEY`,
  `WEB_SEARCH_SEARXNG_URL`, `WEB_SEARCH_SEARXNG_API_KEY` (the env-built upstream + its
  `createWebSearchUpstreamFromEnv`/`gateways.webSearch` fallback are deleted, not just
  unwired). (`SLACK_ENABLED` still gates Slack module assembly; the new tables/services
  assemble whenever `ENCRYPTION_KEY` is set.)

  **Hardening.** Re-sealing a partial settings/credentials write now **refuses** (clear `409`)
  when the stored blob can't be decrypted (e.g. after an encryption-key change) instead of
  silently dropping the un-edited secret group on the re-seal.

  New tables mirror across both runtimes (D1 migrations 0012–0014 ⇄ Drizzle schema +
  generated migration) with cross-runtime conformance assertions for the budget +
  incident-enrichment round-trips. `ENCRYPTION_KEY`, `AUTH_SESSION_SECRET`, and the GitHub
  App/OAuth secrets stay in env (bootstrap/auth). Retention windows, inline-web-search
  toggles, Langfuse keys, and execution timeouts intentionally remain env-configured.

### Patch Changes

- Updated dependencies [3546e3d]
  - @cat-factory/contracts@0.24.0
  - @cat-factory/kernel@0.27.0
  - @cat-factory/orchestration@0.20.0
  - @cat-factory/server@0.24.0
  - @cat-factory/node-server@0.19.0
  - @cat-factory/agents@0.14.6

## 0.11.11

### Patch Changes

- Updated dependencies [a62044d]
  - @cat-factory/kernel@0.26.1
  - @cat-factory/orchestration@0.19.2
  - @cat-factory/agents@0.14.5
  - @cat-factory/server@0.23.6
  - @cat-factory/node-server@0.18.6

## 0.11.10

### Patch Changes

- Updated dependencies [a0d5efc]
  - @cat-factory/server@0.23.5
  - @cat-factory/node-server@0.18.5

## 0.11.9

### Patch Changes

- Updated dependencies [2aae8bc]
  - @cat-factory/kernel@0.26.0
  - @cat-factory/agents@0.14.4
  - @cat-factory/orchestration@0.19.1
  - @cat-factory/server@0.23.4
  - @cat-factory/node-server@0.18.4

## 0.11.8

### Patch Changes

- Updated dependencies [f4f954b]
  - @cat-factory/kernel@0.25.0
  - @cat-factory/orchestration@0.19.0
  - @cat-factory/node-server@0.18.3
  - @cat-factory/agents@0.14.3
  - @cat-factory/server@0.23.3

## 0.11.7

### Patch Changes

- Updated dependencies [ce81233]
  - @cat-factory/contracts@0.23.0
  - @cat-factory/kernel@0.24.0
  - @cat-factory/agents@0.14.2
  - @cat-factory/orchestration@0.18.1
  - @cat-factory/server@0.23.2
  - @cat-factory/node-server@0.18.2

## 0.11.6

### Patch Changes

- Updated dependencies [7346a4f]
  - @cat-factory/kernel@0.23.0
  - @cat-factory/orchestration@0.18.0
  - @cat-factory/agents@0.14.1
  - @cat-factory/server@0.23.1
  - @cat-factory/node-server@0.18.1

## 0.11.5

### Patch Changes

- Updated dependencies [6ff1f10]
  - @cat-factory/contracts@0.22.0
  - @cat-factory/kernel@0.22.0
  - @cat-factory/agents@0.14.0
  - @cat-factory/orchestration@0.17.0
  - @cat-factory/server@0.23.0
  - @cat-factory/node-server@0.18.0

## 0.11.4

### Patch Changes

- Updated dependencies [04befe8]
  - @cat-factory/contracts@0.21.0
  - @cat-factory/kernel@0.21.0
  - @cat-factory/agents@0.13.0
  - @cat-factory/server@0.22.0
  - @cat-factory/orchestration@0.16.0
  - @cat-factory/node-server@0.17.0

## 0.11.3

### Patch Changes

- Updated dependencies [be182e8]
  - @cat-factory/kernel@0.20.0
  - @cat-factory/agents@0.12.0
  - @cat-factory/orchestration@0.15.0
  - @cat-factory/server@0.21.0
  - @cat-factory/node-server@0.16.0

## 0.11.2

### Patch Changes

- Updated dependencies [2c24da8]
  - @cat-factory/contracts@0.20.0
  - @cat-factory/kernel@0.19.0
  - @cat-factory/orchestration@0.14.0
  - @cat-factory/server@0.20.0
  - @cat-factory/node-server@0.15.0
  - @cat-factory/agents@0.11.16

## 0.11.1

### Patch Changes

- 4120ac5: Nested tasks (epics) + a first-class task dependency graph.

  **Epics** are a new non-structural block level (`level: 'epic'`). An epic groups tasks
  that may live under different services/modules via the tasks' new `epicId` membership
  link (independent of `parentId`, so deleting an epic clears membership but never deletes
  the member tasks). The board draws an epic node linked to all its members, and the epic
  inspector shows the full member tree grouped service → module → task. Add one via
  `POST /workspaces/:ws/epics`; assign/detach a task via `POST /blocks/:id/epic`.

  **Importing a Jira epic / GitHub parent issue** spawns the epic + its children onto the
  board in one shot (`POST /workspaces/:ws/task-sources/:source/epics/spawn`, or the "As
  epic" button in the issue-import modal): an epic node, a board task per child issue
  (joined to the epic), and `dependsOn` edges seeded from the issues' **"blocked by" /
  "depends on"** links. Jira links come from `issuelinks` + `parent`/`subtasks` + epic
  children (JQL); GitHub children come from native **sub-issues** and dependency links are
  parsed from the issue body (`Blocked by #12`, `Depends on owner/repo#34`). The
  `GitHubClient` port gains `listSubIssues` + a `parentRef` on issue detail.

  **Dependency enforcement** is now hard and server-side: `ExecutionService.start()` refuses
  (409) to start a task while any block it `dependsOn` is unfinished — enforced for manual,
  recurring, auto-start and direct-API starts alike. Adding a dependency edge that would
  close a **cycle** is rejected (422).

  **Auto-start**: a preceding task carries an `autoStartDependents` toggle (task inspector).
  When it merges, the engine automatically starts every task that depends on it whose other
  dependencies are also done — skipping any on an individual-usage model (which can't unlock
  unattended).

  **Board UX**: a drag-to-connect handle on task cards creates dependency edges directly on
  the canvas (drag from the prerequisite onto the dependent); the dependency-edge overlay
  also draws epic→member membership links.

  Persisted on both runtimes (D1 migration `0010_epics_dependencies` ⇄ Drizzle
  `epic_id` / `auto_start_dependents` columns); the cross-runtime conformance suite asserts
  the epic + membership round-trip, the cycle rejection, and the dependency start gate on
  each store.

  Breaking (pre-1.0, acceptable): the `blocks` table gains `epic_id` / `auto_start_dependents`
  columns and the `level` enum gains `epic`; no migration shims.

- Updated dependencies [4120ac5]
  - @cat-factory/contracts@0.19.0
  - @cat-factory/kernel@0.18.0
  - @cat-factory/orchestration@0.13.0
  - @cat-factory/server@0.19.0
  - @cat-factory/node-server@0.14.1
  - @cat-factory/agents@0.11.15

## 0.11.0

### Minor Changes

- 25efe48: Add UI-configurable provider config + per-user GitHub PAT, with provider self-describe and connection-test.

  - Providers self-describe the config they expect (`describeConfig`) and can be connection-tested (`testConnection`) before saving — added as optional methods on the `EnvironmentProvider` and `RunnerPoolProvider` kernel ports, implemented by the generic HTTP adapters (secret-key fields from the manifest + an authed probe), and surfaced via new `GET …/environments/provider`, `POST …/environments/connection/test`, `GET …/runner-pool/provider`, `POST …/runner-pool/connection/test` endpoints. The SPA renders the descriptor fields generically.
  - New generic, `kind`-discriminated per-user secret store (`user_secrets`, mirrored D1 ⇄ Drizzle) with `UserSecretService` + a kind registry (first kind: `github_pat`). User-scoped `GET/POST/DELETE /user-secrets` + `…/test`; a "My GitHub token" entry under Integrations → Source control.
  - A run you initiate now prefers YOUR stored GitHub PAT over the deployment's GitHub App / env token for the container push token AND the engine CI-gate + merge reads (resolved by the run initiator via an ambient `RunInitiatorScope`), falling back to the existing source when you have none. Wired symmetrically across the Cloudflare, Node and local facades.

  Breaking: none for existing data. The local-mode `GITHUB_PAT` env var still works as a fallback.

### Patch Changes

- Updated dependencies [25efe48]
  - @cat-factory/contracts@0.18.0
  - @cat-factory/kernel@0.17.0
  - @cat-factory/server@0.18.0
  - @cat-factory/orchestration@0.12.0
  - @cat-factory/node-server@0.14.0
  - @cat-factory/agents@0.11.14

## 0.10.11

### Patch Changes

- c7b8012: Improve the requirements-review experience.

  **Auto-save answers (no button).** The requirements-review window no longer has a "Save
  answer" button: an answer is seeded into its textarea from the recorded reply and persisted
  on blur (and flushed before incorporate/proceed), so a value just needs to be typed.

  **"Recommend something" + the Requirement Writer.** A finding can now be marked for a
  grounded recommendation instead of being answered or dismissed. A new second companion of
  the requirements reviewer — the **Requirement Writer** (an inline LLM call, `WRITER_SYSTEM_PROMPT`
  `requirement-writer@v1`) — produces a suggested answer per finding, grounded in this
  precedence order: the block's **best-practice fragments** (team/org standards — checked
  FIRST; a match is flagged as the "current standard" and surfaced with a badge), then the
  in-repo `spec/` + `tech-spec/` (via the checkout-free `RepoFiles` port), then web search
  (provider-hosted on Anthropic/OpenAI models; gateway-RAG wiring lands separately).
  Recommendations are NOT AI-reviewed — the human accepts (it becomes the finding's answer,
  folded into the next incorporation), rejects, or re-requests with a "do it differently"
  note. Recommendations are a first-class collection on the review that survives the re-review
  item churn.

  - Contracts: `recommend_requested` item status, `RequirementRecommendation` +
    `recommendations[]` on `RequirementReview`, and the request schemas.
  - Persistence (both runtimes): a `recommendations` JSON column on `requirement_reviews`
    (new D1 migration `0009` ⇄ Drizzle column + generated migration).
  - Service: `RequirementReviewService.recommend` / `acceptRecommendation` /
    `rejectRecommendation` / `reRequestRecommendation`, with optional `resolveRunRepoContext`
    - best-practice-fragment resolver deps (degrade gracefully when unwired).
  - Controller: `POST /blocks/:blockId/requirement-review/recommend` and the
    `…/recommendations/:recId/{accept,reject,re-request}` routes.

  **Board progress for the review companions.** While the review is incorporating, re-reviewing
  or recommending, the board task card / mini-pipeline / inspector now show a spinning stage
  label (`Recommending…` added alongside the existing `Incorporating…` / `Re-reviewing…`).

- Updated dependencies [c7b8012]
  - @cat-factory/contracts@0.17.1
  - @cat-factory/kernel@0.16.2
  - @cat-factory/agents@0.11.13
  - @cat-factory/orchestration@0.11.1
  - @cat-factory/server@0.17.2
  - @cat-factory/node-server@0.13.4

## 0.10.10

### Patch Changes

- Updated dependencies [aa06003]
  - @cat-factory/contracts@0.17.0
  - @cat-factory/orchestration@0.11.0
  - @cat-factory/kernel@0.16.1
  - @cat-factory/server@0.17.1
  - @cat-factory/node-server@0.13.3
  - @cat-factory/agents@0.11.12

## 0.10.9

### Patch Changes

- Updated dependencies [208c933]
  - @cat-factory/kernel@0.16.0
  - @cat-factory/server@0.17.0
  - @cat-factory/agents@0.11.11
  - @cat-factory/orchestration@0.10.9
  - @cat-factory/node-server@0.13.2

## 0.10.8

### Patch Changes

- 494fb34: Finish the Task-5 strangler: migrate the last two built-in agents (conflict-resolver and
  repo bootstrap) onto the single, manifest-driven `agent` harness kind, then delete every
  bespoke per-kind handler and collapse the dispatch surface. The harness is now a generic
  LLM-over-a-checkout runner with **one** kind — WHAT each agent does is decided entirely by
  the backend and carried as job data.

  **conflict-resolver** now dispatches `kind: 'agent'` `mode: 'coding'` with a `mergeBase`
  (full clone of the PR branch). `handleAgent`'s coding flow merges `origin/<mergeBase>` in to
  surface the conflicts, leads the prompt with the actual conflict hunks it discovers, then
  completes the merge commit and pushes back onto the same branch (no new PR) — refusing to
  push a half-resolved tree. Routed through `buildMigratedBuiltInBody`; the bespoke
  `/resolve-conflicts` body + handler are gone.

  **bootstrap** now dispatches `kind: 'agent'` `mode: 'coding'` with a `bootstrap` spec
  (`{ target, reference?, reinit, forcePush, fromScratch? }`). `handleAgent` clones the
  reference architecture (or scaffolds from an empty dir), runs the agent, guards against a
  no-op, then force-pushes a fresh single-commit history to the separate target repo's default
  branch (lifted `reinitAndPush` / `producedRepoContent`). `ContainerRepoBootstrapper` builds
  the generic body; its `linkRepoToBlock` post-op already lives in `pollBootstrapJob`.

  **Harness cleanup (image bump).** Deleted the bespoke handlers (`blueprint`/`spec`/`explore`/
  `merger`/`on-call`/`tester`/`ci-fixer`/`fixer`/`conflict-resolver`/`bootstrap`/`handleRun`),
  collapsed `server.ts`'s `KINDS` to `{ agent }`, and stripped the bespoke job types + parsers
  from `job.ts` (keeping `parseAgentJob` + the shared helpers + `BootstrapTargetSpec`). The
  executor-harness image is bumped (1.13.0 → 1.14.0; deploy tag + `wrangler.toml`).

  **Kernel (breaking, pre-1.0).** `RunnerDispatchKind` collapses to the single member
  `'agent'`, and `RunnerJobResult` is slimmed to `prUrl` / `branch` / `summary` / `error` /
  `defaultBranch` / `pushed` / `custom` / `usage` (the per-kind `service`/`spec`/`assessment`/
  `onCallAssessment`/`report`/`resolved` channels are removed — every structured agent returns
  its doc on `custom`, coerced kind-aware in `toRunResult`). The transports default to
  `kind: 'agent'`; the runner-pool result coercion passes only `custom` through.

  Two fixes ride along. (1) `toRunResult` now surfaces an opened PR (`prUrl`) **before** the
  in-place-fixer `pushed` branch — the migrated coder returns BOTH `pushed: true` and `prUrl`,
  so the previous ordering silently dropped its structured `pullRequest` (the worker test only
  passed because its fake omitted `pushed`). (2) The local transport ran the per-run container
  privileged off `kind === 'test'`, which never matched after the tester migration; the
  container is per-RUN (created by the run's first step, not the tester), so it now runs
  privileged whenever `privilegedTestJobs` is enabled (gated by the `localDind` capability).

- Updated dependencies [494fb34]
  - @cat-factory/server@0.16.1
  - @cat-factory/kernel@0.15.1
  - @cat-factory/node-server@0.13.1
  - @cat-factory/agents@0.11.10
  - @cat-factory/orchestration@0.10.8

## 0.10.7

### Patch Changes

- Updated dependencies [0ac64b8]
  - @cat-factory/kernel@0.15.0
  - @cat-factory/contracts@0.16.0
  - @cat-factory/server@0.16.0
  - @cat-factory/node-server@0.13.0
  - @cat-factory/agents@0.11.9
  - @cat-factory/orchestration@0.10.7

## 0.10.6

### Patch Changes

- Updated dependencies [7d1f829]
  - @cat-factory/server@0.15.1
  - @cat-factory/agents@0.11.8
  - @cat-factory/node-server@0.12.3
  - @cat-factory/orchestration@0.10.6

## 0.10.5

### Patch Changes

- Updated dependencies [fde0437]
  - @cat-factory/contracts@0.15.0
  - @cat-factory/kernel@0.14.0
  - @cat-factory/server@0.15.0
  - @cat-factory/agents@0.11.7
  - @cat-factory/orchestration@0.10.5
  - @cat-factory/node-server@0.12.2

## 0.10.4

### Patch Changes

- Updated dependencies [77b7d31]
  - @cat-factory/agents@0.11.6
  - @cat-factory/server@0.14.1
  - @cat-factory/orchestration@0.10.4
  - @cat-factory/kernel@0.13.4
  - @cat-factory/node-server@0.12.1

## 0.10.3

### Patch Changes

- Updated dependencies [82d771e]
  - @cat-factory/contracts@0.14.0
  - @cat-factory/server@0.14.0
  - @cat-factory/node-server@0.12.0
  - @cat-factory/agents@0.11.5
  - @cat-factory/kernel@0.13.3
  - @cat-factory/orchestration@0.10.3

## 0.10.2

### Patch Changes

- Updated dependencies [ce27690]
  - @cat-factory/contracts@0.13.1
  - @cat-factory/kernel@0.13.2
  - @cat-factory/agents@0.11.4
  - @cat-factory/server@0.13.2
  - @cat-factory/orchestration@0.10.2
  - @cat-factory/node-server@0.11.2

## 0.10.1

### Patch Changes

- Updated dependencies [c8bd144]
  - @cat-factory/server@0.13.1
  - @cat-factory/orchestration@0.10.1
  - @cat-factory/kernel@0.13.1
  - @cat-factory/node-server@0.11.1
  - @cat-factory/agents@0.11.3

## 0.10.0

### Minor Changes

- 5c915fd: Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
  UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

  A source is now offered to a workspace when it is **available** AND **enabled**:

  - Availability is intrinsic, not a deployment switch. Jira is always registered (its
    credentials are per-workspace, entered in the UI) and is available once connected.
    GitHub Issues registers whenever the GitHub integration is configured and is available
    once the workspace has installed the GitHub App — it rides that App, so there is nothing
    to "connect" (the credentialless connect path now returns a clear error).
  - `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
    GitHub Issues to use GitHub repos without offering their issues, or park a connected
    Jira without disconnecting it. A disabled source is hidden from the import/link UI and
    its import/search endpoints are refused (409).

  New surface:

  - `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
    ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
    `TaskSourceSettingsRepository` kernel port.
  - `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
    `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
  - The SPA settings modal hosts the toggle, and import entry points key off the offered
    (available + enabled) set instead of raw connections.

  BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
  `TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
  which sources a workspace uses is now controlled in the app, not by the operator.

### Patch Changes

- Updated dependencies [5c915fd]
  - @cat-factory/contracts@0.13.0
  - @cat-factory/kernel@0.13.0
  - @cat-factory/orchestration@0.10.0
  - @cat-factory/server@0.13.0
  - @cat-factory/node-server@0.11.0
  - @cat-factory/agents@0.11.2

## 0.9.1

### Patch Changes

- Updated dependencies [22d7fff]
  - @cat-factory/server@0.12.1
  - @cat-factory/agents@0.11.1
  - @cat-factory/node-server@0.10.1
  - @cat-factory/orchestration@0.9.1

## 0.9.0

### Minor Changes

- 128e12e: Custom agents: live pre/post-op execution + data-driven palette + generic result view.

  Registered custom agent kinds now run end to end. A kind's deterministic backend hooks
  fire around its agent step: `ExecutionService` runs its `preOps` before dispatch and its
  `postOps` after the result is recorded, over a per-run, checkout-free `RepoFiles` bound to
  the run's repo. The binding is a new optional engine dependency `resolveRunRepoContext`
  (`CoreDependencies` / `ExecutionServiceDependencies`), composed from a facade's wired
  `GitHubClient` + the executor's `resolveRepoTarget` via the new
  `makeResolveRunRepoContext` (`@cat-factory/server`) and wired symmetrically across ALL
  three facades (Worker `selectGitHubDeps`, Node `githubGateDeps`, local via
  `buildNodeContainer`). When GitHub isn't connected the hooks are skipped, so pipelines run
  unchanged without the feature. `runRepoOps` moved to `@cat-factory/agents` so the
  orchestration engine drives the hooks without importing the server HTTP layer. New kernel
  ports: `RunRepoContext` + `ResolveRunRepoContext`. The cross-runtime conformance suite
  asserts a registered kind's pre-op read + post-op commit on both D1 and Postgres.

  Frontend: the workspace snapshot now carries `customAgentKinds` (kind + presentation +
  container flag), which the SPA merges into its palette catalog
  (`useAgentsStore().registerCustomKinds`) so a registered kind is a first-class palette
  block + result view instead of the generic fallback. A `container-explore` structured
  kind's `result.custom` JSON is recorded on the step (new `PipelineStep.custom`) and
  rendered read-only by a new shared `generic-structured` result view — a custom agent gets
  a usable result window with no bespoke UI.

  The built-in agents are not yet migrated to this model (their rendering still lives in the
  executor-harness); that strangler conversion is sequenced as follow-up work. See
  `backend/docs/custom-agents.md` and the `@cat-factory/example-custom-agent` worked example.

### Patch Changes

- Updated dependencies [128e12e]
- Updated dependencies [4de2f5f]
- Updated dependencies [4de2f5f]
  - @cat-factory/kernel@0.12.0
  - @cat-factory/agents@0.11.0
  - @cat-factory/contracts@0.12.0
  - @cat-factory/orchestration@0.9.0
  - @cat-factory/server@0.12.0
  - @cat-factory/node-server@0.10.0

## 0.8.3

### Patch Changes

- f8a24e0: Refresh dependencies to latest. Notable major bumps: TypeScript 5→6 (tooling
  packages), vitest 3→4, pino 9→10, `@hono/node-server` 1→2, `@hono/valibot-validator`
  0.5→0.6, happy-dom 15→20, and `@types/node` →26. Patch/minor refreshes for `ai`,
  `hono`, `wrangler`, `pg-boss`, `ws`, `@ai-sdk/*`, `oxlint`, and the Cloudflare
  workers tooling.
- Updated dependencies [f8a24e0]
  - @cat-factory/agents@0.10.1
  - @cat-factory/kernel@0.11.1
  - @cat-factory/orchestration@0.8.1
  - @cat-factory/server@0.11.1
  - @cat-factory/node-server@0.9.1

## 0.8.2

### Patch Changes

- Updated dependencies [1e31cbc]
  - @cat-factory/contracts@0.11.0
  - @cat-factory/kernel@0.11.0
  - @cat-factory/orchestration@0.8.0
  - @cat-factory/agents@0.10.0
  - @cat-factory/server@0.11.0
  - @cat-factory/node-server@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [d0081e1]
  - @cat-factory/contracts@0.10.0
  - @cat-factory/agents@0.9.0
  - @cat-factory/server@0.10.0
  - @cat-factory/kernel@0.10.1
  - @cat-factory/orchestration@0.7.7
  - @cat-factory/node-server@0.8.1

## 0.8.0

### Minor Changes

- ae29687: OpenRouter: dynamic multi-tenant catalog + flavour unification.

  **Flavour unification.** A catalog model can now carry an `openrouter` flavour alongside
  `cloudflare`/`direct`/`subscription`. `effectiveVariant` resolves in the precedence
  direct → openrouter → cloudflare (the subscription override still wins in `ModelRouter`),
  so the SAME logical model routes through OpenRouter when only an OpenRouter key is
  configured, and through its native vendor when that key is present. The standalone
  `openrouter-*` catalog entries are folded into their native twins: `deepseek`, `gpt-5.5`
  and `claude-opus` gain an `openrouter` route; Gemini 3 Pro becomes a curated `gemini`
  entry. **Breaking (pre-1.0, acceptable):** the catalog ids `openrouter-claude-opus`,
  `openrouter-gpt`, `openrouter-deepseek`, `openrouter-gemini-pro` and `openrouter-llama`
  are removed — a block pinned to one falls through to default routing.

  **Dynamic catalog.** A workspace can now browse OpenRouter's live `/models` and enable a
  subset in the UI (the new "OpenRouter models" panel), rather than a hardcoded handful.
  Enabled models surface in the per-workspace picker as `openrouter:<slug>` entries with
  their live context window and price (overlaid onto the spend table, so budgets meter
  accurately). Persisted in a new generic per-workspace `provider_model_catalog` table
  (D1 ⇄ Drizzle, keyed by `(workspace_id, provider)` so future gateways like LiteLLM reuse
  it), behind the new kernel `ProviderModelCatalogRepository` port and the
  `OpenRouterCatalogService` (refresh leases the workspace's pooled OpenRouter key). New
  routes: `GET|PUT /workspaces/:ws/openrouter/catalog`, `POST /workspaces/:ws/openrouter/refresh`.
  Cross-runtime conformance asserts the enabled-subset round-trip + catalog surfacing on
  both D1 and Postgres.

### Patch Changes

- Updated dependencies [ae29687]
  - @cat-factory/contracts@0.9.0
  - @cat-factory/kernel@0.10.0
  - @cat-factory/server@0.9.0
  - @cat-factory/node-server@0.8.0
  - @cat-factory/agents@0.8.2
  - @cat-factory/orchestration@0.7.6

## 0.7.6

### Patch Changes

- Updated dependencies [5c20968]
  - @cat-factory/kernel@0.9.0
  - @cat-factory/server@0.8.0
  - @cat-factory/agents@0.8.1
  - @cat-factory/orchestration@0.7.5
  - @cat-factory/node-server@0.7.5

## 0.7.5

### Patch Changes

- Updated dependencies [c70df09]
  - @cat-factory/agents@0.8.0
  - @cat-factory/contracts@0.8.0
  - @cat-factory/kernel@0.8.0
  - @cat-factory/orchestration@0.7.4
  - @cat-factory/server@0.7.4
  - @cat-factory/node-server@0.7.4

## 0.7.4

### Patch Changes

- Updated dependencies [a0a1bcc]
  - @cat-factory/kernel@0.7.3
  - @cat-factory/node-server@0.7.3
  - @cat-factory/agents@0.7.3
  - @cat-factory/orchestration@0.7.3
  - @cat-factory/server@0.7.3

## 0.7.3

### Patch Changes

- fef2964: Add `@cat-factory/sandbox` and `@cat-factory/local-server` to the root `tsc -b`
  build graph (`backend/tsconfig.build.json`). They were publishable (`private: false`,
  `publishConfig.access: public`) and declared `files: ["dist"]`, but neither was
  referenced by the build graph nor pulled in transitively, so `pnpm build` (which
  `ci:publish` runs before `changeset publish`) never produced their `dist`. The last
  release therefore published both with only `package.json` + `LICENSE` and no code.
  This patch re-releases them with their built output. (`@cat-factory/consensus` was
  unaffected — it builds transitively via the cloudflare/node graphs.)

## 0.7.2

### Patch Changes

- 4fa5ed9: Re-release all publishable packages. The previous release bumped these on `main` but never reached npm (the publish job was never triggered), so npm is a release behind. This changeset re-triggers the release so every package publishes.
- Updated dependencies [4fa5ed9]
  - @cat-factory/agents@0.7.2
  - @cat-factory/contracts@0.7.2
  - @cat-factory/kernel@0.7.2
  - @cat-factory/node-server@0.7.2
  - @cat-factory/orchestration@0.7.2
  - @cat-factory/server@0.7.2

## 0.7.1

### Patch Changes

- 7463cf2: Add `repository` metadata (url + monorepo `directory`) to every published package.json. npm provenance attestation rejected the previous release because `repository.url` was empty and could not be matched against the source repo; declaring it lets the publish (and provenance) succeed, and re-triggers publishing of all packages from the failed release.
- Updated dependencies [7463cf2]
  - @cat-factory/agents@0.7.1
  - @cat-factory/contracts@0.7.1
  - @cat-factory/kernel@0.7.1
  - @cat-factory/node-server@0.7.1
  - @cat-factory/orchestration@0.7.1
  - @cat-factory/server@0.7.1

## 0.7.0

### Minor Changes

- 385bd93: Add an optional consensus-orchestration framework + a core Task Estimator.

  A new opt-in `@cat-factory/consensus` package lets an eligible agent step run through
  a multi-model **consensus** process — a specialist panel, a debate, or ranked
  voting/scoring — to produce a higher-quality result of the same shape the single-actor
  agent would have (a polished document, an aggregate of observations, an estimate). It
  integrates via the `AgentExecutor` seam: a `ConsensusAgentExecutor` wraps the standard
  composite and delegates to it when a step isn't consensus-enabled or gating marks the
  task ineligible. Eligibility is surfaced through a new group of assignable capability
  traits (`specialist-panel-capable` / `debate-capable` / `ranked-voting-capable`); the
  pipeline builder shows an "Enable Consensus" toggle (strategy, participants + models,
  optional risk/impact gating) on eligible steps. Each session persists a full transcript
  (`consensus_sessions`, both runtimes) rendered in a dedicated Consensus Session window
  and streamed live via a new `consensus` workspace event; every sub-call flows to
  `llm_call_metrics`. Wired per facade behind `CONSENSUS_ENABLED` (off ⇒ unchanged).

  A new **core** `task-estimator` agent rates a task's Complexity/Risk/Impact (0..1) after
  requirements are clarified; the engine persists it on `block.estimate` (new column on
  both stores) and the inspector shows the ratings. It gates the expensive consensus step
  and is useful standalone for triage.

  BREAKING (pre-1.0, no migration): `Block` gains `estimate`, the pipeline + pipeline-step
  shapes gain `consensus`, `AgentRunContext` gains `consensus` + `block.estimate`, and the
  `WorkspaceEvent` union + `ExecutionEventPublisher` gain a consensus variant. Stale rows /
  shapes simply re-create.

- e8005ba: Datadog post-release-health gate + Agent-On-Call.

  After a release ships, a new **`post-release-health`** polling gate watches the team's
  Datadog **monitors/SLOs** over a monitoring window. It reuses the existing gate machinery
  (`ci`/`conflicts`): a clean window advances with nothing spun up; a regression escalates —
  Datadog credentials stay on the backend and never enter containers.

  The gate is **opt-in**: it is NOT in any default pipeline. A user adds it deliberately in
  the pipeline builder, and it only appears in the palette — and is only accepted by the
  backend — once the workspace has an **observability integration connected** (today a
  Datadog connection). `PipelineService` rejects a `create`/`update` that adds an enabled
  `post-release-health` step otherwise.

  - **No blind revert.** On a regression the gate dispatches an **`on-call`** container agent
    that clones the base branch (the merged release; the work branch is deleted on merge),
    locates the merged commit and correlates its diff with the regression evidence (alerting
    monitors/SLOs + recent error logs), returning a JSON assessment (culprit confidence +
    `revert`/`hold`/`monitor` recommendation). It makes no commits and reverts nothing — the
    engine raises a **`release_regression`** notification for a human to decide. The gate only
    engages once the PR actually merged, attributes only post-release alerts (not pre-existing
    ones) to the release, and honours the full configured watch window even when it outlasts a
    single poll budget.
  - **Datadog connection + monitor/SLO mapping** are per-workspace (keys sealed at rest under
    a `cat-factory:datadog` cipher, write-only), managed in a new settings panel and the
    `GET|PUT|DELETE /workspaces/:ws/datadog/connection` + `/release-health-configs/:blockId`
    API. The gate maps a run's repo to its service-frame config (monitor + SLO ids + env tag).
  - **Merge-preset knobs**: `releaseWatchWindowMinutes` (default 30) and `releaseMaxAttempts`
    (default 1) bound the watch window + on-call dispatches.
  - **Incident enrichment (optional, additive):** PagerDuty / incident.io are NOT used to
    re-alert (they already page off the same monitors/SLOs) — instead the on-call
    investigation is posted onto an incident they already opened (annotate, never duplicate),
    behind a new `IncidentEnrichmentProvider` port. Slack + the in-app inbox carry the
    human-facing `release_regression` notification.
  - Runtime-symmetric: D1 (`datadog_connections`, `release_health_configs` + the two preset
    columns) ⇄ Drizzle/Postgres, wired in both the Cloudflare Worker and Node/local facades.
  - New harness route `POST /on-call`; the executor-harness image is bumped to `1.7.1`.

  **Breaking (pre-1.0, acceptable):** `merge_threshold_presets` gains two columns — stale rows
  are re-seeded with the defaults.

- f73652c: LLM key management overhaul: DB-backed, multi-scope, pooled provider API keys;
  opt-in Cloudflare AI; provider-gated pipelines; account roles.

  - **Direct-provider API keys move from env to the DB** (BREAKING). The
    OpenAI/Anthropic/Qwen/DeepSeek/Moonshot keys that were read from
    `*_API_KEY` env vars are now onboarded via the UI and stored encrypted (the
    shared `WebCryptoSecretCipher`, HKDF info `cat-factory:provider-api-keys`).
    They are pooled and leased with usage-aware rotation, and scoped to an
    **account, workspace, or user** — within a workspace the candidate pool merges
    the workspace's keys, its owning account's keys, and the run initiator's own
    user keys. Operators must re-enter their keys via the app after upgrading.
  - **Cloudflare Workers AI is no longer assumed available.** It becomes a separate
    opt-in provider lib (like `provider-bedrock`), explicitly registered per
    deployment (the Worker `AI` binding; Node REST account/token). The unconditional
    `workers-ai` fallback is removed, so a bare deployment exposes no models until a
    key is added or the Cloudflare lib is enabled.
  - **Model selectability is derived from what is configured**, and starting a
    pipeline is blocked when any step's canonical model has no usable provider
    (no direct key, no subscription, no registered registry).
  - **Account roles** (admin / developer / product, combinable) layered on the
    membership model: only admins may modify org-account settings; a product member
    can be set as a task's responsible person and is notified when requirement review
    raises findings.

- f9d3647: Local mode: first-class support for Podman, OrbStack, Colima and Apple `container`
  alongside Docker (for both spinning the per-run harness containers and the Tester's
  ephemeral/local test environments).

  The local runner backend (`LocalDockerRunnerTransport`, now
  `LocalContainerRunnerTransport`) no longer assumes the Docker CLI and Docker Desktop
  networking. HOW it talks to the runtime is delegated to a `ContainerRuntimeAdapter`
  (`backend/runtimes/local/src/runtimes/*`), selected by a new `LOCAL_CONTAINER_RUNTIME`
  env (`docker` | `podman` | `orbstack` | `colima` | `apple`, default `docker`):

  - **Docker / Podman / OrbStack / Colima** share the Docker-CLI adapter (`docker run`,
    publish `:8080` to an ephemeral host port, `cat-factory.runId` label), parameterised by
    binary + host-networking. Per-runtime defaults set the right host alias the harness
    uses to reach the LLM proxy (`host.docker.internal`, `host.lima.internal` for Colima),
    overridable via the new `LOCAL_HARNESS_HOST_ALIAS` / `PUBLIC_URL`. `PUBLIC_URL` now
    derives from the selected runtime's alias.
  - **Apple `container`** (macOS) gets its own adapter: one VM per container, addressed by a
    deterministic name, connected to the container's own IP (no published-port model), via
    `container run | list | inspect | delete`.

  **Tester "limited mode".** Apple `container` has no Docker-in-Docker, so the Tester's
  **Local** infra mode (`docker compose up` inside the job container) can't run there. Each
  adapter exposes a `localDind` capability that the local facade threads into the engine as
  `localTestInfraSupported`; `ExecutionService` now refuses a local-infra Tester pipeline at
  start on an incapable runtime (`tester-infra.logic.ts`), with an actionable message. The
  Tester still runs there via the **Ephemeral** test environment (offloaded to a configured
  environment provider — e.g. a custom container pool) or a **No infra dependencies**
  service. This gate defaults to permissive (`localTestInfraSupported` defaults `true`), so
  Cloudflare, Node and tests are unchanged.

  `startLocal()` now logs the resolved runtime + capabilities + host alias and probes that
  the CLI is installed, so a misconfiguration fails loudly at boot rather than on the first
  agent job. The executor-harness image is unchanged.

- 8807f5c: Run agents on locally-hosted LLMs (Ollama, LM Studio, llama.cpp, vLLM, or any
  custom OpenAI-compatible server). Each user configures their own runners in
  Settings → "My local runners" (a runner lives on that person's machine), stored
  per-user in the DB with on-the-fly connection validation that probes the runner's
  `/v1/models` and lists the installed models to enable. The enabled models appear
  in the picker as the `direct` flavour and need no API key — the LLM proxy resolves
  the run initiator's endpoint and skips the DB key lease (new optional
  `LlmUpstreamEndpoint.apiKey` signal / keyless local branch), and inline LLM calls
  register the user's runners as keyless resolvers. Resolution is by the run
  initiator, exactly like personal subscriptions.

  New per-user `local_model_endpoints` table mirrored across both runtimes (D1
  migration `0002` ⇄ Drizzle), a user-scoped `GET|PUT|DELETE /local-model-endpoints`

  - `POST /local-model-endpoints/test` API, and a cross-runtime conformance
    assertion for the store (CRUD + bearer-key encryption round-trip + enabled-models
    JSON). Container kinds (coder/tester/merger/…) and the inline reviewer/planner all
    run on the local model. Breaking only in the pre-1.0 sense: a new table is added,
    no migration of existing data is needed.

  Because the user-supplied base URL is forwarded server-side (the test probe + the
  LLM proxy), it is constrained to a loopback/LAN allow-list (`localRunnerUrlError`):
  `localhost`, `*.local`, and RFC1918/ULA private addresses are accepted, while public
  hosts and the link-local cloud-metadata endpoint (`169.254.169.254` / `fe80::`) are
  rejected at the write boundary and the probe (anti-SSRF). Model usability is gated on
  the specific enabled model id (`localModels` capability), not merely the runner being
  configured, so a stale pin to a since-disabled model is caught at the pipeline-start
  guard.

- f0a847d: Local mode can link GitHub repos with the PAT, lighting up the "Add from existing
  repo" board flow (previously the GitHub integration was App-only, so it returned 503
  and the button stayed hidden — repos could only be linked via the `linkRepo` CLI).

  With a `GITHUB_PAT` set, the local facade now serves the GitHub read/link endpoints
  through the PAT-backed client:

  - `config.github.enabled` is forced on in local mode when a PAT is present (the Node
    loader only enables it for a configured GitHub App).
  - A workspace's installation is auto-provisioned from the PAT on first read
    (`AutoProvisioningInstallationRepository`), so `GET /github/connection` reports
    connected with no connect flow. The synthetic installation id matches the `linkRepo`
    CLI's, so CLI- and UI-linked repos share one installation.
  - The repo picker lists repos via `/user/repos` (`PatGitHubClient.listInstallationRepos`),
    the PAT analogue of the App-only `/installation/repositories` (which 403s for a PAT).
  - The connection reports `workflows: write` granted (the local PAT carries `workflow`
    scope), suppressing the advisory "missing workflows permission" banner.

  `@cat-factory/node-server` gains a `githubInstallationRepository` option on
  `buildNodeContainer` (default unchanged) so the local facade can wrap the repository,
  and re-exports `DrizzleGitHubInstallationRepository`. This is a local-mode differentiator
  (like the Docker runner and PAT token source); the Cloudflare/Node-proper facades keep
  using the GitHub App.

  The "Add from existing repo" picker also gains a search/filter input (filter by
  owner/name, with a "showing X of Y" count), since a PAT or wide App install can expose
  hundreds of repos that overflowed the plain dropdown.

- 0b21ff3: Add a local-mode runtime facade (`@cat-factory/local-server`) so a developer can run
  the whole product on their own machine. It is the Node.js facade
  (`@cat-factory/node-server`: shared Hono app + Drizzle/Postgres + pg-boss) with two
  local differentiators: agent jobs run as per-job local Docker/Podman containers (the
  new `LocalDockerRunnerTransport` — the local analogue of the Worker's per-run
  Cloudflare Container and an org's self-hosted runner pool, driven through the same
  `RunnerTransport` port), and GitHub is reached via a personal access token (`GITHUB_PAT`)
  instead of a GitHub App. `startLocal()` boots the service; `buildLocalContainer()` is
  the composition root. The agent containers clone, push branches and open real PRs on
  github.com with the PAT; pipelines run end to end locally.

  To support this cleanly, `@cat-factory/node-server` gained composition seams used by
  the local facade (all default to the existing Node behaviour): `buildNodeContainer`
  now accepts an injected `resolveTransport`, `mintInstallationToken` and `githubClient`,
  and `start()` accepts an injected `buildContainer` and a `host` bind address (else
  `HOST` from the env, else all interfaces — so a deployment can keep the service off the
  LAN). It also re-exports `createApp`. The local facade runs the shared cross-runtime
  conformance suite (with a fake agent executor) so it can't drift from the Node and
  Cloudflare facades.

  The runtime-neutral fetch-based GitHub client and the CI / merge / mergeability
  providers (`FetchGitHubClient`, `GitHubCiStatusProvider`, `GitHubMergeabilityProvider`,
  `GitHubPullRequestMerger`) move from the Cloudflare runtime into `@cat-factory/server`
  (re-exported from the Worker for existing imports — no behaviour change), so every
  facade can gate on real CI and merge for real. `FetchGitHubClient` now accepts any
  `AppTokenSource` (the App registry or a static PAT). Local mode wires these from a
  PAT-backed client, so a local pipeline gates on real GitHub Actions CI and merges the
  PR for real. The Node facade now also wires these gates when a GitHub App is configured
  — it builds a `FetchGitHubClient` from its own shared App registry — so a stock
  Node-with-App deployment gates on real CI and merges for real too (parity with the
  Worker; previously only local mode did).

  Local-mode robustness: the Docker transport is now constructed lazily, so the service
  boots (to serve the board + inline kinds) even without `LOCAL_HARNESS_IMAGE` — only
  repo-operating kinds then fail, loudly. On boot it reaps per-job containers orphaned by
  a previous crash, and on re-dispatch it removes any lingering container for the same job
  id before starting a fresh one. The `linkRepo` helper clears a stale installation row
  for the workspace before upserting (robust against the `github_installations`
  workspace-unique index), and local mode warns when the auth gate is left open on a
  network-reachable bind.

- f066c59: Make the **native environment-adapter** path first-class, so a deployment can inject a
  hand-written `EnvironmentProvider` (e.g. a native ephemeral-environment adapter) instead of the generic
  manifest-driven `HttpEnvironmentProvider` — with per-workspace config and the supported
  local-mode entry point.

  - **Manifest `providerConfig` bag** (`@cat-factory/contracts`): `environmentManifestSchema`
    gains an optional, opaque `providerConfig: Record<string, unknown>`. The generic
    `HttpEnvironmentProvider` ignores it; a native adapter reads + validates it off the
    per-call `manifest`. Because an injected provider is a deployment-wide singleton, the
    per-workspace connection's manifest is its only per-workspace config carrier — so a
    single deployment can now target a different native project (provider project, link key,
    status map, …) per workspace. It rides inside the existing `manifest_json` JSON column on
    both runtimes — no migration, automatic D1 ⇄ Drizzle parity. **Not** covered by the
    manifest URL/SSRF checks (which only guard `baseUrl`/`tokenUrl`); an adapter that reads a
    URL from `providerConfig` must guard it itself.
  - **`startLocal({ environmentProvider })`** (`@cat-factory/local-server`): the local-mode
    entry point gains an `environmentProvider` seam (and a `host` option, matching `start()`),
    threaded through `buildLocalContainer` → `buildNodeContainer`. A local deployment can now
    wire a native provider through the supported entry point — keeping local mode's boot
    preflight (orphan reaping, PAT/auth warnings) and differentiators — instead of bypassing
    `startLocal()` and re-implementing the preflight. `buildContainer` is intentionally not
    exposed (overriding it would discard local mode's differentiators).
  - New `backend/docs/native-environment-adapter.md` documents the injection contract, the
    env-port-vs-runner-port boundary, teardown/TTL idempotency, the `@cat-factory/kernel`
    adapter dependency, and a reference native-adapter sketch.

  No backwards-incompatible changes: every addition is optional and defaults to today's
  behaviour.

- 7d5e060: Bridge the Cloudflare ⇄ Node/local runtime feature-parity gaps: seven product
  features that worked on the Worker but `503`'d on the Node + local facades (their
  repositories were never wired) now work identically on all three, each landed with
  a cross-runtime conformance assertion.

  - **Merge threshold presets** — `merge_threshold_presets` + `DrizzleMergePresetRepository`.
  - **Board-scan repository blueprints** — `repo_blueprints` + `DrizzleRepoBlueprintRepository`
    (the blueprint reads; the `blueprints` pipeline step already ran on Node).
  - **Document sources** — `document_connections`/`documents` + repos; the Confluence /
    Notion / GitHub-docs provider shells are promoted into `@cat-factory/integrations`
    so both facades compose the same providers.
  - **Ephemeral environments** — `environment_connections`/`environments` + repos;
    `HttpEnvironmentProvider` promoted into `@cat-factory/integrations`; a Node
    `setInterval` TTL-teardown sweeper mirrors the Worker's expiry cron.
  - **GitHub projections + inline sync** — `github_branches`/`github_pull_requests`/
    `github_issues`/`github_commits`/`github_check_runs` + `github_sync_cursors` and the
    full read/write projection repos, so the runtime-neutral `GitHubSyncService`'s inline
    webhook/backfill ingest persists on Node; `WebCryptoWebhookVerifier` promoted into
    `@cat-factory/server`.
  - **Repo bootstrap** — `reference_architectures` + bootstrap runs stored as
    `kind='bootstrap'` rows of `agent_runs`; `ContainerRepoBootstrapper` promoted into
    `@cat-factory/server`; a **pg-boss durable bootstrap driver** (the analogue of the
    Worker's `BootstrapWorkflow`) replaces the previous "bootstrap isn't durable on Node
    yet" gap, and the stale-run sweeper now re-drives orphaned bootstrap runs too. The
    self-hosted runner pool (`RunnerPoolTransport`) now accepts the `bootstrap` dispatch
    kind — the harness `/bootstrap` route needs no Cloudflare primitive, so a pool runner
    serves it just like the local Docker transport — so a real bootstrap run dispatches +
    pushes for real on Node, not just on local.
  - **Prompt-fragment library (ADR 0006)** — `prompt_fragments`/`fragment_sources` +
    `DrizzlePromptFragmentRepository`/`DrizzleFragmentSourceRepository`; the runtime-neutral
    `LlmFragmentSelector` promoted into `@cat-factory/agents`. Opt-in via
    `PROMPT_LIBRARY_ENABLED`/`PROMPT_LIBRARY_SELECTOR`, wired exactly like the Worker's
    `selectFragmentLibraryDeps` (repos + installation resolver + selector), so the managed
    tenant fragment catalog feeding every agent run works identically on all three.

  The Worker keeps the same behaviour (it gains the new conformance assertions and the
  shared promoted classes). **Breaking on Node/local:** these features now require their
  new tables — boot-time `migrate()` applies them; there is no data to preserve.

  The Node/local Drizzle migration lineage was re-baselined to a single fresh
  `drizzle-kit generate` migration off the current `schema.ts` (the prior hand-authored
  folders had no snapshots, which blocked `db:generate`); `db:generate`/`db:check` are
  green again. Safe because no deployed database depends on the old lineage.

  Deferred (still Worker-only, flagged for follow-up): real-time push (Node `realtime`
  gateway still `501`s — needs a WebSocket hub over Postgres `LISTEN/NOTIFY`),
  queue-backed async GitHub ingest (Node ingests inline rather than via a pg-boss queue),
  and GitHub rate-limit telemetry (Node keeps the no-op repository).

- 75bd29d: Implement the real-time WebSocket transport on the Node + local facades, closing the
  last "Worker-only" runtime gap for live board updates. Previously the SPA's
  `ws://…/workspaces/:ws/events` handshake had no server on Node/local (the realtime
  gateway returned null and `@hono/node-server` doesn't upgrade on its own), so the
  browser logged a perpetual `connection refused` and only got updates by reconnect-time
  snapshot refresh.

  - New `runtimes/node/src/realtime.ts`: `NodeRealtimeHub` (in-memory per-workspace
    subscriber registry), `NodeEventPublisher` (mirrors the Worker's
    `DurableObjectEventPublisher` event shapes), and `attachRealtime` — a `ws` server bound
    to the HTTP `upgrade` event. The SPA speaks raw WebSocket (not socket.io), so the
    client is unchanged across runtimes; `@hono/node-ws` was rejected because its
    `upgradeWebSocket` middleware can't compose with the shared, `Response`-returning
    `EventsController`.
  - `start()` creates the hub, wires it into `buildNodeContainer` (as the engine's
    `executionEventPublisher`, decorated with `FanOutEventPublisher` so a shared service's
    events reach every mounting board, plus an `InAppNotificationChannel` composed
    alongside Slack), and attaches it to the HTTP listener. Local mode inherits all of
    this through `buildLocalContainer`'s pass-through, so a developer running locally now
    gets live execution/bootstrap/notification updates.
  - Ticket mint/verify is extracted into the shared `@cat-factory/server`
    `auth/wsTicket.ts` (`mintWsTicket`/`authorizeWsUpgrade`), used by both the Worker's
    `EventsController` and the Node upgrade handler so both handshakes authorise
    identically. `InAppNotificationChannel` is promoted from the Worker into
    `@cat-factory/server` so both facades deliver in-app notifications through one class.

  Single-process only for now: a multi-replica Node deployment would need a shared bus
  (Postgres `LISTEN/NOTIFY`) in front of the in-memory hub. The Worker's behaviour is
  unchanged (it gains the shared ticket/channel helpers).

- 7157fd7: Rework run timing, add task types, and add a per-service running-task limit.

  **Run timing.** A run parked waiting for a human is no longer auto-failed after a
  fixed timeout — it waits indefinitely. The old `decision_timeout` machinery is gone
  (the Cloudflare driver re-arms its `waitForEvent` instead of failing; the Node driver
  drops the decision-timeout queue/worker; the `decision_timeout` failure kind is
  removed). Instead, notifications carry a `severity` and a periodic sweep escalates any
  open notification from `normal` (yellow) to `urgent` (red, "Overdue") once it has
  waited past the workspace's `waitingEscalationMinutes` threshold. Every human-input
  park now also guarantees an open notification, so a waiting run is never silently
  stuck. **Breaking:** the `decision_timeout` agent-failure kind is removed.

  **Task types.** Tasks gain a `taskType` (`feature` / `bug` / `document` / `spike` /
  `recurring`) chosen at creation, plus small per-type fields (e.g. a bug's severity /
  repro, a spike's time-box). `recurring` is created through the existing recurring-
  pipeline schedule flow, which now also accepts a free-text prompt for its reused task.

  **Per-service running-task limit.** A new per-workspace settings object
  (`waitingEscalationMinutes` + a task-limit policy) caps how many tasks may run
  concurrently under one service — off, a single shared bucket, or one bucket per task
  type. Starting a task over the limit is refused with a human-readable 409. Managed via
  `GET|PUT /workspaces/:ws/settings` and a new Workspace settings panel. Persisted in a
  new `workspace_settings` table on both runtimes (D1 ⇄ Drizzle), with cross-runtime
  conformance assertions for the task type round-trip and the limit enforcement.

- 8eed95b: Service-scoped best-practice prompt fragments, delivered by agent traits.

  A service (frame block) now owns an explicit selection of best-practice / guideline
  fragments — its programming standards — chosen from the **universal fragment pool**.
  That pool is the built-in catalog plus any fragments a deployment registers at startup
  via the new `registerPromptFragment` seam in `@cat-factory/prompt-fragments` (mirroring
  `registerAgentKind` / the model-provider registry); `GET /prompt-fragments` serves the
  merged pool. A workspace can also configure a **default set new services inherit**
  (`GET|PUT /workspaces/:ws/service-fragment-defaults`), seeded onto a frame's
  `serviceFragmentIds` when it is created (board drop, repo import, or bootstrap).

  Agents gain first-class **capability traits** (`@cat-factory/agents`): a registry of
  standard + custom traits with `traitsFor` / `hasTrait`, assignable to built-in kinds and
  to custom kinds via `AgentKindDefinition.traits`. Two standard traits ship:

  - **`code-aware`** (coder, ci-fixer, fixer, reviewer, architect): the running service's
    selected fragments are folded into the agent's system prompt, unioned with the block's
    own manual pins. Other kinds keep only their block pins.
  - **`spec-aware`** (every code-touching kind): the agent's system prompt gains guidance to
    read the in-repo `spec/` artifact (overview.md → rules.md → features/\*.feature →
    spec.json) and treat it as the source of truth for required behaviour.

  This **replaces the automatic per-run relevance selector**: fragment delivery is now
  explicit (the service's selection) and trait-gated (code-aware) rather than guessed per
  run. Per-block manual pins (`Block.fragmentIds`) still apply to that block's own agents.
  The tenant fragment **library** (account/workspace CRUD + repo sources) remains as a
  management surface but no longer feeds the run path.

  Persistence is mirrored on both runtimes: a `service_fragment_ids` column on `blocks`
  and a `workspace_fragment_defaults` table (Cloudflare D1 migration `0040` +
  `D1ServiceFragmentDefaultsRepository`; Node Drizzle schema/migration +
  `DrizzleServiceFragmentDefaultsRepository`), with the cross-runtime conformance suite
  asserting the workspace-default round-trip, new-service inheritance, and the
  code-aware-only folding on both facades. The UI adds a per-service "Service best
  practices" picker in the inspector and a "Default service best practices" workspace
  settings panel.

  BREAKING (Node facade dev/test only): the Drizzle migration lineage under
  `runtimes/node/drizzle/` was squashed into a single fresh baseline migration — the prior
  incremental migrations had a forked, non-commutative history (left by merging two
  branches) that broke `drizzle-kit generate`/`check`. There are no production Postgres
  deployments, so existing dev/test databases should be dropped and re-created from the
  new baseline rather than migrated. CI now runs `db:check` to keep the lineage honest.

- 5ca8086: Add alternate subscription-backed coding harnesses (Claude Code / Codex) alongside
  the Pi proxy harness.

  - New per-workspace **subscription token pool** (`provider_subscription_tokens`,
    D1 + Postgres, encrypted at rest) with usage-aware rotation, behind a kernel
    port + `ProviderSubscriptionService`, wired into all three runtimes.
  - A guided **LLM Vendors** navbar UI to connect Claude / Codex / GLM (Z.ai) /
    Kimi (Moonshot) / DeepSeek subscription credentials (token pool, write-only).
    GLM / Kimi / DeepSeek all run via Claude Code against the vendor's
    Anthropic-compatible endpoint; the unfiltered credential list covers every vendor.
  - The executor-harness image now bundles the Claude Code and Codex CLIs; the
    harness selects `pi` / `claude-code` / `codex` per job from the model, and the
    subscription harnesses authenticate direct-to-vendor (no proxy) and report token
    usage from the CLI event stream for rotation + telemetry.
  - The model catalog becomes a canonical-model → provider map with precedence
    **subscription > direct > cloudflare** ("subscriptions always win"): latest
    Opus/Sonnet + GPT-5.5/5.4 (subscription-only), GLM-5.2/Kimi gain a Claude-Code
    subscription flavour, and `ModelOption` now carries per-flavour cost, context
    window, and a `quotaBased` flag (subscription usage is flat-rate quota, never
    billed against the spend budget).
  - A block's model is shared by all its pipeline steps, so a pin to a subscription-only
    model (Claude Code / Codex — container-only, no provider key) is degraded to the
    step's env-routing default for every INLINE LLM path through one shared seam
    (`inlineModelRef` / `resolveInlineModelRef`): both the inline agent executor and the
    requirements reviewer/rework, so the inline steps run instead of hard-failing and the
    two paths can't drift. The claude-code subscription harness repairs malformed
    structured output through the vendor's own Anthropic-compatible endpoint (the Pi
    harness still uses the proxy; Codex keeps the graceful no-repair path).
  - Hardening: the per-vendor token pool is capped to bound growth; the leased
    subscription credential is scrubbed from subscription-repair error details (not just
    GitHub-shaped secrets); and Codex token usage is read from its cumulative
    `total_token_usage` so multi-turn runs attribute usage correctly for rotation.

- cc8d96a: Flesh out the Tester agent, add an agent configuration-contribution mechanism, and
  make Mocker always precede Tester.

  - **Pipelines:** every built-in pipeline that runs a `tester` now runs `mocker`
    immediately before it, so the Tester has its external-dependency mocks up.
  - **Config contribution:** agents (built-in or custom, via the agent registry's new
    `configContributions`) declare task-level config parameters. The union over a
    task's pipeline appears on task creation + the inspector and freezes once the
    contributing agent's step starts. Values persist as a sparse `agentConfig` map on
    the block (keys/values length-capped); the catalog rides the workspace snapshot. The
    Tester contributes its `environment` (local vs ephemeral) and Playwright its e2e
    target (CI vs ephemeral). The old fixed `testTarget` block field is dropped — its
    column is dropped on both runtimes too (no backwards-compat shim).
  - **Tester → Fixer loop:** `tester` is now a container agent that runs the project's
    tests — standing infra up locally via the service's docker-compose (rootless
    Docker-in-Docker in the harness) or against an ephemeral environment — and returns
    a structured report (what was tested, outcomes, concerns, greenlight). On a
    withheld greenlight the engine loops a new dedicated `fixer` agent with the report
    and re-tests, up to the task's merge-preset attempt budget. Only **blocking
    (high/critical)** concerns withhold the greenlight — low/medium are advisory, so a
    trivial nit can't burn the whole fixer budget — and the engine re-applies that rule
    defensively over the report. When the budget is spent (or there's no PR branch to
    fix, or the report is unparseable) the run fails for real (the tester step is left
    un-`done`) and raises a human-actionable `test_failed` notification (retry action),
    mirroring the CI gate. New harness `/test` + `/fix-tests` endpoints; reports + fixer
    summaries render in the inspector and step detail.
  - **Service + provisioning config:** a service frame carries the Tester's
    docker-compose path / "no infra dependencies" toggle (a Tester pipeline can't start
    until one is set), plus a cloud provider and abstract instance size that resolve to
    the concrete instance-type id forwarded to the runner. Per-service sizing applies to
    the self-hosted-pool and local-Docker backends; the Cloudflare Container backend has
    a fixed per-class instance type (`wrangler.toml`) with no per-dispatch override, so
    it ignores the hints (pick `cloudflare` when you don't need per-service sizing).
  - **Account default cloud provider (fully wired):** accounts carry a
    `defaultCloudProvider` new services inherit — persisted on both runtimes, settable
    via `PATCH /accounts/:id` (owner-only) and the account menu, returned on the account
    wire, and pre-filled as the service editor's provider default.
  - **Local mode is 100% Docker/Podman:** a new first-class `docker` cloud provider
    represents the local daemon. The local runner backend sizes each per-job container
    from the abstract instance size (`--memory`/`--cpus`) and runs the Tester job
    `--privileged` so it stands its docker-compose infra up with Docker-in-Docker on the
    host daemon — never Cloudflare. A Tester-only pipeline with no PR branch now fails
    cleanly (no fixer to push to) instead of throwing.
  - Mirrored across both runtimes (D1 migration ⇄ Drizzle schema + migration).

- 3e6a844: Workspace creation/onboarding overhaul: real users, non-GitHub auth, invites,
  named+described boards.

  - **Persistent identity**: a new `users` + `user_identities` model replaces the
    GitHub-numeric-id identity. Memberships, `blocks.created_by`, personal
    subscriptions, and the session payload are all re-keyed to a generated `usr_*`
    id. (BREAKING: pre-existing personal accounts — keyed by GitHub login with a null
    `owner_user_id` — stop matching and a fresh personal account is created on next
    sign-in; old member-mapping rows keyed by GitHub id are orphaned. No migration,
    per the pre-1.0 policy.)
  - **Non-GitHub auth**: email/password (WebCrypto PBKDF2 hashing) and Google OAuth
    login alongside GitHub. New-user creation is invite-only plus an optional
    `AUTH_ALLOWED_EMAIL_DOMAINS` self-signup allowlist (fail-closed). A user without
    a GitHub account works fully — repo access is via the GitHub App, not a user token.
  - **Email invitations**: invite teammates by email into an org account; the invitee
    redeems a tokened link to gain membership. Email is sent via a pluggable
    `EmailSender` (SendGrid / Resend adapters) whose provider + API key are
    **onboarded per-account in the UI and stored sealed in the DB** (not env), like
    the Slack bot token. New tables: `users`, `user_identities`, `account_invitations`,
    `email_connections` (D1 + Drizzle).
  - **Board name + description**: `Workspace.description` end to end (create + edit).
  - **Onboarding discovery**: org members see and open existing org boards from the
    switcher instead of being forced to create one.
  - Slack member-mapping is re-keyed from `githubUserId` to the internal `userId`.

### Patch Changes

- 9d3a956: Clarity reviewer (bug-report triage) + bug investigator: a new bug-fix pipeline front.

  Adds two new agents at the front of a new `pl_bugfix` ("Triage & fix bug") pipeline preset:

  - **`bug-investigator`** — a read-only container agent (it runs the shared `/explore`
    harness path used by `architect`/`analysis`, so no new harness endpoint or image change).
    It clones the repo, reads the codebase from the raw bug report, and returns a prose
    enriched report plus an OPTIONAL working hypothesis — which it omits unless reasonably
    confident, so a low-confidence guess never misdirects the fix. Its output feeds the
    clarity reviewer (the triage subject) and the coder (a non-binding lead, via `priorOutputs`).
  - **`clarity-review`** — an inline engine gate step that triages the bug report for
    _fixability_ (repro steps, expected-vs-actual, environment, affected area), mirroring the
    requirements-review iterative loop (raise findings → answer/dismiss → incorporate into one
    standard-format clarified report → re-review until it converges, with the same per-task
    `maxRequirementIterations` / `maxRequirementConcernAllowed` knobs). The converged clarified
    report substitutes downstream as the task description for the spec-writer/coder (when both
    a requirements and a clarity review exist, the requirements doc wins).

  Persisted as a new `clarity_reviews` table on BOTH runtimes (D1 migration
  `0002_clarity_reviews` + Drizzle migration), wired in both facades' containers with a new
  `clarity` event on the real-time transport and a `clarity_review` notification type. A
  cross-runtime conformance assertion pins the clarified-brief substitution against both
  stores.

- 8d11833: Companion agents + acceptance-test rework (the structured spec replaces the
  client-only scenario surface), plus a vocabulary split so "requirements" (the
  linked-prose context review) and "spec" (the structured in-repo document) are no
  longer the same word.

  - **Companion agents.** A companion grades a prior producer step's output, returns
    an overall quality rating (0..1), and — below the step's threshold (default 0.8) —
    loops the producer back for automatic rework BEFORE a human is asked, failing the
    run (`companion_rejected`) once the rework budget is spent. Companions declare an
    allow-list of target kinds and are placed as their own chain step in the pipeline
    builder (with a per-step `thresholds` array, parallel to `gates`). Built-ins:
    `architect-companion`, `spec-companion`, and `reviewer` reframed as the coder's
    companion. Wired into `ExecutionService` (`evaluateCompanion` + a unified rework
    revision path shared with the human "request changes" flow).
  - **Companion-gated requirements rework.** The per-block requirements review's
    rework step is now gated by a quality companion: below threshold the reworked doc
    is NOT accepted (the review stays `ready`), and the companion's challenge is
    surfaced in the review window and fed into the next rework. Persisted on
    `requirement_reviews.companion` (D1 migration 0036 + Drizzle).
  - **Acceptance tests via the spec.** The client-only scenarios store/UI is removed;
    the structured Given/When/Then acceptance scenarios live in the service spec
    (authored by the `spec-writer`, reviewed on its gated step) and are derived into
    Gherkin. The redundant `acceptance` polish agent is dropped; `playwright` still
    writes the runnable tests. `spec-writer`'s prompt now treats complete
    acceptance-scenario coverage as a first-class deliverable.
  - **`architect` is now a container agent** that explores the repo (read-only, like
    `analysis`) before proposing. Both read-only kinds share one reusable execution
    path: a new harness `/explore` endpoint (dispatch kind `explore`) clones the branch,
    runs the agent read-only and returns its prose report/proposal — making no commit,
    opening no PR, and (unlike `/run`) NOT treating an edit-free run as a failure. A
    shared read-only guardrail is appended to their system prompts.
  - **Companion rework correctness.** When a companion loops a producer back, EVERY step
    between the producer and the companion is now reset and re-run (clearing stale
    container job handles), so an intermediate container step re-dispatches fresh work
    instead of re-attaching to its evicted job. The automatic rework budget now counts
    only automatic attempts (`companion.attempts`); a human "request changes" on a
    companion's gate re-runs the producer without consuming it.
  - **Rename: requirements → spec** for the structured family. In-repo `requirements/`
    → `spec/` (`spec.json`, `spec/features/*.feature`; legacy `requirements/`
    relocated on first run); `RequirementsDoc` → `SpecDoc`; `requirements-writer` →
    `spec-writer`; the pipeline analyst `requirements` → `requirements-review`;
    `pl_requirements` → `pl_spec`. The context-review family (`RequirementReview*`,
    `requirement_reviews`) keeps the `requirements` name.

  The harness image changed (the `/requirements` endpoint + `requirements/` paths
  became `/spec` + `spec/`), so `@cat-factory/executor-harness` and the
  `deploy/backend` image tag are bumped to 1.0.6 and must be re-published + rolled out.

- 157cd02: Standardize the executor-harness job API on a single `POST /jobs` endpoint with the
  agent kind carried in the request body, instead of one route per kind (`/run`,
  `/bootstrap`, `/merge`, …).

  Breaking wire change between the runtime transports and the harness image (acceptable
  pre-1.0: the two ship together, no external consumers). The old per-kind-route image
  is incompatible with the new transports, so the runner image MUST be republished and
  deployed.

  - Harness: `server.ts` is now table-driven — one `KINDS` registry keyed by kind drives
    a single `POST /jobs` dispatcher (reads the body's `kind` to pick the validator +
    registry) and a single `GET /jobs/{id}` poll. Adding an agent kind is one table
    entry, not a new endpoint + registry global + poll-chain branch. Bumps the runner
    image tag (1.7.2 -> 1.7.3) in `deploy/backend` (`image:publish` + wrangler.toml).
  - Harness: the explore job's temp-dir/log label field is renamed `kind` -> `label` so
    it no longer collides with the reserved dispatch discriminator `kind`.
  - Server: `ContainerAgentExecutor` stamps the kind into the dispatch body (the explore
    body now sends `label` for its agent-kind label).
  - Worker + local-server transports POST `{ ...spec, kind }` to `/jobs`;
    `LocalDockerRunnerTransport` drops its `KIND_ROUTE` map. The self-hosted pool already
    forwards `kind` in the spec, so it needs no code change — only the manifest docs
    (kernel/contracts/integrations) are updated to note the harness routes by the body's
    `kind`.

- db77061: Add an **individual-usage restricted mode** for subscriptions licensed for personal
  use only (`claude`, `glm` and `codex` — see their terms of service). Such vendors are no
  longer poolable on a workspace; instead each user stores their OWN credential and only
  that user's runs may use it.

  - **Per-user, double-encrypted storage.** A personal subscription's token is sealed
    under a key derived from the user's personal **password** (PBKDF2 → AES-GCM, never
    stored) and then encrypted again with the system key, so it cannot be recovered
    without BOTH the system key AND the password. New `personal_subscriptions` table on
    both runtimes (D1 migration `0039` ⇄ Drizzle), `PersonalSubscriptionService`, and
    `GET/POST/DELETE /personal-subscriptions` (user-scoped).
  - **One password per user.** All of a user's individual-usage subscriptions must share a
    single personal password (enforced at store time), since a run unlocks every vendor it
    touches with one password. Passwords are restricted to printable ASCII so they are
    HTTP-header-safe.
  - **Per-run activation, short TTL, transparently extended.** At task start/retry the user
    supplies their password — carried on the ambient `X-Personal-Password` header (never a
    body field), cached client-side (~40h) so it usually rides along transparently — to mint a
    short-lived (~12h), system-encrypted, per-run activation (`subscription_activations`
    table) that the asynchronous container steps lease, so the whole step chain authenticates
    without the user present. The activation is **re-minted from the cached password on each
    interaction** (resolve a decision / approve a step / retry), so an actively-tended run
    never lapses under the short TTL; the user is only re-prompted once the password cache
    expires. Activations are deleted when the run finishes (or its block's run is replaced)
    and swept on TTL expiry.
  - **No recurring runs.** A recurring schedule whose block resolves to an individual-usage
    model — by pin **or** workspace per-kind default — is refused at fire time (it can't be
    unlocked unattended).
  - **Gating.** Starting/retrying a run that resolves to individual-usage model(s)
    requires a signed-in user with the stored subscription(s); a missing password returns
    `428 credential_required` so the client prompts. The gate mirrors dispatch's model
    precedence (block pin → workspace per-kind default) across the pipeline's steps, so a
    block with no pin but an individual-usage workspace default is gated up-front instead
    of failing at dispatch. The container executor leases the initiator's activation and
    fails clearly (retryable) if it has lapsed. Expiry/renewal is surfaced in advance.

  **Breaking (no migration — backwards compatibility is a non-goal here):** `glm` and `codex`
  join `claude` as individual-only, and individual-only vendors are no longer poolable on ANY
  workspace. Any existing **pooled** `claude`/`glm`/`codex` workspace tokens become orphaned
  (no longer leased or listed) — reconnect them as personal subscriptions.

  See `backend/docs/individual-subscription-usage.md` for the full model + safeguards.

- 160837f: Default `ENCRYPTION_KEY` in local mode so the server boots out of the box. The
  Node config loader requires `ENCRYPTION_KEY` (it backs credential encryption at
  rest), but `applyLocalDefaults` only defaulted the auth/session/PUBLIC_URL vars,
  so a stock local install crashed on boot with "ENCRYPTION_KEY is required" despite
  the docs promising a local default. It now generates a per-process key when unset,
  mirroring `AUTH_SESSION_SECRET`. Set `ENCRYPTION_KEY` explicitly to keep
  encrypted-at-rest credentials decryptable across restarts.
- 7a9cabf: Local mode now warns when no GitHub PAT is configured — in the UI, not just the
  console. At boot, `startLocal()` still logs a warning, but the local facade also tags
  its `AppConfig` with a `localMode` block carrying a GitHub "new personal access token
  (classic)" URL (scopes pre-selected: `repo`, `workflow`) when `GITHUB_PAT` is unset.
  The shared `/auth/config` endpoint surfaces that block, and the SPA renders a
  dismissible banner with a one-click link straight to the token-creation page, so the
  prompt isn't lost in a dev terminal. Exposed as `githubPatCreationUrl()` from the local
  facade and `LocalModeConfig` from `@cat-factory/server`.
- b287996: Give every pipeline step its own runner job id so sibling steps in one run can't read
  back each other's results.

  Every container step of a run was dispatched and polled under the bare execution id,
  which is ALSO the per-run container's address. The harness keys its per-kind job
  registries by that id and `GET /jobs/{id}` checks them in a fixed order, so two steps
  that ran close enough together to share the still-warm container collided: a poll for
  one step returned another step's finished result. The visible symptom was an
  `architect` (`/explore`) step returning the `spec-writer`'s (`/spec`) document verbatim
  with no model call of its own — and, latently, `blueprints`/`mocker` reading back the
  `coder`'s result.

  The fix separates the two conflated identifiers into an explicit `RunnerJobRef`:

  - **`runId`** — the run (execution). On backends that share one container across a run
    (the Cloudflare per-run Container, the local Docker container) this addresses that
    container, and `release` reclaims it.
  - **`jobId`** — the job itself, now UNIQUE PER STEP (`<executionId>-<agentKind>`). The
    harness registers and polls each step's job by it, so siblings never alias.

  `RunnerTransport.dispatch`/`poll`/`release` and `RunnerJobClient` now take the ref;
  `AgentJobHandle` carries the `runId` so the poll/stop site can re-address the per-run
  container. The Cloudflare and local transports key the container by `runId` (one
  container per run, reclaimed as a unit) and read the harness job by the per-step
  `jobId`; a self-hosted pool, being per-job, keys on `jobId` (which already kept its
  steps distinct). Single-job flows (repo bootstrap/scan) use the same value for both.
  The engine reclaims a run by its id and passes the in-flight step's job id so a pool can
  cancel exactly it.

  Breaking: `RunnerTransport` implementers now receive a `RunnerJobRef` instead of a bare
  job-id string. The local container label moves from `cat-factory.jobId` to
  `cat-factory.runId`.

- 311a110: Requirements review: dedicated window + iterative convergence loop, and a universal
  result-view seam.

  The pipeline's `requirements-review` gate step no longer runs as a prose agent behind the
  generic approve/reject panel. It now drives the purpose-built structured review window: the
  reviewer raises findings (each with a severity), the human answers or dismisses them, an
  incorporation companion folds the answers into one standard-format document, and the
  reviewer re-reviews that document. The cycle repeats until the reviewer converges (or every
  remaining finding is dismissed). The human can reject a bad merge and redo the incorporation
  with a freeform "do it differently" comment.

  Two new per-task knobs live on the merge-threshold preset:

  - `maxRequirementIterations` (default 3) — reviewer passes allowed before the run stops on
    its own and the human picks: one more round / proceed anyway (with the last incorporated
    document) / stop and reset the task to phase zero (editable; the last incorporated
    document stays on the inspector as a base).
  - `maxRequirementConcernAllowed` (default `none`) — when every outstanding finding is at or
    below this severity, the findings are recorded but the run advances automatically (no
    human gate, companion skipped).

  Frontend gains a UNIVERSAL result-view seam: an agent archetype can declare a `resultView`
  id and register a window component, and the renderer dispatches to it instead of the generic
  prose panel — requirements review is the first consumer, not a hardcoded special case.

  Breaking (pre-1.0, acceptable): the requirements-rework quality-companion gate is removed
  (convergence is now reviewer-driven), so `RequirementReview` drops `companionVerdicts` and
  gains `iteration`/`maxIterations` and the `merged`/`exceeded` statuses; the
  `requirement_reviews` and `merge_threshold_presets` tables change shape on both runtimes
  (D1 migration `0044` ⇄ a generated Drizzle migration — additive `ALTER`s: `companion` is
  dropped, the new columns take defaults, so existing rows are not lost but their old review
  state is re-created on the next run).

- de5a9d7: Add configurable Slack notifications as an additional delivery transport for the
  existing notification mechanism (merge_review / pipeline_complete / ci_failed) —
  not a parallel system. A new `SlackNotificationChannel` implements the same
  `NotificationChannel` port the in-app channel does and is composed alongside it via
  `CompositeNotificationChannel`, so the engine call sites that raise notifications
  are untouched.

  Two scopes, mirroring the GitHub-App precedent:

  - The Slack **connection** (the installed team + its bot token) is bound
    **per-account**. The bot token is multi-tenant data, so it is encrypted at rest
    with `WebCryptoSecretCipher` (HKDF tag `cat-factory:slack`) and never returned on
    the wire — only safe metadata (team name/icon, bot user, scopes) is exposed.
    Onboarding is UI-based: a full OAuth "Add to Slack" flow when the app credentials
    are configured (`SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`/`SLACK_REDIRECT_URL`),
    with manual bot-token paste always available as a fallback.
  - Notification **routing** (which types post, to which channel) is configured
    **per-workspace**.
  - Optional **@-mentions** are **role- and audience-aware**, not a workspace
    broadcast. The per-account member map tags each member `product` or `engineering`,
    and each notification type mentions a specific audience: requirement-review
    findings ping **product** people **plus the task's creator**, while the engineering
    notifications (merge_review / pipeline_complete / ci_failed) ping **only the task's
    creator**. This adds a `requirement_review` notification type (raised by the
    requirements reviewer when it produces findings) and records a `createdBy` on
    blocks (a new nullable column on both runtimes), captured from the authenticated
    user at task creation.

  New surface: the `slack` contracts, the kernel Slack repository ports, the
  `@cat-factory/integrations` Slack module (`SlackNotificationChannel`,
  `SlackConnectionService`, `SlackSettingsService`, `SlackMemberMappingService`,
  `SlackApiClient`), the shared `SlackController` (+ public OAuth callback) and
  `SlackConfig`, and the orchestration `SlackModule`. Persisted on **both** runtimes:
  the Cloudflare D1 tables (migration `0037_slack.sql`) and the Node Postgres tables
  (Drizzle schema + generated migration), with both facades wiring the channel +
  management module. The cross-runtime conformance suite asserts the routing and
  member-map persistence parity on both stores.

  This change also closes a pre-existing parity gap: the Node/Drizzle facade now has
  a `notifications` table + `DrizzleNotificationRepository` and wires
  `notificationRepository`, so the notification subsystem — and any channel composed
  onto it — fires on the Node runtime exactly as on the Worker.

  Opt-in via `SLACK_ENABLED=true` (requires `ENCRYPTION_KEY`); off by default, so
  unconfigured deployments are unaffected.

- e0230a0: Surface the real reason a run failed instead of a generic "the implementation container
  reported a failure", and stop the cross-runtime conformance suite from hiding driver bugs.

  - **Fix the clobbered failure record.** Two inline gates that already knew the precise
    failure — an unparseable companion (Spec Reviewer) verdict (`companion_rejected`, with
    the companion's raw reply as the detail) and a Tester gate that exhausted its fixer
    budget (`agent`) — recorded a rich `failRun` AND then returned `job_failed`. The durable
    driver (Cloudflare `ExecutionWorkflow` / Node `driveExecution`) treated `job_failed` as
    "fail the run" and fired a SECOND `failRun`, overwriting the good record with a generic
    one: kind `job_failed`, message the literal `"companion_rejected"`, no detail, and the
    misleading "inspect the container logs" hint. Those gates now RETURN the classification +
    detail on the `job_failed` result (`failureKind`/`detail` on `AdvanceResult`), and the
    driver funnels them through the single `failRun` — so the board shows the actual message,
    the precise kind/hint, and the raw reply under "Show detail".

  - **`failRun` is now idempotent.** A run already in a terminal `failed` state keeps its
    first (richest) failure rather than being overwritten, so no future
    record-then-return-`job_failed` path can clobber it.

  - **Share the production driver loop.** The runtime-neutral per-run driver
    (`driveExecution`) moved into `@cat-factory/orchestration` and is now exported; the Node
    service injects a real `setTimeout` sleep, the Cloudflare workflow wraps the same
    advance/poll calls in durable steps. The cross-runtime conformance harnesses no longer
    hand-roll their own advance/poll loop (which never re-called `failRun` on `job_failed`,
    the gap that let this ship) — both drive runs through the SAME `driveExecution` via a
    shared `driveWorkspace` helper, so the suite exercises real production driving logic. The
    companion-rejected conformance assertion now checks the rich message + stored detail.

- Updated dependencies [fe53445]
- Updated dependencies [8eed38c]
- Updated dependencies [d94e75c]
- Updated dependencies [6406c8c]
- Updated dependencies [e0e89a7]
- Updated dependencies [3d9a9d8]
- Updated dependencies [db77061]
- Updated dependencies [28d3c28]
- Updated dependencies [a48c620]
- Updated dependencies [3bc8c79]
- Updated dependencies [9d3a956]
- Updated dependencies [8d11833]
- Updated dependencies [ad9ba9e]
- Updated dependencies [3e0d753]
- Updated dependencies [f83ffd7]
- Updated dependencies [3e7ab89]
- Updated dependencies [8065fed]
- Updated dependencies [385bd93]
- Updated dependencies [4ee8a4b]
- Updated dependencies [e50e78a]
- Updated dependencies [0972696]
- Updated dependencies [b48c455]
- Updated dependencies [e9b9356]
- Updated dependencies [8eed38c]
- Updated dependencies [e8005ba]
- Updated dependencies [3a12f15]
- Updated dependencies [3a12f15]
- Updated dependencies [8eed38c]
- Updated dependencies [b40da13]
- Updated dependencies [3a12f15]
- Updated dependencies [ec0c416]
- Updated dependencies [8eed38c]
- Updated dependencies [084bf43]
- Updated dependencies [14840ec]
- Updated dependencies [268c15d]
- Updated dependencies [c9d3f49]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [157cd02]
- Updated dependencies [794b628]
- Updated dependencies [7c37653]
- Updated dependencies [db77061]
- Updated dependencies [f49fa30]
- Updated dependencies [6406c8c]
- Updated dependencies [57d70fa]
- Updated dependencies [1a0686f]
- Updated dependencies [6406c8c]
- Updated dependencies [918764f]
- Updated dependencies [918764f]
- Updated dependencies [88b3170]
- Updated dependencies [fe0b7f8]
- Updated dependencies [f73652c]
- Updated dependencies [db336b1]
- Updated dependencies [f9d3647]
- Updated dependencies [8807f5c]
- Updated dependencies [7a9cabf]
- Updated dependencies [f0a847d]
- Updated dependencies [0b21ff3]
- Updated dependencies [9c9c1b5]
- Updated dependencies [9be11e1]
- Updated dependencies [5ec0d25]
- Updated dependencies [197264e]
- Updated dependencies [a691853]
- Updated dependencies [f066c59]
- Updated dependencies [c664fe6]
- Updated dependencies [8eed38c]
- Updated dependencies [7d5e060]
- Updated dependencies [75bd29d]
- Updated dependencies [8eed38c]
- Updated dependencies [4a08935]
- Updated dependencies [2796a42]
- Updated dependencies [6406c8c]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [70e8ef0]
- Updated dependencies [b287996]
- Updated dependencies [b156b4b]
- Updated dependencies [f49fa30]
- Updated dependencies [5c8ca33]
- Updated dependencies [b156b4b]
- Updated dependencies [7cf2a2d]
- Updated dependencies [2d66d34]
- Updated dependencies [197264e]
- Updated dependencies [1a0686f]
- Updated dependencies [3a12f15]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [37baa7f]
- Updated dependencies [c664fe6]
- Updated dependencies [553a67d]
- Updated dependencies [b80d657]
- Updated dependencies [4026793]
- Updated dependencies [311a110]
- Updated dependencies [f16ae62]
- Updated dependencies [ba1c0cf]
- Updated dependencies [36018cb]
- Updated dependencies [799be66]
- Updated dependencies [cc39497]
- Updated dependencies [d65c979]
- Updated dependencies [75a0441]
- Updated dependencies [7157fd7]
- Updated dependencies [21ca647]
- Updated dependencies [c4ef995]
- Updated dependencies [8eed95b]
- Updated dependencies [0b38aa6]
- Updated dependencies [861d363]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [8eed38c]
- Updated dependencies [a97e485]
- Updated dependencies [de5a9d7]
- Updated dependencies [f647733]
- Updated dependencies [d5e9141]
- Updated dependencies [2dd7e56]
- Updated dependencies [2d66d34]
- Updated dependencies [86a5843]
- Updated dependencies [a54ada2]
- Updated dependencies [e0f21a0]
- Updated dependencies [2dd7e56]
- Updated dependencies [5ca8086]
- Updated dependencies [d0697d1]
- Updated dependencies [e0230a0]
- Updated dependencies [0090313]
- Updated dependencies [7dc8e57]
- Updated dependencies [cc8d96a]
- Updated dependencies [7c37653]
- Updated dependencies [43f2443]
- Updated dependencies [acac735]
- Updated dependencies [b98923c]
- Updated dependencies [3841315]
- Updated dependencies [48d2f0d]
- Updated dependencies [3e6a844]
  - @cat-factory/contracts@0.7.0
  - @cat-factory/orchestration@0.7.0
  - @cat-factory/node-server@0.7.0
  - @cat-factory/server@0.7.0
  - @cat-factory/kernel@0.7.0
  - @cat-factory/agents@0.7.0
