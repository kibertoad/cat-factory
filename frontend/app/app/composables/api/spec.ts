import { getRunSpecContract, getServiceSpecContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The two spec reads, which answer different questions and are paired here so a caller has to
 * pick one deliberately.
 *
 * `getServiceSpec` reassembles the sharded `spec/` artifact from the service repo's DEFAULT
 * branch: what the service requires today, for the inspector's "View Requirements" window.
 * `getRunSpec` reads it from the branch ONE RUN pushed to: what that run's tester actually ruled
 * against, for the outcome card's requirement join. While a pull request is open the two are
 * different trees, and joining a run's verdicts against the first shows every requirement the
 * run itself added as "not checked".
 *
 * Both are always 200: no spec, no repo or no VCS connected returns `{ present: false }`.
 */
export function specApi({ send, ws }: ApiContext) {
  return {
    getServiceSpec: (workspaceId: string, blockId: string) =>
      send(getServiceSpecContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),
    getRunSpec: (workspaceId: string, executionId: string) =>
      send(getRunSpecContract, { pathPrefix: ws(workspaceId), pathParams: { executionId } }),
  }
}
