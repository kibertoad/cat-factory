// Verifying an outbound-webhook delivery, over the RAW request bytes.
//
// The platform signs `"<timestamp>.<raw body>"` with the endpoint's own secret and sends the MAC
// as `x-cat-factory-signature: v1=<hex>` beside `x-cat-factory-timestamp`. Two properties of that
// contract decide how this is written:
//
//   - The timestamp is bound INTO the MAC, so it can be trusted, which is what makes a skew
//     window a real replay defence rather than a field an attacker sets.
//   - The MAC covers bytes, not a parsed value. So the body is read once, as text, and verified
//     BEFORE any JSON parse. Re-serializing a parsed body to check it would compare a
//     reconstruction against a signature over the original.
//
// The verdict is a discriminated result rather than a boolean because a receiver that cannot tell
// "no signature was sent" from "the signature was wrong" cannot tell an unconfigured endpoint
// from an attacker, and those need opposite reactions.

/** Why a delivery was refused, or that it was accepted. */
export type VerificationResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'missing_signature'
        | 'malformed_signature'
        | 'missing_timestamp'
        | 'stale_timestamp'
        | 'bad_signature'
    }

/** Default replay window: the platform's own documented example. */
export const DEFAULT_MAX_SKEW_MS = 5 * 60 * 1000

const encoder = new TextEncoder()

/**
 * Verify one delivery.
 *
 * `rawBody` must be the exact text the request carried. `now` is injected so the skew check is
 * testable without waiting; production passes `Date.now()`.
 */
export async function verifyDelivery(
  headers: Headers,
  rawBody: string,
  secret: string,
  now: number,
  maxSkewMs: number = DEFAULT_MAX_SKEW_MS,
): Promise<VerificationResult> {
  const signature = headers.get('x-cat-factory-signature')
  if (signature === null || signature.length === 0)
    return { ok: false, reason: 'missing_signature' }
  if (!signature.startsWith('v1=')) return { ok: false, reason: 'malformed_signature' }
  const provided = hexToBytes(signature.slice('v1='.length))
  if (provided === null) return { ok: false, reason: 'malformed_signature' }

  const timestampHeader = headers.get('x-cat-factory-timestamp')
  const timestamp = timestampHeader === null ? Number.NaN : Number(timestampHeader)
  if (!Number.isFinite(timestamp)) return { ok: false, reason: 'missing_timestamp' }
  if (Math.abs(now - timestamp) > maxSkewMs) return { ok: false, reason: 'stale_timestamp' }

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestampHeader}.${rawBody}`)),
  )

  return equalBytes(expected, provided) ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

/**
 * Constant-time byte comparison.
 *
 * Hand-written rather than reached for from a library because workerd exposes no
 * `timingSafeEqual` on the WebCrypto surface. The length check leaks only the LENGTH of the
 * supplied signature, which the attacker already chose; the bytes themselves are compared with no
 * early exit.
 */
function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number)
  return diff === 0
}

/** Decode a lowercase-or-uppercase hex string, or `null` if it is not one. */
function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (!Number.isInteger(byte)) return null
    bytes[i] = byte
  }
  return /^[0-9a-fA-F]+$/.test(hex) ? bytes : null
}
