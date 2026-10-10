// ---------------------------------------------------------------------------
// The managed-section splice behind the PR verification report.
//
// The engine maintains its report as a MARKER-DELIMITED region of the pull request's own
// body/description (see `docs/initiatives/pr-verification-report.md`, decision D1). The
// markers ARE the report's identity, which is what makes the write idempotent with no
// persisted state at all: a re-run, a retry, a replayed durable step, or a second
// deployment writing the same PR all replace exactly the marked region instead of appending
// a second copy.
//
// Pure string logic, so it lives in kernel and is shared by the orchestration composer and
// the `@cat-factory/server` publisher without either depending on the other.
// ---------------------------------------------------------------------------

/** Opens the engine-managed region of a PR body. Never change this: it is the identity. */
export const PR_REPORT_MARKER_START = '<!-- cat-factory:verification-report:start -->'
/** Closes the engine-managed region of a PR body. */
export const PR_REPORT_MARKER_END = '<!-- cat-factory:verification-report:end -->'

/**
 * One engine-managed region's identity: the comment pair that delimits it.
 *
 * A region is identified by its markers alone, so a body may carry several independent ones and
 * each writer replaces only its own. That is what lets the monorepo bootstrap keep its settled
 * adoption decisions on the pull request without owning the description: the agent writes the
 * narrative, the engine owns one marked block inside it, and neither overwrites the other.
 */
export interface ManagedSectionMarkers {
  start: string
  end: string
}

/** The verification report's markers, as a pair (the default for the helpers below). */
export const PR_REPORT_MARKERS: ManagedSectionMarkers = {
  start: PR_REPORT_MARKER_START,
  end: PR_REPORT_MARKER_END,
}

/**
 * The monorepo bootstrap's adoption-decision region.
 *
 * Distinct markers rather than a second use of the report's, because the two are written by
 * different flows at different times and a shared identity would mean whichever ran last erased
 * the other. A bootstrap opens no run whose steps settle, so it never publishes a verification
 * report; a task run on the same repository later can, and its report must not land on top of
 * the decisions this service was created under.
 */
export const PR_ADOPTION_MARKERS: ManagedSectionMarkers = {
  start: '<!-- cat-factory:adoption-decisions:start -->',
  end: '<!-- cat-factory:adoption-decisions:end -->',
}

/**
 * Splice `section` into `body` as the engine-managed region.
 *
 * - Markers present  ⇒ the region between them is REPLACED (everything the human/agent wrote
 *   above and below is preserved verbatim).
 * - Markers absent   ⇒ the section is appended after the existing body, separated by a blank
 *   line. The agent's own PR description is never rewritten.
 * - A malformed body (an end marker before a start marker, or a start with no end) is treated
 *   as "no managed region": the stray markers are left alone and a fresh region is appended,
 *   because guessing at a truncated region risks eating real prose.
 *
 * Returns the new body. The caller compares it against what it read and skips the remote write
 * when nothing changed.
 */
export function spliceManagedSection(
  body: string | null | undefined,
  section: string,
  markers: ManagedSectionMarkers = PR_REPORT_MARKERS,
): string {
  const existing = body ?? ''
  const wrapped = `${markers.start}\n${section.trim()}\n${markers.end}`
  const start = existing.indexOf(markers.start)
  const end = existing.indexOf(markers.end)
  if (start !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + markers.end.length)
    return `${before}${wrapped}${after}`
  }
  const prefix = existing.trim()
  return prefix ? `${prefix}\n\n${wrapped}\n` : `${wrapped}\n`
}

/**
 * The engine-managed region's current contents, or null when the body carries none. Used by
 * tests and by any consumer that wants to read a report back off a PR without re-composing it.
 */
export function readManagedSection(
  body: string | null | undefined,
  markers: ManagedSectionMarkers = PR_REPORT_MARKERS,
): string | null {
  const existing = body ?? ''
  const start = existing.indexOf(markers.start)
  const end = existing.indexOf(markers.end)
  if (start === -1 || end <= start) return null
  return existing.slice(start + markers.start.length, end).trim()
}
