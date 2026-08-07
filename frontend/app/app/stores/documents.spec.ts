import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDocumentsStore } from '~/stores/documents'
import { useWorkspaceStore } from '~/stores/workspace'
import type { DocumentFreshness, SourceDocument } from '~/types/domain'

// The document store's REFRESH half: what a person gets back when they ask a source whether the
// copy on the board is still the current one.
//
// Two things are worth pinning here rather than leaving to the component. The verdict is kept
// SEPARATE from the row because it is a statement about a moment, not a property of the projection,
// so an absent entry has to keep meaning "nobody has asked" (listing documents deliberately probes
// nothing). And a refresh that pulls a moved page has to reconcile the returned row into the same
// list every surface reads, or the panel goes on showing the title and excerpt import stored while
// claiming, one line below, that it just confirmed the newer revision.

function doc(over: Partial<SourceDocument> = {}): SourceDocument {
  return {
    source: 'figma',
    externalId: 'file1:1-2',
    title: 'Checkout flow',
    url: 'https://figma.com/design/file1',
    excerpt: 'Checkout',
    linkedBlockId: 'task_1',
    role: null,
    docKind: null,
    syncedAt: 1_000,
    ...over,
  }
}

const CONFIRMED: DocumentFreshness = { status: 'confirmed', version: 'v2', change: 'reimported' }

/** The store reads `useApi()` off the auto-import, so each test stubs just what it calls. */
function stubApi(over: Record<string, unknown>) {
  vi.stubGlobal('useApi', () => ({
    listDocuments: () => Promise.resolve([]),
    ...over,
  }))
}

beforeEach(() => {
  useWorkspaceStore().workspaceId = 'ws1'
})

describe('documents store: manual refresh', () => {
  it('reconciles the refreshed row into the list every surface reads', async () => {
    stubApi({
      listDocuments: () => Promise.resolve([doc()]),
      refreshDocument: () =>
        Promise.resolve({
          document: doc({ title: 'Checkout flow v2', syncedAt: 2_000 }),
          freshness: CONFIRMED,
        }),
    })
    const store = useDocumentsStore()
    await store.loadDocuments()

    await store.refresh('figma', 'file1:1-2')

    // Upserted by `(source, externalId)`, not appended: a refresh must not leave the old title
    // sitting beside the new one in a picker keyed by the same document.
    expect(store.documents).toHaveLength(1)
    expect(store.documents[0]?.title).toBe('Checkout flow v2')
  })

  it('records the verdict beside the row, and reports "nobody asked" until someone does', async () => {
    stubApi({
      refreshDocument: () => Promise.resolve({ document: doc(), freshness: CONFIRMED }),
    })
    const store = useDocumentsStore()

    // An unasked document has NO verdict. It must not read as unknown-and-therefore-suspect: a
    // freshly imported page is fine, it simply has not been re-checked since.
    expect(store.freshnessFor('figma', 'file1:1-2')).toBeUndefined()

    await store.refresh('figma', 'file1:1-2')

    expect(store.freshnessFor('figma', 'file1:1-2')?.verdict).toEqual(CONFIRMED)
    // Stamped with WHEN it was reached, because a verdict never expires: what keeps an hour-old
    // confirmation from rendering as the present state of a page that has had an hour to move is
    // that the moment travels with it.
    expect(store.freshnessFor('figma', 'file1:1-2')?.checkedAt).toBeTypeOf('number')
    // Scoped to the document that was asked about, never to the source.
    expect(store.freshnessFor('figma', 'other:9-9')).toBeUndefined()
  })

  it('never shows one board\u2019s verdict against another board\u2019s row', async () => {
    // The same Figma file can be imported into two boards, and `(source, externalId)` is identical
    // in both, so a verdict keyed by that pair alone would render board A's "confirmed, revision
    // v2" against a board B row nobody has ever checked. That breaks the "absent means nobody has
    // asked" rule in the one direction nothing can notice, since the wrong answer looks like a
    // right one.
    stubApi({
      refreshDocument: () => Promise.resolve({ document: doc(), freshness: CONFIRMED }),
    })
    const store = useDocumentsStore()
    await store.refresh('figma', 'file1:1-2')
    expect(store.freshnessFor('figma', 'file1:1-2')?.verdict).toEqual(CONFIRMED)

    useWorkspaceStore().workspaceId = 'ws2'

    expect(store.freshnessFor('figma', 'file1:1-2')).toBeUndefined()

    // …and switching back does not lose it: the verdict stays true of the board it was asked on.
    useWorkspaceStore().workspaceId = 'ws1'
    expect(store.freshnessFor('figma', 'file1:1-2')?.verdict).toEqual(CONFIRMED)
  })

  it('does not merge a check that outlived a board switch into the new board\u2019s list', async () => {
    // The list is the ACTIVE board's and is not keyed by board, so a row arriving after the switch
    // would be a document from somewhere else appearing on a board that never imported it. The
    // verdict is still filed, under the board that asked.
    let resolve!: (v: unknown) => void
    stubApi({
      listDocuments: () => Promise.resolve([]),
      refreshDocument: () =>
        new Promise((res) => {
          resolve = res
        }),
    })
    const store = useDocumentsStore()
    await store.loadDocuments()

    const pending = store.refresh('figma', 'file1:1-2')
    useWorkspaceStore().workspaceId = 'ws2'
    resolve({ document: doc(), freshness: CONFIRMED })
    await pending

    expect(store.documents).toHaveLength(0)
    useWorkspaceStore().workspaceId = 'ws1'
    expect(store.freshnessFor('figma', 'file1:1-2')?.verdict).toEqual(CONFIRMED)
  })

  it('reports in-flight state per document, and clears it when the source refuses', async () => {
    let reject!: (e: Error) => void
    stubApi({
      refreshDocument: () =>
        new Promise((_res, rej) => {
          reject = rej
        }),
    })
    const store = useDocumentsStore()

    const pending = store.refresh('figma', 'file1:1-2')
    expect(store.isRefreshing('figma', 'file1:1-2')).toBe(true)
    expect(store.isRefreshing('figma', 'other:9-9')).toBe(false)

    reject(new Error('figma 429'))
    await expect(pending).rejects.toThrow('figma 429')

    // A failure that left the flag set would disable the button that is the whole remedy, and the
    // person would have no way to try again.
    expect(store.isRefreshing('figma', 'file1:1-2')).toBe(false)
    expect(store.freshnessFor('figma', 'file1:1-2')).toBeUndefined()
  })
})
