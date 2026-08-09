import { PUBLIC_API_SCOPES } from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The two metadata documents an MCP host reads before it has any credential, and the challenge
// that points at the first of them.
//
// This is the discovery chain the MCP authorization spec prescribes, and every link is a document
// a third party's client walks unattended: the endpoint answers 401 with a `WWW-Authenticate`
// naming its protected-resource metadata (RFC 9728), that document names the authorization server,
// and the server's own metadata (RFC 8414) names the endpoints. Getting a host connected is
// therefore not a matter of publishing instructions anywhere: it is these three strings being
// right.
//
// They live in this package rather than the controller for one reason: the consuming half of this
// initiative WALKS the same chain against a vendor, so the shapes are asserted against each other
// (`mcpAuthorizationInterop.test.ts`) instead of each being pinned to a hand-written expectation
// that agrees with nothing.
// ---------------------------------------------------------------------------

/** The path the hosted MCP endpoint is served at, and the resource identifier is built from. */
const HOSTED_MCP_PATH = '/api/v1/mcp'

/** Where the public docs for connecting a host live. Named in both documents, per RFC. */
const DOCUMENTATION_URL = 'https://www.catfactory.ai/extend/mcp-server.html'

/** This deployment's resource identifier: the exact URL a host is told to send `resource` for. */
export function mcpResourceIdentifier(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${HOSTED_MCP_PATH}`
}

/**
 * The path a host looks for protected-resource metadata at, for a resource with a path.
 *
 * RFC 9728 INSERTS the resource's path after the well-known segment rather than appending the
 * well-known to it, so one origin can serve several protected resources. The bare path is served
 * too (see the controller): every client the wild has produced tries one or the other, and both
 * answer for the single resource this deployment has.
 */
export const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${HOSTED_MCP_PATH}`

/** The path RFC 8414 puts authorization-server metadata at. */
export const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server'

/** The three endpoints the authorization server serves, relative to the deployment's origin. */
export const OAUTH_ENDPOINT_PATHS = {
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
} as const

/**
 * The protected-resource metadata (RFC 9728) for the hosted MCP endpoint.
 *
 * `authorization_servers` names THIS deployment, because this deployment is the one: the token a
 * host ends up with is a key on this platform's own surface, so there is no third party for the
 * document to point at and no claim mapping for an operator to invent. A deployment fronted by an
 * external IdP still signs its users in through that IdP at the consent screen, where the session
 * comes from, which is the layer where the IdP's answer is actually about a person.
 */
export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: mcpResourceIdentifier(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: [...PUBLIC_API_SCOPES],
    resource_name: 'cat-factory',
    resource_documentation: DOCUMENTATION_URL,
  }
}

/**
 * The authorization-server metadata (RFC 8414).
 *
 * Three entries are load-bearing beyond being required:
 *
 * - `registration_endpoint`, because a host nobody configured has no other way to become a client
 *   here, and the hosts this exists for (claude.ai, the IDE clients) register themselves or do not
 *   connect at all.
 * - `code_challenge_methods_supported: ["S256"]`, which is not a preference: the server refuses a
 *   request without it, so advertising anything else would be advertising a request it rejects.
 * - `token_endpoint_auth_methods_supported: ["none"]`, which says out loud that the clients here
 *   are PUBLIC. A host that expected to be issued a secret learns it from the document rather than
 *   from a failed exchange.
 *
 * `refresh_token` is absent from `grant_types_supported` deliberately, and it is the honest half of
 * the token model: what this server issues is a public-API key, which does not expire, so there is
 * nothing to refresh. A client that asked for one anyway would be handed a token it never needed
 * to renew and a refresh grant that could only mint duplicates.
 */
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  const base = origin.replace(/\/+$/, '')
  return {
    issuer: base,
    authorization_endpoint: `${base}${OAUTH_ENDPOINT_PATHS.authorize}`,
    token_endpoint: `${base}${OAUTH_ENDPOINT_PATHS.token}`,
    registration_endpoint: `${base}${OAUTH_ENDPOINT_PATHS.register}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...PUBLIC_API_SCOPES],
    service_documentation: DOCUMENTATION_URL,
  }
}

/**
 * The `WWW-Authenticate` value the hosted endpoint answers an unauthenticated call with.
 *
 * This header is the ENTRY POINT to everything above: a host that gets a bare 401 has been told
 * only that its credential is wrong, and the whole discovery chain, which is otherwise perfectly
 * served, is unreachable, because nothing told the client to look for it.
 *
 * `scope` names the FLOOR the endpoint enforces rather than the scope a host should ask for. The
 * ladder is inclusive, so `read` is what a token must at least carry; what it ends up carrying is
 * the human's pick on the consent screen, which no header can predict.
 */
export function bearerChallenge(origin: string): string {
  const base = origin.replace(/\/+$/, '')
  return (
    `Bearer resource_metadata="${base}${PROTECTED_RESOURCE_METADATA_PATH}", ` +
    `scope="${PUBLIC_API_SCOPES[0]}"`
  )
}
