// The shape every SEALED CONNECTION store answers a batched open with.
//
// A workspace's document-source and tracker connections are stored one row per
// `(workspace, source)` with the credential bag SEALED, and opened through a store rather than
// inside the repository so a mothership-mode node can reach them at all (see
// `DocumentConnectionStore` / `TaskConnectionStore`, and docs/initiatives/mothership-mode.md).
//
// This type exists because a BATCHED open has a failure mode a point read does not: the sources in
// one call are independent facts about independent vendors, so collapsing them into one resolve-or-
// reject makes a single corrupt row speak for all of them. A run's whole document corpus reported
// as `credentials_unreadable` because one shelf entry drifted, or a block's every ticket losing its
// reply channel because one tracker's envelope did, are the same bug twice — and both read to the
// operator as the healthy sources being broken, which is the misattribution the sealed-connection
// work exists to remove rather than relocate.

/**
 * One named source's outcome from a batched open.
 *
 * `unreadable` is deliberately NOT foldable into "absent": a source with no stored row is a
 * workspace that never connected it, and a source whose bag will not open is a deployment fault
 * with its own remedy. A caller that cannot tell them apart re-derives the difference from
 * whatever the vendor says next, which is the 401-shaped guess this vocabulary replaces.
 */
export type SealedConnectionOpenResult<Kind extends string, Opened> =
  | { source: Kind; status: 'opened'; connection: Opened }
  | { source: Kind; status: 'unreadable'; cause: unknown }

/** The opened connections from a batched read, indexed by source, dropping the unreadable ones. */
export function openedConnections<Kind extends string, Opened>(
  results: readonly SealedConnectionOpenResult<Kind, Opened>[],
): Map<Kind, Opened> {
  const opened = new Map<Kind, Opened>()
  for (const result of results) {
    if (result.status === 'opened') opened.set(result.source, result.connection)
  }
  return opened
}
