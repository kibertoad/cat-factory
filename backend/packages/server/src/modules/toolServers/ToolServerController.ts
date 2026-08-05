import {
  disconnectToolServerOAuthContract,
  listToolServersContract,
  probeToolServerContract,
  startToolServerOAuthContract,
} from '@cat-factory/contracts'
import type { McpOAuthConfig } from '@cat-factory/kernel'
import { NotFoundError, ValidationError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { Hono } from 'hono'
import { createMcpOAuthTokenSource } from '../../agents/mcpOAuthTokenSource.js'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { mountWorkspacePermissionIncludingReads } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requestLogger } from '../../http/requestLogging.js'
import { collectDeclaredToolServers, resolveDeclaredToolServers } from './declaredToolServers.js'
import { probeToolServer } from './probeToolServer.js'
import { requireMcpOAuthRedirectUrl } from './mcpOAuthRedirect.js'

/**
 * TOOL SERVER (MCP) OPERABILITY: what this deployment declared, and whether one of them answers.
 *
 * The read is the inventory nothing else provided. A tool server has four independent ways of not
 * reaching a run — no kind declares it, no harness can serve its transport, its credential does not
 * resolve, or the endpoint is dead — and before this surface each was visible somewhere else or
 * nowhere: the deployment's own source, a boot log line, a run's prompt. The probe settles the last
 * two for real, by resolving the credential through the same chain a dispatch uses and speaking the
 * protocol.
 *
 * `secrets.manage`-gated INCLUDING THE READ, via {@link mountWorkspacePermissionIncludingReads}
 * rather than the usual writes-only mount. The projection names the credential KEYS this
 * deployment's capabilities want, which is the same content the workspace snapshot deliberately
 * withholds from a viewer ("no business learning which environment variables the deployment sets"),
 * plus the endpoints those credentials are sent to. The probe needs the gate for a second reason: it
 * SPENDS an outbound request against a third party under the deployment's own credential, which is
 * not a read-tier capability whatever the response reveals.
 */
export function toolServerController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermissionIncludingReads(app, 'secrets.manage', ['/tool-servers'])

  buildHonoRoute(app, listToolServersContract, async (c) => {
    const container = c.get('container')
    // ONE read of the workspace's grants for the whole inventory, indexed by server id — the
    // declarations are the deployment's entire registry, so a per-row lookup here would be an N+1
    // over it. Absent store ⇒ an empty map, and each OAuth declaration renders as not connected,
    // which is the true state of a deployment that cannot keep a grant.
    const grants = container.mcpOAuth
      ? await container.mcpOAuth.listStatuses(param(c, 'workspaceId'))
      : new Map()
    return c.json(
      {
        servers: collectDeclaredToolServers({
          agentKindRegistry: container.agentKindRegistry,
          oauthGrants: grants,
        }),
      },
      200,
    )
  })

  buildHonoRoute(app, probeToolServerContract, async (c) => {
    const container = c.get('container')
    return c.json(
      await probeToolServer({
        agentKindRegistry: container.agentKindRegistry,
        workspaceId: param(c, 'workspaceId'),
        serverId: c.req.valid('param').id,
        // The composed chain, so the verdict is about THIS board's credentials. Absent when a facade
        // wired none, which the probe reports as `credentials_missing` — the same disposition the
        // dispatch path gives the same state.
        ...(container.toolSecretResolver
          ? { resolveToolSecrets: container.toolSecretResolver }
          : {}),
        // The same token source a dispatch mints with, so an OAuth server's verdict is about this
        // board's grant rather than about an unauthenticated request nobody makes.
        ...(container.mcpOAuth
          ? {
              resolveToolServerOAuth: createMcpOAuthTokenSource({
                oauth: container.mcpOAuth,
                ...(container.toolSecretResolver
                  ? { resolveToolSecrets: container.toolSecretResolver }
                  : {}),
                logger: requestLogger(c),
              }),
            }
          : {}),
        logger: requestLogger(c),
      }),
      200,
    )
  })

  // Begin an interactive grant. Everything that can refuse does so BEFORE a browser leaves the
  // app: an id nothing declares (404), a server that does not authenticate with OAuth or does so
  // with the machine grant (422), a deployment with no grant store or no registered redirect URL
  // (503). A refusal after the redirect would land on a vendor's error page instead.
  buildHonoRoute(app, startToolServerOAuthContract, async (c) => {
    const container = c.get('container')
    const oauthService = requireCapability(
      container.mcpOAuth,
      'Tool-server OAuth is not configured: this deployment has no encryption key, so it has ' +
        'nowhere to keep a grant.',
    )
    const definition = requireOAuthServer(container.agentKindRegistry, c.req.valid('param').id)
    return c.json(
      await oauthService.startAuthorization({
        workspaceId: param(c, 'workspaceId'),
        serverId: definition.id,
        serverUrl: definition.url,
        oauth: definition.oauth,
        userId: c.get('user')?.id ?? null,
        redirectUri: requireMcpOAuthRedirectUrl(container),
      }),
      200,
    )
  })

  buildHonoRoute(app, disconnectToolServerOAuthContract, async (c) => {
    const container = c.get('container')
    const oauthService = requireCapability(
      container.mcpOAuth,
      'Tool-server OAuth is not configured: this deployment has no encryption key, so it has ' +
        'nowhere to keep a grant.',
    )
    // The id is NOT re-checked against a live declaration. A grant outlives the declaration that
    // created it (a deployment retires a server, or renames it in a refactor), and the row is then
    // a live vendor token nobody can reach — so the one action that removes it must not be gated
    // on the registry still naming it.
    await oauthService.disconnect(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}

/**
 * The declared server behind an id, narrowed to one that can actually be granted.
 *
 * Both refusals are the operator's to act on and neither is the same as the other: an id nothing
 * declares means the deployment changed under the panel they are looking at (404), while a server
 * that declares no OAuth — or declares it on a transport with no request to authorise — means the
 * button was rendered for a row it does not apply to (422, with a `reason` the SPA translates).
 */
function requireOAuthServer(
  registry: AgentKindRegistry,
  serverId: string,
): { id: string; url: string; oauth: McpOAuthConfig } {
  const declared = resolveDeclaredToolServers(registry).get(serverId)
  if (!declared) throw new NotFoundError('Tool server', serverId)
  const { oauth, transport, id } = declared.definition
  if (!oauth || transport.kind !== 'http') {
    throw new ValidationError(
      `Tool server '${serverId}' does not authenticate with OAuth, so there is nothing to grant.`,
      { reason: 'tool_server_without_oauth' },
    )
  }
  return { id, url: transport.url, oauth }
}
