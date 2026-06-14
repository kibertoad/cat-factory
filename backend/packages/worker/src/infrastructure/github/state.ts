import { base64url, timingSafeEqual, base64urlToBytes } from './encoding'

// Signs the `state` parameter carried through the GitHub App install flow. The
// state binds the resulting installation to the workspace that initiated it; a
// returning callback must present a state we signed, so a third party cannot
// trick us into binding their installation to someone else's workspace.
//
// Format: `<workspaceId>.<base64url(HMAC-SHA256(workspaceId))>`.

export class StateSigner {
  private keyPromise?: Promise<CryptoKey>

  constructor(private readonly secret: string) {}

  async sign(workspaceId: string): Promise<string> {
    const mac = await this.mac(workspaceId)
    return `${workspaceId}.${base64url(mac)}`
  }

  /** Return the workspaceId if `state` carries a valid signature, else null. */
  async verify(state: string | null): Promise<string | null> {
    if (!state) return null
    const dot = state.lastIndexOf('.')
    if (dot <= 0) return null
    const workspaceId = state.slice(0, dot)
    // A malformed base64url signature must fail closed, not throw out of `atob`.
    let provided: Uint8Array
    try {
      provided = base64urlToBytes(state.slice(dot + 1))
    } catch {
      return null
    }
    const expected = new Uint8Array(await this.mac(workspaceId))
    return timingSafeEqual(provided, expected) ? workspaceId : null
  }

  private async mac(workspaceId: string): Promise<ArrayBuffer> {
    const key = await this.importKey()
    return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(workspaceId))
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
