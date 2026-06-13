// Small encoding helpers for the GitHub App crypto, built on what the Workers
// runtime provides natively (atob/btoa, TextEncoder, Web Crypto). No Node
// `Buffer` or `crypto` module is used, so this works in plain V8 isolates.

/** Base64url-encode bytes or a UTF-8 string (no padding), per JWT/JWS. */
export function base64url(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array
  if (typeof input === 'string') bytes = new TextEncoder().encode(input)
  else if (input instanceof Uint8Array) bytes = input
  else bytes = new Uint8Array(input)

  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode a base64url string to bytes. */
export function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Decode a PEM private key body to DER bytes. Requires PKCS#8
 * (`-----BEGIN PRIVATE KEY-----`); GitHub issues PKCS#1
 * (`-----BEGIN RSA PRIVATE KEY-----`), which must be converted once via
 * `openssl pkcs8 -topk8 -nocrypt` (see backend/docs/github-operations.md).
 */
export function pkcs8PemToDer(pem: string): ArrayBuffer {
  if (/BEGIN RSA PRIVATE KEY/.test(pem)) {
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is PKCS#1 (BEGIN RSA PRIVATE KEY); convert it to PKCS#8 ' +
        'with `openssl pkcs8 -topk8 -nocrypt -in key.pem -out key.pk8.pem`',
    )
  }
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

/** Constant-time-ish equality for two byte arrays (length + XOR accumulation). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
