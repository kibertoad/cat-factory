import { randomBytes as nodeRandomBytes } from 'node:crypto'

/**
 * The two mandatory crypto secrets a cat-factory deployment needs, in the EXACT formats
 * the server's config loader expects:
 *
 * - `authSessionSecret` — signs the session JWT. The loader requires `>= 32` characters;
 *   we emit 32 random bytes as **hex** (64 chars), matching `deploy/local`'s
 *   `generate-secrets.mjs`.
 * - `encryptionKey` — the master key that seals every integration credential at rest.
 *   The cipher requires valid **base64 of at least 32 decoded bytes** (a non-base64 value
 *   like `dummy` fails the cipher at boot with `InvalidCharacterError`); we emit 32 random
 *   bytes as base64.
 *
 * Both MUST stay STABLE once chosen: regenerating `authSessionSecret` forces a re-login and
 * regenerating `encryptionKey` orphans every encrypted-at-rest credential. The CLI generates
 * them once at scaffold time and writes them into `.env` so the developer keeps the values.
 */
export interface GeneratedSecrets {
  authSessionSecret: string
  encryptionKey: string
}

/** Injectable RNG seam so the generator is deterministic in tests. */
export type RandomBytes = (size: number) => Buffer

/** Generate a fresh {@link GeneratedSecrets} pair in the server's required formats. */
export function generateSecrets(randomBytes: RandomBytes = nodeRandomBytes): GeneratedSecrets {
  return {
    authSessionSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64'),
  }
}
