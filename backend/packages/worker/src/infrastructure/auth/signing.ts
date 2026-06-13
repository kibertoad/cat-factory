import { base64url, base64urlToBytes, timingSafeEqual } from '../github/encoding'

// Stateless signed tokens for the auth flow, built on Web Crypto (HMAC-SHA256)
// like the GitHub install `StateSigner` — no Node `crypto`, runs in a plain
// Workers isolate. The same primitive backs two things:
//   - the *session token* the SPA carries as `Authorization: Bearer`
//   - the OAuth *state* nonce that protects the login round-trip from CSRF
//
// Format: `base64url(JSON payload).base64url(HMAC(base64url(JSON payload)))`.
// The payload is base64url (no dots), so the dot split is unambiguous. Payloads
// carrying an `exp` (epoch ms) are rejected once expired. There is no server-side
// store: logout is a client-side drop and expiry bounds the blast radius.

/** Identity we trust from GitHub and surface to the client. */
export interface SessionUser {
  /** GitHub user id (stable across renames). */
  id: number
  login: string
  name: string | null
  avatarUrl: string | null
}

/** A signed session: the user plus an absolute expiry (epoch ms). */
export interface SessionPayload extends SessionUser {
  exp: number
}

export class HmacSigner {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly secret: string) {}

  async sign(payload: object): Promise<string> {
    const body = base64url(JSON.stringify(payload))
    return `${body}.${base64url(await this.mac(body))}`
  }

  /** Return the payload when the signature is valid and unexpired, else null. */
  async verify<T extends object>(token: string | null | undefined): Promise<T | null> {
    if (!token) return null
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) return null
    const body = token.slice(0, dot)
    const provided = base64urlToBytes(token.slice(dot + 1))
    const expected = new Uint8Array(await this.mac(body))
    if (!timingSafeEqual(provided, expected)) return null

    let payload: T
    try {
      payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body))) as T
    } catch {
      return null
    }
    const exp = (payload as { exp?: unknown }).exp
    if (typeof exp === 'number' && exp < Date.now()) return null
    return payload
  }

  private async mac(input: string): Promise<ArrayBuffer> {
    const key = await this.importKey()
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))
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
