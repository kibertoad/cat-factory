// The PHASE axis on LLM telemetry: which slice of a container run spent a model call —
// the agent's own edit loop, a pre-PR validation repair round, a reproduction-proof repair
// round, and so on. See `docs/initiatives/token-burn-instrumentation.md`.
//
// The label is produced by whoever OWNS the phase boundary (the harness, which drives the
// repair loops itself) and rides the metric to the store; it is never reconstructed
// downstream from wall-clock timestamps. This module is only the boundary: the free-text
// label a producer hands over is normalised here before it is persisted, logged, or grouped.

/**
 * The phase of a call nothing could attribute. A REAL slice of the rollup, never a reason
 * to drop the row: a run that spends half its tokens somewhere we cannot name is exactly
 * what the instrument is meant to reveal, and hiding it under-reports the window while
 * looking complete (the same rule the reports surface applies to its `''` key).
 */
export const UNATTRIBUTED_CALL_PHASE = ''

// There is deliberately NO `KNOWN_CALL_PHASES` list here. The vocabulary belongs to the
// harness — it is whatever its handlers pass to `onPhase`, including the registry's initial
// `starting` and the terminal `done` — and a copy in kernel would be a second source of truth
// with nothing keeping it in step, which is how the first draft of this module came to omit
// both of those. Nothing consumed it, either. A rollup that needs display labels should read
// the phases PRESENT in its own result set (`''` included) rather than a hard-coded list that
// can only be wrong in one direction: silently dropping a phase a newer harness introduced,
// which is exactly what `normalizeCallPhase` passing unknown labels through exists to prevent.

/** Longest phase label kept; anything longer is a producer bug, not a phase. */
const MAX_PHASE_CHARS = 32

/**
 * Normalise a producer-supplied phase label to what may be stored: lowercase, `[a-z0-9-]`
 * only, bounded. Anything else — a non-string, an empty value, a label carrying characters
 * a phase never has — becomes {@link UNATTRIBUTED_CALL_PHASE}.
 *
 * Applied at every boundary the label crosses (the harness-call recorder, the proxy's URL
 * segment, a runner pool's result envelope), because two of those are inputs the platform
 * does not author: a pool's JSON and a proxy request path both arrive over HTTP. Rejecting
 * rather than escaping keeps the stored vocabulary a fixed alphabet, so a rollup's `GROUP BY
 * phase` can never be split by a label that only differs in case or padding.
 */
export function normalizeCallPhase(raw: unknown): string {
  if (typeof raw !== 'string') return UNATTRIBUTED_CALL_PHASE
  const trimmed = raw.trim().toLowerCase()
  if (!trimmed || trimmed.length > MAX_PHASE_CHARS) return UNATTRIBUTED_CALL_PHASE
  return /^[a-z0-9-]+$/.test(trimmed) ? trimmed : UNATTRIBUTED_CALL_PHASE
}
