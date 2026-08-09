import {
  getBinaryCandidatesContract,
  keepBinaryCandidatesContract,
  type KeepBinaryCandidatesInput,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Generated-candidate comparison. A binary-output step configured to COMPARE generates a
 * candidate from each of its selected integrations, stages them through the step's storage
 * service, and parks. These endpoints read the staged candidates and record which of them
 * survive (and under which alternate ids); keeping re-runs the step to deliver exactly those.
 * The read returns null when no step carries candidate state.
 */
export function binaryCandidatesApi({ send, ws }: ApiContext) {
  return {
    // The live candidate state for a run (null when no step carries one).
    getBinaryCandidates: (workspaceId: string, executionId: string) =>
      send(getBinaryCandidatesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
      }),

    // Keep the chosen candidates and discard the rest.
    keepBinaryCandidates: (
      workspaceId: string,
      executionId: string,
      body: KeepBinaryCandidatesInput,
    ) =>
      send(keepBinaryCandidatesContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),
  }
}
