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

  it('throws on a wrong password', async () => {
    const sealed = await cipher.seal('TOKEN', 'right-password')
    await expect(cipher.open(sealed, 'wrong-password')).rejects.toThrow()
  })

  it('uses a fresh salt/iv per seal (distinct ciphertext for the same input)', async () => {
    const a = await cipher.seal('TOKEN', 'pw-pw-pw-pw')
    const b = await cipher.seal('TOKEN', 'pw-pw-pw-pw')
    expect(a).not.toBe(b)
    expect(await cipher.open(a, 'pw-pw-pw-pw')).toBe('TOKEN')
    expect(await cipher.open(b, 'pw-pw-pw-pw')).toBe('TOKEN')
  })

  it('rejects a malformed envelope', async () => {
    await expect(cipher.open('not-an-envelope', 'pw')).rejects.toThrow()
  })
})
