import {
  disconnectToolServerOAuthContract,
  listToolServersContract,
  probeToolServerContract,
  startToolServerOAuthContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/**
 * Per-workspace tool-server (MCP) operability: the inventory of what this deployment declared, and
 * a probe that speaks the protocol to one of them.
 *
 * `secrets.manage`-gated end to end, the READ included — the inventory names the credential keys the
 * deployment's capabilities want and the endpoints those credentials are sent to. The probe is a
 * POST because it SPENDS an outbound request under the deployment's own credential, so it must not
 * be safe to retry from a cache or a prefetch. See ToolServerController.
 */
export function toolServersApi({ send, ws }: ApiContext) {
  return {
    listToolServers: (workspaceId: string) =>
      send(listToolServersContract, { pathPrefix: ws(workspaceId) }),

    probeToolServer: (workspaceId: string, id: string) =>
      send(probeToolServerContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),

    // Begin an interactive OAuth grant: answers with the VENDOR's authorization URL for the
    // operator's browser to follow, rather than redirecting, since a redirect from a `fetch` lands
    // in a cross-origin document this app cannot observe.
    startToolServerOAuth: (workspaceId: string, id: string) =>
      send(startToolServerOAuthContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),

    disconnectToolServerOAuth: (workspaceId: string, id: string) =>
      send(disconnectToolServerOAuthContract, { pathPrefix: ws(workspaceId), pathParams: { id } }),
  }
}
