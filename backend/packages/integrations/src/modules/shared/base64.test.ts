import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64, bytesToBase64Url, toBase64, toBase64Url } from './base64.js'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('bytesToBase64', () => {
  it('pads a partial final group', () => {
    expect(bytesToBase64(bytes(102))).toBe('Zg==')
    expect(bytesToBase64(bytes(102, 111))).toBe('Zm8=')
    expect(bytesToBase64(bytes(102, 111, 111))).toBe('Zm9v')
  })

  it('encodes nothing as nothing', () => {
    expect(bytesToBase64(bytes())).toBe('')
  })
})

describe('toBase64', () => {
  it('encodes UTF-8, not one byte per char', () => {
    // The reason this moved out of `tracker/`: a byte-per-char encode truncates a non-ASCII
    // character to its low byte, producing an HTTP Basic credential that is wrong in a way no
    // error names. `ä` is two bytes (0xC3 0xA4).
    expect(toBase64('ä')).toBe(bytesToBase64(bytes(0xc3, 0xa4)))
  })

  it('still matches the ASCII expectation the tracker relies on', () => {
    expect(toBase64('user:token')).toBe('dXNlcjp0b2tlbg==')
  })
})

describe('bytesToBase64Url', () => {
  it('substitutes the URL alphabet and drops the padding, as a JWT segment is encoded', () => {
    // 0xFB 0xFF encodes as `+/8=` in standard base64.
    expect(bytesToBase64(bytes(0xfb, 0xff))).toBe('+/8=')
    expect(bytesToBase64Url(bytes(0xfb, 0xff))).toBe('-_8')
  })

  it('round-trips a string through the URL form', () => {
    expect(base64ToBytes(toBase64Url('header.payload'))).toEqual(
      new TextEncoder().encode('header.payload'),
    )
  })
})

describe('base64ToBytes', () => {
  it('decodes with or without padding, and in either alphabet', () => {
    expect(base64ToBytes('Zm9v')).toEqual(bytes(102, 111, 111))
    expect(base64ToBytes('Zg==')).toEqual(bytes(102))
    expect(base64ToBytes('Zg')).toEqual(bytes(102))
    expect(base64ToBytes('-_8')).toEqual(bytes(0xfb, 0xff))
  })

  it('refuses a value that is not base64, rather than decoding its valid prefix', () => {
    // The one caller derives an HMAC key: a key silently decoded from the leading characters of a
    // malformed secret would sign every request with the wrong key and come back as a 401 blaming
    // the credential.
    expect(base64ToBytes('not base64 !!!')).toBeNull()
    expect(base64ToBytes('Zm9vYg')).not.toBeNull()
    // A length of 4n+1 cannot be base64 at all.
    expect(base64ToBytes('Zm9vZg')).not.toBeNull()
    expect(base64ToBytes('Z')).toBeNull()
  })

  it('tolerates surrounding whitespace, which a pasted secret carries', () => {
    expect(base64ToBytes('  Zm9v\n')).toEqual(bytes(102, 111, 111))
  })
})
