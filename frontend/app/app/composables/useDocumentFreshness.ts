import { ref } from 'vue'
import type {
  DocumentFreshness,
  DocumentOrigin,
  DocumentSourceKind,
  RefreshedDocumentView,
  SourceDocument,
} from '~/types/domain'

/**
 * The "is the copy on the board still the current one" half of the documents store: the per-document
 * verdict a manual check produced, the in-flight flags, and the call that produces both.
 *
 * Its own collaborator rather than more lines in the store because it holds a DIFFERENT KIND of
 * state from everything around it. The store's other state is the projection itself (sources,
 * connections, imported rows), which the backend owns and the SPA mirrors; a freshness verdict is a
 * statement about one MOMENT ("as of the click, this was the live revision"), owned by nothing and
 * true of no row. Keeping it separate is what makes the two rules below expressible at all instead
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
 */
export function useDocumentFreshness(deps: {
  /** Ask the backend to re-confirm one document. Only a CONNECTABLE source can be asked. */
  refresh: (source: DocumentSourceKind, externalId: string) => Promise<RefreshedDocumentView>
  /** Reconcile the (possibly rewritten) row back into the list every surface reads. */
  onRefreshed: (document: SourceDocument) => void
}): {
  refresh: (source: DocumentSourceKind, externalId: string) => Promise<RefreshedDocumentView>
  freshnessFor: (source: DocumentOrigin, externalId: string) => DocumentFreshness | undefined
  isRefreshing: (source: DocumentOrigin, externalId: string) => boolean
} {
  const freshness = ref<Record<string, DocumentFreshness>>({})
  const refreshing = ref<Record<string, boolean>>({})
  const keyOf = (source: DocumentOrigin, externalId: string) => `${source}:${externalId}`

  async function refresh(source: DocumentSourceKind, externalId: string) {
    const key = keyOf(source, externalId)
    refreshing.value = { ...refreshing.value, [key]: true }
    try {
      const result = await deps.refresh(source, externalId)
      deps.onRefreshed(result.document)
      freshness.value = { ...freshness.value, [key]: result.freshness }
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
    freshnessFor: (source, externalId) => freshness.value[keyOf(source, externalId)],
    isRefreshing: (source, externalId) => !!refreshing.value[keyOf(source, externalId)],
  }
}
