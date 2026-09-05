import type { Logger, SsoDiscoveryDocument } from '@cat-factory/kernel'
import { UnavailableError, describeError, noopLogger, redactSecrets } from '@cat-factory/kernel'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet, JWTPayload } from 'jose'
import { base64url } from '../../crypto/encoding.js'
import type { SsoConfig } from '../../config/types.js'
import type { OidcProviderDirectory } from './discovery.js'
import { causeText } from './discovery.js'

// ---------------------------------------------------------------------------
// The OpenID Connect Authorization Code + PKCE client — one adapter for every enterprise IdP.
//
// Deliberate choices, each of which is the difference between a login flow and a vulnerability:
//
//  - **Authorization Code, never implicit.** No token ever crosses the browser's URL bar.
//  - **PKCE (S256) always.** The `code_verifier` lives only in an httpOnly cookie, so an
//    authorization code intercepted from the redirect cannot be exchanged. Sent even to
//    providers whose metadata omits `code_challenge_methods_supported`: an unaware provider
//    ignores the parameters, whereas refusing on the advertisement locks out providers that
//    implement the RFC without announcing it.
//  - **ID token verified against the provider's JWKS, with an ASYMMETRIC algorithm allow-list.**
//    Signature verification is delegated to `jose` rather than hand-rolled: it is Web-Crypto
//    native (so it runs unchanged in a Workers isolate and on Node) and it is the wrong thing to
//    reimplement. The allow-list is what closes the classic JWT holes — `alg: none` and an
//    `HS256` token forged with the deployment's own client secret as the HMAC key.
//  - **Keys are supplied LOCALLY** (`createLocalJWKSet` over the key set our own cache holds)
//    rather than through jose's remote JWKS helper, which keeps its own module-level cache. One
//    cache for the document, and it is the evictable app-cache seam.
//  - **`nonce` is checked here**, bound to the httpOnly cookie the login leg set, so a replayed
//    or injected ID token from another session is refused.
// ---------------------------------------------------------------------------

/**
 * The signature algorithms an ID token may use. Asymmetric only, so a token can be verified
 * ONLY with a key the provider published — never with a secret this deployment also holds.
 */
const ALLOWED_ID_TOKEN_ALGS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]

/** Clock skew tolerated on `exp`/`iat`/`nbf`. IdP and app clocks routinely differ by seconds. */
const CLOCK_TOLERANCE = '60s'

/** The token/userinfo calls sit on a user's critical path — bound them. */
const FETCH_TIMEOUT_MS = 10_000

/** A failed exchange or verification, carrying the reason the SPA renders copy for. */
export class OidcFlowError extends Error {
  constructor(
    readonly reason: 'exchange_failed' | 'token_invalid',
    message: string,
  ) {
    super(message)
    this.name = 'OidcFlowError'
  }
}

/** The PKCE pair a login leg mints: the secret stays in a cookie, the challenge goes to the IdP. */
export interface PkcePair {
  verifier: string
  challenge: string
}

export interface OidcClientDependencies {
  config: SsoConfig
  directory: OidcProviderDirectory
  logger?: Logger
  fetchImpl?: typeof fetch
}

export class OidcClient {
  private readonly log: Logger

  constructor(private readonly deps: OidcClientDependencies) {
    this.log = deps.logger ?? noopLogger
  }

  /** The provider, from the discovery cache. */
  provider(): Promise<SsoDiscoveryDocument> {
    return this.deps.directory.resolve(this.deps.config.issuerUrl)
  }

  /** Where to send the browser to authenticate. */
  async authorizeUrl(params: {
    redirectUri: string
    state: string
    nonce: string
    codeChallenge: string
    /** Pre-fills the IdP's account picker when the SPA knows who is signing in. Rarely set. */
    loginHint?: string
  }): Promise<string> {
    const { metadata } = await this.provider()
    const url = new URL(metadata.authorizationEndpoint)
    url.searchParams.set('client_id', this.deps.config.clientId)
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', this.deps.config.scopes)
    url.searchParams.set('state', params.state)
    url.searchParams.set('nonce', params.nonce)
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    if (params.loginHint) url.searchParams.set('login_hint', params.loginHint)
    return url.toString()
  }

