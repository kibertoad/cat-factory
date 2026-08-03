# Initiative: per-run token-burn instrumentation & diagnosis

**Status:** in progress (Slice 4 next) · **Owner:** core · **Started:** 2026-07-28

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

**Stop treating cat-factory's token burn as a display artifact. It is not one.** An autonomous
run pushes far more input through the model than an interactive Claude Code session would for the
same small change, and that gap is real volume (quota, turns, latency) not a counting quirk.

The framing that misled the earlier investigation was "the big number is mostly discounted cache
reads, so it's a reporting problem." Two facts kill that read:

1. **Claude Code's own context gauge counts cache reads.** The "% until auto-compact" indicator is
   computed from the sum of every input bucket
   ( `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`) because cache reads
   still physically occupy the context window. cat-factory summing the same buckets is therefore a
   **like-for-like** measure of the same thing, not an inflation relative to how Claude Code
   reports. The cache-read composition explains why the _dollar_ cost stays low; it explains
   nothing about the _volume_.
2. **The volume is abnormal.** A one-line change (e.g. "bump pnpm") that an interactive session
   finishes in a tiny fraction of the tokens routinely drives ~1M input tokens through the model
   in the pipeline. That is turns × context, and both terms are inflated.

This initiative builds the **instrument** that turns "we think we burn too much" into "here is the
slice that costs, measured", and only then cuts the biggest slice. It is deliberately a
measurement-first tracker: the sibling initiatives below move levers, but none of them can prove
which lever matters without this.

### Why autonomous runs spiral past an interactive session (the hypotheses to measure)

Grounded in the #1261-era investigation and the pipeline architecture; each is a _candidate_
driver this instrument is meant to rank, not a settled cause:

1. **No human off-ramp.** Headless `-p` + `bypassPermissions`, bounded only by the inactivity
   watchdog (`JOB_INACTIVITY_MS`, 10 min) and the command watchdog (15 min). A person bumping
   pnpm stops when the diff is done; the autonomous coder runs to its _own_ notion of "done."
2. **The pipeline piles on model work the edit never needed.** Pre-PR validation with repair loops
   (`validation-checks.ts`), the bugfix reproduction proof (`reproduction-proof.ts`), the effort
   report, follow-up generation (a trivial run emitted 3 follow-ups at `maxLoops: 3`), the coder
   fork decision. Each is turns an interactive session never spends.
3. **A large always-on prefix, re-sent every turn.** Role + folded fragments + spec / blueprint /
   trait / effort / follow-up guidance + the repo's own (uncapped) `CLAUDE.md` / `AGENTS.md`. Base
   prefix × N turns is the cache-read pile.
4. **No trimming or summarization.** Every file read stays verbatim in the window and is re-sent on
   every subsequent turn (turns × context is superlinear in how much each early turn loads).

### The honest read on what's already shipped/planned

- The `pr-review-turn-reduction` slices shrink the per-turn prefix (brief fragments, context-file
  delivery, computed slicing) and are real wins, but scoped to the PR-review kind.
- `ProgressGuard` (`ProgressGuardLimits` in the harness, `guardLimits` per agent kind) is the only
  anti-spiral lever, and it only fires on **pathological non-progress** (no-edit probing,
  error/web loops). A run _productively_ grinding through validation/repair loops on a trivial task
  will not trip it, and the burn continues.
- So today we reduce baseline weight and catch the worst runaways; we do **not** cap "doing far too
  much work for a small task." Closing that needs the measurement this tracker produces.

## End state

- **Slice 1: honest per-turn accounting (dependency). ✅ landed.** The three input classes must be
  orthogonal and additive before any per-phase sum means anything. This is exactly the
  [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) Slice 1
  (redefine `promptTokens` as fresh-only; carry `cacheReadTokens` + `cacheWriteTokens` distinctly
  end to end). **This tracker consumes that split; it does not re-implement it.** Every row now
  carries `promptTokens` (fresh) / `cacheReadTokens` / `cacheWriteTokens` additively, so Slice 3's
  per-phase sums are meaningful and Slice 4's baseline can state WHICH class a phase burns. Read
  that tracker's "Carried out of Slice 1" before adding a producer here.
