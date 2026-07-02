import { base64url, base64urlToBytes, timingSafeEqual } from '../crypto/encoding.js'

// Stateless signed tokens for the auth flow, built on Web Crypto (HMAC-SHA256) —
// no Node `crypto` module, so it runs in a plain Workers isolate and in Node. The
// same primitive (and the same session secret) backs several distinct token classes:
//   - the *session token* the SPA carries as `Authorization: Bearer`
//   - the OAuth *state* nonce that protects the login round-trip from CSRF
//   - the *container* token an implementation container uses against the LLM proxy
//   - the short-lived *ws ticket* that authorises one WebSocket event stream
//
// Because they share a secret and verifier, every token MUST carry an `aud`
// (audience) claim and every verifier MUST pin the audience it expects, so a
// token minted for one purpose cannot be replayed as another (e.g. a container
// proxy token acting as a full user session). `verify` rejects any token whose
// `aud` does not match the caller's expected audience.
//
// Beyond that pin, each audience is signed with its OWN key: the master secret is
// run through HKDF-SHA256 with a per-audience `info` tag to derive an independent
// 256-bit subkey. So a token class is cryptographically isolated — a signature made
// under one audience's key can't validate under another's even before the `aud`
// check — and the effective HMAC key is a full-entropy 32 bytes rather than the raw
// secret string. (Audience-less payloads — tests/legacy — fall back to the raw secret.)
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
  /**
   * Machine-to-machine token a mothership-mode local node presents on the `/internal/*`
   * API. Carries the accounts the node is authorised for; pinned so a user session /
   * container / ws ticket can never be replayed against the persistence RPC.
   */
  machine: 'machine',
} as const

export type TokenAudience = (typeof TOKEN_AUDIENCE)[keyof typeof TOKEN_AUDIENCE]

/** Identity we surface to the client. */
export interface SessionUser {
  /** Internal user id (`usr_*`) — stable across login providers. */
  id: string
  /** Display handle (GitHub login for GitHub users, else email/local-part). */
  login: string
  name: string | null
  avatarUrl: string | null
  /** Primary email, when known. */
  email?: string | null
}

/** A signed session: the user plus an absolute expiry (epoch ms). */
export interface SessionPayload extends SessionUser {
  /** Audience pin — always `session` for a user session. */
  aud: typeof TOKEN_AUDIENCE.session
  exp: number
}

/**
 * A signed machine token for a mothership-mode local node. Minted by the mothership
 * after a whitelisted login (or provisioned for headless nodes); presented on every
 * `/internal/*` call. `scope.accountIds` bounds which accounts the node may touch — the
 * persistence RPC rejects (404) any call resolving to an account outside this set.
 */
export interface MachinePayload {
  aud: typeof TOKEN_AUDIENCE.machine
  /** Stable id of the local node this token was minted for (telemetry / revocation). */
  nodeId: string
  /** The mothership user the node acts as (set during login onboarding). */
  userId: string
  /** Accounts this node is authorised to read/write. */
  scope: { accountIds: string[] }
  /** Absolute expiry (epoch ms). */
  exp: number
}

/** HKDF `info` tag for a token audience's derived signing subkey. */
function audienceInfo(aud: string): string {
  return `cat-factory:token:${aud}`
}

export class HmacSigner {
  /** Per-audience signing keys, keyed by the `aud` string (`''` = the raw-secret base key). */
  private readonly keyCache = new Map<string, Promise<CryptoKey>>()

  constructor(private readonly secret: string) {}

  async sign(payload: object): Promise<string> {
    const body = base64url(JSON.stringify(payload))
    return `${body}.${base64url(await this.mac(body, audienceOf(payload)))}`
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

    // Decode the signature + payload defensively: a malformed base64url tail or a
    // non-JSON body must fail closed (null → 401), never throw out of `atob` into a 500.
    let provided: Uint8Array
    let payload: T
    try {
      provided = base64urlToBytes(token.slice(dot + 1))
      payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body))) as T
    } catch {
      return null
    }

    // Select the signing key from the token's CLAIMED audience so it matches whatever
    // `sign` used. Reading the claimed `aud` before verifying is safe: it only chooses
    // which key the MAC is checked against, and forging still requires that key. The
    // caller's `opts.aud` pin below is the actual cross-token-confusion defence.
    const expected = new Uint8Array(await this.mac(body, audienceOf(payload)))
    if (!timingSafeEqual(provided, expected)) return null

    const exp = (payload as { exp?: unknown }).exp
    if (typeof exp === 'number' && exp < Date.now()) return null
    // Audience pin: when the caller expects a specific audience, the token's
    // `aud` must match exactly. This is the cross-token-confusion defence.
    if (opts?.aud !== undefined && (payload as { aud?: unknown }).aud !== opts.aud) return null
    return payload
  }

  private async mac(input: string, aud?: string): Promise<ArrayBuffer> {
    const key = await this.keyFor(aud)
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))
  }

  /** The HMAC signing key for an audience (HKDF-derived), memoised; base key when absent. */
  private keyFor(aud?: string): Promise<CryptoKey> {
    const cacheKey = aud ?? ''
    let key = this.keyCache.get(cacheKey)
    if (!key) {
      key = aud === undefined ? this.importBaseKey() : this.deriveAudienceKey(aud)
      this.keyCache.set(cacheKey, key)
    }
    return key
  }

  /** Raw-secret HMAC key — the fallback for audience-less (test/legacy) payloads. */
  private importBaseKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  }

  /**
   * Derive an independent 256-bit HMAC key for one audience: import the master secret as
   * HKDF key material, expand it with a per-audience `info` tag, and import the result as
   * the signing key. Isolates each token class cryptographically from the others.
   */
  private async deriveAudienceKey(aud: string): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(this.secret),
      'HKDF',
      false,
      ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(audienceInfo(aud)),
      },
      material,
      256,
    )
    return crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  }
}

/** The `aud` claim of a payload as a string, or undefined (⇒ the raw-secret base key). */
function audienceOf(payload: object): string | undefined {
  const aud = (payload as { aud?: unknown }).aud
  return typeof aud === 'string' ? aud : undefined
}
