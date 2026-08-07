import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Reports: the cross-cutting analytics projection an operator reads to answer
// "where is the money and the work going". Where `platformObservabilitySchema`
// answers "is the deployment HEALTHY" (outcomes, failures, latency), this answers
// "how is it being USED" — spend sliced by model / agent kind, and both spend and
// run activity sliced by workspace / service / task type, plus a spend trend.
//
// Every number is a SQL rollup behind the kernel `ReportsRepository` port (one
// GROUP BY per breakdown, run in parallel — never rows reduced in JS). Account
// scoped and admin-gated like the operator dashboard, with an optional single
// workspace filter that narrows every breakdown at once.
// ---------------------------------------------------------------------------

/**
 * The time window every breakdown aggregates over. `24h`/`7d` are scanned live off the
 * `token_usage` ledger; `30d`/`90d` are served from the DURABLE `spend_days` rollup the
 * retention sweep materialises, which carries each run's board shape frozen at the time the
 * money was spent. Which source answered is carried on the projection
 * ({@link reportSpendSourceSchema}) rather than left to be inferred from the window.
 */
export const reportWindowSchema = v.picklist(['24h', '7d', '30d', '90d'])
export type ReportWindow = v.InferOutput<typeof reportWindowSchema>

/**
 * Where a window's spend breakdowns and trend came from: a live scan of the `token_usage`
 * ledger (`ledger`) or the durable daily cost-attribution rollup (`daily-rollup`).
 *
 * The two differ in more than cost. The ledger is exact to the millisecond and resolves a
 * repository or a ticket through the LIVE links, so it re-attributes history whenever a
 * service is re-pointed or an issue re-imported, and it forgets everything the retention
 * sweep prunes. The rollup froze that attribution while the spend was happening and keeps it
 * with no retention at all, at the cost of being as fresh as the last sweep. A reader has to
 * know which one is talking, so it is reported rather than derived.
 */
export const reportSpendSourceSchema = v.picklist(['ledger', 'daily-rollup'])
export type ReportSpendSource = v.InferOutput<typeof reportSpendSourceSchema>

/**
 * What a SPEND breakdown groups by. `model` keys on the canonical `provider:model`
 * id; `agentKind` on the metered call's agent kind; the rest resolve through the
 * call's run (`workspace` directly, the others via the run's service and block).
 *
 * `run`, `repo` and `ticket` are the TCO axes: the dimensions an organisation actually
 * budgets against. They key on the run itself, on the run's service repo, and on the
 * tracker issue linked to the run's block, so "what did this repository cost us this
 * quarter", "what did this ticket cost" and "what did that pipeline run cost" are one
 * grouped query rather than a hand-written join against the database.
 */
export const reportSpendDimensionSchema = v.picklist([
  'model',
  'agentKind',
  'workspace',
  'service',
  'repo',
  'taskType',
  'ticket',
  'run',
])
export type ReportSpendDimension = v.InferOutput<typeof reportSpendDimensionSchema>

/**
 * What an ACTIVITY breakdown groups by. A run carries no single agent kind or model
 * (those are per-step facts, which is what the spend breakdowns key on), so the
 * activity axis is deliberately narrower than the spend axis.
 */
export const reportActivityDimensionSchema = v.picklist(['workspace', 'service', 'taskType'])
export type ReportActivityDimension = v.InferOutput<typeof reportActivityDimensionSchema>

/**
 * One slice of a spend breakdown. `key` is the raw dimension value and the row's
 * identity; EMPTY means unattributed (a call whose run, service, or task type could
 * not be resolved) — a real bucket, rendered as such, never dropped.
 *
 * The two costs are kept apart on purpose and must never be summed blindly: only
 * `meteredCost` is real money. `subscriptionCost` is what the same tokens WOULD have
 * cost on the metered API — illustrative for a flat-rate quota harness (Claude Code /
 * Codex / GLM / pooled Kimi & DeepSeek), which is why the spend gate excludes it.
 */
export const reportSpendRowSchema = v.object({
  key: v.string(),
  /** Human-readable name for `key` when the store can resolve one (workspace/service); else null. */
  label: v.nullable(v.string()),
  inputTokens: v.number(),
  outputTokens: v.number(),
  /** Number of metered LLM calls in this slice (both billing kinds). */
  calls: v.number(),
  /** Real per-token cost, in the deployment's spend currency. */
  meteredCost: v.number(),
  /** Illustrative equivalent-API cost of flat-rate subscription usage. Never real spend. */
  subscriptionCost: v.number(),
})
export type ReportSpendRow = v.InferOutput<typeof reportSpendRowSchema>

/**
 * One slice of an activity breakdown, over the agent runs CREATED in the window — every
 * kind of run (task pipelines, repo bootstraps, env-config repairs), so this half of a row
 * covers the same population whose LLM calls the spend half reports.
 */
