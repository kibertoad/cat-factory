# Initiative: observability, logging & error-handling gap analysis

**Status:** analysis complete, no slices started · **Owner:** core · **Started:** 2026-07-28
**Audited at:** `main` @ `4b3bab4`. File:line references are against that commit and will drift;
the anchoring file + symbol names are kept current — search by symbol, not line.

> This is the durable source of truth for a multi-PR initiative. Read it first before picking up
> the next slice; update the checklist at the end of each PR.

## Goal & rationale

A systematic audit of where the platform is **blind**: failures that leave no log line, errors
that lose their machine-readable cause on the way to the user, telemetry that silently
under-reports, and operational states (dead deployment, wedged queue, mass re-drive) that no
signal distinguishes from healthy. The headline findings:

- **~113k LOC of business logic cannot log at all.** There is no logger port in the kernel, so
  `orchestration`, `integrations`, `agents` and `kernel` (together the entire domain engine) have
  no structural access to a logger. This *forces* the ~115 silent `.catch(() => {})` drops in
  those packages — the swallow is mandatory, not stylistic.
- **The deployed Cloudflare runtime discards `AgentFailure.reason` on every failure path**, so the
  SPA's machine-readable remedies (the "Connect GitHub" jump action, the deploy-runner hint) never
  fire in production — the whole `details.reason` pipeline built by the error-message-coverage
  initiative is unpopulated on one of the two runtimes.
- **No end-to-end trace and no correlation id exist.** The workflow logs `executionId`, the
  harness logs `jobId`, nothing logs both, and the dispatch/poll seam between them
  (`ContainerAgentExecutor`) logs nothing.
- **The most important operational signals have no metric**: stale-run re-drives, container
  evictions, queue depth, dropped telemetry batches, sweeper health. A totally dead deployment is
  indistinguishable from a quiet healthy one to `platform_health`.

## Relationship to existing trackers (do NOT restate their work)

Three initiatives already own adjacent ground; this doc records only what they do **not** cover
and cross-references where a fix belongs to them:

- [`error-message-coverage.md`](./error-message-coverage.md) — owns the *content* of error
  messages (remedies, doc URLs, structured cause codes). This doc owns whether the error is
  **logged/propagated at all** and whether the structured code **survives the trip**.
- [`stuck-run-audit.md`](./stuck-run-audit.md) — owns runs that wedge or get wrongly killed
  (F4/F6/F8/F9/F11–F13 still open). This doc owns the *visibility* of those events: whether a
  re-drive, an eviction, or a stall is countable and diagnosable after the fact.
- [`platform-operator-observability.md`](./platform-operator-observability.md) — owns the
  operator dashboard + `platform_health` alert (slices 4b/6/7 still open). This doc records the
  signals that projection structurally lacks.
- `docs/code-quality-observability-extensibility-review-2026-07.md` §7 independently flagged four
  of these gaps (no HTTP spans, no operational metrics, uncounted best-effort drops, no client
  error reporting); this doc turns them into an actionable plan.

## Findings

Severity: **P1** = operators/users are blind to a failure class that occurs routinely;
**P2** = plausible incident with no diagnosis path; **P3** = polish.

### A. Logging infrastructure

**A1 — No logger port in the kernel; the domain engine is silent by construction. (P1)**
`backend/packages/kernel/src/ports/` has ~90 port files and no logger. The only logger lives in
`@cat-factory/server` (`src/observability/logger.ts`, pino-over-console), which the domain
packages must not import. Consequence: `orchestration` (45k LOC), `integrations` (33k),
`agents` (15k) and `kernel` (20k) emit **zero** log lines. The one port-shaped logger that exists
is local and optional (`GitHubDocsProvider.ts:36-42`, `logger?: GitHubDocsLogger`), and several
services document the resulting hole outright —
[`pr-verification-report.md`](./pr-verification-report.md): "an unwired logger means a revoked
token or a rejected body leaves no trace anywhere". Raw `console.*` is *not* the problem (near
zero in non-test source); silence is.

