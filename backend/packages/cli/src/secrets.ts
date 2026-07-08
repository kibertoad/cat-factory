import { randomBytes as nodeRandomBytes } from 'node:crypto'

/**
 * The three mandatory crypto secrets a cat-factory deployment needs, in the EXACT formats
 * the server's config loader expects (all validated by `requireStableSecret` in
 * `@cat-factory/local-server`'s config loader — a deployment missing any of them fails to boot):
 *
 * - `authSessionSecret` — signs the session JWT. The loader requires `>= 32` characters;
 *   we emit 32 random bytes as **hex** (64 chars), matching `deploy/local`'s
 *   `generate-secrets.mjs`.
 * - `encryptionKey` — the master key that seals every integration credential at rest.
 *   The cipher requires valid **base64 of at least 32 decoded bytes** (a non-base64 value
 *   like `dummy` fails the cipher at boot with `InvalidCharacterError`); we emit 32 random
 *   bytes as base64.
 * - `harnessSharedSecret` — the shared HMAC secret the backend and the executor-harness sign
 *   their traffic with (`HARNESS_SHARED_SECRET`). The loader requires `>= 16` characters; we
 *   emit 32 random bytes as **hex** (64 chars), matching `deploy/local`'s `generate-secrets.mjs`.
 *
 * All three MUST stay STABLE once chosen: regenerating `authSessionSecret` forces a re-login and
 * regenerating `encryptionKey` orphans every encrypted-at-rest credential. The CLI generates
 * them once and writes them into `.env` so the developer keeps the values.
 */
export interface GeneratedSecrets {
  authSessionSecret: string
  encryptionKey: string
  harnessSharedSecret: string
}

/** Injectable RNG seam so the generator is deterministic in tests. */
export type RandomBytes = (size: number) => Buffer

/** Generate a fresh {@link GeneratedSecrets} set in the server's required formats. */
export function generateSecrets(randomBytes: RandomBytes = nodeRandomBytes): GeneratedSecrets {
  return {
    authSessionSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64'),
    harnessSharedSecret: randomBytes(32).toString('hex'),
  }
}
