import type { PersonalSecretCipher } from '@cat-factory/kernel'
import { base64url, base64urlToBytes } from './encoding.js'

// The SECOND, password-derived encryption layer for individual-usage subscriptions
// (see the PersonalSecretCipher port). A key is derived from the user's personal
// password via PBKDF2-HMAC-SHA256 (random per-record salt) and used for AES-256-GCM.
// No master key is involved — only the password the user types — so the resulting
// envelope is undecryptable without it. The system SecretCipher is layered on top of
// this envelope at rest, so recovering a credential needs BOTH the system key AND the
// user's password.
//
//   envelope = "pv1." + base64url(salt) + "." + base64url(iv) + "." + base64url(MAGIC|plaintext sealed)
//
// A fixed MAGIC prefix is sealed with the plaintext so a wrong password is detected
// deterministically (in addition to the GCM auth tag), surfaced to the caller as a
// thrown error which the service maps to a `wrong_password` credential error.

const VERSION = 'pv1'
const SALT_BYTES = 16
const IV_BYTES = 12
// OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023). Runs once per unlock, not per
// step, so the cost is paid at task start/retry only.
const PBKDF2_ITERATIONS = 210_000
const MAGIC = 'cfpers1:'

export class WebCryptoPersonalSecretCipher implements PersonalSecretCipher {
  async seal(plaintext: string, password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const key = await deriveKey(password, salt)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(MAGIC + plaintext),
    )
    return [VERSION, base64url(salt), base64url(iv), base64url(new Uint8Array(sealed))].join('.')
  }

  async open(envelope: string, password: string): Promise<string> {
    // Parse the `pv1.` envelope up front. A wrong structure OR an undecodable segment
    // (base64url that `atob` rejects — a mid-envelope corruption) both mean the stored
    // value is malformed: the ciphertext never even reaches the decrypt, so this is NOT a
    // wrong password — the column is truncated/corrupted, or was written by a different
    // scheme/version. Both funnel through one actionable message (original kept as `cause`).
    let salt: Uint8Array<ArrayBuffer>
    let iv: Uint8Array<ArrayBuffer>
    let ciphertext: Uint8Array<ArrayBuffer>
    try {
      const parts = envelope.split('.')
      if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error(`unexpected envelope structure (${parts.length} segments)`)
      }
      salt = base64urlToBytes(parts[1]!) as Uint8Array<ArrayBuffer>
      iv = base64urlToBytes(parts[2]!) as Uint8Array<ArrayBuffer>
      ciphertext = base64urlToBytes(parts[3]!) as Uint8Array<ArrayBuffer>
    } catch (e) {
      throw new Error(
        'The stored personal subscription credential is not a valid encryption envelope: ' +
          'it is truncated or corrupted, or was written by a different scheme/version. ' +
          'Remove and re-add the subscription to re-seal it.',
        { cause: e },
      )
    }
    const key = await deriveKey(password, salt)
    let plain: ArrayBuffer
    try {
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
    } catch (e) {
      // AES-GCM authentication failed. For this password-derived layer that almost
      // always means the WRONG PASSWORD: the key is derived from the personal password,
      // so a mismatch can't reproduce the auth tag. The raw failure is the opaque Web
      // Crypto DOMException ("operation-specific reason"); rethrow an actionable message
      // (original kept as `cause`). The service maps this to a `wrong_password` 428.
      throw new Error(
        'The personal password does not match the one this subscription was sealed under — ' +
          're-enter it, or remove and re-add the subscription.',
        { cause: e },
      )
    }
    const text = new TextDecoder().decode(plain)
    if (!text.startsWith(MAGIC)) {
      // GCM verified but the sealed magic prefix is absent — the stored value is corrupted
      // or was sealed by a different scheme, not a simple wrong password.
      throw new Error(
        'This personal subscription credential failed its integrity check — the stored value ' +
          'is corrupted or was sealed by a different scheme. Remove and re-add the subscription.',
      )
    }
    return text.slice(MAGIC.length)
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations: PBKDF2_ITERATIONS,
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}