**A2 — No request logging, no request/correlation id; every 4xx is invisible. (P1)**
No `app.use` in either facade is a logging middleware; no `requestId`/`x-request-id` exists
anywhere outside the LLM-span packages. `errorHandler.ts` logs **only unexpected 500s** (with
`{ method, path }` — no id, no duration, no status); `SchemaValidationError` (400) and every
`DomainError` (403/404/409/422/428) return with no server-side log line at all. There is no way
to tie a user report to a request, or a 4xx spike to a cause.

**A3 — No correlation across the durable execution path. (P1)**
`ExecutionWorkflow` logs `executionId`; the harness binds `jobId` (`runner.ts:382`) and never
receives `executionId` (zero hits in `executor-harness/src`); the id spaces are stitched only by
the `${executionId}-${agentKind}` naming convention (`ContainerAgentExecutor.ts:176-179`).
`ContainerAgentExecutor` — the workflow↔container seam — has **zero** logger calls.
`logger.child` has only ~9 real call sites backend-wide; `ExecutionWorkflow` passes ids inline
per-call instead of binding a child (`BootstrapWorkflow`/`EnvConfigRepairWorkflow` do it right).

**A4 — `LOG_LEVEL` is inert; no debug tier exists. (P2)**
`logger.ts:10` reads `(globalThis as { LOG_LEVEL?: string }).LOG_LEVEL ?? 'info'` — nothing ever
assigns it (not `process.env`, not a wrangler var, absent from `.env.example`). The harness logger
has no level filtering at all, and `logger.debug`/`log.debug` has **zero** call sites repo-wide,
so there is no verbose tier to turn on during an incident.

**A5 — Harness log fields bypass `redactSecrets`; the scrubber is triplicated. (P2)**
The harness scrubs *captured output* (`captured-command.ts:106`) but its logger emits every field
verbatim (`executor-harness/src/logger.ts` — no redaction), including spawn-failure `err.message`
and caller-supplied `logFields` for `sh -c` commands that can embed credentials
(`captured-command.ts:73,129-131`). Traces are scrubbed; logs are not. `redactSecrets` exists as
three independently drifting copies (kernel `shared/redact-secrets.logic.ts`, executor-harness
`redact.ts`, deploy-harness `redact.ts`) with only the harness copy conformity-pinned nowhere.

### B. Error handling

**B1 — ~115 `.catch(() => {})` sites swallow with no log, no metric, no marker. (P1)**
Zero literal empty `catch {}` blocks exist in non-test source, but silent promise-drop sites are
widespread (integrations 39, executor-harness 30, server 20, orchestration 20). The consequential
ones:

| Site | What vanishes |
| --- | --- |
| `ExecutionService.ts:1551` `autoStartDependents(...).catch(() => {})` | dependent tasks silently never start |
| `MergeTrackRecordService.ts:112,156,200,236` | all four track-record reads/writes; the class has **no logger dep at all** |
| `InitiativeLoopService.ts:142,186,291,312,428,604` | loop tick, tracker recommits, block deletion, notification raise |
| `PublicApiController.ts:246-247` | rollback of a half-created run → orphaned rows |
| `LlmProxyController.ts:637` `recordUsage(...).catch(() => {})` | usage/billing attribution lost |
| `DeployerStepController.ts:569,611` | leaked provisioning leases |
| `GitHubGateways.ts:25` `workflow.create(...).catch(() => {})` then `return true` | backfill reported scheduled when it wasn't |
| `RunDispatcher.ts:1681,1829`, `review-kinds.ts:302`, `ExecutionService.ts:1543` | every issue-writeback hook |

There is no `runBestEffort(fn, logger)` helper and nothing counts the drops. Blocked on A1 for
the domain packages.

