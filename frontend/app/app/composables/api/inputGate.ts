import { resolveInputGateContract, type ResolveInputGateChoice } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The PRE-DISPATCH INPUT GATE: a run whose task states nothing an agent could act on parks before
 * its first dispatch, having spent no tokens. This resolves that park: `recheck` re-evaluates
 * the task as it now stands (the fix is verified, not asserted), `proceed` waives the findings.
 *
 * There is deliberately no read: the verdict rides the run (`ExecutionInstance.inputGate`),
 * which the board snapshot and the live stream already carry.
 */
export function inputGateApi({ send, ws }: ApiContext) {
  return {
    resolveInputGate: (
      workspaceId: string,
      executionId: string,
      body: { choice: ResolveInputGateChoice },
    ) =>
      send(resolveInputGateContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { executionId },
        body,
      }),
  }
}
