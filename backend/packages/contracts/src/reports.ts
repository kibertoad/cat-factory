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

/** The time window every breakdown aggregates over. */
export const reportWindowSchema = v.picklist(['24h', '7d', '30d', '90d'])
export type ReportWindow = v.InferOutput<typeof reportWindowSchema>

/**
 * What a SPEND breakdown groups by. `model` keys on the canonical `provider:model`
 * id; `agentKind` on the metered call's agent kind; the rest resolve through the
 * call's run (`workspace` directly, the others via the run's service and block).
 *
 * `repo` and `ticket` are the TCO axes: the two dimensions an organisation actually
 * budgets against. They key on the run's service repo and on the tracker issue linked
 * to the run's block respectively, so "what did this repository cost us this quarter"
 * and "what did this ticket cost" are one grouped query rather than a hand-written join
 * against the database.
 */
export const reportSpendDimensionSchema = v.picklist([
  'model',
  'agentKind',
  'workspace',
  'service',
  'repo',
  'taskType',
  'ticket',
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
    /** Spend per linked tracker TICKET, keyed `source:externalId` and labelled with its title. */
    byTicket: v.array(reportSpendRowSchema),
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
