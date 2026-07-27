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

/** Opens the engine-managed region of a PR body. Never change this — it is the identity. */
export const PR_REPORT_MARKER_START = '<!-- cat-factory:verification-report:start -->'
/** Closes the engine-managed region of a PR body. */
export const PR_REPORT_MARKER_END = '<!-- cat-factory:verification-report:end -->'

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
export function spliceManagedSection(body: string | null | undefined, section: string): string {
  const existing = body ?? ''
  const wrapped = `${PR_REPORT_MARKER_START}\n${section.trim()}\n${PR_REPORT_MARKER_END}`
  const start = existing.indexOf(PR_REPORT_MARKER_START)
  const end = existing.indexOf(PR_REPORT_MARKER_END)
  if (start !== -1 && end > start) {
    const before = existing.slice(0, start)
    const after = existing.slice(end + PR_REPORT_MARKER_END.length)
    return `${before}${wrapped}${after}`
  }
  const prefix = existing.trim()
  return prefix ? `${prefix}\n\n${wrapped}\n` : `${wrapped}\n`
}

/**
 * The engine-managed region's current contents, or null when the body carries none. Used by
 * tests and by any consumer that wants to read a report back off a PR without re-composing it.
 */
export function readManagedSection(body: string | null | undefined): string | null {
  const existing = body ?? ''
  const start = existing.indexOf(PR_REPORT_MARKER_START)
  const end = existing.indexOf(PR_REPORT_MARKER_END)
  if (start === -1 || end <= start) return null
  return existing.slice(start + PR_REPORT_MARKER_START.length, end).trim()
}