**B2 — Half the wire error vocabulary can't carry `details.reason`. (P1)**
Only `not_found`/`validation`/`conflict`/`credential_required`/`forbidden` have `DomainError`
classes. `unavailable` (503), `unauthorized` (401), `rate_limited` (429) and `internal` exist only
as ~40 hand-rolled envelope literals (e.g. `ClarityReviewController.ts:24`,
`AuthController.ts:277`, `ApiKeyController.ts:29`), which structurally cannot carry the
machine-readable `details.reason` the SPA maps to translated copy. Two controllers emit
`code`-less envelopes that break the shape the SPA's `api/errors.ts:31` assumes:
`WebSearchProxyController.ts:43,52,85` and **12 sites** in `LlmProxyController.ts`. One genuine
internals leak: `LlmProxyController.ts:196` returns the raw upstream exception text on the wire
(502). `AuthController.ts:790` hand-maps a `ConflictError` and drops its `reason`.

**B3 — `AgentFailure.reason` is dropped by the Cloudflare driver on every path. (P1)**
`ExecutionWorkflow.ts`'s local `failRun` helper omits `reason` from its signature, so `:232`
discards `result.reason` even though the runtime-neutral `drive.ts:192-197` forwards it. The
advance-throw path drops it on **both** runtimes (`drive.ts:131` doesn't call `getErrorReason`;
kernel ships that helper with a docstring naming exactly this use, and it has one production call
site — `DeployerStepController.ts:360`). Downstream, `AgentFailureCard.vue:52,73,79` branches on
`failure.reason` to render the "Connect GitHub" / deploy-runner remedies — on Cloudflare those
branches can never fire. This is a live runtime-symmetry violation.

**B4 — No process-level failure handlers on Node/local; pg-boss `error` can crash the process. (P1)**
Neither Node nor local registers `process.on('unhandledRejection'|'uncaughtException')` (only
SIGTERM/SIGINT). `server.ts:550` registers `boss.on('stopped')` but **no `boss.on('error')`** —
pg-boss emits `error` for maintenance faults, and an unhandled `'error'` event on an EventEmitter
throws, i.e. a pg-boss maintenance hiccup can take down the orchestrator with no log line naming
pg-boss.

**B5 — Two Cloudflare queue consumers fail with zero logging; no DLQ exists anywhere. (P1)**
`sync-consumer.ts:59-61` (GitHub sync) and `index.ts:745-747` (execution admission) are bare
`catch { message.retry() }` — a permanently failing webhook delivery or a run that can never
start burns its retries with no evidence (the tracker-sync sibling at `:129-139` logs; copy it).
The `dead_letter_queue`/`max_retries` blocks in `deploy/backend/wrangler.toml:216-262` are
**commented out**, and no pg-boss `createQueue` passes `deadLetter` (zero hits repo-wide) — a
pg-boss job that exhausts `retryLimit: 5` lands in `failed` and nothing ever reads it. For
execution kinds the stale-run sweeper is the accidental backstop; for `githubSync`/`trackerSync`/
`envTest` there is nothing.

**B6 — No timeout and no retry on any VCS call; `safeFetch` has no default deadline. (P2)**
`FetchGitHubClient` (`:384,1472`), `GitHubAppAuth.ts:199`, `ensureWorkBranch.ts`, and
`FetchGitLabClient` pass no `AbortSignal` (the integrations package is consistent about it —
compare `KubernetesApiClient.ts:77`). A hung GitHub connection blocks a durable step until the
5-min Workflows timeout / pg-boss expiry. `GitHubApiError.rateLimited` + `resetAt` are computed
(`FetchGitHubClient.ts:1483-1496`) and then only rendered into prose — nothing honours
`Retry-After`. `safeFetch` sets no timeout of its own; the per-attempt deadline lives in one
caller (`WebhookNotificationChannel.ts:140-161`), so any future caller inherits an unbounded
per-hop fetch.

**B7 — Poll/sweep error causes are lost. (P1)**
`drive.ts:107-116` (Node/local): a **bare `catch`** counts the failure without binding the error;
the terminal message is `"<label> status was unreadable (3 polls)"` with the actual cause (DNS,
TLS, 502) existing nowhere. The Cloudflare twin logs each attempt and appends
`(last error: …)` (`ExecutionWorkflow.ts:110-122`) — a one-line asymmetry causing total
cause-loss on Node/local. Both sweepers also run their whole pass in one `try`: a single throwing
`instanceState`/`redrive` aborts every later stale run that tick (`sweeper.ts:130-162`,
`pgBossRunner.ts:312-381`), logged as "sweep failed" with no run id.