- **Slice 2: turn index + phase attribution on every LLM call.** Stamp each `llm_call_metrics`
  row with (a) a per-job **turn ordinal** and (b) the **phase** that spent it: coder edit vs
  validation/repair vs reproduction proof vs follow-up generation vs fork decision vs exploration.
  The harness already streams per-call metrics with a job-scoped `seq`
  (`RunnerJobView.callMetrics`, minted as `<jobId>-hc-<seq>`); phase is the new axis. A call that
  can't be attributed lands in an explicit `''`/`unknown` phase: a real slice, never dropped.
- **Slice 3: per-run rollup, grouped by phase. ✅ landed.** One SQL aggregate per execution over
  `llm_call_metrics` (never rows reduced in JS): turns, fresh / cache-read / cache-write / output,
  and a **carry-cost** proxy (each turn's context × turns remaining) per phase. Surfaced in the
  observability panel (`step.metrics.byPhase`, folded to the run) and available headless on the
  debug overview (`llm.byPhase`). The aggregate's grain is `(agentKind, phase)` and every coarser
  view is a pure fold over it, so Slice 4 can read a per-phase split that provably sums to the
  totals beside it.
- **Slice 4: the baseline & the decision.** Run the same trivial task ("bump pnpm") as (a) an
  interactive Claude Code session and (b) a full pipeline run, and compare the ratio + the
  per-phase breakdown. The breakdown _decides the fix_ rather than us guessing:
  - prefix size dominates → prompt/`CLAUDE.md` trimming + compaction;
  - turn count dominates → a per-run turn budget / `ProgressGuard` extension to productive-but-
    excessive runs;
  - the pipeline does redundant work on trivial tasks → trivial-task routing to a single-shot
    runner, or trimming the pipeline steps a small task doesn't need.
    Whichever wins becomes its own follow-up initiative; this tracker's job is to name it with
    evidence.

## Carried out of Slice 2 (read before adding a producer)

The axis landed as `phase` (TEXT, `''` = unattributed) + `turn_index` (INTEGER, NULLABLE) on both
telemetry stores, and the two producing paths carry it themselves. What the implementation
settled, and what a Slice 3 rollup must not undo:

- **Two channels, two carriers, because they are not the same shape.** A subscription harness's
  calls are objects the harness owns, so the job registry stamps `phase` on them beside `seq`.
  Pi's calls are made BY PI, to the server-side proxy, from a config file whose only per-run knobs
  are the base URL and the token: there is no per-request header to set. So the harness rewrites
  the base URL per pass (`${proxyBaseUrl}/phase/<phase>`) and the proxy reads the segment back.
  Both paths are the component that owns the boundary telling the store; neither infers.
- **Stamp at EMIT time, not drain time.** A drained poll can land long after the phase moved on,
  which would file a whole repair round under whatever phase happened to be current when the
  backend got around to reading it. The registry stamps inside `onCallMetric`.
- **The unphased proxy path stays the canonical route, and the BACKEND decides when it is left.**
  An image that predates the phase segment keeps working and lands in `''`. The reverse pairing
  ( an image NEWER than its backend) would 404 EVERY model call, killing the run rather than
  degrading its telemetry, so the backend states on the job body that it serves the route
  (`proxyPhasePath`, set in `resolveAuth` / the bootstrapper / the env-config repairer) and the
  harness tags the URL only when told. This is NOT the capability handshake the repo refuses: the
  harness never asks and never adapts to an answer, it is one more backend-authored job-body field
  in the exact shape `webSearch` already has ("point your search tool at MY `/web-search`").
  The first draft skipped it on the grounds that the image and the backend are a matched set
  (`RECOMMENDED_HARNESS_IMAGE`): true for the Cloudflare deployment, false everywhere else: a
  runner pool pins its own executor-harness image in its manifest, and `LOCAL_HARNESS_IMAGE`
  overrides the recommended pin outright. Note this PR's other carrier already assumed the
  opposite (`coerceCallMetrics` passes an unknown phase through _because_ a pool may run a newer
  image), so the two channels have to make the same assumption about skew.
- **`normalizeCallPhase` has a COPY in the harness** (`normalizeProxyPhase`, `src/pi.ts`), because
  the image builds from `src/` plus typescript and can depend on no workspace package: the same
  constraint that forced `src/host-markdown.ts`. It gets the same treatment: a byte-of-behaviour
  conformity suite (`test/llm-phase.conformity.test.ts`) pinning the two to identical verdicts,
  plus the end-to-end property that the segment the harness sends must survive the backend's
  normalisation UNCHANGED. Drift here is silent in both directions: a stricter harness sends the
  plain path and loses exactly the phase someone went looking for; a looser one spends a request
  on a segment destined for `''`. Change the alphabet in both or in neither.
- **There is no `KNOWN_CALL_PHASES` list, deliberately.** The vocabulary is the harness's (it is
  whatever its handlers pass to `onPhase`, including the registry's initial `starting` and the
  terminal `done`) so a copy in kernel is a second source of truth with nothing keeping it in
  step (the first draft's list omitted both of those, and nothing consumed it). A Slice 3 rollup
  should render the phases PRESENT in its result set (`''` included) rather than a hard-coded
  list, which can only be wrong in the direction that hides a phase a newer harness introduced.
- **A phase is not always a `currentPhase` read.** The structured-output repair round
  (`structured-output.ts`) is billed to the constant `structured-repair`, because the harness
  makes that call ITSELF: the agent has already finished and left text that won't parse, so it
  belongs to no pass the registry marks. Any future harness-made call owes the same treatment:
  leaving it on the plain path would grow `''` into a bucket Slice 3 could no longer read as
  "old images and genuinely unattributable calls".
- **`turn_index` is NULL for a proxied call, never 0.** The proxy has no job-scoped counter; a 0
  would read as "the first turn" and sort every Pi call to the front of its phase. Slice 3 orders
  those rows by `created_at` (with `message_count` as the tie-break the export already uses).
- **The turn ordinal IS `seq`**, the same number `<jobId>-hc-<seq>` is minted from: deliberately
  not a second counter, so a rollup ordering by turn sees exactly the sequence the ids encode.
- **The label is normalised at every boundary** (`normalizeCallPhase`, kernel): two of the three
  producing paths are inputs the platform does not author (a request path anyone holding a session
  token can write, a runner pool's JSON). It rejects rather than escapes, so the stored vocabulary
  stays one alphabet and `GROUP BY phase` can't be split by case or padding, but it passes an
  UNKNOWN label through, so a phase a future harness adds reaches telemetry verbatim.
- **Hono footgun:** registering one handler on both paths via `app.on('POST', [paths], …)` silently
  degrades the handler's contextual typing (an inner `.catch((err) =>` becomes an implicit-any
  error). The handler is a named function registered per path instead.

## Carried out of Slice 3 (read before consuming the rollup)

The rollup landed as ONE aggregate at the `(agentKind, phase)` grain, with kernel folds
(`domain/llm-rollup.ts`) producing every coarser view. What that settled:

- **One aggregate, folded, never one query per axis.** The store returns the finest grain and
  `foldRollupsByAgentKind` / `foldRollupsByPhase` / `foldRollupTotals` derive the rest. The
  alternative (a second `GROUP BY phase` beside the existing `GROUP BY agent_kind`) doubles the
  cost of an emit (this runs on EVERY step settlement) and, worse, produces two answers to the
  same question the moment one of them changes. The folds are over a handful of cells, not over
  the rows they were computed from, so the "push aggregates into SQL" rule still holds.
- **Carry cost partitions by CONVERSATION, not by run.** `Σ (a call's total input) × (turns left
after it)` is charged within `partition by agent_kind`, because that is what the prompt delta
  chain is keyed by: a merger step's turns never re-send a coder step's context, and a run-wide
  window would have charged the coder's first turn for every later step's turn. The conformance
  case pins exactly this discrimination (run-wide accounting gives 1000 where the correct answer
  is 400).
- **The window orders by `(created_at, message_count, id)`, deliberately NOT `turn_index`.** A
  proxied row's turn index is NULL by design (Slice 2), so ordering by it would heap every Pi
  call at one end of its own conversation. `message_count` breaks the same-millisecond ties a
  streamed burst produces and `id` makes it deterministic across runtimes.
- **The carry cost is the ONE column that needs a 64-bit sum.** It is a product of two sums, so a
  real run clears int4's 2.1e9 ceiling routinely; the Postgres aggregate casts `::bigint` (not
  the `::int` its neighbours use) and coerces on the way out. Getting this wrong is not a rounding
  error, it is a query that throws mid-emit.
