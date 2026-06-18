/**
 * Maximum number of times a step's container eviction/crash is recovered
 * automatically by re-dispatching a fresh container for the same step. Set to 1:
 * one transient eviction is recovered silently; a second eviction of the same step
 * is treated as deterministic and fails the run (`evicted`).
 */
export const MAX_EVICTION_RECOVERIES = 1

/**
 * Whether a failed job poll is a *container eviction/crash* (the per-run container
 * vanished and its in-memory job registry is gone) rather than a genuine agent
 * failure. The Cloudflare transport maps a 404 job poll to a failed view whose
 * message ends `(container evicted or crashed)`; the worker bootstrap flow
 * classifies the identical string. Matching it here lets the execution engine
 * recover a transient eviction by spinning a fresh container instead of failing
 * the whole run on the first blip.
 */
export function isContainerEvictionError(error: string | undefined): boolean {
  return error !== undefined && /evicted or crashed/i.test(error)
}
