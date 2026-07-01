# Initiative: inline harness execution (local) + preset satisfiability gate

**Status:** in progress · **Owner:** core · **Started:** 2026-07-02

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
  and stock Node has no ambient CLI — so it is asymmetric *by nature* (like the local
  runner transport), NOT a facade-parity gap.
- **A preset that can't provide a runnable model for every step refuses to start**, with a
  clear, actionable error naming the offending step + model and the remedy (pin an
  inline-capable model, or configure a provider). No more silent mid-run degrade.

## Design

### A. Inline harness execution (local ambient)

- **`nativeVendorForRef(ref)` (kernel `domain/models.ts`)** → `'claude' | 'codex' | undefined`.
  The only *native* ambient vendors (a CLI login, no Anthropic-compatible base URL) are
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

| Slice                                                              | Status | Notes |
| ------------------------------------------------------------------ | ------ | ----- |
| Kernel: `nativeVendorForRef`, `inlineModelRef` opts, `isModelUsableInline` | ✅ done | |
| Agents: `isInlineModelStep` taxonomy + `CliInlineLanguageModel` | ✅ done | `CONTAINER_KINDS` left in `CompositeAgentExecutor` — the guard only needs the inline set (container/gate keep the lenient check, so no false refusals), so moving it was unnecessary churn. |
| Server: `AgentsConfig.inlineHarnessRef`; thread `resolveInlineModelRef` | ✅ done | |
| Orchestration: thread predicate into inline services; rewrite start guard | ✅ done | requirements/clarity/brainstorm/kaizen/sandbox + `AiAgentExecutor` all thread `runsInline`. |
| Local: ambient CLI runner + `HarnessInlineModelProvider` + config wiring | ✅ done | `harnessInline.ts`; wired via the new `wrapModelProviderResolver` seam on `buildNodeContainer`. |
| Conformance: preset-unsatisfiable refusal | ⬜ deferred | The guard is SHARED orchestration code (identical on Node/Worker; `inlineHarnessRef` undefined), so there is no facade-drift to catch — covered by unit tests instead. A cross-runtime assertion needs `subscriptions` wired into the harness (to reach the "container-usable, not inline-usable" state); tracked as a follow-up. |
| Unit tests (kernel logic via agents, `isInlineModelStep`, `CliInlineLanguageModel`, reviewer resolution, local predicate/provider) | ✅ done | |
| Frontend: i18n mapping for `preset_unsatisfiable` (+ all 8 locales) | ✅ done | |
| Changesets | ✅ done | |

## Gotchas carried between iterations

- **`effectiveVariant` returns a best-effort ref even when nothing is usable** — never infer
  usability from the ref alone; gate on `isModelUsable`/`isModelUsableInline`.
- **The reviewer persists no row on a first-review failure** — the "No review yet" symptom is
  a *consequence* of the failure, not a separate bug; the refuse-to-start guard prevents the
  failure entirely, so no persistence change is needed.
- **Don't loosen the existing guard**: keep `isModelUsable` on every model-bearing step and
  only *add* the inline-strict check for inline steps, so no currently-passing run regresses.
