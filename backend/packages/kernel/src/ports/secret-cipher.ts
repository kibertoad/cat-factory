// Port for authenticated encryption of credentials at rest. The core depends
// only on this interface; the worker supplies a Web Crypto (AES-256-GCM)
// implementation keyed by a service-level master secret. Used to protect the
// per-tenant management-API secret bundle and the per-environment access creds
// before they are written to D1, and to decrypt them in-memory at call time.

export interface SecretCipher {
  /** Encrypt plaintext into an opaque, self-describing envelope string. */
  encrypt(plaintext: string): Promise<string>
  /** Decrypt an envelope produced by {@link encrypt}. Throws if tampered/invalid. */
  decrypt(envelope: string): Promise<string>
}

/**
 * Why a {@link SecretCipher.decrypt} failed, as a machine-readable discriminant (ADR 0026 D6.2):
 * - `key-mismatch` — the envelope parsed but AES-GCM authentication failed, i.e. the
 *   ENCRYPTION_KEY does not match the one the secret was sealed under (rotated/regenerated).
 *   The value is UNRECOVERABLE without restoring the original key. This is the drift case.
 * - `corrupt` — the envelope itself is malformed/truncated or from a different scheme/version,
 *   so decryption never even reaches the key. A separate, non-drift fault.
 *
 * The drift sweep buckets each stored secret by this discriminant, so it must be typed rather
 * than parsed from message text.
 */
export type SecretDecryptFailureReason = 'key-mismatch' | 'corrupt'

/** A typed {@link SecretCipher.decrypt} failure carrying its {@link SecretDecryptFailureReason}. */
export class SecretDecryptError extends Error {
  readonly reason: SecretDecryptFailureReason
  constructor(reason: SecretDecryptFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'SecretDecryptError'
    this.reason = reason
  }
}

/** Narrow an unknown thrown value to a {@link SecretDecryptError} (and optionally a reason). */
export function isSecretDecryptError(
  error: unknown,
  reason?: SecretDecryptFailureReason,
): error is SecretDecryptError {
  return error instanceof SecretDecryptError && (reason === undefined || error.reason === reason)
}
