// How current the body of a linked context document actually is at the moment a run reads it.
//
// A source-backed document is a PROJECTION of a page someone else keeps editing. Import writes that
// projection once; nothing downstream used to look at it again, so a run started a week later fed
// its agent the week-old copy with the run reading as perfectly healthy. For a requirements page
// that is an annoyance; for a design under active iteration it means the agent routinely builds the
// previous revision.
//
// The dispatch-time refresh (`LinkedDocumentRefresher`) closes that, and this module owns the
// vocabulary of what it concluded plus the ONE renderer that states it to the agent. Two rules from
// the repo's "degrade loudly" convention shape the union:
//
//   - "no source to confirm against" and "tried and failed" are DIFFERENT facts and must not
//     collapse into one "unknown". An `upload` has nothing to be stale relative to; a Figma file the
//     API refused is a body that may well be behind the live design. Only the second is a warning.
//   - a confirmed document STATES its revision rather than saying nothing, so "which revision did
//     this run build against" is answerable from the materialised context after the fact.

/**
 * Why the platform could not confirm a source-backed document against its source. Each member needs
 * a DIFFERENT fix, which is the whole reason they are not one value:
 *
 * - `not_connected`: the workspace's connection to the source is gone (revoked/disconnected), so
 *   reconnecting it is the remedy.
 * - `credentials_unreadable`: the connection could not be READ at all, so the platform never got as
 *   far as asking the source. Distinct from `not_connected` (which is a definite "there is no
 *   connection") because the remedy is the deployment's, not the workspace's — and distinct from
 *   `source_unreachable` because the source is not the thing that failed. The case that makes this
 *   load-bearing rather than defensive is MOTHERSHIP MODE: a node runs the engine with no main
 *   database and reaches org state over the persistence RPC, but a document-source connection is
 *   sealed with the mothership's `ENCRYPTION_KEY` and therefore cannot be served remotely, so the
 *   read fails permanently and BY DESIGN there. Reporting that as an outage would send an operator
 *   hunting a Figma incident that does not exist.
 * - `unversioned`: the source answered but exposes no version token to compare (a Zeplin project
 *   with no `updated` stamp), so there is nothing to fix — the freshness mechanism simply cannot
 *   apply here, and saying so beats implying the copy was checked.
 * - `source_unreachable`: the probe or the re-fetch failed (a 403, a rate limit, an outage). The
 *   run continues on the stored body; the operator's log line carries the cause.
 */
export type DocumentFreshnessGap =
  | 'not_connected'
  | 'credentials_unreadable'
  | 'unversioned'
  | 'source_unreachable'

/** What the dispatch-time refresh concluded about one linked document. */
export type DocumentFreshness =
  /**
   * Checked against the source for THIS dispatch. `reimported` records whether the check found the
   * page had moved and pulled the new body, or found it unchanged: both leave the agent reading the
   * live revision, so neither is a degradation, but the distinction is what an operator reads to
   * tell "the design is being iterated on" from "nothing has changed since import".
   */
  | { readonly status: 'confirmed'; readonly version: string; readonly reimported: boolean }
  /**
   * Nothing to confirm against: an `upload` body the platform was handed directly, or a source this
   * deployment has no provider wired for. Not a gap and not a warning — there is no fresher copy in
   * existence — so it renders NOTHING rather than a note implying a check was skipped.
   */
  | { readonly status: 'not-applicable' }
  /** The platform tried and could not confirm. The agent gets the stored body; see the reason. */
  | { readonly status: 'unconfirmed'; readonly reason: DocumentFreshnessGap }

/** The human-readable half of a {@link DocumentFreshnessGap}, for the note the agent reads. */
function describeGap(reason: DocumentFreshnessGap): string {
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
 * The materialised context file's freshness header lines, or NOTHING when there is nothing to state.
 *
 * Rendered beside `originHeaderLine` (`context-references.ts`) at the top of every `.cat-context/`
 * document, which is why it lives in kernel: the engine decides the verdict and the container's
 * materialiser renders it, and they must not each invent their own wording.
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
        `Freshness: NOT confirmed against the source (${describeGap(freshness.reason)}). This is ` +
        `the copy stored at import time and may be behind the current version — treat anything ` +
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
