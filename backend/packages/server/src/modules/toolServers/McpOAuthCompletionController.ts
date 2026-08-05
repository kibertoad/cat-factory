import { completeToolServerOAuthContract } from '@cat-factory/contracts'
import type { McpOAuthConfig } from '@cat-factory/kernel'
import { ForbiddenError, UnauthorizedError, ValidationError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { resolveOAuthClientSecret } from '../../agents/mcpOAuthClientSecret.js'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { requestLogger } from '../../http/requestLogging.js'
import { loadWorkspaceAccess } from '../../http/workspaceAccess.js'
import { resolveDeclaredToolServers } from './declaredToolServers.js'

// ---------------------------------------------------------------------------
// Finishing an OAuth grant against a remote MCP tool server.
//
// The vendor's redirect does NOT land here. It lands on the SPA, which re-presents the `code` and
// `state` over the authenticated API, and that indirection is the entire security design rather
// than a convenience:
//
// A redirect URI is one fixed string a third party has on file, so a route receiving it directly
// is reached by a top-level browser navigation the vendor triggers. Sessions in this product are
// BEARER TOKENS, which such a navigation cannot carry, so that route sees no user on every request
// — on an auth-enabled deployment exactly as in dev-open. Any "the caller is who started the flow"
// or "the caller still holds secrets.manage" check written there is unreachable code that reads
// like protection, and it would additionally have to be exempted from the default-deny session gate
// to be reachable at all. Routing the two values back through the SPA is what turns both checks
// into things that actually run.
//
// So this route is ordinary session-gated API, and it is mounted at the ROOT because the board is
// sealed into the state rather than carried in the path — the same shape `/user-secrets` has. Three
// things gate it, each of which now genuinely executes:
//
//   1. the SESSION, via the shared default-deny gate (`mountAuthGate`), so an absent user here
//      means auth is not configured at all rather than a caller who simply has no token;
//   2. the sealed `state`, which only this deployment can mint and open, carries the workspace, the
//      server and the PKCE verifier, and expires;
//   3. the workspace PERMISSION, re-resolved at the moment the token is stored. A grant takes
//      minutes of human time and `secrets.manage` can be revoked inside that window, so the start
//      route's gate is not evidence about now.
// ---------------------------------------------------------------------------

export function mcpOAuthCompletionController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, completeToolServerOAuthContract, async (c) => {
    const container = c.get('container')
    const logger = requestLogger(c)
    const oauthService = requireCapability(
      container.mcpOAuth,
      'Tool-server OAuth is not configured',
    )

    const { code, state } = c.req.valid('json')
    const request = await oauthService.readAuthorizationRequest(state)
    if (!request) {
      logger.warn('mcp oauth completion carried no usable state')
      throw new UnauthorizedError('This authorization request is invalid or has expired')
    }

    await assertMayCompleteGrant(c, request)

    // Re-resolved from the registry rather than sealed into the state: the CLIENT is deployment
    // code, so a deployment that fixed a wrong client id between the redirect and the completion
    // should exchange with the corrected one. What is pinned in the state is the endpoint and the
    // verifier, which are properties of the request the operator actually consented to.
    const declared = resolveDeclaredToolServers(container.agentKindRegistry).get(request.serverId)
    const oauth = declared?.definition.oauth
    if (!oauth) {
      throw new ValidationError(
        `Tool server '${request.serverId}' no longer declares OAuth, so this grant cannot be ` +
          `completed.`,
        { reason: 'tool_server_without_oauth' },
      )
    }
    const clientSecret = await resolveClientSecret(c, request.workspaceId, request.serverId, oauth)

    await oauthService.completeAuthorization(request, {
      code,
      clientId: oauth.clientId,
      ...(clientSecret ? { clientSecret } : {}),
    })
    return c.json({ serverId: request.serverId, workspaceId: request.workspaceId }, 200)
  })

  return app
}

/**
 * The two checks a completion is worth having a session for.
 *
 * A `null` user is dev-open and allows everything, the same reading `requirePermission` takes and
 * not a second policy. It is SOUND here only because the route sits behind the default-deny gate:
 * with auth enabled, a request with no valid session never reaches the handler, so an absent user
 * means auth is genuinely unconfigured. (That is precisely what a public redirect target could not
 * say, which is why this flow does not have one.)
 */
async function assertMayCompleteGrant<E extends AppEnv>(
  c: Context<E>,
  request: { workspaceId: string; serverId: string; userId: string | null },
): Promise<void> {
  const user = c.get('user')
  if (!user) return

  // Without this binding, getting an admin to open an attacker's authorization link would plant the
  // ATTACKER's vendor account as the board's connection: the classic OAuth login-CSRF turned inside
  // out. The state is sealed, so only someone who could already start a flow on this board can mint
  // one, and this closes the case where such a value is captured and replayed by someone else.
  if (request.userId && request.userId !== user.id) {
    requestLogger(c).warn(
      'mcp oauth completion attempted by a different user than the one who started it',
      { workspaceId: request.workspaceId, toolServerId: request.serverId },
    )
    throw new UnauthorizedError('This authorization request was started by someone else')
  }

  // Resolved through the ONE shared resolution the workspace gate uses. It cannot be the gate
  // itself: the board is sealed into the state rather than named in the path, so there is no
  // `:workspaceId` segment to bind to.
  const access = await loadWorkspaceAccess(c.get('container'), request.workspaceId, user.id)
  if (!access?.allowed || !access.permissions.has('secrets.manage')) {
    throw new ForbiddenError('This action requires the secrets.manage permission', {
      permission: 'secrets.manage',
    })
  }
}

/**
 * The OAuth client secret for the exchange, through the SAME shared resolution the dispatch path
 * uses — including its reserved-key floor, which is exactly why this is not a local lookup: a
 * floor enforced at one of two call sites is not a floor.
 *
 * A declared-but-unresolvable secret REFUSES the completion with a 422 rather than exchanging as a
 * public client. The operator is standing in front of this: telling them the client secret is
 * missing is a fix they can make, where a vendor's `invalid_client` a second later is not.
 */
async function resolveClientSecret<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  serverId: string,
  oauth: McpOAuthConfig,
): Promise<string | undefined> {
  const container = c.get('container')
  const resolved = await resolveOAuthClientSecret({
    workspaceId,
    serverId,
    oauth,
    ...(container.toolSecretResolver ? { resolveToolSecrets: container.toolSecretResolver } : {}),
    logger: requestLogger(c),
  })
  if (!resolved.ok) {
    throw new ValidationError(resolved.error, { reason: 'oauth_client_secret_unavailable' })
  }
  return resolved.value
}
