# LLM telemetry & agent-context observability

> **Operators read this on the website**:
> [Observability](https://www.catfactory.ai/operate/observability.html) owns the dashboard, what
> each capture setting does and how to read a run; retention windows are on
> [Upgrades & Data Retention](https://www.catfactory.ai/operate/upgrades-and-retention.html). This
> page is the INTERNAL account: the sinks, the producers, and the rules a new recording path has
> to keep.

Four sinks live in a dedicated telemetry store, separate from the transactional domain
(append-heavy, high-volume, short-retention): a required `TELEMETRY_DB` D1 database on Cloudflare
and a `telemetry` Postgres schema on Node, all pruned to `LLM_CALL_METRICS_RETENTION_DAYS`.
Parity is asserted by `defineAgentContextSuite`, and Cloudflare fails fast at build if
`TELEMETRY_DB` is unbound. Gaps and the plan to close them:
[`observability-logging-gaps.md`](../../docs/initiatives/observability-logging-gaps.md).

The sinks:

- **`llm_call_metrics`**: per LLM call.
- **`agent_context_snapshots`**: the complete context an agent was PROVIDED per dispatch,
  including the full content of injected `.cat-context/*` files, which the agent reads via tools
  and which therefore never reach proxy telemetry. A redacted allow-list projection, never a
  token or credential-bearing URL. Filed by BOTH executors: a container dispatch records its job
  body's projection, an inline one records the prompts it composed plus an empty file list (an
  inline call has no checkout to inject into). Wiring only the container half is what once left
  every companion and inline document kind absent from this table, and the one reader that notices
  (`KaizenService`) blamed a disabled switch for it. **Still absent: the services that call
  `generateText` themselves rather than through an agent-kind dispatch** (the judges, the
  requirements and clarity reviewers, the tester-quality reviewer, the bug-hunt assessor, the
  document interviewer, Kaizen's own grader). Each composes its prompts at its own call site, so a
  snapshot there is a separate piece of work; a step of one of those kinds reads as "no snapshot
  available", which is why that message names no cause.
- **`agent_search_queries`**: one row per web search a container agent PERFORMED.
- **`agent_tool_calls`**: one row per tool invocation an agent MADE, in the order it made them:
  the TRAJECTORY. Where the snapshot keeps what an agent was given and `llm_call_metrics` what
  each model call cost, this keeps what it did with them, which is the half of "how did this diff
  come about" that neither a diff nor a prompt body answers. See the section below.

The deployment-level projections (`gate_outcomes`, `platform_run_days`) deliberately live in the
MAIN store, not here; their rules are in
[ADR 0048](./adr/0048-platform-operator-observability.md).

## Three producers converge on the ONE `LlmObservabilityService`, and a new one must too

The proxy; the subscription harnesses (Claude Code / Codex bypass the proxy, so the harness lifts
metrics off each CLI's event stream); and INLINE calls, through the kernel
`InlineLlmCallRecorder` port. An inline call SERVED BY a harness CLI is both at once (it reaches
the store through the inline port, carrying per-call rows lifted off the CLI's stream), which is
why the model owns them and the instrumentation stands down (below), not a fourth producer.

## The provider takes EXACTLY ONE exit per inline call

`record` already fans out to the external trace sink, so a recorded call must NOT also hit the
provider's own `traceSink`: that doubles every inline generation on Langfuse/OTel. A facade never
assembles the pair by hand: `createInlineInstrumentation` builds both exits from ONE sink
instance. Bodies reach the recorder as THUNKS, so a prompts-off deployment never pays to
serialise a prompt the gate is about to drop.

## The wrap ORDER is owned by one helper

The inline instrumentation is a middleware around a RESOLVED model, so it only ever sees what the
wrap beneath it returned, and one facade wrap SUBSTITUTES that model. It shipped innermost,
inside `createScopedModelProviderResolver`, where local mode's subscription-inline wrap (which
answers a harness ref with its own `CliInlineLanguageModel` instead of delegating) was invisible
to it: on the default local shape every inline step on a host `claude`/`codex` login recorded
zero calls while the same step on a metered API model recorded fine. **A facade never composes
that order by hand**: `wrapResolverWithTelemetry(resolver, instrument, limiter)`
(`@cat-factory/server`) owns it, for the same reason `createInlineInstrumentation` owns the exit
pair: the wrong order still typechecks and still records every non-substituted call, so nothing
fails until it is the deployment you don't test on. The limiter stays outermost, so a queue wait
is never counted as generation time.

## A model served by a harness CLI files its OWN calls, and the middleware STANDS DOWN

One `doGenerate` on `CliInlineLanguageModel` is not one model call (the CLI runs a whole tool
loop behind it, routinely 16+ calls over eight minutes), so the middleware could only ever report
it as ONE lumped row, only once the subprocess exited, and (a rejection carries no usage) as
ZEROS whenever the run was killed. The model therefore takes the facade's recorder and files each
call the CLI reports, live; the middleware asks `reportsOwnLlmCalls(model)` and returns it
unwrapped, because two producers for one call would double every token in the step's rollup.
**The model is ASKED, never a facade told**: the instrumentation sits outside the wrap that
substitutes the model (it has to; see above), so it cannot know what the inner wrap returned.

Each row carries the model the CLI says SERVED that call (`call.model ?? requested`, the same
precedence `makeHarnessCallRecorder` applies), because cost is derived per row from
`(model, token classes)` and a CLI serves some calls with a cheaper model of its own. **The
step-level row carries the SHORTFALL, not a lump**: the terminal cumulative usage minus what the
per-call rows accounted for, so a CLI that narrates nothing (`codex exec`) still gets the one row
the SDK boundary knows, a fully-narrated step gets none (it would double every token), and a
PART-narrated one gets the remainder rather than silently under-reporting, which is what an
"aggregate only when nothing was costed" rule did. An uncosted turn is never filed as a zero row,
and that rule lives with the model, so it holds for both transports.

Only Claude Code's `stream-json` is parsed per call, through the container harness's
`createClaudeRunTelemetry` (`@cat-factory/executor-harness/claude-call-aggregator`): the ONE
fold, imported rather than re-implemented, because folding per ENVELOPE instead of per
`message.id` inflated a measured 1.47M tokens to 5.53M and both paths had to learn that once.
**That fold reconstructs a transcript in the DRIVER's process, so both of its bounds are
load-bearing on the backend**: `MAX_TRANSCRIPT_CHARS` (which states what it stopped retaining)
and the `bodies` switch, off when `LLM_RECORD_PROMPTS` is: a body the store will drop must not be
assembled, since unlike every other body it is BUILT rather than merely passed as a thunk.

## Run attribution

The fallback is the credential SCOPE, which names the block's LAST run, not necessarily a live
one. A per-call `catFactoryObservability({ executionId })` wins; absent, the wrap threads
`scope.executionId`, because most inline sites tag only the workspace and such a row is worse
than unrecorded: it is IN the store and absent from every run-scoped read (`listByExecution`, a
step's rollup, `/api/v1/debug/runs/*`), which reads as a step that spent nothing.
`block.executionId` is NOT cleared when a run settles, so `resolveBlockRunContext` drops the id
for a TERMINAL run (keeping the initiator, which the key pool still scopes by): a stale id would
report spend against a finished run's rollup, and unlike a null nothing about it looks wrong.
Both absent means null, the honest answer for a genuinely un-run-scoped call. **A NEW inline
caller on the run path must build its scope with the run in it**: a call that generates on the
run path but resolves its own scope, like a fragment brief, carries the run on its input. The
precedence itself is ONE function, `resolveInlineAttribution`, because both inline producers
apply it.

## State what a producer does NOT know rather than filling a field with a guess

An inline call has `httpStatus` null, `phase` `''` and `upstreamMs === totalMs`, so the derived
overhead is a real 0. `turnIndex` is null for a plain `generateText` (no turn concept) and REAL
for a harness-CLI call, whose stream numbered it; `turn_index` is NULLABLE and never 0, or a
proxied call would sort to the front of its phase. A harness-CLI row likewise says `durationMs` 0
and `requestMaxTokens` null, because the CLIs expose no per-call timing and apply their own
ceiling, so this step's elapsed time or our ignored ask would both be fabrications.

## The input side is THREE orthogonal classes, never a lump

`promptTokens` is FRESH input with `cacheReadTokens` + `cacheWriteTokens` beside it, priced ~1x /
~0.1x / 1.25-2x base input (a cache WRITE costs more than fresh), so a producer that sums them
makes a loop that keeps invalidating its prefix read look exactly like one riding a warm cache.
Normalise at the source through the SINGLE `readInputTokenClasses`, which subtracts where the
vendor reports an INCLUSIVE prompt count and leaves the already-exclusive field alone where it
reports them apart, and **reads the two cache classes INDEPENDENTLY**, because an OpenAI-shaped
gateway fronting Anthropic reports both on one payload. A count crossing a wire boundary is read
LENIENTLY, since a runner pool runs whatever image its workspace pinned. **On every SPA surface
the headline `↑` is the TOTAL of the three, with the classes as the breakdown.** Doc:
[`token-telemetry-per-class-and-cost.md`](../../docs/initiatives/token-telemetry-per-class-and-cost.md).

## Every row is stamped with the PHASE that spent it, by whoever OWNS the boundary

Never reconstructed downstream: the harness stamps at EMIT time (not drain time), and the Pi path
carries it on the proxy URL because Pi has no per-request header to set. `''` is a REAL slice,
filed as unattributed rather than guessed at from the agent kind. **The BACKEND declares the
phase-tagged route** (`proxyPhasePath` on the job body) and the harness tags only when told:
never assume image and backend are a matched set, since a pool pins its own image and an image
ahead of its backend would 404 EVERY model call. Doc:
[`token-burn-instrumentation.md`](../../docs/initiatives/token-burn-instrumentation.md).

## The rollup is ONE aggregate at the `(agentKind, phase)` grain

Every coarser view is a pure fold over it (kernel `domain/llm-rollup.ts`), running on EVERY step
settlement. **A new consumer folds; it does not add a query.**

## The tool-call trajectory

An agent's tool loop is internal to its CLI: Pi's calls never appear as separate proxy requests
and a subscription harness bypasses the proxy entirely, so the harness's own event stream is the
only place the loop is visible, and the container is gone the moment the job settles. The harness
therefore pairs each call's start with its result, NUMBERS the pair, and captures both bodies;
the backend drains a window's worth on its existing job poll and sends it to two places.

- **`seq` orders a dispatch, and identifies a row.** A tool loop routinely fires several calls
  inside one millisecond, so no timestamp can sequence them. The ordinal is scoped to the
  DISPATCH, because a run's step can dispatch more than once (a re-run, a gate's fixer rounds, a
  Ralph iteration) and each starts numbering at zero. Each row's id derives from `(jobId, seq)`,
  zero-padded so the debug page's `(createdAt, id)` tiebreak agrees with the call order, and that
  derivation is what makes a replayed poll re-record instead of duplicate.
  A harness image too old to number its calls has its trajectory SKIPPED with a log line naming
  the job, because the only stateless substitute (the position in the batch) restarts every poll
  window and would silently drop four calls in five.
- **The trajectory ORDER is `(startedAt, seq)`**, the one telemetry read not on the
  `(createdAt, id)` keyset — `createdAt` is stamped once per DRAIN, so a whole poll window shares
  it. It is deliberately NOT `(jobId, seq)`: a job id is a string (`<executionId>-<agentKind>`,
  plus `-<epoch>` past the first dispatch), so ordering by it sorts a run's dispatches by
  agent-kind spelling and its re-runs `-10` before `-2`. Ordering by when each call actually
  started gets the dispatches in the order they ran for free. The SERVER computes this
  (`?order=trajectory`); a client sorting rows itself gets it wrong in a way that looks right.
- **Both bodies are bounded and scrubbed at CAPTURE**, and each row states what the cap dropped:
  a build log is routinely megabytes, and a reader has to be able to tell a short command from
  the head of a long one. That cap is also what keeps the poll response small, and it is why the
  debug list returns these rows WHOLE where a prompt body is sliced at read time.
- **`bodies` says whether they were retained at all.** A withheld body and a tool that genuinely
  took no arguments both leave `args` empty, and without the field an opted-out workspace's
  trajectory reads as a run whose every tool took none.
- **The failures are AGGREGATED, at the `(agentKind, tool)` grain.** A tool-execution failure is
  a healthy model call whose result came back bad, so it is invisible in every LLM rollup and a
  run-level count of the rows says nothing on its own: 34 failures out of 36 calls and out of
  3,600 are the same number and opposite diagnoses. `summarizeByExecution` is the one GROUP BY,
  and the run's total, both breakdowns and the debug overview's `sinks.toolCalls.count` are folds
  over it (kernel `domain/tool-call-rollup.ts`) rather than a second query, on the same rule the
  LLM rollup follows. The grain keeps BOTH halves because the finding is the CONCENTRATION: one
  agent kind retrying one tool is a stuck loop, and the same count scattered across nine tools is
  an agent exploring. `?ok=` narrows the rows behind any of it, in SQL.
- **The gate is applied ONCE, at the drain** (`toolTrajectory.ts`), not in either destination:
  the store and the external trace sinks receive the same already-gated batch. Reading it per
  destination is how a body withheld from the store gets shipped to Langfuse anyway.
- **A FAILING tool call is the one failure class no other sink can see.** The tool executes inside
  the container, so the model call that requested it still records `ok` with a clean finish reason
  and every `llm_call_metrics` rollup reads healthy on a run whose edit loop is wedged. Both reads
  therefore narrow on it in SQL (`ok?: boolean` on the port, `?outcome=ok|error` on the debug list,
  which is the same param name and vocabulary the llm-call list uses), and `summarizeByExecution`
  returns the `(agentKind, tool)` cells from ONE aggregate pass, which the overview folds into
  `toolCalls.totals` and derives a `tool_calls_failed` signal from. The count lives THERE and not
  on `sinks.toolCalls` as well: a second copy could only be a second read of the same rows, which
  is how a `failed` above its own `count` gets published. Narrowing in SQL rather than after the
  read is what makes it correct on a long run: the
  trajectory read is bounded to a PREFIX, so a post-filter would report no failures on any run
  whose failures came after its opening moves.

The SPA reads this sink through TWO workspace-scoped routes, at two different bounds, and the
split is load-bearing rather than an optimisation:

- `GET /workspaces/:ws/executions/:id/tool-call-failures` is the panel's HEADLINE, made on open.
  It answers `{ total, failed, failures, failuresTruncated }`: the counts are the store's one
  aggregate pass over the whole run, and the rows are the failing calls, narrowed in SQL and
  bounded separately from the trajectory. Every number the pinned "what failed" section prints
  comes from here.
- `GET /workspaces/:ws/executions/:id/tool-calls` is the BROWSE read, made when the trajectory is
  actually opened. Oldest-first, bounded, and carrying every captured argument and result, which
  is why it is not on the panel's critical path.

The reason they are separate is the prefix. The trajectory's bound takes the oldest end, so a
long run's rows are its opening moves; counting failures off them would report zero on exactly
the runs whose failures came later. That is the same mistake a post-read filter makes in the
store, one layer up, and it fails the same way: silently, with a confident all-clear. So the
trajectory reports `truncated` rather than presenting a prefix as a run, and the panel's counts
never come from it.

The panel holds four statements apart, not one: a failing call was found; both sinks answered and
nothing failed; a sink answered with nothing recorded; and a sink DID NOT ANSWER (its read
failed). The last outranks the rest, because each of the others is a claim about the run and that
one is the case where there is no standing to make one. Rendering any of them alike puts a clean
bill of health over a run that died.

On the trace side the bodies ride span EVENTS (`gen_ai.tool.arguments` / `gen_ai.tool.result`)
rather than attributes, like a generation's prompt and for the same reason: they are payloads,
not dimensions.

## Gating: the double gate on model bodies

The snapshot, the search queries and the tool-call bodies require BOTH `LLM_RECORD_PROMPTS` AND
the per-workspace
`storeAgentContext` (the operator opt-out wins). **That double gate governs every path that
captures a model BODY**, the EXTERNAL trace fan-out included, on the proxied AND inline paths. It
is ONE shared helper, kernel's `createStoreAgentContextGate`, precisely because the two paths
diverged; a read that THROWS fails closed, because an unreadable settings row is not consent.
**Any service in front of this store needs its `workspaceSettingsRepository`**, or that gate is
OPEN and an opted-out workspace's bodies are retained anyway.

## Remote debugging reads

`/api/v1/debug/*` exposes the same sinks to an external caller (in practice an LLM diagnosing a
run) under one rule a new endpoint must obey too: **a response's size has to be computable BEFORE
the request.** So fan-out lists never carry bodies, slicing/filtering/searching happen in SQL,
every body is a `debugText` reachable at any offset, and keyset cursors ride the
`(createdAt, id)` COMPOSITE because telemetry is appended in same-millisecond bursts. Scope is
`read`, deliberately not `admin`. Full model: [`debug-api.md`](./debug-api.md).

## External trace destinations

They go through ONE kernel port (`LlmTraceSink`) and never a second recording path: two packages
implement it and `composeTraceSinks([…])` collapses them into `CoreDependencies.llmTraceSink`, so
**adding a destination is a new implementation composed into that array, never a new call site.**
Every sink is opt-in on a FULL config, **never throws into the caller**, and honours
`LLM_RECORD_PROMPTS` (usage and timing still export; bodies don't). The OTel package is the one
place the runtimes deliberately differ in TRANSPORT, not behaviour (workerd can't run the
official SDK), sharing `src/mapping.ts` pinned equal by `conformity.test.ts`, so span names,
attributes and metric names change in the mapping layer.

**A run's spans are a HIERARCHY (`run → agent kind → generations + tool calls`) built from
DERIVED ids, never shared state**: every parent id is a pure function of the run, so a stateless
per-call emission names a parent it has never seen. The parents are emitted at settlement, from
the same terminal hook the run-lifecycle edge uses (`recordRunSpans` ←
`LlmObservabilityService.recordRunTrace`), for the same reason: a run reaches `done` from four
sites. That hook fires AGAIN for an already-settled run, so **the parents' EXTENT is folded from
stamps the run recorded, never read off a clock at emit time** (`buildRunTraceSpans`): derived
ids alone make a replay re-export the same span ids, and pairing those with a duration that moved
is a contradiction where a byte-identical duplicate is something a backend collapses.

The step level's grain is the agent KIND because that is the finest thing a generation event can
NAME. **A step that dispatched a HELPER kind (a gate's `ci-fixer`, a Tester's fixer, a
`fork-proposer`) gets a span for that kind too, nested under it**: the helper's telemetry is
tagged with the HELPER, so without one every row of it names a parent nobody emits. What ran is
recorded at dispatch on `PipelineStep.dispatches` through the ONE funnel
(`recordDispatchAttribution`), never re-derived from `agentKind`.

**What a span cannot separate it STATES**: the runs here repeat as CYCLES (a fixer loop, a Ralph
iteration, a bounced step), and the events under a span carry no attempt ordinal to split it by,
so each step span reports `step_count` AND `attempt_count` rather than passing six rounds off as
one. A re-run's extent comes from `firstStartedAt`, which survives the reset that re-stamps
`startedAt`, or the parent would begin after its own earlier children.

**A span NAME is a bounded class** (`chat {model}`, `invoke_agent {agentKind}`, the bare `run`),
the trace-side counterpart of the bounded-dimension rule for metrics: free text like a pipeline
name rides an attribute, or a tenant mints unbounded series on the operator's backend by renaming
things. Deployment-level metrics are the dual, swept per account and opt-in on top of the base
exporter:
[ADR 0048](./adr/0048-platform-operator-observability.md).
