import * as v from 'valibot'
import { createTaskTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Per-workspace runtime settings. A single settings object per workspace (lazily
// seeded from the defaults) holding the operator-tunable policies that aren't
// per-task: how long a run may wait for a human before its notification escalates
// to red, and whether/how to cap the number of tasks running concurrently under one
// service. Persisted in the `workspace_settings` table on both runtime facades.
// ---------------------------------------------------------------------------

/**
 * How the per-service running-task limit is bucketed:
 *  - `off`      — no limit (the default).
 *  - `shared`   — one shared cap across all task types under a service.
 *  - `per_type` — a separate cap per task type under a service.
 */
export const taskLimitModeSchema = v.picklist(['off', 'shared', 'per_type'])
export type TaskLimitMode = v.InferOutput<typeof taskLimitModeSchema>

const limitSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))

/** Per-task-type running-task caps (used when {@link taskLimitModeSchema} is `per_type`). */
export const taskLimitPerTypeSchema = v.record(createTaskTypeSchema, limitSchema)
export type TaskLimitPerType = v.InferOutput<typeof taskLimitPerTypeSchema>

// ---------------------------------------------------------------------------
// Per-workspace spend budget. Moved out of the deployment-wide env vars
// (`SPEND_MONTHLY_LIMIT` / `SPEND_CURRENCY`) onto the workspace settings row so
// an operator can tune a workspace's budget in the UI without a redeploy. Both
// are nullable; null ⇒ fall back to the built-in `DEFAULT_SPEND_PRICING` base
// table (the spend service resolves the effective pricing per workspace,
// overlaying the OpenRouter catalog as before).
// ---------------------------------------------------------------------------

/** ISO 4217 currency code (3 letters), e.g. `EUR`. */
const spendCurrencySchema = v.pipe(
  v.string(),
  v.trim(),
  v.toUpperCase(),
  v.length(3),
  v.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code'),
)

/** A workspace's runtime settings. */
export const workspaceSettingsSchema = v.object({
  /**
   * Minutes a run may wait for human input before its open notification escalates
   * from `normal` (yellow) to `urgent` (red). The run itself is never auto-failed.
   */
  waitingEscalationMinutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  /** Whether/how the per-service running-task limit is enforced. */
  taskLimitMode: taskLimitModeSchema,
  /** The shared cap, when {@link taskLimitMode} is `shared`. Null otherwise. */
  taskLimitShared: v.nullable(limitSchema),
  /** The per-type caps, when {@link taskLimitMode} is `per_type`. Null otherwise. */
  taskLimitPerType: v.nullable(taskLimitPerTypeSchema),
  /**
   * Whether to store the complete context provided to each container agent (the
   * fully composed system + user prompts, the best-practice fragment bodies folded
   * in, and the full content of the files injected into the container) for the
   * observability viewer. On by default. The heavy, potentially sensitive bodies ride
   * the same retention window as the per-call LLM telemetry, and storing is also
   * suppressed when the deployment disables prompt recording (`LLM_RECORD_PROMPTS`).
   */
  storeAgentContext: v.boolean(),
  /** Spend budget currency (ISO 4217). Null ⇒ the built-in default (`EUR`). */
  spendCurrency: v.nullable(spendCurrencySchema),
  /**
   * Monthly spend budget in {@link spendCurrency}. Null ⇒ the built-in default
   * (~100 EUR). `0` is intentional and valid — it means "no PAID spend": runs on
   * metered models (direct API keys / Cloudflare Workers AI) are refused at start and
   * paused mid-run, while LOCAL-runner models (keyless) and connected SUBSCRIPTIONS
   * (Claude Code / Codex, flat-rate quota) keep running, since they incur no metered
   * cost. So `0` is the "local-/subscription-only" setting, not a footgun — it's
   * reversible from the UI and clearer than an unbounded "unlimited" that can run up a
   * bill. The gate is per-workspace (see the spend safeguard); web search still costs
   * money, so a `0` budget also blocks paid web searches.
   */
  spendMonthlyLimit: v.nullable(v.pipe(v.number(), v.minValue(0))),
})
export type WorkspaceSettings = v.InferOutput<typeof workspaceSettingsSchema>

/** Update a workspace's runtime settings (full replace of the supplied fields). */
export const updateWorkspaceSettingsSchema = v.object({
  waitingEscalationMinutes: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000)),
  ),
  taskLimitMode: v.optional(taskLimitModeSchema),
  taskLimitShared: v.optional(v.nullable(limitSchema)),
  taskLimitPerType: v.optional(v.nullable(taskLimitPerTypeSchema)),
  storeAgentContext: v.optional(v.boolean()),
  spendCurrency: v.optional(v.nullable(spendCurrencySchema)),
  spendMonthlyLimit: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
})
export type UpdateWorkspaceSettingsInput = v.InferOutput<typeof updateWorkspaceSettingsSchema>
