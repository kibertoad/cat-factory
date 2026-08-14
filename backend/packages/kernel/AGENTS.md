# `@cat-factory/kernel`: shared vocabulary + ports

The dependency **leaf** of the domain (depends only on `@cat-factory/contracts`). Everything
else imports its **ports** and domain types from here.

**Entry:** `src/index.ts`.

**Where things live:**

- `ports/` holds **all ~84 repository/port interfaces**: the hexagonal seam every runtime facade
  implements. Adding a persisted table or a gateway starts with a port here (then a D1 repo +
  a Drizzle repo; see "Keep the runtimes symmetric"). `ports/repo-files.ts`'s `RunRepoContext`
  carries the run repo's provider-neutral identity (`repoId` + `provider`) alongside the bound
  `RepoFiles`, so a caller that resolved a run's repo can RECORD which repo it was and later
  correlate an inbound webhook, which names a repository by exactly that id.
- `domain/`: domain types (`types.ts`, re-exporting contracts), pure logic + constants
  (`seed.ts`, `catalog.ts`, `models.ts` + its data half `model-catalog.ts` — the
  `MODEL_CATALOG` entries live there and are re-exported from `models.ts`, so add a model in
  the first and a resolution RULE in the second, `subtasks.logic.ts`, `change-class.ts`, the
  deterministic changed-file → change-class classifier + its risk ranking; what a preset then DOES
  with a class lives in `@cat-factory/contracts` beside the rule maps, because the SPA has to
  reach the same verdict), and the **public extension
  registries**: `gate-registry.ts` + `gate-logic.ts`, `judge-registry.ts` + `judge-logic.ts`,
  `pipeline-registry.ts`, `provider-registry.ts`, `vcs-registry.ts`, `step-resolver-registry.ts`,
  `foundational-service-registry.ts` (the shared capabilities a DEPLOYMENT declares in code: the
  `builtin` tier of the foundational-services catalog, projected through `summarizeContract` and
  validated at boot; ADR 0031), `binary-generator-registry.ts` + `binary-generators.ts` (the
  GENERATIVE binary integrations a deployment declares in code: an image / music / video API a
  `binary-output` step selects to PRODUCE its artifacts, with the pure selection validation and
  agent-facing rendering beside it; deliberately NOT the foundational catalog, which is what a
  DESIGN consumes) plus `binary-generator-registration.ts` (what a registered definition must
  satisfy beyond its parse, with TWO callers: the boot validator, and the authoring seam in
  `@cat-factory/binary-generators` that runs the same rules at import so a bad definition fails a
  test rather than a deploy), `binary-store-registry.ts` (the binary artifact STORES a deployment defines in
  code: its own `BinaryBlobBackend` implementations, offered per account beside the platform's own
  backends; per-process rather than port-read, because a store is a live client only the process
  writing the bytes can build), `service-registration.ts`. Two of those registries are also READ through a
  port, because a mothership deployment is two processes and what a deployment registers in code
  is org state its node's build can only hold a stale copy of: `ports/foundational-builtins.ts`
  and `ports/binary-generators.ts`, each defaulting to the in-process registry and pointed at the
  mothership on a node. The `registerGate`/`registerPipeline`/`registerAgentKind`/
  `registerVcsProvider` seams live here: a gate/agent package never depends on orchestration.
  `judge-registry.ts` is the FOURTH step-taxonomy bucket (an LLM verdict against a rubric vs a
  per-task threshold → advance / park / bounce / fail); its pure disposition rules are
  `judge-logic.ts` (`disposeJudgeVerdict` / `renderJudgeRework`). See CLAUDE.md → "Gates vs
  agents" and `docs/initiatives/judge-registry.md`. Its COMPANION sibling is
  `companion-logic.ts` (`disposeCompanionVerdict`, `companionParkReasonFor`, `CompanionParkReason`):
  the same shape of decision from a rework pair's inputs, where a `blocker` finding holds the step
  whatever the rating, and where the park REASON is what decides whether an unattended policy may
  answer it.
- `ports/tracker-webhook.ts` is the INBOUND tracker seam: the neutral `TrackerWebhookEvent`
  (`issue` | `comment`, keyed `(source, externalId)`) plus the optional
  `TaskSourceProvider.webhook` capability a provider implements to verify + parse its vendor's
  deliveries. Its dedup marker port is `ports/tracker-comment-ingest-repositories.ts`, the
  `review_question_posts` claim shape, applied to the other direction of the same loop. See
  CLAUDE.md → "Inbound tracker webhooks".