**B8 — `MergeTrackRecordService` drops the repo identity its own comment promises to keep. (P2)**
`MergeTrackRecordService.ts:105-114`: the comment says the repo identity is captured even when
the changed-file list is unreadable, but `repo` is bound *inside* the `try` — a **throwing**
`listChangedFiles` (403/404/rate-limit, the common case) returns bare `absent`, so external-merge
attribution by `(repoId, prNumber)` fails permanently for that record.

### C. Telemetry, tracing, metrics, health

**C1 — Tracing covers only LLM generations and container tool spans, as siblings. (P2)**
The `LlmTraceSink` port has exactly two emit methods; the OTel/Langfuse mappings export three
mappers. Trace id is an FNV hash of `executionId`; tool spans carry no parent span id. **Not**
traced: HTTP server spans on the Hono app, DB queries, pg-boss/CF-queue jobs, workflow steps,
gate probes, container dispatches — and no W3C `traceparent` crosses the container boundary, so
no end-to-end trace exists (also flagged in the code-quality review, item 8).

**C2 — Inline LLM calls never reach `llm_call_metrics`, and bypass the workspace privacy gate. (P1)**
`InstrumentedModelProvider.emit` (`agents/src/providers/instrumented.ts:127-161`) calls only
`traceSink.recordGeneration` — no repository write. Every inline site (judges, requirements
writer, kaizen, fragment selector, fork chat, consensus — ~19 `catFactoryObservability(` sites)
is invisible to `ObservabilityPanel` and the `investigate-telemetry` skill. Worse, the proxy path
gates bodies on `LLM_RECORD_PROMPTS` **AND** per-workspace `storeAgentContext`
(`LlmObservabilityService.ts:191`), but the inline path honours only `recordPrompts`
(`instrumented.ts:80,93,152-153`) — **a workspace that opted out still ships its inline
prompt/response bodies to Langfuse/OTel.** The gating asymmetry is a privacy bug, not just a
coverage gap.

**C3 — Operational metrics are five run-level gauges behind a double opt-in. (P1)**
`sweepPlatformMetrics` pushes exactly `runs`/`run_success_rate`/`run_failures`/`live_runs`/
`run_duration` (per-account, from `agent_runs` only), and only when `OTEL_ENABLED` AND an
endpoint AND `OTEL_PLATFORM_METRICS` are all set. Missing entirely: HTTP request
rate/latency/errors, pg-boss/CF queue depth + job failures, `AppCaches` hit/miss, container
dispatch failures and evictions, webhook delivery failures, sweeper activity (runs swept,
re-driven, stalled), dropped telemetry/notification batches, DB errors. No `/metrics` scrape
endpoint exists.

**C4 — Health probes under-report; the Worker has none. (P2)**
Node `/ready` checks a DB `SELECT 1` and a **process-local boolean** for pg-boss (a wedged boss
reads healthy — acknowledged in-code at `server.ts:544-549`); Redis, the telemetry store, and the
runner backend are unprobed. The embedded/mothership variant returns a permanently green
`/ready`. The Worker exposes only `/health` returning `{status:'ok'}` — zero dependency signal
(D1, TELEMETRY_DB, queues, containers all unprobed).

**C5 — `platform_health` cannot see a dead deployment. (P2)**
Exactly three conditions (failure rate, p99 duration, backlog). If run creation stops entirely,
`total = 0` → all three silent: a fully dead platform reads identically to a quiet healthy one.
No absolute failure counts, no failure-kind-specific condition (100% `evicted` reads the same as
100% `agent`), no stuck-run condition (deferred by the observability initiative), and the sweep
itself failing raises nothing. Off by default (`PLATFORM_ALERTS`).

**C6 — One sick table silently stops all telemetry pruning. (P2)**
Both retention sweeps (`node/src/retention.ts:114-149`,
`cloudflare/.../workflows/retention.ts:120-159`) are a chain of sequential `await`s with no
per-table isolation — the first failing `deleteOlderThan` aborts every later prune in the pass,
indefinitely, with only a generic sweep-failed log.

