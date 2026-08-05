import type { McpOAuthConfig } from '@cat-factory/kernel'
import { ForbiddenError, UnauthorizedError, ValidationError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { resolveOAuthClientSecret } from '../../agents/mcpOAuthClientSecret.js'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { requestLogger } from '../../http/requestLogging.js'
import { loadWorkspaceAccess } from '../../http/workspaceAccess.js'
import { resolveDeclaredToolServers } from './declaredToolServers.js'
import { MCP_OAUTH_CALLBACK_PATH } from './mcpOAuthRedirect.js'

// ---------------------------------------------------------------------------
// Where a vendor's authorization server sends the operator's browser back after they approve a
// remote MCP tool server. Public by necessity and gated by three independent things instead:
//
//   1. the sealed `state`, which only this deployment can mint and open (AEAD under its own key),
//      carries the workspace, the server and the PKCE verifier, and expires;
//   2. the SESSION, because the state names the user who started the flow and this route refuses
//      a callback completed as anyone else — without that binding, getting an admin to open an
//      attacker's authorization link plants the attacker's vendor account as the board's
//      connection, which is the classic OAuth login-CSRF turned inside out;
//   3. the workspace PERMISSION, re-checked here rather than assumed from the start call. A grant
//      takes minutes of human time, and `secrets.manage` can be revoked inside that window; the
//      start route's gate is not evidence about the moment the token is stored.
//
// It is mounted at the app root because the redirect URI is a string the VENDOR has on file: it
// cannot carry a board id in its path and cannot sit behind the workspace gate.
// ---------------------------------------------------------------------------

export function mcpOAuthCallbackController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get(MCP_OAUTH_CALLBACK_PATH, async (c) => {
    const container = c.get('container')
    const logger = requestLogger(c)
    const oauthService = requireCapability(
      container.mcpOAuth,
      'Tool-server OAuth is not configured',
    )

    // An authorization server that REFUSED reports it here rather than on the token endpoint, so
    // the operator's own decision ("Deny") and a misconfigured client both arrive as this. Named
    // rather than folded into "missing code": one is nothing to fix and the other is the client
    // registration.
    const denied = c.req.query('error')
    if (denied) {
      throw new ValidationError(
        `The authorization server refused the grant (${denied})` +
          `${c.req.query('error_description') ? `: ${c.req.query('error_description')}` : ''}`,
        { reason: 'oauth_authorization_denied' },
      )
    }
    const code = c.req.query('code')
    if (!code) {
      throw new ValidationError('The authorization server sent no code', {
        reason: 'oauth_code_missing',
      })
    }

    const request = await oauthService.readAuthorizationRequest(c.req.query('state') ?? null)
    if (!request) {
      logger.warn('mcp oauth callback carried no usable state')
      throw new UnauthorizedError('This authorization request is invalid or has expired')
    }

    const user = c.get('user')
    // Dev-open (no auth configured) resolves no user and no access object, and allows everything,
    // exactly as `requirePermission` does — the same reading, not a second policy.
    if (user) {
      if (request.userId && request.userId !== user.id) {
        logger.warn(
          'mcp oauth callback completed by a different user than the one who started it',
          {
            workspaceId: request.workspaceId,
            toolServerId: request.serverId,
          },
        )
        throw new UnauthorizedError('This authorization request was started by someone else')
      }
      const access = await loadWorkspaceAccess(container, request.workspaceId, user.id)
      if (!access?.allowed || !access.permissions.has('secrets.manage')) {
        throw new ForbiddenError('This action requires the secrets.manage permission', {
          permission: 'secrets.manage',
        })
      }
    }

    // Re-resolved from the registry rather than sealed into the state: the CLIENT is deployment
    // code, so a deployment that fixed a wrong client id between the redirect and the callback
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
    // Land back on the app, reusing the target the GitHub setup flow already redirects to.
    return c.redirect(container.config.github.setupRedirectUrl || '/')
  })

  return app
}

/**
 * The OAuth client secret for the exchange, through the SAME shared resolution the dispatch path
 * uses — including its reserved-key floor, which is exactly why this is not a local lookup: a
 * floor enforced at one of two call sites is not a floor.
 *
 * A declared-but-unresolvable secret REFUSES the callback with a 422 rather than exchanging as a
 * public client. The operator is standing in front of this: telling them the client secret is
 * missing is a fix they can make, where a vendor's `invalid_client` a second later is not.
 */
async function resolveClientSecret(
  c: Context<AppEnv>,
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
