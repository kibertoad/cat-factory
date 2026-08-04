import type { PublicTaskDocument } from '@cat-factory/contracts'
import type { UploadedDocument } from '@cat-factory/integrations'
import { assertUploadReadable } from '@cat-factory/integrations'
import type { DocumentOrigin, Logger } from '@cat-factory/kernel'
import { runBestEffort } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'

// Attaching requirements documents to a `/api/v1` task at creation: the spec half of
// `createPublicTaskContract`.
//
// It is the answer to the surface's one structural gap. `description` is a task's own framing and
// is capped accordingly, and the 50,000-character `POST /jobs` brief drives inline pipelines that
// never touch a repository, so before this there was nowhere on `/api/v1` to put a PRD that a
// repository-touching run would read. The app has had one all along (import a page, attach it),
// but only behind a session; this is the same model, reached with a key.
//
// Its own module for the same reason `ticketLinkage.ts` is: the ORDERING is the design, and it
// does not read as such inlined between two route registrations.

/** What the controller needs from the container to attach documents to a task. */
export interface DocumentAttachmentDeps {
  documents: ServerContainer['documents']
  boardService: ServerContainer['boardService']
  logger: Logger
}

/** A document resolved far enough to be attached, once there is a block to attach it to. */
interface ResolvedDocument {
  source: DocumentOrigin
  externalId: string
}

/** The resolved corpus, as the single step that attaches it once a block exists. */
export interface DocumentAttachment {
  attach: (blockId: string) => Promise<void>
}

/**
 * Resolve the documents a task is being created with, and hand back the ATTACH step to run once
 * the block exists. Two phases, mirroring {@link resolveTicket}, for the same reason: the link
 * column can only name a block that exists, while every refusal must land before one does.
 *
 * Phase 1 (`resolveDocuments`) does everything that can refuse, in the order the caller listed:
 *
 * - a `source` document is FETCHED here, so an unconfigured source, an unparseable ref and a page
 *   the provider will not serve all answer before the board is touched. A page it DOES serve but
 *   which turns out to be blank is not refused here: `import` persists whatever came back, and
 *   which emptiness counts depends on the reader (a container agent opens the raw body, an inline
 *   one renders only the excerpt), so that refusal stays at the run's first context resolution
 *   where the reader is known. One rule, in one place.
 * - an `upload` is only VALIDATED here (`assertUploadReadable`), because there is no source to
 *   re-read: the bytes in hand are the whole document, so the boundary is where the caller can
 *   still fix them.
 *
 * The uploads are then WRITTEN in a second pass, after the whole list has resolved. The order
 * matters because the two halves fail differently on a RETRY: an `import` is idempotent on its
 * `(source, externalId)` key, so re-running it lands on the same row, while every upload MINTS an
 * id and would leave one more unreachable copy of the same spec behind on each attempt. Writing
 * them last means the common refusals (a source that is not connected, a ref that does not
 * resolve, a body that renders to nothing) leave the workspace exactly as they found it, and an
 * integration retrying in a loop cannot fill a workspace with orphans.
 *
 * Phase 2 (`attach`) links every resolved document to the new block in ONE batched write, in the
 * order given, because that is the order the agents read the corpus in.
 */
export async function resolveDocuments(
  deps: DocumentAttachmentDeps,
  workspaceId: string,
  documents: readonly PublicTaskDocument[],
): Promise<DocumentAttachment> {
  const module = requireCapability(deps.documents, 'Document-source integration is not configured')
  // Placeholders keep the caller's ORDER while the uploads are still unwritten: each slot is
  // filled either by the import that resolved it or by the upload minted in the second pass.
  const resolved: Array<ResolvedDocument | null> = documents.map(() => null)
  const pendingUploads: Array<{ index: number; upload: UploadedDocument }> = []
  // Sequential, not `Promise.all`: a `source` entry is an outbound fetch of the caller's own
  // page, and the first refusal should be the first problem in the list rather than whichever
  // call happened to lose the race, since the caller fixes them one at a time.
  for (const [index, document] of documents.entries()) {
    if (document.kind === 'upload') {
      const upload = { title: document.title, content: document.content }
      assertUploadReadable(upload)
      pendingUploads.push({ index, upload })
      continue
    }
    const record = await module.importService.import(workspaceId, document.source, document.ref)
    resolved[index] = { source: record.source, externalId: record.externalId }
  }
  for (const { index, upload } of pendingUploads) {
    const record = await module.importService.ingest(workspaceId, upload)
    resolved[index] = { source: record.source, externalId: record.externalId }
  }
  const refs = resolved.filter((ref): ref is ResolvedDocument => ref !== null)
  return {
    attach: (blockId) => module.linkService.linkManyToBlock(workspaceId, blockId, refs).then(),
  }
}

/**
 * Take the just-created task back off the board after an attachment did not land, and detach the
 * documents that were resolved for it.
 *
 * A task that keeps some of its documents is the worst of the outcomes available here: the caller
 * has a `201`, the run starts, and an agent builds against a spec with a piece missing that
 * nothing in the run reports. Removing the block turns that into an error the caller can react to,
 * and its retry files the task once, whole.
 *
 * The documents themselves SURVIVE — a projected document is a workspace asset, exactly what the
 * app's own import produces, so the retry re-imports onto the same rows. What must not survive is
 * a LINK to the block being removed: a document row carries exactly one `linkedBlockId`, so a
 * stale one makes the document look permanently spoken for by a task nobody can open, and the
 * retry would then be refused by the very guard that protects the corpus.
 *
 * The detach is keyed by the BLOCK, never by the refs this creation resolved. A rollback can be
 * running because the attach was REFUSED — a named document is already held by another task — and
 * clearing that document by ref would strip it from the task that legitimately holds it, which is
 * the same silent loss the guard just refused, committed by the cleanup instead. (`removeBlock`
 * detaches too, via the removal cascade; this asks first because the removal is best-effort and
 * may itself be what fails.)
 *
 * Best-effort throughout: this runs while an error is already on its way to the caller, and
 * failing to tidy up must never replace the refusal that explains what happened.
 */
export async function releaseUnattachedTask(
  deps: DocumentAttachmentDeps,
  workspaceId: string,
  blockId: string,
): Promise<void> {
  await runBestEffort(
    deps.logger,
    'public-api.documents.release-unattached-task',
    async () => {
      if (deps.documents) await deps.documents.linkService.detachBlock(workspaceId, blockId)
      await deps.boardService.removeBlock(workspaceId, blockId)
    },
    { workspaceId, blockId },
  )
}
