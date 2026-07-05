import {
  DEFAULT_USER_SETTINGS,
  type UpdateUserSettingsInput,
  type UserSettings,
} from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import type { UserSettingsRepository } from '@cat-factory/kernel'

export interface UserSettingsServiceDependencies {
  userSettingsRepository: UserSettingsRepository
  /**
   * Invalidate the spend service's cached user-tier limit when the user's budget
   * changes, so the new ceiling takes effect immediately.
   */
  onUserBudgetChanged?: (userId: string) => void
  /**
   * The operator hard ceiling on the user-tier budget (`BUDGET_MAX_MONTHLY_PER_USER`), or
   * null/undefined when uncapped. Enforced on write so a submitted value can't exceed the
   * cap (the docs promise server-side enforcement; the gate additionally clamps at read
   * time). A late-bound getter so it tracks the live pricing config.
   */
  resolveUserBudgetCap?: () => number | null | undefined
}

/**
 * Per-user settings (today: the user-tier spend budget). Reads fall back to the
 * built-in defaults when a user has never saved a row; updates are a full-replace of
 * the supplied fields, mirroring the workspace-settings service.
 */
export class UserSettingsService {
  constructor(private readonly deps: UserSettingsServiceDependencies) {}

  async get(userId: string): Promise<UserSettings> {
    return (await this.deps.userSettingsRepository.get(userId)) ?? DEFAULT_USER_SETTINGS
  }

  async update(userId: string, input: UpdateUserSettingsInput): Promise<UserSettings> {
    const current = await this.get(userId)
    const next: UserSettings = {
      spendMonthlyLimit:
        'spendMonthlyLimit' in input
          ? (input.spendMonthlyLimit ?? null)
          : current.spendMonthlyLimit,
    }
    const cap = this.deps.resolveUserBudgetCap?.()
    if (next.spendMonthlyLimit != null && cap != null && next.spendMonthlyLimit > cap) {
      throw new ValidationError(
        `User monthly budget (${next.spendMonthlyLimit}) exceeds the operator cap (${cap}).`,
      )
    }
    await this.deps.userSettingsRepository.upsert(userId, next)
    this.deps.onUserBudgetChanged?.(userId)
    return next
  }
}
