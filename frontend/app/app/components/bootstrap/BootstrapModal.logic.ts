import type { BootstrapReferenceReason } from '@cat-factory/contracts'
import { apiErrorEnvelope, apiErrorReason } from '~/composables/api/errors'
import type { BootstrapDelivery } from '~/types/domain'
import { repoPathSegments } from '~/utils/repoPath'

// The pure half of the bootstrap launch form: the monorepo service-directory field, the delivery
// default, and the refusal a launch can come back with. The directory field holds one string but
// carries two decisions: what the new directory is CALLED and WHERE in the repo it sits. Browsing
// the repo tree answers only the second, so it rewrites the parent and keeps the leaf, which means
// both halves have to be readable off the typed value on their own. Extracted for the reason every
// `*.logic.ts` here is: a decision worth a test should not need a mounted component to reach.

/**
 * What the new directory is called: the last segment of the typed path.
 *
 * Falls back to the service name, which is what the field's own seeding watcher would have put
 * there anyway, so opening the tree before typing a path still has a name to place. Empty only
 * when NEITHER is known, and that answer is load-bearing: with nothing to place, the tree can
 * decide nothing and says so rather than offering picks that compose a bare folder path.
 */
export function serviceDirectoryLeaf(directory: string, serviceName: string): string {
  return repoPathSegments(directory).at(-1) ?? serviceName.trim()
}

/**
 * The folder the typed path sits in, and so where the tree should OPEN: empty for a bare name,
 * because a name with no parent is a directory at the repo root.
 */
export function serviceDirectoryParent(directory: string): string {
  return repoPathSegments(directory).slice(0, -1).join('/')
}

/**
 * The delivery a target takes when nobody has answered the question.
 *
 * The backend applies the same rule for a request that names none, and it is stated on both
 * sides deliberately: the form has to SHOW the default it is about to send, and a control
 * rendering the wrong one asks the person to correct something they never chose. The two targets
 * want opposite answers, which is why it is a function of the target rather than a constant.
 *
 * Also what the form RESETS to after a launch: an explicit choice binds the run it was made for,
 * never every later one, so the reset restores the default for whatever target is still selected.
 */
export function defaultBootstrapDelivery(intoMonorepo: boolean): BootstrapDelivery {
  return intoMonorepo ? 'pull_request' : 'direct_push'
}

/** A launch the backend refused because of the reference architecture it named. */
export interface ReferenceRefusal {
  reason: BootstrapReferenceReason
  /** The entry that named the repository, so the fix opens the right one of several. */
  architectureId: string | null
  /** `owner/name` as the entry spells it. */
  repo: string | null
}

/**
 * The refusal a failed launch carries, or null when it failed for anything else.
 *
 * The reason comes from the shared `apiErrorReason`, never a second hand-rolled read of the same
 * wire field: that helper is what keeps a renamed code a typecheck failure here instead of a
 * silent fall-through to the generic toast. The envelope is read directly only for the two extra
 * fields this refusal carries, which no shared accessor knows about.
 */
export function referenceRefusalOf(error: unknown): ReferenceRefusal | null {
  const reason = apiErrorReason(error)
  if (reason !== 'reference_repo_not_found' && reason !== 'reference_repo_unreadable') return null
  const details = (apiErrorEnvelope(error)?.details ?? {}) as Record<string, unknown>
  return {
    reason,
    architectureId:
      typeof details.referenceArchitectureId === 'string' ? details.referenceArchitectureId : null,
    repo: typeof details.repo === 'string' ? details.repo : null,
  }
}

/**
 * Whether saving a reference architecture makes a standing refusal stale.
 *
 * Only the entry the refusal NAMED: that one has been rewritten, so the refusal no longer
 * describes it, and whether the new value is reachable is the next launch's question. Every other
 * save leaves it alone. Clearing on any save is the bug this answers: adding a second
 * architecture, or editing an unrelated one, dropped the banner while the refused entry was still
 * selected and still unreachable, taking away the one affordance pointing at the problem.
 */
export function referenceRefusalSurvivesSave(
  /** The entry that was saved, or null/undefined when the save CREATED a new one. */
  savedArchitectureId: string | null | undefined,
  refusal: ReferenceRefusal | null,
): boolean {
  if (!refusal) return false
  return !savedArchitectureId || savedArchitectureId !== refusal.architectureId
}