- `domain/mount-layout.ts`: `applyMountLayout`, the projection that puts a service frame where
  THIS board mounts it. A frame's position (and any size override) lives on the `WorkspaceMount`,
  never on the shared block, so the block row's own coordinates are frozen at creation. Both the
  board snapshot (`WorkspaceService.composeBoard`) and every frame-returning `BoardService`
  mutation project through it; a response that skips it hands the SPA coordinates no board shows
  the frame at, and the SPA upserts them.
- `domain/task-type-registry.ts` + `domain/task-type-context.ts`: the two halves of the CUSTOM
  TASK TYPE seam. The registry is what a deployment registers its namespaced types on (the
  vehicle for a REUSABLE OPERATION: a per-case form, its standing-context `defaultFragmentIds`
  and its canned `defaultPipelineId`); `describeCustomTaskType` is the run-time projection that
  joins a block's collected `taskTypeFields.custom` bag with that descriptor's labels for the
  prompt. The join is VALUE-AUTHORITATIVE on purpose: descriptor and row drift by construction (a
  node one build behind, a withdrawn type), so an undeclared key renders under its raw key rather
  than being dropped. It stops at a NAMESPACED id, though: a built-in carrying a `custom` bag is a
  malformed row rather than drift, and the raw-id fallback would head a section over keys nothing
  declared, inventing an operation instead of naming a withdrawn one. The per-workspace hide-list is
  the seam's one DATA half (`ports/task-type-repositories.ts`, tombstones), which is also why it is
  the only part of this feature that goes `remote` in mothership mode.
  See `backend/docs/reusable-operations.md`.
- `domain/prompt-fragment-registry.ts` + `ports/prompt-fragments.ts`: the app-owned
  `PromptFragmentRegistry` (a deployment's best-practice standards and the per-task-type default
  SETS that select them) and the `PromptFragmentSource` that decides where the pool is READ from.
  `defaultPromptFragmentRegistry()` is EMPTY; the shipped catalog installs onto one through the
  same public methods a deployment uses (`@cat-factory/prompt-fragments`'
  `promptFragmentRegistryWithBuiltins()`), the `defaultGateRegistry()` ⇄ `@cat-factory/gates` shape.
  It replaced two MODULE GLOBALS whose correctness depended on every reader resolving the same
  physical copy of that package, which a published dependency graph does not guarantee. The source
  is the third `/internal/*` read of the mothership family beside `FoundationalBuiltinSource` and
  `BinaryGeneratorSource`, and it THROWS rather than answering an empty pool for the reason they do.
- `ports/secret-delegation.ts`: `OrgSecretSource` (a CLOSED vocabulary of org-owned sealed rows),
  `SecretDelegate` and `createOrgSecretCipher`: the seam every service holding one of those rows
  composes with its own `SecretCipher`. With no delegate (every hosted deployment) it is a
  pass-through; on a mothership-mode node it routes BOTH directions to the mothership, which holds
  the key. Deliberately NOT a `SecretCipher` decorator: an envelope alone carries no claim about
  who may open it, so the delegated call addresses a ROW and the mothership re-reads it under the
  node's account scope. The server binds each member to one repository read in
  `SEALED_SECRET_SOURCES`; a member with no binding fails to compile.
