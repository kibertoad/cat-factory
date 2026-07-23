# @cat-factory/cli

## 0.8.5

### Patch Changes

- 8254367: Lint tightening: ratchet oxlint `complexity` from 40 to its step-2 target of 30.

  Refactored every function above complexity 30 along cohesive, behaviour-neutral seams (helper
  extractions / options-object bundles), including the god-file offenders: the Worker
  `buildContainer` registry resolution → a `container-registries.ts` sibling, `RunDispatcher`'s
  settled-poll branch tree → a new `PollCompletionController`, and `ExecutionService.stepInstance`'s
  re-entrancy predicate → a `reentrancy.logic.ts` sibling (both of which also shrink their host
  god-files). The executor-harness image tag is bumped (harness `src/**` changed).

## 0.8.4

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

## 0.8.3

### Patch Changes

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

## 0.8.2

### Patch Changes

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

## 0.8.1

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

## 0.8.0

### Minor Changes

- 19d5884: Scaffolded local-mode `.env` no longer sets `LOCAL_HARNESS_IMAGE` to a mutable `:latest` tag.
  It is now left UNSET by default (documented commented-out) so the backend runs the executor-harness
  image version it was built and tested against; the guidance explains that you should pin it only to
  lock to a specific version for testing or a hotfix. `--harness-image` still writes an explicit pin
  active when supplied.

## 0.7.1

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

## 0.7.0

### Minor Changes

- 20bcf00: Add a `cat-factory env` command that generates a ready-to-run local-mode `.env` in the
  current directory (or `--dir`) — the same secret generation, GitHub/GitLab PAT browser flow, and
  pool-vs-native execution-mode choice as `init`, but without scaffolding a whole project. Use it in
  an existing deployment dir (e.g. `deploy/local`). Like `init`, it also creates or merges the target
  dir's `.gitignore` so the secret `.env` it writes can never be committed.

  Also generate the `HARNESS_SHARED_SECRET` (the backend↔executor-harness HMAC key) alongside
  `AUTH_SESSION_SECRET` and `ENCRYPTION_KEY`, and write it into the local `.env` (and `.env.example`).
  It is required to boot, so both `init` and `env` now produce a `.env` that runs local mode with no
  manual edits (a model-provider key is not needed to boot — add providers/keys in the UI).

## 0.6.2

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

## 0.6.1

### Patch Changes

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

## 0.6.0

### Minor Changes

- 85592eb: `cat-factory init` now offers richer `.env` preconfiguration for local mode: it offers to
  generate `AUTH_SESSION_SECRET` / `ENCRYPTION_KEY` (on by default, decline to paste your own),
  lets you choose between a **prewarmed Docker pool** and **native host agents** (with the
  tradeoffs printed and the applicable native models listed for the native path), and surfaces the
  commonly-useful optional settings (auth, Langfuse, Slack, consensus, image refresh) commented with
  sane defaults — each annotated with its actual default (so the opt-in knobs aren't mistaken for
  on-by-default). New flags: `--execution-mode`, `--native-harnesses`, `--harness-entry`. A
  native-only flag with no `--execution-mode` now infers native mode (and passing one under `pool`
  warns instead of silently dropping it), and `--yes --execution-mode native` warns when
  `LOCAL_HARNESS_ENTRY` is left blank.

## 0.5.4

### Patch Changes

- 8bf2a8b: Add a configurable token-read poll budget to the `cat-factory k3s` provisioner: `ProvisionDeps.tokenReadAttempts` (default `DEFAULT_TOKEN_READ_ATTEMPTS` = 20, i.e. 10s) lets a caller wait longer for a freshly-applied ServiceAccount-token Secret to populate. The interactive default is unchanged (still fails fast); the new k3d integration suite raises it so a busy CI cluster's token controller can't flake the run.

  Also test/CI only: a k3d integration suite for the guided setup that drives the CLI's real probe + provisioning logic against the `test-k8s` cluster, validating the idempotent "already set up before" re-run behaviour (stable long-lived token across re-provisions, `kubectl apply` reconcile, no duplicate resources). Runs in the existing `test-k8s` CI job (also gated on `host-shell.ts`, whose real `createNodeShell()` this suite alone exercises); self-skips when no reachable local cluster is present.

