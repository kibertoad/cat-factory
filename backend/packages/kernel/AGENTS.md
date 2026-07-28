# `@cat-factory/kernel` — shared vocabulary + ports

The dependency **leaf** of the domain (depends only on `@cat-factory/contracts`). Everything
else imports its **ports** and domain types from here.

**Entry:** `src/index.ts`.

**Where things live:**

- `ports/` — **all ~84 repository/port interfaces**: the hexagonal seam every runtime facade
  implements. Adding a persisted table or a gateway starts with a port here (then a D1 repo +
  a Drizzle repo — see "Keep the runtimes symmetric"). `ports/repo-files.ts`'s `RunRepoContext`
  carries the run repo's provider-neutral identity (`repoId` + `provider`) alongside the bound
  `RepoFiles`, so a caller that resolved a run's repo can RECORD which repo it was and later
  correlate an inbound webhook — which names a repository by exactly that id.
- `domain/` — domain types (`types.ts`, re-exporting contracts), pure logic + constants
  (`seed.ts`, `catalog.ts`, `models.ts`, `subtasks.logic.ts`, `change-class.ts` — the
  deterministic changed-file → change-class classifier + its risk ranking and the per-class
  merge-rule resolution), and the **public extension
  registries**: `gate-registry.ts` + `gate-logic.ts`, `judge-registry.ts` + `judge-logic.ts`,
  `pipeline-registry.ts`, `provider-registry.ts`, `vcs-registry.ts`, `step-resolver-registry.ts`,
  `service-registration.ts`. The `registerGate`/`registerPipeline`/`registerAgentKind`/
  `registerVcsProvider` seams live here — a gate/agent package never depends on orchestration.
  `judge-registry.ts` is the FOURTH step-taxonomy bucket (an LLM verdict against a rubric vs a
  per-task threshold → advance / park / bounce / fail); its pure disposition rules are
  `judge-logic.ts` (`disposeJudgeVerdict` / `renderJudgeRework`). See CLAUDE.md → "Gates vs
  agents" and `docs/initiatives/judge-registry.md`.
- `ports/tracker-webhook.ts` — the INBOUND tracker seam: the neutral `TrackerWebhookEvent`
  (`issue` | `comment`, keyed `(source, externalId)`) plus the optional
  `TaskSourceProvider.webhook` capability a provider implements to verify + parse its vendor's
  deliveries. Its dedup marker port is `ports/tracker-comment-ingest-repositories.ts` — the
  `review_question_posts` claim shape, applied to the other direction of the same loop. See
  CLAUDE.md → "Inbound tracker webhooks".
- `domain/mount-layout.ts` — `applyMountLayout`, the projection that puts a service frame where
  THIS board mounts it. A frame's position (and any size override) lives on the `WorkspaceMount`,
  never on the shared block, so the block row's own coordinates are frozen at creation. Both the
  board snapshot (`WorkspaceService.composeBoard`) and every frame-returning `BoardService`
  mutation project through it — a response that skips it hands the SPA coordinates no board shows
  the frame at, and the SPA upserts them.
- `domain/llm-phase.ts` — `normalizeCallPhase` + `UNATTRIBUTED_CALL_PHASE`, the boundary for the
  **phase axis** on `llm_call_metrics` (which slice of a run spent a model call). The label is
  free-form and comes from producers the platform does not fully author (a proxy request path, a
  runner pool's JSON), so every path normalises here before it becomes a grouping key; an
  unrecognisable one becomes the unattributed `''` slice rather than a group of its own. See
  `docs/initiatives/token-burn-instrumentation.md`.
- `domain/pr-report.ts` — the marker-delimited `spliceManagedSection` / `readManagedSection`
  behind the engine's **PR verification report** (the pure half; the `PrVerificationReportPublisher`
  port is in `ports/pr-report.ts`, the composer in orchestration).
- `shared/host-markdown.logic.ts` — the **host text boundary** (`hostMarkdown.inline` / `cell` /
  `prose` / `balanceFences` / `capList`): the one place untrusted, mostly model-authored text is
  made safe to send to a VCS/tracker host. It defuses the auto-link triggers that would otherwise
  notify a real account, cross-link an unrelated issue, or close one on merge, and balances code
  fences. It lives in kernel because BOTH the PR verification report (orchestration) and the
  tracker-issue writebacks (integrations) render through it — a second copy is how one of them
  drifts into paging a stranger. Anything host-bound picks one of the three renderers; never a
  bare template hole.
- `ports/logging.ts` — the **`Logger` port**: `debug`/`info`/`warn`/`error` (`(msg, fields?)`)
  plus `child(bound)`, with `noopLogger` and the test-facing `createRecordingLogger`. Injected
  like `Clock`/`IdGenerator`, which is what lets the whole domain engine log without depending on
  a runtime facade; `@cat-factory/server` adapts pino onto it. Its companion is
  `shared/best-effort.ts` (`runBestEffort` / `describeError`), the convention that replaces
  `.catch(() => {})` — keep the swallow, add one scrubbed `warn`. See
  [`backend/docs/logging.md`](../../docs/logging.md).
- `shared/` — `*.logic.ts` pure helpers, incl. the checkout-free repo-scan primitives
  (`repo-scan.logic.ts` — `BudgetedRepoScanner`) and the **manifest-probe** toolkit for
  custom-provider autodetection (`manifest-probe.logic.ts` — `matchManifestSignature`,
  `firstPresent`/`allPresent`, `readYamlDoc`, `listFiles`, + the `CustomManifestDetection` /
  `CustomManifestDetectionContext` authoring types).

**See also:** `CLAUDE.md` → "Gates vs agents (the step taxonomy)", "Custom agents",
"Merge track record", "Logging goes through the kernel `Logger` port".
