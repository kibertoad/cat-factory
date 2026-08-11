# `@cat-factory/agents`: agent catalog + prompt composition + AI provisioning

**Entry:** `src/index.ts`.

**Where things live:**

- `agents/`: the agent catalog + per-kind roles: `catalog.ts`, `kinds/` (per-kind definitions;
  `versions.ts` holds the versioned prompts, bump the number when you edit one), `prompts/`
  (`systemPromptFor`/`userPromptFor`; the shared fragments in `prompts/shared.ts`, incl.
  `FINAL_ANSWER_IN_REPLY` and the sentinel-file guidances `EFFORT_REPORT_GUIDANCE`,
  `FOLLOW_UP_GUIDANCE`, and `PR_DESCRIPTION_GUIDANCE` (the reviewer briefing a PR-opening coding
  agent writes to `.cat-pr-description.md`, which the harness lifts onto the PR it opens), plus
  `REVIEW_SUMMARY_LAYOUT`, carried by every reviewer whose `summary` IS the review a human reads
  (the companions, every judge) so that verdict arrives as a verdict line plus grouped bullets
  rather than one paragraph),
  `runtime/` (`runRepoOps`, the custom-agent pre/post-op runner).
  `kinds/built-in-container.ts` registers every BUILT-IN CONTAINER kind (`coder`, the testers,
  the in-place fixers, the conflict-resolver, `merger`, `on-call`, the read-only explorers) as an
  ordinary `AgentKindDefinition` declaring its `AgentStepSpec`, which is what let the server's
  per-kind job-body switch and the executor's result-coercion chain both be deleted. Each
  declares NO `systemPrompt` (its shipped TRACK owns the text; a copy would be dead the day the
  track moves) and NO `presentation` (that field is what promotes a REGISTERED kind into the
  palette, so declaring it would list the built-in twice). Their task prompts + shape hints live
  in `prompts/built-in-container.ts` and their engine-channel mappings in `kinds/built-in-results.ts`.
  `kinds/gatable.ts` answers whether a pipeline may ESTIMATE-GATE a step of a given kind
  (`isGatableKind`): a `BUILTIN_GATABLE_KINDS` set beside the `AgentKindRegistry.gatable()`
  override, the same shape as `kinds/read-only.ts` and `kinds/tuning.ts` — those catalogs still
  answer for a built-in that declares nothing, so setting the field to `false` on a registration
  SHADOWS them. A kind is NOT gatable by default; the set's comments say why
  each exclusion (`merger`, `deployer`, `conflicts`/`ci`, `bug-intake`) would break a run.
  `kinds/companions.ts` holds the COMPANION pairing vocabulary: a companion grades the
  immediately-preceding producer and loops it back for automatic rework below the step's
  threshold. Same shape as `gatable.ts`: a `COMPANIONS` built-in catalog beside
  `AgentKindRegistry.registerCompanion`, with registry-aware free lookups (`isCompanionKind`,
  `companionTargets`, `companionFor`, `isContainerBackedCompanion`) that take the registry
  OPTIONALLY and fall back to the built-ins. ⚠️ Optional means a site that omits the registry
  sees built-ins ONLY, so every engine site that could meet a deployment's own pair threads it;
  the pairing is also registered SEPARATELY from the kind, so a projection reading a kind's own
  definition (the snapshot's `customAgentKinds`) must ask the registry instead.
  `kinds/capabilities.ts` holds the agent-CAPABILITY declaration vocabulary: the skill and
  tool-server (MCP) refs a kind declares, plus the pure normalisers `AgentKindRegistry` resolves
  them with (`skillsFor` / `toolServersFor`). `prompts/capabilities.ts` renders the tool-server
  prompt section (available servers + the ones this run could NOT wire). See ADR 0029.
  `catalog.ts` exports `baseSystemPromptFor` (the SHIPPED track prompt) beside `systemPromptFor`
  (that prompt plus the engine-enforced surface directives and trait guidance). The split is what
  a per-workspace **prompt override** replaces: an override supplies the base and the directives
  are re-applied on top, so a workspace cannot edit away the read-only guardrail or the
  answer-in-your-reply rule. `systemPromptFor`'s third argument is that override; the dispatch
  side of the seam lives in `@cat-factory/server`'s `agents/promptOverrides.ts`. It also appends
  `PLATFORM_IS_NOT_THE_PRODUCT` UNCONDITIONALLY (every kind can see the orchestrator's own
  mechanics, and a task with no product context of its own leaves the platform's name as the most
  salient subject in the prompt), after the override, so it cannot be edited away.
  `kinds/variants.ts` holds agent-kind VARIANTS: an alternate prompt for an EXISTING kind, which
  a pipeline step selects through `stepOptions.agentVariantId`. A variant is NOT a kind (it never
  appears in `all()`, never answers `get()`), because a kind id is what every un-migrated
  `switch(agentKind)` keys off; a varied step records the BASE kind, so only the prompt changes.
  `applyAgentVariant` is the pure composition the ENGINE runs once per dispatch, folding the
  variant onto the workspace's own override and emitting the result through the SAME
  `AgentRunContext.systemPromptOverride` seam, which is why no executor branches on variants. It
  returns what the variant CONTRIBUTED (`applied` + a `fingerprint` of that text) beside the
  prompt, because the workspace wins on the same text: the engine pins that on the step, and every
  reader that reports or keys on a varied step reads the pin rather than the selection.
  `prompts/bespoke.ts` holds `BespokeSystemPrompt`, the `{ role, directives }` split used by the
  prompts that never reach `systemPromptFor`; `prompts/bespoke-kinds.ts` holds the two bespoke
  CONTAINER prompts (`merger`, `on-call`, moved here from the server layer), the
  `BESPOKE_SYSTEM_PROMPTS` map collecting every bespoke-prompt kind, and `shippedBasePromptFor`,
  the ONE answer to "the shipped base prompt this kind runs under", which a workspace override and
  a variant each replace and the prompt editor shows as the baseline. It lives below the HTTP
  layer because the engine needs the same answer: for a bespoke kind that base is the ROLE half,
  so resolving it anywhere else would fold a variant's addition onto text the kind never sends; `prompts/inline-engine.ts` maps the INLINE ENGINE
  kinds (the requirements + clarity reviewers, both brainstorm stages, their rework editors and the
  Requirement Writer) to theirs, which is what lets `IterativeReviewService` honour an override and
  the prompt editor show the text that actually runs.
  `prompts/standard.ts`'s `ownServiceSection` names the service a step's work belongs to and STATES
  an unresolved one, since an omitted product is indistinguishable from an obvious one. Its sibling
  `customTaskTypeSection` renders the per-case PARAMETERS a custom-typed task was invoked with (a
  REUSABLE OPERATION's brief), and has THREE emit points, not one: `renderStandardUserPrompt`, the
  generic branch of `buildBaseUserPrompt`, and the prepend a registered kind that authors its own
  user prompt gets. A new prompt-assembly site owes it the same emit, or an operation's parameters
  silently vanish for that path. See `backend/docs/reusable-operations.md`.
- `providers/`, the **AI provisioning facade**: `registry.ts` (`CompositeModelProvider`),
  `resolvers.ts` (the runtime-neutral single-provider resolvers), `endpoints.ts`
  (`providerEndpoints`, the base-URL/key source of truth, also used by the LLM proxy), and
  `instrumented.ts` (`InstrumentedModelProvider`, the INLINE feeder). It has TWO exits and
  takes EXACTLY ONE per call: the kernel `InlineLlmCallRecorder` port, which persists the call
  to `llm_call_metrics` AND (inside the service behind it) fans out to the trace sink; or the
  direct `traceSink` emit, for a call carrying no `workspaceId` (the store is workspace-scoped)
  and for a deployment with a sink but no metric store. Taking both would double every
  inline generation on Langfuse/OTel. A wrap with neither exit throws at construction.
  Neither exit is wired by hand: the server layer's `createInlineInstrumentation` composes both
  from ONE sink instance, since handing the two halves DIFFERENT sinks typechecks and merely
  splits the trace. Nor is its POSITION: a middleware only sees the model the wrap beneath it
  returned, so composing it under a facade wrap that SUBSTITUTES the model (local mode's
  subscription-inline harness) makes every call that wrap serves invisible while every other
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
  optional, because an absent gate is an OPEN gate, which is how an opted-out workspace's
  inline prompts reached Langfuse/OTel for months. A call taken by the RECORDER is gated by the
  same rule inside the service instead, so bodies reach it ungated, and as THUNKS, so the far
  side's gate costs a prompts-off deployment nothing. Any new inline call site must tag its
  `workspaceId` via `catFactoryObservability`, or no opt-out can apply to it AND it records no
  metric row. The attribution precedence itself is kernel's `resolveInlineAttribution`, shared
  with the second producer below.
  Finally, `cli-inline.ts` (`CliInlineLanguageModel`, the model a HARNESS CLI serves) is the one
  model the middleware deliberately does NOT wrap. One `doGenerate` there is a whole CLI tool loop,
  so it takes the facade's recorder itself and files each call the CLI reports, live, then declares
  `reportsOwnLlmCalls` so the middleware returns it untouched; two producers for one call would
  double every token of the step. Left to the middleware it would be one lumped row per step,
  written only once the subprocess exited, and zeroed whenever the run was killed (a rejection
  carries no usage). Alongside the per-call rows it files ONE step-level row for the SHORTFALL (the
  terminal cumulative usage minus what those rows accounted for), so a CLI that narrates nothing
  (`codex exec`) still gets the single row the SDK boundary knows, a fully-narrated step gets none,
  and a part-narrated one gets the remainder instead of under-reporting in silence. A turn the CLI
  costed at nothing is not filed at all (that rule lives here, so it holds for the host CLI's stream
  and a container job's terminal metrics alike), and a failed run gets a zero-token row at the next
  ordinal for the call that never completed. Each row names the model the CLI says SERVED it, since
  cost is derived per row. The model is ASKED rather than a facade told, because the instrumentation
  sits OUTSIDE the wrap that substitutes it and cannot see what that wrap returned. It also tells its
  runner whether bodies are worth assembling (`reportBodies`): a harness CLI's are RECONSTRUCTED, so
  a prompts-off deployment must refuse them at the source rather than via the usual thunk.
- `fragmentLibrary/`: the prompt-fragment library plumbing. The repo-source engine both
  libraries share lives in `repoSourceSync/`, including
  `tier-installation-resolver.ts` (`createTierInstallationResolvers`), the ONE
  implementation of "which GitHub installation reads this tier's repos" both runtime facades
  wire for fragments AND skills. The account tier resolves through the account's boards, not
  the installation row's `accountId` (null for a PAT connect, a GitHub id for local mode's
  synthetic rows).
- `skillLibrary/`: the repo-sourced Claude Skills catalog + sync (ADR 0024) and
  `SkillRunResolver`, which resolves ONE catalog skill (instructions + resource bodies at its
  pinned commit) for a dispatch. A BUNDLED skill needs none of this: it is deployment code,
  registered on `AgentKindRegistry.registerSkill`.
- `foundationalServices/`: the shared-capability catalog an Architect designs against
  (`backend/docs/adr/0031-foundational-services.md`). `FoundationalServiceCatalogService` owns the
  three-tier merge (the deployment's code-registered kernel `FoundationalServiceRegistry` under
  the account and workspace rows) and the manifest/document SPLIT (a catalog read never loads a
  contract body);
  `FoundationalServiceSourceService` reuses the same `repoSourceSync/` engine the two libraries
  above do, supplying only what a UNIT is: a service DIRECTORY, a whole contract FOLDER
  (`folder-scan.ts`, optionally recursive) for one named service, or an explicit FILE list for one
  named service; `FoundationalServiceRunResolver` is the engine-facing seam that turns them into
  injected `.cat-context/` files. Its third read serves BINARY-OUTPUT steps
  (`docs/initiatives/binary-output-foundational-storage.md`): a kind carrying the
  `binary-output` trait gets `binary-output/brief.md` + contract files for the storage/context
  services its step selected (`stepOptions.binaryOutput`), plus one per GENERATIVE INTEGRATION it
  selected from the deployment's `BinaryGeneratorRegistry` (kernel). The brief leads with what
  MAKES the artifacts (each integration's content types, endpoint, contract and credential
  VARIABLE), because that is the decision an agent cannot recover from later.
- `repo-ops/`: the checkout-free `RepoFiles` renderers for custom-agent artifacts, plus the
  built-in post-ops (`builtin.ts`: `blueprintPostOp`, `specPostOp`, and `specPromotionPostOp`,
  the tester-driven `aspirational` → `established` promotion of the in-repo spec) and
  `readServiceSpec.ts`, the checkout-free reassembly of the sharded `spec/` tree (read by the
  SPA's service-spec view in `@cat-factory/server`, the promotion post-op, and the PR
  verification report's requirement → evidence join in orchestration; hence it lives here,
  below all three).
- `presets/`: built-in initiative-preset pilots. `docs-refresh/docs-detect.logic.ts` is the
  deterministic, checkout-free repo probe (`detectDocsLayout`) behind the docs-refresh preset's
  form prefill (see `docs/initiatives/initiative-presets-and-docs-refresh.md`).
  `tech-migration/` holds the technological-migration preset's pieces: `phases.ts` (the canonical
  `MIGRATION_PHASE_IDS` contract shared by the template / prompt pack / plan post-processor / E2E)
  and `prompt-additions.ts` (`MIGRATION_PROMPT_ADDITIONS`, the per-planning-kind methodology
  steering the registration spreads onto its `promptAdditions`; see
  `docs/initiatives/tech-migration-preset-and-mssql-postgres-pilot.md`).

**See also:** `CLAUDE.md` → "Custom agents", "Conventions" (the `FINAL_ANSWER_IN_REPLY` rule);
`backend/docs/custom-agent-roles.md` (authoring a registered kind's prompt / skills / tool
servers on these seams); `backend/docs/model-support.md`.