## 0.5.3

### Patch Changes

- 51dd48f: Surface why the Kubernetes connect button is disabled, and align the `cat-factory k3s` CLI
  guidance with the actual form field names.

  - The Kubernetes connect forms (`KubernetesEngineForm`, `KubernetesRunnerForm`,
    `KubernetesEnvironmentForm`) now render a red hint next to the disabled **Connect** button
    listing the mandatory fields that are still empty (or, where applicable, the format/range
    issue), so a dead button explains itself instead of leaving the user guessing.
  - `cat-factory k3s`'s connection summary now names the fields exactly as the Local k3s form
    labels them: paste the token into the **"ServiceAccount token"** field (was "API token"),
    and set **"Environment URL source" → "Ingress host template"** with the **"Host template"**
    value (was a single "Ingress host template" line).

## 0.5.2

### Patch Changes

- 3643478: `cat-factory k3s`: show the real kubectl client version in the probe report (was rendered as
  `{` — the leading brace of the `--output=json` payload) and make the k3s-install fallback
  platform-aware. k3s is Linux-only, so on Windows/macOS the guided setup now steers to the k3d
  (k3s-in-Docker) path instead of printing a `curl … | sh -` command that can't run there.

## 0.5.1

### Patch Changes

- 3965992: Refresh the scaffold library pins to the current published releases (`@cat-factory/local-server` `^0.34.0`, `@cat-factory/app` `^0.66.0`) so `templates.pins.test.ts` is green again.

## 0.5.0

### Minor Changes

- ae76a0d: `cat-factory k3s` now hands the provisioned cluster off to the SPA (guided-setup slice 3).
  After provisioning, it builds the `local-k3s` infra-handler registration input
  (`buildK3sHandler`) — apiserver URL, skip-TLS, the `cf-env-{{pullNumber}}` namespace + the
  `{{branch}}.127.0.0.1.nip.io` ingress defaults, and the minted ServiceAccount token in the
  write-only secret bundle — and opens the SPA's Local k3s connect form **pre-filled** via a
  deep-link (`buildK3sSetupUrl`). The link carries only the non-secret fields (the token is a
  secret — it would leak into browser history/logs — so it is printed once for the user to
  paste); the user then runs Test → Save, reusing the existing connectivity probe. New
  `--app-url` flag (default `http://localhost:3000`) picks the SPA base; the browser open is
  skipped under `--no-open` or non-interactive `--yes`. A hands-free `--register` flag that
  POSTs the handler to the local API is documented as a follow-up. The handler shape is
  validated against the real `registerEnvironmentHandlerSchema` in tests, so the CLI keeps its
  single `@clack/prompts` runtime dependency (contracts is a devDependency only).

## 0.4.0

### Minor Changes

- cf5774a: `cat-factory k3s` now provisions on your behalf (guided-setup slice 2): after the probe,
  it creates (or reuses) a local k3d/kind cluster, applies a least-privilege ServiceAccount

  - RBAC, mints a long-lived token, reads the apiserver URL, and prints the values to wire
    into the Local k3s environment handler. Every mutating step is behind an explicit confirm
    (skipped by `--yes`); the sudo `k3s` install is still only ever printed. The `HostShell`
    seam gained an `input` option so the RBAC manifest is piped to `kubectl apply -f -` without
    touching disk. Also refreshes the scaffold `@cat-factory/app` pin to `^0.64.0`.

    Hardening: cluster creation runs under a 5-minute watchdog (the default 10s would kill the
    image pull); the RBAC no longer grants cluster-wide `list`/`watch` on `secrets`/
    `serviceaccounts` (which would let the token read every ServiceAccount token — effectively
    cluster-admin); `--yes` refuses to auto-provision a reachable cluster that doesn't look local
    (guarding a kubeconfig pointed at a shared/remote cluster) and the confirm names the target
    context + apiserver; commands target an explicit `--context` instead of mutating the user's
    global current-context; a create that fails on the apiserver port surfaces a collision hint;
    and the `0.0.0.0` apiserver bind address is normalized to `127.0.0.1`.

