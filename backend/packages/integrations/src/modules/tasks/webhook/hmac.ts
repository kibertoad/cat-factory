// Inbound-webhook verification shared by every tracker adapter.
//
// GitHub, Jira and Linear sign HMAC-SHA256 over the RAW request body and differ only in which
// header carries the digest and whether it is prefixed (`sha256=<hex>` on GitHub/Jira, a bare
// `<hex>` on Linear). So the crypto lives here once and each adapter supplies its header name +
// prefix, rather than three near-verbatim copies, which is exactly how a fix to one silently
// misses the others (the lesson `captured-command.ts` records on the harness side).
//
// GitLab does not sign at all: it echoes a caller-chosen secret in `X-Gitlab-Token`, which
// {@link verifySharedToken} compares. That is a WEAKER scheme (the secret travels on every
// delivery, and nothing binds it to the body), and it is the vendor's only option, so it is named
// as its own function rather than dressed up as a signature check.
//
// This is the same Web Crypto construction `WebCryptoWebhookVerifier` (`@cat-factory/server`) uses
// for GitHub VCS deliveries, re-expressed here because `@cat-factory/server` sits ABOVE this
// package: importing it would invert the layering, the same reason `webhookSignature.ts` re-derives
// the outbound signature instead of reaching for `HmacSigner`.

export interface HmacHeaderScheme {
  /** Lower-cased header the digest arrives in (e.g. `x-hub-signature-256`). */
  header: string
  /**
   * Literal prefix that must precede the digest (`sha256=`), or `''` for a bare one (Linear).
   * A scheme WITH a prefix rejects a header that lacks it rather than treating the whole value
   * as the digest — otherwise `sha1=<40 hex>` from a mis-set vendor option would be decoded and
   * compared as if it were a SHA-256, which fails opaquely instead of visibly.
   */
  prefix: string
}

/**
 * Verify a raw delivery body against `secret` using the vendor's header scheme.
 *
 * Resolves `false` for every rejection rather than throwing: a receiver turns this into a terse
 * 401 and must not distinguish "no header" from "bad digest" to a caller. Two guards are
 * load-bearing:
 *
 * - **Empty secret fails closed, and does so FIRST.** An empty HMAC key is a key an attacker also
 *   has, so an unconfigured connection must never accept a delivery it can verify by construction.
 *   The guard also has to precede `importKey`, which REJECTS a zero-length key with a `DataError`
 *   — a throw here would reach the tracker as a 500 (and a redelivery loop) instead of the terse
 *   401 the receiver intends.
 * - **The comparison is timing-safe.** A byte-at-a-time early return leaks the expected digest to
 *   anyone willing to send a few thousand deliveries.
 */
export async function verifyHmacSignature(
  secret: string,
  raw: ArrayBuffer,
  headers: Record<string, string>,
  scheme: HmacHeaderScheme,
): Promise<boolean> {
  if (!secret) return false
  const presented = headers[scheme.header]
  if (!presented) return false
  if (scheme.prefix && !presented.startsWith(scheme.prefix)) return false
  const provided = hexToBytes(presented.slice(scheme.prefix.length).trim())
  if (!provided) return false

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const computed = new Uint8Array(await crypto.subtle.sign('HMAC', key, raw))
  return timingSafeEqual(provided, computed)
}

/**
 * Verify a delivery whose vendor sends the shared secret itself in a header (GitLab's
 * `X-Gitlab-Token`) rather than a signature over the body.
 *
 * The same two guards as {@link verifyHmacSignature} apply and for the same reasons: an empty
 * stored secret fails closed FIRST (an unconfigured connection must not accept a delivery that
 * also presents nothing), and the comparison is timing-safe. The body is not read here at all,
 * because nothing in this scheme binds the token to it, which is precisely why the platform
 * still reads the RAW body once, before any parse, rather than trusting a re-serialisation.
 */
export function verifySharedToken(
  secret: string,
  headers: Record<string, string>,
  header: string,
): boolean {
  if (!secret) return false
  const presented = headers[header]
  if (!presented) return false
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(presented), encoder.encode(secret))
}

/** Constant-time byte comparison (length included in the constant-time property). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

/** Decode a delivery's raw bytes as JSON, or null when it is not parseable JSON. */
export function parseJsonBody(raw: ArrayBuffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Read a nested string off an untrusted payload (`obj.a.b`), or null. */
export function readString(payload: unknown, ...path: string[]): string | null {
  let cursor: unknown = payload
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'string' && cursor.length > 0
    ? cursor
    : typeof cursor === 'number'
      ? String(cursor)
      : null
}

/** Read a nested object off an untrusted payload, or null. */
export function readObject(payload: unknown, ...path: string[]): Record<string, unknown> | null {
  let cursor: unknown = payload
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    ? (cursor as Record<string, unknown>)
    : null
}
