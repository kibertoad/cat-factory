import type {
  Block,
  BlockRepository,
  BoardWritePort,
  DocumentRecord,
  DocumentRef,
  DocumentRepository,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { DocumentLinkService } from './DocumentLinkService.js'

// Attaching documents to a block. Two properties are worth pinning here rather than leaving to
// the HTTP suites: what the batch costs (a list must not become a read per document), and what it
// REFUSES (a document row holds one `linkedBlockId`, so a second attach moves the link instead of
// copying it, and the task that loses it is never told).

interface Calls {
  blockGets: string[]
  blockFindByIds: string[][]
  listByRefs: DocumentRef[][]
  linkWrites: Array<{ refs: readonly DocumentRef[]; blockId: string | null }>
  detached: string[][]
}

function makeService(documents: DocumentRecord[], blocks: string[]) {
  const calls: Calls = {
    blockGets: [],
    blockFindByIds: [],
    listByRefs: [],
    linkWrites: [],
    detached: [],
  }
  const live = new Set(blocks)
  const blockRepository = {
    get: async (_ws: string, id: string) => {
      calls.blockGets.push(id)
      return live.has(id) ? ({ id, title: id } as unknown as Block) : null
    },
    findByIds: async (ids: string[]) => {
      calls.blockFindByIds.push(ids)
      return ids
        .filter((id) => live.has(id))
        .map((id) => ({ workspaceId: 'ws_1', serviceId: null, block: { id } as Block }))
    },
  } as unknown as BlockRepository
  const documentRepository = {
    listByRefs: async (_ws: string, refs: readonly DocumentRef[]) => {
      calls.listByRefs.push([...refs])
      return documents.filter((doc) =>
        refs.some((ref) => ref.source === doc.source && ref.externalId === doc.externalId),
      )
    },
    linkBlockMany: async (_ws: string, refs: readonly DocumentRef[], blockId: string | null) => {
      calls.linkWrites.push({ refs: [...refs], blockId })
    },
    detachBlocks: async (_ws: string, blockIds: readonly string[]) => {
      calls.detached.push([...blockIds])
    },
  } as unknown as DocumentRepository
  const service = new DocumentLinkService({
    boardService: {} as unknown as BoardWritePort,
    blockRepository,
    documentRepository,
  })
  return { service, calls }
}

function doc(externalId: string, linkedBlockId: string | null = null): DocumentRecord {
  return {
    workspaceId: 'ws_1',
    source: 'confluence',
    externalId,
    title: externalId,
    url: `https://wiki/${externalId}`,
    excerpt: 'x',
    body: 'x',
    contentHash: 'h',
    linkedBlockId,
    role: null,
    docKind: null,
    syncedAt: 1,
    deletedAt: null,
  }
}

const ref = (externalId: string): DocumentRef => ({ source: 'confluence', externalId })

describe('DocumentLinkService.linkManyToBlock', () => {
  it('reads the block once and writes the links once, however many documents', async () => {
    const { service, calls } = makeService([doc('A'), doc('B'), doc('C')], ['task_1'])

    await service.linkManyToBlock('ws_1', 'task_1', [ref('A'), ref('B'), ref('C')])

    // The block is invariant across the list and the documents resolve in one read: the point
    // method in a loop would have made this 3 block reads + 3 document reads + 3 writes.
    expect(calls.blockGets).toEqual(['task_1'])
    expect(calls.listByRefs).toHaveLength(1)
    expect(calls.linkWrites).toEqual([{ refs: [ref('A'), ref('B'), ref('C')], blockId: 'task_1' }])
  })

  it('refuses the whole list when one document does not exist, attaching none of it', async () => {
    const { service, calls } = makeService([doc('A')], ['task_1'])

    await expect(
      service.linkManyToBlock('ws_1', 'task_1', [ref('A'), ref('MISSING')]),
    ).rejects.toMatchObject({ code: 'not_found' })
    expect(calls.linkWrites).toEqual([])
  })

  it('refuses a document another LIVE task already holds, naming that task', async () => {
    const { service, calls } = makeService([doc('A', 'task_other')], ['task_1', 'task_other'])

    // The failure this prevents is silent: the link would MOVE, so `task_other` loses a document
    // it was created with and nothing in its next run reports the absence.
    await expect(service.linkManyToBlock('ws_1', 'task_1', [ref('A')])).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'document_already_linked', taskId: 'task_other' },
    })
    expect(calls.linkWrites).toEqual([])
  })

  it('treats a link naming a DELETED task as free, so a document is never wedged', async () => {
    // `task_gone` is not in the live set. Refusing on a dangling link would strand the document
    // forever, which is why the guard asks whether the holder still exists.
    const { service, calls } = makeService([doc('A', 'task_gone')], ['task_1'])

    await service.linkManyToBlock('ws_1', 'task_1', [ref('A')])
    expect(calls.blockFindByIds).toEqual([['task_gone']])
    expect(calls.linkWrites).toEqual([{ refs: [ref('A')], blockId: 'task_1' }])
  })

  it('re-attaching to the SAME block is idempotent, not a conflict', async () => {
    // A retry of a creation whose link write already landed must not answer 409.
    const { service, calls } = makeService([doc('A', 'task_1')], ['task_1'])

    await service.linkManyToBlock('ws_1', 'task_1', [ref('A')])
    // No holder to check: the only link names the block being attached to.
    expect(calls.blockFindByIds).toEqual([])
    expect(calls.linkWrites).toEqual([{ refs: [ref('A')], blockId: 'task_1' }])
  })

  it('detaches by BLOCK, so a rollback cannot strip another task', async () => {
    // Keyed by block rather than by ref on purpose: a rollback runs after a REFUSED attach, whose
    // refs include the document another task legitimately holds. Clearing those by ref would
    // commit the exact loss the guard above just refused.
    const { service, calls } = makeService([doc('A', 'task_1'), doc('B', 'task_other')], ['task_1'])

    await service.detachBlock('ws_1', 'task_1')
    expect(calls.detached).toEqual([['task_1']])
    expect(calls.linkWrites).toEqual([])
  })
})