**C7 — Telemetry drops its own failures silently. (P2)**
`CompositeTraceSink` swallows per-sink errors with bare `catch {}` and no logging
(`llm-trace-sink.ts:118-133`); a failed `llm_call_metrics` write is a single `log.warn`
(`LlmProxyController.ts:589-595`); the Langfuse sink documents that a chatty run can drop batches
on rate limits. Nothing counts any of this — telemetry completeness is itself unmonitored.

**C8 — No client-side error reporting. (P3)**
No global Nuxt error handler, no sink: SPA exceptions are invisible to operators (also in the
code-quality review). The two `console.error` sites in the frontend are the whole story.

### D. Execution-path failure visibility

**D1 — Container death yields no post-mortem on most transports — including production. (P1)**
The post-mortem machinery (`exitState()` + scrubbed `logs()` tail → `firstEvictionDetail`) exists
and is user-visible, but is wired into exactly **one** path: the local per-run poll
(`LocalContainerRunnerTransport.ts:413`). Not wired: the **Cloudflare transport** (all three
eviction branches produce `evicted: 'crash'` with no `detail` — production container deaths
surface as the bare sentinel string), the local **pooled** poll (`:585-599` — same adapter, same
method available, not passed), Kubernetes (never reads
`status.containerStatuses[].lastState.terminated` despite having `apiFetch`), the native process
transport (exit code + stderr discarded), and inline jobs (`pollInlineJob` — no `evicted` field
at all). The **runner-pool transport mints no eviction signal whatsoever** (no `evicted:`
producer) — that is stuck-run-audit F4; the visibility half belongs here.

**D2 — A harness crash loses every in-flight `JobView`. (P1)**
The harness registers no `uncaughtException`/`unhandledRejection` handler; a throw outside a job
promise kills the process, the in-memory `JobRegistry` (with each job's `error`, `failureCause`,
`detail`, buffered `callMetrics`) vanishes, and the poller reports a generic eviction. Related
harness silences: a clean-exit failure (`no-usable-output`, `llm-upstream`) never gets `detail`
(phase timings/breadcrumbs are only attached on the throw path — `runner.ts:479-481`); the
`coldStart` wedge signal has **zero** consumers outside the harness; the PR-description lift
(`pr-description.ts:79-82`) and effort-report read (`effort.ts:41-51`) fail with `undefined` and
no log.

**D3 — Spec promotion is a fully silent no-op on every failure path. (P2)**
`agents/src/repo-ops/builtin.ts:414-416` plus ~6 early returns (unsafe shard, replay, zero
landed) — all indistinguishable from success. A tester run that verified 10 requirements but
could not promote any (GitHub 403, shard mismatch) reports as fully green with no log, no
persisted note, no user surface. Blocked on A1 (RepoOp ctx has no logger to wire).

**D4 — Re-drives, stalls and orphan-finalizations are uncountable. (P1)**
Neither sweeper persists a re-drive count; `orphanedSince` is an in-memory map holding only a
timestamp. "Was this run re-driven 3 times?" is unanswerable except by grepping logs — and on
Cloudflare not even that: the sweep logs only aggregates (`{redriven: 3}`, no run ids), and
isolate eviction resets the map silently. `WorkflowsLookup.instanceState` swallows **both** of
its error paths to `'missing'` (`sweeper.ts:31-47`) — a Workflows API outage makes every stale
run look missing and triggers a mass re-drive with zero log lines — and an unconfigured workflow
binding returns `'alive'`, silently exempting that kind from sweeping forever.

**D5 — `RunDiagnostics` misses the failures that need it most, and has no UI. (P2)**
`recordDispatchDiagnostics` runs **after** `startJob` returns, so dispatch/preflight failures —
the class where "which model / which repo / which backend" matters most — carry no `lastDispatch`.
Inline steps never stamp diagnostics at all. And the whole block is write-only: zero frontend
references to run `diagnostics`, `firstEvictionDetail` (for runs that *recovered*), or the
`evictionRecoveries` counters. The schema's stated purpose ("after-the-fact investigation") is
served today only by hand-written SQL.

