import { requestHumanReviewFixContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The human-review gate's run-driving action. The gate self-drives off the PR's GitHub review
 * state, but a human can request a freeform fix at any time — dispatched to the `fixer`
 * immediately. Returns the updated execution instance (the gate state rides on its step + the
 * execution stream).
 */
export function humanReviewApi({ send, ws }: ApiContext) {
  return {
    requestHumanReviewFix: (workspaceId: string, blockId: string, instructions: string) =>
      send(requestHumanReviewFixContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { blockId },
        body: { instructions },
      }),
  }
}
