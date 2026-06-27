import {
  answerFollowUpContract,
  dismissFollowUpContract,
  fileFollowUpContract,
  getFollowUpsContract,
  queueFollowUpContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The Follow-up companion: the Coder surfaces forward-looking items (loose ends /
 * side-tasks / questions) live on its run step; these endpoints decide each one. Every
 * call returns the updated live state; when the run is parked on the follow-up gate and
 * the last item is decided, the backend drives the run forward (loop the Coder for the
 * queued / answered items, else advance).
 */
export function followUpsApi({ send, ws }: ApiContext) {
  return {
    // The live follow-up state for a run (null when the companion is off / nothing surfaced).
    getFollowUps: (workspaceId: string, executionId: string) =>
      send(getFollowUpsContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),

    // File a follow-up as a tracker issue (GitHub Issues / Jira).
    fileFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      send(fileFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, itemId },
      }),

    // Send a follow-up back to the Coder (queued for its next pass).
    queueFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      send(queueFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, itemId },
      }),

    // Answer a question item (folded into the Coder's next pass).
    answerFollowUp: (workspaceId: string, executionId: string, itemId: string, answer: string) =>
      send(answerFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, itemId },
        body: { answer },
      }),

    // Dismiss a follow-up / question item without acting on it.
    dismissFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      send(dismissFollowUpContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, itemId },
      }),
  }
}