- **It is a PROXY and says so everywhere it surfaces.** It re-counts tokens the model saw once,
  per subsequent turn, which is precisely the re-send being measured, so it is comparable
  BETWEEN a run's phases and meaningless as an absolute. Both surfaces sort by it and neither
  presents it as a token total. **Sorting by it is not the same as sorting by spend**, and the
  difference is systematic rather than incidental: the last turn of a conversation carries
  nothing by construction, so a phase concentrated at the tail (a validation repair round that
  ends the run) scores near zero however many tokens it burned. Both surfaces therefore say what
  they are ordered by (the panel in its subtitle and on the column header, the debug API in
  `debug-api.md`) and both keep the token columns beside it. Do NOT let a future surface present
  this ranking as "the phases that spent the most".
- **No migration, no schema change.** The columns Slice 2 added are all it reads, so this is a
  read-only change on both telemetry stores, which is also why there is no runtime-asymmetry
  risk beyond the SQL itself (asserted by the conformance suite on real D1 and real Postgres).
- **The panel folds the per-step rollups, deduplicating by agent kind.** A step's `metrics` is
  its KIND's rollup for the whole run (the proxy keys a conversation by `(execution, agentKind)`,
  not by step index), so two steps of one kind carry identical numbers and a naive sum over
  `steps` doubles them. Folding the rollup rather than the loaded call list also keeps the
  breakdown honest on a long run, where that list is capped.
