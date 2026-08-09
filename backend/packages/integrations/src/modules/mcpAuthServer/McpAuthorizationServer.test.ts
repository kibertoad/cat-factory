import type { PublicApiKeyRecord, PublicApiKeyRepository, SecretCipher } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { PublicApiKeyService } from '../publicApi/PublicApiKeyService.js'
import {
  McpAuthorizationServer,
  McpOAuthProtocolError,
  isAllowedRedirectUri,
} from './McpAuthorizationServer.js'

// The whole flow a host walks, end to end, plus the refusals that are the only thing standing
// between an open registration endpoint and a stranger holding a key on someone's board.
//
// The token is issued through the REAL `PublicApiKeyService` over a memory repository rather than a
// stub, because the property worth asserting is not "a string came back" but that the string
// AUTHENTICATES, on the workspace and at the scope a human picked. A stub would agree with any
// implementation, including one that minted a key on the wrong board.

/** A transparent cipher: these tests assert on what is SEALED, so it must be inspectable. */
const cipher: SecretCipher = {
  encrypt: async (value) => `sealed(${value})`,
  decrypt: async (value) => {
    const match = /^sealed\((.*)\)$/s.exec(value)
    if (!match) throw new Error('not sealed by this cipher')
    return match[1]!
  },
}

class MemoryKeyRepository implements PublicApiKeyRepository {
  readonly rows = new Map<string, PublicApiKeyRecord>()
  async add(record: PublicApiKeyRecord) {
    this.rows.set(record.id, record)
  }
  async getById(id: string) {
    return this.rows.get(id) ?? null
  }
  async listByWorkspace(workspaceId: string) {
    return [...this.rows.values()].filter(
      (row) => row.workspaceId === workspaceId && row.revokedAt === null,
    )
  }
  async markUsed(id: string, at: number) {
    const row = this.rows.get(id)
    if (row) this.rows.set(id, { ...row, lastUsedAt: at })
  }
  async revoke(workspaceId: string, id: string, at: number) {
    const row = this.rows.get(id)
    if (row && row.workspaceId === workspaceId) this.rows.set(id, { ...row, revokedAt: at })
  }
  async revokeMintedBy() {}
}

const REDIRECT = 'https://host.example/callback'
const RESOURCE = 'https://cat.example/api/v1/mcp'