  /**
   * Exchange the callback `code` for tokens. Authenticates as a confidential client
   * (`client_secret_post`, the method every enterprise IdP accepts) AND sends the PKCE verifier,
   * so neither the code alone nor the secret alone is enough.
   */
  async exchangeCode(params: {
    code: string
    redirectUri: string
    codeVerifier: string
  }): Promise<{ idToken: string; accessToken: string | null }> {
    const { metadata } = await this.provider()
    const doFetch = this.deps.fetchImpl ?? fetch
    let res: Response
    try {
      res = await doFetch(metadata.tokenEndpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: params.code,
          redirect_uri: params.redirectUri,
          client_id: this.deps.config.clientId,
          client_secret: this.deps.config.clientSecret,
          code_verifier: params.codeVerifier,
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      throw new OidcFlowError(
        'exchange_failed',
        `The token endpoint could not be reached: ${causeText(error)}`,
      )
    }
    const body = (await res.json().catch(() => ({}))) as {
      id_token?: unknown
      access_token?: unknown
      error?: unknown
      error_description?: unknown
    }
    if (!res.ok) {
      // The provider's own `error`/`error_description` is the diagnostic an operator needs
      // ("invalid_client" ⇒ wrong secret, "invalid_grant" ⇒ redirect_uri mismatch), and it is
      // scrubbed because a token-endpoint error routinely echoes the request back.
      const detail = [body.error, body.error_description].filter(Boolean).join(': ')
      throw new OidcFlowError(
        'exchange_failed',
        `The identity provider refused the authorization code (HTTP ${res.status})` +
          (detail ? `: ${redactSecrets(String(detail)) ?? ''}` : '.'),
      )
    }
    if (typeof body.id_token !== 'string' || body.id_token === '') {
      throw new OidcFlowError(
        'token_invalid',
        'The identity provider returned no ID token. Make sure the `openid` scope is granted to this client.',
      )
    }
    return {
      idToken: body.id_token,
      accessToken: typeof body.access_token === 'string' ? body.access_token : null,
    }
  }

  /**
   * Verify an ID token and return its claims.
   *
   * On a `kid` the cached key set does not hold, refetches the provider ONCE (the rate-limited
   * key-rotation path) and retries — because a provider rotating its signing keys must cost one
   * fetch, not every login until the cache TTL lapses.
   *
   * Every exit is a payload or an `OidcFlowError`. The unknown-key signal is jose's OWN error and
   * it is useful only INSIDE this method: once the one refetch is spent (or refused by its rate
   * limit) the token is simply unverifiable, and letting the raw error out made the callback leg's
   * `instanceof OidcFlowError` catch miss, which rendered a 500 JSON envelope at a browser
   * mid-redirect instead of the reason the flow promises.
   */
  async verifyIdToken(idToken: string, expected: { nonce: string }): Promise<JWTPayload> {
    const document = await this.provider()
    try {
      return await this.verifyAgainst(document, idToken, expected)
    } catch (error) {
      if (!isUnknownKeyError(error)) throw error
      const refreshed = await this.deps.directory.refreshForUnknownKey(
        this.deps.config.issuerUrl,
        document,
      )
      // Unchanged means the refetch was rate-limited: nothing new to try against.
      if (refreshed === document) throw keyNotPublished(error)
      try {
        return await this.verifyAgainst(refreshed, idToken, expected)
      } catch (retryError) {
        if (!isUnknownKeyError(retryError)) throw retryError
        throw keyNotPublished(retryError)
      }
    }
  }

  private async verifyAgainst(
    document: SsoDiscoveryDocument,
    idToken: string,
    expected: { nonce: string },
  ): Promise<JWTPayload> {
    const keys = createLocalJWKSet(document.jwks as unknown as JSONWebKeySet)
    let payload: JWTPayload
    try {
      const verified = await jwtVerify(idToken, keys, {
        // The DISCOVERED issuer, never the configured URL: the provider's own spelling is what
        // it signs, and it is what the identity subject is built from.
        issuer: document.metadata.issuer,
        audience: this.deps.config.clientId,
        algorithms: ALLOWED_ID_TOKEN_ALGS,
        clockTolerance: CLOCK_TOLERANCE,
        requiredClaims: ['sub', 'iat', 'exp'],
      })
      payload = verified.payload
    } catch (error) {
      if (isUnknownKeyError(error)) throw error
      throw new OidcFlowError('token_invalid', `The ID token did not verify: ${causeText(error)}`)
    }
    // `nonce` is not a claim jose checks — it is OIDC's own replay binding, and it is the reason
    // an ID token captured from one user's round-trip cannot be injected into another's.
    if (payload.nonce !== expected.nonce) {
      throw new OidcFlowError(
        'token_invalid',
        "The ID token's nonce does not match this sign-in attempt.",
      )
    }
    // `azp` identifies which client the token was issued FOR when the audience is multi-valued.
    // Only meaningful when present; when it is, it must be us.
    if (typeof payload.azp === 'string' && payload.azp !== this.deps.config.clientId) {
      throw new OidcFlowError('token_invalid', 'The ID token was issued for a different client.')
    }
    return payload
  }

  /**
   * Read the userinfo endpoint, or null when the provider exposes none / the call failed.
   *
   * Best-effort BY DESIGN: it supplements the ID token's claims, and a provider that answers
   * slowly must not turn a valid authentication into a failed login. When the missing claim is
   * one admission depends on, the ADMISSION rule refuses (with `email_required` /
   * `group_required`) — so a userinfo outage never silently widens who gets in.
   */
  async fetchUserInfo(accessToken: string): Promise<Record<string, unknown> | null> {
    const { metadata } = await this.provider()
    if (!metadata.userinfoEndpoint) return null
    const doFetch = this.deps.fetchImpl ?? fetch
    try {
      const res = await doFetch(metadata.userinfoEndpoint, {
        headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!res.ok) {
        this.log.warn('sso.userinfo.failed', { status: res.status })
        return null
      }
      const body = await res.json()
      return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
    } catch (error) {
      this.log.warn('sso.userinfo.failed', describeError(error))
      return null
    }
  }
}

/**
 * The refusal for a token whose signing key the provider does not publish, once the single
 * rate-limited refetch has been spent. Reported as `token_invalid` because that is what it is
 * from the caller's side: a token this deployment cannot verify. The message names the key so an
 * operator reading the log can tell a mid-rotation race (retry succeeds) from a provider signing
 * with a key it never published (it does not).
 */
function keyNotPublished(error: unknown): OidcFlowError {
  return new OidcFlowError(
    'token_invalid',
    'The ID token is signed with a key the identity provider does not publish in its key set, ' +
      `and refetching the key set did not produce it: ${causeText(error)}`,
  )
}

/**
 * Whether a verification failure is "no key with that `kid`" — the key-rotation signal — rather
 * than a bad signature.
 *
 * Matched on jose's stable error `code` rather than its message, so a wording change upstream
 * cannot silently turn a rotation into a hard login failure. `ERR_JWKS_MULTIPLE_MATCHING_KEYS`
 * counts too: an ambiguous match resolves once the stale key is gone.
 */
function isUnknownKeyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ERR_JWKS_NO_MATCHING_KEY' || code === 'ERR_JWKS_MULTIPLE_MATCHING_KEYS'
}

/**
 * Mint a PKCE pair: 32 random bytes as the verifier, its SHA-256 as the S256 challenge.
 *
 * Exported (rather than a private method) because the login leg needs the verifier to put in the
 * cookie and the challenge to put in the redirect, and the callback leg needs neither — keeping
 * it a free function is what stops the secret from being reachable off the client instance.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = base64url(bytes)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(digest) }
}

/** Throw the shared 503 when a caller reached an SSO route on a deployment with none wired. */
export function ssoNotConfigured(): never {
  throw new UnavailableError(
    'Single sign-on is not configured on this deployment.',
    'sso_not_configured',
  )
}
