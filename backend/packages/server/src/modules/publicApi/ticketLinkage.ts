import type { PublicTaskTicket } from '@cat-factory/contracts'
import type { Logger } from '@cat-factory/kernel'
import { ConflictError, runBestEffort } from '@cat-factory/kernel'
import type { ServerContainer } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'

// Filing a `/api/v1` task FROM a tracker ticket: the linkage half of `createPublicTaskContract`.
//
// The LINK, not the ticket's text, is what the rest of the platform runs on: every agent step
// re-reads the live issue as context, the writeback path posts a run's clarification questions
// onto that issue, a reply typed there resolves against the parked run, and the intake sweep
// treats the issue as taken. A caller with nowhere to name its ticket has only `description`,
// which keeps the words and throws all of that away.
//
// It is its own module because the ordering below is the whole design and it does not read as
// such inlined between two route registrations.

/** What the controller needs from the container to file a ticket-linked task. */
export interface TicketLinkageDeps {
  tasks: ServerContainer['tasks']
  boardService: ServerContainer['boardService']
  logger: Logger
}

/**
 * Resolve the ticket a task is being filed from, and hand back the CLAIM to run once the task
 * exists. Two phases, because the column that records the link can only name a block that exists
 * while every refusal has to land before one does.
 *
 * Phase 1 (`resolveTicket`) does everything that can refuse cheaply: an unconfigured or disabled
 * source, an unparseable ref, an issue the tracker will not serve, and the overwhelmingly common
 * "this ticket already has a task" all answer before the board is touched. The alternative order
 * half-succeeds in exactly the direction that hurts: a `201` for a task the caller believes
 * carries its ticket, running on the title alone, with no error to react to.
 *
 * Phase 2 (`claim`) is what makes the refusal TRUE rather than merely likely. Phase 1's read has
 * already returned by the time the block is created, so two filings of one ticket can both pass
 * it; only the conditional write in `claimForBlock` decides which one holds the ticket.
 */
export async function resolveTicket(
  deps: TicketLinkageDeps,
  workspaceId: string,
  ticket: PublicTaskTicket,
): Promise<{ claim: (blockId: string) => Promise<void> }> {
  const tasks = requireCapability(deps.tasks, 'Task-source integration is not configured')
  // Fetches the issue and upserts its projection, resolving the caller's key-OR-URL `ref` to the
  // provider's own canonical external id, so a caller holding whichever form its webhook carried
  // never has to know how this deployment keys the issue.
  const issue = await tasks.importService.import(workspaceId, ticket.source, ticket.ref)
  // One task per ticket: an issue carries a single link, so re-pointing it would strip the task
  // that already holds it of the context it was created with. Naming that task is what makes the
  // refusal actionable for a redelivering integration: it follows the existing task rather than
  // filing a duplicate. Same rule, same reason code as the app's own create-from-issue.
  if (issue.linkedBlockId) {
    throw new ConflictError(
      `Ticket ${issue.externalId} is already linked to task ${issue.linkedBlockId}`,
      'ticket_already_linked',
      { taskId: issue.linkedBlockId },
    )
  }
  return {
    claim: async (blockId) => {
      try {
        await tasks.linkService.claimForBlock(workspaceId, blockId, ticket.source, issue.externalId)
      } catch (error) {
        await releaseUnclaimedTask(deps, workspaceId, blockId, ticket, issue.externalId)
        throw error
      }
    },
  }
}

/**
 * Roll the just-created task back off the board unless it is the one that ended up holding the
 * ticket, after a claim did not report success.
 *
 * A headless filing that keeps its task here is worse than useless: the caller has an error, so
 * it retries, and the leftover is a duplicate the platform can no longer tell from real work —
 * which is precisely the bookkeeping the `ticket` input exists to spare an integration. (The
 * app's create-from-issue makes the opposite choice: a person is looking at the board and can see
 * and delete the leftover, where a rollback would delete a block out from under them.)
 *
 * It RE-READS rather than trusting how it got here, because the two ways in are not equally
 * knowable. A `false` claim means another filing won and this block is certainly not the holder.
 * A THROWN claim means the write's outcome is unknown, and a rollback on a claim that actually
 * landed would leave the ticket pointing at a task that no longer exists — a state that refuses
 * every future filing of it, naming a task nobody can open. So the row itself is asked, and the
 * block is removed only when the row does not name it.
 *
 * Best-effort throughout: this runs while an error is already on its way to the caller, and
 * failing to tidy up must never replace the refusal that explains what happened.
 */
async function releaseUnclaimedTask(
  deps: TicketLinkageDeps,
  workspaceId: string,
  blockId: string,
  ticket: PublicTaskTicket,
  externalId: string,
): Promise<void> {
  await runBestEffort(
    deps.logger,
    'public-api.ticket.release-unclaimed-task',
    async () => {
      const tasks = deps.tasks
      if (!tasks) return
      const holder = await tasks.linkService.holderOf(workspaceId, ticket.source, externalId)
      if (holder === blockId) return
      await deps.boardService.removeBlock(workspaceId, blockId)
    },
    { workspaceId, blockId, source: ticket.source, externalId },
  )
}
