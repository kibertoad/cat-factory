import type {
  BinaryArtifactStore,
  BlockRepository,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Runtime-neutral retention sweep for binary artifacts (UI screenshots + uploaded reference
 * design images). Retention is a PER-WORKSPACE setting (`artifactRetentionDays`, default 14),
 * so unlike the deployment-global ledger sweeps this iterates workspaces and applies each
 * one's own window: an artifact is pruned — bytes AND metadata — once it ages past its
 * workspace's cutoff. The blob backend is configured per-account, so the store is resolved
 * per workspace via {@link ResolveBinaryArtifactStore} (which caches per account, so the many
 * workspaces under one account reuse a single store). Driven from the Cloudflare retention cron
 * and the Node retention timer (kept symmetric); the per-runtime wiring supplies the workspace
 * list + per-workspace day lookup as closures so this stays free of any repo/runtime types.
 *
 * A workspace whose store resolves to null is SKIPPED, and the two reasons that can happen are
 * reported by the resolver rather than here, because only it can tell them apart: an account that
 * configured no storage (nothing to reclaim, the normal case on a stock deployment) and an
 * account whose configured backend THIS PROCESS cannot build (bytes that exist and stay). The
 * second is the one a mothership deployment hits when its custom stores are registered on the
 * nodes that write them and not on the mothership that sweeps them; `makeResolveBinaryArtifactStore`
 * names the account and the store id once per pass-through of that config.
 */
export async function sweepBinaryArtifactRetention(deps: {
  resolveStore:
    | ResolveBinaryArtifactStore
    | ((workspaceId: string) => Promise<BinaryArtifactStore | null>)
  listWorkspaceIds: () => Promise<string[]>
  retentionDaysFor: (workspaceId: string) => Promise<number>
  /** Resolves block ids to the workspace homing each, for the orphan half below. */
  findBlocks: BlockRepository['findByIds']
  now: number
}): Promise<number> {
  const workspaceIds = await deps.listWorkspaceIds()
  let removed = 0
  for (const workspaceId of workspaceIds) {
    const days = await deps.retentionDaysFor(workspaceId)
    // A non-positive / non-finite window is treated as "keep everything" rather than wiping
    // the store — the UI bounds it to ≥ 1, but guard defensively against bad data.
    if (!Number.isFinite(days) || days <= 0) continue
    const store = await deps.resolveStore(workspaceId)
    if (!store) continue
    const cutoff = deps.now - days * MS_PER_DAY
    removed += await store.pruneOlderThan(workspaceId, cutoff)
    removed += await pruneOrphanedBlockArtifacts(store, deps.findBlocks, workspaceId, cutoff)
  }
  return removed
}

/**
 * The backstop for the retained kinds whose lifetime is their block's: reclaim the rows anchored
 * on a block that no longer exists in their workspace.
 *
 * A block delete reclaims them promptly, but that reclaim is best-effort and keeps any row whose
 * blob delete failed, and nothing else ever names a deleted block again. Scoped by the same cutoff
 * as the age sweep, so an image is never taken while a move or a delete may still be in flight.
 */
async function pruneOrphanedBlockArtifacts(
  store: BinaryArtifactStore,
  findBlocks: BlockRepository['findByIds'],
  workspaceId: string,
  cutoff: number,
): Promise<number> {
  const anchors = await store.listBlockAnchorsOlderThan(workspaceId, cutoff)
  if (!anchors.length) return 0
  const homed = new Set(
    (await findBlocks(anchors))
      .filter((found) => found.workspaceId === workspaceId)
      .map((found) => found.block.id),
  )
  const orphaned = anchors.filter((blockId) => !homed.has(blockId))
  return orphaned.length ? store.pruneByBlocks(workspaceId, orphaned) : 0
}
