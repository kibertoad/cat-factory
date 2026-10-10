// Runtime-neutral base64, for the integrations that have to build a credential by hand.
//
// Hand-rolled rather than reaching for `btoa`/`atob` (DOM lib) or `Buffer` (Node lib) so this
// package keeps compiling and behaving identically on workerd and on Node. It started as the
// Jira Basic-auth encoder under `tracker/`; it moved here when the service-catalog integration
// needed the same encode for its own Basic mode plus the two halves a JWT needs (base64URL of a
// byte array, and the DECODE of a shared secret into HMAC key bytes).
//
// The string entry point encodes UTF-8 rather than one byte per char, which is what HTTP Basic
// and JWT both specify: a byte-per-char encode silently truncates any non-ASCII character in a
// password to its low byte, producing a credential that is wrong in a way no error names.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 of `bytes`, padded. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0
    out += ALPHABET[b0 >> 2]
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : '='
  }
  return out
}

/** Base64URL of `bytes`, unpadded, as every JWT segment is encoded. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Base64 of `input`'s UTF-8 bytes. */
export function toBase64(input: string): string {
  return bytesToBase64(new TextEncoder().encode(input))
}

/** Base64URL of `input`'s UTF-8 bytes. */
export function toBase64Url(input: string): string {
  return bytesToBase64Url(new TextEncoder().encode(input))
}

const REVERSE = new Map<string, number>(
  [...ALPHABET].map((character, index) => [character, index] as const),
)

/**
 * The bytes `value` encodes, or null when it is not base64 at all.
 *
 * Accepts base64URL (`-`/`_`) and a missing tail of `=` padding, because both forms turn up in
 * secrets an operator pasted from somewhere else. Returns NULL rather than a best-effort decode
 * of the prefix: the one caller is deriving an HMAC key, and a key silently decoded from the
 * leading valid characters of a malformed secret would sign every request with the wrong key and
 * fail as an authorization error that names the credential rather than its encoding.
 */
export function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value
    .trim()
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '')
    .replace(/\s+/g, '')
  if (normalized.length % 4 === 1) return null
  const out = new Uint8Array(Math.floor((normalized.length * 3) / 4))
  let offset = 0
  let buffer = 0
  let bits = 0
  for (const character of normalized) {
    const index = REVERSE.get(character)
    if (index === undefined) return null
    buffer = (buffer << 6) | index
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[offset++] = (buffer >> bits) & 0xff
    }
  }
  return out.subarray(0, offset)
}
