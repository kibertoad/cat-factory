/**
 * "The text to show for this failure", for a surface that renders it INLINE rather than as a
 * toast: a store whose error a panel prints, a message above Retry, a probe verdict.
 *
 * It is the toast funnel's own classification, not a second vocabulary. A conflict resolves its
 * description through `refusalCopy(reason)`, which reads the bespoke conflicts' fixed cause lines
 * and then the same `conflictInfo` entry `presentMappedConflict` reads, and every other failure
 * goes through `describeGenericFailure`. So a reason gains its translated copy in ONE place and the
 * toast and the inline message agree about it. The shape is the toast's own `GenericFailure`, and
 * the raw detail is joined by the toast's own `failureDetail`.
 *
 * Pure (no i18n, no store), so a Pinia store can hold the result as state and a spec can assert
 * it. `FailureMessage.vue` renders it.
 */

import {
  describeGenericFailure,
  failureDetail,
  parseConflict,
  type GenericFailure,
} from '~/composables/usePipelineErrorToast'
import { refusalCopy } from '~/utils/conflictCopy'

/** A failure classified for presentation: the translated part and the raw detail behind it. */
export type DescribedFailure = GenericFailure

export { failureDetail }

/**
 * A surface's own copy for the reasons it words itself, keyed on the backend's `details.reason`.
 * Checked before the shared copy, so a surface overrides only the reasons it names.
 */
export type ReasonCopy = Readonly<Partial<Record<string, string>>>

/** Description for a conflict whose reason this build has no copy for (as the toast uses). */
const CONFLICT_FALLBACK_KEY = 'errors.conflict.fallbackMessage'

/** Description for a failure the backend reported as DATA (as `presentReported` uses). */
const REPORTED_DESCRIPTION_KEY = 'errors.reported.description'

/**
 * Classify a thrown failure, with a surface's own copy for the reasons it names. Never throws and
 * never returns an empty `descriptionKey`, for the same reason as `describeGenericFailure`: a
 * failure with no description reads as a success.
 */
export function describeFailure(error: unknown, overrides?: ReasonCopy): DescribedFailure {
  const conflict = parseConflict(error)
  const failure: DescribedFailure = conflict
    ? {
        descriptionKey: refusalCopy(conflict.reason)?.descriptionKey ?? CONFLICT_FALLBACK_KEY,
        message: conflict.message ?? null,
        issues: [],
        requestId: conflict.requestId ?? null,
        reason: conflict.reason ?? null,
      }
    : describeGenericFailure(error)
  return withReasonCopy(failure, overrides)
}

/**
 * Re-word an already classified failure with a surface's own copy for its reason, for a store
 * that keeps the failure while the surface that renders it owns the wording.
 */
export function withReasonCopy(
  failure: DescribedFailure,
  overrides: ReasonCopy | undefined,
): DescribedFailure {
  const key = failure.reason ? overrides?.[failure.reason] : undefined
  return key ? { ...failure, descriptionKey: key } : failure
}

/**
 * A failure the backend reported as DATA rather than as a failed call (a job row's `error`, a
 * verdict's `reason`). There is no envelope to classify, so the description is the caller's key
 * or the generic "it reported a failure", and the reported text is the detail.
 */
export function reportedFailure(
  detail: string | null | undefined,
  descriptionKey: string = REPORTED_DESCRIPTION_KEY,
): DescribedFailure {
  const message = detail?.trim()
  return {
    descriptionKey,
    message: message ? message : null,
    issues: [],
    requestId: null,
    reason: null,
  }
}
