// ---------------------------------------------------------------------------
// Enterprise SSO: the shape of a discovered OpenID Connect provider.
//
// One generic OIDC adapter serves every enterprise identity provider (Okta, Entra ID,
// Auth0, Keycloak, PingFederate, OneLogin, JumpCloud, a Shibboleth IdP running the OIDC
// OP plugin), because a discovery document plus a client id/secret IS the whole
// configuration. Nothing here may branch on WHICH provider answered: a per-vendor code path
// would mean a provider is only supported once it is named, and would pin endpoints that the
// provider itself is free to move. Vendor differences belong in the discovered document and
// in a deployment's configuration, never in this layer.
//
// These types live in kernel because the CACHE that holds a discovered provider is declared
// on the kernel `AppCaches` port, and `@cat-factory/server` owns the fetch that fills it.
// ---------------------------------------------------------------------------

/**
 * The subset of an OIDC provider's `/.well-known/openid-configuration` the login flow
 * actually uses, validated at fetch time so a malformed or non-conforming document fails
 * with an operator-readable message rather than deep inside the redirect.
 *
 * `issuer` is kept because it is the value an ID token's `iss` claim MUST equal, and it is
 * the provider's own canonical spelling of itself — not the URL an operator happened to
 * type. Everything downstream (the identity subject, the token audience check) keys off
 * this one, so the discovered value is authoritative over the configured one.
 */
export interface OidcProviderMetadata {
  /** The provider's canonical issuer identifier — what a valid ID token's `iss` equals. */
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly jwksUri: string
  /** Absent on a provider that exposes no userinfo endpoint (claims then come from the ID token). */
  readonly userinfoEndpoint: string | null
  /**
   * Whether the provider ADVERTISES PKCE S256 support. We send PKCE regardless (an unaware
   * provider ignores the parameters), so this exists to be reported, never to gate: a
   * provider whose metadata omits the field but implements the RFC is common enough that
   * refusing on it would lock out working deployments.
   */
  readonly supportsPkceS256: boolean
}

/**
 * The `user_identities.subject` an OIDC login keys on: the provider's own canonical issuer,
 * then its `sub`.
 *
 * An OIDC `sub` is unique WITHIN an issuer and carries no global guarantee, so keying a row on
 * it alone would let two directories collide the day a deployment re-points at a second
 * provider — one person inheriting another's account, silently. The separator is `#` because it
 * cannot appear in a URL's path (it would start a fragment), so the pair can never be ambiguous
 * however odd a `sub` is.
 *
 * The issuer used here is the DISCOVERED one (`OidcProviderMetadata.issuer`), never the URL an
 * operator typed: those differ in trailing slashes and casing, and a subject that drifted with
 * an operator's spelling would orphan every existing identity on the next config edit.
 */
export function oidcIdentitySubject(issuer: string, sub: string): string {
  return `${issuer}#${sub}`
}

/**
 * A discovered provider: its metadata plus the signing keys its ID tokens verify against,
 * fetched together so one cache entry is one coherent view of the provider.
 *
 * `jwks` is the raw JSON Web Key Set as served. It is kept unparsed (rather than as imported
 * `CryptoKey`s) because a `CryptoKey` is not structured-cloneable across every runtime and the
 * entry has to survive the cache's serialisation boundary; importing is cheap and happens per
 * verification.
 */
export interface SsoDiscoveryDocument {
  readonly metadata: OidcProviderMetadata
  readonly jwks: { readonly keys: readonly Record<string, unknown>[] }
  /** When this view was fetched (epoch ms), so a key-rotation refetch can be rate-limited. */
  readonly fetchedAt: number
}
