// Persistence port for the spend safeguard. Every LLM call's token usage is
// recorded here; the SpendService aggregates it over the current billing period
// to decide whether the configured budget has been exhausted. The domain
// depends only on this interface — the worker implements it against D1.

/**
 * Whether a usage row is a real metered cost (a per-token API/proxy call, which the
 * budget gate sums) or a flat-rate subscription call (Claude Code / Codex / GLM / pooled
 * Kimi & DeepSeek). Subscription rows are counted for the usage report but EXCLUDED from
 * every spend rollup — a quota plan costs nothing per token, so letting one into the
 * budget gate would wrongly pause runs. See the usage-and-quota-tracking initiative.
 */
export type UsageBilling = 'metered' | 'subscription'

/**
 * One usage-report row: aggregated token usage for one `(billing, vendor, provider,
 * model)` group over a window. `costEstimate` is illustrative for subscription rows (what
 * the same tokens would have cost on the metered API) and never summed into a budget.
 */
export interface UsageBreakdownRow {
  billing: UsageBilling
  /** The subscription vendor for a subscription row; null for a metered row. */
  vendor: string | null
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  costEstimate: number
  /** Number of recorded calls in this group. */
  calls: number
}

/** One metered LLM call. `costEstimate` is in the deployment's spend currency. */
export interface TokenUsageRecord {
  id: string
  workspaceId: string
  /**
   * The owning account of `workspaceId`, denormalized at record time so the
   * account-tier budget rollup is a single indexed read. Null when the workspace is
   * unscoped/legacy (no account) or the account couldn't be resolved.
   */
  accountId: string | null
  /**
   * The user who initiated the run this call belongs to (the run's `initiatedBy`),
   * denormalized so the user-tier budget rollup is a single indexed read. Null when
   * no initiating user is known (e.g. system/anonymous paths).
   */
  userId: string | null
  executionId: string | null
  agentKind: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  /**
   * Estimated cost of this call, priced at record time so history is stable. For a
   * subscription row this is illustrative (the equivalent metered-API cost), never budget.
   */
  costEstimate: number
  /**
   * Metered (per-token API/proxy cost, summed by the budget gate) or subscription
   * (flat-rate quota harness usage, counted for reporting but excluded from spend).
   */
  billing: UsageBilling
  /** The subscription vendor for a subscription row (claude/codex/glm/kimi/deepseek); null for metered. */
  vendor: string | null
  /** When the call was metered (epoch ms). */
  createdAt: number
}

/** Aggregated usage over a time window, used to evaluate the budget. */
export interface TokenUsageTotals {
  inputTokens: number
  outputTokens: number
  costEstimate: number
}

export interface TokenUsageRepository {
  /** Append a usage row (metered or subscription). */
  record(usage: TokenUsageRecord): Promise<void>
  /**
   * The usage report for one workspace since `epochMs` (inclusive): one aggregated row per
   * `(billing, vendor, provider, model)` group, summed in SQL (a single GROUP BY — never a
   * per-model loop). Includes BOTH metered and subscription rows, since the report shows
   * total usage; the spend rollups below stay metered-only.
   */
  usageBreakdownForWorkspace(workspaceId: string, epochMs: number): Promise<UsageBreakdownRow[]>
  /**
   * Sum METERED usage across all workspaces since `epochMs` (inclusive). Retained for the
   * deployment-wide rollup; the per-workspace budget gate uses
   * {@link totalsSinceForWorkspace}. Subscription rows are excluded (they never cost).
   */
  totalsSince(epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum METERED usage for a single workspace since `epochMs` (inclusive). Budgets are
   * per-workspace, so the spend gate scopes its current-period rollup to the
   * workspace whose run is about to execute. Subscription rows are excluded.
   */
  totalsSinceForWorkspace(workspaceId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum METERED usage for a single account since `epochMs` (inclusive) — the account-tier
   * budget rollup, across every workspace the account owns. Reads the denormalized
   * `account_id` column. Subscription rows are excluded.
   */
  totalsSinceForAccount(accountId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum METERED usage for a single initiating user since `epochMs` (inclusive) — the
   * user-tier budget rollup, across every run they started. Reads the denormalized
   * `user_id` column. Subscription rows are excluded.
   */
  totalsSinceForUser(userId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many
   * were removed. The budget query only reads the current period, so pruning old
   * history caps this append-only ledger without affecting spend gating.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
