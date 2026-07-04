import type { MergePrEntry } from '@cat-factory/kernel'

/**
 * Order a multi-repo task's PRs for the all-green-then-merge-all sequence (service-connections
 * phase 4), **provider before consumer**.
 *
 * In the canonical topology the task sits on the CONSUMER service and its involved services are
 * the PROVIDERS it uses (an "Auth uses Email" task changes both Auth and Email). Merging the
 * provider PRs first means the consumer never lands referencing an unmerged provider change. We
 * therefore merge the peer (provider) PRs first — sorted by frame id (falling back to repo name)
 * for a deterministic order — and the own-service (consumer) PR last. This doubles as the
 * design's specified deterministic fallback for a cyclic connection graph ("primary … then frame
 * id order"), so a cycle can't deadlock the sequence.
 *
 * (A full graph-topological order across a multi-hop provider chain, or a task that sits on a
 * PROVIDER rather than the consumer, is a future refinement; the peers-then-own rule is correct
 * for the star topology that dominates and deterministic for every other.)
 *
 * The own-service entry is the one with no `repo` (see `allPullRequests`: own carries neither
 * `repo` nor `frameId`; peers always carry `repo`). Returns the entries unchanged when there is
 * 0 or 1 PR (nothing to order).
 */
export function orderPrsForMerge(entries: MergePrEntry[]): MergePrEntry[] {
  if (entries.length <= 1) return entries
  const own = entries.filter((e) => !e.repo)
  const peers = entries
    .filter((e) => e.repo)
    .sort((a, b) => (a.frameId ?? a.repo ?? '').localeCompare(b.frameId ?? b.repo ?? ''))
  return [...peers, ...own]
}
