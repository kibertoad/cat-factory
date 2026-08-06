import type {
  DocumentFreshness,
  DocumentRecord,
  DocumentRepository,
  LinkedDocumentRefresher,
} from '@cat-factory/kernel'
import { CONTEXT_DOCUMENT_UNREADABLE, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import {
  linkedContextSourcesFrom,
  makeDocumentUrlResolver,
  resolveLinkedContext,
} from './linked-context.js'

// Two things the resolution path owes a linked DESIGN document, both of which used to be missing:
// the body it hands an agent is re-confirmed against the source first, and a URL a host-pinned
// provider claims cannot be stolen by a host-blind one that merely matched a shape.

function record(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws1',
    source: 'figma',
    externalId: 'file1:1-2',
    title: 'Checkout flow',
    url: 'https://figma.com/design/file1',
    excerpt: 'Checkout',
    body: '## Checkout',
    contentHash: 'h',
    sourceVersion: 'v1',
    linkedBlockId: 'task_1',
    role: null,
    docKind: null,
    syncedAt: 0,
    deletedAt: null,
    ...over,
  }
}

function documentsRepo(corpus: DocumentRecord[]): DocumentRepository {
  return {
    async listByBlock(_ws: string, blockId: string) {
      return corpus.filter((d) => d.linkedBlockId === blockId)
    },
    async get(_ws: string, source: string, externalId: string) {
      return corpus.find((d) => d.source === source && d.externalId === externalId) ?? null
    },
    async getByUrl(_ws: string, url: string) {
      return corpus.find((d) => d.url === url) ?? null
    },
  } as unknown as DocumentRepository
}

/** A refresher that hands back a replacement record plus a verdict, like the real one does. */
function refresherReturning(
  replacement: DocumentRecord,
  freshness: DocumentFreshness = { status: 'confirmed', version: 'v2', reimported: true },
): LinkedDocumentRefresher & { refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(async () => [{ record: replacement, freshness }])
  return { refresh }
}

describe('resolveLinkedContext: dispatch-time freshness', () => {
  it('hands the agent the REFRESHED body and the freshness verdict', async () => {
    const stored = record()
    const refresher = refresherReturning(record({ body: '## Checkout (revised)' }))

    const { docs } = await resolveLinkedContext(
      linkedContextSourcesFrom({
        documentRepository: documentsRepo([stored]),
        documentRefresher: refresher,
      }),
      'ws1',
      'task_1',
      '',
      { includeLinked: true },
    )

    expect(refresher.refresh).toHaveBeenCalledWith('ws1', [stored])
    // The whole point: what reaches the checkout is the current revision, not import's copy.
    expect(docs[0]?.body).toBe('## Checkout (revised)')
    expect(docs[0]?.freshness).toEqual({ status: 'confirmed', version: 'v2', reimported: true })
  })

  it('leaves every document untouched and un-annotated when no refresher is wired', async () => {
    // A deployment that does not refresh must be byte-for-byte its old self: an absent verdict, NOT
    // a synthesised "could not confirm" it never actually tried to establish.
    const { docs } = await resolveLinkedContext(
      linkedContextSourcesFrom({ documentRepository: documentsRepo([record()]) }),
      'ws1',
      'task_1',
      '',
      { includeLinked: true },
    )

    expect(docs[0]?.body).toBe('## Checkout')
    expect(docs[0]?.freshness).toBeUndefined()
  })

  it('refuses the run when the REFRESH reveals the page has been emptied', async () => {
    // The readability refusal has to run on what the agent will actually read. Asserting on the
    // stored copy would admit a run whose agent then opens a blank file — the exact silent failure
    // `assertContextDocumentsReadable` exists to prevent, one layer later.
    const refresher = refresherReturning(record({ body: '   ', excerpt: '' }))

    const error = await resolveLinkedContext(
      linkedContextSourcesFrom({
        documentRepository: documentsRepo([record()]),
        documentRefresher: refresher,
      }),
      'ws1',
      'task_1',
      '',
      { includeLinked: true },
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
  })

  it('reports the corpus ORIGINS before the refresh, not after it', async () => {
    // The design-context fragment fold needs only the kinds of document a run carries, and those are
    // settled the moment the corpus read returns. The refresh that follows is a live probe per
    // source plus a possible whole-file re-download, so reporting the origins after it would put a
    // Figma round trip in front of the fragment fold on every single dispatch.
    let refreshStarted = false
    let originsAt: 'before-refresh' | 'after-refresh' | 'never' = 'never'
    const refresher: LinkedDocumentRefresher = {
      refresh: async (_ws, records) => {
        refreshStarted = true
        return records.map((record) => ({ record, freshness: { status: 'not-applicable' } }))
      },
    }

    await resolveLinkedContext(
      linkedContextSourcesFrom({
        documentRepository: documentsRepo([record()]),
        documentRefresher: refresher,
      }),
      'ws1',
      'task_1',
      '',
      {
        includeLinked: true,
        onDocumentsResolved: (origins) => {
          originsAt = refreshStarted ? 'after-refresh' : 'before-refresh'
          expect(origins).toEqual(['figma'])
        },
      },
    )

    expect(originsAt).toBe('before-refresh')
  })

  it('carries the origin so a reader can tell a design document from prose', async () => {
    const { docs } = await resolveLinkedContext(
      linkedContextSourcesFrom({ documentRepository: documentsRepo([record()]) }),
      'ws1',
      'task_1',
      '',
      { includeLinked: true },
    )

    expect(docs[0]?.origin).toBe('figma')
  })
})

describe('makeDocumentUrlResolver: host-pinned claims win', () => {
  // Notion's `parseRef` is host-BLIND — it claims any UUID-shaped run in any string — so registered
  // first it used to claim a Figma URL that happened to carry one. The point lookup then searched
  // Notion's key space, found nothing, and the linked design reached the agent as no context at all.
  const notionLike = {
    kind: 'notion' as const,
    parseRef: (url: string) =>
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(url)?.[0] ?? null,
  }
  const figmaLike = {
    kind: 'figma' as const,
    parseRef: (url: string) => (url.includes('figma.com') ? 'file1' : null),
  }
  const FIGMA_URL =
    'https://figma.com/design/file1/Checkout?node-id=1-2&t=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

  it('lets the pinned provider claim its own host even when registered LAST', async () => {
    const resolve = makeDocumentUrlResolver([notionLike, figmaLike])

    expect(resolve?.(FIGMA_URL)).toEqual({ source: 'figma', externalId: 'file1' })
  })

  it('still lets a host-blind provider claim a URL no pinned one wants', async () => {
    // Ordering by confidence must not disable the blind parsers — a real Notion link carries nothing
    // but the UUID shape, so that claim is the only one available.
    const resolve = makeDocumentUrlResolver([notionLike, figmaLike])

    expect(
      resolve?.('https://notion.so/Rate-Limiter-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    ).toEqual({ source: 'notion', externalId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
  })

  it('preserves registration order among providers of equal confidence', async () => {
    // Two pinned providers can never claim one host, so within a pass first-registered still decides
    // — the property that keeps this change from re-ordering anything it did not need to.
    const alsoPinned = { kind: 'zeplin' as const, parseRef: () => 'z1' }
    const resolve = makeDocumentUrlResolver([figmaLike, alsoPinned])

    expect(resolve?.(FIGMA_URL)).toEqual({ source: 'figma', externalId: 'file1' })
  })
})
