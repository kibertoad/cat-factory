// Inbound-webhook signature verification shared by every tracker adapter.
//
// All three vendors sign HMAC-SHA256 over the RAW request body and differ only in which header
// carries the digest and whether it is prefixed (`sha256=<hex>` on GitHub/Jira, a bare `<hex>` on
// Linear). So the crypto lives here once and each adapter supplies its header name + prefix —
// rather than three near-verbatim copies, which is exactly how a fix to one silently misses the
// others (the lesson `captured-command.ts` records on the harness side).
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
 * - **Empty secret fails closed.** An empty HMAC key is a key an attacker also has, so an
 *   unconfigured connection must never accept a delivery it can verify by construction.
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
