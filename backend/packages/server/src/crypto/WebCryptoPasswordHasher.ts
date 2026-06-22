import type { PasswordHasher } from '@cat-factory/kernel'
import { base64url, base64urlToBytes, timingSafeEqual } from './encoding.js'

// Password hashing for the email/password login provider, built on Web Crypto
// (PBKDF2-HMAC-SHA256) so it runs identically on Cloudflare workerd and Node —
// native argon2/bcrypt modules do NOT load in a Workers isolate, which would split
// the runtimes. A random per-record salt + a high iteration count are embedded in a
// self-describing PHC-like string so `verify` re-derives without external params:
//
//   pbkdf2-sha256$i=<iterations>$<base64url(salt)>$<base64url(hash)>
//
// `verify` is constant-time (timingSafeEqual) and fails closed on any malformed
// stored value.

// OWASP-recommended floor for PBKDF2-HMAC-SHA256 (2023). Paid once per login, not
// per request.
const DEFAULT_ITERATIONS = 210_000
const SALT_BYTES = 16
const HASH_BYTES = 32
const SCHEME = 'pbkdf2-sha256'

export class WebCryptoPasswordHasher implements PasswordHasher {
  constructor(private readonly iterations: number = DEFAULT_ITERATIONS) {}

  async hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
    const derived = await deriveBits(password, salt, this.iterations)
    return `${SCHEME}$i=${this.iterations}$${base64url(salt)}$${base64url(derived)}`
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parseStored(stored)
    if (!parsed) return false
    const derived = new Uint8Array(await deriveBits(password, parsed.salt, parsed.iterations))
    return timingSafeEqual(derived, parsed.expected)
  }

  needsRehash(stored: string): boolean {
    const parsed = parseStored(stored)
    // Unparseable ⇒ upgrade it; otherwise upgrade anything below the current cost.
    return !parsed || parsed.iterations < this.iterations
  }
}

interface ParsedHash {
  iterations: number
  salt: Uint8Array
  expected: Uint8Array
}

/** Parse a stored PHC-like value, or null on any malformed input (fail closed). */
function parseStored(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== SCHEME) return null
  const iterMatch = /^i=(\d+)$/.exec(parts[1]!)
  if (!iterMatch) return null
  const iterations = Number(iterMatch[1])
  if (!Number.isInteger(iterations) || iterations < 1) return null
  try {
    return {
      iterations,
      salt: base64urlToBytes(parts[2]!),
      expected: base64urlToBytes(parts[3]!),
    }
  } catch {
    return null
  }
}

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as Uint8Array<ArrayBuffer>,
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as Uint8Array<ArrayBuffer>, iterations },
    baseKey,
    HASH_BYTES * 8,
  )
}
