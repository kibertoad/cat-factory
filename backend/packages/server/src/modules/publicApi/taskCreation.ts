import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import type { Block, CreatePublicTaskInput } from '@cat-factory/contracts'
import type { Logger } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'
import { releaseUnattachedTask, resolveDocuments } from './documentAttachment.js'
import { assertFragmentsResolvable } from './fragmentCatalog.js'
import { resolveTaskTypeFields } from './taskTypeFields.js'
import { resolveTicket } from './ticketLinkage.js'

// The ORDERING of `POST /api/v1/services/:serviceId/tasks`, which is the whole design of that
// route and reads as nothing but a long function inlined into a route registration.
//
// A creation on this surface can carry two kinds of attachment, each with a step that cannot run
// until the block exists (a link column can only name a row that is there) and refusals that must
// all land before one does. The rule the sequence below encodes, in one sentence:
//
//   everything refusable is refused before the board changes, the container first of all, and
//   everything that can only name an existing block runs after, taking the task back off the
//   board if it does not land.
//
// "The container first of all" is a rule about which refusal a caller READS. Every other check
// here presumes a service that exists, so any of them answering ahead of the 404 describes a
// request the caller did not make.
//
// The failure it exists to prevent is not a lost write, it is a QUIET one: a `201` for a task the
// caller believes carries its ticket and its spec, running on its title alone, with an agent
// building against requirements nobody notices it never received.
//
// Refusals that need a REPOSITORY read are mostly not restated here. A pinned `modelPresetId` /
// `riskPolicyId` naming nothing is refused inside `addServiceTask`, on the service every other
// door reaches too (`presetPinGuard.ts`), which costs a bad pin one wasted ticket/document fetch
// and buys the same refusal for the SPA, tracker intake, an initiative spawn and blueprint
// reconciliation.
//
// `fragmentIds` is the one that cannot go there, and `fragmentCatalog.ts` carries the reason: the
// app's create form submits the service's inherited standards verbatim alongside the person's own
// picks, so the same refusal on the service would turn one stale library id into a service nobody
// can file a task under. Here every id was named by the caller. It reads a cached tenant catalog
// and makes no outbound call, so it is hoisted with the deterministic checks rather than paid for
// after the ticket and document fetches.

/** What creating a public task needs from the container. */
export interface PublicTaskCreationDeps {
  boardService: ServerContainer['boardService']
  /** The registry a custom type's field descriptors are read off; absent ⇒ built-in types only. */
  taskTypeRegistry: ServerContainer['taskTypeRegistry']
  tasks: ServerContainer['tasks']
  documents: ServerContainer['documents']
  /** The merged best-practice catalog a named `fragmentIds` is checked against; absent ⇒ a 503. */
  fragmentLibrary: ServerContainer['fragmentLibrary']
  logger: Logger
}

/** Read the collaborators this module drives off the request's container. */
export function taskCreationDeps(container: ServerContainer): PublicTaskCreationDeps {
  return {
    boardService: container.boardService,
    taskTypeRegistry: container.taskTypeRegistry,
    tasks: container.tasks,
    documents: container.documents,
    fragmentLibrary: container.fragmentLibrary,
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
  const { ticket, documents, fields: _fields, ...rest } = body
  // The caller's `fields` bag becomes the internal per-type shape BEFORE anything is resolved: it
  // is a pure, deterministic refusal, so it must land ahead of the outbound ticket/document
  // fetches, exactly like the container check below.
  const taskTypeFields = resolveTaskTypeFields(body, deps.taskTypeRegistry)
  // The container is checked before anything is fetched, read per workspace, or written, and
  // UNCONDITIONALLY, not only when there is an outbound fetch to save. A `serviceId` that names
  // nothing is the caller's most basic mistake, and every refusal that runs ahead of it answers a
  // request about a service that does not exist by complaining about something else: a typo'd
  // path carrying an unknown standard would come back `422 prompt_fragment_not_found`, telling the
  // integrator its service was fine and sending it to fix the wrong end. `addServiceTask`
  // re-applies the same rule (it is the one that must hold at the moment of the write); this moves
  // the cheap, deterministic half of it in front of everything.
  await deps.boardService.assertTaskContainer(workspaceId, serviceId)
  // Then the standards: one the workspace does not resolve is refused before anything is fetched
  // or written. See `fragmentCatalog.ts` for why the run path's "drop a stale id" is the wrong
  // disposition for a list a caller just named.
  await assertFragmentsResolvable(deps.fragmentLibrary, workspaceId, body.fragmentIds)
  // `modelPresetId`, `riskPolicyId` and `fragmentIds` ride the spread because the public surface
  // spells each exactly as `AddTaskInput` does, which is the ONE reason a spread is safe here and
  // is pinned by `blockEditAuthority.coverage.spec.ts`. Whether the two PINS name a real row is
  // `addServiceTask`'s to refuse, on the service where every other door reaches it too
  // (`presetPinGuard.ts`); the standards were settled a few lines up, at this door.
  const input = { ...rest, ...(taskTypeFields ? { taskTypeFields } : {}) }
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
    UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
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