## 0.3.1

### Patch Changes

- c40736e: Refresh the scaffolded `@cat-factory/app` pin to `^0.64.0` so `cat-factory init` generates a
  frontend deployment against the current published layer (the `^0.63.1` pin no longer covered
  `0.64.0`).

## 0.3.0

### Minor Changes

- fb699f3: Add the `cat-factory k3s` guided local-cluster setup command (initiative slice 1: host probe +
  report).

  `cat-factory k3s` probes the machine over a new injectable host shell-out seam (`HostShell`) for a
  reachable cluster / installed `k3d`/`kind`/`k3s`/`kubectl` / a running Docker, classifies the host
  (pure `classifyHost`), and reports what it found plus a recommended path — reuse the existing
  cluster, create a k3d or kind cluster (Docker, no root; selected by `--runtime`), or the guided
  (sudo) k3s path (which points at starting an already-installed k3s, or otherwise prints the install
  command — never run). The apiserver-contacting `kubectl` probes carry a `--request-timeout` and the
  `HostShell` has a watchdog, so a stale kubeconfig fails fast instead of hanging the probe. Mirrors
  the `init` command's pure-planner + IO-seam shape and is fully unit-tested with a scripted fake
  shell. Cluster provisioning, ServiceAccount/token minting, and wiring the `local-k3s` infra handler
  follow in later slices.

## 0.2.2

### Patch Changes

- 720942a: Refresh the scaffolded project's pinned library versions so `cat-factory init`
  emits an up-to-date local-mode deployment. `@cat-factory/local-server` was pinned
  at `^0.19.5` (published `0.33.0`) and `@cat-factory/app` at `^0.47.7` (published
  `0.63.1`), so a freshly scaffolded project resolved badly stale backend/frontend
  libraries. Bumped both pins to the current published majors.

  Also note the local-mode sign-in step in the generated `README.md`: local mode
  requires sign-in, and because the CLI writes the provider PAT, the login screen
  offers "Sign in with configured PAT" — the generated run instructions now say so.

  Guard the pins against silent re-drift: `templates.pins.test.ts` fails the build
  if either caret no longer covers the current workspace version of
  `@cat-factory/local-server` / `@cat-factory/app`, so the pins can't quietly fall
  behind the libraries again. Also corrected the `templates.ts` comment, which
  claimed the caret picks up "patch/minor" releases — for these `0.x` libraries a
  caret only covers patches, so each minor bump needs a manual refresh here.

## 0.2.1

### Patch Changes

- 2961b05: Polish the scaffolded local deployment: `local/.env` now carries commented container→host
  reachability + security hints (the per-runtime host alias, the native-Linux-Docker
  `add-host-gateway`, the `AUTH_DEV_OPEN` lockdown note), the `.env.example` files mirror the
  chosen port/db/api-base instead of hardcoding `8787`, the generated README warns when `db:up`
  needs a non-docker runtime (Podman/Apple), and a `git init` nudge is printed for a fresh target
  dir. GitLab is now documented as a first-class local-mode provider (it gates CI + merges for real
  via `@cat-factory/gitlab`).

## 0.2.0

### Minor Changes

- 5c95baa: Add `@cat-factory/cli` — a bootstrap CLI (`cat-factory init`) that scaffolds a local-mode
  deployment (Node/local backend + frontend SPA, mirroring `deploy/local` + `deploy/frontend` but
  on the published libraries). It generates the crypto secrets (`AUTH_SESSION_SECRET` hex,
  `ENCRYPTION_KEY` base64) in the server's required formats, mints a GitHub/GitLab personal access
  token by opening the browser at the right pre-scoped URL and reading the pasted value, and writes
  the populated `.env` files with a `.gitignore` that keeps them out of version control.