- **`byPhase` rides the emit payload, and that is a deliberate trade.** It is attached to EVERY
  step (duplicated across steps sharing a kind, which is why the panel dedupes), so it lands in
  the persisted `ExecutionInstance` JSON and in the real-time push on every step settlement: on
  the order of a few hundred numbers, single-digit KB for a large pipeline. It buys the surface
  with no extra query and no new endpoint, since the rollup already had to be attached. The knob
  to reach for if a run ever makes this hurt is the number of PHASES a harness emits, not a cap
  on the array: a dropped phase row is exactly the silent under-report the `''` slice exists to
  prevent.

## Target pattern (Slice 2: the reference implementation)

The instrument rides seams that already exist, so it needs no new sink and stays runtime-symmetric
(D1 ⇄ Drizzle telemetry stores, asserted by `defineAgentContextSuite` / the LLM-metrics
conformance suite):

- **Phase is carried on the metric, not inferred downstream.** The harness knows which phase it is
  in (it drives the validation and reproduction loops itself); the phase label rides the streamed
  `callMetrics` object alongside `seq`, so `makeHarnessCallRecorder` persists it with the row. The
  proxy path (`LlmProxyController.observe`) tags the dispatch's phase from the step kind. This
  keeps attribution at the point of truth instead of reconstructing it from timestamps.
- **Turn ordinal is the existing `seq`,** exposed as a first-class column rather than only encoded
  in the id, so the rollup can `GROUP BY phase` and `ORDER BY turn` without parsing the id.
- **The rollup is one aggregate,** mirrored across both telemetry repos'
  `summarizeByExecution`-shaped query, folded onto `step.metrics` the same way today's sums are.
