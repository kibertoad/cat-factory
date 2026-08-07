import type {
  DocumentFreshness,
  DocumentFreshnessChange,
  DocumentFreshnessGap,
  StepContextDocument,
} from '@cat-factory/contracts'

// How current the body of a linked context document actually is at the moment a run reads it.
//
// A source-backed document is a PROJECTION of a page someone else keeps editing. Import writes that
// projection once; nothing downstream used to look at it again, so a run started a week later fed
// its agent the week-old copy with the run reading as perfectly healthy. For a requirements page
// that is an annoyance; for a design under active iteration it means the agent routinely builds the
// previous revision.
//
// The dispatch-time refresh (`LinkedDocumentRefresher`) closes that, and this module owns the ONE
// renderer that states the verdict to the agent. The VOCABULARY itself lives in
// `@cat-factory/contracts`, because a human has to read the same verdict the agent does: the SPA
// names each gap in the reader's own language off an exhaustive `Record` keyed by those members,
// and the backend does not localize prose. Two rules from the repo's "degrade loudly" convention
// shape the union, and they bind both readers:
//
//   - "no source to confirm against" and "tried and failed" are DIFFERENT facts and must not
//     collapse into one "unknown". An `upload` has nothing to be stale relative to; a Figma file the
//     API refused is a body that may well be behind the live design. Only the second is a warning.
//   - a confirmed document STATES its revision rather than saying nothing, so "which revision did
//     this run build against" is answerable from the materialised context after the fact.

export type {
  DocumentFreshness,
  DocumentFreshnessChange,
  DocumentFreshnessGap,
  StepContextDocument,
}

/**
 * The human-readable half of a {@link DocumentFreshnessGap}.
 *
 * Exported because a SECOND English-prose reader of the verdict exists: the PR verification
 * report, which states the same gap to a human reviewer in a pull-request body. Both are
 * backend-authored prose (the SPA is the localized reader and keys its own `Record` off the
 * members), and one gap must not acquire two wordings that a reader would have to reconcile.
 */
export function describeFreshnessGap(reason: DocumentFreshnessGap): string {
  switch (reason) {
    case 'not_connected':
      return 'this workspace is no longer connected to the source'
    case 'credentials_unreadable':
      return 'this deployment cannot read the source credentials, so the source was never asked'
    case 'unversioned':
      return 'the source exposes no revision to compare against'
    case 'source_unreachable':
      return 'the source could not be reached'
    default:
      return exhaustiveGap(reason)
  }
}

/**
 * The compile-time totality guard: adding a {@link DocumentFreshnessGap} member fails the build here
 * rather than splicing `undefined` into the note an agent reads.
 */
function exhaustiveGap(reason: never): string {
  return `unknown reason (${String(reason)})`
}

/**
 * A linked document's freshness header lines, or NOTHING when there is nothing to state.
 *
 * ONE renderer for BOTH surfaces the verdict has to reach, which is why it lives in kernel: the
 * container's materialiser puts it beside `originHeaderLine` (`context-references.ts`) at the top of
 * every `.cat-context/` file, and the in-prompt injection an INLINE kind gets instead of a checkout
 * puts it under the document's heading. The engine decides the verdict; neither renderer invents its
 * own wording, and neither gets to decide separately whether to state it at all. An inline judge,
 * estimator or requirements reviewer is exactly as able to score against a stale design as a
 * container agent is to build from one, and it has no `.cat-context/` file to read the warning from.
 *
 * A confirmed document contributes its revision, so the file records what the run built against. An
 * UNCONFIRMED one contributes a warning naming the gap, because an agent handed a design has no
 * other way to know the copy might trail the live file — and an omitted note reads exactly like a
 * copy that was checked.
 */
export function freshnessHeaderLines(freshness?: DocumentFreshness): string {
  if (!freshness) return ''
  switch (freshness.status) {
    case 'confirmed':
      // The revision only, with no "confirmed" claim attached: the line's presence IS the claim,
      // and a bare token is what a human pastes back into the source to compare.
      return freshness.version ? `Revision: ${freshness.version}\n` : ''
    case 'not-applicable':
      return ''
    case 'unconfirmed':
      return (
        `Freshness: NOT confirmed against the source (${describeFreshnessGap(freshness.reason)}). ` +
        `This is the copy stored at import time and may be behind the current version — treat anything ` +
        `that looks inconsistent with the task as possibly out of date.\n`
      )
    default:
      return exhaustiveFreshness(freshness)
  }
}

/** {@link exhaustiveGap}'s sibling for the outer union. */
function exhaustiveFreshness(freshness: never): string {
  return `Freshness: unknown (${JSON.stringify(freshness)})\n`
}
