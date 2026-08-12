import type {
  GroupCacheHandle,
  RiskPolicy,
  RiskPolicyCacheValue,
  RunDefaultScope,
} from '@cat-factory/kernel'
import type { RiskPolicyRepository } from '@cat-factory/kernel'
import { FALLBACK_RISK_POLICY } from '@cat-factory/kernel'
import type { ResolvedRunRiskPolicy } from '../execution/policy-types.js'

// ---------------------------------------------------------------------------
// WHICH merge-threshold preset governs a task: its own pick, else the workspace default, else the
// built-in `FALLBACK_RISK_POLICY`, which does NOT auto-merge (see the constant).
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

/**
 * WHICH row a resolution wants: the id the task pinned, or the workspace's default.
 *
 * A discriminated target rather than the cache key string it used to be. The key spelling is one
 * reader's encoding, and picking the id back out of it (`key.slice('picked:'.length)`) is the
 * shape that reads as correct until someone renames a prefix; a second reader that answers off a
 * preloaded library needs the id, not the key.
 */
export type RiskPolicyTarget =
  | { kind: 'picked'; id: string }
  | { kind: 'default'; scope: RunDefaultScope }

/** Reads one preset row, possibly through a cache slice or a preloaded library. */
export type RiskPolicyRead = (
  target: RiskPolicyTarget,
  load: () => Promise<RiskPolicy | null>,
) => Promise<RiskPolicy | null>

/** Read straight from the repository, for the paths with no cache slice wired to read through. */
export const directRiskPolicyRead: RiskPolicyRead = (_target, load) => load()

/**
 * The cache key one target resolves under; the ONE place that spelling lives.
 *
 * The scope is part of the DEFAULT key because a workspace has two of them and they are different
 * rows: sharing one `default` key would serve whichever scope asked first to the other, which is
 * silent and intermittent (it depends on which kind of run reached the cache first).
 */
function cacheKeyOf(target: RiskPolicyTarget): string {
  return target.kind === 'picked' ? `picked:${target.id}` : `default:${target.scope}`
}

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
  return async (target, load) =>
    (await cache.get(cacheKeyOf(target), workspaceId, async () => ({ policy: await load() })))
      .policy
}

/**
 * Answer every resolution in one workspace out of its library, already read in full.
 *
 * For the caller that resolves MANY ids in the same workspace at once (the board's preset guard,
 * judging every block in a moved subtree), where the per-id shape is the banned N+1: one point
 * read per pin plus the workspace default re-read once per pin. A preset library is a handful of
 * rows a workspace admin maintains by hand, so reading it whole is one query whatever the subtree
 * holds, and the workspace default stops being a repeated round trip.
 *
 * `load` is never called: the library IS the answer, and a miss (a pinned id that no longer exists,
 * a workspace with no default seeded) is a real null that falls through to the same place an
 * uncached read's null would, which is {@link FALLBACK_RISK_POLICY}.
 */
export function preloadedRiskPolicyRead(library: readonly RiskPolicy[]): RiskPolicyRead {
  const byId = new Map(library.map((preset) => [preset.id, preset]))
  const defaults: Record<RunDefaultScope, RiskPolicy | null> = {
    interactive: library.find((preset) => preset.isDefault) ?? null,
    unattended: library.find((preset) => preset.isUnattendedDefault) ?? null,
  }
  return (target) =>
    Promise.resolve(
      target.kind === 'picked' ? (byId.get(target.id) ?? null) : defaults[target.scope],
    )
}

/**
 * Resolve the preset governing `riskPolicyId` in a workspace.
 *
 * An ABSENT repository is not a hole to guard: with no preset library there is nothing for a task
 * to point at, so every task in the deployment is governed by {@link FALLBACK_RISK_POLICY}, whose
 * role layer is empty and therefore holds nobody to anything, and which auto-merges nothing, so
 * the deployment that configured no policy lands no PR without a human.
 *
 * A wired repository answers from a library the board was seeded with at CREATION, so reaching
 * the fallback is a deployment-level fact rather than a question of who had read what first.
 */
export async function resolveRiskPolicy(input: {
  repository: RiskPolicyRepository | undefined
  workspaceId: string
  riskPolicyId: string | null | undefined
  /**
   * WHICH default a task that pinned nothing falls back to. Required, because the two scopes are
   * different rows with different postures and a caller that has not decided which kind of run it
   * is resolving for has not finished asking the question.
   */
  scope: RunDefaultScope
  read?: RiskPolicyRead
}): Promise<ResolvedRunRiskPolicy> {
  const { repository, workspaceId, riskPolicyId, scope } = input
  if (!repository) return FALLBACK_RISK_POLICY
  const read = input.read ?? directRiskPolicyRead
  if (riskPolicyId) {
    const picked = await read({ kind: 'picked', id: riskPolicyId }, () =>
      repository.get(workspaceId, riskPolicyId),
    )
    if (picked) return picked
  }
  return (
    (await read({ kind: 'default', scope }, () => repository.getDefault(workspaceId, scope))) ??
    FALLBACK_RISK_POLICY
  )
}
