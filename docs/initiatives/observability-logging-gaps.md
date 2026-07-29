# Initiative: observability, logging & error-handling gap analysis

**Status:** Phases 1, 1b + 2 landed; Phase 3 landed except 3.3; Phases 4–6 open (plus 1.2d)
· **Owner:** core · **Started:** 2026-07-28
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
  no structural access to a logger. This _forces_ the ~115 silent `.catch(() => {})` drops in
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

- [`error-message-coverage.md`](./error-message-coverage.md) — owns the _content_ of error
  messages (remedies, doc URLs, structured cause codes). This doc owns whether the error is
  **logged/propagated at all** and whether the structured code **survives the trip**.
- [`stuck-run-audit.md`](./stuck-run-audit.md) — owns runs that wedge or get wrongly killed
  (F4/F6/F8/F9/F11–F13 still open). This doc owns the _visibility_ of those events: whether a
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
_(FIXED in Phase 1.1 — kept here as the record of what the port was for.)_
`backend/packages/kernel/src/ports/` has ~90 port files and no logger. The only logger lives in
`@cat-factory/server` (`src/observability/logger.ts`, pino-over-console), which the domain
packages must not import. Consequence: `orchestration` (45k LOC), `integrations` (33k),
`agents` (15k) and `kernel` (20k) emit **zero** log lines. The one port-shaped logger that exists
is local and optional (`GitHubDocsProvider.ts:36-42`, `logger?: GitHubDocsLogger`), and several
services document the resulting hole outright —
[`pr-verification-report.md`](./pr-verification-report.md): "an unwired logger means a revoked
token or a rejected body leaves no trace anywhere". Raw `console.*` is _not_ the problem (near
zero in non-test source); silence is.

**A2 — No request logging, no request/correlation id; every 4xx is invisible. (P1)**
_(FIXED in Phase 3.1.)_
No `app.use` in either facade is a logging middleware; no `requestId`/`x-request-id` exists
anywhere outside the LLM-span packages. `errorHandler.ts` logs **only unexpected 500s** (with
`{ method, path }` — no id, no duration, no status); `SchemaValidationError` (400) and every
`DomainError` (403/404/409/422/428) return with no server-side log line at all. There is no way
to tie a user report to a request, or a 4xx spike to a cause.

