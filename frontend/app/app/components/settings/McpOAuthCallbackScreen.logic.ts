import type { ToolServerOAuthReason } from '@cat-factory/contracts'
import { apiErrorReason } from '~/composables/api/errors'
import { describeGenericFailure } from '~/composables/usePipelineErrorToast'

/**
 * Why the callback page could not finish the grant. `text` is a line the page already has in
 * hand (the vendor's own refusal, or a link with nothing to complete); `api` is a refusal from our
 * own API, split into the translated line and the untranslated detail behind "Show details".
 */
export type CallbackFailure =
  | { kind: 'text'; text: string }
  | {
      kind: 'api'
      /** i18n key for the translated description shown up front. */
      descriptionKey: string
      /** The backend's prose, validation issues and request id; empty when there is none. */
      detail: string
      /** Whether starting the connection again can help, so the page says to. */
      restartHint: boolean
    }

/** Reasons a fresh start cannot fix: the server has no OAuth, or the flow is someone else's. */
const NO_RESTART: ReadonlySet<string> = new Set<ToolServerOAuthReason>([
  'tool_server_without_oauth',
  'oauth_started_by_other_user',
])

/**
 * Describe a failed `completeToolServerOAuth` call through the same classifier the failure toasts
 * use, so the envelope is read from where the API client keeps it (`ApiError.body`) and a known
 * status class or reason gets translated copy. The detail is joined as the toast disclosure joins
 * it.
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
  const reason = apiErrorReason(error)
  return {
    kind: 'api',
    descriptionKey: failure.descriptionKey,
    detail,
    restartHint: !reason || !NO_RESTART.has(reason),
  }
}
