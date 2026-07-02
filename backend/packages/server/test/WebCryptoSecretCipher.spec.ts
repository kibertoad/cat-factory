import { describe, expect, it } from 'vitest'
import { WebCryptoSecretCipher } from '../src/crypto/WebCryptoSecretCipher.js'

// A 32-byte master key, base64. Two DISTINCT keys model the incident: a credential sealed
// under one ENCRYPTION_KEY and read back after the key was rotated/regenerated.
const KEY_A = Buffer.alloc(32, 1).toString('base64')
const KEY_B = Buffer.alloc(32, 2).toString('base64')

describe('WebCryptoSecretCipher', () => {
  it('round-trips a secret under the same master key', async () => {
    const cipher = new WebCryptoSecretCipher({ masterKeyBase64: KEY_A })
    const sealed = await cipher.encrypt('sk-secret')
    expect(sealed).not.toContain('sk-secret')
    expect(await cipher.decrypt(sealed)).toBe('sk-secret')
  })

  it('rejects a malformed envelope up front', async () => {
    const cipher = new WebCryptoSecretCipher({ masterKeyBase64: KEY_A })
    await expect(cipher.decrypt('not-an-envelope')).rejects.toThrow('Invalid secret envelope')
  })

  it('surfaces an actionable error when the master key no longer matches (rotated key)', async () => {
    const sealed = await new WebCryptoSecretCipher({ masterKeyBase64: KEY_A }).encrypt('sk-secret')
    const withRotatedKey = new WebCryptoSecretCipher({ masterKeyBase64: KEY_B })
    const err = (await withRotatedKey.decrypt(sealed).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    // Actionable — names ENCRYPTION_KEY and the likely rotation cause, not the opaque
    // Web Crypto "operation-specific reason" DOMException (which is kept as `cause`).
    expect(err.message).toContain('ENCRYPTION_KEY')
    expect(err.message).not.toBe('The operation failed for an operation-specific reason')
    expect((err as Error).cause).toBeDefined()
  })

  it('domain-separates by HKDF info: a secret sealed under one info is unreadable under another', async () => {
    const sealed = await new WebCryptoSecretCipher({
      masterKeyBase64: KEY_A,
      info: 'cat-factory:providers',
    }).encrypt('sk-secret')
    const other = new WebCryptoSecretCipher({ masterKeyBase64: KEY_A, info: 'cat-factory:slack' })
    await expect(other.decrypt(sealed)).rejects.toThrow('ENCRYPTION_KEY')
  })
})
