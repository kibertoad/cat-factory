import type { SecretCipher } from '@cat-factory/kernel'
import { base64url, base64urlToBytes } from '../github/encoding'

// Authenticated encryption of credentials at rest, on Web Crypto (AES-256-GCM)
// — no Node `crypto`, runs in a plain Workers isolate. A service-level master key
// (the `ENVIRONMENTS_ENCRYPTION_KEY` secret) is imported once for HKDF; every
// record derives a fresh AES key from a random per-record salt and is sealed
// under a random per-record IV. The self-describing envelope carries a version
// tag so the scheme/key can be rotated later without ambiguity.
//
//   envelope = "v1." + base64url(salt) + "." + base64url(iv) + "." + base64url(ciphertext|tag)

const VERSION = 'v1'
const SALT_BYTES = 16
const IV_BYTES = 12
/** Default HKDF domain-separation tag (used by the environments integration). */
const DEFAULT_INFO = 'cat-factory:environments'

export interface WebCryptoSecretCipherOptions {
  /** Service-level master key, base64 (≥32 bytes decoded). */
  masterKeyBase64: string
  /**
   * HKDF `info` string, separating the keys derived for distinct uses of the
   * same (or a shared) master key — e.g. environment secrets vs document-source
   * credentials. Defaults to the environments tag for backward compatibility.
   * Ciphertext is only decryptable by a cipher built with the same `info`.
   */
  info?: string
}

export class WebCryptoSecretCipher implements SecretCipher {
  private readonly masterKey: Uint8Array
  private readonly info: Uint8Array
  private baseKeyPromise?: Promise<CryptoKey>

  constructor({ masterKeyBase64, info }: WebCryptoSecretCipherOptions) {
    this.masterKey = base64urlToBytes(masterKeyBase64.trim())
    if (this.masterKey.length < 32) {
      throw new Error('encryption key must decode to at least 32 bytes')
    }
    this.info = new TextEncoder().encode(info ?? DEFAULT_INFO)
  }

  async encrypt(plaintext: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = await this.deriveKey(salt)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(plaintext),
    )
    return [VERSION, base64url(salt), base64url(iv), base64url(new Uint8Array(sealed))].join('.')
  }

  async decrypt(envelope: string): Promise<string> {
    const parts = envelope.split('.')
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new Error('Invalid secret envelope')
    }
    const salt = base64urlToBytes(parts[1]!)
    const iv = base64urlToBytes(parts[2]!)
    const ciphertext = base64urlToBytes(parts[3]!)
    const key = await this.deriveKey(salt)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    return new TextDecoder().decode(plain)
  }

  private baseKey(): Promise<CryptoKey> {
    if (!this.baseKeyPromise) {
      this.baseKeyPromise = crypto.subtle.importKey('raw', this.masterKey, 'HKDF', false, [
        'deriveKey',
      ])
    }
    return this.baseKeyPromise
  }

  private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: this.info },
      await this.baseKey(),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  }
}