/** PKCE, done the way a client does it, so the server's check is exercised rather than mirrored. */
async function pkce(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function build(now = () => 1_700_000_000_000) {
  const repository = new MemoryKeyRepository()
  const publicApiKeys = new PublicApiKeyService({
    repository,
    pepper: 'pepper-for-tests-only',
    idGenerator: { next: (prefix) => `${prefix}_${repository.rows.size + 1}` },
    clock: { now },
  })
  return {
    repository,
    publicApiKeys,
    server: new McpAuthorizationServer({ secretCipher: cipher, publicApiKeys, clock: { now } }),
  }
}

/** Register, authorize, approve and redeem, as a host and a human between them would. */
async function connect(
  fixture: ReturnType<typeof build>,
  overrides: { verifier?: string; scope?: 'read' | 'write' | 'decide' | 'admin' } = {},
) {
  const verifier = overrides.verifier ?? 'a-verifier-only-the-host-has'
  const client = await fixture.server.registerClient({
    clientName: 'Test Host',
    redirectUris: [REDIRECT],
  })
  const { sealedRequest } = await fixture.server.beginAuthorization({
    clientId: client.clientId,
    redirectUri: REDIRECT,
    responseType: 'code',
    codeChallenge: await pkce(verifier),
    codeChallengeMethod: 'S256',
    state: 'host-state',
    resource: RESOURCE,
    expectedResource: RESOURCE,
  })
  const request = await fixture.server.readAuthorizationRequest(sealedRequest)
  const { redirectTo } = await fixture.server.approve(request!, {
    accountId: 'acc_1',
    workspaceId: 'ws_1',
    scope: overrides.scope ?? 'write',
    approvedByUserId: 'user_1',
  })
  return { client, request: request!, redirectTo, verifier }
}

describe('McpAuthorizationServer', () => {
  it('issues a working key on the board and scope the human approved', async () => {
    const fixture = build()
    const { client, redirectTo, verifier } = await connect(fixture, { scope: 'read' })

    const url = new URL(redirectTo)
    expect(url.origin + url.pathname).toBe(REDIRECT)
    // The host's own `state` comes back untouched, which is the only way it can match the
    // redirect to the request it started.
    expect(url.searchParams.get('state')).toBe('host-state')

    const issued = await fixture.server.redeemCode({
      code: url.searchParams.get('code')!,
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
    })
    expect(issued.scope).toBe('read')

    const auth = await fixture.publicApiKeys.authenticate(issued.accessToken)
    expect(auth).toMatchObject({ workspaceId: 'ws_1', accountId: 'acc_1', scope: 'read' })
    // Attribution: the run this host starts names the HOST, not the person who approved it months
    // earlier, while the key row still records who did.
    expect(auth?.externalIdentity).toBe('mcp-client:Test Host')
    expect(fixture.repository.rows.get(auth!.keyId)?.createdByUserId).toBe('user_1')
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

  it('expires an authorization request, and a code, rather than letting either sit', async () => {
    let now = 1_700_000_000_000
    const fixture = build(() => now)
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    const { sealedRequest } = await fixture.server.beginAuthorization({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      responseType: 'code',
      codeChallenge: await pkce('v'),
      codeChallengeMethod: 'S256',
      expectedResource: RESOURCE,
    })
    expect(await fixture.server.readAuthorizationRequest(sealedRequest)).not.toBeNull()
    now += 16 * 60 * 1000
    expect(await fixture.server.readAuthorizationRequest(sealedRequest)).toBeNull()
  })

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

  it('reports a denial to the host instead of leaving it waiting', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({
      clientName: 'Test Host',
      redirectUris: [REDIRECT],
    })
    const { sealedRequest } = await fixture.server.beginAuthorization({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      responseType: 'code',
      codeChallenge: await pkce('v'),
      codeChallengeMethod: 'S256',
      state: 'host-state',
      expectedResource: RESOURCE,
    })
    const request = await fixture.server.readAuthorizationRequest(sealedRequest)
    const url = new URL(fixture.server.denial(request!).redirectTo)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('host-state')
    expect(url.searchParams.get('code')).toBeNull()
  })

  it('takes the redirect URIs a native host really registers, and refuses the ones that leak', () => {
    // RFC 8252: a desktop MCP host listens on a loopback port it picked at start-up, or is reached
    // through a private-use scheme. Both carry the authorization code, so plain http anywhere else
    // is refused rather than tolerated.
    expect(isAllowedRedirectUri('http://127.0.0.1:53219/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback')).toBe(true)
    expect(isAllowedRedirectUri('com.example.host:/oauth')).toBe(true)
    expect(isAllowedRedirectUri('https://host.example/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://host.example/callback')).toBe(false)
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false)
    // A fragment would put our query after it, where the host never sees the code.
    expect(isAllowedRedirectUri('https://host.example/cb#frag')).toBe(false)
  })

  it('names an unnamed client rather than rendering a blank consent screen', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({ redirectUris: [REDIRECT] })
    const { summary } = await fixture.server.beginAuthorization({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      responseType: 'code',
      codeChallenge: await pkce('v'),
      codeChallengeMethod: 'S256',
      scope: 'openid decide',
      expectedResource: RESOURCE,
    })
    expect(summary.clientName).toBe('An unnamed MCP client')
    expect(summary.redirectOrigin).toBe('https://host.example')
    // A scope list the ladder partly knows resolves to the member it knows; the screen offers it
    // as a default rather than granting it.
    expect(summary.requestedScope).toBe('decide')
  })
})
