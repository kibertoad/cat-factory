import type { WebhookVerifier } from '@cat-factory/kernel'
import { timingSafeEqual } from './encoding'

// Verifies GitHub webhook deliveries: GitHub signs the raw body with
// HMAC-SHA-256 using the App's webhook secret and sends `sha256=<hex>` in the
// `X-Hub-Signature-256` header. We recompute the digest with Web Crypto and
// compare in constant time. Built on the *raw* body bytes (verification must
// happen before any JSON parse).

const PREFIX = 'sha256='

export class WebCryptoWebhookVerifier implements WebhookVerifier {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly secret: string) {}

  async verify(rawBody: ArrayBuffer, signatureHeader: string | null): Promise<boolean> {
    if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return false
    const provided = hexToBytes(signatureHeader.slice(PREFIX.length))
    if (!provided) return false

    const key = await this.importKey()
    const computed = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody))
    return timingSafeEqual(provided, computed)
  }

  private importKey(): Promise<CryptoKey> {
    if (!this.keyPromise) {
      this.keyPromise = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      )
    }
    return this.keyPromise
  }
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
