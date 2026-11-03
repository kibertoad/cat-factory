import type { AccountRiskPolicy, UpdateRiskPolicyInput } from '@cat-factory/kernel'

const DEFAULT_CLAIMS: ReadonlySet<string> = new Set(['isDefault', 'isUnattendedDefault'])

/**
 * The patch as the policy fields it may replace. Indexing the policy by each patch key is what
 * fails to compile when a patch field names no stored field, or carries a different type, instead
 * of that key being spread onto the stored row.
 */
type PolicyFieldPatch = {
  [
    K in keyof Omit<UpdateRiskPolicyInput, 'isDefault' | 'isUnattendedDefault'>
  ]?: AccountRiskPolicy[K]
}

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
  const fields: PolicyFieldPatch = patch
  const stated = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => value !== undefined && !DEFAULT_CLAIMS.has(key),
    ),
  ) as Partial<AccountRiskPolicy>
  return { ...existing, ...stated }
}
