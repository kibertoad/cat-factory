import type { GroupCacheHandle, RiskPolicy, RiskPolicyCacheValue } from '@cat-factory/kernel'
import type { RiskPolicyRepository } from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY } from '@cat-factory/kernel'
import type { ResolvedRunRiskPolicy } from '../execution/policy-types.js'

// ---------------------------------------------------------------------------
// WHICH merge-threshold preset governs a task: its own pick, else the workspace default, else the
// built-in `DEFAULT_RISK_POLICY`.
//
// One implementation, because two readers depend on the answer being the SAME one: the engine
// resolves it to make the merge decision, and the board's preset-SELECTION guard resolves it to
// judge a swap against the policy actually in force. A guard that resolved "the task's current
// policy" even slightly differently from the engine would refuse (or admit) swaps by a rule nobody
// enforces, and a dangling `riskPolicyId` falling back to the default rather than to the built-in
// is exactly the kind of divergence that would go unnoticed.
//
// The cache is a per-caller decision rather than a property of the resolution: the engine reads a
// slow-moving row on every gate evaluation and wants the slice; the guard runs on a rare board
// write and is an authorization decision, which is the last place to want a stale-by-a-TTL answer.
// ---------------------------------------------------------------------------

/** Reads one preset row, possibly through a cache slice. */
export type RiskPolicyRead = (
  key: string,
  load: () => Promise<RiskPolicy | null>,
) => Promise<RiskPolicy | null>

/** Read straight from the repository, for the paths with no cache slice wired to read through. */
export const directRiskPolicyRead: RiskPolicyRead = (_key, load) => load()

/**
 * Read through the `AppCaches.riskPolicy` slice, grouped by workspace (one preset write drops the
 * whole library) and keyed per resolved id, so a task's pick and the workspace default cache
 * separately. A null (deleted id / unseeded default) caches as a VALUE and still falls through,
 * exactly as an uncached read would. That is what the `RiskPolicyCacheValue` wrapper is for.
 */
export function cachedRiskPolicyRead(
  cache: GroupCacheHandle<RiskPolicyCacheValue> | undefined,
  workspaceId: string,
): RiskPolicyRead {
  if (!cache) return directRiskPolicyRead
  return async (key, load) =>
    (await cache.get(key, workspaceId, async () => ({ policy: await load() }))).policy
}

/**
 * Resolve the preset governing `riskPolicyId` in a workspace.
 *
 * An ABSENT repository is not a hole to guard: with no preset library there is nothing for a task
 * to point at, so every task in the deployment is governed by {@link DEFAULT_RISK_POLICY}, whose
 * role layer is empty and therefore holds nobody to anything.
 */
export async function resolveRiskPolicy(input: {
  repository: RiskPolicyRepository | undefined
  workspaceId: string
  riskPolicyId: string | null | undefined
  read?: RiskPolicyRead
}): Promise<ResolvedRunRiskPolicy> {
  const { repository, workspaceId, riskPolicyId } = input
  if (!repository) return DEFAULT_RISK_POLICY
  const read = input.read ?? directRiskPolicyRead
  if (riskPolicyId) {
    const picked = await read(`picked:${riskPolicyId}`, () =>
      repository.get(workspaceId, riskPolicyId),
    )
    if (picked) return picked
  }
  return (await read('default', () => repository.getDefault(workspaceId))) ?? DEFAULT_RISK_POLICY
}
