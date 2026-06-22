import {
  getSelectableModel,
  individualVendorForModelId,
  type SubscriptionVendor,
} from '@cat-factory/kernel'

/** Resolve the workspace per-kind default model id (the model-defaults feature). */
export type WorkspaceModelDefaultResolver = (kind: string) => Promise<string | undefined>

/**
 * The individual-usage subscription vendors (Claude / GLM / Codex) a run will use, so
 * the caller can gate it on the initiator's personal subscription(s) up-front. This
 * mirrors the dispatch-time model precedence ({@link resolveStepModelRef}):
 *
 *  - A RESOLVABLE block pin applies to EVERY step, so it alone decides the set — its
 *    individual vendor, or NONE when the pin is a non-subscription model (Cloudflare /
 *    Bedrock / a direct provider). Workspace defaults are never consulted, so a block
 *    pinned to a Cloudflare model is NOT gated on a personal password just because some
 *    workspace per-kind default happens to be an individual-usage model.
 *  - With no pin (or a stale/unknown id that resolves to nothing), each step's kind
 *    falls to the workspace per-kind default, exactly like dispatch.
 *
 * Env-routing defaults (dispatch's last fallback) are operator-level and not gated.
 */
export async function resolveIndividualVendors(
  blockModelId: string | undefined,
  agentKinds: string[],
  resolveWorkspaceModelDefault: WorkspaceModelDefaultResolver | undefined,
): Promise<SubscriptionVendor[]> {
  if (blockModelId && getSelectableModel(blockModelId)) {
    const pinned = individualVendorForModelId(blockModelId)
    return pinned ? [pinned] : []
  }
  if (!resolveWorkspaceModelDefault || agentKinds.length === 0) return []
  const vendors = new Set<SubscriptionVendor>()
  for (const kind of agentKinds) {
    const defaultId = await resolveWorkspaceModelDefault(kind)
    const vendor = individualVendorForModelId(defaultId)
    if (vendor) vendors.add(vendor)
  }
  return [...vendors]
}
