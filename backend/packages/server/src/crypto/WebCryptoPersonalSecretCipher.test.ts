import { describe, expect, it } from 'vitest'
import { WebCryptoPersonalSecretCipher } from './WebCryptoPersonalSecretCipher.js'

// The password-derived (PBKDF2 → AES-GCM) inner layer for individual-usage credentials.
// No master key — only the password — so a wrong password (or no password) can't open it.

describe('WebCryptoPersonalSecretCipher', () => {
  const cipher = new WebCryptoPersonalSecretCipher()

  it('round-trips a secret with the correct password', async () => {
    const sealed = await cipher.seal('sk-ant-oat01-secret', 'correct horse battery')
    expect(sealed).toMatch(/^pv1\./)
    expect(sealed).not.toContain('sk-ant-oat01-secret')
    expect(await cipher.open(sealed, 'correct horse battery')).toBe('sk-ant-oat01-secret')
  })

  it('throws an actionable error (not the raw DOMException) on a wrong password', async () => {
    const sealed = await cipher.seal('TOKEN', 'right-password')
    const err = (await cipher.open(sealed, 'wrong-password').catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    // Names the cause + remedy, not the opaque Web Crypto "operation-specific reason"
    // DOMException (which is preserved as `cause`).
    expect(err.message).toMatch(/personal password does not match/i)
    expect(err.message).not.toBe('The operation failed for an operation-specific reason')
    expect(err.cause).toBeDefined()
  })

  it('uses a fresh salt/iv per seal (distinct ciphertext for the same input)', async () => {
    const a = await cipher.seal('TOKEN', 'pw-pw-pw-pw')
    const b = await cipher.seal('TOKEN', 'pw-pw-pw-pw')
    expect(a).not.toBe(b)
    expect(await cipher.open(a, 'pw-pw-pw-pw')).toBe('TOKEN')
    expect(await cipher.open(b, 'pw-pw-pw-pw')).toBe('TOKEN')
  })

  it('rejects a malformed envelope with an actionable message', async () => {
    await expect(cipher.open('not-an-envelope', 'pw')).rejects.toThrow(
      /not a valid encryption envelope/i,
    )
  })

  it('rejects a well-structured envelope with an undecodable (corrupt) segment', async () => {
    // 4 segments + the right version prefix, but the base64url body is corrupt so `atob`
    // rejects it. This must still surface the actionable envelope message (with the raw
    // decode error kept as `cause`), not leak a bare `InvalidCharacterError` DOMException.
    const err = (await cipher.open('pv1.@@@.@@@.@@@', 'pw').catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/not a valid encryption envelope/i)
    expect(err.cause).toBeDefined()
  })
})