- `domain/llm-phase.ts`: `normalizeCallPhase` + `UNATTRIBUTED_CALL_PHASE`, the boundary for the
  **phase axis** on `llm_call_metrics` (which slice of a run spent a model call). The label is
  free-form and comes from producers the platform does not fully author (a proxy request path, a
  runner pool's JSON), so every path normalises here before it becomes a grouping key; an
  unrecognisable one becomes the unattributed `''` slice rather than a group of its own. See
  `docs/initiatives/token-burn-instrumentation.md`.
- `domain/llm-rollup.ts`: `foldRollupTotals` / `foldRollupsByAgentKind` / `foldRollupsByPhase`,
  the folds over the telemetry stores' ONE `(agentKind, phase)` aggregate. The store computes the
  finest grain and every coarser view (a step's per-kind rollup, the run's per-phase burn
  breakdown, the run totals) is derived here, so the numbers on a surface can't disagree with the
  totals beside them. A new consumer folds; it does not add a second `GROUP BY` on the emit path.
- `domain/spend-rollup-window.ts`: how much of the ledger one fold of the durable spend rollup
  (`spend_days`) covers, for the sweep's periodic pass (`spendRollupWindow`) and for the FINAL
  pass a board takes inside its own delete (`finalSpendFoldPlan`). Here rather than beside the
  sweep because those two callers sit in different layers and must agree that the catch-up
  horizon is the LEDGER's retention; the delete's plan differs in having no next pass to leave a
  remainder to, so the span cap becomes a chunk size, and in running inside a request rather than
  a cron, so its chunks are ordered NEWEST FIRST against `FINAL_SPEND_FOLD_BUDGET_MS`. See
  `backend/docs/storage-and-retention.md` §1c.
- `domain/infra-reachability.ts`: the pure decision behind the **infrastructure-reachability
  watcher**: `decideReachability` (what to record + which transitions to announce, from this pass's
  probes and the set the open `infra_unreachable` card recorded), `recordedUnreachableAreas`, and
  `applyInfraReachability`; a fold over contracts' `applyInfraSetupTransition`, which is the ONE
  rule both this snapshot fold and the SPA's live event patch obey about which prior state a probe
  verdict may overwrite. Four probe verdicts, because they need four dispositions: an outage, a
  recovery, an `indeterminate` we could not ask about (leave the record alone) and a
  `not_configured` area that is simply gone (forget the record, announce nothing).
- `domain/context-references.ts`: the **"a referenced context document reaches the agent whole, or
  the run breaks loudly naming it"** invariant: the two refusals
  (`assertContextDocumentsReadable` / `assertContextReferencesFit`) with their `details.reason`
  codes, plus the two readability tests a caller picks between; `hasReadableContent` where the RAW
  body is delivered to a checkout, `contextExcerptFor` where an inline caller renders only a short
  excerpt (a body that is pure markup passes the first and projects to nothing under the second, so
  asserting over the body and rendering the excerpt re-opens the hole one field narrower). Shared
  because the reference can vanish in two different layers (the engine's `resolveLinkedContext`
  and the container's `buildContextFiles`) and both must refuse in the same words. See
  `backend/docs/document-sources.md`.
- `domain/input-gate.ts`: the **pre-dispatch input gate**'s pure check (`evaluateInputGate` plus the
  one `inputGateInputOf` block mapping the three evaluation sites share). Fields in, findings out,
  no I/O. `describesAuthoredTaskInput` is the `not_applicable` rule: only a `level: 'task'` block
  that is not a platform-authored TYPE carries a description the gate may judge, so a run against a
  frame, module, epic or initiative ANCHOR is never parked on a caption.
- `domain/pr-report.ts`: the marker-delimited `spliceManagedSection` / `readManagedSection`
  behind the engine's **PR verification report** (the pure half; the `PrVerificationReportPublisher`
  port is in `ports/pr-report.ts`, the composer in orchestration).
- `domain/validation-detection.ts` + `domain/validation-detectors.ts`: the pure half of **pre-PR
  validation AUTODETECTION**: the first composes a repo-root surface into ordered, uniquely
  labelled suggestions; the second is one detector function per ecosystem (node/python/go/rust/
  maven/gradle/dotnet/ruby/php/elixir, plus make/just/task as a fallback tier). Reading the
  surface is `detectValidationChecksFromRepo` in integrations. Adding an ecosystem is a new
  detector plus a `ValidationEcosystem` member in contracts.
- `shared/host-markdown.logic.ts`: the **host text boundary** (`hostMarkdown.inline` / `cell` /
  `prose` / `balanceFences` / `capList`): the one place untrusted, mostly model-authored text is
  made safe to send to a VCS/tracker host. It defuses the auto-link triggers that would otherwise
  notify a real account, cross-link an unrelated issue, or close one on merge, and balances code
  fences. It lives in kernel because BOTH the PR verification report (orchestration) and the
  tracker-issue writebacks (integrations) render through it: a second copy is how one of them
  drifts into paging a stranger. Anything host-bound picks one of the three renderers; never a
  bare template hole.
- `shared/process-exit.logic.ts`: **`describeProcessExit(code, signal)`**, the one sentence every
  transport that reports a dead subprocess renders its failure with. It encodes an operational
  distinction, not formatting: a `null` exit code means a SIGNAL killed the process, and telling
  that apart from the process's own non-zero exit is the first fork in the road between "the CLI
  gave up" and "something killed the container"; rendering the `null` verbatim produces "exited
  with code null", which reads as neither. A new process-reporting transport (a pooled runner, a
  K8s pod, a native host process) renders through this rather than re-deriving it. `signal` is a
  plain `string` because kernel compiles without Node's ambient types. The executor-harness carries
  a pinned COPY (`src/process-exit.ts`, it can depend on no workspace package), held equal by
  `test/process-exit.conformity.test.ts`: the same arrangement as `host-markdown`.
