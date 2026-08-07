import { describe, expect, it } from 'vitest'
import { verifyDelivery } from '../src/webhook/signature'

const SECRET = 'test-webhook-secret-0123456789ab'
const NOW = 1_800_000_000_000

// The MAC the platform sends, computed here the way its docs state it: HMAC-SHA256 over
// `"<timestamp>.<raw body>"`. Written out rather than imported from the product so the two
// implementations are genuinely independent; a shared helper would pass even if both were wrong.
async function sign(timestamp: number, rawBody: string, secret = SECRET): Promise<string> {
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
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  )
  const hex = [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `v1=${hex}`
}

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('verifyDelivery', () => {
  const body = '{"deliveryId":"exec_9:run.completed","sentAt":1800000000000}'

  it('accepts a delivery the platform signed', async () => {
    const result = await verifyDelivery(
      headers({
        'x-cat-factory-timestamp': String(NOW),
        'x-cat-factory-signature': await sign(NOW, body),
      }),
      body,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: true })
  })

  // The reason vocabulary is the point of the discriminated result: an unconfigured endpoint and
  // an attacker probing one need opposite reactions, and a boolean cannot tell them apart.
  it.each([
    ['missing_signature', {}],
    ['malformed_signature', { 'x-cat-factory-signature': 'sha256=deadbeef' }],
    ['malformed_signature', { 'x-cat-factory-signature': 'v1=nothex!!' }],
  ])('refuses with %s', async (reason, extra) => {
    const result = await verifyDelivery(
      headers({ 'x-cat-factory-timestamp': String(NOW), ...extra }),
      body,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: false, reason })
  })

  it('refuses a delivery with no timestamp', async () => {
    const result = await verifyDelivery(
      headers({ 'x-cat-factory-signature': await sign(NOW, body) }),
      body,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: false, reason: 'missing_timestamp' })
  })

  // The timestamp is bound INTO the MAC, which is what makes this a replay defence rather than a
  // field an attacker can set: a stale delivery re-sent verbatim keeps its own stamp.
  it('refuses a correctly-signed delivery from outside the skew window', async () => {
    const stale = NOW - 10 * 60 * 1000
    const result = await verifyDelivery(
      headers({
        'x-cat-factory-timestamp': String(stale),
        'x-cat-factory-signature': await sign(stale, body),
      }),
      body,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('refuses a signature made with a different secret', async () => {
    const result = await verifyDelivery(
      headers({
        'x-cat-factory-timestamp': String(NOW),
        'x-cat-factory-signature': await sign(NOW, body, 'a-different-secret-0123456789'),
      }),
      body,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })

  // The MAC covers BYTES. A receiver that parsed first and re-serialized to verify would compare
  // a reconstruction against a signature over the original, and would accept this.
  it('refuses a body whose bytes changed but whose JSON value did not', async () => {
    const spaced = '{ "deliveryId": "exec_9:run.completed", "sentAt": 1800000000000 }'
    const reserialized = JSON.stringify(JSON.parse(spaced))
    expect(reserialized).not.toBe(spaced)

    const result = await verifyDelivery(
      headers({
        'x-cat-factory-timestamp': String(NOW),
        'x-cat-factory-signature': await sign(NOW, spaced),
      }),
      reserialized,
      SECRET,
      NOW,
    )
    expect(result).toEqual({ ok: false, reason: 'bad_signature' })
  })
})
