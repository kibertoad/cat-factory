# Initiative: per-class token telemetry + cost surfacing

**Status:** in progress (Slice 2) · **Owner:** core · **Started:** 2026-07-20

> Durable source of truth for a multi-PR initiative. Read it first before picking up the
> next slice; update the checklist at the end of each PR.

## Goal & rationale

The per-run token telemetry surface (the step-metrics bar + the observability panel, fed by
`llm_call_metrics`) is **not honest about what tokens actually cost**. It tracks exactly two
input dimensions (`promptTokens` and a single lumped `cachedPromptTokens`) which fails three
ways:

1. **`cachedPromptTokens` conflates cache READS with cache WRITES.** On the subscription-CLI
   path (`claudeCallUsage`) `cache_read_input_tokens` and `cache_creation_input_tokens` are
   summed into one number. But they are priced very differently: a cache **read** is ~0.1× base
   input, a cache **write** is 1.25×–2× base input (i.e. _more_ than fresh). Lumping them makes
   cost impossible to reason about.
2. **`promptTokens` has provider-dependent semantics.** On OpenAI/DeepSeek (and the harness,
   which folds cache into `promptTokens`) `cachedPromptTokens` is a _subset_ of `promptTokens`;
   on Anthropic-via-proxy cache reads are reported _separately_, so `cachedPromptTokens` can
   _exceed_ `promptTokens`. This forced the `freshPromptTokens` **heuristic** in
   `frontend/app/app/utils/observability.ts`, which is only approximately correct (it can't
   distinguish the separate shape while cached ≤ prompt).
3. **No cost is surfaced at all.** The meaningful "am I burning money" signal is dollars with
   per-class multipliers. A price table exists (`backend/packages/spend/src/pricing.ts`,
   `DEFAULT_MODEL_PRICES`) but it is input/output-only (no cached tiers) and wired to the spend
   gate, not to telemetry.

The prompt for this work was the #1261 PR-review investigation, where a run surfaced "31M
tokens" that was 99.998% cache reads: cheap per token but neither free nor visible for what it
was. (See `docs/pr-review-run-efficiency-and-parking-fixes-2026-07.md`; the sibling
`pr-review-turn-reduction.md` initiative attacks the _cause_: this one makes the _accounting_
honest.) The `token-burn-instrumentation.md` initiative consumes Slice 1 below as its dependency:
its per-phase attribution is meaningless until cache read vs write are orthogonal here.

### End state

- **Slice 1: orthogonal input classes.** Redefine `promptTokens` as **fresh (uncached) input
  only** and carry `cacheReadTokens` + `cacheWriteTokens` as two distinct, additive fields end
  to end. Total input = `promptTokens + cacheReadTokens + cacheWriteTokens`. This removes the
  subset-vs-separate ambiguity, deletes the `freshPromptTokens` heuristic (fresh _is_
  `promptTokens`), and lets the UI show reads-vs-writes distinctly.
- **Slice 2: cost.** Extend `ModelPrice` with `cachedReadPerMillion` + `cacheWritePerMillion`,
  compute an estimated cost per call/step from the three input classes + output, and surface it
  as the headline in the observability panel (with the token breakdown as detail). Subscription
  runs show cost as _illustrative_ ("what this would have cost metered"), consistent with the
  `usage-and-quota-tracking` initiative's convention.

## Target pattern (Slice 1: the reference implementation)

The normalization rule every population site applies: **`promptTokens` = fresh input, exclusive
of both cache classes.**

| Provider family                         | `promptTokens` (fresh)          | `cacheReadTokens`                                       | `cacheWriteTokens`                   |
| --------------------------------------- | ------------------------------- | ------------------------------------------------------- | ------------------------------------ |
| Anthropic (proxy + Claude Code harness) | `input_tokens`                  | `cache_read_input_tokens`                               | `cache_creation_input_tokens`        |
| OpenAI / Codex / DeepSeek               | `prompt_tokens − cached_tokens` | `cached_tokens` (`prompt_cache_hit_tokens` on DeepSeek) | 0 (no separate write class reported) |
| Workers AI / cache-less                 | `prompt_tokens`                 | 0                                                       | 0                                    |

Anthropic already reports all three separately: the current code _destroys_ that by summing.
This slice preserves it.

