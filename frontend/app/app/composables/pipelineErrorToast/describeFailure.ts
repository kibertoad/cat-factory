/**
 * "The text to show for this failure", for a surface that renders it INLINE rather than as a
 * toast: a store whose error a panel prints, a message above a Retry button, a probe verdict.
 *
 * It is the toast funnel's own classification, not a second vocabulary. A conflict resolves its
 * description from the same `conflictInfo(reason)` entry `presentMappedConflict` reads, and every
 * other failure goes through `describeGenericFailure`, so a reason gains its translated copy in
 * ONE place and the toast and the inline message agree about it. What is kept raw (the backend's
 * prose, a validation 400's issues, the request id) is the same detail the toast puts behind
 * "Show details", joined the same way by {@link failureDetail}.
 *
 * Pure (no i18n, no store), so a Pinia store can hold the result as state and a spec can assert
 * it. `FailureMessage.vue` renders it.
 */

import { describeGenericFailure, parseConflict } from '~/composables/usePipelineErrorToast'
import { conflictInfo } from '~/utils/conflictCopy'

/** A failure classified for presentation: the translated part and the raw detail behind it. */
export interface DescribedFailure {
  /** i18n key for the translated description shown up front. */
  descriptionKey: string
  /** The backend's untranslated prose, when there is any. Detail, never the headline. */
  message: string | null
  /** `path: message` entries from a request-validation 400, in wire order. */
  issues: string[]
  /** The envelope's correlation id, so the user can quote it at whoever reads the logs. */
  requestId: string | null
}

/** Description for a conflict whose reason this build has no copy for (as the toast uses). */
const CONFLICT_FALLBACK_KEY = 'errors.conflict.fallbackMessage'

/** Description for a failure the backend reported as DATA (as `presentReported` uses). */
const REPORTED_DESCRIPTION_KEY = 'errors.reported.description'

/**
 * Classify a thrown failure. Never throws and never returns an empty `descriptionKey`, for the
 * same reason as `describeGenericFailure`: a failure with no description reads as a success.
 */
export function describeFailure(error: unknown): DescribedFailure {
  const conflict = parseConflict(error)
  if (!conflict) return describeGenericFailure(error)
  return {
    descriptionKey: conflictInfo(conflict.reason)?.descriptionKey ?? CONFLICT_FALLBACK_KEY,
    message: conflict.message ?? null,
    issues: [],
    requestId: conflict.requestId ?? null,
  }
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
  return { descriptionKey, message: message ? message : null, issues: [], requestId: null }
}

/**
 * The raw detail as one line, joined exactly as the toast disclosure joins it. Empty parts drop
 * out, so an empty result means there is nothing to disclose and the caller shows no button.
 */
export function failureDetail(
  failure: DescribedFailure,
  t: (key: string, params: Record<string, unknown>) => string,
): string {
  return [
    failure.message,
    failure.issues.join(', '),
    failure.requestId ? t('errors.generic.requestId', { id: failure.requestId }) : '',
  ]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(' · ')
}
