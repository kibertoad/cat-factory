import {
  addressBugFishingFindingsContract,
  dismissBugFishingFindingContract,
  getBugFishingContract,
  resolveBugFishingContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The bug-fishing expedition: the read-only `bug-fisher` agent reads the service's codebase once
 * per ANGLE and reports what each angle caught, and the run parks once every angle has settled.
 * These endpoints read the live catch, MARK findings (each spawning its own bug-fix task), drop
 * one from triage, and finish a parked expedition. The read returns null when no `bug-fisher`
 * step carries expedition state.
 */
export function bugFishingApi({ send, ws }: ApiContext) {
  return {
    // The live expedition state for a run (null when no bug-fisher step carries one).
    getBugFishing: (workspaceId: string, executionId: string) =>
      send(getBugFishingContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),

    // Mark findings to be addressed: one bug-fix task per finding, linked to the expedition.
    // Accepted while later angles are still fishing, which is the point of the phase loop.
    // `pipelineId` overrides the board's default fix pipeline for this batch only.
    addressBugFishingFindings: (
      workspaceId: string,
      executionId: string,
      body: { findingIds: string[]; pipelineId?: string },
    ) =>
      send(addressBugFishingFindingsContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),

    // Dismiss a finding: it stays on the record, struck through, and can no longer be marked.
    dismissBugFishingFinding: (workspaceId: string, executionId: string, findingId: string) =>
      send(dismissBugFishingFindingContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId, findingId },
        body: {},
      }),

    // Finish a parked expedition (triage is done); the run advances past the step.
    resolveBugFishing: (workspaceId: string, executionId: string) =>
      send(resolveBugFishingContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body: {},
      }),
  }
}
