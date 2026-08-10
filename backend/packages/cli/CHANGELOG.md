# @cat-factory/cli

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
