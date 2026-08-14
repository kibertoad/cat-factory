import { describe, expect, it } from 'vitest'
import { REDIRECT, RESOURCE, build, connect, pkce } from './test-support/authorization-server.js'

// The GRANT: what a host walks, and what it walks away with.
//
// The refusals that stand between an open registration endpoint and a stranger holding a key on
// someone's board are the sibling suite (`McpAuthorizationServer.refusals.test.ts`); the two split
// because they ask opposite questions of one machine, and both are long enough that reading either
// meant scrolling past the other.

describe('McpAuthorizationServer: the grant', () => {
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
    // A scope list the ladder partly knows resolves to the member it knows. It is REPORTED, so the
    // screen can say what was asked, and it is not what the screen preselects: `decide` is above
    // the platform default, and a registration nobody authenticated must not move the radio button
    // on a screen whose whole subject is the grant.
    expect(summary.requestedScope).toBe('decide')
    expect(summary.defaultScope).toBe('write')
  })

  it('honours a host asking for LESS, and refuses to preselect one asking for more', async () => {
    const fixture = build()
    const client = await fixture.server.registerClient({ redirectUris: [REDIRECT] })
    const begin = async (scope: string) =>
      (
        await fixture.server.beginAuthorization({
          clientId: client.clientId,
          redirectUri: REDIRECT,
          responseType: 'code',
          codeChallenge: await pkce('v'),
          codeChallengeMethod: 'S256',
          scope,
          expectedResource: RESOURCE,
        })
      ).summary

    // Downward the ask is honoured outright: nothing is protected by talking a person into
    // granting less than the default, so a read-only host gets a read-only screen.
    expect(await begin('read')).toMatchObject({ defaultScope: 'read', requestedScope: 'read' })
    // Upward it is not. `admin` is the rung that deletes tasks and merges pull requests, and the
    // party asking for it is one that registered itself a moment ago.
    expect(await begin('admin')).toMatchObject({ defaultScope: 'write', requestedScope: 'admin' })
  })

  it('strips the line separators the key store refuses, not only the control characters', async () => {
    const fixture = build()
    // A registered name is spliced into `externalIdentity`, which normally arrives over the wire,
    // where `publicApiExternalIdentitySchema` refuses U+2028 and U+2029 by name. This path calls
    // `issue` directly, so `normaliseClientName` is the only thing standing where that schema
    // stands, and what it lets through is echoed on the key resource, on run projections and on
    // `GET /api/v1/me`. Both are LINE BREAKS to every renderer that matters, so one in a name a
    // stranger chose breaks a row on whichever surface shows it next.
    const client = await fixture.server.registerClient({
      clientName: 'Real Host\u2028admin: true\u2029',
      redirectUris: [REDIRECT],
    })
    expect(client.clientName).not.toMatch(/[\u2028\u2029\p{Cc}\p{Cf}]/u)

    const { sealedRequest } = await fixture.server.beginAuthorization({
      clientId: client.clientId,
      redirectUri: REDIRECT,
      responseType: 'code',
      codeChallenge: await pkce('v'),
      codeChallengeMethod: 'S256',
      expectedResource: RESOURCE,
    })
    const request = await fixture.server.readAuthorizationRequest(sealedRequest)
    const { redirectTo } = await fixture.server.approve(request!, {
      accountId: 'acc_1',
      workspaceId: 'ws_1',
      scope: 'read',
      approvedByUserId: null,
    })
    const issued = await fixture.server.redeemCode({
      code: new URL(redirectTo).searchParams.get('code')!,
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeVerifier: 'v',
    })

    // Asserted where the value LANDS, not only where it was cleaned: the name reaches the key row
    // through two hops, and a check on the registration alone passes an implementation that
    // re-derives the identity from the sealed code instead.
    const row = fixture.repository.rows.get(issued.keyId)!
    expect(row.externalIdentity).not.toMatch(/[\u2028\u2029\p{Cc}\p{Cf}]/u)
    expect(row.label).not.toMatch(/[\u2028\u2029\p{Cc}\p{Cf}]/u)
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

  it('expires a CODE on its own much shorter clock, which is the whole of its replay defence', async () => {
    // The code's TTL is the half this test used to name and never reach: with no row there is no
    // single-use enforcement, so the minute is what bounds a captured code, and a check nothing
    // exercises is a check that can be deleted without a failure.
    let now = 1_700_000_000_000
    const fixture = build(() => now)
    const { client, redirectTo, verifier } = await connect(fixture)
    const code = new URL(redirectTo).searchParams.get('code')!
    const redeem = () =>
      fixture.server.redeemCode({
        code,
        clientId: client.clientId,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
      })

    // Still inside the window: the request TTL is fifteen minutes, so a code that outlived only
    // that one would pass here and every assertion below.
    now += 59 * 1000
    await expect(redeem()).resolves.toBeDefined()

    now += 2 * 1000
    await expect(redeem()).rejects.toMatchObject({ oauthError: 'invalid_grant' })
    // One key, from the redemption that landed: the expired attempt minted nothing.
    expect(fixture.repository.rows.size).toBe(1)
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
})
