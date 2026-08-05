import type { ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { hostMarkdown } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Step selection for the PR verification report: which step of a run a section reports on.
//
// Its own module because both halves of the report need it and neither may import the other:
// `prReport.logic.ts` (the spine) imports `prReport.environments.ts` (the one section composed
// from a source outside the run), so the rule they share has to sit underneath both rather than
// being copied into the second one.
// ---------------------------------------------------------------------------

/**
 * The step a section should report on: the LAST matching step that carries evidence, else the
 * first matching step (so a pipeline that has the step but hasn't reached it still gets the
 * "not run yet" note rather than nothing).
 *
 * Last-with-evidence, not first-match: a pipeline may legitimately carry the same kind twice (a
 * `ci` gate after the coder and another after the tester, say), and the later run is the one
 * that describes the PR head as it stands now. Reporting the first would pin the section to a
 * verdict two steps of work out of date.
 */
export function findStep(
  instance: ExecutionInstance,
  matches: (step: PipelineStep) => boolean,
  hasEvidence: (step: PipelineStep) => boolean,
): PipelineStep | undefined {
  const matching = instance.steps.filter(matches)
  for (let i = matching.length - 1; i >= 0; i--) {
    if (hasEvidence(matching[i]!)) return matching[i]
  }
  return matching[0]
}

/**
 * Render an ABSENT section's note: the ONE line every section emits in place of its evidence.
 *
 * It goes through the `hostMarkdown` boundary like every other hole in this document, and that
 * matters more than it looks. These notes read as engine-authored constants, so they were
 * interpolated raw; but a note now NAMES things (the own-service pull request a peer's report
 * withholds its sections to), and `owner/repo#12` in a PR body is a cross-repo reference the
 * host resolves and back-links. The escape keeps a note a STATEMENT about a pull request rather
 * than an event on one, and it is applied here, once, so the next note that interpolates
 * something cannot reintroduce the hole one section at a time.
 */
export function absentNote(note: string | null | undefined): string {
  return `_${hostMarkdown.prose(note ?? 'Not reported.')}_`
}