**D6 — A dead Workflows instance discards its own cause. (P1)**
`finalizeOrphan` stops the run with a fixed string; `instance.status()` returns an `error` field
the sweeper never destructures (`sweeper.ts:37`). `buildWorkflowRuntime` retries with no logging
(its own doc says a persistent failure "SHOULD fail loudly" — it fails silently into the
Workflows console only). Every `WorkflowsWorkRunner` operation (`create`/`signalDecision`/
`signalResume`/`cancelRun`) is a bare `catch {}` — `create`'s catch assumes "already exists" but
equally swallows quota and binding failures, and `runtime.ts:20-24` documents the resulting
discarded-decision incident.

**D7 — The two primary realtime publishers are silent; the browser goes stale with no trace. (P1)**
`DurableObjectEventPublisher.publish` and `NodeEventPublisher.publish` both swallow with no
logger even injected — a persistently broken `WorkspaceEventsHub` DO or a serialisation throw
leaves every browser stale with zero log lines, indistinguishable from "no subscribers". The
Redis propagator proves the fix is one `log.warn` per class (`redisPropagator.ts:140-146`).

**D8 — Local adapter contracts conflate distinct failure states. (P3)**
`logs()` returns `''` for both "container printed nothing" and "docker daemon unreachable"
(`dockerRuntime.ts:178-180`), which can null the entire post-mortem; `exitState()` maps a failed
inspect to "may still be running" for a container that is definitively gone
(`dockerRuntime.ts:160-166` → the misleading message at `LocalContainerRunnerTransport.ts:892`);
Apple's coarse inspect loses OOM/exit-code fidelity with no reduced-fidelity warning; every
`remove()`/`reapExited()` swallows unconditionally, so a leaking container inventory has no
signal.

## Recommended steps

Phased so each slice is PR-sized, foundations first (later phases depend on the logger port).
Every slice obeys the standing rules: runtime symmetry with a conformance assertion where the
behaviour is shared; harness changes are image-bumping and batch together; best-effort paths stay
best-effort (a fix adds a log/counter, never a throw into the caller).

### Phase 1 — Logging foundations (prerequisite for everything else)

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 1.1 | Add a `Logger` port to kernel (`ports/logging.ts`: 4 levels + `child`, the shape the harness already declares); thread it through `CoreDependencies` and the facade containers; wire the pino logger in all three facades. A `noopLogger` default keeps construction cheap. | A1 | P1 |
| 1.2 | Add `runBestEffort(label, fn, logger)` (kernel, beside the port) and convert the B1 table's sites to it — log-and-swallow, never rethrow. Give `MergeTrackRecordService` and the `RepoOp` ctx a logger dep. | B1, D3, B8's sibling sites | P1 |
| 1.3 | Wire `LOG_LEVEL` for real: read `process.env.LOG_LEVEL` (Node/local) and a wrangler var (Worker) into the pino level; add level filtering to the harness logger; document in `.env.example`. | A4 | P2 |
| 1.4 | One-line cause recoveries: bind + log the poll error in `drive.ts` and append `(last error: …)` to the failure message (copy `ExecutionWorkflow`); log the two silent CF queue consumers (copy `handleTrackerSyncBatch`); `log.warn` in both realtime publishers; log every `WorkflowsWorkRunner` swallow and `buildWorkflowRuntime` retry. | B7, B5 (logging half), D7, D6 (logging half) | P1 |
| 1.5 | Process-level guards on Node/local: `process.on('unhandledRejection'/'uncaughtException')` (log structured, exit on uncaught), and `boss.on('error', log)`. | B4 | P1 |

