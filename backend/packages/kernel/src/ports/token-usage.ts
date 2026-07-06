// Persistence port for the spend safeguard. Every LLM call's token usage is
// recorded here; the SpendService aggregates it over the current billing period
// to decide whether the configured budget has been exhausted. The domain
// depends only on this interface — the worker implements it against D1.

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
  /** Estimated cost of this call, priced at record time so history is stable. */
  costEstimate: number
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
  /** Append a metered call. */
  record(usage: TokenUsageRecord): Promise<void>
  /**
   * Sum usage across all workspaces since `epochMs` (inclusive). Retained for the
   * deployment-wide rollup; the per-workspace budget gate uses
   * {@link totalsSinceForWorkspace}.
   */
  totalsSince(epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum usage for a single workspace since `epochMs` (inclusive). Budgets are
   * per-workspace, so the spend gate scopes its current-period rollup to the
   * workspace whose run is about to execute.
   */
  totalsSinceForWorkspace(workspaceId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum usage for a single account since `epochMs` (inclusive) — the account-tier
   * budget rollup, across every workspace the account owns. Reads the denormalized
   * `account_id` column.
   */
  totalsSinceForAccount(accountId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Sum usage for a single initiating user since `epochMs` (inclusive) — the
   * user-tier budget rollup, across every run they started. Reads the denormalized
   * `user_id` column.
   */
  totalsSinceForUser(userId: string, epochMs: number): Promise<TokenUsageTotals>
  /**
   * Retention: delete rows older than `epochMs` (exclusive), returning how many
   * were removed. The budget query only reads the current period, so pruning old
   * history caps this append-only ledger without affecting spend gating.
   */
  deleteOlderThan(epochMs: number): Promise<number>
}
