import type { Notification } from '~/types/domain'

/**
 * The verb that takes a person to where a notification is ANSWERED, used by the queue-first
 * preview's inbox (issue #2258, finding F4).
 *
 * Today a parked decision's card offers "Mark read" as its only button, while the routing that
 * opens the decision already exists behind the card's title. This names that route with its
 * verb, so the one moment the product asks for a human carries the action rather than a way to
 * silence it.
 *
 * Exhaustive over the notification types, so a new type has to decide. `null` means the card's
 * own act button already IS the action (Merge, Retry run, Acknowledge), or there is nowhere to
 * go beyond the card itself.
 */
export const NOTIFICATION_GO_TO_KEYS: Record<Notification['type'], string | null> = {
  merge_review: null,
  pipeline_complete: null,
  merge_tag_request: null,
  ci_failed: null,
  test_failed: null,
  deploy_blocked: null,
  release_regression: null,
  platform_health: null,
  infra_unreachable: null,
  key_drift: null,
  budget_threshold: null,
  requirement_review: 'homePreview.inbox.verb.review',
  clarity_review: 'homePreview.inbox.verb.review',
  decision_required: 'homePreview.inbox.verb.answer',
  human_test_ready: 'homePreview.inbox.verb.test',
  visual_confirmation_ready: 'homePreview.inbox.verb.confirm',
  human_review: 'homePreview.inbox.verb.review',
  followup_pending: 'homePreview.inbox.verb.triage',
  fork_decision_pending: 'homePreview.inbox.verb.choose',
  judge_review: 'homePreview.inbox.verb.review',
  pr_review_ready: 'homePreview.inbox.verb.review',
  bug_fishing_triage: 'homePreview.inbox.verb.triage',
  initiative: 'homePreview.inbox.verb.open',
  budget_paused: 'homePreview.inbox.verb.open',
}
