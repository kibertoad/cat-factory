import type { ServiceCatalogAuth, ServiceCatalogAuthMode } from '@cat-factory/contracts'
import { UnavailableError, ValidationError } from '@cat-factory/kernel'
import { base64ToBytes, bytesToBase64Url, toBase64, toBase64Url } from '../shared/base64.js'

// ---------------------------------------------------------------------------
// Turning a stored service-catalog credential into the headers one request carries.
//
// Five of the six modes are a pure function of the bag and are computed per request. The sixth
// (`oauth2-client-credentials`) needs a round trip to an identity provider, so the caller
// resolves it ONCE per import pass and passes the resulting bearer value down; there is
// deliberately no cache here, because the only two places a token could be held are a module
// global (banned) and a per-isolate map that workerd may discard between invocations, and an
// import pass is exactly the scope over which one token is both sufficient and safe.
// ---------------------------------------------------------------------------

/** How long a minted legacy service token is valid for. Short: it is minted per pass. */
const LEGACY_TOKEN_TTL_SECONDS = 600

/**
 * The `sub` Backstage's legacy service-to-service tokens carry.
 *
 * Fixed by the vendor rather than chosen here: its backend admits a legacy token only when the
 * subject is this exact string, so it is a wire constant and not a configurable identity.
 */
const LEGACY_TOKEN_SUBJECT = 'backstage-server'

/** Read a sealed credential bag back into the discriminated auth it was written from. */
export function parseServiceCatalogAuth(
  plaintext: string,
  expected: ServiceCatalogAuthMode,
): ServiceCatalogAuth {
  if (expected === 'none') return { mode: 'none' }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    // silent-catch-ok: the parse error names only JSON syntax, and what the caller has to be
    // told is which connection's bag will not open. The throw below says that.
    parsed = null
  }
  const bag = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  const auth = bag ? readAuth(bag, expected) : null
  if (!auth) {
    // A row whose stored mode and stored bag disagree is corrupt, not a misconfiguration, so the
    // remedy is re-entering the credential rather than anything the operator can adjust. Named
    // as `unavailable` for that reason: a `ValidationError` here would blame the request.
    // The SHARED reason, not one of this integration's own: an unopenable credential bag is the
    // same fact here as for a document source or a tracker, with the same two remedies, and the
    // SPA already carries copy naming both. `details.source` is what tells them apart.
    throw new UnavailableError(
      `The stored service-catalog credential does not hold a '${expected}' credential. Re-enter the connection.`,
      'connection_credentials_unreadable',
      { source: 'service_catalog' },
    )
  }
  return auth
}

/**
 * Narrow a parsed bag against ONE declared mode.
 *
 * Keyed off the column's mode rather than the bag's own, so a bag that claims a different mode
 * than the row does is refused instead of quietly switching schemes: the column is what every
 * management read and the request builder branch on, and a disagreement between the two is the
 * one state where trusting the ciphertext over the plaintext is wrong.
 */
