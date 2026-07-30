# `@cat-factory/agents` — agent catalog + prompt composition + AI provisioning

**Entry:** `src/index.ts`.

**Where things live:**

- `agents/` — the agent catalog + per-kind roles: `catalog.ts`, `kinds/` (per-kind definitions
  - `versions.ts`, the versioned prompts — bump the number when you edit one), `prompts/`
    (`systemPromptFor`/`userPromptFor`; the shared fragments incl. `FINAL_ANSWER_IN_REPLY` and
    the sentinel-file guidances — `EFFORT_REPORT_GUIDANCE`, `FOLLOW_UP_GUIDANCE`, and
    `PR_DESCRIPTION_GUIDANCE` (the reviewer briefing a PR-opening coding agent writes to
    `.cat-pr-description.md`, which the harness lifts onto the PR it opens) — in
    `prompts/shared.ts`), `runtime/` (`runRepoOps` — the custom-agent pre/post-op runner).
    `kinds/capabilities.ts` holds the agent-CAPABILITY declaration vocabulary — the skill and
    tool-server (MCP) refs a kind declares, plus the pure normalisers `AgentKindRegistry` resolves
    them with (`skillsFor` / `toolServersFor`). `prompts/capabilities.ts` renders the tool-server
    prompt section (available servers + the ones this run could NOT wire). See ADR 0029.
    `catalog.ts` exports `baseSystemPromptFor` (the SHIPPED track prompt) beside `systemPromptFor`
    (that prompt plus the engine-enforced surface directives and trait guidance). The split is what
    a per-workspace **prompt override** replaces: an override supplies the base and the directives
    are re-applied on top, so a workspace cannot edit away the read-only guardrail or the
    answer-in-your-reply rule. `systemPromptFor`'s third argument is that override; the dispatch
    side of the seam lives in `@cat-factory/server`'s `agents/promptOverrides.ts`.
- `providers/` — the **AI provisioning facade**: `registry.ts` (`CompositeModelProvider`),
  `resolvers.ts` (the runtime-neutral single-provider resolvers), `endpoints.ts`
  (`providerEndpoints` — the base-URL/key source of truth, also used by the LLM proxy), and
  `instrumented.ts` (`InstrumentedModelProvider` — the INLINE feeder). It has TWO exits and
  takes EXACTLY ONE per call: the kernel `InlineLlmCallRecorder` port, which persists the call
  to `llm_call_metrics` AND (inside the service behind it) fans out to the trace sink; or the
  direct `traceSink` emit, for a call carrying no `workspaceId` — the store is workspace-scoped
  — and for a deployment with a sink but no metric store. Taking both would double every
  inline generation on Langfuse/OTel. A wrap with neither exit throws at construction.
  Neither exit is wired by hand: the server layer's `createInlineInstrumentation` composes both
  from ONE sink instance, since handing the two halves DIFFERENT sinks typechecks and merely
  splits the trace. Nor is its POSITION: a middleware only sees the model the wrap beneath it
  returned, so composing it under a facade wrap that SUBSTITUTES the model — local mode's
  subscription-inline harness — makes every call that wrap serves invisible while every other
  inline call keeps recording. That order therefore lives in the server layer's
  `wrapResolverWithTelemetry` (instrumentation inside, concurrency limiter outermost) and the two
  wraps are not individually exported, for the same reason the exit pair isn't: reversed, it
  still typechecks.
  A call whose tag names no run is attributed to `scope.executionId`, the run its credential
  scope was built for; the per-call tag still wins, and neither ⇒ null. The scope only carries a
  LIVE run (`resolveBlockRunContext`), since `block.executionId` outlives the run it names.
  Bodies leaving for a SINK pass the SAME double gate the proxied path applies: the deployment's
  `LLM_RECORD_PROMPTS` **and** the workspace's `storeAgentContext` opt-out, the latter injected
  as the required narrow `WorkspaceBodiesGate` predicate (built by kernel's
  `createStoreAgentContextGate`, so both facades wire it from one place). It is required, not
  optional, because an absent gate is an OPEN gate — which is how an opted-out workspace's
  inline prompts reached Langfuse/OTel for months. A call taken by the RECORDER is gated by the
  same rule inside the service instead, so bodies reach it ungated — and as THUNKS, so the far
  side's gate costs a prompts-off deployment nothing. Any new inline call site must tag its
  `workspaceId` via `catFactoryObservability`, or no opt-out can apply to it AND it records no
  metric row.
- `fragmentLibrary/` — the prompt-fragment library plumbing. The repo-source engine both
  libraries share lives in `repoSourceSync/`, including
  `tier-installation-resolver.ts` (`createTierInstallationResolvers`) — the ONE
  implementation of "which GitHub installation reads this tier's repos" both runtime facades
  wire for fragments AND skills. The account tier resolves through the account's boards, not
  the installation row's `accountId` (null for a PAT connect, a GitHub id for local mode's
  synthetic rows).
- `skillLibrary/` — the repo-sourced Claude Skills catalog + sync (ADR 0024) and
  `SkillRunResolver`, which resolves ONE catalog skill (instructions + resource bodies at its
  pinned commit) for a dispatch. A BUNDLED skill needs none of this — it is deployment code,
  registered on `AgentKindRegistry.registerSkill`.
- `repo-ops/` — the checkout-free `RepoFiles` renderers for custom-agent artifacts, plus the
  built-in post-ops (`builtin.ts`: `blueprintPostOp`, `specPostOp`, and `specPromotionPostOp` —
  the tester-driven `aspirational` → `established` promotion of the in-repo spec) and
  `readServiceSpec.ts`, the checkout-free reassembly of the sharded `spec/` tree (read by the
  SPA's service-spec view in `@cat-factory/server`, the promotion post-op, and the PR
  verification report's requirement → evidence join in orchestration — hence it lives here,
  below all three).
- `presets/` — built-in initiative-preset pilots. `docs-refresh/docs-detect.logic.ts` is the
  deterministic, checkout-free repo probe (`detectDocsLayout`) behind the docs-refresh preset's
  form prefill (see `docs/initiatives/initiative-presets-and-docs-refresh.md`).
  `tech-migration/` holds the technological-migration preset's pieces: `phases.ts` (the canonical
  `MIGRATION_PHASE_IDS` contract shared by the template / prompt pack / plan post-processor / E2E)
  and `prompt-additions.ts` (`MIGRATION_PROMPT_ADDITIONS` — the per-planning-kind methodology
  steering the registration spreads onto its `promptAdditions`; see
  `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`).

**See also:** `CLAUDE.md` → "Custom agents", "Conventions" (the `FINAL_ANSWER_IN_REPLY` rule);
`backend/docs/custom-agent-roles.md` (authoring a registered kind's prompt / skills / tool
servers on these seams); `backend/docs/model-support.md`.
