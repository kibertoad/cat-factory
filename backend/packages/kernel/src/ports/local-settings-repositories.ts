// Persistence port for the local-mode operational settings — a per-DEPLOYMENT
// SINGLETON (local mode is one developer's machine), so there is exactly one row,
// addressed by a fixed key rather than an account/workspace id. LOCAL-MODE-ONLY: there
// is no D1 mirror (the warm pool + checkout reuse are the local Docker runner's
// differentiators; the symmetry rule's runtime-specific carve-out applies). The
// non-secret `config` is JSON text; a missing row means "all defaults".

export interface LocalSettingsRecord {
  /** Non-secret tuning JSON (warm-pool sizing + per-repo checkout reuse). */
  config: string
  createdAt: number
  updatedAt: number
}

export interface LocalSettingsRepository {
  /** The singleton settings row, or null when none persisted yet (caller uses defaults). */
  get(): Promise<LocalSettingsRecord | null>
  /** Create or replace the singleton settings row. */
  upsert(record: LocalSettingsRecord): Promise<void>
}
