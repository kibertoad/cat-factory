import {
  McpAuthorizationServer,
  MCP_AUTH_SERVER_CIPHER_INFO,
  type PublicApiKeyService,
} from '@cat-factory/integrations'
import type { Clock, Logger } from '@cat-factory/kernel'
import { WebCryptoSecretCipher } from '../../crypto/WebCryptoSecretCipher.js'

/**
 * The one field an MCP-authorization-capable facade contributes to its `ServerContainer`.
 *
 * Projected through a shared function rather than assembled at each composition root, for the
 * reason `mcpOAuthContainerFields` beside it exists: the capability has TWO preconditions that a
 * facade could satisfy by halves, and `requireCapability` narrows on presence, so a facade
 * spreading the key unconditionally would turn "not wired" into a value that reads as wired.
 */
export interface McpAuthServerContainerFields {
  mcpAuthServer?: McpAuthorizationServer
}

/**
 * Build the authorization server for a facade that can serve one, or nothing.
 *
 * The two preconditions are not arbitrary and neither is optional:
 *
 * - an `ENCRYPTION_KEY`, because every value this flow carries between two requests is sealed
 *   under it. With no key there is nowhere to keep a PKCE challenge or an approved board, and the
 *   only alternative designs are a table or a signed-but-readable value, both refused for reasons
 *   recorded on the service itself.
 * - the public-API key store, because the token a host is issued IS a public-API key. A deployment
 *   with the public API unwired has nothing to issue, and an authorization server that authorizes
 *   access to a surface its own deployment does not serve would be a consent screen leading
 *   nowhere.
 *
 * Absent, every route refuses with a 503 naming both, which is the honest answer: this is a
 * capability a deployment has not enabled rather than a fault.
 */
export function mcpAuthServerContainerFields(input: {
  encryptionKey?: string | undefined
  publicApiKeys?: PublicApiKeyService | undefined
  clock: Clock
  logger: Logger
}): McpAuthServerContainerFields {
  const key = input.encryptionKey?.trim()
  if (!key || !input.publicApiKeys) return {}
  return {
    mcpAuthServer: new McpAuthorizationServer({
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: key,
        info: MCP_AUTH_SERVER_CIPHER_INFO,
      }),
      publicApiKeys: input.publicApiKeys,
      clock: input.clock,
      logger: input.logger,
    }),
  }
}