Change set (all in ONE change: a new telemetry column can't land on one runtime; see "Keep the
runtimes symmetric"):

1. **Contracts** (`@cat-factory/contracts`): `cacheReadTokens` + `cacheWriteTokens` on
   `llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema`, and the
   export/summary schemas (`llmExportInsightSchema`, `llmMetricsExportSchema.totals`). **Drop
   `cachedPromptTokens`** (backwards-compat is a non-goal; telemetry is 3-day retention, so stale
   rows churn out within the window). `cacheHitRate` becomes `(read + write) / (prompt + read + write)`.
2. **Kernel ports**: `LlmCallMetric` + `LlmCallMetricSummary` (`ports/llm-metrics.ts`); the
   external `LlmGenerationEvent` (`ports/llm-trace-sink.ts`) gains the two fields so Langfuse
   traces carry them.
3. **`HarnessCallMetric`** (`kernel/ports/runner-transport.ts`): replace `cachedInputTokens`
   with `cacheReadTokens` + `cacheWriteTokens`; `inputTokens` becomes fresh-only.
4. **Population sites** normalize per the table above: `agent-runner.ts`
   (`claudeCallUsage` / `codexLastTurnUsage`), `harnessInline.ts` (`claudeUsage`; currently
   drops cache entirely; fix), `cache.ts` (`cachedTokensFromUsage` → split into read/write
   readers), the proxy `observe` (`LlmProxyController.ts`), and `makeHarnessCallRecorder`
   (`LlmObservabilityService.ts`).
5. **Both telemetry DBs**: D1 `telemetry-migrations/00NN_*.sql` (ALTER: add `cache_read_tokens` +
   `cache_write_tokens`, drop `cached_prompt_tokens`) ⇄ Drizzle `schema.ts` column edits + a new
   `drizzle/` migration. Both repos' `MetricRow`/`rowToMetric`, INSERT column lists, and
   `summarizeByExecution` SQL (`SUM(cache_read_tokens)`, `SUM(cache_write_tokens)`).
6. **Rollup**: `attachStepMetrics` (`RunStateMachine.ts`) copies the two new sums onto
   `step.metrics`.
7. **Frontend**: delete `freshPromptTokens` (fresh = `promptTokens`); `StepMetricsBar.vue` +
   `ObservabilityPanel.vue` show `fresh↑ / read / write / completion↓`; i18n keys for read/write
   across all 10 locales (real translations).
8. **Conformance**: `defineLlmMetricsSuite` fixture + both assertion blocks gain the two fields;
   the harness-recorder test asserts the read/write mapping.
9. **Changeset** for every touched published package.

## Per-slice checklist

| #   | Slice            | Scope                                                                                                                                             | Status  | PR  |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --- |
| 1   | Read/write split | The full change set above: contracts + kernel ports + HarnessCallMetric + population sites + both telemetry DBs + rollup + frontend + conformance | ✅ done |     |
| 2   | Cost surfacing   | `ModelPrice` cache tiers; per-call/step cost compute; observability-panel cost headline; subscription = illustrative                              | ⬜ todo |     |

## Conventions / gotchas carried between iterations

- **Keep the runtimes symmetric.** A telemetry column lands for D1 **and** Drizzle in the SAME
  change with a conformance assertion: a facade-parity gap is a showstopper. The D1 repo hand-writes
  `MetricRow`/`rowToMetric` + an explicit INSERT column list (a 3-place edit); Node is `$inferSelect`-driven.
- **`promptTokens` is fresh-only after Slice 1.** Every population site MUST subtract the cache
  classes (OpenAI) or read the separate field (Anthropic). A site that forgets re-introduces the
  double-count. The conformance harness-recorder test pins the mapping.
- **Anthropic reports all three; don't re-lump them.** `claudeCallUsage` used to sum read+write:
  that was the bug. It now carries them apart, and so must anything new that reads that usage.
- **Both inline paths carry the split** as of Slice 1: the local native CLI runner
  (`harnessInline.ts`, which previously summed the buckets into one figure) and the container
  `inline` job (whose `InlineResult.usage` folds the split out of its per-call metrics). A new
  inline runner that reports one lumped input count leaves that path blind again.
- **Telemetry ≠ spend ledger.** `llm_call_metrics` (3-day, per-run) is separate from the durable
  `token_usage` ledger (`SpendService`, ~395-day, with cost). This initiative touches ONLY the
  telemetry surface. Cost here is display-time estimation, not the billed spend gate.
- **Backwards-compat is a non-goal.** Drop `cached_prompt_tokens` cleanly rather than dual-writing;
  the 3-day retention window makes the break invisible within days.

### Carried out of Slice 1

- **A COARSE run total and a per-call metric answer different questions; never unify them.** The
  harness's `PiRunOutcome.usage` is the usage-aware key-rotation weight, so it must keep summing
  every billed input bucket, while `callMetrics` keeps the classes apart. Two sites had to sum the
  classes back explicitly after the split (`subagents.ts`'s accumulator, the Langfuse `usage.input`),
  and `inline.ts` had to fold the split OUT of the per-call metrics rather than off the coarse total.
  A site that quietly inherits the wrong one under-weights the rotation window (invisible until a key
  is throttled) or under-reports spend to an operator's dashboard.
- **`cacheHitRate` needs no clamp any more, and the clamp was the tell.** It existed only because the
  old denominator (`promptTokens`) did not contain the cache reads on the Anthropic shape. With the
  classes orthogonal the denominator is the whole input and the ratio is a genuine share. If a future
  derived ratio needs a clamp to stay in range, that is evidence its terms are not orthogonal: fix
  the terms, not the ratio.
- **Only Anthropic reports a cache-WRITE class.** OpenAI/DeepSeek report reads only, so `write` is 0
  there, never inferred. Guessing one would report spend at 1.25-2x base input that never happened.
- **ONE function reads a usage payload into all three classes** (`readInputTokenClasses`), never a
  read-the-classes helper the caller pairs by hand with a subtract-them one. The first cut had two,
  and the shape rule ("subtract on OpenAI/DeepSeek, don't on Anthropic") then lived in prose beside
  them rather than in the code: the proxy subtracted unconditionally and was correct only because
  the exclusive shape happened to leave `prompt_tokens` absent. A rule a caller can get wrong will
  eventually be got wrong.
- **The two cache classes are read INDEPENDENTLY of each other.** Detecting a read must never
  short-circuit the write, because the shapes are not mutually exclusive: an OpenAI-compatible
  gateway fronting Anthropic (`litellm`, OpenRouter) reports its reads under the OpenAI field AND
  `cache_creation_input_tokens` beside it. A read-first `if` chain zeroes the write on the ONLY
  path that reports it: the dearest class, silently, on the feature built to expose it.
- **On the inclusive shape, every class the payload reports is a partition of `prompt_tokens`**, so
  both come off. That keeps the total we record equal to the vendor's own prompt count rather than
  minting input it never billed, whichever way a gateway folds its write class.
- **A count crossing a version boundary is coerced LENIENTLY** (`coerceCallMetrics`). A runner pool
  runs whatever harness image its workspace pinned, so requiring a field a newer image added fails
  every entry and drops that pool's telemetry wholesale: the run reports zero model calls instead
  of "cache breakdown unknown". Strictness belongs on the fields whose absence makes a row
  meaningless, not on an additive one whose absence IS the older image's honest answer.
- **The AI SDK v3 usage shape already carries the split** (`inputTokens: { total, noCache, cacheRead,
cacheWrite }`), so the inline path reads it straight off rather than re-deriving; `noCache` is
  preferred over `total − read − write` because it is what the provider itself reported.
- **The frontend now derives nothing except the TOTAL.** `freshPromptTokens` (the SPA heuristic) is
  deleted, not reimplemented: the whole point of the slice is that the split arrives correct from
  the source. The one surviving helper is `totalInputTokens` (fresh + read + write), and it exists
  for the rule below.
- **The headline "↑" is the TOTAL, never the fresh figure.** Splitting the classes is about making
  COST readable; it must not be allowed to make VOLUME unreadable. The surface previously led with
  fresh on the stated grounds that the raw sum "reads as a blow-up", which is exactly the framing
  [`token-burn-instrumentation`](./token-burn-instrumentation.md) exists to reject, and it rendered
  a ~31M-token run as 685 tokens. A cached token occupies the context window like any other, and
  Claude Code's own gauge counts the same buckets, so the headline sums all three and the classes
  render as the breakdown beneath it. `frontend/app/app/utils/observability.spec.ts` pins this.
  Any new token surface follows the same shape: **total in the headline, classes in the
  breakdown.**
