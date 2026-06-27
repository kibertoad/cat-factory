import { getServiceSpecContract } from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * The service-spec read (the inspector's "View Requirements" window). Reassembles the
 * sharded `spec/` artifact from the service repo's default branch. Always 200: a service
 * with no spec on main (or no GitHub connected) returns `{ present: false }`.
 */
export function specApi({ send, ws }: ApiContext) {
  return {
    getServiceSpec: (workspaceId: string, blockId: string) =>
      send(getServiceSpecContract, { pathPrefix: ws(workspaceId), pathParams: { blockId } }),
  }
}