- `shared/post-mortem.logic.ts`: **`composePostMortem(parts)`**, the other half of the same job.
  A transport that finds its backend gone gets ONE chance to say why (`RunnerJobView.detail`,
  which the engine keeps as the step's `firstEvictionDetail`), and every producer of that text
  owes the same two things: a `redactSecrets` pass, because the material is a container's own
  output, and a cap, because it is a diagnostic rather than a log sink. Both live here so a new
  transport inherits them. The cap keeps the HEAD, so a caller puts its one-line verdict first
  and bulk material after it; everything empty answers `undefined`, which the eviction view omits
  the field for rather than rendering "nothing could be read" as an empty tail. Bulk material is
  bounded by the caller with **`tailPostMortemMaterial`**, which keeps the TAIL, and the opposite
  directions are the point: a log's value is at its end, so letting one reach the head-keeping cap
  unbounded keeps the boot chatter and drops the crash. A LINE bound (`--tail 50`, a stderr ring)
  does not count as bounded.
- `ports/sso.ts`: the shape of a DISCOVERED enterprise identity provider
  (`OidcProviderMetadata` / `SsoDiscoveryDocument`, the value `AppCaches.ssoDiscovery` holds) plus
  **`oidcIdentitySubject`**, the one place the `<issuer>#<sub>` identity key is spelled. The issuer
  half is not optional: an OIDC `sub` is unique per issuer only, so `sub` alone would let two
  directories collide on one `user_identities` row. `@cat-factory/server`'s `auth/oidc/` owns the
  fetch that fills the document.
- `ports/logging.ts`: the **`Logger` port**: `debug`/`info`/`warn`/`error` (`(msg, fields?)`)
  plus `child(bound)`, with `noopLogger` and the test-facing `createRecordingLogger`. Injected
  like `Clock`/`IdGenerator`, which is what lets the whole domain engine log without depending on
  a runtime facade; `@cat-factory/server` adapts pino onto it. Its companion is
  `shared/best-effort.ts` (`runBestEffort` / `describeError`), the convention that replaces
  `.catch(() => {})`: keep the swallow, add one scrubbed `warn`. See
  [`backend/docs/logging.md`](../../docs/logging.md).
- `shared/error-chain.logic.ts`: **`errorChainText` / `flattenErrorChain`**, how a THROWN VALUE
  becomes text for every reader in the repo. It walks `.cause` and each `AggregateError` branch
  (bounded by depth and by link IDENTITY, so a cause cycle terminates), folds links that render
  identically into an `(xN)` count rather than dropping one, scrubs through `redactSecrets` and caps
  the result SAYING what it dropped. The three describers that read it are `getErrorMessage`
  (`domain/errors.ts`, what a human is shown), `describeError` (`shared/best-effort.ts`, log fields)
  and `describeConnectionFailure` (below, which adds a cause class and remedy). They were three
  answers to one question before this existed, two of them stopping at `error.message`: that is why
  a probe named `connect ECONNREFUSED` while the log line for the SAME failure said `fetch failed`.
  The one asymmetry that stays: this KEEPS undici's contentless outer link, because a log line and a
  `DispatchError` message are matched downstream by their opening phrase, while a probe's verdict
  drops it to lead with the real cause. Full model: [`backend/docs/logging.md`](../../docs/logging.md).
- `shared/connection-failure.logic.ts`: **`describeConnectionFailure` / `connectionFailureResult`**,
  what every "Test connection" button reports when the probe got no ANSWER at all. On Node/undici a
  transport failure arrives as a generic `TypeError: fetch failed` with the real cause on `.cause`
  (or on an `AggregateError`'s `.errors`, one per resolved address), so reading `error.message`
  renders the single least informative string in the chain: a stopped cluster, an untrusted
  certificate and a firewalled host all read as `fetch failed`. This flattens the chain and adds a
  remedy per recognised cause. It lives in kernel for the same reason `domain/vcs-errors.ts` does:
  the probes are spread across integrations and each facade, which share only kernel; the cause
  UNION lives in contracts, because the SPA owns the translated copy per member. A probe returns
  `connectionFailureResult`, which carries that cause on the wire beside the English prose, rather
  than a hand-built `{ ok: false, message }` a localized surface cannot render. `unknown` is a real
  member, and it yields NO hint: a guessed remedy for an unrecognised failure sends the operator
  somewhere wrong. Classification walks the chain INNERMOST-first, because the outer links are
  generic wrappers whose own codes would mask the specific cause underneath. **`connectionFailureHint`**
  is the same per-cause remedy for a cause the CALLER classified, and it exists for the one thing the
  walk cannot see: a client that already converted its own deadline into a typed error whose abort
  marker is NAMED `AbortError` (the SDK's `CatFactoryTimeoutError`), which the walk therefore reads as
  a cancelled request. The caller supplies the class; the sentence stays this module's, because a copy
  written at that call site is one release behind by construction.
- `shared/initiator-pat-gate.ts`: **`createInitiatorPatGate`**, the two-tier `allowInitiatorPat`
  policy: may a RUN authenticate as its initiator's own personal access token instead of the
  deployment credential? Effective = the ACCOUNT permits AND the WORKSPACE permits, and the tiers
  are not redundant: the workspace switch is edited with `settings.manage`, which a member
  elevated on one board holds, so only the account tier binds the case the control exists for.
  Both defaults are permissive, deliberately: a personal token is the right credential for someone
  adopting cat-factory alone inside an org that has not. The sibling of
  `shared/agent-context-gate.ts`, and for the same reason: the rule is asked from three mint
  sites, and three copies are three chances to miss an opt-out. It does NOT catch: the caller
  (`createResolveRunInitiatorToken` in `@cat-factory/server`) fails closed, because an unreadable
  policy is not permission to widen a run's credential. See
  [`backend/docs/security-model.md`](../../docs/security-model.md).
- `domain/errors.ts`: the **`DomainError` hierarchy**, the whole vocabulary a service may raise
  toward the wire: `NotFoundError` (404), `ValidationError` (422), `ConflictError` (409),
  `CredentialRequiredError` (428), `ForbiddenError` (403), `UnauthorizedError` (401),
  `UnavailableError` (503), `RateLimitedError` (429). Every one can carry `details.reason`, the
  machine-readable code the SPA maps to translated copy (`getErrorReason` is the read side). A
  hand-built `c.json({ error: { code } }, status)` structurally cannot, which is why controllers
  raise these instead: see `@cat-factory/server`'s `http/guards.ts`.
- `shared/agent-context-gate.ts`: `createStoreAgentContextGate`, the per-workspace
  `storeAgentContext` half of the double gate governing prompt/response BODY capture. Shared by
  the proxied path (`LlmObservabilityService`) and the inline one (`InstrumentedModelProvider`)
  because those two DID diverge, and the inline half exported an opted-out workspace's bodies.
  A third consumer is the tool-call drain (`@cat-factory/server`'s `toolTrajectory.ts`), which
  gates a captured call's `args`/`result` the same way.
- `ports/platform-metrics.ts` + `ports/gate-outcomes.ts`: the deployment-level (operator)
  reads, and the ONE place in the observability family that deliberately lives in the MAIN store
  rather than the telemetry one. Both are account-scoped through the same `workspaces`
  sub-select every other platform rollup uses, which is what a telemetry-store home would have
  cost them (a cross-store join, or a workspace-id list threaded through every read).
  `platform-metrics.ts` also owns the DAILY ROLLUP the long dashboard windows read: its
  `dailyRollupWatermark` is a separate method, reading the coverage the SWEEP recorded rather
  than `max(day_start)` over the rows, and deployment-scoped rather than per account. An
  un-materialised rollup and an idle quarter return the same empty series, and a value derived
  from the rows cannot separate them in either direction (a quiet account looks like a lagging
  sweep; a new account looks like a rollup that never ran), so the number comes from the thing
  being asked about. `RUN_DAYS_ROLLUP` is the one key both facades write and read it under.
- `ports/llm-metrics.ts`: besides the store's own `LlmCallMetric` / `LlmCallMetricRepository`,
  `InlineLlmCallRecorder` is the seam the inline feeder writes through, so all three producers
  (proxy, subscription harness, inline) land in one table. Its `InlineLlmCall` is deliberately
  NARROWER than the row: it states only what a direct AI-SDK call can honestly report, and the
  adapter fills the proxy-shaped rest with not-applicable values rather than plausible ones.
  Its bodies are `InlineLlmCallBody` THUNKS: the recorder owns the body gate and the caller
  cannot see it, so handing over the work rather than the result is what lets a prompts-off
  deployment skip serialising a prompt that is about to be dropped.
- `shared/`: `*.logic.ts` pure helpers, incl. the checkout-free repo-scan primitives
  (`repo-scan.logic.ts`: `BudgetedRepoScanner`) and the **manifest-probe** toolkit for
  custom-provider autodetection (`manifest-probe.logic.ts`: `matchManifestSignature`,
  `firstPresent`/`allPresent`, `readYamlDoc`, `listFiles`, + the `CustomManifestDetection` /
  `CustomManifestDetectionContext` authoring types).

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)", "Custom agents",
"Merge track record", "Logging goes through the kernel `Logger` port".

**Mutation-tested** (`stryker.config.mjs`): nightly, non-blocking, never run locally. Scope and
score floor: [`mutation-testing.md`](../../../docs/internal/mutation-testing.md).
