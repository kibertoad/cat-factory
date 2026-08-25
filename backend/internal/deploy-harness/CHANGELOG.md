# @cat-factory/deploy-harness

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