- **Two new columns, both telemetry DBs, one change** (a telemetry column can't land on one
  runtime: see "Keep the runtimes symmetric"): D1 `telemetry-migrations/00NN_*.sql` ⇄ Drizzle
  `schema.ts` + a `drizzle/` migration; both repos' row mappers, INSERT column lists, and the
  rollup SQL. 3-day retention means no dual-write is needed: stale rows churn out within the
  window.

## Per-slice checklist

| #   | Slice                      | Scope                                                                                                            | Status  | PR    |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------- | ----- |
| 0   | One row per CALL           | Fold Claude Code's per-content-block envelopes back into one call; give subagent turns ONE owning channel        | ✅ done | #1430 |
| 1   | Honest per-turn accounting | Adopt `token-telemetry-per-class-and-cost` Slice 1 (fresh / read / write split) as the dependency                | ✅ done |       |
| 2   | Turn index + phase axis    | Turn ordinal + phase on `llm_call_metrics` (harness `callMetrics`, proxy `observe`, both telemetry DBs, mappers) | ✅ done | #1455 |
| 3   | Per-run rollup by phase    | `GROUP BY (agent_kind, phase)` aggregate + carry-cost proxy; onto `step.metrics`; panel + debug overview         | ✅ done |       |
| 4   | Baseline & decision        | Interactive-CC vs pipeline baseline on a trivial task; per-phase breakdown → name the winning lever              | ⬜ todo |       |
| 5   | Parent per-call output     | The parent's own turns record the stream's early output count, not the final one: see below                      | ⬜ todo |       |

### Slice 0: what the instrument was actually reporting (2026-07-28)

Found while taking the `pr-review-turn-reduction` Slice 3 measurement on run `exec_a4972d30`. The
surface reported **575 rows / 39.4M input tokens** where the run made **~228 calls / ~16.3M**, so
every conclusion drawn from it was inflated ~2.4×. Two independent defects, both now fixed in
`agent-runner.ts` + `claude-call-aggregator.ts`:

1. **A row per content BLOCK, not per call.** Claude Code's `stream-json` emits one `assistant`
   envelope per content block of a response, each repeating that response's `usage`; the runner
   recorded one metric per envelope. A turn answering with text and five parallel tool calls was
   counted six times. Proof in the data: six consecutive rows all at `prompt_tokens = 49,661`
   covering one `ToolSearch` and five `TaskCreate` calls; consecutive real calls cannot share an
   input count, because each adds the previous tool result.
2. **Subagent turns counted twice.** The CLI streams a dispatched subagent's turns onto the
   parent's stdout tagged with `parent_tool_use_id`, and the same turns are written to the
   `subagents/*.jsonl` transcripts the watcher reads. Nothing filtered the tagged events, so both
   channels recorded them: 56 distinct `(prompt_tokens, completion_tokens)` pairs appeared in both.
   The runner's message reconstruction spliced them in too, so `promptText` interleaved several
   conversations and matched no request that was ever sent: visible as the parent's
   `prompt_tokens` dropping 51,429 → 19,430 at a dispatch and snapping back to 57,935 when the
   `Agent` result landed.

The `assembleClaudeOutcome` invariant ("the two sources are disjoint") holds for the aggregate
`usage`, which comes from the terminal `result` event and covers only the parent loop. It never
held for `callMetrics`.

**Deduplicating is not the same as having a source.** The obvious fix (always skip the tagged
events, the watcher owns them) under-counts wherever the watcher does not run, and an under-count
reads as a cheap run rather than as an error. Two places it does not run: an `ambientAuth` run has
no isolated config home to watch at all, and the CLI's `subagents/*.jsonl` layout is not a stable
contract (it moved once already, ADR 0027 Defect A). So ownership is decided ONCE per run from
whether a watcher exists, not per event: with no watcher the parent stream carries the subagent
calls through per-dispatch transcripts of their own (`createSubagentStreamTelemetry`), and a
watcher that was wired but captured nothing while tagged turns crossed the stream is logged rather
than left to look like a run with no subagents.

