import { UNATTRIBUTED_BLOCK_EDITOR } from '@cat-factory/contracts'
import type { Block, CreatePublicTaskInput } from '@cat-factory/contracts'
import type { Logger } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'
import { releaseUnattachedTask, resolveDocuments } from './documentAttachment.js'
import { resolveTicket } from './ticketLinkage.js'

// The ORDERING of `POST /api/v1/services/:serviceId/tasks`, which is the whole design of that
// route and reads as nothing but a long function inlined into a route registration.
//
// A creation on this surface can carry two kinds of attachment, each with a step that cannot run
// until the block exists (a link column can only name a row that is there) and refusals that must
// all land before one does. The rule the sequence below encodes, in one sentence:
//
//   everything refusable is refused before the board changes, and everything that can only name
//   an existing block runs after, taking the task back off the board if it does not land.
//
// The failure it exists to prevent is not a lost write, it is a QUIET one: a `201` for a task the
// caller believes carries its ticket and its spec, running on its title alone, with an agent
// building against requirements nobody notices it never received.

/** What creating a public task needs from the container. */
export interface PublicTaskCreationDeps {
  boardService: ServerContainer['boardService']
  tasks: ServerContainer['tasks']
  documents: ServerContainer['documents']
  logger: Logger
}

/** Read the collaborators this module drives off the request's container. */
export function taskCreationDeps(container: ServerContainer): PublicTaskCreationDeps {
  return {
    boardService: container.boardService,
    tasks: container.tasks,
    documents: container.documents,
    logger: container.logger,
  }
}

/**
 * Create a task under a service, with the ticket it is filed from and the requirements documents
 * it is to be built against. Returns the created block, or throws the refusal that stopped it.
 *
 * Both attachments are two-phase, and their own modules explain each half: `ticketLinkage.ts` for
 * the ticket (resolve, then claim) and `documentAttachment.ts` for the documents (resolve, then
 * attach).
 */
export async function createTaskWithAttachments(
  deps: PublicTaskCreationDeps,
  workspaceId: string,
  serviceId: string,
  body: CreatePublicTaskInput,
): Promise<Block> {
  const { ticket, documents, ...input } = body
  if (ticket || documents?.length) {
    // The container is checked FIRST because resolving a ticket or a source document is an
    // outbound call to the workspace's own tracker/wiki: a bad `serviceId` should be answered by
    // the 404 it could have had for free, not paid for with a live third-party fetch.
    // `addServiceTask` re-applies the same rule (it is the one that must hold at the moment of the
    // write); this only moves the cheap, deterministic half of it in front of the expensive work.
    await deps.boardService.assertTaskContainer(workspaceId, serviceId)
  }
  const linkage = ticket ? await resolveTicket(deps, workspaceId, ticket) : null
  const attachment = documents?.length ? await resolveDocuments(deps, workspaceId, documents) : null

  // Unattributed by the same reading the headless RUN start gets (ADR 0037): an API key holds
  // scopes, not a workspace tier, so no role-scoped merge restriction applies to it and none can
  // be dropped by what it selects. Stated HERE, at the route that knows how the caller
  // authenticated, rather than inside `addServiceTask`, which serves whoever calls it.
  const block = await deps.boardService.addServiceTask(
    workspaceId,
    serviceId,
    input,
    UNATTRIBUTED_BLOCK_EDITOR,
  )

  if (attachment) {
    // Attached BEFORE the ticket is claimed, so this rollback can be a plain removal: a block
    // removed after a successful claim would leave the ticket pointing at a task nobody can open,
    // a state that then refuses every future filing of that ticket.
    try {
      await attachment.attach(block.id)
    } catch (error) {
      await releaseUnattachedTask(deps, workspaceId, block.id)
      throw error
    }
  }
  // Rolls the block back off the board if the claim is lost, so a caller that retries on the 409
  // does not accumulate the duplicates the ticket link exists to prevent.
  if (linkage) await linkage.claim(block.id)
  return block
}
