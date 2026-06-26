import type { FollowUpsStepState } from '~/types/execution'
import type { ApiContext } from './context'

/**
 * The Follow-up companion: the Coder surfaces forward-looking items (loose ends /
 * side-tasks / questions) live on its run step; these endpoints decide each one. Every
 * call returns the updated live state; when the run is parked on the follow-up gate and
 * the last item is decided, the backend drives the run forward (loop the Coder for the
 * queued / answered items, else advance).
 */
export function followUpsApi({ http, ws }: ApiContext) {
  const base = (workspaceId: string, executionId: string) =>
    `${ws(workspaceId)}/executions/${encodeURIComponent(executionId)}/follow-ups`

  return {
    // The live follow-up state for a run (null when the companion is off / nothing surfaced).
    getFollowUps: (workspaceId: string, executionId: string) =>
      http<FollowUpsStepState | null>(base(workspaceId, executionId)),

    // File a follow-up as a tracker issue (GitHub Issues / Jira).
    fileFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      http<FollowUpsStepState>(`${base(workspaceId, executionId)}/${encodeURIComponent(itemId)}/file`, {
        method: 'POST',
      }),

    // Send a follow-up back to the Coder (queued for its next pass).
    queueFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      http<FollowUpsStepState>(`${base(workspaceId, executionId)}/${encodeURIComponent(itemId)}/queue`, {
        method: 'POST',
      }),

    // Answer a question item (folded into the Coder's next pass).
    answerFollowUp: (workspaceId: string, executionId: string, itemId: string, answer: string) =>
      http<FollowUpsStepState>(
        `${base(workspaceId, executionId)}/${encodeURIComponent(itemId)}/answer`,
        { method: 'POST', body: { answer } },
      ),

    // Dismiss a follow-up / question item without acting on it.
    dismissFollowUp: (workspaceId: string, executionId: string, itemId: string) =>
      http<FollowUpsStepState>(
        `${base(workspaceId, executionId)}/${encodeURIComponent(itemId)}/dismiss`,
        { method: 'POST' },
      ),
  }
}
