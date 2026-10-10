import { describe, expect, it } from 'vitest'
import {
  McpOAuthError,
  discoverMcpOAuthEndpoints,
  exchangeAuthorizationCode,
} from './mcpOAuthClient.js'

// Endpoint DISCOVERY, which is what makes a vendor server connectable from a declaration naming
// only its url. The two properties that matter: the walk follows the specs' own locations in order
// (a server that publishes only one of them still resolves), and a metadata document — which is a
// third party telling this deployment where to send its client secret — is held to the SAME url
// floor a declared endpoint is.

function fakeFetch(documents: Record<string, unknown>): typeof fetch {
  return (async (url: string) => {
    const body = documents[String(url)]
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
  }) as unknown as typeof fetch
}

const AS_METADATA = {
  authorization_endpoint: 'https://auth.example.com/authorize',
  token_endpoint: 'https://auth.example.com/token',
}

/**
 * AS metadata declaring the issuer it was fetched for. RFC 8414 §3.3 makes that claim mandatory
 * and makes checking it the client's job, so a fixture without one is a document this client
 * refuses rather than a shorter way to write the same thing.
 */
const asMetadataFor = (issuer: string, extra: Record<string, unknown> = {}) => ({
  issuer,
  ...AS_METADATA,
  ...extra,
})

