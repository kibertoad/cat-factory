import { describe, expect, it } from 'vitest'
import { discoverMcpOAuthEndpoints } from '../mcpOAuth/mcpOAuthClient.js'
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  authorizationServerMetadata,
  bearerChallenge,
  mcpResourceIdentifier,
  protectedResourceMetadata,
} from './metadataDocuments.js'

// ---------------------------------------------------------------------------
// The two halves of this initiative, held against each other and against a real vendor.
//
// The serving side's documents are easy to write and easy to get subtly wrong: one wrong key, one
// path that a client does not try, and a host reports "cannot connect" with nothing on this side
// failing. The way to know they are right is not a hand-written expectation (which agrees with
// whatever was written beside it) but a real MCP OAuth CLIENT walking them, and this repository has
// one: the discovery walk the CONSUMING half uses against vendor servers.
//
// So the first test drives that walk over the documents FIGMA actually serves, recorded verbatim
// from `mcp.figma.com` on 2026-08-09, and the second drives the same walk over the documents this
// deployment now serves. One client, two servers, and the second is held to whatever the first
// demonstrates is enough. The Figma fixture also earns its place on its own: it is the regression
// test for the consuming walk against a real, shipping, OAuth-protected MCP server, which is
// otherwise only exercised against documents we wrote ourselves.
// ---------------------------------------------------------------------------

/** `https://mcp.figma.com/.well-known/oauth-protected-resource`, recorded 2026-08-09. */
const FIGMA_PROTECTED_RESOURCE = {
  resource: 'https://mcp.figma.com/mcp',
  authorization_servers: ['https://api.figma.com'],
  bearer_methods_supported: ['header'],
  scopes_supported: ['mcp:connect'],
  resource_name: 'Figma MCP',
  resource_documentation: 'https://developers.figma.com/docs/figma-mcp-server/',
}

/** `https://api.figma.com/.well-known/oauth-authorization-server`, recorded 2026-08-09. */
const FIGMA_AUTHORIZATION_SERVER = {
  issuer: 'https://api.figma.com',
  authorization_endpoint: 'https://www.figma.com/oauth/mcp',
  token_endpoint: 'https://api.figma.com/v1/oauth/token',
  grant_types_supported: [
    'authorization_code',
    'refresh_token',
    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  ],
  response_types_supported: ['code'],
  registration_endpoint: 'https://api.figma.com/v1/oauth/mcp/register',
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  scopes_supported: ['mcp:connect'],
  require_state_parameter: true,
}

/** The `WWW-Authenticate` Figma's endpoint answers an unauthenticated call with, same recording. */
const FIGMA_CHALLENGE =
  'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",' +
  'scope="mcp:connect",authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"'

/** A fetch that serves exactly the documents at exactly the URLs, and 404s everything else. */
function serving(documents: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const document = documents[url]
    if (!document) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(document), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

/**
 * The `resource_metadata` URL out of a challenge, the way a client reads it.
 *
 * Deliberately a parse rather than a string comparison: what matters is that a client following RFC
 * 6750 §3 can EXTRACT a URL from what this deployment sends, and the same reader has to work on
 * Figma's header, which quotes its parameters the same way but separates them without spaces.
 */
function resourceMetadataOf(challenge: string): string | null {
  const match = /resource_metadata="([^"]+)"/.exec(challenge)
  return match ? match[1]! : null
}

describe('MCP authorization interoperability', () => {
  it("walks Figma's live documents to its authorization endpoints", async () => {
    // Figma serves the protected-resource document at BOTH well-known paths, which is what the
    // walk's two candidates exist for; the recorded fixture only serves the bare one, so this also
    // pins that the path-inserted miss falls through rather than ending the walk.
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.figma.com/mcp', {
      fetch: serving({
        'https://mcp.figma.com/.well-known/oauth-protected-resource': FIGMA_PROTECTED_RESOURCE,
        'https://api.figma.com/.well-known/oauth-authorization-server': FIGMA_AUTHORIZATION_SERVER,
      }),
    })
    expect(endpoints).toEqual({
      authorizationUrl: 'https://www.figma.com/oauth/mcp',
      tokenUrl: 'https://api.figma.com/v1/oauth/token',
      // Figma advertises both client-authentication methods, and the body form is what this
      // platform then uses: flipping to Basic only when the server advertises Basic and NOT post
      // is what keeps a client secret from being sent twice to a server that refused it once.
      useBasicAuth: false,
    })

    expect(resourceMetadataOf(FIGMA_CHALLENGE)).toBe(
      'https://mcp.figma.com/.well-known/oauth-protected-resource',
    )
  })

  it('walks THIS deployment’s documents the same way, to this deployment’s endpoints', async () => {
    const origin = 'https://cat.example'
    const endpoints = await discoverMcpOAuthEndpoints(mcpResourceIdentifier(origin), {
      fetch: serving({
        [`${origin}${PROTECTED_RESOURCE_METADATA_PATH}`]: protectedResourceMetadata(origin),
        [`${origin}${AUTHORIZATION_SERVER_METADATA_PATH}`]: authorizationServerMetadata(origin),
      }),
    })
    expect(endpoints).toEqual({
      authorizationUrl: `${origin}/oauth/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      // No client secret is ever sent here (the clients are public), so the body form is the only
      // one that could be right.
      useBasicAuth: false,
    })
  })

  it('points its challenge at a document that answers, exactly as Figma’s does', async () => {
    const origin = 'https://cat.example'
    const url = resourceMetadataOf(bearerChallenge(origin))
    expect(url).toBe(`${origin}${PROTECTED_RESOURCE_METADATA_PATH}`)

    // The entry point has to survive one more hop than a client's first read: the document it names
    // must declare THIS resource and name an authorization server, or a host that followed the
    // header lands on a document about something else.
    const document = protectedResourceMetadata(origin) as {
      resource: string
      authorization_servers: string[]
    }
    expect(document.resource).toBe(mcpResourceIdentifier(origin))
    expect(document.authorization_servers).toEqual([origin])
  })

  it('advertises only what the authorization server actually serves', () => {
    const metadata = authorizationServerMetadata('https://cat.example') as Record<string, unknown>
    // Each of these is a promise a client acts on. `S256` is refused-if-absent rather than
    // preferred, `none` says the clients are public, and the ABSENCE of `refresh_token` is what
    // stops every client scheduling a renewal against an endpoint that would answer
    // `unsupported_grant_type`.
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(metadata.grant_types_supported).toEqual(['authorization_code'])
    // Registration is what lets a host nobody configured connect at all, so its absence would be
    // the whole feature quietly not working for the clients it exists for.
    expect(metadata.registration_endpoint).toBe('https://cat.example/oauth/register')
  })
})
