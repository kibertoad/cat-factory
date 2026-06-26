import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Local-mode operational config, moved out of env vars into a single DB row (a
// per-DEPLOYMENT singleton — local mode is one developer's machine, so there is no
// per-account/per-workspace scoping). It is LOCAL-MODE-ONLY: the warm-container pool +
// per-repo checkout reuse are differentiators of the local facade's Docker/Podman/…
// runner, so this has NO Cloudflare/D1 mirror (the symmetry rule's runtime-specific
// carve-out). Surfaced through a dedicated local-mode settings panel rather than the
// account Deployment-settings panel, because local mode runs with the auth gate OPEN
// (no signed-in admin account to hang it on). There are no secrets here, so the read
// view is the plain config.
// ---------------------------------------------------------------------------

const nonNegInt = v.pipe(v.number(), v.integer(), v.minValue(0))

/**
 * Warm-container-pool sizing (the local Docker-family runner). `size: 0` ⇒ pooling OFF —
 * every run cold-starts its own container, the classic behaviour. `> 0` keeps that many
 * idle harness containers warm and re-leases one (preferring repo affinity) to each run.
 */
export const localPoolSettingsSchema = v.object({
  /** Max idle warm containers kept for re-lease. 0 disables pooling (cold-start per run). */
  size: v.optional(v.pipe(nonNegInt, v.maxValue(50)), 0),
  /** Containers pre-warmed when the service starts (clamped to `max`). */
  minWarm: v.optional(v.pipe(nonNegInt, v.maxValue(50)), 0),
  /** Hard cap on total containers (leased + idle). `null` ⇒ defaults to `size`. */
  max: v.optional(v.nullable(v.pipe(nonNegInt, v.maxValue(100))), null),
  /** How long an idle pooled container is kept before eviction (ms). */
  idleTtlMs: v.optional(nonNegInt, 600_000),
})
export type LocalPoolSettings = v.InferOutput<typeof localPoolSettingsSchema>

/**
 * Per-repo checkout-reuse knobs, forwarded into the harness container as env. When the
 * warm pool re-leases a container that already holds the run's repo, the harness reuses
 * its `<workspaceRoot>/<owner>/<repo>` checkout (clean-sweep + fetch + switch branch)
 * instead of cloning fresh; `cleanKeep` are the dep-cache dirs that sweep preserves.
 */
export const localCheckoutSettingsSchema = v.object({
  /** Absolute in-container dir the reused per-repo checkout lives under. */
  workspaceRoot: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.minLength(1),
      v.regex(/^\//, 'workspaceRoot must be an absolute (POSIX) path, e.g. /workspace'),
    ),
    '/workspace',
  ),
  /** Dep-cache directories the per-run clean sweep keeps (so deps aren't reinstalled). */
  cleanKeep: v.optional(v.array(v.pipe(v.string(), v.trim(), v.minLength(1))), [
    'node_modules',
    '.venv',
    'target',
    '.gradle',
    '.pnpm-store',
  ]),
})
export type LocalCheckoutSettings = v.InferOutput<typeof localCheckoutSettingsSchema>

/** The full local-mode settings blob. Every field defaults, so `{}` parses to defaults. */
export const localSettingsSchema = v.object({
  pool: v.optional(localPoolSettingsSchema, {}),
  checkout: v.optional(localCheckoutSettingsSchema, {}),
})
export type LocalSettings = v.InferOutput<typeof localSettingsSchema>

/** Built-in config used when no row exists yet (pooling off, harness defaults). */
export const DEFAULT_LOCAL_SETTINGS: LocalSettings = v.parse(localSettingsSchema, {})

/** Parse + fully-default a (possibly partial / absent) stored settings blob. */
export function parseLocalSettings(raw: unknown): LocalSettings {
  return v.parse(localSettingsSchema, raw ?? {})
}

/** Admin write: the full settings blob fully replaces the stored config. */
export const updateLocalSettingsSchema = localSettingsSchema
export type UpdateLocalSettingsInput = v.InferOutput<typeof updateLocalSettingsSchema>
