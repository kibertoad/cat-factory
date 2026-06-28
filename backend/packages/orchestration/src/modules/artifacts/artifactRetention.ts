import type { BinaryArtifactStore } from '@cat-factory/kernel'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Runtime-neutral retention sweep for binary artifacts (UI screenshots + uploaded reference
 * design images). Retention is a PER-WORKSPACE setting (`artifactRetentionDays`, default 14),
 * so unlike the deployment-global ledger sweeps this iterates workspaces and applies each
 * one's own window: an artifact is pruned — bytes AND metadata — once it ages past its
 * workspace's cutoff. Driven from the Cloudflare retention cron and the Node retention timer
 * (kept symmetric); the per-runtime wiring supplies the workspace list + per-workspace day
 * lookup as closures so this stays free of any repo/runtime types.
 */
export async function sweepBinaryArtifactRetention(deps: {
  store: Pick<BinaryArtifactStore, 'pruneOlderThan'>
  listWorkspaceIds: () => Promise<string[]>
  retentionDaysFor: (workspaceId: string) => Promise<number>
  now: number
}): Promise<number> {
  const workspaceIds = await deps.listWorkspaceIds()
  let removed = 0
  for (const workspaceId of workspaceIds) {
    const days = await deps.retentionDaysFor(workspaceId)
    // A non-positive / non-finite window is treated as "keep everything" rather than wiping
    // the store — the UI bounds it to ≥ 1, but guard defensively against bad data.
    if (!Number.isFinite(days) || days <= 0) continue
    const cutoff = deps.now - days * MS_PER_DAY
    removed += await deps.store.pruneOlderThan(workspaceId, cutoff)
  }
  return removed
}