The per-dispatch split matters as much as the filter: concurrent subagents interleave on ONE
stdout, so a single fallback chain would reproduce the interleaved-`promptText` defect one level
down. `parent_tool_use_id` is the only thing separating those conversations.

**Slice 5 (the residual).** Stream-sourced rows carry the output count as of the message start, not
the total: across that run every parent-channel row reported ~14 output tokens, and every
substantial count came from a transcript row. With Slice 0 in, subagent calls are transcript-sourced
and correct, and the run total stays right (the `result` event), so what is left is the per-call
output split for the PARENT's own turns. Fixing it means deciding which source owns per-call usage:
most likely joining the stream's prompt side to the parent session transcript's usage side on
`message.id`, which is a real restructuring of the two-source split rather than a patch.

## Conventions / gotchas carried between iterations

- **An envelope is not a call, and a channel is not a source of truth.** Both Slice 0 defects were
  the same mistake: treating whatever the CLI happened to emit as one unit of spend. Before adding
  a producer to `llm_call_metrics`, establish what makes a row unique (`message.id`, here) and
  which channel owns it. A cross-check that catches this early: distinct `prompt_tokens` values
  should be close to the row count, since a real call's prompt is strictly larger than its
  predecessor's.
- **Every channel you silence needs a channel that speaks.** Deduplicating by dropping one side is
  only correct while the other side is guaranteed to run; where it is best-effort (a watcher over a
  file layout the vendor can change), decide ownership from whether that channel EXISTS and keep
  the other as the fallback. Where neither can be guaranteed, log the gap: a telemetry defect that
  under-counts is invisible in exactly the way an over-count is not.
- **`PiRunStats` is not telemetry.** `toolCalls` / `assistantChars` answer "did the agent act at
  all" (`agentNeverActed`), so they are accumulated off the raw stream and deliberately do NOT ride
  the telemetry ownership split: otherwise the same run reports different activity depending on
  which channel billed it.
- **Cache reads are NOT free and NOT cosmetic.** They occupy the context window and count toward
  Claude Code's own gauge. Any framing that discounts them because the dollar cost is low is
  measuring the wrong thing: the quota/latency/volume cost is what this tracker exists to measure.
- **The read/write split is a hard dependency: now satisfied.** Summing cache read + cache write
  (the old `cachedPromptTokens`) made a per-phase attribution meaningless: a repair loop that
  re-writes the cache looked identical to one that only re-reads it. That split landed
  ([`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) Slice 1), so the
  phase axis can be added on top. Its corollary for THIS tracker: a per-phase rollup must aggregate
  the three classes SEPARATELY. Re-summing them into one "input" figure for the panel would undo the
  dependency this initiative waited for.
- **`ProgressGuard` is not a token budget.** It stops _pathological non-progress_, not _productive
  excess_. A trivial task that legitimately edits, validates, repairs, reproduces and follows-up
  will never trip it, so "we already have a guard" is not a reason to skip the instrument.
- **Attribute at the source, never reconstruct.** The harness owns the phase boundaries; carry the
  label on the streamed metric. Reconstructing phase from wall-clock timestamps downstream is the
  kind of brittle inference this repo avoids.
- **Don't drop the unattributable slice.** A call whose phase can't be resolved is a real `''`
  slice: hiding it under-reports the window while looking complete (same rule the reports surface
  applies to its `''` key).
- **Measurement decides; this tracker does not pre-commit a fix.** Compaction, a turn budget,
  trivial-task routing, and pipeline trimming are all candidates. Picking one before the per-phase
  numbers exist is exactly the guessing this initiative replaces.

## Siblings

- [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md): makes the
  read/write/fresh split honest (Slice 1 is this tracker's dependency) and adds cost surfacing.
- [`pr-review-turn-reduction`](./pr-review-turn-reduction.md): attacks the _cause_ for the
  PR-review kind (cut what each turn carries); its "measure the reduction" slice is a consumer of
  this instrument.
