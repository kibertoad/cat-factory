import type { AccountRiskPolicy, UpdateRiskPolicyInput } from '@cat-factory/kernel'

const DEFAULT_CLAIMS: ReadonlySet<string> = new Set(['isDefault', 'isUnattendedDefault'])

/**
 * Apply a policy PATCH: every field the patch states replaces the stored one, and an absent field
 * keeps it. Shared by the board and account tiers so a field added to the patch schema reaches both
 * stores without a second list to keep in step.
 *
 * Map fields (`classRules`, `classRulesByRole`, `submissionClassesByRole`, `dryRunRoles`) replace
 * the whole stored value rather than merging, so clearing one entry is a plain omission from the
 * submitted set. The editor submits the full map on every save and depends on that.
 *
 * The two default claims are left to the caller: only the board tier holds them, and it guards
 * each demotion before it applies one.
 */
export function applyRiskPolicyPatch<T extends AccountRiskPolicy>(
  existing: T,
  patch: UpdateRiskPolicyInput,
): T {
  const stated = Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined && !DEFAULT_CLAIMS.has(key)),
  ) as Partial<T>
  return { ...existing, ...stated }
}
