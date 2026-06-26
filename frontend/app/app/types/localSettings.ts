// Local-mode operational settings (warm-container-pool sizing + per-repo checkout reuse).
// Mirrors `@cat-factory/contracts` localSettings. A per-deployment singleton, edited in the
// dedicated local-mode settings panel — these replaced the old LOCAL_POOL_* / HARNESS_* env
// vars. There are no secrets, so the read view is the plain config. Local-mode-only (the
// warm pool is the local Docker-family runner's differentiator).

export interface LocalPoolSettings {
  /** Max idle warm containers kept for re-lease. 0 disables pooling (cold-start per run). */
  size: number
  /** Containers pre-warmed when the service starts. */
  minWarm: number
  /** Hard cap on total containers (leased + idle). `null` ⇒ defaults to `size`. */
  max: number | null
  /** How long an idle pooled container is kept before eviction (ms). */
  idleTtlMs: number
}

export interface LocalCheckoutSettings {
  /** Absolute in-container dir the reused per-repo checkout lives under. */
  workspaceRoot: string
  /** Dep-cache directories the per-run clean sweep keeps (so deps aren't reinstalled). */
  cleanKeep: string[]
}

export interface LocalSettings {
  pool: LocalPoolSettings
  checkout: LocalCheckoutSettings
}

/** Admin write: the full settings blob fully replaces the stored config. */
export type UpdateLocalSettingsInput = LocalSettings
