import { describe, expect, it } from 'vitest'
import { WebCryptoWebhookVerifier } from '../src/github/WebCryptoWebhookVerifier.js'

// GitHub signs the raw body with HMAC-SHA256 using the App's webhook secret.
const enc = new TextEncoder()

async function sign(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, body))
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `sha256=${hex}`
}

describe('WebCryptoWebhookVerifier', () => {
  const body = enc.encode('{"action":"opened"}').buffer as ArrayBuffer

  it('accepts a signature computed with the configured secret', async () => {
    const verifier = new WebCryptoWebhookVerifier('s3cret')
    expect(await verifier.verify(body, await sign('s3cret', body))).toBe(true)
  })

  it('rejects a signature computed with a different secret', async () => {
    const verifier = new WebCryptoWebhookVerifier('s3cret')
    expect(await verifier.verify(body, await sign('wrong', body))).toBe(false)
  })

  it('fails closed when the secret is empty', async () => {
    // An unconfigured secret must never verify — the guard rejects before importing an
    // empty HMAC key (which an attacker could otherwise use to sign their own body).
    const verifier = new WebCryptoWebhookVerifier('')
    expect(await verifier.verify(body, 'sha256=deadbeef')).toBe(false)
    // A well-formed 32-byte hex signature still fails closed on the empty secret.
    expect(await verifier.verify(body, `sha256=${'ab'.repeat(32)}`)).toBe(false)
  })

  it('rejects a missing or malformed signature header', async () => {
    const verifier = new WebCryptoWebhookVerifier('s3cret')
    expect(await verifier.verify(body, null)).toBe(false)
    expect(await verifier.verify(body, 'not-a-sig')).toBe(false)
    expect(await verifier.verify(body, 'sha256=zz')).toBe(false)
  })
})
