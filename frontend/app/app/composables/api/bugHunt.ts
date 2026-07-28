import {
  adoptBugHuntCandidateContract,
  listTrackerBoardsContract,
  runBugHuntContract,
} from '@cat-factory/contracts'
import type { RunBugHuntInput, TaskSourceKind } from '~/types/domain'
import type { ApiContext } from './context'

/** Bug hunt: list a tracker's boards, rank a board's open unassigned bugs, adopt one. */
export function bugHuntApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    // The boards a hunt can run against (Jira projects / Linear teams / GitHub repos). Errors
    // when the source can't enumerate them, which the modal turns into a free-text board field.
    listTrackerBoards: (workspaceId: string, source: TaskSourceKind) =>
      send(listTrackerBoardsContract, { pathPrefix: ws(workspaceId), pathParams: { source } }),

    // Scan the board for open, unassigned bugs and rank them by impact vs complexity. A live
    // external call plus a model call, so it can take a while — the modal shows progress.
    runBugHunt: (workspaceId: string, source: TaskSourceKind, body: RunBugHuntInput) =>
      send(runBugHuntContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body,
      }),

    // Adopt the confirmed candidate as a bug task and start its run. Carries the personal
    // password header when the pipeline resolves an individual-usage model, like every start.
    adoptBugHuntCandidate: (
      workspaceId: string,
      source: TaskSourceKind,
      body: { externalId: string; containerId: string; pipelineId?: string },
      password?: string,
    ) =>
      sendWith(pwHeaders(password), adoptBugHuntCandidateContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { source },
        body,
      }),
  }
}
