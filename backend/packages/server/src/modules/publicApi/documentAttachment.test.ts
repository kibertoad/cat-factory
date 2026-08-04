import type { PublicTaskDocument } from '@cat-factory/contracts'
import type { RecordedLogLine } from '@cat-factory/kernel'
import { createRecordingLogger, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { DocumentAttachmentDeps } from './documentAttachment.js'
import { releaseUnattachedTask, resolveDocuments } from './documentAttachment.js'

// Attaching requirements documents to a `/api/v1` task, at the level the ORDERING is visible.
// The worker integration suite drives the surface end to end over real HTTP; what it cannot show
// is which side of the block creation each step falls on, and that split is the whole design:
// everything refusable happens before there is a task, and everything that can only name a block
// happens after, taking the task with it if it does not land.

interface Harness {
  deps: DocumentAttachmentDeps
  /** `(source, externalId)` pairs written or fetched, in order. */
  resolved: string[]
  /** `(blockId, source, externalId)` triples linked, in order. */
  linked: string[]
  removed: string[]
  logLines: RecordedLogLine[]
  /** Set to make the Nth (0-based) `linkToBlock` throw. */
  failLinkAt: number | null
  /** Set to make an `import` of this ref throw, as an unserved page would. */
  failImportOf: string | null
}

function harness(): Harness {
  const h: Harness = {
    resolved: [],
    linked: [],
    removed: [],
    logLines: [],
    failLinkAt: null,
    failImportOf: null,
    deps: undefined as unknown as DocumentAttachmentDeps,
  }
  let minted = 0
  h.deps = {
    documents: {
      importService: {
        ingest: async (_ws: string, input: { title: string }) => {
          const externalId = `doc_${++minted}`
          h.resolved.push(`upload:${externalId}`)
          return { source: 'upload', externalId, title: input.title }
        },
        import: async (_ws: string, source: string, ref: string) => {
          if (h.failImportOf === ref) throw new ValidationError(`Cannot resolve '${ref}'`)
          h.resolved.push(`${source}:${ref}`)
          return { source, externalId: ref }
        },
      },
      linkService: {
        linkToBlock: async (_ws: string, blockId: string, source: string, externalId: string) => {
          if (h.failLinkAt === h.linked.length) throw new Error('link write failed')
          h.linked.push(`${blockId}:${source}:${externalId}`)
        },
      },
    },
    boardService: {
      removeBlock: async (_ws: string, blockId: string) => {
        h.removed.push(blockId)
      },
    },
    logger: createRecordingLogger(h.logLines),
  } as unknown as DocumentAttachmentDeps
  return h
}

const SPEC: PublicTaskDocument = { kind: 'upload', title: 'Checkout PRD', content: '# PRD' }
const PAGE: PublicTaskDocument = { kind: 'source', source: 'confluence', ref: 'PAGE-1' }

describe('resolveDocuments', () => {
  it('resolves every document before the block exists, and attaches in the order given', async () => {
    const h = harness()

    const attachment = await resolveDocuments(h.deps, 'ws_1', [PAGE, SPEC])
    // Nothing is linked yet: there is no block to link to, and the caller has not created one.
    expect(h.resolved).toEqual(['confluence:PAGE-1', 'upload:doc_1'])
    expect(h.linked).toEqual([])

    await attachment.attach('task_new')
    // Order is preserved, because it is the order the agents read the corpus in.
    expect(h.linked).toEqual(['task_new:confluence:PAGE-1', 'task_new:upload:doc_1'])
  })

  it('refuses an unresolvable page BEFORE the board is touched, and stops at the first problem', async () => {
    const h = harness()
    h.failImportOf = 'PAGE-1'

    // The refusal is the whole of `resolveDocuments`, so the caller never reaches its create: the
    // other order hands back a `201` for a task the caller believes carries its spec.
    await expect(resolveDocuments(h.deps, 'ws_1', [PAGE, SPEC])).rejects.toThrow(ValidationError)
    // And the upload behind it was never written, so the caller's retry does not accumulate
    // copies of a document the first attempt already stored.
    expect(h.resolved).toEqual([])
  })

  it('refuses when the documents integration is not wired, rather than dropping the attachments', async () => {
    const h = harness()
    h.deps.documents = undefined

    await expect(resolveDocuments(h.deps, 'ws_1', [SPEC])).rejects.toMatchObject({
      code: 'unavailable',
    })
  })
})

describe('releaseUnattachedTask', () => {
  it('takes the task back off the board when an attachment did not land', async () => {
    // A task keeping SOME of its documents is the worst outcome available: the caller has a
    // `201`, the run starts, and an agent builds against a spec with a piece missing that nothing
    // in the run reports.
    const h = harness()
    const attachment = await resolveDocuments(h.deps, 'ws_1', [PAGE, SPEC])
    h.failLinkAt = 1

    await expect(attachment.attach('task_new')).rejects.toThrow('link write failed')
    await releaseUnattachedTask(h.deps, 'ws_1', 'task_new')
    expect(h.removed).toEqual(['task_new'])
  })

  it('reports a rollback it could not perform instead of swallowing it', async () => {
    const h = harness()
    h.deps.boardService.removeBlock = async () => {
      throw new Error('board write failed')
    }

    // The tidy-up runs while an error is already on its way to the caller, so it must not throw
    // over it, but the leftover has to be diagnosable.
    await expect(releaseUnattachedTask(h.deps, 'ws_1', 'task_new')).resolves.toBeUndefined()
    expect(h.logLines.some((line) => line.level === 'warn')).toBe(true)
  })
})
