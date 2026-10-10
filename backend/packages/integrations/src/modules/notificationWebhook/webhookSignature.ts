// Detached HMAC signature over an outbound webhook body — the proof a receiver uses to decide that
// a delivery really came from this deployment and was not replayed or tampered with.
//
// NOTE on why this is not the server's `HmacSigner` (`@cat-factory/server` `auth/signing.ts`):
// that primitive mints self-contained TOKENS (`base64url(payload).base64url(mac)`) whose payload
// travels inside the signed string, and it is audience-keyed for the session/OAuth/container/ws
// token classes. A webhook needs the opposite shape — a signature DETACHED from a body the
// receiver already has — and, decisively, `@cat-factory/server` sits ABOVE this package in the
// layering, so importing it here would invert the dependency. The construction below is the plain
// Web Crypto HMAC-SHA256 both use underneath, so it runs unchanged on workerd and Node.

/** Header names a receiver reads to verify a delivery. */
export const WEBHOOK_SIGNATURE_HEADERS = {
  /** Epoch-ms the delivery was produced; part of the signed string (replay window). */
  timestamp: 'x-cat-factory-timestamp',
  /** `v1=<hex HMAC-SHA256>` over `<timestamp>.<body>`. */
  signature: 'x-cat-factory-signature',
} as const

/** The signature scheme version, so the format can change without silently breaking receivers. */
const SCHEME = 'v1'

/**
 * Sign a delivery body, returning the headers to send with it.
 *
 * The signed string is `<timestamp>.<body>`, NOT the body alone: binding the timestamp INTO the
 * MAC is what makes the timestamp header trustworthy, so a receiver can reject a replayed delivery
 * by rejecting an old timestamp. Signing the body alone would leave the timestamp freely rewritable
 * by anyone replaying the capture, making the whole replay window decorative.
 */
export async function signWebhookDelivery(
  secret: string,
  body: string,
  timestamp: number,
): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  )
  return {
    [WEBHOOK_SIGNATURE_HEADERS.timestamp]: String(timestamp),
    [WEBHOOK_SIGNATURE_HEADERS.signature]: `${SCHEME}=${toHex(new Uint8Array(mac))}`,
  }
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}
