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
  (`seed.ts`, `catalog.ts`, `models.ts`, `subtasks.logic.ts`, `change-class.ts`, the
  deterministic changed-file → change-class classifier + its risk ranking and the per-class
  merge-rule resolution), and the **public extension
  registries**: `gate-registry.ts` + `gate-logic.ts`, `judge-registry.ts` + `judge-logic.ts`,
  `pipeline-registry.ts`, `provider-registry.ts`, `vcs-registry.ts`, `step-resolver-registry.ts`,
  `foundational-service-registry.ts` (the shared capabilities a DEPLOYMENT declares in code: the
  `builtin` tier of the foundational-services catalog, projected through `summarizeContract` and
  validated at boot; ADR 0031), `binary-generator-registry.ts` + `binary-generators.ts` (the
  GENERATIVE binary integrations a deployment declares in code: an image / music / video API a
  `binary-output` step selects to PRODUCE its artifacts, with the pure selection validation and
  agent-facing rendering beside it; deliberately NOT the foundational catalog, which is what a
  DESIGN consumes), `service-registration.ts`. The `registerGate`/`registerPipeline`/`registerAgentKind`/
  `registerVcsProvider` seams live here: a gate/agent package never depends on orchestration.
  `judge-registry.ts` is the FOURTH step-taxonomy bucket (an LLM verdict against a rubric vs a
  per-task threshold → advance / park / bounce / fail); its pure disposition rules are
  `judge-logic.ts` (`disposeJudgeVerdict` / `renderJudgeRework`). See CLAUDE.md → "Gates vs
  agents" and `docs/initiatives/judge-registry.md`.
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
- `ports/logging.ts`: the **`Logger` port**: `debug`/`info`/`warn`/`error` (`(msg, fields?)`)
  plus `child(bound)`, with `noopLogger` and the test-facing `createRecordingLogger`. Injected
  like `Clock`/`IdGenerator`, which is what lets the whole domain engine log without depending on
  a runtime facade; `@cat-factory/server` adapts pino onto it. Its companion is
  `shared/best-effort.ts` (`runBestEffort` / `describeError`), the convention that replaces
  `.catch(() => {})`: keep the swallow, add one scrubbed `warn`. See
  [`backend/docs/logging.md`](../../docs/logging.md).
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