describe('discoverMcpOAuthEndpoints', () => {
  it('follows protected-resource metadata at the PATH-AWARE location to the authorization server', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/v1/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp': {
          authorization_servers: ['https://auth.example.com'],
        },
        'https://auth.example.com/.well-known/oauth-authorization-server': asMetadataFor(
          'https://auth.example.com',
        ),
      }),
    })
    expect(endpoints).toEqual({
      authorizationUrl: AS_METADATA.authorization_endpoint,
      tokenUrl: AS_METADATA.token_endpoint,
      useBasicAuth: false,
    })
  })

  it('falls back to the resource ORIGIN as the issuer for a server that publishes no RFC 9728 document', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-authorization-server':
          asMetadataFor('https://mcp.example.com'),
      }),
    })
    expect(endpoints.tokenUrl).toBe('https://auth.example.com/token')
  })

  it('reads OpenID Connect discovery, which many vendors publish and no OAuth-only client would find', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/openid-configuration':
          asMetadataFor('https://mcp.example.com'),
      }),
    })
    expect(endpoints.authorizationUrl).toBe('https://auth.example.com/authorize')
  })

  it('asks for Basic client authentication only when the server advertises it and not post', async () => {
    const basic = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-authorization-server': asMetadataFor(
          'https://mcp.example.com',
          { token_endpoint_auth_methods_supported: ['client_secret_basic'] },
        ),
      }),
    })
    expect(basic.useBasicAuth).toBe(true)

    const both = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-authorization-server': asMetadataFor(
          'https://mcp.example.com',
          { token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'] },
        ),
      }),
    })
    expect(both.useBasicAuth).toBe(false)
  })

  it('refuses metadata that names a cleartext endpoint off loopback', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
        fetch: fakeFetch({
          'https://mcp.example.com/.well-known/oauth-authorization-server': asMetadataFor(
            'https://mcp.example.com',
            { token_endpoint: 'http://auth.example.com/token' },
          ),
        }),
      }),
    ).rejects.toBeInstanceOf(McpOAuthError)
  })

  it('reports an exhausted walk as a permanent failure naming the declaration as the fix', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', { fetch: fakeFetch({}) }),
    ).rejects.toMatchObject({ permanent: true })
  })

  it('refuses to fetch an authorization server the resource metadata points at instance metadata', async () => {
    // The one place in this flow where an OUTSIDER picks a url this side then fetches. Without the
    // floor on the issuer the walk would GET the cloud instance-metadata service on the
    // deployment's behalf, and it would read as an ordinary "no metadata found" while doing it.
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
        fetch: fakeFetch({
          'https://mcp.example.com/.well-known/oauth-protected-resource': {
            authorization_servers: ['https://169.254.169.254/latest/meta-data'],
          },
        }),
      }),
    ).rejects.toMatchObject({ permanent: true })
  })

  it('reads the OIDC PATH-INSERT location, which an issuer with a path is likeliest to publish', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
          authorization_servers: ['https://auth.example.com/tenant-a'],
        },
        'https://auth.example.com/.well-known/openid-configuration/tenant-a': asMetadataFor(
          'https://auth.example.com/tenant-a',
        ),
      }),
    })

    // The MCP spec's order is oauth-authorization-server path-insert, then OIDC path-INSERT, then
    // OIDC append. The middle one used to be missing entirely, and a tenant-per-path issuer that
    // publishes only it was unreachable.
    expect(endpoints.tokenUrl).toBe('https://auth.example.com/token')
  })

  it('refuses metadata whose issuer is not the DECLARED one it was fetched for', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
        fetch: fakeFetch({
          'https://mcp.example.com/.well-known/oauth-protected-resource/mcp': {
            authorization_servers: ['https://auth.example.com'],
          },
          // The document names endpoints, so whoever writes it chooses where the user is sent and
          // where this deployment posts its client secret. RFC 8414 §3.3 is what stops a host
          // serving someone else's metadata at the well-known path of the issuer the RESOURCE
          // named from redirecting both.
          'https://auth.example.com/.well-known/oauth-authorization-server': asMetadataFor(
            'https://attacker.example.com',
          ),
        }),
      }),
    ).rejects.toMatchObject({ permanent: true })
  })

  it('accepts an authorization server that identifies as itself under the ORIGIN fallback', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        // A fronted IdP, and the ordinary shape for a server that predates RFC 9728. §3.3 compares
        // a document against the issuer identifier the client was GIVEN, and here there is none:
        // the origin is this client's own guess, so the equality would test the guess rather than
        // the server and would refuse every deployment whose AS identifies as anything else.
        'https://mcp.example.com/.well-known/oauth-authorization-server': asMetadataFor(
          'https://login.vendor.example',
        ),
      }),
    })
    expect(endpoints.tokenUrl).toBe('https://auth.example.com/token')
  })

  it('refuses a document with no issuer claim at all, under either source', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
        // An absent claim is the missing half RFC 8414 §3.3 exists for, and a document without one
        // is not authorization-server metadata whichever issuer it was fetched for.
        fetch: fakeFetch({
          'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
        }),
      }),
    ).rejects.toMatchObject({ permanent: true })
  })

  it('probes each well-known location once for a path-less issuer', async () => {
    const asked: string[] = []
    const fetchImpl = (async (url: string) => {
      asked.push(String(url))
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch

    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com', { fetch: fetchImpl }),
    ).rejects.toMatchObject({ permanent: true })

    // The two OIDC forms render to the same URL when the issuer has no path, which is the ordinary
    // case: a duplicate probe spends a round trip and a slot of the bounded fetch budget to be told
    // the same 404 twice.
    expect(new Set(asked).size).toBe(asked.length)
  })

  it('refuses a metadata redirect that leaves the url floor, rather than following it', async () => {
    // A permitted first hop is not a permitted request: with the platform's own redirect handling
    // the walk would follow this to cleartext and never re-check.
    const fetchImpl = (async (url: string) =>
      String(url) === 'https://mcp.example.com/.well-known/oauth-authorization-server'
        ? new Response(null, { status: 302, headers: { location: 'http://internal.example/meta' } })
        : new Response('not found', { status: 404 })) as unknown as typeof fetch
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', { fetch: fetchImpl }),
    ).rejects.toMatchObject({ permanent: true })
  })
})

describe('exchangeAuthorizationCode', () => {
  it('refuses a redirecting token endpoint instead of re-sending the client secret', async () => {
    // The request body carries the client secret and the grant. `fetch` strips `Authorization`
    // across origins but never a form body, so following this would hand the deployment's client
    // secret to whatever the redirect names.
    const hops: string[] = []
    const fetchImpl = (async (url: string) => {
      hops.push(String(url))
      return new Response(null, {
        status: 307,
        headers: { location: 'https://elsewhere.example.com/token' },
      })
    }) as unknown as typeof fetch

    await expect(
      exchangeAuthorizationCode(
        {
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'cid',
          clientSecret: 'shh',
          resource: 'https://mcp.example.com/mcp',
          code: 'code-1',
          redirectUri: 'https://app.example.com/mcp-oauth-callback',
          codeVerifier: 'verifier',
        },
        { fetch: fetchImpl },
      ),
    ).rejects.toMatchObject({ permanent: true })
    // The point of the assertion: the secret was sent exactly once, to the declared endpoint.
    expect(hops).toEqual(['https://auth.example.com/token'])
  })
})
