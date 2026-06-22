import { base64url, base64urlToBytes, timingSafeEqual } from '../crypto/encoding.js'

// Signs the `state` parameter carried through the GitHub App install flow. The
// state binds the resulting installation to the workspace that initiated it AND
// to the signed-in user who started the flow, and carries a short expiry — so a
// returning callback must present a state we issued, recently, for a known
// owner. A third party cannot forge one to bind their installation to someone
// else's workspace, and a captured state cannot be replayed indefinitely.
//
// Format: `base64url(JSON payload).base64url(HMAC-SHA256(base64url(JSON)))`.

/** Claims carried through the install round-trip. */
export interface InstallState {
  workspaceId: string
  /** Internal user id that initiated the install (null when auth is disabled). */
  userId: string | null
  /** Absolute expiry, epoch ms. */
  exp: number
}

export class StateSigner {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly secret: string) {}

  async sign(state: InstallState): Promise<string> {
    const body = base64url(JSON.stringify(state))
    return `${body}.${base64url(await this.mac(body))}`
  }

  /** Return the claims if `state` carries a valid, unexpired signature, else null. */
  async verify(state: string | null): Promise<InstallState | null> {
    if (!state) return null
    const dot = state.indexOf('.')
    if (dot <= 0 || dot === state.length - 1) return null
    const body = state.slice(0, dot)
    // A malformed base64url signature must fail closed, not throw out of `atob`.
    let provided: Uint8Array
    try {
      provided = base64urlToBytes(state.slice(dot + 1))
    } catch {
      return null
    }
    const expected = new Uint8Array(await this.mac(body))
    if (!timingSafeEqual(provided, expected)) return null

    let payload: InstallState
    try {
      payload = JSON.parse(new TextDecoder().decode(base64urlToBytes(body))) as InstallState
    } catch {
      return null
    }
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    if (typeof payload.workspaceId !== 'string' || payload.workspaceId === '') return null
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
