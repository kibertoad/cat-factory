// Port for enumerating (and remediating) the deployment's sealed-at-rest secrets, so a
// boot-time sweep can detect ENCRYPTION_KEY drift per credential and an operator can drop a
// specific unrecoverable one (ADR 0026 D6.2 / D6.3). Each runtime implements it over its own
// stores (D1 / Drizzle); the inventory is the ONLY place that knows which tables/columns hold
// sealed secrets, so adding a source is a change here + its two repo methods, never in the
// runtime-neutral sweep.

/**
 * A reference to one sealed secret found in the deployment's stores. It carries the sealed
 * `envelope` (so the sweep can attempt a decrypt) and the `info` HKDF tag needed to build the
 * right cipher for it, plus NON-secret identification (source table, row id, a human label,
 * seal time) — NEVER the plaintext value.
 */
export interface SealedSecretRef {
  /** The logical source, e.g. `'environment_connection'` / `'observability_connection'`. */
  source: string
  /** The owning row's id (stringified; composite keys are joined). Stable per (source, id). */
  id: string
  /** The workspace the secret belongs to, or null for a deployment-scoped one. */
  workspaceId: string | null
  /** A human label — the connection type / provider — for the surfaced issue. Never the value. */
  label: string
  /** The HKDF `info` domain-separation tag the secret was sealed under (to build its cipher). */
  info: string
  /** The sealed `v1.` envelope string. */
  envelope: string
  /** Epoch ms the secret was sealed (row create/update), when known. */
  sealedAt: number | null
}

/**
 * The result of a {@link SealedSecretInventory.drop}: whether a stored secret was actually
 * removed, so the caller can report "dropped" vs "already gone" (idempotent).
 */
export interface DropSealedSecretResult {
  dropped: boolean
}

export interface SealedSecretInventory {
  /**
   * Every sealed secret currently stored, across the sources this runtime knows. Used by the
   * drift sweep to attempt a decrypt of each. Bounded to slow-moving credential tables (not
   * high-volume telemetry), so a full scan is cheap.
   */
  listSealed(): Promise<SealedSecretRef[]>
  /**
   * Drop the unrecoverable ciphertext identified by `(source, id)` and flip its owning
   * connection to a "needs re-entry" state (D6.3). Opt-in, per-secret, NEVER automatic — the
   * value is unrecoverable, so a mistaken key change must be fixed by restoring the key, not
   * by this. Idempotent: dropping an already-gone secret reports `dropped: false`.
   */
  drop(ref: { source: string; id: string }): Promise<DropSealedSecretResult>
}