### Phase 2 — Error identity survives the trip

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 2.1 | Thread `reason` through the Cloudflare driver's `failRun` helper (match `drive.ts:192-197`), and call `getErrorReason(error)` on the advance-throw path of **both** drivers. Conformance-assert that a `ConflictError` thrown mid-advance reaches `AgentFailure.reason` on both runtimes. | B3 | P1 |
| 2.2 | Add `UnavailableError`/`UnauthorizedError`/`RateLimitedError` `DomainError` subclasses (with `details.reason` support) and migrate the ~40 hand-rolled envelopes; normalize the `code`-less envelopes in `LlmProxyController` + `WebSearchProxyController`; stop echoing the raw upstream exception at `LlmProxyController.ts:196`; rethrow instead of hand-mapping at `AuthController.ts:790`. | B2 | P1 |
| 2.3 | Hoist `repo` resolution out of the `try` in `MergeTrackRecordService.classify` so a throwing `listChangedFiles` still records `(repoId, prNumber)`. | B8 | P2 |
| 2.4 | Fix the inline-path privacy gate: `InstrumentedModelProvider` must consult the same per-workspace `storeAgentContext` gate as the proxy path before shipping bodies to trace sinks. | C2 (privacy half) | P1 |

### Phase 3 — Correlation & request visibility

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 3.1 | Request middleware on the shared Hono app: mint/propagate `x-request-id`, log method/path/status/duration at `info` (4xx at `warn` with the `DomainError` code), bind a request-scoped child logger. Extend `errorHandler` to include the request id in error envelopes so a user-visible error is greppable. | A2 | P1 |
| 3.2 | Thread `executionId`/`workspaceId` into the container job body; the harness binds them into its `log.child` beside `jobId`. Give `ContainerAgentExecutor` a logger and log dispatch/poll transitions. Standardize `logger.child({workspaceId, executionId})` in the workflows/drivers. | A3 | P1 |
| 3.3 | Propagate W3C `traceparent` into the job body so harness tool spans nest under the run's trace; add real parent ids to the OTel/Langfuse mappings (change in `src/mapping.ts`, conformity-pinned). HTTP server spans can follow as a separate slice. | C1 | P2 |

