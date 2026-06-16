import { base64url, base64urlToBytes, timingSafeEqual } from '../github/encoding'

// Stateless signed tokens for the auth flow, built on Web Crypto (HMAC-SHA256)
// like the GitHub install `StateSigner` — no Node `crypto`, runs in a plain
// Workers isolate. The same primitive (and the same AUTH_SESSION_SECRET) backs
// several distinct token classes:
//   - the *session token* the SPA carries as `Authorization: Bearer`
//   - the OAuth *state* nonce that protects the login round-trip from CSRF
//   - the *container* token an implementation container uses against the LLM proxy
//   - the short-lived *ws ticket* that authorises one WebSocket event stream
//
// Because they share a key and verifier, every token MUST carry an `aud`
// (audience) claim and every verifier MUST pin the audience it expects, so a
// token minted for one purpose cannot be replayed as another (e.g. a container
// proxy token acting as a full user session). `verify` rejects any token whose
// `aud` does not match the caller's expected audience.
//
// Format: `base64url(JSON payload).base64url(HMAC(base64url(JSON payload)))`.
// The payload is base64url (no dots), so the dot split is unambiguous. Payloads
// carrying an `exp` (epoch ms) are rejected once expired. There is no server-side
// store: logout is a client-side drop and expiry bounds the blast radius.

/** Distinct token audiences. Each verifier pins exactly one of these. */
export const TOKEN_AUDIENCE = {
  /** SPA user session (Authorization: Bearer). */
  session: 'session',
  /** OAuth login `state` nonce. */
  oauthState: 'oauth-state',
  /** Implementation-container → LLM proxy token. */
  container: 'llm-proxy',
  /** Single-workspace WebSocket event-stream ticket. */
  wsTicket: 'ws',
} as const

export type TokenAudience = (typeof TOKEN_AUDIENCE)[keyof typeof TOKEN_AUDIENCE]

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
  /** Audience pin — always `session` for a user session. */
  aud: typeof TOKEN_AUDIENCE.session
  exp: number
}

export class HmacSigner {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly secret: string) {}

  async sign(payload: object): Promise<string> {
    const body = base64url(JSON.stringify(payload))
    return `${body}.${base64url(await this.mac(body))}`
  }

  /**
   * Return the payload when the signature is valid, unexpired, and (when an
   * expected audience is given) carries a matching `aud` claim; else null.
   *
   * `opts.aud` is REQUIRED in practice for every protected verification: it pins
   * the token class so a token minted for another audience (e.g. a container
   * proxy token) cannot be replayed here. It is optional only so the same
   * primitive can verify legacy/audience-less payloads in tests.
   */
  async verify<T extends object>(
    token: string | null | undefined,
    opts?: { aud?: TokenAudience },
  ): Promise<T | null> {
    if (!token) return null
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) return null
    const body = token.slice(0, dot)

    // Decode the signature segment defensively: a malformed base64url tail must
    // fail closed (null → 401), never throw out of `atob` into a 500.
    let provided: Uint8Array
    try {
      provided = base64urlToBytes(token.slice(dot + 1))
    } catch {
      return null
    }
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
    // Audience pin: when the caller expects a specific audience, the token's
    // `aud` must match exactly. This is the cross-token-confusion defence.
    if (opts?.aud !== undefined && (payload as { aud?: unknown }).aud !== opts.aud) return null
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
