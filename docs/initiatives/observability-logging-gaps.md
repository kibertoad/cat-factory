# Initiative: observability, logging & error-handling gap analysis

**Status:** Phases 1, 1b, 2 + 4 landed; Phase 3 landed except 3.3, whose span-PARENTAGE half
landed separately with the run/step spans (see C1), leaving only the container-boundary
`traceparent`; Phase 5 landed for 5.1, 5.2, 5.4 and 5.6–5.8; Phase 6 open (plus 1.2d, 3.3,
5.3, 5.5)
· **Owner:** core · **Started:** 2026-07-28
**Audited at:** `main` @ `4b3bab4`. File:line references are against that commit and will drift;
the anchoring file + symbol names are kept current: search by symbol, not line.

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
  those packages: the swallow is mandatory, not stylistic.
- **The deployed Cloudflare runtime discards `AgentFailure.reason` on every failure path**, so the
  SPA's machine-readable remedies (the "Connect GitHub" jump action, the deploy-runner hint) never
  fire in production: the whole `details.reason` pipeline built by the error-message-coverage
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

- [`error-message-coverage.md`](./error-message-coverage.md): owns the _content_ of error
  messages (remedies, doc URLs, structured cause codes). This doc owns whether the error is
  **logged/propagated at all** and whether the structured code **survives the trip**.
- [`stuck-run-audit.md`](./stuck-run-audit.md): owns runs that wedge or get wrongly killed
  (F4/F6/F8/F9/F11–F13 still open). This doc owns the _visibility_ of those events: whether a
  re-drive, an eviction, or a stall is countable and diagnosable after the fact.
- [ADR 0048](../../backend/docs/adr/0048-platform-operator-observability.md): owns the
  operator dashboard + `platform_health` alert (shipped; that initiative is closed). This doc
  records the signals that projection structurally lacks.
- `docs/internal/code-quality-observability-extensibility-review-2026-07.md` §7 independently flagged four
  of these gaps (no HTTP spans, no operational metrics, uncounted best-effort drops, no client
  error reporting); this doc turns them into an actionable plan.

## Findings

Severity: **P1** = operators/users are blind to a failure class that occurs routinely;
**P2** = plausible incident with no diagnosis path; **P3** = polish.

### A. Logging infrastructure

**A1, No logger port in the kernel; the domain engine is silent by construction. (P1)**
_(FIXED in Phase 1.1: kept here as the record of what the port was for.)_
`backend/packages/kernel/src/ports/` has ~90 port files and no logger. The only logger lives in
`@cat-factory/server` (`src/observability/logger.ts`, pino-over-console), which the domain
packages must not import. Consequence: `orchestration` (45k LOC), `integrations` (33k),
`agents` (15k) and `kernel` (20k) emit **zero** log lines. The one port-shaped logger that exists
is local and optional (`GitHubDocsProvider.ts:36-42`, `logger?: GitHubDocsLogger`), and several
services document the resulting hole outright:
[`pr-verification-report.md`](./pr-verification-report.md): "an unwired logger means a revoked
token or a rejected body leaves no trace anywhere". Raw `console.*` is _not_ the problem (near
zero in non-test source); silence is.

**A2, No request logging, no request/correlation id; every 4xx is invisible. (P1)**
_(FIXED in Phase 3.1.)_
No `app.use` in either facade is a logging middleware; no `requestId`/`x-request-id` exists
anywhere outside the LLM-span packages. `errorHandler.ts` logs **only unexpected 500s** (with
`{ method, path }`, no id, no duration, no status); `SchemaValidationError` (400) and every
`DomainError` (403/404/409/422/428) return with no server-side log line at all. There is no way
to tie a user report to a request, or a 4xx spike to a cause.

**A3, No correlation across the durable execution path. (P1)**
_(FIXED in Phase 1.4b + 3.2: the harness now receives `workspaceId`/`executionId` on the job body
and binds them beside `jobId`, and `ContainerAgentExecutor` logs the seam's transitions.)_
`ExecutionWorkflow` logs `executionId`; the harness binds `jobId` (`runner.ts:382`) and never
receives `executionId` (zero hits in `executor-harness/src`); the id spaces are stitched only by
the `${executionId}-${agentKind}` naming convention (`ContainerAgentExecutor.ts:176-179`).
`ContainerAgentExecutor` (the workflow↔container seam) has **zero** logger calls.
`logger.child` has only ~9 real call sites backend-wide; `ExecutionWorkflow` passes ids inline
per-call instead of binding a child (`BootstrapWorkflow`/`EnvConfigRepairWorkflow` do it right).

**A4: `LOG_LEVEL` is inert; no debug tier exists. (P2)**
_(Backend half FIXED in Phase 1.3; the harness logger still has no level filtering: see 5.5.)_
`logger.ts:10` reads `(globalThis as { LOG_LEVEL?: string }).LOG_LEVEL ?? 'info'`: nothing ever
assigns it (not `process.env`, not a wrangler var, absent from `.env.example`). The harness logger
has no level filtering at all, and `logger.debug`/`log.debug` has **zero** call sites repo-wide,
so there is no verbose tier to turn on during an incident.

**A5: Harness log fields bypass `redactSecrets`; the scrubber is triplicated. (P2)**
_(Backend half addressed in Phase 1: `describeError` scrubs every error message it emits, and the
convention is documented. The HARNESS logger is unchanged: it is image-bumping, so it batches
into 5.5.)_
The harness scrubs _captured output_ (`captured-command.ts:106`) but its logger emits every field
verbatim (`executor-harness/src/logger.ts`, no redaction), including spawn-failure `err.message`
and caller-supplied `logFields` for `sh -c` commands that can embed credentials
(`captured-command.ts:73,129-131`). Traces are scrubbed; logs are not. `redactSecrets` exists as
three independently drifting copies (kernel `shared/redact-secrets.logic.ts`, executor-harness
`redact.ts`, deploy-harness `redact.ts`) with only the harness copy conformity-pinned nowhere.

### B. Error handling

**B1: ~115 `.catch(() => {})` sites swallow with no log, no metric, no marker. (P1)**
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
~110 bare `catch {}` blocks this finding wrongly reported as absent: now slice 1.2d.)_

**B2: Half the wire error vocabulary can't carry `details.reason`. (P1)**
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

**B3: `AgentFailure.reason` is dropped by the Cloudflare driver on every path. (P1)**
_(FIXED in Phase 2.1, along with the `job_evicted` `detail` the same helper also dropped.)_
`ExecutionWorkflow.ts`'s local `failRun` helper omits `reason` from its signature, so `:232`
discards `result.reason` even though the runtime-neutral `drive.ts:192-197` forwards it. The
advance-throw path drops it on **both** runtimes (`drive.ts:131` doesn't call `getErrorReason`;
kernel ships that helper with a docstring naming exactly this use, and it has one production call
site: `DeployerStepController.ts:360`). Downstream, `AgentFailureCard.vue:52,73,79` branches on
`failure.reason` to render the "Connect GitHub" / deploy-runner remedies: on Cloudflare those
branches can never fire. This is a live runtime-symmetry violation.

**B4, No process-level failure handlers on Node/local; pg-boss `error` can crash the process. (P1)**
_(FIXED in Phase 1.5.)_
Neither Node nor local registers `process.on('unhandledRejection'|'uncaughtException')` (only
SIGTERM/SIGINT). `server.ts:550` registers `boss.on('stopped')` but **no `boss.on('error')`**:
pg-boss emits `error` for maintenance faults, and an unhandled `'error'` event on an EventEmitter
throws, i.e. a pg-boss maintenance hiccup can take down the orchestrator with no log line naming
pg-boss.

**B5: Two Cloudflare queue consumers fail with zero logging; no DLQ exists anywhere. (P1)**
_(Logging half FIXED in Phase 1.4; the DLQ half in Phase 4.5.)_
`sync-consumer.ts:59-61` (GitHub sync) and `index.ts:745-747` (execution admission) are bare
`catch { message.retry() }`: a permanently failing webhook delivery or a run that can never
start burns its retries with no evidence (the tracker-sync sibling at `:129-139` logs; copy it).
The `dead_letter_queue`/`max_retries` blocks in `deploy/backend/wrangler.toml:216-262` are
**commented out**, and no pg-boss `createQueue` passes `deadLetter` (zero hits repo-wide): a
pg-boss job that exhausts `retryLimit: 5` lands in `failed` and nothing ever reads it. For
execution kinds the stale-run sweeper is the accidental backstop; for `githubSync`/`trackerSync`/
`envTest` there is nothing.

**B6, No timeout and no retry on any VCS call; `safeFetch` has no default deadline. (P2)**
`FetchGitHubClient` (`:384,1472`), `GitHubAppAuth.ts:199`, `ensureWorkBranch.ts`, and
`FetchGitLabClient` pass no `AbortSignal` (the integrations package is consistent about it:
compare `KubernetesApiClient.ts:77`). A hung GitHub connection blocks a durable step until the
5-min Workflows timeout / pg-boss expiry. `GitHubApiError.rateLimited` + `resetAt` are computed
(`FetchGitHubClient.ts:1483-1496`) and then only rendered into prose: nothing honours
`Retry-After`. `safeFetch` sets no timeout of its own; the per-attempt deadline lives in one
caller (`WebhookNotificationChannel.ts:140-161`), so any future caller inherits an unbounded
per-hop fetch.

**B7: Poll/sweep error causes are lost. (P1)**
`drive.ts:107-116` (Node/local): a **bare `catch`** counts the failure without binding the error;
the terminal message is `"<label> status was unreadable (3 polls)"` with the actual cause (DNS,
TLS, 502) existing nowhere. The Cloudflare twin logs each attempt and appends
`(last error: …)` (`ExecutionWorkflow.ts:110-122`): a one-line asymmetry causing total
cause-loss on Node/local. Both sweepers also run their whole pass in one `try`: a single throwing
`instanceState`/`redrive` aborts every later stale run that tick (`sweeper.ts:130-162`,
`pgBossRunner.ts:312-381`), logged as "sweep failed" with no run id.

**B8: `MergeTrackRecordService` drops the repo identity its own comment promises to keep. (P2)**
_(FIXED in Phase 1.2: `repo` is now bound outside the `try` and re-attached in the catch. 2.3 is
therefore closed; the service also gained the logger it had no way to report through.)_
`MergeTrackRecordService.ts:105-114`: the comment says the repo identity is captured even when
the changed-file list is unreadable, but `repo` is bound _inside_ the `try`; a **throwing**
`listChangedFiles` (403/404/rate-limit, the common case) returns bare `absent`, so external-merge
attribution by `(repoId, prNumber)` fails permanently for that record.

### C. Telemetry, tracing, metrics, health

