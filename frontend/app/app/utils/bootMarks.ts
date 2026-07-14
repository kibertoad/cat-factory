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
  try {
    performance.mark(mark)
    // Absolute time from navigation start (DOMHighResTimeStamp 0 = timeOrigin) to this milestone.
    performance.measure(`${PREFIX}:open→${milestone}`, { start: 0, end: mark })
    // The segment since the previous milestone — the waterfall bar.
    if (previousMark) {
      performance.measure(`${PREFIX}:${previousMark.slice(PREFIX.length + 1)}→${milestone}`, {
        start: previousMark,
        end: mark,
      })
    }
    previousMark = mark
  } catch {
    // Some engines reject the numeric-`start` measure form; the marks still land, so the trace is
    // usable and we simply skip the derived measures.
  }
}