function readAuth(
  bag: Record<string, unknown>,
  mode: ServiceCatalogAuthMode,
): ServiceCatalogAuth | null {
  switch (mode) {
    case 'none':
      return { mode: 'none' }
    case 'static-token': {
      const token = text(bag.token)
      return token ? { mode, token } : null
    }
    case 'legacy-shared-secret': {
      const sharedSecret = text(bag.sharedSecret)
      return sharedSecret ? { mode, sharedSecret } : null
    }
    case 'oauth2-client-credentials': {
      const tokenUrl = text(bag.tokenUrl)
      const clientId = text(bag.clientId)
      const clientSecret = text(bag.clientSecret)
      if (!tokenUrl || !clientId || !clientSecret) return null
      const scope = text(bag.scope)
      const audience = text(bag.audience)
      return {
        mode,
        tokenUrl,
        clientId,
        clientSecret,
        ...(scope ? { scope } : {}),
        ...(audience ? { audience } : {}),
      }
    }
    case 'basic': {
      const username = text(bag.username)
      const password = text(bag.password)
      return username && password ? { mode, username, password } : null
    }
    case 'headers': {
      const raw = Array.isArray(bag.headers) ? bag.headers : []
      const headers: { name: string; value: string }[] = []
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue
        const name = text((entry as Record<string, unknown>).name)
        const value = text((entry as Record<string, unknown>).value)
        if (name && value) headers.push({ name, value })
      }
      return headers.length > 0 ? { mode, headers } : null
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * The headers one catalog request carries.
 *
 * `bearer` is the token an OAuth2 exchange produced, resolved once by the caller. It is a
 * parameter rather than something fetched here so this stays pure and so one import pass cannot
 * fan out into one token request per page.
 */
export function serviceCatalogAuthHeaders(
  auth: ServiceCatalogAuth,
  bearer: string | null,
): Record<string, string> {
  switch (auth.mode) {
    case 'none':
      return {}
    case 'static-token':
      return { authorization: `Bearer ${auth.token}` }
    case 'legacy-shared-secret':
      // Minted asynchronously, so the caller supplies it through the same channel the OAuth2
      // token uses. Reaching this with no bearer means the mint was skipped, which would send an
      // UNAUTHENTICATED request and read back as a rejected credential.
      return bearerHeaders(bearer, 'legacy service token')
    case 'oauth2-client-credentials':
      return bearerHeaders(bearer, 'OAuth2 access token')
    case 'basic':
      return { authorization: `Basic ${toBase64(`${auth.username}:${auth.password}`)}` }
    case 'headers':
      return Object.fromEntries(auth.headers.map((header) => [header.name, header.value]))
  }
}

function bearerHeaders(bearer: string | null, what: string): Record<string, string> {
  if (!bearer) {
    throw new UnavailableError(
      `The service-catalog ${what} was not resolved before the request was built.`,
      'service_catalog_token_unresolved',
    )
  }
  return { authorization: `Bearer ${bearer}` }
}

/** Whether this mode's bearer value has to be resolved before any request is built. */
export function requiresResolvedBearer(mode: ServiceCatalogAuthMode): boolean {
  return mode === 'legacy-shared-secret' || mode === 'oauth2-client-credentials'
}

/**
 * Mint the short-lived HS256 token Backstage's LEGACY external-access mode accepts: a JWT whose
 * subject is the vendor's fixed `backstage-server`, signed with the HMAC key the configured
 * shared secret decodes to.
 *
 * The secret is base64-DECODED into key bytes rather than used as UTF-8, because that is how the
 * vendor derives its own key and how its documentation has operators generate the value
 * (`openssl rand -base64 32`). Signing with the raw characters of a base64 secret produces a
 * different key, so the choice is not a preference: it decides whether the token verifies at all.
 * A secret that is not base64 is REFUSED here rather than falling back to its raw bytes: the two
 * readings of one string are indistinguishable, so a fallback would sign half the deployments in
 * the world with the wrong key and surface as a 401 blaming the credential.
 */
export async function mintLegacyBackstageToken(
  sharedSecret: string,
  nowSeconds: number,
): Promise<string> {
  const keyBytes = base64ToBytes(sharedSecret)
  if (!keyBytes || keyBytes.length === 0) {
    throw new ValidationError(
      'The Backstage shared secret must be base64 (the value `backend.auth.keys[].secret` holds). ' +
        'If your instance authenticates some other way, use a static token or explicit headers instead.',
      { reason: 'service_catalog_shared_secret_not_base64' },
    )
  }
  const header = toBase64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = toBase64Url(
    JSON.stringify({
      sub: LEGACY_TOKEN_SUBJECT,
      iat: nowSeconds,
      exp: nowSeconds + LEGACY_TOKEN_TTL_SECONDS,
    }),
  )
  const signingInput = `${header}.${payload}`
  // `slice()` rather than the view: `base64ToBytes` returns a `subarray`, whose backing buffer
  // WebCrypto's `BufferSource` overloads will not accept without a copy of its own bytes.
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes.slice().buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`
}

/** The form body an OAuth2 client-credentials exchange posts. */
export function clientCredentialsBody(auth: {
  clientId: string
  clientSecret: string
  scope?: string
  audience?: string
}): string {
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
  })
  if (auth.scope) form.set('scope', auth.scope)
  if (auth.audience) form.set('audience', auth.audience)
  return form.toString()
}

/**
 * The access token an OAuth2 token response carries, or null when the body is not one.
 *
 * Null rather than a throw so the caller can attach WHICH connection failed and what the provider
 * answered; a bare parse error here would name neither.
 */
export function readAccessToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const token = (body as { access_token?: unknown }).access_token
  return typeof token === 'string' && token.trim() ? token : null
}
