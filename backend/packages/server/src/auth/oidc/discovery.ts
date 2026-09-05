import type { GroupCacheHandle, Logger, OidcProviderMetadata } from '@cat-factory/kernel'
import type { SsoDiscoveryDocument } from '@cat-factory/kernel'
import { UnavailableError, describeError, noopLogger } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Resolving the deployment's enterprise identity provider from its own discovery document.
//
// This is the whole reason there is ONE adapter rather than an Okta one and an Entra one: every
// endpoint the login flow needs is published by the provider at
// `/.well-known/openid-configuration`, so the code path is identical and the differences are
// data. Hard-coding endpoints per vendor would also be wrong over time — a provider moves its
// token endpoint and every deployment pinned to our copy breaks.
//
// Two facts shape the caching:
//
//  - The document changes rarely, and reading it twice per sign-in (authorize, then verify)
//    would put two IdP round-trips in front of every login. So it is cached through the app
//    cache seam (`AppCaches.ssoDiscovery`), never a module-level Map — a scaled Node deployment
//    has to be able to evict it (CLAUDE.md's caching rule).
//  - Providers rotate their signing keys with NO notice and no version to probe. So an ID token
//    whose `kid` is absent from the cached key set is not a failure: it is the signal to refetch
//    ONCE. {@link OidcProviderDirectory.refreshForUnknownKey} is that path, rate-limited by the
//    entry's own `fetchedAt` so a stream of tokens carrying junk `kid`s cannot turn into a
//    request amplifier pointed at the IdP.
// ---------------------------------------------------------------------------

/** How long after a fetch a key-rotation refetch is refused (the amplification bound). */
const KEY_REFRESH_MIN_INTERVAL_MS = 60_000

/** Discovery/JWKS fetches are IdP round-trips on a user's critical path — bound them. */
const FETCH_TIMEOUT_MS = 10_000

export interface OidcProviderDirectoryDependencies {
  /**
   * The `AppCaches.ssoDiscovery` handle. Optional so the directory stays constructible in a
   * unit test (and on a facade that wires no caches), where it simply fetches every time.
   */
  cache?: GroupCacheHandle<SsoDiscoveryDocument>
  logger?: Logger
  /** Injectable for tests; defaults to the runtime `fetch` (available on both facades). */
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Resolves (and caches) the configured provider's metadata + signing keys.
 *
 * A failure here is an `UnavailableError`, not a validation error: the deployment is configured
 * correctly and the IdP (or the network to it) is not answering, which is an outage an operator
 * fixes rather than an input a user can correct. The `details.reason` distinguishes the causes
 * that need different fixes, per CLAUDE.md's degrade-loudly rule.
 */
export class OidcProviderDirectory {
  private readonly log: Logger

  constructor(private readonly deps: OidcProviderDirectoryDependencies = {}) {
    this.log = deps.logger ?? noopLogger
  }

  /** The provider behind an issuer URL, from cache when warm. */
  resolve(issuerUrl: string): Promise<SsoDiscoveryDocument> {
    const cache = this.deps.cache
    if (!cache) return this.fetchDocument(issuerUrl)
    return cache.get(issuerUrl, issuerUrl, () => this.fetchDocument(issuerUrl))
  }

  /**
   * Re-resolve after an ID token arrived signed by a `kid` the cached key set does not hold —
   * the key-rotation path. Returns the CACHED document unchanged when the last fetch is too
   * recent to justify another, so the caller's verification fails on the stale keys (a login
   * error the user can retry) rather than every unknown `kid` becoming a fresh IdP request.
   */
  async refreshForUnknownKey(
    issuerUrl: string,
    current: SsoDiscoveryDocument,
  ): Promise<SsoDiscoveryDocument> {
    const now = this.deps.now?.() ?? Date.now()
    if (now - current.fetchedAt < KEY_REFRESH_MIN_INTERVAL_MS) {
      this.log.warn('sso.discovery.refresh_throttled', {
        issuerUrl,
        ageMs: now - current.fetchedAt,
      })
      return current
    }
    await this.deps.cache?.invalidate(issuerUrl, issuerUrl)
    this.log.info('sso.discovery.refreshed_for_key_rotation', { issuerUrl })
    return this.resolve(issuerUrl)
  }

