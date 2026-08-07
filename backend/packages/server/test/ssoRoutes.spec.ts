import { Hono } from 'hono'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { CryptoKey } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { authController } from '../src/modules/auth/AuthController.js'
import { handleError } from '../src/http/errorHandler.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'
import type { SessionPayload } from '../src/auth/signing.js'
import type { SsoConfig } from '../src/config/types.js'

// The whole enterprise-SSO round-trip against a FAKE identity provider with a real key pair and
// real signed ID tokens — the only level at which the pieces that matter can be asserted together:
// the PKCE verifier never leaving the httpOnly cookie, the nonce binding, the algorithm
// allow-list, and each refusal landing the browser back on the SPA with its own reason.
//
// The forged-`HS256` case is the one to keep: it is the classic JWT hole, and the only thing
// standing between it and a signed-in attacker is the asymmetric-only allow-list in `OidcClient`.

const SECRET = 's'.repeat(32)
const ISSUER = 'https://acme.okta.com/oauth2/default'
const CLIENT_ID = 'cat-factory-client'
const CLIENT_SECRET = 'client-secret-value'
const ORIGIN = 'http://localhost'
const KID = 'test-key-1'

let signingKey: CryptoKey
let jwks: { keys: Record<string, unknown>[] }
/** A second key the provider does NOT publish, for the wrong-signer case. */
let foreignKey: CryptoKey

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  signingKey = pair.privateKey
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] }
  foreignKey = (await generateKeyPair('RS256', { extractable: true })).privateKey
})

function ssoConfig(overrides: Partial<SsoConfig> = {}): SsoConfig {
  return {
    issuerUrl: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    label: 'Acme SSO',
    scopes: 'openid profile email',
    redirectUrl: '',
    allowedEmailDomains: [],
    groupsClaim: 'groups',
    requiredGroups: [],
    ...overrides,
  }
}

interface IdpOptions {
  /** Claims to overlay on the ID token (or `null` to omit the token entirely). */
  claims?: Record<string, unknown>
  /** Sign with a key the published JWKS does not contain. */
  wrongSigner?: boolean
  /**
   * Sign with the REAL key but announce a `kid` the published key set does not hold — the shape a
   * provider mid-key-rotation produces, where only the key LOOKUP fails.
   */
  unpublishedKid?: boolean
  /**
   * Stop serving the discovery document after this many successful reads, so the callback leg
   * meets an IdP that went away mid-round-trip (the login leg reads it once).
   */
  discoveryFailsAfter?: number
  /** Forge an HS256 token using the deployment's own client secret as the HMAC key. */
  forgeSymmetric?: boolean
  /** Fail the token exchange with the provider's own error body. */
  tokenError?: { status: number; body: Record<string, unknown> }
  userinfo?: Record<string, unknown>
}

/**
 * A fake IdP over `fetch`. The login leg reads discovery + JWKS; the callback leg posts to the
 * token endpoint and may read userinfo. Records the token-endpoint form so a test can assert what
 * was actually sent (the PKCE verifier, the client authentication).
 */
