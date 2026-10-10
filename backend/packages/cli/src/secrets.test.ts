import { describe, expect, it } from 'vitest'
import { generateSecrets } from './secrets.js'

describe('generateSecrets', () => {
  it('emits a hex session secret, a base64 encryption key and a hex harness secret', () => {
    const { authSessionSecret, encryptionKey, harnessSharedSecret } = generateSecrets()
    // 32 bytes hex = 64 chars, and the server requires >= 32 chars.
    expect(authSessionSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(authSessionSecret.length).toBeGreaterThanOrEqual(32)
    // base64 of 32 bytes decodes back to 32 bytes (the cipher's minimum).
    expect(Buffer.from(encryptionKey, 'base64')).toHaveLength(32)
    // 32 bytes hex = 64 chars, comfortably over the loader's >= 16 minimum.
    expect(harnessSharedSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(harnessSharedSecret.length).toBeGreaterThanOrEqual(16)
  })

  it('uses the injected RNG deterministically', () => {
    const fixed = (size: number) => Buffer.alloc(size, 7)
    const a = generateSecrets(fixed)
    const b = generateSecrets(fixed)
    expect(a).toEqual(b)
    expect(a.authSessionSecret).toBe('07'.repeat(32))
  })

  it('produces distinct values across calls with the real RNG', () => {
    expect(generateSecrets().encryptionKey).not.toBe(generateSecrets().encryptionKey)
  })
})
