import type { Notification } from '~/types/domain'

/**
 * The verb that takes a person to where a notification is ANSWERED (issue #2258, finding F4).
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
  requirement_review: 'layout.notifications.goTo.review',
  clarity_review: 'layout.notifications.goTo.review',
  decision_required: 'layout.notifications.goTo.answer',
  human_test_ready: 'layout.notifications.goTo.test',
  visual_confirmation_ready: 'layout.notifications.goTo.confirm',
  human_review: 'layout.notifications.goTo.review',
  followup_pending: 'layout.notifications.goTo.triage',
  fork_decision_pending: 'layout.notifications.goTo.choose',
  judge_review: 'layout.notifications.goTo.review',
  pr_review_ready: 'layout.notifications.goTo.review',
  bug_fishing_triage: 'layout.notifications.goTo.triage',
  initiative: 'layout.notifications.goTo.open',
  budget_paused: 'layout.notifications.goTo.open',
}