**C1: Tracing covers only LLM generations and container tool spans, as siblings. (P2)**
_(The SIBLING half is FIXED; the coverage half below is what 3.3 still owns. A tool call now
carries its ordinal and, behind the double gate, its arguments and result, and the same batch is
PERSISTED as the `agent_tool_calls` trajectory rather than existing only where a trace sink
happened to be wired. PARENTAGE landed with it: `LlmTraceSink` gained a third emit method,
`recordRunSpans`, so a settled run emits a root span plus one step span per agent kind, and every
generation and tool span names its step as parent. The parent ids are DERIVED (`deriveRunSpanId` /
`deriveStepSpanId`, pure functions of ids every emitter already holds), which is what lets a
generation recorded by the proxy on one isolate and a tool batch drained by the engine on another
name the same parent without either having seen it, and a HELPER kind (a gate's `ci-fixer`, a
Tester's fixer, a `fork-proposer`) hangs under its hosting kind rather than under the root. The
HTTP boundary also READS an inbound W3C `traceparent` now (kernel `domain/trace-context.ts`) and
stamps the caller's trace and span onto the log lines that request emits, with a run-derived trace
winning where a line has both. So the two claims below that are no longer true are "two emit
methods" and "tool spans carry no parent span id"; the FNV-hashed trace id stands, and so does
every entry in the not-traced list.)_
The `LlmTraceSink` port has exactly two emit methods; the OTel/Langfuse mappings export three
mappers. Trace id is an FNV hash of `executionId`; tool spans carry no parent span id. **Not**
traced: HTTP server spans on the Hono app, DB queries, pg-boss/CF-queue jobs, workflow steps,
gate probes, container dispatches, and no W3C `traceparent` crosses the container boundary, so
no end-to-end trace exists (also flagged in the code-quality review, item 8).

**C2: Inline LLM calls never reach `llm_call_metrics`, and bypass the workspace privacy gate. (P1)**
_(FIXED: the PRIVACY half in Phase 2.4, the COVERAGE half in Phase 5.6, and its two attribution
holes (the local subscription-inline wrap and the null execution id) in Phase 5.7. Described
below as it stood; see "What 5.6 shipped" and "What 5.7 shipped" for the resolution.)_
`InstrumentedModelProvider.emit` (`agents/src/providers/instrumented.ts:127-161`) calls only
`traceSink.recordGeneration`, no repository write. Every inline site (judges, requirements
writer, kaizen, fragment selector, fork chat, consensus: ~19 `catFactoryObservability(` sites)
is invisible to `ObservabilityPanel` and the `investigate-telemetry` skill. Worse, the proxy path
gates bodies on `LLM_RECORD_PROMPTS` **AND** per-workspace `storeAgentContext`
(`LlmObservabilityService.ts:191`), but the inline path honours only `recordPrompts`
(`instrumented.ts:80,93,152-153`): **a workspace that opted out still ships its inline
prompt/response bodies to Langfuse/OTel.** The gating asymmetry is a privacy bug, not just a
coverage gap.

**C3: Operational metrics are five run-level gauges behind a double opt-in. (P1)**
_(FIXED in Phase 4.1: the kernel `OperationalMetrics` seam plus the counters/gauges below.)_
`sweepPlatformMetrics` pushes exactly `runs`/`run_success_rate`/`run_failures`/`live_runs`/
`run_duration` (per-account, from `agent_runs` only), and only when `OTEL_ENABLED` AND an
endpoint AND `OTEL_PLATFORM_METRICS` are all set. Missing entirely: HTTP request
rate/latency/errors, pg-boss/CF queue depth + job failures, `AppCaches` hit/miss, container
dispatch failures and evictions, webhook delivery failures, sweeper activity (runs swept,
re-driven, stalled), dropped telemetry/notification batches, DB errors. No `/metrics` scrape
endpoint exists.

**C4: Health probes under-report; the Worker has none. (P2)**
_(FIXED in Phase 4.3. Redis + the telemetry store are deliberately still unprobed: see the
phase's notes for why each would be worse than the gap.)_
Node `/ready` checks a DB `SELECT 1` and a **process-local boolean** for pg-boss (a wedged boss
reads healthy: acknowledged in-code at `server.ts:544-549`); Redis, the telemetry store, and the
runner backend are unprobed. The embedded/mothership variant returns a permanently green
`/ready`. The Worker exposes only `/health` returning `{status:'ok'}`: zero dependency signal
(D1, TELEMETRY_DB, queues, containers all unprobed).

**C5: `platform_health` cannot see a dead deployment. (P2)**
_(FIXED in Phase 4.2: `throughput_stalled`, `failure_kind_dominant`, `sweep_degraded`; the
per-kind half completed later by `failure_kind_rate_high`, see the Phase 4 notes.)_
Exactly three conditions (failure rate, p99 duration, backlog). If run creation stops entirely,
`total = 0` → all three silent: a fully dead platform reads identically to a quiet healthy one.
No absolute failure counts, no failure-kind-specific condition (100% `evicted` reads the same as
100% `agent`), no stuck-run condition (deferred by the observability initiative), and the sweep
itself failing raises nothing. Off by default (`PLATFORM_ALERTS`).

**C6: One sick table silently stops all telemetry pruning. (P2)**
_(FIXED in Phase 4.4: shared per-table isolation plus a reported `failedTables`.)_
Both retention sweeps (`node/src/retention.ts:114-149`,
`cloudflare/.../workflows/retention.ts:120-159`) are a chain of sequential `await`s with no
per-table isolation: the first failing `deleteOlderThan` aborts every later prune in the pass,
indefinitely, with only a generic sweep-failed log.

**C7: Telemetry drops its own failures silently. (P2)**
_(PARTLY FIXED in Phase 4.1: `CompositeTraceSink`'s bare `catch {}` now logs AND counts
`telemetry.export_dropped`. The Langfuse sink's own rate-limit batch drops are its to report.)_
`CompositeTraceSink` swallows per-sink errors with bare `catch {}` and no logging
(`llm-trace-sink.ts:118-133`); a failed `llm_call_metrics` write is a single `log.warn`
(`LlmProxyController.ts:589-595`); the Langfuse sink documents that a chatty run can drop batches
on rate limits. Nothing counts any of this: telemetry completeness is itself unmonitored.

**C8, No client-side error reporting. (P3)**
No global Nuxt error handler, no sink: SPA exceptions are invisible to operators (also in the
code-quality review). The two `console.error` sites in the frontend are the whole story.

### D. Execution-path failure visibility

**D1 (Container death yields no post-mortem on most transports) including production. (P1)**
_(FIXED across 5.1's two slices: the local POOLED poll first, then the Cloudflare transport,
Kubernetes and the native process transport. The one claim below that did not survive contact is
"capture a scrubbed log tail" on Cloudflare: a Container's stdout is delivered to the deployment's
Workers logs and no API hands it back to the Durable Object, so that runtime's post-mortem is its
exit state, which says so rather than implying a tail exists. `pollInlineJob` still mints no
`evicted` field, and the runner-pool transport still mints no eviction signal at all: that is
stuck-run-audit F4, unchanged.)_
The post-mortem machinery (`exitState()` + scrubbed `logs()` tail → `firstEvictionDetail`) exists
and is user-visible, but is wired into exactly **one** path: the local per-run poll
(`LocalContainerRunnerTransport.ts:413`). Not wired: the **Cloudflare transport** (all three
eviction branches produce `evicted: 'crash'` with no `detail`; production container deaths
surface as the bare sentinel string), the local **pooled** poll (`:585-599`; same adapter, same
method available, not passed), Kubernetes (never reads
`status.containerStatuses[].lastState.terminated` despite having `apiFetch`), the native process
transport (exit code + stderr discarded), and inline jobs (`pollInlineJob`, no `evicted` field
at all). The **runner-pool transport mints no eviction signal whatsoever** (no `evicted:`
producer): that is stuck-run-audit F4; the visibility half belongs here.

**D2: A harness crash loses every in-flight `JobView`. (P1)**
The harness registers no `uncaughtException`/`unhandledRejection` handler; a throw outside a job
promise kills the process, the in-memory `JobRegistry` (with each job's `error`, `failureCause`,
`detail`, buffered `callMetrics`) vanishes, and the poller reports a generic eviction. Related
harness silences: a clean-exit failure (`no-usable-output`, `llm-upstream`) never gets `detail`
(phase timings/breadcrumbs are only attached on the throw path; `runner.ts:479-481`); the
`coldStart` wedge signal has **zero** consumers outside the harness; the PR-description lift
(`pr-description.ts:79-82`) and effort-report read (`effort.ts:41-51`) fail with `undefined` and
no log.

_(PARTIALLY FIXED: the `coldStart` half. `describeFailure` now folds the cold-start diagnostic,
plus a measurement of how long the run had been silent, into the failure `detail` the backend
already carries onto the step, so a wedge is legible on the run instead of only in the container
log. Surfacing it on a still-RUNNING view (the early warning, which does need the `RunnerJobView`
hop) remains slice 5.5's.)_

**D2.1: An agent CLI's own account of a bad exit was discarded. (P1, FIXED)**
The sharper edge of the same blindness, and distinct from 5.1's native-transport gap: both agent
CLIs report a terminal failure **on stdout**, inside their event stream (Claude Code's `result`
event, Codex's last agent message), and leave stderr EMPTY. `streamCli` rejected a non-zero exit
with the stderr tail alone, so an upstream refusal (quota, rate limit, a provider outage the CLI
retried out on) reached the operator as `claude exited with code 1:` and nothing more, while the
CLI's own explanation sat in a local variable only the success path returned, indistinguishable
from a crash. Nothing else in the run recorded it either: the CLI session transcript dies with the
per-run config home, and a local-mode container is removed the moment the job settles. The bad-exit
rejection now carries the CLI's terminal report, names an empty stderr as empty, and names the
SIGNAL when one killed the process instead of rendering "code null". The same fix landed on the
local runtime's native inline runner (`harnessInline.ts`), where the caller's in-band `is_error`
check was equally unreachable on a non-zero exit.

**D3: Spec promotion is a fully silent no-op on every failure path. (P2)**
_(FIXED in Phase 1.2b: `RepoOpContext.logger` is a required field now, and every outcome names
itself; `warn` is reserved for a promotion that was genuinely dropped.)_
`agents/src/repo-ops/builtin.ts:414-416` plus ~6 early returns (unsafe shard, replay, zero
landed): all indistinguishable from success. A tester run that verified 10 requirements but
could not promote any (GitHub 403, shard mismatch) reports as fully green with no log, no
persisted note, no user surface. Blocked on A1 (RepoOp ctx has no logger to wire).

**D4: Re-drives, stalls and orphan-finalizations are uncountable. (P1)**
_(FIXED across Phase 4.1 and 5.4: 4.1 added the per-run `redrive_count` column plus the sweep
counters; 5.4 closed the `instanceState` swallow that turned a Workflows outage into a mass
re-drive, and the sweep now counts what it could not classify.)_
Neither sweeper persists a re-drive count; `orphanedSince` is an in-memory map holding only a
timestamp. "Was this run re-driven 3 times?" is unanswerable except by grepping logs, and on
Cloudflare not even that: the sweep logs only aggregates (`{redriven: 3}`, no run ids), and
isolate eviction resets the map silently. `WorkflowsLookup.instanceState` swallows **both** of
its error paths to `'missing'` (`sweeper.ts:31-47`) (a Workflows API outage makes every stale
run look missing and triggers a mass re-drive with zero log lines) and an unconfigured workflow
binding returns `'alive'`, silently exempting that kind from sweeping forever.

**D5: `RunDiagnostics` misses the failures that need it most, and has no UI. (P2)**
_(HALF FIXED in 5.2: the block is stamped before the dispatch, carries the dispatch's failure
verdict, and inline steps stamp one. The UI half is 5.3.)_
`recordDispatchDiagnostics` runs **after** `startJob` returns, so dispatch/preflight failures
(the class where "which model / which repo / which backend" matters most) carry no `lastDispatch`.
Inline steps never stamp diagnostics at all. And the whole block is write-only: zero frontend
references to run `diagnostics`, `firstEvictionDetail` (for runs that _recovered_), or the
`evictionRecoveries` counters. The schema's stated purpose ("after-the-fact investigation") is
served today only by hand-written SQL.

**D6: A dead Workflows instance discards its own cause. (P1)**
_(FIXED in 5.4 for the sweeper's half: the instance's own error reaches the stop reason, and the
`WorkflowsWorkRunner` swallows were given their log lines in Phase 1.4.)_
`finalizeOrphan` stops the run with a fixed string; `instance.status()` returns an `error` field
the sweeper never destructures (`sweeper.ts:37`). `buildWorkflowRuntime` retries with no logging
(its own doc says a persistent failure "SHOULD fail loudly": it fails silently into the
Workflows console only). Every `WorkflowsWorkRunner` operation (`create`/`signalDecision`/
`signalResume`/`cancelRun`) is a bare `catch {}`: `create`'s catch assumes "already exists" but
equally swallows quota and binding failures, and `runtime.ts:20-24` documents the resulting
discarded-decision incident.

**D7: The two primary realtime publishers are silent; the browser goes stale with no trace. (P1)**
`DurableObjectEventPublisher.publish` and `NodeEventPublisher.publish` both swallow with no
logger even injected: a persistently broken `WorkspaceEventsHub` DO or a serialisation throw
leaves every browser stale with zero log lines, indistinguishable from "no subscribers". The
Redis propagator proves the fix is one `log.warn` per class (`redisPropagator.ts:140-146`).

**D8: Local adapter contracts conflate distinct failure states. (P3)**
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

### Phase 1: Logging foundations (prerequisite for everything else): **LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                                                        | Fixes                                        | Sev | Status                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --- | ---------------------------------------------------------------------------------------- |
| 1.1 | Add a `Logger` port to kernel (`ports/logging.ts`: 4 levels + `child`, the shape the harness already declares); thread it through `CoreDependencies` and the facade containers; wire the pino logger in all three facades. A `noopLogger` default keeps construction cheap.                                                                 | A1                                           | P1  | ✅                                                                                       |
| 1.2 | Add `runBestEffort(label, fn, logger)` (kernel, beside the port) and convert the B1 table's sites to it: log-and-swallow, never rethrow. Give `MergeTrackRecordService` and the `RepoOp` ctx a logger dep.                                                                                                                                  | B1, D3, B8's sibling sites                   | P1  | ◐ helper + the highest-value sites; the long tail and the `RepoOp` ctx remain (see 1.2b) |
| 1.3 | Wire `LOG_LEVEL` for real: read `process.env.LOG_LEVEL` (Node/local) and a wrangler var (Worker) into the pino level; add level filtering to the harness logger; document in `.env.example`.                                                                                                                                                | A4                                           | P2  | ◐ backend done; the HARNESS half moves to 5.5 (image-bumping)                            |
| 1.4 | One-line cause recoveries: bind + log the poll error in `drive.ts` and append `(last error: …)` to the failure message (copy `ExecutionWorkflow`); log the two silent CF queue consumers (copy `handleTrackerSyncBatch`); `log.warn` in both realtime publishers; log every `WorkflowsWorkRunner` swallow and `buildWorkflowRuntime` retry. | B7, B5 (logging half), D7, D6 (logging half) | P1  | ✅                                                                                       |
| 1.5 | Process-level guards on Node/local: `process.on('unhandledRejection'/'uncaughtException')` (log structured, exit on uncaught), and `boss.on('error', log)`.                                                                                                                                                                                 | B4                                           | P1  | ✅                                                                                       |

#### What Phase 1 actually shipped

- **`kernel/src/ports/logging.ts`**: `Logger` (`debug`/`info`/`warn`/`error` as `(msg, fields?)`,
  plus `child`), `noopLogger`, and `createRecordingLogger` (a recording fake, shipped rather than
  duplicated per package, so a best-effort path's evidence is assertable everywhere).
- **`kernel/src/shared/best-effort.ts`**: `runBestEffort(logger, label, fn, fields)` and
  `describeError(error)` (message + constructor name, scrubbed through `redactSecrets`).
- **`@cat-factory/server`'s `observability/logger.ts`** is now the ONLY place a logging library is
  named: pino adapted onto the port, plus `createPinoLogger(destination?)`, `parseLogLevel` and
  `setLogLevel`. The level gate lives in the adapter, NOT on the pino instance: pino children
  snapshot their parent's level at creation, so a facade configuring `LOG_LEVEL` after module load
  would otherwise miss every logger already derived.
- **Every ad-hoc logger interface was retired** (the stopgap this initiative named): `PrReportLogger`,
  `PlatformMetricsSweepLogger`, `GitHubDocsLogger`, `OtelLogger`, `OtlpLogger`, `LangfuseLogger`,
  `ResetLogger`, `InfraSetupLogger`, `PlatformHealthSweepLogger`, `KeyFingerprintLogger`,
  `GateWiringLogger`, `DriveLogger`, `PropagatorLogger`, `RealtimeLogger`, plus the inline
  `{ warn(obj, msg?) }` shapes and the `log?: (event, msg) => void` callbacks on
  `RecurringPipelineService` / `TrackerWebhookService`. Both pino→port bridges
  (`node/src/keyFingerprint.ts`, the Worker's `keyFingerprintLogger`) were deleted: the shapes
  now match, so a `logger.child({ … })` is the whole adaptation.
- **~230 call sites migrated** from pino's `(fields, msg)` to the port's `(msg, fields)`. The
  signature change makes an un-migrated site a typecheck failure, so coverage is complete by
  construction.
- **A facade-parity gap surfaced while wiring**: the Worker's `buildWorkerCoreDependencies` passed
  no logger into `createCore` at all, so on the DEPLOYED runtime every domain service would have
  silently fallen back to `noopLogger`; putting exactly the best-effort paths this initiative
  exists to surface back in the dark. Both facades now wire it at the TOP of their dependency
  literal, next to each other, so the pair reads as the obligation it is.
- **Docs**: [`backend/docs/logging.md`](../../backend/docs/logging.md) (the patterns), a CLAUDE.md
  convention section, `LOG_LEVEL` in `docs/environment-variables.md` and all three deployment
  examples.

#### Notes for the next implementer

- **`runBestEffort` swallows a SYNCHRONOUS throw, `.catch(() => {})` does not.** A straight port of
  the old idiom at a site whose function can throw before returning a promise is a small behaviour
  change (for the better): worth knowing when converting the tail.
- **`layered-loader` keeps its own pino-shaped `Logger`.** `@cat-factory/caching` adapts ours onto
  it in `asLayeredLoaderLogger`; that is the one place the two conventions meet, and it should stay
  the only one.
- **`CoreDependencies.logger` is REQUIRED.** It was optional at first, and that is exactly how the
  Worker shipped with no `logger` key at all: an absent optional dep is silent by definition, and
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

### Phase 1b: Finish the conversion (the tail Phase 1 deliberately left): **LANDED**

| #    | Step                                                                                                                                                                                                                                                                                                                                                                          | Fixes  | Sev | Status                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- | -------------------------------------------------- |
| 1.2b | Convert the REMAINING `.catch(() => {})` sites to `runBestEffort`: the B1 table's `InitiativeLoopService` (6), `DeployerStepController` (2, leaked provisioning leases), `PublicApiController` (the half-created-run rollback), `RunDispatcher`/`review-kinds` issue-writeback hooks, and thread a logger into the `RepoOp` ctx so spec promotion stops being a silent no-op. | B1, D3 | P1  | ✅ backend non-harness is at zero                  |
| 1.2c | Add a lint rule banning `.catch(() => {})` and a bare `catch {}` in non-test source, so the tail can't regrow while it is being drained.                                                                                                                                                                                                                                      | B1     | P2  | ◐ a guard SCRIPT, promise-drop half only: see 1.2d |
| 1.4b | Bind a `child({ workspaceId, executionId })` in the remaining engine drivers that still pass ids inline per call (`ExecutionWorkflow`).                                                                                                                                                                                                                                       | A3     | P2  | ✅                                                 |
| 1.2d | Drain the ~110 bare `catch {}` blocks in `backend/packages` + `backend/runtimes` and extend the guard to them. Most are documented deliberate swallows, so this is per-site judgement (log / `describeError` / annotate), not a sweep, which is why it was split out of 1.2c rather than lumped into it.                                                                      | B1     | P2  |                                                    |

#### What Phase 1b actually shipped

- **`scripts/check-silent-catch.mjs`**, wired into CI's always-on `repo-guards` job. It is a
  SCRIPT, not the oxlint rule 1.2c specified: oxlint (1.75) ships no `no-restricted-syntax`, so
  the rule as written could not be authored. The repo already has this shape:
  `check-file-size.mjs` exists beside oxlint's `max-lines` for the same reason.
  - **Detection MASKS comments and string literals before matching** (`scripts/silent-catch.mjs`,
    fixtures in `silent-catch.test.mjs`, run by `node --test` in the same CI job). The first cut
    matched raw source and then asked whether the hit was in a comment, using a prefix heuristic:
    which read the `//` inside a URL as a comment opener, so `fetch('https://…').catch(() => {})`
    turned the guard off on precisely the line it exists to catch. Masking answers the question
    structurally instead of guessing, and the fixtures exist because a guard that regresses
    silently still reports green.
  - **Every spelling of an empty handler counts**: arrow or `function`, typed param or not, and a
    body holding only a comment. That last one is the important one: without it an author can
    document a swallow inline and never state a reason, which makes the escape hatch optional.
    Widening it immediately turned up two drops the narrow pattern had missed
    (`HttpMachineEventClient.publish`, the web-search query recorder), both now converted.
    `.catch(noop)` stays out of reach by design: whether a named function is empty is not a
    question a text scan can answer, and guessing makes a guard unpredictable.
- **The guard's scope is narrower than "non-test source", deliberately, and the gap is tracked:**
  - The **harnesses** (executor + deploy) are excluded, because a source change there bumps the
    published runner image: this initiative's own rule batches all harness work into slice 5.5.
    17 sites remain there.
  - The **SPA** is excluded: it has no logger to report through until client-side error reporting
    (6.5 / C8) lands. ~40 sites remain there, and they need a sink before they need a rule.
  - A **bare `catch {}`** is not checked. The audit above claimed there were none in non-test
    source; there are ~110 in this scope alone. Draining them is 1.2d.
- **An escape hatch with a mandatory reason**: `// silent-catch-ok: <why>` above the drop. Exactly
  one site uses it (`readiness.ts`'s late-rejection swallow, whose rejection the surrounding race
  already reports: logging it again would warn on every probe timeout).
- **`RepoOpContext.logger` is REQUIRED**, the same call the initiative made for
  `CoreDependencies.logger` and for the same reason: an absent optional logger is silent by
  definition, which is the failure mode. `specPromotionPostOp` now names each outcome: `debug`
  for the ordinary no-ops (nothing met, no `spec/` tree, a replay), `warn` only where a promotion
  was genuinely DROPPED (an unsafe shard, a throwing commit). That is D3 closed.
- **Three engine collaborators gained a logger they had no way to report through**:
  `RunDispatcher` (both issue-writeback hooks), `DeployerStepController` (both provisioning-lease
  releases; a leaked lease holds billed compute or a self-hosted pool slot, with no other
  symptom), and `InitiativeLoopService` (whose per-initiative isolation meant an initiative
  failing EVERY tick read as idle in the sweeper's aggregate counts).
- **Two `try { … .catch(() => {}) } catch {}` doubles collapsed** into one `runBestEffort`
  (`LlmObservabilityService`, `InstrumentedModelProvider`): the helper already covers the
  synchronous throw the outer `try` was there for.
- **One more local logger interface retired**: `warnOnGitHubPatProblemInBackground`'s
  `{ warn: (msg: string) => void }`, missed by Phase 1's sweep. Its test now uses kernel's
  `createRecordingLogger`.
- **`ExecutionWorkflow` binds `child({ workspaceId, executionId, workflow: 'execution' })`**, and
  its poll-failure messages are scrubbed with `redactSecrets` where they are minted: they are
  both logged AND folded into the run's user-visible failure text, and a `fetch` error routinely
  echoes the request URL back in its own message.

#### Notes for the next implementer

- **`runBestEffort` inside `waitUntil` is the shape to copy for post-response work.** The Node
  fallback in `makeWaitUntil` used to swallow, so a rejection from any controller's
  fire-and-forget telemetry reached the process-level guard with no idea which controller
  scheduled it.
- **A `.catch(fallbackValue)` is not a silent drop and the guard does not flag it**, but it still
  owes a `describeError`. `IssueWritebackService`'s claim read is the worked example: a store
  failure there reads as "someone else holds the claim", which silently suppresses the post.
- **Requiring a new context field is cheap and finds real holes.** Making `RepoOpContext.logger`
  required cost ~40 one-line test edits and nothing else, because every production construction
  site is in one file.
- **A guard's own blind spots are worth more attention than its findings.** Both extra drops this
  slice converted were found by WIDENING the detector, not by reading code, and the widening was
  prompted by asking what shapes the pattern could not express, not by a failure. Do the same for
  1.2d: the bare-`catch {}` sweep is a text scan too, and `catch (e) { /* fine */ }` will be its
  equivalent hole.
- **Bind the narrowed value to a local before a `runBestEffort` closure.** TypeScript drops
  property narrowing across a callback boundary, so `() => this.maybe!.thing()` is the shape that
  falls out naturally: an assertion resting on a guard several lines up, which nothing rechecks
  when that condition later grows a branch. `const x = this.maybe; if (x) …` costs one line and
  keeps the typechecker responsible for it.

### Phase 2 (Error identity survives the trip) **LANDED**

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
  no `detail`, so the container post-mortem (the only surviving account of why a container
  died) was dropped on the runtime where containers actually run.
- **The wire vocabulary is complete**: `UnavailableError` (503) / `UnauthorizedError` (401) /
  `RateLimitedError` (429) join the five existing `DomainError` classes, each carrying
  `details.reason`, with `errorHandler`'s status map and the persistence-RPC status map
  extended. The audit undercounted the hand-rolled envelopes: there were **113**, not ~40,
  across **68 files**; all are migrated.
- **The migration shape worth copying**: a controller-local
  `const unavailable = (): never => { throw new UnavailableError(…) }`. Because `never` is
  assignable to every declared response type, the ~90 `return unavailable(c)` call sites became
  `return unavailable()` with no change to their surrounding control flow, so the diff is
  mechanical rather than a per-handler rewrite. **Phase 2b then retired that shape**: see below.
- **`LlmProxyController` + `WebSearchProxyController` envelopes all carry a `code`** now
  (`upstream_unavailable` / `upstream_error` / `upstream_blocked` / `unavailable` /
  `unauthorized` / `validation` / `payload_too_large` / `spend_exhausted`), and the in-process
  call failure no longer echoes the raw SDK exception onto the wire: that text routinely
  carries the request URL or an auth header, and this response leaves the deployment. The cause
  is still logged and still recorded on the call metric, both of which scrub.
- **The inline LLM path now runs the SAME double gate as the proxy path.** `LLM_RECORD_PROMPTS`
  alone used to govern it, so a workspace with `storeAgentContext` off still shipped its inline
  prompt/response bodies to Langfuse/OTel: a privacy bug, not a coverage gap. The gate is a
  narrow predicate (`WorkspaceBodiesGate`) built by `createStoreAgentContextGate` in the shared
  server layer, so both facades wire it from one place.

#### Phase 2b: closing the same three holes structurally

Phase 2 fixed all three defects. Each fix, though, left the SHAPE that produced the defect in
place, so the next field/rule/copy could go missing the same way. 2b removes the shapes. No
behaviour changes.

- **`RunFailure` + its three derivations** (`orchestration/src/modules/execution/runFailure.ts`):
  `failureFromAdvanceError` / `failureFromResult` / `failureFromDriver`, now the only way either
  durable driver fails a run. Threading `reason` into two positional helpers left every parameter
  defaulted, so a call site that stopped short still compiled and still recorded `null`, which is
  indistinguishable from "no reason to report", and is why the original divergence survived
  review. With one shared value, a dropped field is a typecheck failure.
- **Two shared total accessors** (`server/src/http/guards.ts`: `requireCapability`, `requireUser`),
  the siblings of `param()`. The per-controller `requireX(c): Module | null` is what forced every
  route to restate `if (!x) return unavailable()`, and **51 controllers had each declared their
  own copy of the thrower** to satisfy it. Making the accessor TOTAL deletes the guard line at
  every route: ~300 call sites. Two throwers remain, both in `AuthController` and both correct:
  what they guard is a boolean FLAG (`cfg.passwordEnabled` / `cfg.githubEnabled`) and a rate-limit
  verdict, neither of which has a value to narrow.
  Each guard has an **`assert*` twin** (`assertCapability` / `assertUser`, plus a per-controller
  `assertXWired`) for the ~20 routes that need a capability WIRED but read nothing off it,
  because they call through the execution service instead. Those were the one class the sweep
  could not convert mechanically, and a discarded `require*` result is indistinguishable from a
  no-op statement: the next reader, or a mechanical "drop the unused call" pass, deletes the
  guard and no test fails. The `void` return type is what keeps the intent local to the line.
  A capability behind a capability (a library module's `sourceService`, wired only when GitHub
  is) gets its OWN accessor rather than a guard restated per route; so does one whose refusal
  message differs from its parent's (the environment self-test), or the message names a module
  the operator has in fact already wired.
- **`createStoreAgentContextGate` moved to kernel** (`shared/agent-context-gate.ts`) and is now
  the single implementation, consumed by BOTH `LlmObservabilityService` and
  `InstrumentedModelProvider`. Phase 2 gave the inline path a gate, but wrote the rule a second
  time in a second package: leaving the two free to drift exactly as they had. `agents`'
  `WorkspaceBodiesGate` is an alias of kernel's `StoreAgentContextGate` rather than a second
  declaration of the same signature.

#### Notes for the next implementer

- **`AuthController`'s signup hand-map was removed, but the reset-password one was KEPT.**
  They look identical and are not: signup flattening `ConflictError`/`ValidationError` onto one
  400 discards the code a client needs ("email taken" vs "password too weak"), while reset
  flattening `NotFound`/`Conflict`/`Validation` onto one message is deliberate; the distinct
  causes are an ORACLE for whether a reset token exists. Read the surrounding comment before
  "finishing" a flattening that looks like an oversight.
- **A controller that throws needs the app it is mounted on to have `onError`.** Both facades
  wire `app.onError(handleError)` at the root, so production was fine, but
  `VcsWebhookController.test.ts` built a bare `new Hono()` and every refusal became a 500. A
  controller unit test must mount the real handler now, not just the route.
- **The `Record<PersistenceErrorCode, number>` in `persistence/rpc.ts` earns its keep.** Adding
  three `DomainErrorCode` members failed `tsc` there until they were mapped, which is the only
  reason the machine-RPC status mapping stayed in step with the HTTP one.
- **`publicApiAuth.ts` / `PublicDecisionController`'s `fail` shapes were deliberately left
  alone.** They are a typed sum type (`{ fail: { status, code, message } }`) chosen so contract
  handlers stay typed against their declared response schemas: a different pattern from the
  hand-rolled envelope, and they already carry a `code`.
- **The inline body gate FAILS CLOSED but does not fail the export.** An unreadable settings row
  is not consent, so bodies are withheld, while the numeric telemetry still ships, because
  losing usage/timing for a store hiccup would trade a privacy bug for an observability one.
- **`LlmFragmentSelector` was the one inline site tagging no `workspaceId`**, so no workspace
  opt-out could ever apply to it. It had `context.workspaceId` in hand. When adding an inline
  LLM call, tag the workspace: the gate is only as good as the attribution.
- **The `code` slot is still being used as a REASON slot in ~20 places**, and that residue is
  NOT migrated: `too_large`, `no_run`, `invalid_body`, `invalid_cursor`, `pipeline_not_public`,
  `individual_model_unsupported` and friends are causes, not status classes. Each needs a status
  decision (413 and 402 have no domain class today) and each is a wire change for a specific
  client, so the work is "move the reason to `details.reason`, pick the class for `code`": worth
  doing when Phase 3.1's request middleware makes the `code` axis load-bearing for logging, not
  before.
- **The `null`-workspace answer is fail-OPEN, deliberately.** An untagged inline call has no
  workspace whose opt-out could apply, so the deployment switch alone governs it. The alternative
  (refuse, on the grounds that an unattributable call is precisely the one whose opt-out can't be
  checked) was considered and NOT taken: it turns a forgotten tag into silently missing trace
  bodies. Revisit it only together with a way to catch an untagged call at review time.

### Phase 3 (Correlation & request visibility) **3.1 + 3.2 LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                                                      | Fixes | Sev | Status |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| 3.1 | Request middleware on the shared Hono app: mint/propagate `x-request-id`, log method/path/status/duration at `info` (4xx at `warn` with the `DomainError` code), bind a request-scoped child logger. Extend `errorHandler` to include the request id in error envelopes so a user-visible error is greppable.                             | A2    | P1  | ✅     |
| 3.2 | Thread `executionId`/`workspaceId` into the container job body; the harness binds them into its `log.child` beside `jobId`. Give `ContainerAgentExecutor` a logger and log dispatch/poll transitions. Standardize `logger.child({workspaceId, executionId})` in the workflows/drivers.                                                    | A3    | P1  | ✅     |
| 3.3 | Propagate W3C `traceparent` across the CONTAINER boundary (into the job body), so the harness's own spans join the run's trace rather than being re-parented from outside it. HTTP server spans can follow as a separate slice. ~~Add real parent ids to the OTel/Langfuse mappings~~: done separately by the run/step span work, see C1. | C1    | P2  | ◐      |

#### What Phase 3 (3.1 + 3.2) actually shipped

- **`http/requestLogging.ts`**: `mountRequestLogging`, mounted by both facades as the FIRST
  middleware (ahead of CORS and the per-request container build, so a CORS denial and the
  Worker's misconfiguration fallback are logged like anything else). It adopts a bounded, safe
  `X-Request-Id` or mints one, binds `{ requestId, method, path }` on a request-scoped child
  logger, echoes the id on the response, and emits one line per request: `info` on success,
  `warn` on a 4xx, `error` on a 5xx.
- **Every error envelope carries `requestId`**, which is the whole point of the id: a user quotes
  what they were shown and an operator greps one line. `handleError` also stashes the code it
  mapped on the context so the request line names it, and now reports an unexpected fault through
  the REQUEST logger: the 500's own line and the envelope the caller received share an id.
- **The misconfiguration fallback is covered on every facade.** The Worker inherits the middleware
  (it serves the fallback from INSIDE `createApp`'s container-build middleware), but Node/local
  `serve()` the standalone `createMisconfiguredApp` instead, so that app mounts it and the
  expose-header itself. Without that, the one deployment shape an operator is actively debugging
  would be the only one with no ids and no request lines.
- **`X-Request-Id` joined both CORS lists**: `CORS_ALLOWED_HEADERS` so a caller that already has
  an id can propagate it instead of the backend minting a second one for the same request, and a
  new `CORS_EXPOSED_HEADERS` so a browser can actually READ it off the response (without
  `Access-Control-Expose-Headers` it is on the wire and invisible to the SPA).
- **The container seam correlates end to end.** `buildCommonBody` puts `workspaceId` +
  `executionId` on every agent job body; the harness parses them (optional) and binds them onto
  its per-job child logger beside `jobId`. Riding the job body means all three transports
  (Cloudflare container, local container, runner pool) carry them with no transport-specific
  wiring: the same reason `validationChecks` rides it.
- **`containerAgentLogging.ts`**: the seam's log vocabulary as a small collaborator
  (`ContainerAgentExecutor.ts` had 29 lines of headroom against its budget, so the messages and
  their rationale were extracted rather than the budget raised). `ContainerAgentExecutor` now logs
  dispatched / dispatch-failed / poll-failed / running (`debug`) / settled, with the ids bound once.
  A second extraction, **`agentContextRecord.ts`** (the observability snapshot's allow-list
  projection), ratcheted the file's budget 1520 → 1450 rather than growing it.
- **A dispatch or poll that THROWS is logged and re-thrown.** Those failure classes had no account
  anywhere: a failed dispatch never gets a handle, so no poll can report it, and a failed poll's
  transport fault was recorded against no job, backend or run.
- **Every `agent`-kind dispatcher carries the ids, not just the execution path.**
  `ContainerRepoBootstrapper` and `ContainerEnvConfigRepairer` hand-build their job bodies instead
  of going through `buildCommonBody`; a bootstrap is a first-class agent run (one `agent_runs`
  table, one retry surface), so leaving it out would have left exactly one agent flow whose
  container logs join to nothing. Neither has a separate execution row, so the job id doubles as
  the run id: matching the session token each already mints.
- **Two bare `catch {}` swallows in the executor became `runBestEffort`** (the agent-context
  snapshot write and the tool-span forward) now that the class has a bound logger to report
  through: 1.2d sites, drained here because they are in the file this slice gave a logger.

#### Notes for the next implementer

- **Do NOT set a response header on a 101.** Hono implements a post-`next()` `c.header()` by
  REBUILDING the response (`new Response(body, res)`), which silently drops the Cloudflare
  `webSocket` property, i.e. stamping the request id on the SPA's WebSocket upgrade would break
  the live event stream on the deployed runtime while every plain-HTTP test stayed green. The
  middleware skips 101 and the unit test pins response IDENTITY, not just the header.
- **A client-supplied correlation id is untrusted text that lands in a log stream.** It is adopted
  only when short and `[\w\-=]+`; anything else is replaced. Same reason the middleware logs
  `new URL(url).pathname` and never the raw URL: the WS `?ticket=` and OAuth `?code=` live in
  query strings.
- **`errorCode` on the request line is a bonus, not a promise.** It is set by `handleError`, so a
  controller that RETURNS a 4xx envelope instead of throwing a `DomainError` leaves it unset.
  That is one more reason to throw rather than hand-roll (see the `http/errorHandler.ts` note in
  `packages/server/AGENTS.md`).
- **3.2 is scoped to the AGENT job body, not the inline one.** A local inline container job
  (`LocalContainerRunnerTransport.runInline`) is minted with a synthetic `inline-<rand>` run id
  and its request shape carries no workspace/execution: correlating it is a change to
  `InlineContainerRequest` and its call sites, not to the harness.
- **3.3 is deliberately still open, and it is not "pass one more id".** _(Written when the
  platform had no span-id model at all. It has one now: the run/step spans of C1 give every
  generation and tool span a derived parent, so the half this note called the blocker is done.
  What remains is the CONTAINER boundary, and the reasoning below still holds for it.)_ A real
  distributed trace needs a span-id model the platform does not have yet (tool spans carry no
  parent span id today, and the trace id is an FNV hash of `executionId`), plus a harness change,
  so it batches naturally with 5.5 rather than paying a second image bump for the id alone.

### Phase 4 (Operational metrics, health, alerting) **LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fixes            | Sev |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --- |
| 4.1 | Extend `PLATFORM_METRIC` with the missing operational gauges/counters: runs re-driven/stalled/finalized per sweep, container dispatch failures + evictions, pg-boss queue depth (one `COUNT` per queue) ⇄ CF queue backlog where readable, dropped telemetry/notification batches, `AppCaches` hit/miss (a counter pair on the caching seam). Persist the per-run re-drive count (a column on `agent_runs`, D1 ⇄ Drizzle) so D4's question is answerable. | C3, D4           | P1  |
| 4.2 | `platform_health`: add a zero-throughput condition (no runs created in N hours where the trailing window had activity) and a failure-kind-dominant condition (e.g. >80% `evicted`/`dispatch`); alert when the sweep itself fails repeatedly.                                                                                                                                                                                                              | C5               | P2  |
| 4.3 | Harden readiness: real pg-boss round-trip (or last-maintenance-tick age) instead of the boolean; optional Redis + telemetry-store checks; decide and document the Worker story (a `/ready` that probes D1/TELEMETRY_DB bindings, or an explicit ADR that the platform relies on Cloudflare's own health).                                                                                                                                                 | C4               | P2  |
| 4.4 | Isolate retention pruning per table (per-table try/catch + one summary log naming failed tables).                                                                                                                                                                                                                                                                                                                                                         | C6               | P2  |
| 4.5 | Enable DLQs: uncomment + document the `dead_letter_queue` config in `deploy/backend/wrangler.toml`; add `deadLetter` to the pg-boss `createQueue` calls with a sweeper that logs/alerts on dead-lettered jobs.                                                                                                                                                                                                                                            | B5 (policy half) | P2  |

#### What Phase 4 actually shipped

The through-line: `PlatformMetricsRepository` answers "how are the RUNS doing" by aggregating
`agent_runs`, and it structurally cannot answer what an operator asks during an incident
(how often dispatch is failing, whether the sweeper is re-driving more than it was, whether the
queue is draining) because none of those are rows in a table. They are EVENTS. Phase 4 is
where they became countable.

- **A kernel `OperationalMetrics` port** (`ports/operational-metrics.ts`): a closed
  `OperationalCounter` union, an `OperationalGauge` union, `noopOperationalMetrics`, and
  `createOperationalMetricsCollector()`; an in-memory accumulate/drain pair. Both unions are
  CLOSED so adding a signal is a typecheck-visible decision, and the OTel mapping names each one
  through an exhaustive `Record`, so a new counter fails to compile until it has a metric name
  and a unit.
- **Counters are exported as DELTA sums, and that is load-bearing.** A collector is per PROCESS
  on Node and per ISOLATE on the Worker, and each flushes independently, which sums correctly in
  the backend only as a delta. `queue.depth` stays a real gauge (a reading, never accumulated).
- **`CoreDependencies.operationalMetrics` is REQUIRED**, for the same reason and with the same
  history as `logger`: an un-wired counter reads as a zero, and a zero here is the most dangerous
  value in the initiative; it says "no evictions" on a runtime where every container is dying.
- **The flush TIMING is the one deliberate facade difference.** Node drains on the
  platform-metrics sweep interval (one long-lived process, nothing lost between flushes); the
  Worker flushes at the end of EVERY invocation that recorded something, because an isolate is
  discarded without warning and a cron tick runs in a different isolate that saw none of it.
  Draining only on cron there would have zeroed everything the request and queue paths did.
- **Wired at every increment site named in C3/D4**: both stale-run sweepers (re-driven /
  finalized / stalled, dimensioned by run kind), EVERY sweep pass on both facades (`sweep.failed`,
  dimensioned by sweep), the container seam's dispatch failures and evictions,
  `CompositeTraceSink`'s dropped exports, the notification webhook's spent deliveries, and every
  app-cache read's hit/miss.
- **A sweep's rate and its STREAK are one call, and that is what keeps the facades together.**
  They shipped as two calls at each site and the runtimes immediately diverged: Node recorded a
  streak for every `startSweeper` sweep but only a counter for its two hand-rolled intervals,
  while the Worker recorded a streak for exactly one sweep and neither signal for the other
  fourteen, so `sweep_degraded` described a DISJOINT set of sweepers on each facade and a wedged
  retention cron on Cloudflare raised nothing. `SweepHealthTracker.recordFailure` now emits both,
  `SweeperOptions.health` replaces the raw metrics sink (a sweep site has no business holding
  one), and the Worker's `SweepTick` is the facade-symmetric twin of `startSweeper`: named pass,
  fixed failure message, outcome reported, no way to do half of it.
- **`SweepTick` also owns the cron tick's FLUSH ORDERING.** The Worker's collector is per isolate,
  so a counter a cron pass records can only be exported by a flush that runs after it; draining
  while the passes were still in flight left every cron-recorded counter waiting for a next tick
  in the same isolate: for the daily retention cron, a tick that never comes.
- **Dead-lettered jobs are a GAUGE, not a counter.** `queue.depth{state=dead_letter}` carries them.
  The counter this replaced was fed pg-boss's standing `totalCount` on an hourly sweep, so five
  dead-lettered jobs re-reported as ~120/day; deriving a delta from a level in memory would tell
  the same lie after every restart. The hourly sweep remains, for the log line naming the SOURCE
  queue: the metric says how many, the line says where to look.
- **`agent_runs.redrive_count`** (D1 0076 ⇄ Drizzle, with a conformance assertion). The sweeper's
  `orphanedSince` map holds a timestamp and dies with the process/isolate, and the Worker's sweep
  logs only aggregates with no run ids, so "was this run re-driven three times?" had no answer
  anywhere. Deliberately NOT rev-guarded and written AFTER the re-drive: it is bookkeeping about
  a recovery and must never be able to fail one.
- **`platform_health` gained three conditions** (4.2), all read off fields the projection already
  carries, no new SQL, no port change. `throughput_stalled` is the headline: every existing
  condition divides by runs and goes silent at `total = 0`, so a deployment that stopped
  accepting work read identically to a quiet one. It fires on trailing EMPTY trend buckets
  against a busy earlier half, so an idle deployment stays quiet, which is what keeps the alert
  from being muted before the night it matters. `failure_kind_dominant` splits 100% `evicted`
  from 100% `agent` (identical failure rate, opposite fixes). `sweep_degraded` alerts on the
  WATCHER, off a `SweepHealthTracker` streak the caller supplies.
- **`failure_kind_rate_high` completes the taxonomy half** (a later slice on the same read):
  per-kind rules an operator configures, `PLATFORM_ALERTS_FAILURE_KIND_RATES=evicted=0.05:3` or
  the same list per account. The dominant condition asks whether one cause is swamping the rest,
  which is a question about the SHAPE of the distribution; a per-kind rule asks whether a NAMED
  cause reached what a deployment tolerates from it, and 20% evictions never approaches
  dominance while being one run in five lost to the substrate. Two traps, both about identity:
  the reason code is SHARED by every rule, so the firing KINDS ride the card beside the reasons
  and are the other half of its dedup identity (evictions subsiding while timeouts take over is
  otherwise an unchanged firing set), and the rule's per-rule `minCount` is what makes a low
  ceiling usable at all, since `minRuns`'s five terminal runs with one eviction is already 20%.
- **Retention pruning is isolated per table** (4.4) through one shared `createRetentionPass`,
  because the passes were a chain of bare `await`s: the first failing `deleteOlderThan` aborted
  every later one, indefinitely, and the heaviest tables sit late in the chain. Isolation alone
  was not the fix: the pass also REPORTS `failedTables`, since a failed prune and an empty table
  both reclaim 0 rows and only one of them means the table is still growing.
- **Readiness** (4.3): the pg-boss check was a process-local boolean flipped only by a graceful
  `stopped`, so the one failure a readiness probe exists to catch (the substrate dying under a
  running process) reported healthy forever. It now also round-trips pg-boss's OWN pool. The
  Worker gained a `/ready` that probes its D1 + `TELEMETRY_DB` bindings; it is deliberately not a
  drain signal (there is no rotation to leave) but a bindings answer.
- **Dead-letter queues** (4.5): every pg-boss queue is created through `createQueueWithDeadLetter`,
  and an hourly sweep REPORTS what has landed there. Deliberately never a replay: a job that
  failed every retry will fail again, and an automatic replay turns a bounded loss into an
  unbounded loop.

#### Notes for the next implementer

- **Two dependencies are deliberately NOT probed by `/ready`, and the reasons are in the module.**
  Redis, because probing it per request means either a connection per probe or widening the
  propagator seam, and a dead bus degrades real-time, which a replica should keep serving HTTP
  through rather than drain on. The telemetry store, because on Node it is a SCHEMA in the same
  database the `SELECT 1` already reached.
- **A readiness probe cannot tell you a consumer is WEDGED**, only that its connection is alive.
  That is what `queue.depth` is for; do not try to fold it into `/ready`, which would drain a
  replica that is serving HTTP perfectly well.
- **Cloudflare Queues expose no backlog to the Worker consuming them**, so that facade emits no
  `queue.depth` series at all rather than a zero: an absent point says "nobody could look",
  where a zero says "the queue is empty". If Cloudflare ever exposes it, that is where it goes.
- **Dimensions must stay BOUNDED.** Every distinct value is its own time series in the operator's
  backend, so a run/workspace/job id is a cardinality explosion. The correlation ids belong on
  the log line, which is why every increment site also logs.
- **The sweep-failure streak is in-memory**, so it spans the process on Node and the ISOLATE on
  the Worker (an eviction resets it and the condition needs a fresh run of failures to re-arm).
  Same trade-off, in the same place, that `orphanedSince` already makes: it can only UNDER-report,
  so the failure mode is a missed alert rather than a false one.
- **Two files were at their size ratchet and were SPLIT rather than bumped**: the Slack tables out
  of `db/schema.ts` (1716 → 1700) and the binary-artifact storage pair out of the Worker's
  `container.ts` (1500 → 1470).

### Phase 5 (Execution-path forensics) **5.2, 5.4 + 5.6–5.8 LANDED**

| #   | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Fixes                       | Sev | Status                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --- | -------------------------------------------------------- |
| 5.1 | Post-mortem parity: pass `postMortem` to the local pooled poll (method already exists); have the CF container DO capture exit state + a scrubbed log tail and expose it on the eviction view; read `lastState.terminated` in the K8s transport; capture exit code + stderr tail in the native process transport. Pool eviction classification itself is stuck-run F4: land the visibility with it.                                                                                                        | D1                          | P1  | ✅ (no CF log tail: the runtime exposes none, see below) |
| 5.2 | Call `recordDispatchDiagnostics` **before** `startJob` so dispatch/preflight failures carry `lastDispatch`; stamp a minimal diagnostics block for inline steps.                                                                                                                                                                                                                                                                                                                                           | D5                          | P2  | ✅                                                       |
| 5.3 | Surface what's already persisted: `diagnostics.lastDispatch`, `firstEvictionDetail` (recovered runs), `evictionRecoveries`, and the new re-drive count in the SPA (an "investigation" disclosure on `AgentFailureCard` / the run panel). Frontend-only once 4.1 lands.                                                                                                                                                                                                                                    | D5                          | P2  |                                                          |
| 5.4 | Read `instance.status().error` into the `finalizeOrphan` stop reason; distinguish `instanceState`'s two swallowed error paths from genuine `missing` (log + treat repeated lookup failures as "unknown", not "missing", to prevent outage-triggered mass re-drives); warn once for an unconfigured workflow binding.                                                                                                                                                                                      | D6, D4                      | P1  | ✅                                                       |
| 5.5 | Harness slice (image-bumping, batch together): `uncaughtException`/`unhandledRejection` handlers that flush terminal `JobView`s before exit; attach `detail` (phase timings + breadcrumb) on clean-exit failures too; log the PR-description/effort-report read failures; scrub log fields through `redactSecrets` in the harness logger. Surface `coldStart` through `RunnerJobView` while in there (its FAILURE-path legibility already landed via the `detail` fold: what's left is the running view). | D2, D2.1, A5 (harness half) | P1  |                                                          |
| 5.6 | Persist inline LLM calls to `llm_call_metrics` via `LlmObservabilityService` (the instrumented provider gains an optional recorder dep) so `ObservabilityPanel` and `investigate-telemetry` see judge/consensus/inline-kind runs.                                                                                                                                                                                                                                                                         | C2 (coverage half)          | P2  | ✅                                                       |
| 5.7 | Close the two attribution holes 5.6 left: apply the instrumentation OUTSIDE any facade wrap that substitutes a resolved model (local mode's subscription-inline harness), through one composer that owns the order, and fall back to the credential scope's `executionId` (narrowed to a LIVE run) for a call whose tag names no run.                                                                                                                                                                     | C2 (coverage half)          | P1  | ✅                                                       |
| 5.8 | Make an inline step served by a harness CLI report PER CALL and LIVE: the model takes the facade's recorder, publishes each call off the CLI's `stream-json` as it arrives (reusing the container harness's own fold), and stands the instrumentation middleware down. Closes the three things 5.7 structurally could not: one lumped row for a whole tool loop, nothing at all until the subprocess exits, and zeros whenever it was killed.                                                             | C2 (coverage half)          | P1  | ✅                                                       |

#### What 5.2 + 5.4 shipped (and 5.1's pooled half)

One theme across three sites: **the record of a failure was being written by the thing that only
exists once the failure did not happen.** Each was a fact the platform had, discarded at the exact
moment it became the only fact anyone would want.

**5.2, the dispatch record now predates the dispatch.** `lastDispatch` was stamped from the job
HANDLE, which `startJob` returns only after a container has accepted the job, so the two failure
classes the block exists to explain (a container that never started, a preflight rejection like
`github_not_connected`) were precisely the ones that recorded nothing. The block is now opened
BEFORE the dispatch from what is already known (step index, agent kind, the model its ref resolved
to, the control-plane host) and refined afterwards by what only the accepted dispatch knows (the
repo it resolved, the model it confirmed).

- **The failure lands on the block too**, in the engine's own dispatch taxonomy
  (`failure.kind` + the `DomainError`'s machine-readable `reason`). The step already carries that
  verdict, but a retry of the step OVERWRITES it, and the diagnostics block is what survives to be
  read afterwards. PRESENCE is the signal, so there is no `succeeded` member to keep in step with
  anything, and a re-dispatch cannot inherit the last attempt's failure because opening the block
  REPLACES it rather than merging.
- **An inline step stamps one too, naming its backend `inline`.** Dispatching nowhere is why it
  used to stamp nothing, and the result was that a pure-inline run answered `diagnostics: null` and
  a mixed pipeline answered with whatever CONTAINER step ran last: a run reporting, confidently,
  that it was somewhere it had already left. `inline` is a distinct value rather than an absent
  `executionBackend` because absent already means "a container step whose first poll has not
  reported yet", and those two need opposite investigations.
- It costs no extra write. The pre-dispatch stamp rides the persist the cold-boot emit already
  does, the refinement rides the one after the handle lands, and the inline stamp rides the
  step's own settlement.

**5.4, the sweeper stops guessing.** `WorkflowsLookup` answered `missing` ("the instance was lost,
re-create it") for both of its throw paths, so a Workflows API outage read as every stale run
losing its instance at once and the sweeper re-drove the fleet with no log line to say why. It now
answers a PROBE (`{ state, detail }`) over a four-member state, and the fourth member is the point:

- **`unknown` is not a disposition, it is the absence of one.** Only an `instance.not_found` code
  is `missing`; any other throw, and an unreadable status, is `unknown` with the cause logged. The
  sweep takes NO action on it. Every action it has is destructive against a run that is actually
  fine (a re-drive is at best wasted work, a finalize stops the run outright), so an unclassifiable
  instance costs one tick of recovery latency where a guess costs a live run.
- **An `unknown` tick FORGETS the run's orphan clock rather than carrying it.** The run was not
  observed orphaned, and letting an outage age a deadline nobody could measure is how a Workflows
  incident would come out the far side as a batch of `stalled` runs. Same reasoning as the
  `orphanedSince` map itself: the deadline measures time-observed-orphaned, and an outage is not an
  observation.
- **Two more states were being read as `terminal` by fall-through**, which is the most destructive
  disposition available: Workflows' own `unknown` status (its "I cannot tell you" answer) and
  `waitingForPause` (an instance finishing its current work before parking, i.e. doing exactly what
  it was asked). The alive set is now explicit and the unknown one is routed away from the
  fall-through.
- **A terminal instance's own error reaches the run's stop reason.** `InstanceStatus.error` was
  destructured by nobody, so every run this branch settles carried the identical sentence about a
  driver that "ended without finalizing it". It rides `InstanceProbe.detail` into `finalizeOrphan`,
  scrubbed through `redactSecrets` and capped, because Workflows echoes the step's own throw and
  this lands on a run surface a person reads.
- **An unconfigured workflow binding says so, once per isolate.** It used to answer `alive`, which
  silently exempted that run kind from sweeping forever in a way indistinguishable from health.
  Once per isolate rather than per run per tick: the condition is a deployment fault that holds for
  every stale run of the kind, so repeating it would bury the one line that matters.
- **`sweep.run_state_unknown` is a new operational counter**, dimensioned by the bounded run kind.
  It is counted apart from the three dispositions because a blind sweeper looks exactly like a
  healthy one in all of them: nothing re-driven, nothing finalized, nothing stalled, and the stale
  runs simply sit there. The per-sweep log line reports it even when nothing else happened.

**5.1's pooled half.** `postMortem` was passed to the per-RUN local poll and not to the POOLED one,
though the method takes the same argument and a warm deployment is exactly where a long coding step
runs. The class of container death that pooling exists to make cheaper was the class reporting
nothing but the bare eviction sentinel. The rest of 5.1 (the CF container DO, K8s, the native
transport) is untouched and still open.

Passing the same argument turned out to be the wrong shape for a SHARED backend, which is the
gotcha for the remaining transports. `pollHarnessJob` falls to an eviction view down two branches,
and only one of them means the backend is gone: on `unreachable` it stopped answering and the
runtime confirmed it, on `job_unknown` it answered a 404 and is alive, having merely forgotten this
job. A per-run container serves one run, so reading it is safe either way; a pool member is already
serving somebody else, so a log tail lifted off it attaches another run's work (possibly another
repo's) to this run's failure, indistinguishable from a genuine tail. So the poll now reports which
branch it took (`EvictionCause`) and the pooled post-mortem states the situation instead of reading
a live member. **Any transport whose backend outlives one run owes the same distinction**; a
transport whose backend is per-run may ignore the argument, and the per-run local path does.

#### Notes for the next implementer (5.2 / 5.4)

- **The probe is a PORT-shaped answer now, not a string.** `SweepDeps.instanceState` returns
  `InstanceProbe`, and `finalizeOrphan` takes the cause as a second argument. A new sweeper over a
  durable driver copies that shape rather than re-deriving a three-state string, and a new state
  must decide explicitly whether it is actionable: the fall-through is what `unknown` and
  `waitingForPause` were both lost to.
- **Classifying the throw is what the whole backstop rests on, and the throw is NOT an `Error`.**
  `Workflow.get` is declared to reject with a plain `WorkflowError` (`{ code?: number; message }`),
  whose `code` is a NUMBER, so `instance.not_found` is only ever readable off the MESSAGE and only
  if the message is read off the object rather than off `Error.message`. Getting that wrong makes
  `missing` unreachable, and because `unknown` deliberately takes no action, the entire stale-run
  backstop stops acting with no failing disposition to show for it: nothing re-driven, nothing
  finalized, nothing stalled. `sweep.run_state_unknown` is the only signal that separates it from a
  healthy fleet, which is the reason it is counted. The classification is also applied to the
  `status()` throw, not just `get`'s: the handle is lazy, so a lost instance surfaces from either.
- **This is CF-only on purpose** (the tracker's runtime-symmetry note): Node's stale-run sweeper
  probes pg-boss, which has no analogous swallow. The `lastDispatch` half IS runtime-neutral
  (engine code) and is pinned by conformance on both facades.
- **5.3 is now worth more.** It renders `diagnostics.lastDispatch` in the SPA, and the block it
  would render is no longer absent on exactly the failures a person opens that panel for.
- **The `failure` object is additive on the public API** (`info.version` → 1.29.0), but the
  POPULATION changed: a pure-inline run used to answer `diagnostics: null` on the debug overview
  and now answers a block. A consumer reading "no diagnostics" as "no agent work happened" reads
  differently, which is stated in the spec's version note rather than left to be discovered.

#### What 5.1 finished (the three remaining transports)

The pooled half established the rule; this slice applied it everywhere a container can die. One
theme: **each transport already held the evidence and threw it away at the moment it became the
only evidence there was.** A dead container's account of itself is readable exactly once, and
every one of these read it never.

- **Cloudflare (the deployed runtime, and the reason D1 was a P1).** `onStop` recognised a
  rollout drain and discarded everything else, so an OOM-killed agent reached the operator as
  `Job not found (container evicted or crashed)` and nothing more. The container now records
  `{ exitCode, reason }` for EVERY stop, and the transport attaches it to the eviction `detail`.
  - **The stop record grew a second, independent half, and independence is the point.** The
    `cause` (rollout / idle) decides the recovery BUDGET; the `exit` state decides the DETAIL.
    They are attributed on separate windows and read separately, because a record too old to
    excuse an eviction as churn is still the only account of how the container died, and a crash
    is by construction the case with NO cause to name. Folding them together would have meant the
    diagnostic existed only for the deaths that least needed one.
  - **Recording it changes no verdict.** A cause-less stop still reports `evicted: 'crash'` and
    still spends the crash budget (stuck-run F12's whole mechanism is untouched); it merely says
    how.
  - **The two hooks MERGE rather than overwrite.** One stop reaches the container through
    `onError` (which recognises the churn and knows no exit code) and `onStop` (which carries the
    exit code and cannot name the churn), in either order and sometimes both. The pre-existing
    write was an overwrite, so whichever landed second silently discarded the other's half. A
    CLAIMED record is never merged onto: it has already explained somebody's eviction.
  - **The "scrubbed log tail" the plan asked for does not exist on this runtime.** A Cloudflare
    Container's stdout is delivered to the deployment's Workers logs and no API returns it to the
    Durable Object. The detail says so, rather than leaving an operator to look for a tail here
    that was never withheld.
- **Kubernetes: `state.terminated` was one GET away and never read.** The pod OBJECT outlives its
  workload (`restartPolicy: Never` leaves it Failed until `release` deletes it), so the 404 poll
  is the last moment the kubelet's account is readable. `describePodTermination` reads
  `state.terminated`, falls back to `lastState.terminated` for a container between lives (where a
  crash loop's real cause sits), and adds the POD-level `reason`/`message` on top rather than
  instead: a kubelet eviction under node pressure names itself only there, and the container never
  saw it. `OOMKilled, exit code 137` is what pays for the whole function.
  - **Three outcomes, not two.** A pod GONE from the apiserver, a pod that could not be READ, and
    a pod that reports a termination need different investigations, and reporting the first two as
    an absent detail would make an unreachable control plane read exactly like a clean death. The
    read never throws and never returns silence for a failure to look.
- **The native host-process transport was spawned `stdio: 'ignore'`**, so a harness that died
  mid-job left neither exit code nor output: not to the run, not even to the developer's console.
  stderr is now piped into a bounded ring (nothing is forwarded onward, so the console is exactly
  as quiet as before) and the last process's exit is retained past the handle, which is dropped on
  `exit` while the poll that needs it runs afterwards.
  - **This backend outlives a run**, so it owes the pooled slice's distinction and takes it: the
    tail is attached on `unreachable` (the process is confirmed gone, and it took every concurrent
    job with it, which is worth saying) and withheld on `job_unknown` (it ANSWERED, so it is alive
    and serving other runs).
  - **The same tail is folded into a dispatch that never got the harness healthy**, lazily, so a
    healthy boot pays nothing. A harness that will not boot at all (a bad `LOCAL_HARNESS_ENTRY`, a
    port clash) says why on stderr and said it to nobody.
- **`composePostMortem` (kernel) is the one place the two obligations live**: scrub with
  `redactSecrets`, then cap and SAY what was dropped. Four sites compose through it now. It was a
  two-line idiom restated per transport, which is how a fifth transport ships a `detail` that is
  neither scrubbed nor bounded, and the cap keeps the HEAD so a caller's one-line verdict always
  survives its own log tail.

#### Notes for the next implementer (5.1)

- **A transport whose backend outlives one run must pass `postMortem` and honour its
  `EvictionCause`.** That is now three transports deep (local pooled, native process, and the
  reasoning applies to any future shared backend); a per-run backend may ignore the argument, and
  the per-run local path and the K8s pod both do.
- **An exit code is not a signal name, and `128 + n` is not a decoding.** The Cloudflare wording
  uses a two-entry map (137, 143) rather than deriving one, because an application exit code that
  merely exceeds 128 would otherwise be labelled with a signal that never fired.
- **Recording something on EVERY stop is what made the merge necessary.** Before this, the record
  was written on exactly one condition, so nothing ever raced it. If you add a third observer of
  the same stop, merge onto the unclaimed record rather than adding a second key.
- **`pollInlineJob` still has no `evicted` field**, so a local inline container job that dies is
  reported as a plain failure rather than an eviction. It was out of scope here because the fix is
  a shape change to `InlineJobView` and its consumers, not a post-mortem.

#### What 5.8 shipped

An inline step on a harness CLI is not one model call. `doc-researcher` on a host `claude` login
runs a tool loop (a measured run made 16 calls over 8 minutes) behind ONE `doGenerate`. The
middleware wrapped around that boundary is therefore structurally unable to tell the truth about it,
in three different ways at once, all of which 5.7's attribution fix left in place:

- **One row for sixteen calls.** `message_count` 2 and `tool_count` 0 on a row whose loop used tools
  all the way through; `total_ms` 497316 for "one call"; the fifteen intermediate turns' bodies
  nowhere. The container transport threw its `callMetrics` away for the same reason: nothing on
  `InlineCliResult` could carry them.
- **Nothing until the subprocess exits.** `wrapGenerate` is a post-hoc hook with no `wrapStream`
  sibling, and `spawnCliExec` settles only in `child.on('close')`. So a run reported zero calls for
  its entire 8 minutes, which is exactly when someone is looking.
- **Zeros on a kill.** The error path passes `result: undefined` to `emit`, so `readUsage(undefined)`
  returns all-zero and the burn survives only in the free-text `error_message` (through the lossy
  `formatTokens`, so `896.7k` is not even recoverable as an integer). 5.6's row for a killed
  `doc-researcher` read `total_tokens 0` beside a message saying it had burned 896.7k.

The fix inverts who reports: `CliInlineLanguageModel` takes the facade's `InlineLlmCallRecorder` and
files each call the CLI reports, as it arrives, then declares `reportsOwnLlmCalls` so
`InstrumentedModelProvider` returns it unwrapped instead of adding a duplicate. Notes:

- **The per-call fold is IMPORTED, not re-written.** Claude Code emits one envelope per content
  BLOCK, each repeating that call's usage, so folding by `message.id` first is the difference between
  31 calls and 117 (1.47M tokens inflated to 5.53M). The container harness had solved that, plus the
  prompt-transcript reconstruction and the routing of subagent turns off the parent's chain; local
  carried a lesser copy of just the usage half. It now drives `createClaudeRunTelemetry` through the
  new `@cat-factory/executor-harness/claude-call-aggregator` subpath, so there is one implementation
  and both transports agree on what a call is.
- **Sharing it made the backend a second DRIVER of that reconstruction, which had only ever run in a
  container.** In a box sized for one job, holding the growing history and re-serialising it per call
  costs nothing anyone notices; in the orchestrator process it is per concurrent inline step, on
  exactly the long tool loops this work exists for: the fault `OUTPUT_TAIL_RETAIN_CHARS` already
  refuses one screen away in the same file. So the transcript is retained only to
  `MAX_TRANSCRIPT_CHARS` (512 KiB, the store's own `MAX_BODY_CHARS`: past that, retention could only
  ever be thrown away), freezing the tail and STATING what it stopped retaining rather than ending
  mid-conversation; and assembling bodies at all is a switch, off when `LLM_RECORD_PROMPTS` is. These
  bodies are the one kind that is BUILT rather than passed as a thunk, so the usual "let the gate drop
  it" answer does not apply: the refusal has to happen at the source.
- **The step-level row carries the SHORTFALL, not a lump.** Terminal cumulative usage minus what the
  per-call rows accounted for, per input class, which is one rule for three cases: `codex exec`
  narrates nothing ⇒ the whole step, as the single row the SDK boundary knows; a fully-narrated step ⇒
  nothing (a row there would double every token); a PART-narrated step ⇒ the remainder. That third
  case is the one an "aggregate only when nothing was costed" rule got wrong: an older CLI build, or a
  turn that errored before reporting usage, left its spend recorded by nothing at all. The container
  harness answers the same case differently (`attributeCumulativeUsage` pins the run total onto the
  last call, keeping a row per turn), so this is stated as its own row and the inconsistent narration
  is logged rather than described as mirroring it. An uncosted turn is never filed as a zero-token row,
  and that rule lives with the MODEL, so it holds for the host CLI's stream and a container inline
  job's terminal `callMetrics` alike.
- **A killed step still gets a failure row**, at the ordinal after the last completed call, with zero
  tokens, which is now TRUE of it (it stands for the interrupted call, and everything the run did
  spend is already recorded call by call) rather than a claim about the whole step. Every fold step is
  isolated for the same reason: the reader runs inside the spawn's `stdout` listener, and its flush on
  the killed path runs BEFORE the failure is enriched with the burn clause, so a throw there would
  replace the CLI's own failure with a telemetry error.
- **Each row names the model that SERVED the call** (`call.model ?? requested`), matching
  `makeHarnessCallRecorder`. Cost is derived per row from `(model, token classes)` and a CLI serves
  some calls with a cheaper model of its own, so filing them all under the requested id misprices them.

**Deliberately still open: the spend LEDGER.** `token_usage` is written from the agent result's
`usage` on the success path only (`RunDispatcher`), so a failed step still writes no ledger row on
either transport and the budget rollups stay blind to what it burned. Closing that needs the
failure-path recording seam in orchestration that 5.6's predecessor already scoped, covering the
container path in the same change, not a fourth pass over the inline provider. Related and separate:
an inline call served by the developer's own AMBIENT login is currently ledgered
`billing: 'metered'` with no vendor, so it charges the workspace's monetary budget for tokens that
cost nothing; the container path tags such a step `'subscription'` and the inline executor does not.

#### What 5.6 shipped

- **`InstrumentedModelProvider` gained a second exit**, the kernel `InlineLlmCallRecorder` port,
  implemented by orchestration's `makeInlineCallRecorder(service)`: the sibling of
  `makeHarnessCallRecorder`, feeding the SAME `LlmObservabilityService`. So all three producers
  (proxy, subscription harness, inline) now converge on one store, and an inline agent kind,
  judge, consensus round or requirements-writer call shows up in `ObservabilityPanel`, in a
  step's token rollup and in `/api/v1/debug/*` alongside container calls.
- **EXACTLY ONE exit runs per call, and that is the load-bearing rule.** The service already
  fans a recorded call out to the trace sink, so a provider that took both exits would double
  every inline generation on Langfuse/OTel. The composed sink therefore goes to the RECORDER's
  service, and the provider's own `traceSink` is left for the calls the recorder structurally
  cannot take: an inline call tagged with no `workspaceId` has no row to be filed under, and
  the metric store is workspace-scoped. A provider wired with neither exit now throws at
  construction: it would otherwise pay the middleware, reach nothing, and still satisfy the
  facades' `instanceof InstrumentedModelProvider` wiring assertions.
- **Neither facade assembles that pair by hand.** `createInlineInstrumentation`
  (`@cat-factory/server`) builds the recorder's service and the provider's fallback sink from
  ONE `traceSink` argument, because the invariant above is otherwise enforced only in prose:
  passing the two halves DIFFERENT sink instances typechecks and merely splits the trace. It
  also collapses the ~25 lines of near-identical wiring the two facades would each carry, and
  is what the Node `InlineInstrument` type now aliases rather than restating.
- **The body gate moved to ONE side.** A recorded call passes its bodies through UNGATED and the
  service applies `LLM_RECORD_PROMPTS` + `storeAgentContext`: the same rule from the same kernel
  factory, plus `redactSecrets` and the prompt delta chain. Re-gating in the provider would have
  withheld text the store is entitled to keep and reinstated the two-places-one-rule shape that
  produced the privacy half of C2 in the first place. The bodies cross as THUNKS
  (`InlineLlmCallBody`) and `record` resolves its gate BEFORE touching one, so keeping the rule
  on the far side costs a prompts-off deployment nothing: it never serialises the AI-SDK prompt
  array (on a judge or a reviewer: a rubric and a diff) that the next line would discard.
- **The harness recorder's own gate was open, and is closed here.** `makeHarnessCallRecorder`'s
  service was built with no `workspaceSettingsRepository` on EITHER facade, which makes
  `createStoreAgentContextGate` return a constant `true`, so a subscription harness's full
  `stream-json` prompt and response were retained for a workspace that had opted out. That is
  the privacy half of C2 in a second place, unnoticed because the gap is silent by construction;
  both facades now thread the repository (and, on Node, the settings cache slice).
- **The mapping states what an inline call does NOT know**, rather than filling proxy-shaped
  fields with plausible values: `turnIndex` null (no job-scoped counter), `httpStatus` null (the
  SDK owns the transport, so a failure arrives as an exception whose message is the cause),
  `phase` `''` (phases are boundaries the container harness owns; an inline call sits outside
  all of them), `streaming` false, and `upstreamMs === totalMs` so the derived overhead is a real
  0 instead of a fabricated transport split. Conformance pins all of these on both runtimes'
  real stores, because each is one a store could plausibly flatten.
- **No new bucket decision.** `llm_call_metrics` is already `telemetry` (local-first) for
  mothership mode and no repository METHOD was added, so the Node wiring threads
  `repos.llmCallMetricRepository` from the composition root rather than rebuilding it off `db`:
  which is what makes a mothership node write to its routed local store.

#### Notes for the next implementer (5.6)

- **A failing inline call records too.** It is the row an operator goes looking for, so the
  middleware's catch path feeds the recorder with `ok: false` and the exception message before
  rethrowing: the exception itself still propagates untouched.
- **Test the readers against the SDK's OWN mock, never a hand-rolled result.** The feeder's
  readers parse `unknown`, so a stand-in built to the shape the reader expects proves nothing.
  Consolidating both provider suites onto `MockLanguageModelV3` + a real `generateText`
  immediately surfaced a live one: `finishReason` is `{ unified, raw }` in the current spec, not
  a bare string, so every inline call had been exporting a null finish reason to the trace
  sinks. That failure mode is silent by construction: a null there is indistinguishable from a
  provider that reported nothing.
- **The `null`-workspace fallback is the same deliberate fail-open as Phase 2b's**, for the same
  reason and with the same caveat: an untagged inline call is a missing tag, not a policy. It now
  costs a missing metric ROW as well as missing trace bodies, which makes tagging
  `catFactoryObservability({ workspaceId })` at a new inline site that bit more load-bearing.
- **Cost lands where the calls do.** Every inline call now costs a chain-tip read plus an insert,
  off the response path (`runBestEffort`, never awaited by the caller). That is the same profile
  the proxy has always had per call; the inline sites are far lower volume than a container
  agent's turn loop, so no new sampling was introduced.
- **Wiring drift is what the per-facade specs guard.** Conformance asserts the recorder → real
  store round trip but bypasses the model provider entirely (fake executor), exactly as it does
  for the trace sinks, so `inline-call-metrics-wiring.spec.ts` sits beside
  `langfuse-wiring.spec.ts` / `otel-wiring.spec.ts` and pins the case those never had to
  consider: a deployment that retains metrics and wires no external backend at all, which is the
  DEFAULT shape.
- **One inline path was left uninstrumented and is closed by 5.7 below**: local mode's
  `SubscriptionInlineModelProvider` (`runtimes/local/src/harnessInline.ts`) wraps the resolver
  OUTSIDE the instrumented provider and serves a subscription ref from the developer's own CLI
  or a warm container, so the middleware never saw it. It was equally invisible to the trace
  sinks before this slice, so nothing regressed, but deferring it meant 5.6 read as "inline
  calls are recorded" while the DEFAULT local deployment recorded none of them.

#### What 5.7 shipped

Reported as "a document-writing agent still records zero calls" after 5.6. Two independent
causes, both of which record a call the store then cannot be asked for.

- **The instrumentation was the INNERMOST provider wrap, and had to be the outermost.** It lived
  inside `createScopedModelProviderResolver`, so the composition ran base → instrumentation →
  facade wrap → limiter. The instrumentation is an AI-SDK middleware around a resolved model, so
  it only ever sees what the wrap BENEATH it returned, and local mode's
  `SubscriptionInlineModelProvider` answers a subscription harness ref with its own
  `CliInlineLanguageModel` rather than delegating downwards. Result: with `LOCAL_NATIVE_INLINE`
  on (the default), every inline step on a host `claude`/`codex` login recorded nothing, while
  the same step on a metered API model recorded fine; the hardest shape of this bug to notice,
  because the feature demonstrably works on the deployment you test it on. **The order is now
  owned by ONE composer, `wrapResolverWithTelemetry(resolver, { instrument, limiter })`**, and the
  two wraps it applies are no longer individually exported: a facade passes its own wraps in
  first, and the composer puts the instrumentation on top of them with the limiter outermost (so a
  queue wait is never counted as generation time). Two facades restating the order in comments was
  the first cut, and it is the same mistake `createInlineInstrumentation` exists to prevent for the
  recorder/sink pair: the wrong order typechecks and still records every non-substituted call, so
  nothing fails until it is the deployment nobody tested on.
- **No usage lifting was needed after all.** The 5.6 note assumed this fix would have to read
  usage off the CLI; #1521 had already made the `claude` runner stream `stream-json` and report
  the three input classes, and the warm-container path reports the same shape, so both branches
  feed `readUsage` correctly the moment the middleware is above them.
- **Run attribution now comes from the credential scope when the tag omits it.** Only
  `AiAgentExecutor` and consensus passed `executionId` to `catFactoryObservability`; the other
  ten inline sites tagged the workspace alone, so their rows landed with `execution_id = NULL`:
  in the store, and absent from `listByExecution` / `summarizeByExecution`, a step's token
  rollup and `/api/v1/debug/runs/*`. That reads as a step that spent nothing, which is a worse
  failure than an unwritten row. Every run-scoped inline caller already resolves the block's run
  into its `ModelScope` (it must, or a per-run subscription activation could not be leased), so
  the telemetry wrap threads `scope.executionId` in as the fallback. Fixing it there rather than at
  twelve call sites is deliberate: the scope is load-bearing for credentials, so it cannot rot,
  whereas a per-call tag is a rule each new site must remember, and the ten that forgot are the
  evidence.
- **A per-call tag still wins**, because a scope is per-provider while a tag is per-call and
  consensus fans one scope out across participants. Both absent ⇒ null, unchanged, for the
  genuinely un-run-scoped callers (the document planner, a bug-hunt rating, a fragment title).
- **The scope had to stop naming a SETTLED run before it could be trusted for attribution.**
  `resolveBlockRunContext` read `block.executionId` unconditionally, and nothing clears that
  pointer when a run finishes (the board reads it to show a task's last run), so "the block's
  active run", which both the port's doc and the fallback's premise claimed, was really "the
  block's last run". Every current `scopeForBlockRun` caller runs mid-run or during a park, so
  this was latent; making the scope an attribution source is what turns it into a hazard, because
  a stale id lands the call in a FINISHED run's rollup and `/api/v1/debug/runs/*` and, unlike a
  null, looks right to whoever reads it. It now gates on `LIVE_EXECUTION_STATUSES`: the same
  constant `listLive` / `countActiveByWorkspace` use, so a status added later must be classified
  there rather than defaulting to live, and KEEPS the initiator, which is a durable fact the
  API-key pool and a user's local endpoints scope by. It also improves the credential path it was
  written for: a per-run activation is cleared at terminal, so leasing against a settled id could
  only fail, and confusingly (the id looks valid).
- **The one live run-path caller the scope could not reach was fixed at the source.** A fragment
  BRIEF is generated during a dispatch, but `LlmFragmentBriefGenerator` built a workspace-only
  scope, so the run is now carried on `FragmentBriefGeneratorInput` from the engine's context
  builder. `LlmFragmentBriefGenerator` deliberately carries the run WITHOUT an initiator: a
  condensation is platform bookkeeping the engine triggers, not work a person asked for, so there
  is nobody to name, which also means it cannot run on an individual-usage subscription, the same
  refusal it gave before and the right one. `LlmFragmentSelector` has the same shape and was left
  alone: `resolveForRun` is retired from the run path, so widening its port would have been dead
  code. That chain crosses four optional hops, none of whose omissions fail loudly (the brief is
  still folded, its spend just goes unattributed), so each hop is asserted:
  `AgentContextBuilder.fragments`, `FragmentLibraryService`, `FragmentBriefService`.
- **The ordering is pinned twice, in the two places it can be.** Structurally beside the composer
  (`server/src/agents/modelProviderResolver.test.ts` asserts facade wrap → instrumentation →
  limiter by reaching into who wraps whom, no generation to drive, so nothing to rot at an SDK
  spec bump), and behaviourally where a substituting wrap actually exists
  (`local/src/harnessInline.test.ts` drives a real call through the same composer, including the
  killed-CLI case from #1521 and the scope fallback). Conformance cannot reach either: it bypasses
  the model provider via the fake executor.

### Phase 6: Hardening & polish

| #   | Step                                                                                                                                                                                                                                               | Fixes           | Sev |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --- |
| 6.1 | Default timeouts on the VCS clients (an `AbortSignal.timeout` per request, generous, e.g. 60s) and honour `Retry-After`/`resetAt` with one bounded retry on rate-limited GETs; give `safeFetch` a default per-hop deadline overridable by callers. | B6              | P2  |
| 6.2 | Per-item isolation in both stale-run sweepers (per-run try/catch, log the run id, continue the pass).                                                                                                                                              | B7 (sweep half) | P2  |
| 6.3 | Unify `redactSecrets`: kernel copy as source of truth, harness/deploy-harness copies conformity-pinned byte-for-byte (the `host-markdown.ts` pattern).                                                                                             | A5              | P3  |
| 6.4 | Local adapter fidelity: distinguish "no logs" from "logs unreadable" and "inspect failed" from "still running"; warn once on Apple's reduced fidelity; count swallowed `remove()` failures.                                                        | D8              | P3  |
| 6.5 | Minimal client-side error reporting: a Nuxt global error handler posting to a backend endpoint (workspace-scoped, rate-limited, scrubbed).                                                                                                         | C8              | P3  |

## Conventions & gotchas for implementers

- **`.catch(() => {})` is guarded, not just discouraged.** `scripts/check-silent-catch.mjs` fails
  CI on a new one in `backend/packages` / `backend/runtimes`; a genuinely-silent drop annotates
  itself with `// silent-catch-ok: <reason>`. The harnesses and the SPA are out of that scope on
  purpose (see Phase 1b): do not "fix" a site there ahead of its own slice, because a harness
  edit bumps the runner image.
- **The logger port has landed** (`kernel/src/ports/logging.ts`); the B/D fixes in domain packages
  are no longer blocked. Take a `logger?: Logger` dependency and normalise once
  (`this.log = deps.logger ?? noopLogger`); never import `@cat-factory/server` into a domain
  package, and never declare a local logger interface: every one of those has been retired.
  Patterns: [`backend/docs/logging.md`](../../backend/docs/logging.md).
- **Best-effort stays best-effort.** Every fix to a swallow site adds a log line and/or counter;
  it must never let the failure propagate into the caller. The PR-verification-report rule
  ("observability must never break agent work") applies to all of it: including the new
  observability itself (per stuck-run-audit: don't create a new class of silent background
  failure while building the thing that watches for them).
- **Runtime symmetry**: 2.1's reason-threading, 4.1's counters, 4.4's pruning isolation, and
  5.2's diagnostics all touch engine/facade seams; land Worker + Node together with a
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
  work to the surfaces [ADR 0048](../../backend/docs/adr/0048-platform-operator-observability.md)
  describes. Update the other document rather than widening a slice here.
