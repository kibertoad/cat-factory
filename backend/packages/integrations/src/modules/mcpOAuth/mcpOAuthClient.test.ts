import { describe, expect, it } from 'vitest'
import { McpOAuthError, discoverMcpOAuthEndpoints } from './mcpOAuthClient.js'

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

describe('discoverMcpOAuthEndpoints', () => {
  it('follows protected-resource metadata at the PATH-AWARE location to the authorization server', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/v1/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-protected-resource/v1/mcp': {
          authorization_servers: ['https://auth.example.com'],
        },
        'https://auth.example.com/.well-known/oauth-authorization-server': AS_METADATA,
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
        'https://mcp.example.com/.well-known/oauth-authorization-server': AS_METADATA,
      }),
    })
    expect(endpoints.tokenUrl).toBe('https://auth.example.com/token')
  })

  it('reads OpenID Connect discovery, which many vendors publish and no OAuth-only client would find', async () => {
    const endpoints = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/openid-configuration': AS_METADATA,
      }),
    })
    expect(endpoints.authorizationUrl).toBe('https://auth.example.com/authorize')
  })

  it('asks for Basic client authentication only when the server advertises it and not post', async () => {
    const basic = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-authorization-server': {
          ...AS_METADATA,
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        },
      }),
    })
    expect(basic.useBasicAuth).toBe(true)

    const both = await discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
      fetch: fakeFetch({
        'https://mcp.example.com/.well-known/oauth-authorization-server': {
          ...AS_METADATA,
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        },
      }),
    })
    expect(both.useBasicAuth).toBe(false)
  })

  it('refuses metadata that names a cleartext endpoint off loopback', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', {
        fetch: fakeFetch({
          'https://mcp.example.com/.well-known/oauth-authorization-server': {
            ...AS_METADATA,
            token_endpoint: 'http://auth.example.com/token',
          },
        }),
      }),
    ).rejects.toBeInstanceOf(McpOAuthError)
  })

  it('reports an exhausted walk as a permanent failure naming the declaration as the fix', async () => {
    await expect(
      discoverMcpOAuthEndpoints('https://mcp.example.com/mcp', { fetch: fakeFetch({}) }),
    ).rejects.toMatchObject({ permanent: true })
  })
})
