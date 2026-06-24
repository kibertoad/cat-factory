import {
  getSelectableModel,
  personalCredentialVendorForModelId,
  type SubscriptionVendor,
} from '@cat-factory/kernel'

/** Resolve a kind's default model id via the workspace's model presets. */
export type WorkspaceModelDefaultResolver = (kind: string) => Promise<string | undefined>

/** Whether the run's user has their OWN personal subscription for an individual vendor. */
export type HasPersonalSubscription = (vendor: SubscriptionVendor) => boolean

/**
 * The individual-usage subscription vendors (Claude / Codex / GLM-for-a-subscriber) a run
 * will ACTUALLY lease a personal credential for, so the caller can gate it on the
 * initiator's personal subscription(s) up-front. Mirrors dispatch on TWO axes:
 *
 *  - Model precedence ({@link resolveStepModelRef}): a RESOLVABLE block pin applies to
 *    every step, so it alone decides the set; only an unpinned run (or a stale/unknown
 *    id) falls to the workspace per-kind defaults. Env-routing defaults (dispatch's last
 *    fallback) are operator-level and not gated.
 *  - Personal-credential need ({@link personalCredentialVendorForModelId}, mirroring
 *    `ContainerAgentExecutor.resolveEffectiveRef`): a credential is leased for a
 *    subscription-only individual model (Claude / Codex) always, and for a DUAL-MODE
 *    individual model (GLM) only when THIS user has their own subscription for it (else
 *    it runs on the Cloudflare base, ungated). `hasPersonalSubscription` reports that.
 */
export async function resolveIndividualVendors(
  blockModelId: string | undefined,
  agentKinds: string[],
  resolveWorkspaceModelDefault: WorkspaceModelDefaultResolver | undefined,
  hasPersonalSubscription: HasPersonalSubscription,
): Promise<SubscriptionVendor[]> {
  if (blockModelId && getSelectableModel(blockModelId)) {
    const pinned = personalCredentialVendorForModelId(blockModelId, hasPersonalSubscription)
    return pinned ? [pinned] : []
  }
  if (!resolveWorkspaceModelDefault || agentKinds.length === 0) return []
  const vendors = new Set<SubscriptionVendor>()
  for (const kind of agentKinds) {
    const defaultId = await resolveWorkspaceModelDefault(kind)
    const vendor = personalCredentialVendorForModelId(defaultId, hasPersonalSubscription)
    if (vendor) vendors.add(vendor)
  }
  return [...vendors]
}
