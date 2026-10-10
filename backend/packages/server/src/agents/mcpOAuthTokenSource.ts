import type { Logger, McpOAuthTokenSource, ToolSecretResolver } from '@cat-factory/kernel'
import { noopLogger } from '@cat-factory/kernel'
import type { McpOAuthService } from '@cat-factory/integrations'
import { resolveOAuthClientSecret } from './mcpOAuthClientSecret.js'

// ---------------------------------------------------------------------------
// The kernel `McpOAuthTokenSource` a facade wires, assembled from the two halves a token needs: the
// sealed per-workspace grant store (`McpOAuthService`) and the capability-credential chain that
// resolves the OAuth CLIENT SECRET.
//
// The join lives here, in the server layer, for the same reason the credential composition does:
// the store is built by a facade and the resolver is composed by a facade, and neither the
// runtime-neutral service nor the dispatch code that consumes the port may know about the other.
// ---------------------------------------------------------------------------

export interface McpOAuthTokenSourceOptions {
  oauth: McpOAuthService
  /**
   * The composed capability-credential chain — the SAME resolver a dispatch resolves `secretKeys`
   * through, which is what lets a workspace bring its own OAuth client through the credential
   * checklist rather than through a second mechanism. Absent ⇒ a declaration naming a client
   * secret resolves none, and the dispatch reports the server as `oauth_token_failed` rather than
   * asking the authorization server a question this side already knows the answer to.
   */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

/** Build the token source. */
export function createMcpOAuthTokenSource(
  options: McpOAuthTokenSourceOptions,
): McpOAuthTokenSource {
  const logger = options.logger ?? noopLogger
  return {
    accessToken: async ({ workspaceId, serverId, serverUrl, oauth }) => {
      const secret = await resolveOAuthClientSecret({
        workspaceId,
        serverId,
        oauth,
        ...(options.resolveToolSecrets ? { resolveToolSecrets: options.resolveToolSecrets } : {}),
        logger,
      })
      if (!secret.ok) return { status: 'token_failed', error: secret.error }
      return options.oauth.accessToken({
        workspaceId,
        serverId,
        serverUrl,
        oauth,
        ...(secret.value ? { clientSecret: secret.value } : {}),
      })
    },
  }
}

/**
 * The two fields an MCP-OAuth-capable facade contributes to its `ServerContainer`.
 *
 * They travel together for the reason `toolSecretContainerFields` exists beside it: the store and
 * the redirect URL are two halves of one capability, and a facade that wired the store and dropped
 * the URL offers a Connect button that always answers 503. Structurally typed, so this module keeps
 * no dependency on the HTTP layer.
 */
export interface McpOAuthContainerFields {
  mcpOAuth?: McpOAuthService
  mcpOAuthRedirectUrl?: string
}

/**
 * Project a facade's OAuth wiring onto those fields, omitting what it does not have.
 *
 * ABSENT rather than present-and-undefined, which is why this is a function and not two spreads at
 * each composition root: `requireCapability` and `requireMcpOAuthRedirectUrl` both narrow on
 * presence, and a facade spreading the keys unconditionally would turn "not wired" into a value
 * that reads as wired.
 */
export function mcpOAuthContainerFields(input: {
  oauth?: McpOAuthService | undefined
  redirectUrl?: string | undefined
}): McpOAuthContainerFields {
  const redirectUrl = input.redirectUrl?.trim()
  return {
    ...(input.oauth ? { mcpOAuth: input.oauth } : {}),
    ...(redirectUrl ? { mcpOAuthRedirectUrl: redirectUrl } : {}),
  }
}

/**
 * The executor dep an OAuth-capable facade contributes, or nothing when it has no grant store.
 *
 * Same shape and same reason as {@link mcpOAuthContainerFields}: absent is a real deployment state
 * (no `ENCRYPTION_KEY`), and it must reach the dispatch as an absent dep so an OAuth server is
 * stated as `oauth_not_connected` rather than sent a request with no token.
 */
export function mcpOAuthExecutorDeps(input: {
  oauth?: McpOAuthService | undefined
  resolveToolSecrets?: ToolSecretResolver | undefined
  logger?: Logger | undefined
}): { resolveToolServerOAuth?: McpOAuthTokenSource } {
  if (!input.oauth) return {}
  return {
    resolveToolServerOAuth: createMcpOAuthTokenSource({
      oauth: input.oauth,
      ...(input.resolveToolSecrets ? { resolveToolSecrets: input.resolveToolSecrets } : {}),
      ...(input.logger ? { logger: input.logger } : {}),
    }),
  }
}
