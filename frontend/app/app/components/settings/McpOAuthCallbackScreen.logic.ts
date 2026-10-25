import type { ToolServerOAuthReason } from '@cat-factory/contracts'
import { apiErrorReason } from '~/composables/api/errors'
import {
  describeFailure,
  type DescribedFailure,
} from '~/composables/pipelineErrorToast/describeFailure'

/**
 * Why the callback page could not finish the grant. `text` is a line the page already has in
 * hand (the vendor's own refusal, or a link with nothing to complete); `api` is a refusal from our
 * own API, classified as every inline failure is.
 */
export type CallbackFailure =
  | { kind: 'text'; text: string }
  | {
      kind: 'api'
      failure: DescribedFailure
      /** Whether starting the connection again can help, so the page says to. */
      restartHint: boolean
    }

/** Reasons a fresh start cannot fix: the server has no OAuth, or the flow is someone else's. */
const NO_RESTART: ReadonlySet<string> = new Set<ToolServerOAuthReason>([
  'tool_server_without_oauth',
  'oauth_started_by_other_user',
])

/** Describe a failed `completeToolServerOAuth` call. */
export function describeCallbackFailure(error: unknown): CallbackFailure {
  const reason = apiErrorReason(error)
  return {
    kind: 'api',
    failure: describeFailure(error),
    restartHint: !reason || !NO_RESTART.has(reason),
  }
}
