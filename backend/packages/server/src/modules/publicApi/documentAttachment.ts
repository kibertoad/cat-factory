import type { PublicTaskDocument } from '@cat-factory/contracts'
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

/**
 * Resolve the documents a task is being created with, and hand back the ATTACH step to run once
 * the block exists. Two phases, mirroring {@link resolveTicket}, for the same reason: the link
 * column can only name a block that exists, while every refusal must land before one does.
 *
 * Phase 1 (`resolveDocuments`) does everything that can refuse:
 *
 * - a `source` document is FETCHED here, so an unconfigured source, an unparseable ref and a page
 *   the provider will not serve all answer before the board is touched. A page it DOES serve but
 *   which turns out to be blank is not refused here: `import` persists whatever came back, and
 *   which emptiness counts depends on the reader (a container agent opens the raw body, an inline
 *   one renders only the excerpt), so that refusal stays at the run's first context resolution
 *   where the reader is known. One rule, in one place.
 * - an `upload` is WRITTEN here, and its readability IS asserted, because there is no source to
 *   re-read: the bytes in hand are the whole document, so the boundary is where the caller can
 *   still fix them.
 *
 * Both leave a projected document behind, and that is deliberate: a document in the workspace is
 * exactly what the app's own import produces, so a creation that fails after this point leaves a
 * usable asset rather than a mess. What it must never leave is the inverse: a task the caller
 * believes carries its spec, running on its title alone.
 *
 * Phase 2 (`attach`) links each resolved document to the new block, in the order given.
 */
export async function resolveDocuments(
  deps: DocumentAttachmentDeps,
  workspaceId: string,
  documents: readonly PublicTaskDocument[],
): Promise<{ attach: (blockId: string) => Promise<void> }> {
  const module = requireCapability(deps.documents, 'Document-source integration is not configured')
  const resolved: ResolvedDocument[] = []
  // Sequential, not `Promise.all`: an `upload` is a write and a `source` is an outbound fetch of
  // the caller's own page, and the first refusal should be the first problem in the list rather
  // than whichever call happened to lose the race, since the caller fixes them one at a time.
  for (const document of documents) {
    const record =
      document.kind === 'upload'
        ? await module.importService.ingest(workspaceId, {
            title: document.title,
            content: document.content,
          })
        : await module.importService.import(workspaceId, document.source, document.ref)
    resolved.push({ source: record.source, externalId: record.externalId })
  }
  return {
    attach: async (blockId) => {
      for (const document of resolved) {
        await module.linkService.linkToBlock(
          workspaceId,
          blockId,
          document.source,
          document.externalId,
        )
      }
    },
  }
}

/**
 * Take the just-created task back off the board after an attachment did not land.
 *
 * A task that keeps some of its documents is the worst of the outcomes available here: the caller
 * has a `201`, the run starts, and an agent builds against a spec with a piece missing that
 * nothing in the run reports. Removing the block turns that into an error the caller can react to,
 * and its retry files the task once, whole. (The documents themselves stay, see
 * {@link resolveDocuments}, so the retry re-imports rather than re-uploads nothing.)
 *
 * Best-effort: this runs while an error is already on its way to the caller, and failing to tidy
 * up must never replace the refusal that explains what happened.
 */
export async function releaseUnattachedTask(
  deps: DocumentAttachmentDeps,
  workspaceId: string,
  blockId: string,
): Promise<void> {
  await runBestEffort(
    deps.logger,
    'public-api.documents.release-unattached-task',
    () => deps.boardService.removeBlock(workspaceId, blockId),
    { workspaceId, blockId },
  )
}
