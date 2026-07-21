import {
  type SealedSecretInventory,
  type SealedSecretRef,
  type SecretCipher,
  isSecretDecryptError,
} from '@cat-factory/kernel'
import type { KeyFingerprintLogger } from './keyFingerprint.js'

// ADR 0026 D6.2 — the runtime-neutral drift sweep. It attempts to decrypt every sealed secret
// the {@link SealedSecretInventory} reports and buckets the outcome into the three cases the
// cipher already distinguishes: decryptable (fine), an AES-GCM auth failure (key mismatch — the
// drift case), and envelope corruption (a separate, non-drift fault). The result is one legible
// inventory the caller turns into a single surfaced issue, replacing the stream of opaque
// per-request decrypt errors the incident produced.
//
// Pure of any store/notification specifics: it takes the inventory + a `cipherFor(info)` factory
// (each runtime supplies one built from its ENCRYPTION_KEY) and returns the buckets. Raising the
// notification + remediation live in the caller, which owns the workspace scoping + the channel.

export interface KeyDriftReport {
  /** Refs that decrypted cleanly — no drift for these. */
  ok: SealedSecretRef[]
  /**
   * Refs whose AES-GCM authentication failed: the ENCRYPTION_KEY does not match the one they
   * were sealed under. UNRECOVERABLE without the original key — the drift case D6.3 remediates.
   */
  keyMismatch: SealedSecretRef[]
  /**
   * Refs whose envelope is malformed/truncated or from a different scheme/version. A separate
   * fault (not key drift), surfaced distinctly so it isn't misattributed to a key change.
   */
  corrupt: SealedSecretRef[]
}

/** Whether a report found anything actionable (either failure bucket non-empty). */
export function hasKeyDrift(report: KeyDriftReport): boolean {
  return report.keyMismatch.length > 0 || report.corrupt.length > 0
}

/**
 * Attempt to decrypt every sealed secret and bucket the outcome. Ciphers are memoised per HKDF
 * `info` tag (one cipher serves every secret sealed under that tag). A decrypt that throws an
 * unexpected (non-{@link SecretDecryptError}) error is bucketed as `corrupt` and logged — the
 * sweep never throws, so one unreadable row can't abort the whole scan.
 */
export async function sweepKeyDrift(deps: {
  inventory: SealedSecretInventory
  cipherFor: (info: string) => SecretCipher
  logger?: KeyFingerprintLogger
}): Promise<KeyDriftReport> {
  const { inventory, cipherFor, logger } = deps
  const ciphers = new Map<string, SecretCipher>()
  const cipher = (info: string): SecretCipher => {
    let c = ciphers.get(info)
    if (!c) {
      c = cipherFor(info)
      ciphers.set(info, c)
    }
    return c
  }

  const report: KeyDriftReport = { ok: [], keyMismatch: [], corrupt: [] }
  const refs = await inventory.listSealed()
  for (const ref of refs) {
    try {
      await cipher(ref.info).decrypt(ref.envelope)
      report.ok.push(ref)
    } catch (error) {
      if (isSecretDecryptError(error, 'key-mismatch')) {
        report.keyMismatch.push(ref)
      } else if (isSecretDecryptError(error, 'corrupt')) {
        report.corrupt.push(ref)
      } else {
        // An unexpected decrypt error (not one of the cipher's typed failures): treat it as
        // corruption (conservative — it isn't a confirmed key mismatch) and keep scanning.
        report.corrupt.push(ref)
        logger?.warn('key drift sweep: unexpected decrypt error', {
          source: ref.source,
          id: ref.id,
          error: String(error),
        })
      }
    }
  }

  if (hasKeyDrift(report)) {
    logger?.warn('key drift sweep found affected secrets', {
      keyMismatch: report.keyMismatch.length,
      corrupt: report.corrupt.length,
      ok: report.ok.length,
    })
  } else {
    logger?.info('key drift sweep: all stored secrets decrypt cleanly', { ok: report.ok.length })
  }
  return report
}
