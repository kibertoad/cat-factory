import type { PublicTaskDocument } from '@cat-factory/contracts'
import type { DocumentRef, RecordedLogLine } from '@cat-factory/kernel'
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
  /** Block ids a rollback detached documents from, in order. */
  detachedBlocks: string[]
  removed: string[]
  logLines: RecordedLogLine[]
  /** Set to make `linkManyToBlock` throw, as a lost link write would. */
  failLink: boolean
  /** Set to make an `import` of this ref throw, as an unserved page would. */
  failImportOf: string | null
}

function harness(): Harness {
  const h: Harness = {
    resolved: [],
    linked: [],
    detachedBlocks: [],
    removed: [],
    logLines: [],
    failLink: false,
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
        linkManyToBlock: async (_ws: string, blockId: string, refs: readonly DocumentRef[]) => {
          if (h.failLink) throw new Error('link write failed')
          for (const ref of refs) h.linked.push(`${blockId}:${ref.source}:${ref.externalId}`)
          return []
        },
        detachBlock: async (_ws: string, blockId: string) => {
          h.detachedBlocks.push(blockId)
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
    // Order is preserved, because it is the order the agents read the corpus in — and the
    // uploads being written in a LATER pass than the imports must not disturb it.
    expect(h.linked).toEqual(['task_new:confluence:PAGE-1', 'task_new:upload:doc_1'])
  })

  it('refuses an unresolvable page BEFORE the board is touched, and writes no upload', async () => {
    const h = harness()
    h.failImportOf = 'PAGE-1'

    // The refusal is the whole of `resolveDocuments`, so the caller never reaches its create: the
    // other order hands back a `201` for a task the caller believes carries its spec.
    await expect(resolveDocuments(h.deps, 'ws_1', [SPEC, PAGE])).rejects.toThrow(ValidationError)
    // Note the order: the upload is listed FIRST and still was not written. An import is
    // idempotent on its key, but every upload mints a fresh id, so writing them before the list
    // has fully resolved would leave one more unreachable copy behind on every retry.
    expect(h.resolved).toEqual([])
  })

  it('refuses an unreadable upload before writing any of the others', async () => {
    const h = harness()

    // An empty fenced block: bytes, but nothing at all once rendered to text. It is validated in
    // the first pass, so the good upload beside it is never stored either.
    await expect(
      resolveDocuments(h.deps, 'ws_1', [
        SPEC,
        { kind: 'upload', title: 'Empty', content: '```\n\n```' },
      ]),
    ).rejects.toThrow(ValidationError)
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
  it('takes the task off the board AND detaches whatever landed on it', async () => {
    // A task keeping SOME of its documents is the worst outcome available: the caller has a
    // `201`, the run starts, and an agent builds against a spec with a piece missing that nothing
    // in the run reports. The links go with the block, or the documents stay wedged, looking
    // spoken for by a task nobody can open.
    const h = harness()
    const attachment = await resolveDocuments(h.deps, 'ws_1', [PAGE, SPEC])
    h.failLink = true

    await expect(attachment.attach('task_new')).rejects.toThrow('link write failed')
    await releaseUnattachedTask(h.deps, 'ws_1', 'task_new')
    // Keyed by the BLOCK, never by the refs that were being attached. A rollback can be running
    // because one of those refs belongs to ANOTHER task, and clearing it by ref would strip that
    // task of its spec — the same silent loss the attach guard just refused, committed by the
    // cleanup instead.
    expect(h.detachedBlocks).toEqual(['task_new'])
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
