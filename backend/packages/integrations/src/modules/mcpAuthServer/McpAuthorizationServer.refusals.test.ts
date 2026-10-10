import { describe, expect, it } from 'vitest'
import {
  McpOAuthProtocolError,
  McpOAuthRedirectableError,
  isAllowedRedirectUri,
  mcpOAuthErrorRedirect,
} from './McpAuthorizationServer.js'
import {
  REDIRECT,
  RESOURCE,
  build,
  cipher,
  connect,
  pkce,
} from './test-support/authorization-server.js'

// The REFUSALS, and the question the grant suite next door never asks: WHERE each one is delivered.
//
// That is the half with a security consequence in both directions. A refusal sent to an address
// this server has not matched against a registration is an open redirect on this deployment's own
// origin; a refusal withheld from an address it HAS matched leaves a conforming host waiting on a
// callback that never arrives, so what its user is told is that this deployment never answered.

describe('McpAuthorizationServer: refusals', () => {
  it('refuses a value sealed for something else, and one this deployment did not seal', async () => {
    const fixture = build()
    // The `kind` claim is what stops a value minted for one purpose being opened as another; one
    // cipher tag covers all three carried values, so nothing else would.
    const foreign = await cipher.encrypt(JSON.stringify({ kind: 'mcp-client', name: 'x' }))
    expect(await fixture.server.readAuthorizationRequest(foreign)).toBeNull()
    expect(await fixture.server.readAuthorizationRequest('v1.not.our.envelope')).toBeNull()
    await expect(
      fixture.server.beginAuthorization({
        clientId: 'made-up',
        redirectUri: REDIRECT,
        responseType: 'code',
        codeChallenge: await pkce('v'),
        codeChallengeMethod: 'S256',
        expectedResource: RESOURCE,
      }),
    ).rejects.toMatchObject({ oauthError: 'invalid_client' })
  })

  it('refuses a redirect_uri the client never registered', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    // The open-redirect case: a request that names somewhere else must not reach a consent screen,
    // because approving it would send the code there.
    await expect(
      fixture.server.beginAuthorization({
        clientId: client.clientId,
        redirectUri: 'https://attacker.example/collect',
        responseType: 'code',
        codeChallenge: await pkce('v'),
        codeChallengeMethod: 'S256',
        expectedResource: RESOURCE,
      }),
    ).rejects.toBeInstanceOf(McpOAuthProtocolError)
  })

  it('keeps a refusal it cannot attribute OFF the redirect, which is the open redirect', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    // The pair that must NOT become a redirect, in the same test as the pair that must: an
    // unregistered address and an unknown client are exactly the cases where bouncing the error
    // back would turn this deployment's origin into a forwarder to anywhere an attacker names.
    for (const input of [
      { clientId: client.clientId, redirectUri: 'https://attacker.example/collect' },
      { clientId: 'made-up', redirectUri: REDIRECT },
    ]) {
      const error = await fixture.server
        .beginAuthorization({
          ...input,
          responseType: 'code',
          codeChallenge: await pkce('v'),
          codeChallengeMethod: 'S256',
          expectedResource: RESOURCE,
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(McpOAuthProtocolError)
      expect(error).not.toBeInstanceOf(McpOAuthRedirectableError)
    }
  })

  it('reports a fault in the request to the CLIENT once the redirect URI is registered', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    // RFC 6749 §4.1.2.1. The redirect URI matched a registration, so this refusal has an address
    // the client itself named: rendered as a page instead, a conforming host waits out its timeout
    // and reports that this deployment never answered.
    const error = await fixture.server
      .beginAuthorization({
        clientId: client.clientId,
        redirectUri: REDIRECT,
        responseType: 'token',
        codeChallenge: await pkce('v'),
        codeChallengeMethod: 'S256',
        state: 'host-state',
        expectedResource: RESOURCE,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(McpOAuthRedirectableError)

    const url = new URL(mcpOAuthErrorRedirect(error as McpOAuthRedirectableError))
    expect(url.origin + url.pathname).toBe(REDIRECT)
    expect(url.searchParams.get('error')).toBe('unsupported_response_type')
    expect(url.searchParams.get('state')).toBe('host-state')
    expect(url.searchParams.get('code')).toBeNull()
  })

  it('requires PKCE with S256, and refuses a resource that is not this deployment', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    const base = {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      responseType: 'code' as const,
      expectedResource: RESOURCE,
    }
    await expect(
      fixture.server.beginAuthorization({
        ...base,
        codeChallenge: 'plain-challenge',
        codeChallengeMethod: 'plain',
      }),
    ).rejects.toMatchObject({ oauthError: 'invalid_request' })
    // RFC 8707: a token minted for someone else's resource is a token this deployment vouched for
    // against a surface it does not serve.
    await expect(
      fixture.server.beginAuthorization({
        ...base,
        codeChallenge: await pkce('v'),
        codeChallengeMethod: 'S256',
        resource: 'https://elsewhere.example/mcp',
      }),
    ).rejects.toMatchObject({ oauthError: 'invalid_request' })
    // A trailing slash is the one difference two conforming implementations routinely disagree
    // about, and refusing over it would be failing a host for being right.
    await expect(
      fixture.server.beginAuthorization({
        ...base,
        codeChallenge: await pkce('v'),
        codeChallengeMethod: 'S256',
        resource: `${RESOURCE}/`,
      }),
    ).resolves.toBeDefined()
  })

  it('refuses a code redeemed without the verifier that started the flow', async () => {
    const fixture = build()
    const { client, redirectTo } = await connect(fixture)
    const code = new URL(redirectTo).searchParams.get('code')!

    // The whole defence for a code that leaked through a browser history or a proxy log: whoever
    // captured it cannot have the verifier, which never left the host.
    await expect(
      fixture.server.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeVerifier: 'not-the-verifier',
      }),
    ).rejects.toMatchObject({ oauthError: 'invalid_grant' })
    expect(fixture.repository.rows.size).toBe(0)
  })

  it('refuses a code presented by a different client than the one it was issued to', async () => {
    const fixture = build()
    const { redirectTo, verifier } = await connect(fixture)
    const other = await fixture.server.registerClient({
      clientName: 'Someone else',
      redirectUris: [REDIRECT],
    })
    await expect(
      fixture.server.redeemCode({
        code: new URL(redirectTo).searchParams.get('code')!,
        clientId: other.clientId,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
      }),
    ).rejects.toMatchObject({ oauthError: 'invalid_grant' })
  })

  it('answers a full board in the protocol vocabulary, not the deployment envelope', async () => {
    const fixture = build()
    // Fill the board to the per-workspace key cap through the real service, so what refuses is the
    // rule the platform actually enforces rather than a stub agreeing with this test.
    for (let i = 0; i < 50; i++) {
      await fixture.publicApiKeys.issue(
        { accountId: 'acc_1', workspaceId: 'ws_1', createdByUserId: null },
        `filler-${i}`,
        'read',
      )
    }
    const { client, redirectTo, verifier } = await connect(fixture)

    // The worst moment in the flow to answer in a shape nobody parses: the human already approved
    // and the browser has already gone back to the host, so this is a machine-to-machine call and
    // `error_description` is the only thing left that reaches a person.
    const error = await fixture.server
      .redeemCode({
        code: new URL(redirectTo).searchParams.get('code')!,
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(McpOAuthProtocolError)
    expect(error).toMatchObject({ oauthError: 'access_denied' })
    expect((error as Error).message).toMatch(/revoke one/i)
  })

  it('takes the redirect URIs a native host really registers, and refuses the ones that leak', () => {
    // RFC 8252: a desktop MCP host listens on a loopback port it picked at start-up, or is reached
    // through a private-use scheme. Both carry the authorization code, so plain http anywhere else
    // is refused rather than tolerated.
    expect(isAllowedRedirectUri('http://127.0.0.1:53219/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('com.example.host:/oauth')).toBe(true)
    expect(isAllowedRedirectUri('https://host.example/callback')).toBe(true)
    // The IDE hosts this feature exists for register an undotted scheme, so the rule cannot be
    // "reverse-DNS or nothing" however tidy that would read.
    expect(isAllowedRedirectUri('vscode://cat-factory/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://host.example/callback')).toBe(false)
    // A fragment would put our query after it, where the host never sees the code.
    expect(isAllowedRedirectUri('https://host.example/cb#frag')).toBe(false)
  })

  it('refuses every scheme the BROWSER interprets, not just the one anyone remembers', () => {
    // This URL is navigated to from the consent screen with a code appended, so a scheme the
    // browser resolves in the current document runs there rather than dispatching to an app.
    // Naming `javascript:` alone reads as a fix and admits each of its siblings, which is why the
    // rule is about what a scheme MEANS: a private-use scheme is by definition not a standard one.
    for (const uri of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'blob:https://host.example/2f8a',
      'file:///etc/passwd',
      'about:blank',
      'ftp://host.example/cb',
      'ws://host.example/cb',
    ]) {
      expect(isAllowedRedirectUri(uri)).toBe(false)
    }
  })
})
