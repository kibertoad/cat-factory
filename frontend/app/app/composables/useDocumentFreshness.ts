import { ref } from 'vue'
import type {
  DocumentFreshness,
  DocumentOrigin,
  DocumentSourceKind,
  RefreshedDocumentView,
  SourceDocument,
} from '~/types/domain'

/**
 * A verdict plus WHEN it was reached. The two are one value because either alone is a half-truth:
 * the verdict says the copy matched the source, and only the stamp says how long ago that was true
 * of a page someone else is still editing. A surface handed the verdict without the stamp can only
 * render it as "just now", which is exactly the false confidence this feature exists to remove: an
 * hour-old confirmation would keep showing a green check.
 *
 * `checkedAt` is stamped where the answer LANDS rather than on the server, so it is on the clock the
 * person reading it is looking at. A skewed browser clock renders its own time consistently; a
 * server stamp would render "checked at 14:32" to someone whose clock says 14:29.
 */
export interface DatedFreshness {
  readonly verdict: DocumentFreshness
  /** Epoch ms, on the reader's own clock. */
  readonly checkedAt: number
}

/**
 * The "is the copy on the board still the current one" half of the documents store: the per-document
 * verdict a manual check produced, the in-flight flags, and the call that produces both.
 *
 * Its own collaborator rather than more lines in the store because it holds a DIFFERENT KIND of
 * state from everything around it. The store's other state is the projection itself (sources,
 * connections, imported rows), which the backend owns and the SPA mirrors; a freshness verdict is a
 * statement about one MOMENT ("as of the click, this was the live revision"), owned by nothing and
 * true of no row. Keeping it separate is what makes the three rules below expressible at all instead
 * of folding into the document list and quietly becoming a claim about it.
 *
 * The rules, in one place so no surface can get half of them right:
 *
 *   - **An absent verdict means "nobody has asked", never "unknown".** Listing documents
 *     deliberately probes nothing (confirming costs a round trip to the source per page), so a
 *     freshly imported document has no verdict and is perfectly fine, which is not the same fact as
 *     a check that ran and could not conclude.
 *   - **The verdict never merges into the row.** A refresh that finds nothing changed writes
 *     nothing, so `syncedAt` legitimately stays where it was; folding a confirmation into the row
 *     would either claim a write that never happened or leave the confirmation sitting on a body
 *     the source has moved past since.
 *   - **A verdict belongs to the BOARD it was asked on.** The same Figma file can be imported into
 *     two boards, and the pair `(source, externalId)` is identical in both, so a map keyed by that
 *     alone would render board A's "confirmed, revision v3" against board B's row, which nobody
 *     checked, breaking the first rule in the one direction that cannot be noticed. Hence
 *     {@link keyOf}, and hence the read below asking for the ACTIVE board each time rather than
 *     capturing it once.
 */
export function useDocumentFreshness(deps: {
  /**
   * The board these maps are ABOUT. A getter rather than a value because it changes under a
   * long-lived store, and every read has to see the change.
   */
  workspaceId: () => string | null
  /** Ask the backend to re-confirm one document. Only a CONNECTABLE source can be asked. */
  refresh: (source: DocumentSourceKind, externalId: string) => Promise<RefreshedDocumentView>
  /** Reconcile the (possibly rewritten) row back into the list every surface reads. */
  onRefreshed: (document: SourceDocument) => void
}): {
  refresh: (source: DocumentSourceKind, externalId: string) => Promise<RefreshedDocumentView>
  freshnessFor: (source: DocumentOrigin, externalId: string) => DatedFreshness | undefined
  isRefreshing: (source: DocumentOrigin, externalId: string) => boolean
} {
  const freshness = ref<Record<string, DatedFreshness>>({})
  const refreshing = ref<Record<string, boolean>>({})
  const keyOf = (workspaceId: string | null, source: DocumentOrigin, externalId: string) =>
    `${workspaceId ?? ''}:${source}:${externalId}`

  async function refresh(source: DocumentSourceKind, externalId: string) {
    // Captured ONCE, at the start, and used for every write below: a check that outlives a board
    // switch must land under the board it was asked on, not whichever one is showing when it
    // returns. Re-reading the getter at the end would file the answer under a board that never
    // asked, which is the same wrong render the key exists to prevent, just harder to reproduce.
    const board = deps.workspaceId()
    const key = keyOf(board, source, externalId)
    refreshing.value = { ...refreshing.value, [key]: true }
    try {
      const result = await deps.refresh(source, externalId)
      // The document LIST is the active board's, and it is not keyed by board, so a row can only be
      // merged into it while that board is still the one showing. The verdict is filed either way:
      // it stays true of the board it was asked on, and switching back should not have to re-ask.
      if (deps.workspaceId() === board) deps.onRefreshed(result.document)
      freshness.value = {
        ...freshness.value,
        [key]: { verdict: result.freshness, checkedAt: Date.now() },
      }
      return result
    } finally {
      // Cleared however the call ended. A failure that left the flag set would disable the button
      // that is the whole remedy, so the person could not try again.
      const { [key]: _settled, ...rest } = refreshing.value
      refreshing.value = rest
    }
  }

  // The verdict map itself stays INSIDE: a caller that could write it could record a conclusion
  // nobody reached, which is the one thing this vocabulary exists to make impossible.
  return {
    refresh,
    freshnessFor: (source, externalId) =>
      freshness.value[keyOf(deps.workspaceId(), source, externalId)],
    isRefreshing: (source, externalId) =>
      !!refreshing.value[keyOf(deps.workspaceId(), source, externalId)],
  }
}
