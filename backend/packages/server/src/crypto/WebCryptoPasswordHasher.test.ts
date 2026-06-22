import { describe, expect, it } from 'vitest'
import { WebCryptoPasswordHasher } from './WebCryptoPasswordHasher.js'

// PBKDF2-HMAC-SHA256 password hashing for the email/password login provider. The
// stored value is a self-describing PHC-like string; verify is constant-time and
// fails closed on anything malformed.

describe('WebCryptoPasswordHasher', () => {
  // A low iteration count keeps the unit test fast; the format/behaviour is identical.
  const hasher = new WebCryptoPasswordHasher(1000)

  it('hashes to a self-describing PHC-like string that does not contain the password', async () => {
    const stored = await hasher.hash('correct horse battery staple')
    expect(stored).toMatch(/^pbkdf2-sha256\$i=1000\$[^$]+\$[^$]+$/)
    expect(stored).not.toContain('correct horse battery staple')
  })

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hasher.hash('s3cret-password')
    expect(await hasher.verify('s3cret-password', stored)).toBe(true)
    expect(await hasher.verify('wrong-password', stored)).toBe(false)
  })

  it('uses a fresh salt per hash (distinct output for the same input, both verify)', async () => {
    const a = await hasher.hash('same-password')
    const b = await hasher.hash('same-password')
    expect(a).not.toBe(b)
    expect(await hasher.verify('same-password', a)).toBe(true)
    expect(await hasher.verify('same-password', b)).toBe(true)
  })

  it('verifies across hasher instances and honours the stored iteration count', async () => {
    const stored = await new WebCryptoPasswordHasher(2000).hash('pw')
    expect(stored).toContain('$i=2000$')
    // A different default still re-derives with the embedded iteration count.
    expect(await new WebCryptoPasswordHasher(500).verify('pw', stored)).toBe(true)
  })

  it('fails closed on a malformed stored value', async () => {
    expect(await hasher.verify('pw', 'not-a-hash')).toBe(false)
    expect(await hasher.verify('pw', 'pbkdf2-sha256$i=x$salt$hash')).toBe(false)
    expect(await hasher.verify('pw', '')).toBe(false)
  })

  it('flags a weaker-cost or malformed hash for rehash, not a current-cost one', async () => {
    const current = new WebCryptoPasswordHasher(2000)
    expect(current.needsRehash(await current.hash('pw'))).toBe(false)
    // A hash produced with fewer iterations should be upgraded on next login.
    expect(current.needsRehash(await new WebCryptoPasswordHasher(1000).hash('pw'))).toBe(true)
    // Anything unparseable is upgraded too (fail closed).
    expect(current.needsRehash('garbage')).toBe(true)
  })
})
