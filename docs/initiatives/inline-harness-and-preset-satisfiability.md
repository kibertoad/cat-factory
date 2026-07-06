# Initiative: inline harness execution (local) + preset satisfiability gate

**Status:** in progress · **Owner:** core · **Started:** 2026-07-02

> **Update 2026-07-06 (dedicated inline flag, default on).** The inline ambient-CLI path is now
> gated by its OWN env flag `LOCAL_NATIVE_INLINE` (default ON), decoupled from the container-native
> `LOCAL_NATIVE_AGENTS` opt-in — see [Phase C](#phase-c-dedicated-inline-flag--prewarmed-container-backend)
> below. Previously a subscription-only preset (everything pinned to `claude-opus`) could run its
> inline reviewers ONLY if you also opted into UNSANDBOXED native container execution; now the inline
> steps (one-shot text, no repo/tools) run on the local `claude`/`codex` CLI by default in both local
> and mothership mode. The prewarmed-container backend (run the inline CLI in a warm container on the
> leased subscription, so the host CLI need not be installed) is the documented next slice.

> Durable source of truth for this change. Read it first before picking up the next slice;
> update the checklist at the end of each PR.

## Goal & rationale

Two coupled problems surfaced by a **local (Postgres) deployment whose model preset pins
everything to a subscription-only model (`claude-opus`)**:

1. **The inline requirements-reviewer failed with a misleading `qwen:qwen3-max` error.**
   The reviewer is an inline `generateText` call. A subscription-only ref carries
   `harness: 'claude-code'`, which `inlineModelRef` (`kernel/ports/model-provider.ts`)
   **strips down to the routing default** because an inline call has no provider key for
   the container harness. On the Node/local facade that routing default resolves to
   `qwen:qwen3-max` (a direct DashScope ref, returned best-effort by `effectiveVariant`
   even when Cloudflare is off and no Qwen key is set). The workspace has no Qwen key, so
   the call throws. The failure happens in `IterativeReviewService.review()` **before** any
   `requirement_reviews` row is persisted, so the review window shows "No review yet" —
   the run failed with no surfaced detail.

2. **The pre-flight `assertProvidersConfiguredForPipeline` guard passed it anyway.** It
   checks `isModelUsable(id, caps)`, which is `true` for `claude-opus` (the workspace has a
   Claude subscription) — usable for **container** steps. But it treats a subscription-only
   model as usable for **every** step, when **inline** steps can't use a subscription token.

### End state

- **Local mode can run inline LLM calls through the ambient Claude Code / Codex CLI** when
  the developer opted into native agents (`LOCAL_NATIVE_AGENTS` includes the harness). So a
  Claude-only preset runs the reviewer/brainstorm/estimator inline on the developer's own
  `claude` login, exactly as container steps already do (ambient auth, unmetered, host
  subprocess). This is genuinely **local-only** — the Cloudflare Worker has no subprocess,
  and stock Node has no ambient CLI — so it is asymmetric _by nature_ (like the local
  runner transport), NOT a facade-parity gap.
- **A preset that can't provide a runnable model for every step refuses to start**, with a
  clear, actionable error naming the offending step + model and the remedy (pin an
  inline-capable model, or configure a provider). No more silent mid-run degrade.

## Design

### A. Inline harness execution (local ambient)

- **`nativeVendorForRef(ref)` (kernel `domain/models.ts`)** → `'claude' | 'codex' | undefined`.
  The only _native_ ambient vendors (a CLI login, no Anthropic-compatible base URL) are
  `claude` (`{provider:'anthropic', harness:'claude-code'}`) and `codex`
  (`{harness:'codex'}`). GLM/Kimi/DeepSeek reuse the `claude-code` harness but carry a
  vendor base URL, so they are NOT ambient-inline eligible.
- **`inlineModelRef(ref, fallback, opts?)`** gains an optional
  `opts.runsInline?: (ref) => boolean`. When the ref is a non-`pi` harness ref AND
  `runsInline(ref)` is true, the ref is **kept** (not degraded). Default (no opt / returns
  false) preserves today's degrade-to-fallback behaviour, so Node/Worker are unchanged.
- **`AgentsConfig.inlineHarnessRef?: (ref) => boolean` (server `config/types.ts`)** — the
  deployment predicate threaded into every inline caller. The **local** facade sets it to
  `(ref) => isAmbientNativeVendor(nativeAmbientAuth, nativeVendorForRef(ref))`; Node/Worker
  leave it undefined.
- **`CliInlineLanguageModel` (`@cat-factory/agents/src/providers/cli-inline.ts`)** — an AI
  SDK `LanguageModelV3` whose `doGenerate` calls an injected
  `runInline({model, system, prompt, maxOutputTokens, signal}) → {text, finishReason, usage}`
  and adapts it to the SDK result shape (`doStream` wraps `doGenerate` as one text part).
  Pure; the subprocess lives in the facade.
- **`runAmbientCliInline` (local facade)** — spawns `claude -p --output-format json
--model <m> --append-system-prompt <sys>` (or the codex analogue) with the prompt on
  stdin, ambient auth (no injected creds), parses `{result, usage}`. The one-shot analogue
  of the harness's `runClaudeCode`.
- **`HarnessInlineModelProvider` (local)** — wraps the Node `ModelProviderResolver` so
  `resolve(ref)` returns a `CliInlineLanguageModel` for an ambient-eligible harness ref and
  delegates everything else to the inner composite provider.
- **Inline callers thread the predicate**: `IterativeReviewService.modelFor`,
  `KaizenService`, `SandboxRunService`, and `routing.resolveInlineModelRef` (used by
  `AiAgentExecutor`) pass `config.agents.inlineHarnessRef` into `inlineModelRef`.

### B. Preset satisfiability gate (all facades)

- **Taxonomy (`@cat-factory/agents`)**: `agentStepModelSurface(kind) → 'container' | 'inline' | 'none'`.
  `container` = `CONTAINER_KINDS ∪ registeredKindRequiresContainer ∪ isContainerBackedCompanion`;
  `inline` = the engine-inline set (`requirements-review`, `clarity-review`, the two
  brainstorm kinds, `task-estimator`) ∪ registered kinds with `agent.surface === 'inline'`;
  `none` = gates/one-shot non-LLM steps (`ci`, `conflicts`, `human-review`,
  `post-release-health`, `tracker`, `deployer`, `human-test`, `visual-confirmation`).
  `CONTAINER_KINDS` moves from `CompositeAgentExecutor` into agents and is shared by both
  the executor and the guard (single source of truth).
- **`isModelUsableInline(id, caps, runsInline?)` (kernel)** — usable for an inline step: a
  usable non-subscription flavour (`isModelUsable` with a non-harness effective ref), OR a
  harness ref the deployment runs inline (`runsInline(ref)`). A subscription-only model
  with no inline-harness support is NOT inline-usable (it would degrade to an ungated env
  default — exactly the silent-failure path we are closing).
- **`assertProvidersConfiguredForPipeline`** (orchestration `ExecutionService`) additionally
  requires, for each **inline** step, `isModelUsableInline(id, caps, runsInline)`; container
  steps keep `isModelUsable`; `none` steps are skipped. A block-level pin is checked once
  for container-usability and, if the pipeline has any inline step, for inline-usability.
  The `runsInline` predicate is wired from `config.agents.inlineHarnessRef` (undefined on
  Node/Worker → subscription-only inline steps refuse to start there, as intended).
- **Error**: `ConflictError(code='preset_unsatisfiable', {models,steps,reason})`. The SPA
  maps the code to a translated, actionable toast.

### Symmetry note

Part B is fully symmetric (every facade gets the stricter guard + conformance assertion).
Part A is intentionally local-only (subprocess/ambient CLI). The guard's `runsInline`
predicate is the seam that keeps the two consistent: where inline-harness is supported the
guard treats a subscription model as inline-satisfiable; where it isn't, the guard refuses
— so no runtime silently degrades.

## Checklist

| Slice                                                                                                                                    | Status      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel: `nativeVendorForRef`, `inlineModelRef` opts, `isModelUsableInline`                                                               | ✅ done     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Agents: `isInlineModelStep` taxonomy + `CliInlineLanguageModel`                                                                          | ✅ done     | `CONTAINER_KINDS` left in `CompositeAgentExecutor` — the guard only needs the inline set (container/gate keep the lenient check, so no false refusals), so moving it was unnecessary churn.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server: `AgentsConfig.inlineHarnessRef`; thread `resolveInlineModelRef`                                                                  | ✅ done     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Orchestration: thread predicate into inline services; rewrite start guard                                                                | ✅ done     | requirements/clarity/brainstorm/kaizen/sandbox + `AiAgentExecutor` all thread `runsInline`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Local: ambient CLI runner + `HarnessInlineModelProvider` + config wiring                                                                 | ✅ done     | `harnessInline.ts`; wired via the new `wrapModelProviderResolver` seam on `buildNodeContainer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Conformance: preset-unsatisfiable refusal                                                                                                | ⬜ deferred | The guard is SHARED orchestration code (identical on Node/Worker; `inlineHarnessRef` undefined), so there is no facade-drift to catch — covered by unit tests instead. A cross-runtime assertion needs `subscriptions` wired into the harness (to reach the "container-usable, not inline-usable" state); tracked as a follow-up.                                                                                                                                                                                                                                                                                                       |
| Unit tests (kernel logic via agents, `isInlineModelStep`, `CliInlineLanguageModel`, reviewer resolution, local predicate/provider)       | ✅ done     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Consensus: thread `runsInline` into `ConsensusAgentExecutor` (an inline path)                                                            | ✅ done     | `baseRef` + `refForModelId` now pass the predicate; wired from `config.agents.inlineHarnessRef` in `node/container.ts`; covered by a consensus unit test (degrade vs keep). Without this a subscription-only consensus participant still stranded on the fallback provider in local mode.                                                                                                                                                                                                                                                                                                                                               |
| CLI runner hardening (local): timeout watchdog + SIGKILL escalation, claude in-band error surfacing, injectable exec seam + runner tests | ✅ done     | `spawnCliExec` now has a `DEFAULT_CLI_TIMEOUT_MS` watchdog so a hung CLI can't park the run; `makeClaudeRunner` throws on `is_error`/`error_*` subtypes instead of returning the error text as a review; `runnerForVendor(vendor, exec)` takes an injectable exec so the vendor runners are unit-tested.                                                                                                                                                                                                                                                                                                                                |
| Frontend: i18n mapping for `preset_unsatisfiable` (+ all 8 locales)                                                                      | ✅ done     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Changesets                                                                                                                               | ✅ done     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Guard visibility into consensus per-participant model pins                                                                               | ⬜ deferred | The start guard classifies steps by `pipeline.agentKinds` and checks the block pin / workspace default; it does NOT see a consensus step's per-participant model pins (a consensus step keeps its container `agentKind`). In local mode the consensus threading above makes subscription refs runnable, so no failure; on Node/Worker a consensus step whose participants pin a subscription-only model is not refused up front and would still degrade mid-run. Narrow (opt-in consensus + subscription-only participant pins + non-inline-harness runtime); tracked as a follow-up rather than expanding the guard's data model here. |

## Gotchas carried between iterations

- **`effectiveVariant` returns a best-effort ref even when nothing is usable** — never infer
  usability from the ref alone; gate on `isModelUsable`/`isModelUsableInline`.
- **The reviewer persists no row on a first-review failure** — the "No review yet" symptom is
  a _consequence_ of the failure, not a separate bug; the refuse-to-start guard prevents the
  failure entirely, so no persistence change is needed.
- **Don't loosen the existing guard**: keep `isModelUsable` on every model-bearing step and
  only _add_ the inline-strict check for inline steps, so no currently-passing run regresses.
- **Every INLINE caller must thread `runsInline`** — the reviewers, brainstorm, kaizen, sandbox,
  `AiAgentExecutor`, AND the consensus executor. A missed inline call site silently keeps
  degrading subscription harness refs even in local mode (the consensus path was one such gap).
- **The inline-engine kind ids are single-sourced in `@cat-factory/agents` `step-surface.ts`**
  (co-located with `isInlineModelStep`, since agents can't import orchestration); `ci.logic.ts`
  re-exports them, mirroring how the gate/helper kinds are re-exported from kernel. Add a new
  inline kind's id there so the classifier can't drift.
- **The ambient CLIs report failures in-band (exit 0)** — `claude --output-format json` sets
  `is_error` / an `error_*` subtype with the message in `result`; surface it as a throw, or the
  error string is parsed as a real review. These one-shot CLIs expose no token-length stop
  reason, so a genuine output-cap truncation reads as `stop` (the `finishReason === 'length'`
  guard only fires for HTTP providers).

## Phase C: dedicated inline flag + prewarmed-container backend

Motivation: a developer running local (or mothership) mode with a Claude subscription and a preset
that pins `claude-opus` everywhere was refused at pipeline start with `preset_unsatisfiable` unless
they ALSO turned on `LOCAL_NATIVE_AGENTS` — which runs whole CONTAINER agents unsandboxed. Coupling
the benign inline path (a one-shot text call, no repo checkout, no tools) to the unsandboxed
container opt-in was wrong.

### C1 — dedicated `LOCAL_NATIVE_INLINE` flag (default on) ✅ done (2026-07-06)

- **New env `LOCAL_NATIVE_INLINE`** (local facade), a comma-separated harness allow-list that
  **defaults ON** (both `claude-code` + `codex` when unset). `off`/`false`/… disables; a subset
  (`claude-code`) restricts. Parsed by `parseInlineHarnesses` (`runtimes/local/src/container.ts`),
  which shares `parseHarnessSet` with `parseNativeHarnesses` — the ONLY difference is the
  unset-default (native defaults off, inline defaults on).
- **Decoupled wiring.** `buildLocalContainer` now derives `inlineHarnesses` from
  `LOCAL_NATIVE_INLINE` and wires `config.agents.inlineHarnessRef` + `wrapModelProviderResolver`
  from THAT set, independent of `nativeHarnesses` (`LOCAL_NATIVE_AGENTS`, still the container-native
  opt-in feeding `config.nativeAmbientAuth`). Works in local AND mothership mode — both boot through
  this facade on the developer's machine, so the host CLI is reachable in either.
- **Scope.** Uses the developer's AMBIENT CLI login (leases nothing), so only the native vendors
  `claude` / `codex` qualify (`nativeVendorForRef`). A non-native `claude-code` vendor (GLM/Kimi/
  DeepSeek, which carries a base URL) still degrades to a provider model for inline steps, and the
  start guard still refuses it when no provider-backed flavour is usable.
- **Consequence.** With the flag default-on, a subscription-only preset starts and its inline steps
  run on the local CLI. If the CLI is NOT installed/logged in, the inline step now fails at spawn
  (a clear runner error) rather than the run being refused up front — acceptable for a local dev
  machine and the explicit product choice (default on). Set `LOCAL_NATIVE_INLINE=off` to restore the
  up-front `preset_unsatisfiable` refusal.

### C2 — prewarmed-container inline backend ✅ done (2026-07-06) (the compatibility path)

Landed as designed below. Summary of what shipped:

- **Harness `inline` kind** (`executor-harness/src/inline.ts` + `parseInlineJob`): a one-shot,
  no-checkout completion that reuses `runSubscriptionHarness`'s credential-env setup and returns
  `{ text, usage, finishReason }`. Image bumped 1.35.0 → 1.36.0 (pins re-synced via
  `pnpm sync:image-tags`).
- **Kernel**: `subscriptionVendorForRef(ref)` (catalog reverse-map, ANY subscription vendor);
  `ModelScope.executionId`; `resolveScopedModelProvider(scope, deps)`.
- **Transport**: `LocalContainerRunnerTransport.runInline(req)` leases a warm member (transient
  when pooling is off), POSTs the `inline` job, polls to completion (`pollInlineJob`), releases.
- **Local resolver**: `wrapResolverWithInlineHarness({ inlineHarnesses, hostCliVendors, runInline,
leasePersonal/leasePooled })` — host CLI when the native vendor's binary is present, else the
  container on a leased credential (personal per-run activation for an individual vendor, pooled
  token otherwise). `makeInlineHarnessPredicate` broadened to ANY subscription vendor whose
  harness is enabled (so GLM/Kimi/DeepSeek now qualify — previously host-CLI-only).
- **Node seam**: `wrapModelProviderResolver(inner, deps)` now receives the lease closures;
  `buildNodeContainer` builds the subscription services before the resolver wrap.
- **Threading**: `executionId` + initiator `userId` into the inline scope via `scopeForBlockRun`
  (`inlineScope.ts`) — the iterative reviewers, doc/initiative interviewers, tester QC, Kaizen,
  and the AI/consensus agent executors. `resolveBlockRunContext(deps)` wires it from the block's
  active run for the engine-driven inline services.

Gotchas surfaced:

- **No `docker exec` seam exists** — the ONLY way into a warm container is `POST /jobs`; the
  `inline` kind is the seam (chose this over adding an exec primitive, which would duplicate the
  credential-env setup outside the image).
- **`LOCAL_NATIVE_INLINE` now gates BOTH backends** (host CLI + container), broadened from
  "host-CLI ambient allow-list" to "inline subscription harnesses enabled". `off` still refuses a
  subscription-only inline step up front. Host-vs-container SELECTION lives in the provider, not
  the predicate.
- **Individual-vendor container lease needs run context** (`executionId` + `userId`). Sandbox
  (no run) and Kaizen (activation deleted post-run) are pooled-only in practice; they fail loudly
  for an individual vendor rather than silently mis-running.

Original design (kept for reference):

Goal: run the inline subscription CLI inside a **prewarmed local container** on the LEASED/configured
subscription credential, so the inline path works even when the host has no `claude`/`codex` binary
(and in mothership mode without touching the host), at warm-pool latency. This is the "increase
compatibility" half of the product ask and is deliberately deferred because it is cross-cutting and
credential-sensitive:

#### C2 implementation plan (decided 2026-07-06)

Two decisions locked in: (1) the container runs the one-shot CLI via a NEW harness **`/inline`
job kind** (reuses `runSubscriptionHarness`'s credential-env setup verbatim — the single
credential-handling site — at the cost of an executor-harness image bump), NOT a `docker exec`
seam; (2) **full C2** — pooled (Kimi/DeepSeek, workspaceId lease) AND personal/individual
(claude/codex/glm, executionId+userId lease), including the run-context threading.

Slices (build bottom-up):

- **Harness `inline` kind** (`executor-harness`): `parseInlineJob` (`job.ts`) + `handleInline`
  (`inline.ts`, runs `runSubscriptionHarness` in a throwaway temp cwd, returns
  `{ text, usage, finishReason }`) + register in `server.ts` `KINDS`. Bump the image tag +
  the 4 pins (harness `version`, `deploy/backend` `package.json`/`wrangler.toml`,
  `RECOMMENDED_HARNESS_IMAGE`).
- **Kernel**: `subscriptionVendorForRef(ref)` (catalog reverse-map, ANY subscription vendor,
  not just native-ambient); add `executionId?` + `initiatedByUserId?` to `ModelScope`; widen
  `resolveScopedModelProvider(scope, deps)` to accept the fuller scope.
- **Transport**: `LocalContainerRunnerTransport.runInline(req)` — lease a warm member
  (`acquireMember`, synthetic `inline-*` runId; works pool-off too as a transient member),
  POST the `inline` job, poll to completion (new `pollInlineJob` in `harnessHttp.ts`), release
  the member. Plus `hostCliAvailable(vendor)` probe (`which claude`/`codex`).
- **Local container-inline runner + provider**: an `InlineCliRunner` that, per-scope, leases the
  credential (personal via `leasePersonalSubscriptionToken(executionId,userId,vendor)` / pooled
  via `leaseSubscriptionToken(workspaceId,vendor)`) and calls `transport.runInline`. Selection:
  host-CLI when `LOCAL_NATIVE_INLINE` names the vendor AND the host CLI is present, else the
  container backend. Broaden `inlineHarnessRef` to accept ANY subscription vendor when the
  container backend is available.
- **Node wiring seam**: reorder `buildNodeContainer` so `subscriptions`/`personalSubscriptions`
  build BEFORE the model-resolver wrap; change `wrapModelProviderResolver` to
  `(inner, leaseDeps) => resolver` and pass the lease closures.
- **Threading** executionId + initiator userId into the inline resolution scope:
  `AiAgentExecutor` + `ConsensusAgentExecutor` (add `executionId` to their `forScope`);
  `KaizenService` (`grading.executionId`); `IterativeReviewService` (new run-context param
  threaded from `ExecutionService` review-gate + the re-review HTTP path); `SandboxRunService`
  stays pooled-only (no run context).
- **Tests + tracker + changesets**; keep the runtimes symmetric where the change is shared
  (the kernel scope + threading are runtime-neutral; the container-inline runner is local-only,
  like the host-CLI runner).

Original C2 notes (still accurate):

- **Run-context threading (the blocker).** For an INDIVIDUAL-usage vendor (`claude`/`codex`/`glm`,
  the `claude-opus` case) the token is leased per-run via
  `leasePersonalSubscriptionToken(executionId, userId, vendor)` against the `subscription_activations`
  row minted at run start. But the inline model seam carries almost nothing: `ModelScope` has only
  `workspaceId`/`accountId`/`userId` (no run/execution id), and `resolveScopedModelProvider` drops
  even `userId` (passes `forScope({ workspaceId })`). So C2 must first thread `executionId` +
  initiating `userId` through the inline callers (`IterativeReviewService`, `KaizenService`,
  `SandboxRunService`, `routing.resolveInlineModelRef`) and add a run/execution dimension to the
  resolver scope, then wire the personal + pooled subscription lease into a container-inline runner.
  (Pooled vendors — Kimi/DeepSeek — need only `workspaceId`, so they are the easier first step.)
- **Container execution.** Add an `exec`-into-a-warm-member seam on `ContainerRuntimeAdapter` (or a
  harness one-shot `/inline` endpoint — the latter is cleaner but bumps the executor-harness image),
  lease a warm `LocalContainerRunnerTransport` member for the call, run `claude -p` / `codex exec`
  inside it with the leased `subscriptionToken` + `subscriptionBaseUrl` injected (mirroring the job
  body `ContainerAgentExecutor.resolveAuth` builds), and adapt the result through the SAME
  `CliInlineLanguageModel` / `InlineCliRunner` seam C1 uses.
- **Selection.** With C2 landed, the inline runner picks host-CLI (when `LOCAL_NATIVE_INLINE` names
  the vendor AND the host CLI is present) else the prewarmed-container backend on the leased token,
  so the two backends compose behind one predicate.