function fakeIdp(opts: IdpOptions = {}) {
  const tokenRequests: URLSearchParams[] = []
  let discoveryReads = 0
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })

    if (url.endsWith('/.well-known/openid-configuration')) {
      discoveryReads += 1
      if (opts.discoveryFailsAfter !== undefined && discoveryReads > opts.discoveryFailsAfter) {
        return new Response('gateway timeout', { status: 504 })
      }
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/v1/authorize`,
        token_endpoint: `${ISSUER}/v1/token`,
        jwks_uri: `${ISSUER}/v1/keys`,
        userinfo_endpoint: `${ISSUER}/v1/userinfo`,
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.endsWith('/v1/keys')) return json(jwks)
    if (url.endsWith('/v1/userinfo')) return json(opts.userinfo ?? {})
    if (url.endsWith('/v1/token')) {
      const form = new URLSearchParams(String(init?.body))
      tokenRequests.push(form)
      if (opts.tokenError) return json(opts.tokenError.body, opts.tokenError.status)
      return json({ access_token: 'idp-access-token', id_token: await mintIdToken(form, opts) })
    }
    return new Response('not found', { status: 404 })
  }
  return { fetchImpl: impl as unknown as typeof fetch, tokenRequests }
}

/** Sign an ID token echoing the nonce the authorize request carried, as a real provider does. */
async function mintIdToken(form: URLSearchParams, opts: IdpOptions): Promise<string> {
  const claims = {
    sub: 'okta-user-1',
    email: 'ada@acme.com',
    email_verified: true,
    name: 'Ada Lovelace',
    nonce: nonceForCode(form.get('code') ?? ''),
    ...opts.claims,
  }
  const jwt = new SignJWT(claims).setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m')
  // Only default the audience when the case under test has not overridden it — `setAudience`
  // would otherwise silently overwrite a deliberately-wrong `aud`.
  if (!('aud' in claims)) jwt.setAudience(CLIENT_ID)
  if (opts.forgeSymmetric) {
    // The attack: an attacker who knows the client secret (a leaked config, a shared secret) signs
    // their own token with it. Only the asymmetric-only allow-list refuses this.
    return jwt.setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(CLIENT_SECRET))
  }
  return jwt
    .setProtectedHeader({ alg: 'RS256', kid: opts.unpublishedKid ? 'rotated-key-2' : KID })
    .sign(opts.wrongSigner ? foreignKey : signingKey)
}

/**
 * The IdP echoes back the `nonce` from the authorize request. The fake has no session, so the
 * driver stashes the nonce under the code it hands out and this reads it back.
 */
const noncesByCode = new Map<string, string>()
function nonceForCode(code: string): string | undefined {
  return noncesByCode.get(code)
}

interface HarnessOptions extends IdpOptions {
  sso?: SsoConfig | null
  /** The user id an existing `oidc` identity resolves to; absent ⇒ nobody has signed in with it. */
  knownUserId?: string
  /** Make the revocation throw, to prove a correct refusal still lands. */
  revokeFails?: boolean
}

function harness(opts: HarnessOptions = {}) {
  const idp = fakeIdp(opts)
  const created: { provider: string; subject: string; profile: unknown }[] = []
  // What the OFFBOARDING path did: which identity it looked up, and whose sessions it ended.
  const lookedUp: { provider: string; subject: string }[] = []
  const revoked: string[] = []
  const container = {
    config: {
      auth: {
        enabled: true,
        devOpen: false,
        testingNoAuth: false,
        githubEnabled: false,
        passwordEnabled: false,
        clientId: '',
        clientSecret: '',
        sessionSecret: SECRET,
        apiBase: '',
        oauthBase: '',
        sessionTtlMs: 3_600_000,
        machineTokenTtlMs: 3_600_000,
        successRedirectUrl: '',
        callbackUrl: '',
        allowedLogins: [],
        allowedOrgs: [],
        allowedRedirectOrigins: [],
        openSignup: false,
        allowedEmailDomains: [],
        trustProxyHeaders: false,
        trustedProxyHops: 1,
        ...(opts.sso === null ? {} : { sso: opts.sso ?? ssoConfig() }),
      },
    },
    userService: {
      // The session mint reads the user's generation, and an admission REFUSAL revokes the
      // sessions of a user it can still find (the offboarding half of the SSO story).
      sessionGeneration: async () => 0,
      findByIdentity: async (provider: string, subject: string) => {
        lookedUp.push({ provider, subject })
        return opts.knownUserId ? { id: opts.knownUserId } : null
      },
      revokeSessions: async (userId: string) => {
        if (opts.revokeFails) throw new Error('audit store down')
        revoked.push(userId)
        return 1
      },
      findOrCreateByIdentity: async (provider: string, subject: string, profile: unknown) => {
        created.push({ provider, subject, profile })
        return {
          id: 'usr_1',
          name: 'Ada Lovelace',
          email: 'ada@acme.com',
          avatarUrl: null,
          createdAt: 0,
        }
      },
    },
    accountService: { ensurePersonalAccount: async () => {} },
  } as unknown as ServerContainer

  const app = new Hono<AppEnv>()
  app.onError(handleError)
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/auth', authController())

  return { app, container, created, idp, lookedUp, revoked }
}

/** The `cf_sso_state` cookie a login response set, in `name=value` form for the callback. */
function stateCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie')
  const match = raw ? /cf_sso_state=([^;]*)/.exec(raw) : null
  return match ? `cf_sso_state=${match[1]}` : null
}

/** The fragment key/value a redirect landed on (`token` or `sso_error`). */
function fragment(res: Response): Record<string, string> {
  const location = res.headers.get('location') ?? ''
  const hash = location.includes('#') ? location.slice(location.indexOf('#') + 1) : ''
  return Object.fromEntries(new URLSearchParams(hash).entries())
}

/**
 * Run the login leg, then the callback, wiring the state cookie through as a browser would and
 * teaching the fake IdP which nonce belongs to the code it is about to be handed.
 */
async function roundTrip(
  h: ReturnType<typeof harness>,
  callback: { code?: string; state?: string; error?: string } = {},
) {
  // The routes build their own client, so the fake IdP is installed as the global fetch for the
  // duration — the same seam the Worker and Node facades both run on.
  const realFetch = globalThis.fetch
  globalThis.fetch = h.idp.fetchImpl
  try {
    const login = await h.app.request(`${ORIGIN}/auth/sso/login`)
    const authorize = new URL(login.headers.get('location') ?? 'http://invalid')
    const cookie = stateCookie(login)
    const code = 'auth-code-1'
    noncesByCode.set(code, authorize.searchParams.get('nonce') ?? '')
    const query = new URLSearchParams()
    if (callback.error) query.set('error', callback.error)
    else query.set('code', callback.code ?? code)
    query.set('state', callback.state ?? authorize.searchParams.get('state') ?? '')
    const res = await h.app.request(`${ORIGIN}/auth/sso/callback?${query}`, {
      headers: cookie ? { cookie } : {},
    })
    return { login, authorize, res, cookie }
  } finally {
    globalThis.fetch = realFetch
  }
}

describe('GET /auth/sso/login', () => {
  it('redirects to the DISCOVERED authorize endpoint with PKCE S256', async () => {
    const { authorize } = await roundTrip(harness())
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/v1/authorize`)
    expect(authorize.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('scope')).toBe('openid profile email')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/auth/sso/callback`)
  })

  it('keeps the PKCE verifier OUT of the URL, in an httpOnly cookie', async () => {
    // The reason this flow uses a cookie rather than the OAuth legs' signed URL state: a verifier
    // visible beside the code it protects protects nothing.
    const { login, authorize } = await roundTrip(harness())
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    expect(authorize.searchParams.get('code_verifier')).toBeNull()
    expect(authorize.toString()).not.toContain('cf_sso_state')
  })

  it('503s with a machine-readable reason when SSO is not configured', async () => {
    const h = harness({ sso: null })
    const res = await h.app.request(`${ORIGIN}/auth/sso/login`)
    expect(res.status).toBe(503)
    expect((await res.json()).error.details.reason).toBe('sso_not_configured')
  })
})

describe('GET /auth/sso/callback', () => {
  it('mints a session and lands the browser on the SPA with the token in the fragment', async () => {
    const h = harness()
    const { res } = await roundTrip(h)
    expect(res.status).toBe(302)
    const token = fragment(res).token
    expect(token).toBeTruthy()
    const session = await new HmacSigner(SECRET).verify<SessionPayload>(token!, {
      aud: TOKEN_AUDIENCE.session,
    })
    expect(session).toMatchObject({ id: 'usr_1', login: 'ada@acme.com' })
  })

  it('keys the identity on `<issuer>#<sub>`, never the email', async () => {
    // An OIDC `sub` is unique per issuer only, and emails are reassigned inside orgs — keying on
    // either alone hands one person another's account.
    const h = harness()
    await roundTrip(h)
    expect(h.created).toEqual([
      expect.objectContaining({ provider: 'oidc', subject: `${ISSUER}#okta-user-1` }),
    ])
  })

  it('sends the PKCE verifier and authenticates as a confidential client', async () => {
    const h = harness()
    await roundTrip(h)
    const form = h.idp.tokenRequests[0]!
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code_verifier')).toBeTruthy()
    expect(form.get('client_secret')).toBe(CLIENT_SECRET)
    expect(form.get('redirect_uri')).toBe(`${ORIGIN}/auth/sso/callback`)
  })

  it('refuses a mismatched state as `state_invalid`', async () => {
    const { res } = await roundTrip(harness(), { state: 'not-the-nonce' })
    expect(fragment(res).sso_error).toBe('state_invalid')
  })

  it('refuses a callback with no round-trip cookie', async () => {
    const h = harness()
    const res = await h.app.request(`${ORIGIN}/auth/sso/callback?code=x&state=y`)
    expect(fragment(res).sso_error).toBe('state_invalid')
  })

  it("reports the provider's OWN refusal as `provider_denied`", async () => {
    // Not a token failure: there is nothing on this side to fix, and calling it one would send an
    // operator hunting a misconfiguration they do not have.
    const { res } = await roundTrip(harness(), { error: 'access_denied' })
    expect(fragment(res).sso_error).toBe('provider_denied')
  })

  it('reports a failed code exchange as `exchange_failed`', async () => {
    const { res } = await roundTrip(
      harness({ tokenError: { status: 401, body: { error: 'invalid_client' } } }),
    )
    expect(fragment(res).sso_error).toBe('exchange_failed')
  })

  it("refuses an ID token whose nonce is not this attempt's", async () => {
    const { res } = await roundTrip(harness({ claims: { nonce: 'someone-elses-nonce' } }))
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('refuses an ID token signed by a key the provider does not publish', async () => {
    const { res } = await roundTrip(harness({ wrongSigner: true }))
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('refuses an ID token whose `kid` the provider does not publish, as a REDIRECT', async () => {
    // The key-rotation shape: the signature is genuine, only the key lookup fails. It must land the
    // browser back on the SPA with a reason like every other refusal — this used to let jose's own
    // `ERR_JWKS_NO_MATCHING_KEY` escape the `OidcFlowError` catch, which rendered a 500 JSON
    // envelope at a browser mid-redirect, with no way back and nothing the user could act on.
    const { res } = await roundTrip(harness({ unpublishedKid: true }))
    expect(res.status).toBe(302)
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('reports an IdP that stops answering mid-round-trip as `provider_unreachable`', async () => {
    // An OUTAGE, not a bad token and not this deployment's credentials, so it is neither
    // `token_invalid` nor `exchange_failed` — and it REDIRECTS, because the browser is mid-flow.
    const { res } = await roundTrip(harness({ discoveryFailsAfter: 1 }))
    expect(res.status).toBe(302)
    expect(fragment(res).sso_error).toBe('provider_unreachable')
  })

  it('ignores a userinfo response describing a DIFFERENT subject', async () => {
    // OIDC Core 5.3.2. The contrast with the admitting case below is the whole point: identical
    // groups, and the only difference is whose response they came in. Honouring it would satisfy a
    // group gate with somebody else's directory membership.
    const { res } = await roundTrip(
      harness({
        sso: ssoConfig({ requiredGroups: ['engineering'] }),
        userinfo: { sub: 'somebody-else', groups: ['Engineering'] },
      }),
    )
    expect(fragment(res).sso_error).toBe('group_required')
  })

  it("refuses a cookie signed for the OAuth legs' audience", async () => {
    // The two are both "one login round-trip's CSRF state", but the OAuth value travels in the URL
    // (so any user holds a validly-signed one) while this one is the httpOnly carrier of the PKCE
    // verifier and the OIDC nonce. Sharing an audience would let the public value verify as the
    // secret container, leaving both secrets `undefined` and the flow resting on the provider to
    // refuse a PKCE mismatch.
    // Driven with the fake IdP installed so the refusal is not being done by an unreachable
    // network: with a shared audience this payload reached the token exchange, and because its
    // `idNonce` was `undefined` the nonce comparison collapsed to `undefined === undefined` too —
    // two guards no-oping at once, leaving only the provider's PKCE check standing.
    const h = harness()
    const forged = await new HmacSigner(SECRET).sign({
      aud: TOKEN_AUDIENCE.oauthState,
      nonce: 'attacker-known-nonce',
      redirect: `${ORIGIN}/`,
      exp: Date.now() + 600_000,
    })
    const realFetch = globalThis.fetch
    globalThis.fetch = h.idp.fetchImpl
    try {
      const res = await h.app.request(
        `${ORIGIN}/auth/sso/callback?code=x&state=attacker-known-nonce`,
        { headers: { cookie: `cf_sso_state=${forged}` } },
      )
      expect(fragment(res).token).toBeUndefined()
      expect(fragment(res).sso_error).toBe('state_invalid')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it("refuses an HS256 token forged with the deployment's own client secret", async () => {
    // The classic JWT hole. Asymmetric-only algorithms are what close it: a token must be
    // verifiable ONLY with a key the provider published, never with a secret we also hold.
    const { res } = await roundTrip(harness({ forgeSymmetric: true }))
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('refuses an ID token issued for a different client', async () => {
    const { res } = await roundTrip(harness({ claims: { aud: 'some-other-app' } }))
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('refuses a token with no `sub` at the verification layer', async () => {
    // `sub` is a REQUIRED claim, so an absent one never reaches the identity reader.
    const { res } = await roundTrip(harness({ claims: { sub: undefined } }))
    expect(fragment(res).sso_error).toBe('token_invalid')
  })

  it('refuses a token whose `sub` is present but blank as `subject_missing`', async () => {
    // The shape a required-claim check cannot catch: present, so the token verifies, but with
    // nothing to key an account on. Reported as its own reason because the remedy is the
    // provider's claim configuration, not this deployment's.
    const { res } = await roundTrip(harness({ claims: { sub: '   ' } }))
    expect(fragment(res).sso_error).toBe('subject_missing')
  })

  it('refuses a user outside the required directory groups', async () => {
    const { res } = await roundTrip(
      harness({
        sso: ssoConfig({ requiredGroups: ['engineering'] }),
        claims: { groups: ['marketing'] },
      }),
    )
    expect(fragment(res).sso_error).toBe('group_required')
  })

  it('admits a user in a required group, reading groups from userinfo when the token omits them', async () => {
    // The Entra ID shape: `email` in the ID token, `groups` only from userinfo.
    const h = harness({
      sso: ssoConfig({ requiredGroups: ['engineering'] }),
      userinfo: { sub: 'okta-user-1', groups: ['Engineering'] },
    })
    const { res } = await roundTrip(h)
    expect(fragment(res).token).toBeTruthy()
  })

  it('refuses an email domain outside the allowlist', async () => {
    const { res } = await roundTrip(
      harness({ sso: ssoConfig({ allowedEmailDomains: ['other.com'] }) }),
    )
    expect(fragment(res).sso_error).toBe('domain_not_allowed')
  })

  it('is single-use: the same callback cannot be replayed', async () => {
    // The cookie is deleted whatever the outcome, so a captured callback URL is useless on a
    // second visit — which is what stops a replayed authorization response.
    const h = harness()
    const realFetch = globalThis.fetch
    globalThis.fetch = h.idp.fetchImpl
    try {
      const login = await h.app.request(`${ORIGIN}/auth/sso/login`)
      const authorize = new URL(login.headers.get('location')!)
      const cookie = stateCookie(login)!
      const code = 'replay-code'
      noncesByCode.set(code, authorize.searchParams.get('nonce') ?? '')
      const url = `${ORIGIN}/auth/sso/callback?code=${code}&state=${authorize.searchParams.get('state')}`
      const first = await h.app.request(url, { headers: { cookie } })
      expect(fragment(first).token).toBeTruthy()
      // The browser would no longer hold the cookie; presenting it again must still fail, which is
      // why the check is against the state parameter AND the deleted cookie.
      const replay = await h.app.request(url)
      expect(fragment(replay).sso_error).toBe('state_invalid')
    } finally {
      globalThis.fetch = realFetch
    }
  })
})

// The offboarding half: a refusal is not only "no new session", it ENDS the ones the person is
// already holding. Re-reading the directory on sign-in never could do that on its own, which is
// the entire reason SSO needed a revocation slice.
describe('GET /auth/sso/callback — offboarding revocation', () => {
  const refused = () =>
    harness({
      sso: ssoConfig({ requiredGroups: ['engineering'] }),
      claims: { groups: ['marketing'] },
      knownUserId: 'usr_departed',
    })

  it('ends the live sessions of a returning user the directory now refuses', async () => {
    const h = refused()
    const { res } = await roundTrip(h)

    expect(fragment(res).sso_error).toBe('group_required')
    expect(h.revoked).toEqual(['usr_departed'])
  })

  it('looks the person up by ISSUER#SUB, never by email', async () => {
    // Emails are reassigned inside orgs. Keying the revocation on one would end the sessions of
    // whoever inherited a departed employee's address.
    const h = refused()
    await roundTrip(h)

    expect(h.lookedUp).toEqual([{ provider: 'oidc', subject: `${ISSUER}#okta-user-1` }])
  })

  it('revokes nothing for somebody who never signed in here', async () => {
    // The ordinary case for an outsider hitting the login: there is no account, so there is
    // nothing to end — not a failure.
    const h = harness({
      sso: ssoConfig({ requiredGroups: ['engineering'] }),
      claims: { groups: ['marketing'] },
    })
    const { res } = await roundTrip(h)

    expect(fragment(res).sso_error).toBe('group_required')
    expect(h.revoked).toEqual([])
  })

  it('still refuses cleanly when the revocation itself fails', async () => {
    // The refusal has already succeeded by this point. A store failure must cost the revocation
    // (warned, best-effort) and never turn a correct denial into a 500 an operator would read as
    // a broken SSO configuration.
    const h = harness({
      sso: ssoConfig({ requiredGroups: ['engineering'] }),
      claims: { groups: ['marketing'] },
      knownUserId: 'usr_departed',
      revokeFails: true,
    })
    const { res } = await roundTrip(h)

    expect(res.status).toBe(302)
    expect(fragment(res).sso_error).toBe('group_required')
  })

  it('revokes nothing when the sign-in is ADMITTED', async () => {
    // The mint path must not run the offboarding branch: a person signing in successfully would
    // otherwise invalidate the session being minted for them.
    const h = harness({ knownUserId: 'usr_1' })
    const { res } = await roundTrip(h)

    expect(fragment(res).sso_error).toBeUndefined()
    expect(h.revoked).toEqual([])
  })
})

describe('GET /auth/config', () => {
  it("advertises SSO with the operator's own label", async () => {
    const h = harness({ sso: ssoConfig({ label: 'Acme SSO' }) })
    const body = await (await h.app.request(`${ORIGIN}/auth/config`)).json()
    expect(body.providers.sso).toBe(true)
    expect(body.sso).toEqual({ label: 'Acme SSO', protocol: 'oidc' })
  })

  it('omits the presentation object when SSO is unconfigured', async () => {
    const h = harness({ sso: null })
    const body = await (await h.app.request(`${ORIGIN}/auth/config`)).json()
    expect(body.providers.sso).toBe(false)
    expect(body.sso).toBeUndefined()
  })
})
