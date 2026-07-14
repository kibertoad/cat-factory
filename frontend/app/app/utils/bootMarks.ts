/**
 * Cold-open instrumentation (app-startup initiative, item 1). The SPA is `ssr: false`, so the whole
 * "launch → usable board" path runs client-side after the bundle loads, and nothing timed the
 * milestones along it. `markBoot` drops a `performance.mark` at each one plus `performance.measure`s
 * so the cold-open waterfall is visible in a Playwright/browser trace:
 *   - one `cat-factory:open→<milestone>` measure = absolute ms from navigation start to the milestone,
 *   - one `cat-factory:<prev>→<milestone>` measure = the segment since the previous milestone.
 *
 * Milestones (fired once per cold open): `auth-ready` → `workspaces-listed` → `snapshot-hydrated`
 * → `stream-connected`. It is pure instrumentation — no behaviour depends on it — and it is a no-op
 * where the User Timing API is unavailable (SSR/prerender, ancient engines), so callers never guard.
 */

const PREFIX = 'cat-factory'

/** Milestones already stamped this session — cold-open marks fire ONCE (later switches don't re-time). */
const seen = new Set<string>()
/** The previous milestone's mark name, so each call can measure the segment since it. */
let previousMark: string | null = null

export function markBoot(milestone: string): void {
  if (seen.has(milestone)) return
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  seen.add(milestone)
  const mark = `${PREFIX}:${milestone}`
  const prev = previousMark
  try {
    performance.mark(mark)
  } catch {
    return
  }
  // Advance the chain as soon as the mark itself lands, INDEPENDENT of the derived measures below.
  // Some engines reject the numeric-`start` measure form; if that throws we still want the NEXT
  // milestone to measure its segment from THIS mark rather than a stale earlier one.
  previousMark = mark
  try {
    // Absolute time from navigation start (DOMHighResTimeStamp 0 = timeOrigin) to this milestone.
    performance.measure(`${PREFIX}:open→${milestone}`, { start: 0, end: mark })
    // The segment since the previous milestone — the waterfall bar.
    if (prev) {
      performance.measure(`${PREFIX}:${prev.slice(PREFIX.length + 1)}→${milestone}`, {
        start: prev,
        end: mark,
      })
    }
  } catch {
    // Derived measures unsupported on this engine; the marks still land, so the trace is usable.
  }
}