**A3 — No correlation across the durable execution path. (P1)**
_(FIXED in Phase 1.4b + 3.2: the harness now receives `workspaceId`/`executionId` on the job body
and binds them beside `jobId`, and `ContainerAgentExecutor` logs the seam's transitions.)_
`ExecutionWorkflow` logs `executionId`; the harness binds `jobId` (`runner.ts:382`) and never
receives `executionId` (zero hits in `executor-harness/src`); the id spaces are stitched only by
the `${executionId}-${agentKind}` naming convention (`ContainerAgentExecutor.ts:176-179`).
`ContainerAgentExecutor` — the workflow↔container seam — has **zero** logger calls.
`logger.child` has only ~9 real call sites backend-wide; `ExecutionWorkflow` passes ids inline
per-call instead of binding a child (`BootstrapWorkflow`/`EnvConfigRepairWorkflow` do it right).

**A4 — `LOG_LEVEL` is inert; no debug tier exists. (P2)**
_(Backend half FIXED in Phase 1.3; the harness logger still has no level filtering — see 5.5.)_
`logger.ts:10` reads `(globalThis as { LOG_LEVEL?: string }).LOG_LEVEL ?? 'info'` — nothing ever
assigns it (not `process.env`, not a wrangler var, absent from `.env.example`). The harness logger
has no level filtering at all, and `logger.debug`/`log.debug` has **zero** call sites repo-wide,
so there is no verbose tier to turn on during an incident.

**A5 — Harness log fields bypass `redactSecrets`; the scrubber is triplicated. (P2)**
_(Backend half addressed in Phase 1: `describeError` scrubs every error message it emits, and the
convention is documented. The HARNESS logger is unchanged — it is image-bumping, so it batches
into 5.5.)_
The harness scrubs _captured output_ (`captured-command.ts:106`) but its logger emits every field
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

| Site                                                                             | What vanishes                                                              |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `ExecutionService.ts:1551` `autoStartDependents(...).catch(() => {})`            | dependent tasks silently never start                                       |
| `MergeTrackRecordService.ts:112,156,200,236`                                     | all four track-record reads/writes; the class has **no logger dep at all** |
| `InitiativeLoopService.ts:142,186,291,312,428,604`                               | loop tick, tracker recommits, block deletion, notification raise           |
| `PublicApiController.ts:246-247`                                                 | rollback of a half-created run → orphaned rows                             |
| `LlmProxyController.ts:637` `recordUsage(...).catch(() => {})`                   | usage/billing attribution lost                                             |
| `DeployerStepController.ts:569,611`                                              | leaked provisioning leases                                                 |
| `GitHubGateways.ts:25` `workflow.create(...).catch(() => {})` then `return true` | backfill reported scheduled when it wasn't                                 |
| `RunDispatcher.ts:1681,1829`, `review-kinds.ts:302`, `ExecutionService.ts:1543`  | every issue-writeback hook                                                 |

There is no `runBestEffort(fn, logger)` helper and nothing counts the drops. Blocked on A1 for
the domain packages.

_(Phase 1 added the helper; Phase 1b drained every site above, taking `backend/packages` +
`backend/runtimes` to zero behind `scripts/check-silent-catch.mjs`. What remains is the
executor/deploy harnesses (17, batched into 5.5), the SPA (~40, blocked on 6.5's sink), and the
~110 bare `catch {}` blocks this finding wrongly reported as absent — now slice 1.2d.)_

**B2 — Half the wire error vocabulary can't carry `details.reason`. (P1)**
_(FIXED in Phase 2.2. The count below is an undercount: there were 113 envelopes across 68
files, all migrated.)_
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
_(FIXED in Phase 2.1, along with the `job_evicted` `detail` the same helper also dropped.)_
`ExecutionWorkflow.ts`'s local `failRun` helper omits `reason` from its signature, so `:232`
discards `result.reason` even though the runtime-neutral `drive.ts:192-197` forwards it. The
advance-throw path drops it on **both** runtimes (`drive.ts:131` doesn't call `getErrorReason`;
kernel ships that helper with a docstring naming exactly this use, and it has one production call
site — `DeployerStepController.ts:360`). Downstream, `AgentFailureCard.vue:52,73,79` branches on
`failure.reason` to render the "Connect GitHub" / deploy-runner remedies — on Cloudflare those
branches can never fire. This is a live runtime-symmetry violation.

**B4 — No process-level failure handlers on Node/local; pg-boss `error` can crash the process. (P1)**
_(FIXED in Phase 1.5.)_
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
_(FIXED in Phase 1.2 — `repo` is now bound outside the `try` and re-attached in the catch. 2.3 is
therefore closed; the service also gained the logger it had no way to report through.)_
`MergeTrackRecordService.ts:105-114`: the comment says the repo identity is captured even when
the changed-file list is unreadable, but `repo` is bound _inside_ the `try` — a **throwing**
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
_(The PRIVACY half is FIXED in Phase 2.4; the COVERAGE half — persisting inline calls to
`llm_call_metrics` — remains, as slice 5.6.)_
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
_(FIXED in Phase 1.2b — `RepoOpContext.logger` is a required field now, and every outcome names
itself; `warn` is reserved for a promotion that was genuinely dropped.)_
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
references to run `diagnostics`, `firstEvictionDetail` (for runs that _recovered_), or the
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

### Phase 1 — Logging foundations (prerequisite for everything else) — **LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                                                        | Fixes                                        | Sev | Status                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --- | ---------------------------------------------------------------------------------------- |
| 1.1 | Add a `Logger` port to kernel (`ports/logging.ts`: 4 levels + `child`, the shape the harness already declares); thread it through `CoreDependencies` and the facade containers; wire the pino logger in all three facades. A `noopLogger` default keeps construction cheap.                                                                 | A1                                           | P1  | ✅                                                                                       |
| 1.2 | Add `runBestEffort(label, fn, logger)` (kernel, beside the port) and convert the B1 table's sites to it — log-and-swallow, never rethrow. Give `MergeTrackRecordService` and the `RepoOp` ctx a logger dep.                                                                                                                                 | B1, D3, B8's sibling sites                   | P1  | ◐ helper + the highest-value sites; the long tail and the `RepoOp` ctx remain (see 1.2b) |
| 1.3 | Wire `LOG_LEVEL` for real: read `process.env.LOG_LEVEL` (Node/local) and a wrangler var (Worker) into the pino level; add level filtering to the harness logger; document in `.env.example`.                                                                                                                                                | A4                                           | P2  | ◐ backend done; the HARNESS half moves to 5.5 (image-bumping)                            |
| 1.4 | One-line cause recoveries: bind + log the poll error in `drive.ts` and append `(last error: …)` to the failure message (copy `ExecutionWorkflow`); log the two silent CF queue consumers (copy `handleTrackerSyncBatch`); `log.warn` in both realtime publishers; log every `WorkflowsWorkRunner` swallow and `buildWorkflowRuntime` retry. | B7, B5 (logging half), D7, D6 (logging half) | P1  | ✅                                                                                       |
| 1.5 | Process-level guards on Node/local: `process.on('unhandledRejection'/'uncaughtException')` (log structured, exit on uncaught), and `boss.on('error', log)`.                                                                                                                                                                                 | B4                                           | P1  | ✅                                                                                       |

#### What Phase 1 actually shipped

- **`kernel/src/ports/logging.ts`** — `Logger` (`debug`/`info`/`warn`/`error` as `(msg, fields?)`,
  plus `child`), `noopLogger`, and `createRecordingLogger` (a recording fake, shipped rather than
  duplicated per package, so a best-effort path's evidence is assertable everywhere).
- **`kernel/src/shared/best-effort.ts`** — `runBestEffort(logger, label, fn, fields)` and
  `describeError(error)` (message + constructor name, scrubbed through `redactSecrets`).
- **`@cat-factory/server`'s `observability/logger.ts`** is now the ONLY place a logging library is
  named: pino adapted onto the port, plus `createPinoLogger(destination?)`, `parseLogLevel` and
  `setLogLevel`. The level gate lives in the adapter, NOT on the pino instance — pino children
  snapshot their parent's level at creation, so a facade configuring `LOG_LEVEL` after module load
  would otherwise miss every logger already derived.
- **Every ad-hoc logger interface was retired** (the stopgap this initiative named): `PrReportLogger`,
  `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
  `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
  `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`, `RealtimeLogger`, plus the inline
  `{ warn(obj, msg?) }` shapes and the `log?: (event, msg) => void` callbacks on
  `RecurringPipelineService` / `TrackerWebhookService`. Both pino→port bridges
  (`node/src/keyFingerprint.ts`, the Worker's `keyFingerprintLogger`) were deleted — the shapes
  now match, so a `logger.child({ … })` is the whole adaptation.
- **~230 call sites migrated** from pino's `(fields, msg)` to the port's `(msg, fields)`. The
  signature change makes an un-migrated site a typecheck failure, so coverage is complete by
  construction.
- **A facade-parity gap surfaced while wiring**: the Worker's `buildWorkerCoreDependencies` passed
  no logger into `createCore` at all, so on the DEPLOYED runtime every domain service would have
  silently fallen back to `noopLogger` — putting exactly the best-effort paths this initiative
  exists to surface back in the dark. Both facades now wire it at the TOP of their dependency
  literal, next to each other, so the pair reads as the obligation it is.
- **Docs**: [`backend/docs/logging.md`](../../backend/docs/logging.md) (the patterns), a CLAUDE.md
  convention section, `LOG_LEVEL` in `docs/environment-variables.md` and all three deployment
  examples.

#### Notes for the next implementer

- **`runBestEffort` swallows a SYNCHRONOUS throw, `.catch(() => {})` does not.** A straight port of
  the old idiom at a site whose function can throw before returning a promise is a small behaviour
  change (for the better) — worth knowing when converting the tail.
- **`layered-loader` keeps its own pino-shaped `Logger`.** `@cat-factory/caching` adapts ours onto
  it in `asLayeredLoaderLogger`; that is the one place the two conventions meet, and it should stay
  the only one.
- **`CoreDependencies.logger` is REQUIRED.** It was optional at first, and that is exactly how the
  Worker shipped with no `logger` key at all — an absent optional dep is silent by definition, and
  this one's absence is a facade-parity gap that disables the whole initiative on one runtime.
  Requiring it turns that class of bug into a typecheck failure, the same guard the message-first
  signature gives the call sites; a harness passes `noopLogger` explicitly. A new SERVICE still
  takes `logger?: Logger` and normalises once (`this.log = deps.logger ?? noopLogger`), so it can
  be unit-tested standalone.
- **Drive-by, unrelated to logging**: `backend/packages/caching/src/appCaches.test.ts` was failing
  to typecheck on `main` (a `ResolvedCatalogEntry` fixture missing the `brief` field added by the
  two-tier standards work). Fixed here because it blocked the repo-wide typecheck this change
  needed. `backend/packages/observability-langfuse`'s undici-mocked tests fail in a proxied sandbox
  both before and after; untouched.

### Phase 1b — Finish the conversion (the tail Phase 1 deliberately left) — **LANDED**

| #    | Step                                                                                                                                                                                                                                                                                                                                                                            | Fixes  | Sev | Status                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- | --------------------------------------------------- |
| 1.2b | Convert the REMAINING `.catch(() => {})` sites to `runBestEffort` — the B1 table's `InitiativeLoopService` (6), `DeployerStepController` (2, leaked provisioning leases), `PublicApiController` (the half-created-run rollback), `RunDispatcher`/`review-kinds` issue-writeback hooks — and thread a logger into the `RepoOp` ctx so spec promotion stops being a silent no-op. | B1, D3 | P1  | ✅ backend non-harness is at zero                   |
| 1.2c | Add a lint rule banning `.catch(() => {})` and a bare `catch {}` in non-test source, so the tail can't regrow while it is being drained.                                                                                                                                                                                                                                        | B1     | P2  | ◐ a guard SCRIPT, promise-drop half only — see 1.2d |
| 1.4b | Bind a `child({ workspaceId, executionId })` in the remaining engine drivers that still pass ids inline per call (`ExecutionWorkflow`).                                                                                                                                                                                                                                         | A3     | P2  | ✅                                                  |
| 1.2d | Drain the ~110 bare `catch {}` blocks in `backend/packages` + `backend/runtimes` and extend the guard to them. Most are documented deliberate swallows, so this is per-site judgement (log / `describeError` / annotate), not a sweep — which is why it was split out of 1.2c rather than lumped into it.                                                                       | B1     | P2  |                                                     |

#### What Phase 1b actually shipped

- **`scripts/check-silent-catch.mjs`**, wired into CI's always-on `repo-guards` job. It is a
  SCRIPT, not the oxlint rule 1.2c specified: oxlint (1.75) ships no `no-restricted-syntax`, so
  the rule as written could not be authored. The repo already has this shape —
  `check-file-size.mjs` exists beside oxlint's `max-lines` for the same reason.
  - **Detection MASKS comments and string literals before matching** (`scripts/silent-catch.mjs`,
    fixtures in `silent-catch.test.mjs`, run by `node --test` in the same CI job). The first cut
    matched raw source and then asked whether the hit was in a comment, using a prefix heuristic —
    which read the `//` inside a URL as a comment opener, so `fetch('https://…').catch(() => {})`
    turned the guard off on precisely the line it exists to catch. Masking answers the question
    structurally instead of guessing, and the fixtures exist because a guard that regresses
    silently still reports green.
  - **Every spelling of an empty handler counts** — arrow or `function`, typed param or not, and a
    body holding only a comment. That last one is the important one: without it an author can
    document a swallow inline and never state a reason, which makes the escape hatch optional.
    Widening it immediately turned up two drops the narrow pattern had missed
    (`HttpMachineEventClient.publish`, the web-search query recorder), both now converted.
    `.catch(noop)` stays out of reach by design: whether a named function is empty is not a
    question a text scan can answer, and guessing makes a guard unpredictable.
- **The guard's scope is narrower than "non-test source", deliberately, and the gap is tracked:**
  - The **harnesses** (executor + deploy) are excluded, because a source change there bumps the
    published runner image — this initiative's own rule batches all harness work into slice 5.5.
    17 sites remain there.
  - The **SPA** is excluded: it has no logger to report through until client-side error reporting
    (6.5 / C8) lands. ~40 sites remain there, and they need a sink before they need a rule.
  - A **bare `catch {}`** is not checked. The audit above claimed there were none in non-test
    source; there are ~110 in this scope alone. Draining them is 1.2d.
- **An escape hatch with a mandatory reason**: `// silent-catch-ok: <why>` above the drop. Exactly
  one site uses it (`readiness.ts`'s late-rejection swallow, whose rejection the surrounding race
  already reports — logging it again would warn on every probe timeout).
- **`RepoOpContext.logger` is REQUIRED**, the same call the initiative made for
  `CoreDependencies.logger` and for the same reason: an absent optional logger is silent by
  definition, which is the failure mode. `specPromotionPostOp` now names each outcome — `debug`
  for the ordinary no-ops (nothing met, no `spec/` tree, a replay), `warn` only where a promotion
  was genuinely DROPPED (an unsafe shard, a throwing commit). That is D3 closed.
- **Three engine collaborators gained a logger they had no way to report through**:
  `RunDispatcher` (both issue-writeback hooks), `DeployerStepController` (both provisioning-lease
  releases — a leaked lease holds billed compute or a self-hosted pool slot, with no other
  symptom), and `InitiativeLoopService` (whose per-initiative isolation meant an initiative
  failing EVERY tick read as idle in the sweeper's aggregate counts).
- **Two `try { … .catch(() => {}) } catch {}` doubles collapsed** into one `runBestEffort`
  (`LlmObservabilityService`, `InstrumentedModelProvider`): the helper already covers the
  synchronous throw the outer `try` was there for.
- **One more local logger interface retired** — `warnOnGitHubPatProblemInBackground`'s
  `{ warn: (msg: string) => void }`, missed by Phase 1's sweep. Its test now uses kernel's
  `createRecordingLogger`.
- **`ExecutionWorkflow` binds `child({ workspaceId, executionId, workflow: 'execution' })`**, and
  its poll-failure messages are scrubbed with `redactSecrets` where they are minted — they are
  both logged AND folded into the run's user-visible failure text, and a `fetch` error routinely
  echoes the request URL back in its own message.

#### Notes for the next implementer

- **`runBestEffort` inside `waitUntil` is the shape to copy for post-response work.** The Node
  fallback in `makeWaitUntil` used to swallow, so a rejection from any controller's
  fire-and-forget telemetry reached the process-level guard with no idea which controller
  scheduled it.
- **A `.catch(fallbackValue)` is not a silent drop and the guard does not flag it** — but it still
  owes a `describeError`. `IssueWritebackService`'s claim read is the worked example: a store
  failure there reads as "someone else holds the claim", which silently suppresses the post.
- **Requiring a new context field is cheap and finds real holes.** Making `RepoOpContext.logger`
  required cost ~40 one-line test edits and nothing else, because every production construction
  site is in one file.
- **A guard's own blind spots are worth more attention than its findings.** Both extra drops this
  slice converted were found by WIDENING the detector, not by reading code — and the widening was
  prompted by asking what shapes the pattern could not express, not by a failure. Do the same for
  1.2d: the bare-`catch {}` sweep is a text scan too, and `catch (e) { /* fine */ }` will be its
  equivalent hole.
- **Bind the narrowed value to a local before a `runBestEffort` closure.** TypeScript drops
  property narrowing across a callback boundary, so `() => this.maybe!.thing()` is the shape that
  falls out naturally — an assertion resting on a guard several lines up, which nothing rechecks
  when that condition later grows a branch. `const x = this.maybe; if (x) …` costs one line and
  keeps the typechecker responsible for it.

### Phase 2 — Error identity survives the trip — **LANDED**

| #       | Step                                                                                                                                                                                                                                                                                                                                                                                            | Fixes             | Sev | Status |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --- | ------ |
| 2.1     | Thread `reason` through the Cloudflare driver's `failRun` helper (match `drive.ts:192-197`), and call `getErrorReason(error)` on the advance-throw path of **both** drivers. Conformance-assert that a `ConflictError` thrown mid-advance reaches `AgentFailure.reason` on both runtimes.                                                                                                       | B3                | P1  | ✅     |
| 2.2     | Add `UnavailableError`/`UnauthorizedError`/`RateLimitedError` `DomainError` subclasses (with `details.reason` support) and migrate the ~40 hand-rolled envelopes; normalize the `code`-less envelopes in `LlmProxyController` + `WebSearchProxyController`; stop echoing the raw upstream exception at `LlmProxyController.ts:196`; rethrow instead of hand-mapping at `AuthController.ts:790`. | B2                | P1  | ✅     |
| ~~2.3~~ | ~~Hoist `repo` resolution out of the `try` in `MergeTrackRecordService.classify`.~~ **Done in Phase 1.2** (the service needed a logger anyway, and the two changes are one file).                                                                                                                                                                                                               | B8                | P2  | ✅     |
| 2.4     | Fix the inline-path privacy gate: `InstrumentedModelProvider` must consult the same per-workspace `storeAgentContext` gate as the proxy path before shipping bodies to trace sinks.                                                                                                                                                                                                             | C2 (privacy half) | P1  | ✅     |

#### What Phase 2 actually shipped

- **The Cloudflare driver's `failRun` gained `reason`** and now forwards it from `job_failed`
  results; both drivers call `getErrorReason(error)` on the advance-THROW path. A second
  parity gap surfaced while editing the same helper: the Worker's `job_evicted` branch passed
  no `detail`, so the container post-mortem — the only surviving account of why a container
  died — was dropped on the runtime where containers actually run.
- **The wire vocabulary is complete**: `UnavailableError` (503) / `UnauthorizedError` (401) /
  `RateLimitedError` (429) join the five existing `DomainError` classes, each carrying
  `details.reason`, with `errorHandler`'s status map and the persistence-RPC status map
  extended. The audit undercounted the hand-rolled envelopes — there were **113**, not ~40,
  across **68 files**; all are migrated.
- **The migration shape worth copying**: a controller-local
  `const unavailable = (): never => { throw new UnavailableError(…) }`. Because `never` is
  assignable to every declared response type, the ~90 `return unavailable(c)` call sites became
  `return unavailable()` with no change to their surrounding control flow, so the diff is
  mechanical rather than a per-handler rewrite.
- **`LlmProxyController` + `WebSearchProxyController` envelopes all carry a `code`** now
  (`upstream_unavailable` / `upstream_error` / `upstream_blocked` / `unavailable` /
  `unauthorized` / `validation` / `payload_too_large` / `spend_exhausted`), and the in-process
  call failure no longer echoes the raw SDK exception onto the wire — that text routinely
  carries the request URL or an auth header, and this response leaves the deployment. The cause
  is still logged and still recorded on the call metric, both of which scrub.
- **The inline LLM path now runs the SAME double gate as the proxy path.** `LLM_RECORD_PROMPTS`
  alone used to govern it, so a workspace with `storeAgentContext` off still shipped its inline
  prompt/response bodies to Langfuse/OTel — a privacy bug, not a coverage gap. The gate is a
  narrow predicate (`WorkspaceBodiesGate`) built by `createStoreAgentContextGate` in the shared
  server layer, so both facades wire it from one place.

#### Notes for the next implementer

- **`AuthController`'s signup hand-map was removed, but the reset-password one was KEPT.**
  They look identical and are not: signup flattening `ConflictError`/`ValidationError` onto one
  400 discards the code a client needs ("email taken" vs "password too weak"), while reset
  flattening `NotFound`/`Conflict`/`Validation` onto one message is deliberate — the distinct
  causes are an ORACLE for whether a reset token exists. Read the surrounding comment before
  "finishing" a flattening that looks like an oversight.
- **A controller that throws needs the app it is mounted on to have `onError`.** Both facades
  wire `app.onError(handleError)` at the root, so production was fine — but
  `VcsWebhookController.test.ts` built a bare `new Hono()` and every refusal became a 500. A
  controller unit test must mount the real handler now, not just the route.
- **The `Record<PersistenceErrorCode, number>` in `persistence/rpc.ts` earns its keep.** Adding
  three `DomainErrorCode` members failed `tsc` there until they were mapped, which is the only
  reason the machine-RPC status mapping stayed in step with the HTTP one.
- **`publicApiAuth.ts` / `PublicDecisionController`'s `fail` shapes were deliberately left
  alone.** They are a typed sum type (`{ fail: { status, code, message } }`) chosen so contract
  handlers stay typed against their declared response schemas — a different pattern from the
  hand-rolled envelope, and they already carry a `code`.
- **The inline body gate FAILS CLOSED but does not fail the export.** An unreadable settings row
  is not consent, so bodies are withheld — while the numeric telemetry still ships, because
  losing usage/timing for a store hiccup would trade a privacy bug for an observability one.
- **`LlmFragmentSelector` was the one inline site tagging no `workspaceId`**, so no workspace
  opt-out could ever apply to it. It had `context.workspaceId` in hand. When adding an inline
  LLM call, tag the workspace — the gate is only as good as the attribution.

### Phase 3 — Correlation & request visibility — **3.1 + 3.2 LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                          | Fixes | Sev | Status |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| 3.1 | Request middleware on the shared Hono app: mint/propagate `x-request-id`, log method/path/status/duration at `info` (4xx at `warn` with the `DomainError` code), bind a request-scoped child logger. Extend `errorHandler` to include the request id in error envelopes so a user-visible error is greppable. | A2    | P1  | ✅     |
| 3.2 | Thread `executionId`/`workspaceId` into the container job body; the harness binds them into its `log.child` beside `jobId`. Give `ContainerAgentExecutor` a logger and log dispatch/poll transitions. Standardize `logger.child({workspaceId, executionId})` in the workflows/drivers.                        | A3    | P1  | ✅     |
| 3.3 | Propagate W3C `traceparent` into the job body so harness tool spans nest under the run's trace; add real parent ids to the OTel/Langfuse mappings (change in `src/mapping.ts`, conformity-pinned). HTTP server spans can follow as a separate slice.                                                          | C1    | P2  |        |

#### What Phase 3 (3.1 + 3.2) actually shipped

- **`http/requestLogging.ts`** — `mountRequestLogging`, mounted by both facades as the FIRST
  middleware (ahead of CORS and the per-request container build, so a CORS denial and the
  Worker's misconfiguration fallback are logged like anything else). It adopts a bounded, safe
  `X-Request-Id` or mints one, binds `{ requestId, method, path }` on a request-scoped child
  logger, echoes the id on the response, and emits one line per request: `info` on success,
  `warn` on a 4xx, `error` on a 5xx.
- **Every error envelope carries `requestId`**, which is the whole point of the id: a user quotes
  what they were shown and an operator greps one line. `handleError` also stashes the code it
  mapped on the context so the request line names it, and now reports an unexpected fault through
  the REQUEST logger — the 500's own line and the envelope the caller received share an id.
- **`X-Request-Id` joined both CORS lists** — `CORS_ALLOWED_HEADERS` so a caller that already has
  an id can propagate it instead of the backend minting a second one for the same request, and a
  new `CORS_EXPOSED_HEADERS` so a browser can actually READ it off the response (without
  `Access-Control-Expose-Headers` it is on the wire and invisible to the SPA).
- **The container seam correlates end to end.** `buildCommonBody` puts `workspaceId` +
  `executionId` on every agent job body; the harness parses them (optional) and binds them onto
  its per-job child logger beside `jobId`. Riding the job body means all three transports
  (Cloudflare container, local container, runner pool) carry them with no transport-specific
  wiring — the same reason `validationChecks` rides it.
- **`containerAgentLogging.ts`** — the seam's log vocabulary as a small collaborator
  (`ContainerAgentExecutor.ts` had 29 lines of headroom against its budget, so the messages and
  their rationale were extracted rather than the budget raised). `ContainerAgentExecutor` now logs
  dispatched / dispatch-failed / running (`debug`) / settled, with the ids bound once.
- **A dispatch that THROWS is logged and re-thrown.** That failure class had no account anywhere:
  the job never gets a handle, so no poll can report it, and the resolved model/backend of a job
  that never existed was recorded nowhere.
- **Two bare `catch {}` swallows in the executor became `runBestEffort`** (the agent-context
  snapshot write and the tool-span forward) now that the class has a bound logger to report
  through — 1.2d sites, drained here because they are in the file this slice gave a logger.

#### Notes for the next implementer

- **Do NOT set a response header on a 101.** Hono implements a post-`next()` `c.header()` by
  REBUILDING the response (`new Response(body, res)`), which silently drops the Cloudflare
  `webSocket` property — i.e. stamping the request id on the SPA's WebSocket upgrade would break
  the live event stream on the deployed runtime while every plain-HTTP test stayed green. The
  middleware skips 101 and the unit test pins response IDENTITY, not just the header.
- **A client-supplied correlation id is untrusted text that lands in a log stream.** It is adopted
  only when short and `[\w\-=]+`; anything else is replaced. Same reason the middleware logs
  `new URL(url).pathname` and never the raw URL — the WS `?ticket=` and OAuth `?code=` live in
  query strings.
- **`errorCode` on the request line is a bonus, not a promise.** It is set by `handleError`, so a
  controller that RETURNS a 4xx envelope instead of throwing a `DomainError` leaves it unset.
  That is one more reason to throw rather than hand-roll (see the `http/errorHandler.ts` note in
  `packages/server/AGENTS.md`).
- **3.2 is scoped to the AGENT job body, not the inline one.** A local inline container job
  (`LocalContainerRunnerTransport.runInline`) is minted with a synthetic `inline-<rand>` run id
  and its request shape carries no workspace/execution — correlating it is a change to
  `InlineContainerRequest` and its call sites, not to the harness.
- **3.3 is deliberately still open, and it is not "pass one more id".** A real distributed trace
  needs a span-id model the platform does not have yet (tool spans carry no parent span id today,
  and the trace id is an FNV hash of `executionId`), plus a harness change — so it batches
  naturally with 5.5 rather than paying a second image bump for the id alone.

### Phase 4 — Operational metrics, health, alerting

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fixes            | Sev |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --- |
| 4.1 | Extend `PLATFORM_METRIC` with the missing operational gauges/counters: runs re-driven/stalled/finalized per sweep, container dispatch failures + evictions, pg-boss queue depth (one `COUNT` per queue) ⇄ CF queue backlog where readable, dropped telemetry/notification batches, `AppCaches` hit/miss (a counter pair on the caching seam). Persist the per-run re-drive count (a column on `agent_runs`, D1 ⇄ Drizzle) so D4's question is answerable. | C3, D4           | P1  |
| 4.2 | `platform_health`: add a zero-throughput condition (no runs created in N hours where the trailing window had activity) and a failure-kind-dominant condition (e.g. >80% `evicted`/`dispatch`); alert when the sweep itself fails repeatedly.                                                                                                                                                                                                              | C5               | P2  |
| 4.3 | Harden readiness: real pg-boss round-trip (or last-maintenance-tick age) instead of the boolean; optional Redis + telemetry-store checks; decide and document the Worker story (a `/ready` that probes D1/TELEMETRY_DB bindings, or an explicit ADR that the platform relies on Cloudflare's own health).                                                                                                                                                 | C4               | P2  |
| 4.4 | Isolate retention pruning per table (per-table try/catch + one summary log naming failed tables).                                                                                                                                                                                                                                                                                                                                                         | C6               | P2  |
| 4.5 | Enable DLQs: uncomment + document the `dead_letter_queue` config in `deploy/backend/wrangler.toml`; add `deadLetter` to the pg-boss `createQueue` calls with a sweeper that logs/alerts on dead-lettered jobs.                                                                                                                                                                                                                                            | B5 (policy half) | P2  |

### Phase 5 — Execution-path forensics

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                  | Fixes                 | Sev |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | --- |
| 5.1 | Post-mortem parity: pass `postMortem` to the local pooled poll (method already exists); have the CF container DO capture exit state + a scrubbed log tail and expose it on the eviction view; read `lastState.terminated` in the K8s transport; capture exit code + stderr tail in the native process transport. Pool eviction classification itself is stuck-run F4 — land the visibility with it.   | D1                    | P1  |
| 5.2 | Call `recordDispatchDiagnostics` **before** `startJob` so dispatch/preflight failures carry `lastDispatch`; stamp a minimal diagnostics block for inline steps.                                                                                                                                                                                                                                       | D5                    | P2  |
| 5.3 | Surface what's already persisted: `diagnostics.lastDispatch`, `firstEvictionDetail` (recovered runs), `evictionRecoveries`, and the new re-drive count in the SPA (an "investigation" disclosure on `AgentFailureCard` / the run panel). Frontend-only once 4.1 lands.                                                                                                                                | D5                    | P2  |
| 5.4 | Read `instance.status().error` into the `finalizeOrphan` stop reason; distinguish `instanceState`'s two swallowed error paths from genuine `missing` (log + treat repeated lookup failures as "unknown", not "missing", to prevent outage-triggered mass re-drives); warn once for an unconfigured workflow binding.                                                                                  | D6, D4                | P1  |
| 5.5 | Harness slice (image-bumping, batch together): `uncaughtException`/`unhandledRejection` handlers that flush terminal `JobView`s before exit; attach `detail` (phase timings + breadcrumb) on clean-exit failures too; log the PR-description/effort-report read failures; scrub log fields through `redactSecrets` in the harness logger. Surface `coldStart` through `RunnerJobView` while in there. | D2, A5 (harness half) | P1  |
| 5.6 | Persist inline LLM calls to `llm_call_metrics` via `LlmObservabilityService` (the instrumented provider gains an optional recorder dep) so `ObservabilityPanel` and `investigate-telemetry` see judge/consensus/inline-kind runs.                                                                                                                                                                     | C2 (coverage half)    | P2  |

### Phase 6 — Hardening & polish

| #   | Step                                                                                                                                                                                                                                                | Fixes           | Sev |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --- |
| 6.1 | Default timeouts on the VCS clients (an `AbortSignal.timeout` per request, generous — e.g. 60s) and honour `Retry-After`/`resetAt` with one bounded retry on rate-limited GETs; give `safeFetch` a default per-hop deadline overridable by callers. | B6              | P2  |
| 6.2 | Per-item isolation in both stale-run sweepers (per-run try/catch, log the run id, continue the pass).                                                                                                                                               | B7 (sweep half) | P2  |
| 6.3 | Unify `redactSecrets`: kernel copy as source of truth, harness/deploy-harness copies conformity-pinned byte-for-byte (the `host-markdown.ts` pattern).                                                                                              | A5              | P3  |
| 6.4 | Local adapter fidelity: distinguish "no logs" from "logs unreadable" and "inspect failed" from "still running"; warn once on Apple's reduced fidelity; count swallowed `remove()` failures.                                                         | D8              | P3  |
| 6.5 | Minimal client-side error reporting: a Nuxt global error handler posting to a backend endpoint (workspace-scoped, rate-limited, scrubbed).                                                                                                          | C8              | P3  |

## Conventions & gotchas for implementers

- **`.catch(() => {})` is guarded, not just discouraged.** `scripts/check-silent-catch.mjs` fails
  CI on a new one in `backend/packages` / `backend/runtimes`; a genuinely-silent drop annotates
  itself with `// silent-catch-ok: <reason>`. The harnesses and the SPA are out of that scope on
  purpose (see Phase 1b) — do not "fix" a site there ahead of its own slice, because a harness
  edit bumps the runner image.
- **The logger port has landed** (`kernel/src/ports/logging.ts`); the B/D fixes in domain packages
  are no longer blocked. Take a `logger?: Logger` dependency and normalise once
  (`this.log = deps.logger ?? noopLogger`); never import `@cat-factory/server` into a domain
  package, and never declare a local logger interface — every one of those has been retired.
  Patterns: [`backend/docs/logging.md`](../../backend/docs/logging.md).
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
- **Don't double-track**: message _content_ improvements discovered during this work go to
  `error-message-coverage.md`; wedge-behaviour fixes to `stuck-run-audit.md`; dashboard/alert
  slices to `platform-operator-observability.md`. Update the other tracker rather than widening a
  slice here.
