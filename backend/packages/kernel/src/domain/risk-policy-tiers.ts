import type { RiskPolicy, RiskPolicyLibraryEntry, RiskPolicySuppression } from './types.js'
import type { AccountRiskPolicy } from '../ports/risk-policy-repositories.js'

// ---------------------------------------------------------------------------
// The account ⊕ workspace merge for the risk-policy library (ADR 0055). Pure: the caller hands in
// both tiers plus the board's suppressions, and everything here is unit-testable.
//
// ONE implementation, because three readers depend on the answer being the SAME one: the board's
// settings editor lists it, every picker offers it, and the ENGINE resolves a task's pinned policy
// through it. A resolution that admitted an id the editor called hidden — or refused one the picker
// offered — would decide how much oversight a merge takes by a rule nobody could see.
// ---------------------------------------------------------------------------

/**
 * Lift an account-tier row into a library entry.
 *
 * The two default claims are stated as `false` here rather than carried on the row, because an
 * account row has no columns for them (see {@link AccountRiskPolicy}): a default is a per-board
 * answer. Writing them once, in the one place account rows enter the merged shape, is what keeps
 * every downstream reader from having to know that.
 */
function accountEntry(policy: AccountRiskPolicy): RiskPolicyLibraryEntry {
  return { ...policy, isDefault: false, isUnattendedDefault: false, tier: 'account' }
}

/** Lift a workspace-tier row into a library entry. Its default claims are its own. */
function workspaceEntry(policy: RiskPolicy): RiskPolicyLibraryEntry {
  return { ...policy, tier: 'workspace' }
}

export interface RiskPolicyTierInput {
  /** The account's policies. Empty for a board with no account (a bare test/dev board). */
  accountPolicies: readonly AccountRiskPolicy[]
  /** The board's own policies, including the built-in catalog copied in at creation. */
  workspacePolicies: readonly RiskPolicy[]
  /** The account policy ids this board hides. */
  suppressedIds: readonly string[]
}

/**
 * The library a board picks from: its own policies plus the account policies it has not hidden,
 * ordered oldest-first WITHIN each tier with the account tier first.
 *
 * Two precedence rules, and both matter:
 *
 * - **A workspace row WINS over an account row of the same id.** Every board is seeded with the
 *   built-in catalog (`mp_balanced` and friends), so an account that authors one of those ids
 *   collides with a row every board already owns. The board's own copy winning is the only reading
 *   that cannot silently re-point a board that had TIGHTENED its ceilings.
 * - **A suppressed id is dropped outright**, and only from the account tier. A board's own row is
 *   deleted, never hidden, so a suppression naming an id the board owns says nothing about it: the
 *   two are different acts on different rows, and letting a stale suppression hide a local policy
 *   would make an id unusable for reasons nothing on screen could explain.
 */
export function mergeRiskPolicyTiers(input: RiskPolicyTierInput): RiskPolicyLibraryEntry[] {
  const suppressed = new Set(input.suppressedIds)
  const own = new Set(input.workspacePolicies.map((policy) => policy.id))
  const inherited = input.accountPolicies
    .filter((policy) => !suppressed.has(policy.id) && !own.has(policy.id))
    .map(accountEntry)
  return [...inherited, ...input.workspacePolicies.map(workspaceEntry)]
}

/**
 * Resolve ONE id against the same precedence {@link mergeRiskPolicyTiers} applies, without
 * reading the whole of either tier.
 *
 * This is the engine's shape: a task pins at most one policy, so the hot path asks about one id.
 * It is expressed here, beside the list merge, precisely so the two cannot disagree — the earlier
 * bug this file exists to prevent is a resolution that answers an id the editor says is hidden.
 *
 * `workspacePolicy` is consulted first and answers alone when present, which is also why an
 * account-tier read is worth skipping when it hits: the common case is a board's own policy.
 */
export function resolveRiskPolicyTier(input: {
  workspacePolicy: RiskPolicy | null
  accountPolicy: AccountRiskPolicy | null
  suppressed: boolean
}): RiskPolicyLibraryEntry | null {
  if (input.workspacePolicy) return workspaceEntry(input.workspacePolicy)
  if (!input.accountPolicy || input.suppressed) return null
  return accountEntry(input.accountPolicy)
}

/**
 * What a board is hiding, joined against the account tier for identity.
 *
 * `inherited: false` is the case worth keeping distinct: the account has since deleted the policy
 * this suppression names, so it hides nothing today. Collapsing the two would tell an operator a
 * posture is being withheld when there is none to withhold — and the name then falls back to the
 * id, which is all that is left to identify what was hidden by.
 */
export function describeRiskPolicySuppressions(
  suppressedIds: readonly string[],
  accountPolicies: readonly AccountRiskPolicy[],
): RiskPolicySuppression[] {
  const byId = new Map(accountPolicies.map((policy) => [policy.id, policy]))
  return suppressedIds.map((id) => {
    const shadowed = byId.get(id)
    return { id, name: shadowed?.name ?? id, inherited: shadowed !== undefined }
  })
}
