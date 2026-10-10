// The standing row-count bound on an artifact SET (a run's captures, a block's uploaded reference
// designs), shared by the two upload endpoints so the two cannot drift into different bounds — or
// into one having none.
//
// A bound on the byte size of each upload is not a bound on the set: a caller within every
// per-file ceiling can still add rows without end, and both sets are read UNPAGED. The run's
// captures are folded together with the block's uploads by `GET /api/v1/runs/{runId}/artifacts`,
// whose contract rests on both halves being bounded by construction — so a set with a byte cap and
// no row cap is the half that quietly withdraws that guarantee.
//
// Enforcement is check-then-act plus a post-insert reconcile, because there is no atomic counter
// under either runtime: the cheap indexed COUNT rejects the steady-state case before anything is
// buffered, and the reconcile catches the burst that raced past it. Rolling back the OVERFLOW TAIL
// (never the oldest rows) is what makes the cap safe for a human-facing upload: an uploader is
// told their upload was refused, rather than silently losing a design they added last week.

/** One artifact set, as the cap needs to see it. */
export interface ArtifactSetCap {
  /** Maximum rows the set may hold. */
  limit: number
  /** Indexed COUNT of the set: no rows materialised. */
  count(): Promise<number>
  /** The set OLDEST-FIRST. Materialised only when an insert could have crossed the cap. */
  list(): Promise<{ id: string }[]>
  /** Drop one row and its bytes. */
  remove(id: string): Promise<void>
}

/**
 * The set's size before this insert when there is room for one more, or null when it is full.
 *
 * The returned count is what {@link reclaimArtifactOverflow} needs afterwards, so the common path
 * costs exactly one COUNT: a caller far below the cap never materialises a row on either side.
 */
export async function reserveArtifactSlot(cap: ArtifactSetCap): Promise<number | null> {
  const existing = await cap.count()
  return existing >= cap.limit ? null : existing
}

/**
 * Reconcile the cap after an insert: true when `recordId` landed in the overflow tail and was
 * rolled back, so the caller must refuse.
 *
 * Only runs the materialising read when the insert COULD have crossed the cap — that is, when the
 * pre-check already sat at the edge. The set is oldest-first, so everything at or past `limit` is
 * overflow, and only a record of the CALLER'S OWN is rolled back: a concurrent uploader's row is
 * that request's to reject, and dropping it here would refuse one caller by deleting another's.
 */
export async function reclaimArtifactOverflow(
  cap: ArtifactSetCap,
  priorCount: number,
  recordId: string,
): Promise<boolean> {
  if (priorCount + 1 < cap.limit) return false
  const after = await cap.list()
  if (after.length <= cap.limit) return false
  const overflow = new Set(after.slice(cap.limit).map((row) => row.id))
  if (!overflow.has(recordId)) return false
  await cap.remove(recordId)
  return true
}
