import { describeGenericFailure } from '~/composables/usePipelineErrorToast'

/** A failed grant completion, split into the translated line and the untranslated detail. */
export interface CallbackFailure {
  /** i18n key for the translated description shown up front. */
  descriptionKey: string
  /** The backend's prose, validation issues and request id, for the disclosure; empty when none. */
  detail: string
}

/**
 * Describe a failed `completeToolServerOAuth` call through the same classifier the failure toasts
 * use, so the envelope is read from where the API client keeps it (`ApiError.body`) and a known
 * status class or reason gets translated copy. The detail is joined exactly as the toast
 * disclosure joins it, so the same failure reads the same way on every surface.
 */
export function describeCallbackFailure(
  error: unknown,
  formatRequestId: (id: string) => string,
): CallbackFailure {
  const failure = describeGenericFailure(error)
  const detail = [
    failure.message,
    failure.issues.join(', '),
    failure.requestId ? formatRequestId(failure.requestId) : '',
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(' · ')
  return { descriptionKey: failure.descriptionKey, detail }
}
