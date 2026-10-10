import * as v from 'valibot'
import { monthlyBudgetLimitSchema } from './accounts.js'

// ---------------------------------------------------------------------------
// Per-USER settings. Scoped to the signed-in user (not a workspace or account),
// persisted in the `user_settings` table (PK `user_id`) on both runtime facades.
// Today it holds only the user-tier spend budget (the third budget tier alongside
// the per-workspace and per-account limits); see the tiered-budgets initiative.
// ---------------------------------------------------------------------------

/** A user's settings. */
export const userSettingsSchema = v.object({
  /**
   * The user-tier monthly spend budget (base pricing currency): a ceiling on what
   * this user's initiated runs may spend across every workspace this period. Null ⇒
   * no user-level limit configured; the effective user budget then falls back to the
   * operator env cap (`BUDGET_MAX_MONTHLY_PER_USER`) if set, else unlimited.
   */
  spendMonthlyLimit: v.nullable(monthlyBudgetLimitSchema),
})
export type UserSettings = v.InferOutput<typeof userSettingsSchema>

/** Built-in defaults used when a user has no row yet. */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  spendMonthlyLimit: null,
}

/** Update the signed-in user's settings (full replace of the supplied fields). */
export const updateUserSettingsSchema = v.object({
  spendMonthlyLimit: v.optional(v.nullable(monthlyBudgetLimitSchema)),
})
export type UpdateUserSettingsInput = v.InferOutput<typeof updateUserSettingsSchema>
