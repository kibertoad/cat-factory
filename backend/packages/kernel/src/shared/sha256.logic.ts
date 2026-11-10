// Web Crypto is a global in both workerd and Node, but the kernel compiles against the
// ES2022 lib only (no DOM/WebWorker), so reach it through `globalThis` with a minimal
// local type instead of pulling in the DOM lib.
interface MinimalSubtleCrypto {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>
}
const webCryptoSubtle = (globalThis as { crypto?: { subtle?: MinimalSubtleCrypto } }).crypto?.subtle

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/** sha-256 hex over the bytes (Web Crypto, present in workerd and Node). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (!webCryptoSubtle) {
    // No Web Crypto (should not happen on a real runtime): fall back to a cheap,
    // non-cryptographic FNV-1a so dedup still works deterministically.
    let h = 0x811c9dc5
    for (const b of bytes) {
      h ^= b
      h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const digest = await webCryptoSubtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

const textEncoder = new (
  globalThis as unknown as {
    TextEncoder: new () => { encode(input: string): Uint8Array }
  }
).TextEncoder()

/** sha-256 hex over a string's UTF-8 bytes. */
export function sha256HexOfString(input: string): Promise<string> {
  return sha256Hex(textEncoder.encode(input))
}
