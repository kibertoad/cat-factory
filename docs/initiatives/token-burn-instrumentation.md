# Initiative: per-run token-burn instrumentation & diagnosis

**Status:** proposed · **Owner:** core · **Started:** 2026-07-28

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

**Stop treating cat-factory's token burn as a display artifact. It is not one.** An autonomous
run pushes far more input through the model than an interactive Claude Code session would for the
same small change, and that gap is real volume — quota, turns, latency — not a counting quirk.

The framing that misled the earlier investigation was "the big number is mostly discounted cache
reads, so it's a reporting problem." Two facts kill that read:

1. **Claude Code's own context gauge counts cache reads.** The "% until auto-compact" indicator is
   computed from the sum of every input bucket —
   `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` — because cache reads
   still physically occupy the context window. cat-factory summing the same buckets is therefore a
   **like-for-like** measure of the same thing, not an inflation relative to how Claude Code
   reports. The cache-read composition explains why the _dollar_ cost stays low; it explains
   nothing about the _volume_.
2. **The volume is abnormal.** A one-line change (e.g. "bump pnpm") that an interactive session
   finishes in a tiny fraction of the tokens routinely drives ~1M input tokens through the model
   in the pipeline. That is turns × context, and both terms are inflated.

This initiative builds the **instrument** that turns "we think we burn too much" into "here is the
slice that costs, measured" — and only then cuts the biggest slice. It is deliberately a
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
  delivery, computed slicing) and are real wins — but scoped to the PR-review kind.
- `ProgressGuard` (`ProgressGuardLimits` in the harness, `guardLimits` per agent kind) is the only
  anti-spiral lever, and it only fires on **pathological non-progress** (no-edit probing,
  error/web loops). A run _productively_ grinding through validation/repair loops on a trivial task
  will not trip it, and the burn continues.
- So today we reduce baseline weight and catch the worst runaways; we do **not** cap "doing far too
  much work for a small task." Closing that needs the measurement this tracker produces.

## End state

- **Slice 1 — honest per-turn accounting (dependency).** The three input classes must be
  orthogonal and additive before any per-phase sum means anything. This is exactly the
  [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) Slice 1
  (redefine `promptTokens` as fresh-only; carry `cacheReadTokens` + `cacheWriteTokens` distinctly
  end to end). **This tracker consumes that split; it does not re-implement it.** If that slice
  hasn't landed, land it first.
- **Slice 2 — turn index + phase attribution on every LLM call.** Stamp each `llm_call_metrics`
  row with (a) a per-job **turn ordinal** and (b) the **phase** that spent it — coder edit vs
  validation/repair vs reproduction proof vs follow-up generation vs fork decision vs exploration.
  The harness already streams per-call metrics with a job-scoped `seq`
  (`RunnerJobView.callMetrics`, minted as `<jobId>-hc-<seq>`); phase is the new axis. A call that
  can't be attributed lands in an explicit `''`/`unknown` phase — a real slice, never dropped.
- **Slice 3 — per-run rollup, grouped by phase.** One SQL aggregate per execution over
  `llm_call_metrics` (never rows reduced in JS): turns, fresh / cache-read / cache-write / output,
  and a **carry-cost** proxy (each turn's context × turns remaining) per phase. Surfaced in the
  observability panel and available headless for the baseline runs.
- **Slice 4 — the baseline & the decision.** Run the same trivial task ("bump pnpm") as (a) an
  interactive Claude Code session and (b) a full pipeline run, and compare the ratio + the
  per-phase breakdown. The breakdown _decides the fix_ rather than us guessing:
  - prefix size dominates → prompt/`CLAUDE.md` trimming + compaction;
  - turn count dominates → a per-run turn budget / `ProgressGuard` extension to productive-but-
    excessive runs;
  - the pipeline does redundant work on trivial tasks → trivial-task routing to a single-shot
    runner, or trimming the pipeline steps a small task doesn't need.
    Whichever wins becomes its own follow-up initiative; this tracker's job is to name it with
    evidence.

## Target pattern (Slice 2 — the reference implementation)

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
  runtime — see "Keep the runtimes symmetric"): D1 `telemetry-migrations/00NN_*.sql` ⇄ Drizzle
  `schema.ts` + a `drizzle/` migration; both repos' row mappers, INSERT column lists, and the
  rollup SQL. 3-day retention means no dual-write is needed — stale rows churn out within the
  window.

## Per-slice checklist

| #   | Slice                      | Scope                                                                                                            | Status     | PR  |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- | --- |
| 1   | Honest per-turn accounting | Adopt `token-telemetry-per-class-and-cost` Slice 1 (fresh / read / write split) as the dependency                | ⬜ blocked |     |
| 2   | Turn index + phase axis    | Turn ordinal + phase on `llm_call_metrics` (harness `callMetrics`, proxy `observe`, both telemetry DBs, mappers) | ⬜ todo    |     |
| 3   | Per-run rollup by phase    | `GROUP BY phase` aggregate + carry-cost proxy; onto `step.metrics`; observability panel + headless               | ⬜ todo    |     |
| 4   | Baseline & decision        | Interactive-CC vs pipeline baseline on a trivial task; per-phase breakdown → name the winning lever              | ⬜ todo    |     |

## Conventions / gotchas carried between iterations

- **Cache reads are NOT free and NOT cosmetic.** They occupy the context window and count toward
  Claude Code's own gauge. Any framing that discounts them because the dollar cost is low is
  measuring the wrong thing — the quota/latency/volume cost is what this tracker exists to measure.
- **The read/write split is a hard dependency.** Summing cache read + cache write (today's
  `cachedPromptTokens`) makes a per-phase attribution meaningless: a repair loop that re-writes the
  cache looks identical to one that only re-reads it. Land
  [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) Slice 1 first.
- **`ProgressGuard` is not a token budget.** It stops _pathological non-progress_, not _productive
  excess_. A trivial task that legitimately edits, validates, repairs, reproduces and follows-up
  will never trip it, so "we already have a guard" is not a reason to skip the instrument.
- **Attribute at the source, never reconstruct.** The harness owns the phase boundaries; carry the
  label on the streamed metric. Reconstructing phase from wall-clock timestamps downstream is the
  kind of brittle inference this repo avoids.
- **Don't drop the unattributable slice.** A call whose phase can't be resolved is a real `''`
  slice — hiding it under-reports the window while looking complete (same rule the reports surface
  applies to its `''` key).
- **Measurement decides; this tracker does not pre-commit a fix.** Compaction, a turn budget,
  trivial-task routing, and pipeline trimming are all candidates. Picking one before the per-phase
  numbers exist is exactly the guessing this initiative replaces.

## Siblings

- [`token-telemetry-per-class-and-cost`](./token-telemetry-per-class-and-cost.md) — makes the
  read/write/fresh split honest (Slice 1 is this tracker's dependency) and adds cost surfacing.
- [`pr-review-turn-reduction`](./pr-review-turn-reduction.md) — attacks the _cause_ for the
  PR-review kind (cut what each turn carries); its "measure the reduction" slice is a consumer of
  this instrument.