### Phase 4 — Operational metrics, health, alerting

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 4.1 | Extend `PLATFORM_METRIC` with the missing operational gauges/counters: runs re-driven/stalled/finalized per sweep, container dispatch failures + evictions, pg-boss queue depth (one `COUNT` per queue) ⇄ CF queue backlog where readable, dropped telemetry/notification batches, `AppCaches` hit/miss (a counter pair on the caching seam). Persist the per-run re-drive count (a column on `agent_runs`, D1 ⇄ Drizzle) so D4's question is answerable. | C3, D4 | P1 |
| 4.2 | `platform_health`: add a zero-throughput condition (no runs created in N hours where the trailing window had activity) and a failure-kind-dominant condition (e.g. >80% `evicted`/`dispatch`); alert when the sweep itself fails repeatedly. | C5 | P2 |
| 4.3 | Harden readiness: real pg-boss round-trip (or last-maintenance-tick age) instead of the boolean; optional Redis + telemetry-store checks; decide and document the Worker story (a `/ready` that probes D1/TELEMETRY_DB bindings, or an explicit ADR that the platform relies on Cloudflare's own health). | C4 | P2 |
| 4.4 | Isolate retention pruning per table (per-table try/catch + one summary log naming failed tables). | C6 | P2 |
| 4.5 | Enable DLQs: uncomment + document the `dead_letter_queue` config in `deploy/backend/wrangler.toml`; add `deadLetter` to the pg-boss `createQueue` calls with a sweeper that logs/alerts on dead-lettered jobs. | B5 (policy half) | P2 |

### Phase 5 — Execution-path forensics

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 5.1 | Post-mortem parity: pass `postMortem` to the local pooled poll (method already exists); have the CF container DO capture exit state + a scrubbed log tail and expose it on the eviction view; read `lastState.terminated` in the K8s transport; capture exit code + stderr tail in the native process transport. Pool eviction classification itself is stuck-run F4 — land the visibility with it. | D1 | P1 |
| 5.2 | Call `recordDispatchDiagnostics` **before** `startJob` so dispatch/preflight failures carry `lastDispatch`; stamp a minimal diagnostics block for inline steps. | D5 | P2 |
| 5.3 | Surface what's already persisted: `diagnostics.lastDispatch`, `firstEvictionDetail` (recovered runs), `evictionRecoveries`, and the new re-drive count in the SPA (an "investigation" disclosure on `AgentFailureCard` / the run panel). Frontend-only once 4.1 lands. | D5 | P2 |
| 5.4 | Read `instance.status().error` into the `finalizeOrphan` stop reason; distinguish `instanceState`'s two swallowed error paths from genuine `missing` (log + treat repeated lookup failures as "unknown", not "missing", to prevent outage-triggered mass re-drives); warn once for an unconfigured workflow binding. | D6, D4 | P1 |
| 5.5 | Harness slice (image-bumping, batch together): `uncaughtException`/`unhandledRejection` handlers that flush terminal `JobView`s before exit; attach `detail` (phase timings + breadcrumb) on clean-exit failures too; log the PR-description/effort-report read failures; scrub log fields through `redactSecrets` in the harness logger. Surface `coldStart` through `RunnerJobView` while in there. | D2, A5 (harness half) | P1 |
| 5.6 | Persist inline LLM calls to `llm_call_metrics` via `LlmObservabilityService` (the instrumented provider gains an optional recorder dep) so `ObservabilityPanel` and `investigate-telemetry` see judge/consensus/inline-kind runs. | C2 (coverage half) | P2 |

### Phase 6 — Hardening & polish

| # | Step | Fixes | Sev |
| --- | --- | --- | --- |
| 6.1 | Default timeouts on the VCS clients (an `AbortSignal.timeout` per request, generous — e.g. 60s) and honour `Retry-After`/`resetAt` with one bounded retry on rate-limited GETs; give `safeFetch` a default per-hop deadline overridable by callers. | B6 | P2 |
| 6.2 | Per-item isolation in both stale-run sweepers (per-run try/catch, log the run id, continue the pass). | B7 (sweep half) | P2 |
| 6.3 | Unify `redactSecrets`: kernel copy as source of truth, harness/deploy-harness copies conformity-pinned byte-for-byte (the `host-markdown.ts` pattern). | A5 | P3 |
| 6.4 | Local adapter fidelity: distinguish "no logs" from "logs unreadable" and "inspect failed" from "still running"; warn once on Apple's reduced fidelity; count swallowed `remove()` failures. | D8 | P3 |
| 6.5 | Minimal client-side error reporting: a Nuxt global error handler posting to a backend endpoint (workspace-scoped, rate-limited, scrubbed). | C8 | P3 |

## Conventions & gotchas for implementers

- **The logger port lands first.** Most B/D fixes in domain packages are blocked on 1.1; don't
  work around it by importing `@cat-factory/server` into orchestration or by adding one-off
  optional logger params (the `GitHubDocsProvider` shape is the stopgap being retired, not the
  pattern to copy).
- **Best-effort stays best-effort.** Every fix to a swallow site adds a log line and/or counter;
  it must never let the failure propagate into the caller. The PR-verification-report rule
  ("observability must never break agent work") applies to all of it — including the new
  observability itself (per stuck-run-audit: don't create a new class of silent background
  failure while building the thing that watches for them).
- **Runtime symmetry**: 2.1's reason-threading, 4.1's counters, 4.4's pruning isolation, and
  5.2's diagnostics all touch engine/facade seams — land Worker + Node together with a
  conformance assertion. B5/4.5 and D6/5.4 are CF-only; B4/1.5 is Node-only (genuine facade
  differentiators, not parity gaps).
- **Harness changes are image-bumping** (5.5, parts of 1.3/6.3): bump
  `@cat-factory/executor-harness` + the three tag pins per the release rules; batch them into one
  slice.
- **Secrets**: any new log field that can carry command output, URLs with tokens, or model text
  goes through `redactSecrets` at the emit site. The request-id middleware must not log
  auth headers or query strings verbatim.
- **Don't double-track**: message *content* improvements discovered during this work go to
  `error-message-coverage.md`; wedge-behaviour fixes to `stuck-run-audit.md`; dashboard/alert
  slices to `platform-operator-observability.md`. Update the other tracker rather than widening a
  slice here.
