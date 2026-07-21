import type { KeyDriftAffected } from '@cat-factory/contracts'
import type { SealedSecretRef, SecretCipher } from '@cat-factory/kernel'
import { sweepKeyDrift } from '../crypto/keyDriftSweep.js'
import type { KeyFingerprintLogger } from '../crypto/keyFingerprint.js'
import type { ServerContainer } from '../http/env.js'

// ADR 0026 D6.2 — the runtime-neutral driver that turns the drift sweep into ONE surfaced issue,
// shared by both facades (the Node boot one-shot + the Worker cron), mirroring
// `sweepPlatformHealth`. It attempts to decrypt every sealed secret the inventory reports and,
// per workspace:
//   - raises ONE `key_drift` notification listing that workspace's undecryptable credentials
//     (by source / id / label / reason / seal time — NEVER the value), or
//   - clears the open card once the workspace has none (the operator dropped + re-entered them).
// The card de-dupes on (workspace, type) and its content is a pure function of the affected set,
// so a persistently-drifted deployment re-notifies only when that set changes, not every sweep.
//
// A no-op unless BOTH the sealed-secret inventory and the notifications module are wired (tests /
// no ENCRYPTION_KEY). Best-effort: a failure is logged and swallowed, never blocking boot/cron.

/** Map an undecryptable ref + its reason to the wire shape carried on the card (no value). */
function toAffected(ref: SealedSecretRef, reason: 'key-mismatch' | 'corrupt'): KeyDriftAffected {
  return { source: ref.source, id: ref.id, label: ref.label, reason, sealedAt: ref.sealedAt }
}

/** Card copy for a workspace's affected credentials (title + one-line body). */
function cardContent(affected: KeyDriftAffected[]): { title: string; body: string } {
  const mismatched = affected.filter((a) => a.reason === 'key-mismatch').length
  const corrupt = affected.length - mismatched
  const parts: string[] = []
  if (mismatched > 0) parts.push(`${mismatched} sealed under a different ENCRYPTION_KEY`)
  if (corrupt > 0) parts.push(`${corrupt} with a corrupt/foreign envelope`)
  return {
    title: 'Stored credentials could not be decrypted',
    body:
      `${affected.length} stored credential(s) could not be decrypted (${parts.join(', ')}). ` +
      'They are unrecoverable unless the original ENCRYPTION_KEY is restored. Review them, then ' +
      'drop the stale ones to re-enter — restoring the previous key instead recovers them all.',
  }
}

/**
 * Run the drift sweep and reconcile the per-workspace `key_drift` cards. `cipherFor` builds a
 * cipher for an HKDF info tag (the facade supplies it from its ENCRYPTION_KEY). Returns counts
 * for logging. Safe to call when unwired — it returns zeros.
 */
export async function sweepKeyDriftAndRaise(
  container: ServerContainer,
  cipherFor: (info: string) => SecretCipher,
  logger?: KeyFingerprintLogger,
): Promise<{ raised: number; cleared: number; affected: number }> {
  const inventory = container.sealedSecretInventory
  const notifications = container.notifications
  if (!inventory || !notifications) return { raised: 0, cleared: 0, affected: 0 }

  const report = await sweepKeyDrift({ inventory, cipherFor, logger })
  const affected: Array<{ ref: SealedSecretRef; reason: 'key-mismatch' | 'corrupt' }> = [
    ...report.keyMismatch.map((ref) => ({ ref, reason: 'key-mismatch' as const })),
    ...report.corrupt.map((ref) => ({ ref, reason: 'corrupt' as const })),
  ]

  // Group affected credentials by workspace (a null-workspace ref can't get a per-workspace card;
  // both current sources always carry one, so a null is logged and skipped rather than dropped
  // into a sentinel workspace).
  const affectedByWs = new Map<string, KeyDriftAffected[]>()
  for (const { ref, reason } of affected) {
    if (!ref.workspaceId) {
      logger?.warn('key drift: affected secret has no workspace; not surfaced', {
        source: ref.source,
        id: ref.id,
      })
      continue
    }
    const list = affectedByWs.get(ref.workspaceId) ?? []
    list.push(toAffected(ref, reason))
    affectedByWs.set(ref.workspaceId, list)
  }

  // Every workspace that owns ANY scanned secret — so a workspace that just recovered (its
  // secrets now all decrypt) has its stale card cleared.
  const allWorkspaceIds = new Set<string>()
  for (const ref of [...report.ok, ...report.keyMismatch, ...report.corrupt]) {
    if (ref.workspaceId) allWorkspaceIds.add(ref.workspaceId)
  }
  const withOpenCard = new Set(
    (await notifications.service.listOpenByType([...allWorkspaceIds], 'key_drift')).keys(),
  )

  let raised = 0
  let cleared = 0
  for (const workspaceId of allWorkspaceIds) {
    const list = affectedByWs.get(workspaceId)
    if (list && list.length > 0) {
      // Stable ordering so the card's dedup identity doesn't churn across sweeps.
      list.sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
      const { title, body } = cardContent(list)
      await notifications.service.raise(workspaceId, {
        type: 'key_drift',
        blockId: null,
        executionId: null,
        title,
        body,
        payload: { driftAffected: list },
      })
      raised += 1
    } else if (
      withOpenCard.has(workspaceId) &&
      (await notifications.service.clearByType(workspaceId, 'key_drift'))
    ) {
      cleared += 1
    }
  }
  return { raised, cleared, affected: affected.length }
}