export const reportActivityRowSchema = v.object({
  key: v.string(),
  label: v.nullable(v.string()),
  /** All runs created in the window in this slice. */
  runs: v.number(),
  done: v.number(),
  failed: v.number(),
  /** Runs still in flight (`running`). */
  running: v.number(),
  /** Every other status (`blocked` / `paused` / `pending`). */
  other: v.number(),
  /** Mean wall-clock duration over this slice's TERMINAL runs (ms); null when none. */
  avgDurationMs: v.nullable(v.number()),
})
export type ReportActivityRow = v.InferOutput<typeof reportActivityRowSchema>

/** One contiguous time bucket of the spend trend (zero-filled, oldest first). */
export const reportTrendPointSchema = v.object({
  /** Epoch-ms start of the bucket. */
  start: v.number(),
  meteredCost: v.number(),
  subscriptionCost: v.number(),
  calls: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
})
export type ReportTrendPoint = v.InferOutput<typeof reportTrendPointSchema>

/** Window-wide totals, folded from the `model` breakdown (no extra query). */
export const reportTotalsSchema = v.object({
  inputTokens: v.number(),
  outputTokens: v.number(),
  calls: v.number(),
  meteredCost: v.number(),
  subscriptionCost: v.number(),
})
export type ReportTotals = v.InferOutput<typeof reportTotalsSchema>

/** The complete reports projection the SPA renders. */
export const reportsViewSchema = v.object({
  window: reportWindowSchema,
  /** When the projection was computed (epoch ms). */
  generatedAt: v.number(),
  /**
   * Start of the window (epoch ms): `generatedAt - window`, snapped DOWN to a trend-bucket
   * edge so the chart's first column is a complete bucket rather than a short one that reads
   * as a quiet period. A window therefore covers up to one bucket more than its nominal
   * length, and this is the real span every number in the projection was computed over.
   */
  since: v.number(),
  /** The single workspace every breakdown was narrowed to, or null for the whole account. */
  workspaceId: v.nullable(v.string()),
  /** The deployment's spend currency, so the SPA formats costs without a second call. */
  currency: v.string(),
  /**
   * Which store answered every SPEND breakdown, the totals and the trend for this window.
   * The activity breakdowns always come off `agent_runs` and are unaffected.
   */
  source: reportSpendSourceSchema,
  /**
   * On a `daily-rollup` window: the newest day (epoch ms, UTC midnight) the rollup SWEEP has
   * covered, or NULL when no pass has ever completed. Always null on a `ledger` window,
   * where there is no rollup in the path to be behind.
   *
   * Null is why the field exists. A rollup that has never run and an account that has spent
   * nothing produce the same empty breakdown, and the operator response to each is the
   * opposite of the other's. It is also how a reader tells a genuinely cheap tail-end of the
   * window from one the sweep has not reached yet, which matters most on the facade whose
   * sweep is a daily cron. The value is the SWEEP's own recorded coverage, deployment-wide,
   * never `max(day)` over the rolled-up rows, which cannot tell either pair apart.
   */
  rolledUpThrough: v.nullable(v.number()),
  totals: reportTotalsSchema,
  /** Spend sliced every way, each heaviest-first. */
  spend: v.object({
    byModel: v.array(reportSpendRowSchema),
    byAgentKind: v.array(reportSpendRowSchema),
    byWorkspace: v.array(reportSpendRowSchema),
    byService: v.array(reportSpendRowSchema),
    /** Spend per linked REPOSITORY, keyed by the provider repo id and labelled `owner/name`. */
    byRepo: v.array(reportSpendRowSchema),
    byTaskType: v.array(reportSpendRowSchema),
    /**
     * Spend per linked tracker TICKET, keyed `source:externalId` (e.g. `jira:PROJ-412`) and
     * carrying NO label: the key is self-describing, and a block linked from two tickets could
     * otherwise be labelled with one ticket's title beside the other's ref.
     */
    byTicket: v.array(reportSpendRowSchema),
    /**
     * Spend per agent RUN, keyed by the run id and labelled with the title of the block the
     * run targets (null for a run that carries none, such as a repo bootstrap). The finest
     * TCO axis: what one pipeline execution cost, end to end.
     */
    byRun: v.array(reportSpendRowSchema),
  }),
  /** Run activity sliced every way, each busiest-first. */
  activity: v.object({
    byWorkspace: v.array(reportActivityRowSchema),
    byService: v.array(reportActivityRowSchema),
    byTaskType: v.array(reportActivityRowSchema),
  }),
  /** Spend over time at `bucketMs` resolution. */
  trend: v.object({
    bucketMs: v.number(),
    points: v.array(reportTrendPointSchema),
  }),
})
export type ReportsView = v.InferOutput<typeof reportsViewSchema>
