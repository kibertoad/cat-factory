import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Public spend analytics (`GET /api/v1/usage/spend`): the workspace's money sliced by the
// dimension a budget is actually kept against.
//
// `GET /api/v1/usage` answers "how much has this board spent THIS PERIOD, and is it paused",
// grouped by `(billing, vendor, provider, model)`. That is the budget question. It cannot
// answer the TCO one (what did this repository cost us last quarter, what did that ticket
// cost, what did one pipeline run cost), because it carries no board-shape axis and no window
// but the current calendar month. Inside the product those answers already exist (the Reports
// panel reads them account-wide behind the admin gate, served for the long windows from the
// durable `spend_days` rollup); outside it there was nothing, so an external cost dashboard
// had to re-derive attribution it could not see.
//
// The shapes here are deliberately their OWN projection rather than the internal report rows,
// exactly as `publicUsageRow` is a projection of `UsageBreakdownRow`: everything on this page
// is frozen by the public-API stability contract, and an internal analytics shape must stay
// free to change. That covers the VOCABULARIES too, which are declared below rather than
// aliased off `reports.ts`: an alias makes an internal rename a silent `/api/v1` break, where a
// declaration turns the same edit into a failing assertion in `public-spend.test.ts` naming
// this file as the thing that has to decide.
// ---------------------------------------------------------------------------

/**
 * The time window a breakdown aggregates over, measured back from `generatedAt` and snapped
 * DOWN to a bucket edge (see {@link publicSpendSchema}'s `since`).
 *
 * Same members as the internal `reportWindowSchema` in `reports.ts`, and `public-spend.test.ts`
 * asserts the two stay in step, but this is the FROZEN copy: adding a
 * window internally does not publish it, and removing one internally has to arrive here as a
 * deliberate `/api/v1` decision rather than as a member that quietly stopped being accepted.
 */
export const publicSpendWindowSchema = v.picklist(['24h', '7d', '30d', '90d'])
export type PublicSpendWindow = v.InferOutput<typeof publicSpendWindowSchema>

/**
 * Which store answered a breakdown. Frozen here for the same reason the window is: this is a
 * value an external consumer branches on, so the internal spelling of it is not free to move.
 */
export const publicSpendSourceSchema = v.picklist(['ledger', 'daily-rollup'])
export type PublicSpendSource = v.InferOutput<typeof publicSpendSourceSchema>

/**
 * Hard ceiling on the slices one response may carry.
 *
 * A real bound rather than a suggestion: two of the published dimensions grow with ACTIVITY
 * rather than with a catalog (`run` is one row per pipeline execution, `ticket` one per issue
 * a run touched), so an unbounded `90d` breakdown on a busy board is a response nobody sized.
 * The rows are heaviest first, so the cap is a prefix by cost: the slice a cost question is
 * about, with {@link publicSpendSchema}'s `truncated` saying when there was a tail.
 */
export const PUBLIC_SPEND_MAX_ROWS = 500

/**
 * What a public spend breakdown groups by.
 *
 * The two axes this surface exists for are `repo` and `ticket`: what an organisation budgets
 * against, and the pair no other public read can produce. `run` is the finest of the three
 * (one pipeline execution, end to end), and the rest are the same slices the usage read
 * already implies, offered here because they come from one grouped query rather than four.
 */
export const publicSpendDimensionSchema = v.picklist([
  'model',
  'agentKind',
  'service',
  'repo',
  'taskType',
  'ticket',
  'run',
])
export type PublicSpendDimension = v.InferOutput<typeof publicSpendDimensionSchema>

/**
 * The spend dimensions this surface deliberately does NOT offer, each with the reason.
 *
 * Stated rather than left as an absence, and paired with a test asserting every internal
 * `reportSpendDimensionSchema` member is EXACTLY ONCE across the two lists: a dimension
 * added internally then has to be either published or explained, instead of silently missing
 * from the surface that four SDKs are generated against.
 */
export const PUBLIC_SPEND_DIMENSIONS_OMITTED: Record<string, string> = {
  workspace:
    'Every key is bound to one workspace, so this axis would return a single row naming the ' +
    'board the caller already addressed. The account-wide view it exists for is admin-gated ' +
    'and cross-workspace, which is exactly what a workspace-scoped key must never reach.',
}

/**
 * One slice of a spend breakdown.
 *
 * `key` is the raw dimension value and the row's identity; the EMPTY string is a real bucket
 * meaning UNATTRIBUTED (a call whose run, service, repository or ticket could not be resolved),
 * never a dropped row. Dropping it would under-report the window while the breakdown still
 * looked complete, which is the one thing `totals` and `truncated` exist to prevent.
 *
 * The two costs are separate on purpose and must never be summed: only `meteredCost` is money.
 * `subscriptionCost` is what the same tokens WOULD have cost on the metered API, which is what
 * a flat-rate harness plan (Claude Code, Codex, …) spends nothing per token on, and it is why
 * the spend budget excludes it.
 */
export const publicSpendRowSchema = v.object({
  key: v.string(),
  /**
   * A display name for `key` where the store can resolve one (a service's frame title, a
   * repository's `owner/name`, the title of the block a run targets); null where the key is
   * self-describing (a model id, an agent kind, a task type) or where nothing could be joined
   * (a repository this board holds no projection row for keeps its money and loses its name).
   */
  label: v.nullable(v.string()),
  inputTokens: v.number(),
  outputTokens: v.number(),
  /** Recorded LLM calls in this slice, both billing kinds. */
  calls: v.number(),
  /** Real per-token cost, in the response's `currency`. */
  meteredCost: v.number(),
  /** Illustrative equivalent-API cost of flat-rate subscription usage. Never real spend. */
  subscriptionCost: v.number(),
})
export type PublicSpendRow = v.InferOutput<typeof publicSpendRowSchema>

