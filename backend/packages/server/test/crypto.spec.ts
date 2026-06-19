import { describe, expect, it } from 'vitest'
import {
  base64url,
  base64urlToBytes,
  pkcs8PemToDer,
  timingSafeEqual,
} from '../src/crypto/encoding.js'
import { HmacSigner, TOKEN_AUDIENCE } from '../src/auth/signing.js'

describe('base64url encoding', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255])
    expect(base64urlToBytes(base64url(bytes))).toEqual(bytes)
  })

  it('round-trips UTF-8 strings and emits url-safe, unpadded output', () => {
    const encoded = base64url('hello, мир 🌍')
    expect(encoded).not.toMatch(/[+/=]/)
    expect(new TextDecoder().decode(base64urlToBytes(encoded))).toBe('hello, мир 🌍')
  })
})

describe('timingSafeEqual', () => {
  it('is true only for equal-length, equal-content arrays', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false)
  })
})

describe('pkcs8PemToDer', () => {
  it('rejects a PKCS#1 key with an actionable message', () => {
    expect(() =>
      pkcs8PemToDer('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'),
    ).toThrow(/PKCS#8/)
  })
})

describe('HmacSigner', () => {
  const signer = new HmacSigner('a'.repeat(32))

  it('verifies a token it signed', async () => {
    const token = await signer.sign({ sub: 1, aud: TOKEN_AUDIENCE.session })
    expect(await signer.verify(token, { aud: TOKEN_AUDIENCE.session })).toMatchObject({ sub: 1 })
  })

  it('rejects an audience mismatch (cross-token-confusion defence)', async () => {
    const token = await signer.sign({ sub: 1, aud: TOKEN_AUDIENCE.container })
    expect(await signer.verify(token, { aud: TOKEN_AUDIENCE.session })).toBeNull()
  })

  it('rejects an expired token', async () => {
    const token = await signer.sign({ sub: 1, aud: TOKEN_AUDIENCE.session, exp: Date.now() - 1 })
    expect(await signer.verify(token, { aud: TOKEN_AUDIENCE.session })).toBeNull()
  })

  it('rejects a tampered payload and a wrong key', async () => {
    const token = await signer.sign({ sub: 1, aud: TOKEN_AUDIENCE.session })
    const [body, sig] = token.split('.')
    const tampered = `${base64url('{"sub":2,"aud":"session"}')}.${sig}`
    expect(await signer.verify(tampered)).toBeNull()
    expect(await new HmacSigner('different-secret-key-padding-1234').verify(token)).toBeNull()
    expect(body).toBeTruthy()
  })

  it('fails closed on malformed input rather than throwing', async () => {
    expect(await signer.verify(null)).toBeNull()
    expect(await signer.verify('no-dot')).toBeNull()
    expect(await signer.verify('.leadingdot')).toBeNull()
    expect(await signer.verify('body.@@@not-base64@@@')).toBeNull()
  })
})
