import type { KeyFingerprintStore } from '@cat-factory/kernel'
import { base64url, base64urlToBytes } from './encoding.js'

// ADR 0026 D6.1 — a non-secret fingerprint of the master ENCRYPTION_KEY and the boot-time
// drift check built on it. The fingerprint is `HKDF(masterKey, info="cat-factory:key-
// fingerprint")` truncated to 8 bytes, base64url. It is a one-way function of the key that
// leaks nothing usable (8 bytes of HKDF output can't be inverted to a 32-byte key), so it is
// safe to persist in plaintext. Persisted once on first boot; every boot recomputes and
// compares — an O(1), definitive "the key changed since secrets were last sealed" signal
// available before any request touches a stale secret.

const FINGERPRINT_INFO = 'cat-factory:key-fingerprint'
/** 8 bytes: enough that a collision is not a practical concern, few enough to leak nothing. */
const FINGERPRINT_BYTES = 8

/**
 * Compute the base64url fingerprint of a base64-encoded master key. Uses HKDF-SHA256
 * `deriveBits` with a fixed domain-separation `info` and an empty salt (the salt adds
 * nothing here — the key IS the secret and there is only one derivation per key), mirroring
 * the {@link WebCryptoSecretCipher} HKDF style. Throws on an under-length key, exactly like
 * the cipher, so a misconfigured key fails the same way in both places.
 */
export async function computeKeyFingerprint(masterKeyBase64: string): Promise<string> {
  const masterKey = base64urlToBytes(masterKeyBase64.trim()) as Uint8Array<ArrayBuffer>
  if (masterKey.length < 32) {
    throw new Error('encryption key must decode to at least 32 bytes')
  }
  const baseKey = await crypto.subtle.importKey('raw', masterKey, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(FINGERPRINT_INFO) as Uint8Array<ArrayBuffer>,
    },
    baseKey,
    FINGERPRINT_BYTES * 8,
  )
  return base64url(new Uint8Array(bits))
}

/**
 * The outcome of a boot-time drift check:
 * - `first-seen` — no fingerprint was stored yet; the current one was just persisted.
 * - `match` — the stored fingerprint equals the current key's; no drift.
 * - `drift` — the stored fingerprint differs; the ENCRYPTION_KEY changed since secrets were
 *   last sealed, so any secret sealed under the old key is now unrecoverable without it.
 */
export type KeyFingerprintCheck =
  | { status: 'first-seen'; fingerprint: string }
  | { status: 'match'; fingerprint: string }
  | { status: 'drift'; current: string; stored: string }

/** A minimal logger surface (matches both the server and runtime facades' loggers). */
export interface KeyFingerprintLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

/**
 * Run the boot-time drift check: compute the current key's fingerprint, compare it to the
 * persisted one, and NEVER overwrite a mismatching value (that would erase the drift signal —
 * the operator restores the old key or runs remediation, then the fingerprint is re-seeded
 * deliberately). Logs the outcome and returns it so the caller can act (e.g. trigger the
 * D6.2 sweep). Best-effort persistence: a store write failure is logged, not fatal, so a
 * transient DB hiccup never blocks boot.
 */
export async function checkKeyFingerprint(deps: {
  store: KeyFingerprintStore
  masterKeyBase64: string
  logger: KeyFingerprintLogger
}): Promise<KeyFingerprintCheck> {
  const { store, masterKeyBase64, logger } = deps
  const current = await computeKeyFingerprint(masterKeyBase64)
  const stored = await store.get()
  if (stored === null) {
    await store.set(current).catch((error: unknown) => {
      logger.warn('key fingerprint could not be persisted on first boot', {
        error: String(error),
      })
    })
    logger.info('key fingerprint recorded (first boot)', { fingerprint: current })
    return { status: 'first-seen', fingerprint: current }
  }
  if (stored === current) {
    return { status: 'match', fingerprint: current }
  }
  logger.error('ENCRYPTION_KEY drift detected: the key changed since secrets were last sealed', {
    storedFingerprint: stored,
    currentFingerprint: current,
    hint:
      'Secrets sealed under the previous key are unrecoverable without it. Restore the ' +
      'original ENCRYPTION_KEY, or re-enter the affected credentials to re-seal them.',
  })
  return { status: 'drift', current, stored }
}
