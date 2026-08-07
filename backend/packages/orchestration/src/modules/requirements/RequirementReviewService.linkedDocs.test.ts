import type { Block, DocumentRecord, LinkedDocumentRefresher } from '@cat-factory/kernel'
import { CONTEXT_DOCUMENT_UNREADABLE, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it, vi } from 'vitest'
import { RequirementReviewService } from './RequirementReviewService.js'

// The requirements review is the FIRST step of the default pipelines, so it is the first reader of
// a block's attached documents — and it applies the same "break loudly, never skip" rule the
// dispatch path does. Reviewing requirements against a document the platform could not open would
// ask a product owner to sign off on an absence nobody named.

const BLOCK = {
  id: 'blk_1',
  title: 'Widgets endpoint',
  type: 'service',
  description: 'expose a widgets list endpoint',
} as unknown as Block

function attached(over: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    workspaceId: 'ws',
    source: 'confluence',
    externalId: '77',
    title: 'Widgets PRD',
    url: 'https://wiki.example/pages/77',
    excerpt: '',
    body: '',
    contentHash: 'h',
    sourceVersion: null,
    linkedBlockId: 'blk_1',
    role: null,
    docKind: null,
    syncedAt: 0,
    deletedAt: null,
    ...over,
  }
}

/** A reviewer service whose only wired source is the documents repo (the reviewer LLM is never reached). */
function makeService(docs: DocumentRecord[], refresher?: LinkedDocumentRefresher) {
  return new RequirementReviewService({
    requirementReviewRepository: {} as never,
    blockRepository: { get: vi.fn(async () => BLOCK) } as never,
    idGenerator: { next: (p: string) => `${p}_1` } as never,
    clock: { now: () => 1_000 } as never,
    modelProvider: { resolve: vi.fn(() => ({}) as never) } as never,
    modelRef: { provider: 'cloudflare', model: 'test' },
    documentRepository: { listByBlock: vi.fn(async () => docs) } as never,
    ...(refresher ? { documentRefresher: refresher } : {}),
  })
}

/** A refresher that answers with the records it is given, whatever the stored ones said. */
function refresherReturning(records: DocumentRecord[]): LinkedDocumentRefresher {
  return {
    refresh: async () =>
      records.map((record) => ({
        record,
        freshness: { status: 'confirmed' as const, version: 'v9', change: 'reimported' },
      })),
  }
}

describe('RequirementReviewService: attached documents', () => {
  it('refuses the round when an attached document has no readable content', async () => {
    const error = await makeService([attached()])
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).message).toContain('"Widgets PRD"')
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
  })

  it('reads on past an attached document that has content (the reviewer runs)', async () => {
    // No reviewer model call is faked here, so getting PAST the attachment check is all we assert:
    // the failure must no longer be the context refusal.
    const error = await makeService([attached({ body: '# Widgets\n\nList widgets.' })])
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)
    expect((error as ValidationError | undefined)?.details?.reason).not.toBe(
      CONTEXT_DOCUMENT_UNREADABLE,
    )
  })

  it('refuses a body this INLINE reader cannot project to an excerpt, not just a blank one', async () => {
    // This reviewer has no checkout: it renders the excerpt and nothing else. A body that is pure
    // markup — the empty fenced block an extractor emits for an embed it cannot render — is
    // something a CONTAINER agent at least opens, and collapses to nothing here. Testing the body
    // and rendering the excerpt would leave the very hole this rule closes open, one field
    // narrower.
    const error = await makeService([attached({ body: '```\n```' })])
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
  })

  it('derives the excerpt from the body when the stored excerpt is blank', async () => {
    // A document imported before its excerpt was computed (or through a path that leaves it
    // empty) still has readable prose; the reviewer must SEE it rather than be handed ''.
    const error = await makeService([attached({ body: 'Widgets must page at 50.', excerpt: '' })])
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)
    expect((error as ValidationError | undefined)?.details?.reason).not.toBe(
      CONTEXT_DOCUMENT_UNREADABLE,
    )
  })

  it('reviews the REFRESHED copy, not the one import happened to store', async () => {
    // This is the step a human signs off on. Reviewing the import-time copy records an approval
    // against a revision nobody built, while the coder two steps later receives the current one.
    // Asserted through the readability refusal because that is the one verdict observable without
    // a reviewer model: a page emptied since import must break the round HERE, exactly as it does
    // at the first dispatch: two readability verdicts about one document that could otherwise
    // disagree.
    const error = await makeService(
      [attached({ body: '# Widgets\n\nList widgets.' })],
      refresherReturning([attached({ body: '' })]),
    )
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).details?.reason).toBe(CONTEXT_DOCUMENT_UNREADABLE)
  })

  it('admits a stored blank whose source has since been filled in', async () => {
    // The mirror of the case above, and the reason the assertion must NOT run on the stored row:
    // refusing a round over a document the refresh just repaired would park a run on a problem
    // that no longer exists.
    const error = await makeService(
      [attached({ body: '' })],
      refresherReturning([attached({ body: '# Widgets\n\nList widgets.' })]),
    )
      .review('ws', 'blk_1')
      .catch((e: unknown) => e)

    expect((error as ValidationError | undefined)?.details?.reason).not.toBe(
      CONTEXT_DOCUMENT_UNREADABLE,
    )
  })
})