/**
 * Window-wide totals, over EVERY slice the window holds rather than only the ones `rows`
 * carries. So a `truncated` breakdown still reports what the board actually spent, the same
 * rule the run LLM export states about its own rollups, and a caller reading the top twenty
 * repositories can still say what share of the bill they are. On an untruncated response the
 * rows sum to exactly this.
 */
export const publicSpendTotalsSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  calls: v.number(),
  meteredCost: v.number(),
  subscriptionCost: v.number(),
})
export type PublicSpendTotals = v.InferOutput<typeof publicSpendTotalsSchema>

/** Query of `GET /api/v1/usage/spend`. */
export const publicSpendQuerySchema = v.object({
  dimension: publicSpendDimensionSchema,
  /** Defaults to `7d`, the widest window served live off the ledger. */
  window: v.optional(publicSpendWindowSchema),
  /**
   * How many SLICES to return, 1..{@link PUBLIC_SPEND_MAX_ROWS} (default 100), heaviest first.
   * `totals` is unaffected: it aggregates the whole window whatever this says, so a capped
   * response still reports what the board spent.
   *
   * Digit-checked before the numeric coercion, like every other query number on this API:
   * bare `Number()` also accepts `1e9`, `0x64` and `' '`, which read as plausible values
   * rather than as the 400 a malformed request has earned.
   */
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^\d+$/, 'Must be a whole number'),
      v.transform(Number),
      v.number(),
      v.integer(),
      v.minValue(1),
      v.maxValue(PUBLIC_SPEND_MAX_ROWS),
    ),
  ),
})
export type PublicSpendQuery = v.InferOutput<typeof publicSpendQuerySchema>

/**
 * The workspace's spend over a window, sliced one way.
 *
 * ONE dimension per request rather than every dimension at once (the shape the internal
 * Reports panel reads): a panel renders all of them together, where a caller asks a question
 * and each dimension is its own grouped query. Serving seven would make the common request
 * seven times the work and the response mostly rows nobody asked for.
 */
export const publicSpendSchema = v.object({
  /** Echoes the requested dimension, so a stored response says what it grouped by. */
  dimension: publicSpendDimensionSchema,
  window: publicSpendWindowSchema,
  /** When the breakdown was computed (epoch ms). */
  generatedAt: v.number(),
  /**
   * Start of the window (epoch ms): `generatedAt - window`, snapped DOWN to a bucket edge, and
   * the real span every number here was computed over. A window therefore covers up to one
   * bucket more than its nominal length, which is why this is reported rather than left to be
   * re-derived from `window`.
   */
  since: v.number(),
  /** ISO 4217 currency both costs are denominated in (the deployment's base currency). */
  currency: v.string(),
  /**
   * Which store answered: a live scan of the metered ledger (`ledger`, the `24h`/`7d` windows)
   * or the durable daily cost-attribution rollup (`daily-rollup`, `30d`/`90d`).
   *
   * They differ in more than freshness. The ledger resolves a repository or a ticket through
   * the LIVE links, so it re-attributes history whenever a service is re-pointed or an issue
   * re-imported, and it forgets whatever retention has pruned. The rollup froze that
   * attribution while the money was being spent and is never pruned, at the cost of being only
   * as current as the last sweep. A reader comparing two windows has to know which is talking.
   */
  source: publicSpendSourceSchema,
  /**
   * On a `daily-rollup` window: the newest UTC day (epoch ms, midnight) the rollup sweep has
   * covered, or null when no pass has ever completed. Always null on a `ledger` window, where
   * there is no rollup in the path to be behind.
   *
   * Null is why the field exists: a rollup that has never run and a board that spent nothing
   * produce the same empty breakdown, and they call for opposite reactions. Read it before
   * reporting a quiet quarter.
   */
  rolledUpThrough: v.nullable(v.number()),
  totals: publicSpendTotalsSchema,
  /**
   * True when the window holds more slices than `limit`, so `rows` is the heaviest prefix of
   * them rather than all of them. STATED rather than left to be inferred from
   * `rows.length === limit`, which cannot tell a board with exactly `limit` slices from one
   * with a tail, and which is the reading that turns a capped list into a complete one.
   *
   * `totals` above is unaffected, so the share the returned rows account for is computable:
   * what a truncated breakdown loses is the identity of the long tail, never its money.
   */
  truncated: v.boolean(),
  /**
   * The slices, heaviest by metered cost first, capped at `limit`.
   *
   * Capped rather than served whole because two of the published dimensions grow with
   * ACTIVITY rather than with a catalog: `run` is one row per pipeline execution and `ticket`
   * one per issue a run touched, so a busy board over `90d` is thousands of rows on a
   * response nobody sized. (`model`, `agentKind`, `service`, `repo` and `taskType` all key on
   * a catalog and stay small on their own.) The order is what makes the cap honest: a cost
   * question is about the heavy end, `truncated` says when there was a tail, and `totals`
   * still covers all of it.
   */
  rows: v.array(publicSpendRowSchema),
})
export type PublicSpend = v.InferOutput<typeof publicSpendSchema>