  private async fetchDocument(issuerUrl: string): Promise<SsoDiscoveryDocument> {
    const metadata = await this.fetchMetadata(issuerUrl)
    const jwks = await this.fetchJwks(metadata.jwksUri)
    return { metadata, jwks, fetchedAt: this.deps.now?.() ?? Date.now() }
  }

  private async fetchMetadata(issuerUrl: string): Promise<OidcProviderMetadata> {
    const url = `${issuerUrl}/.well-known/openid-configuration`
    const body = await this.getJson(url, 'sso_discovery_unreachable')
    return readProviderMetadata(body, issuerUrl)
  }

  private async fetchJwks(jwksUri: string): Promise<SsoDiscoveryDocument['jwks']> {
    const body = await this.getJson(jwksUri, 'sso_jwks_unreachable')
    const keys = (body as { keys?: unknown }).keys
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new UnavailableError(
        `The identity provider's key set at ${jwksUri} contains no keys, so no ID token can be verified.`,
        'sso_jwks_invalid',
      )
    }
    return { keys: keys as Record<string, unknown>[] }
  }

  private async getJson(url: string, reason: string): Promise<unknown> {
    const doFetch = this.deps.fetchImpl ?? fetch
    let res: Response
    try {
      res = await doFetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (error) {
      // The URL is operator-configured (never user input), so naming it is the diagnostic:
      // "unreachable" without it sends an operator to the wrong system first.
      throw new UnavailableError(
        `Could not reach the identity provider at ${url}: ${causeText(error)}`,
        reason,
      )
    }
    if (!res.ok) {
      throw new UnavailableError(
        `The identity provider answered HTTP ${res.status} for ${url}.`,
        reason,
      )
    }
    try {
      return await res.json()
    } catch {
      throw new UnavailableError(`The identity provider's response at ${url} is not JSON.`, reason)
    }
  }
}

/**
 * Validate a discovery document down to the fields the flow uses.
 *
 * The `issuer` check is the load-bearing one and it is a SECURITY check, not tidiness: the
 * discovered `issuer` becomes both the value every ID token's `iss` is compared against and half
 * of the identity subject, so a document that names an issuer other than the URL it was served
 * from is either a misconfiguration or a redirect onto an attacker's metadata, and admitting it
 * would let that issuer's tokens sign in. Compared with the `/.well-known` suffix and any
 * trailing slash removed, since providers differ on both.
 */
export function readProviderMetadata(body: unknown, issuerUrl: string): OidcProviderMetadata {
  const doc = (body ?? {}) as Record<string, unknown>
  const issuer = str(doc.issuer)
  const authorizationEndpoint = str(doc.authorization_endpoint)
  const tokenEndpoint = str(doc.token_endpoint)
  const jwksUri = str(doc.jwks_uri)
  const missing = [
    issuer ? null : 'issuer',
    authorizationEndpoint ? null : 'authorization_endpoint',
    tokenEndpoint ? null : 'token_endpoint',
    jwksUri ? null : 'jwks_uri',
  ].filter((name): name is string => name !== null)
  if (missing.length > 0) {
    throw new UnavailableError(
      `The identity provider's discovery document at ${issuerUrl} is missing ${missing.join(', ')}, so it cannot be used for sign-in.`,
      'sso_discovery_invalid',
    )
  }
  if (trimIssuer(issuer!) !== trimIssuer(issuerUrl)) {
    throw new UnavailableError(
      `The identity provider's discovery document declares issuer "${issuer}" but was fetched from "${issuerUrl}". ` +
        `Set AUTH_SSO_ISSUER_URL to the issuer the provider itself publishes.`,
      'sso_issuer_mismatch',
    )
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported)
    ? doc.code_challenge_methods_supported
    : []
  return {
    issuer: issuer!,
    authorizationEndpoint: authorizationEndpoint!,
    tokenEndpoint: tokenEndpoint!,
    jwksUri: jwksUri!,
    userinfoEndpoint: str(doc.userinfo_endpoint) ?? null,
    supportsPkceS256: methods.includes('S256'),
  }
}

function trimIssuer(value: string): string {
  return value
    .trim()
    .replace(/\/\.well-known\/openid-configuration$/i, '')
    .replace(/\/+$/, '')
}

/** The scrubbed message of a thrown value, as a string safe to interpolate. */
/** The cause chain of a discovery or token failure, as one line for a refusal message. */
export function causeText(error: unknown): string {
  return String(describeError(error).err ?? '')
}

/** A non-blank string claim, trimmed; anything else reads as absent. */
export function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}
