import { listToolServersContract, probeToolServerContract } from '@cat-factory/contracts'
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
  }
}
