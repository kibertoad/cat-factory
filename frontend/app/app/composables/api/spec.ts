import type { ServiceSpecView } from '~/types/spec'
import type { ApiContext } from './context'

/**
 * The service-spec read (the inspector's "View Requirements" window). Reassembles the
 * sharded `spec/` artifact from the service repo's default branch. Always 200: a service
 * with no spec on main (or no GitHub connected) returns `{ present: false }`.
 */
export function specApi({ http, ws }: ApiContext) {
  return {
    getServiceSpec: (workspaceId: string, blockId: string) =>
      http<ServiceSpecView>(`${ws(workspaceId)}/blocks/${encodeURIComponent(blockId)}/spec`),
  }
}
