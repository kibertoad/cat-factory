import type {
  Notification,
  NotificationType,
  SlackMemberMappingEntry,
  SlackMemberRole,
  SlackNotificationSettings,
  SlackRoute,
} from '@cat-factory/kernel'

// Pure helpers for the Slack notification transport: default settings, route
// resolution, audience/role targeting, and rendering a notification into a Slack
// `chat.postMessage` body. No I/O here — unit-testable and shared by both facades.

/** HKDF domain-separation tag for the Slack bot-token cipher. */
export const SLACK_CIPHER_INFO = 'cat-factory:slack'

/** The notification types Slack routing can target (mirrors the closed set). */
export const SLACK_ROUTABLE_TYPES: NotificationType[] = [
  'merge_review',
  'pipeline_complete',
  'ci_failed',
  // Routable for the same reason `ci_failed` is: the machine gave up on a branch somebody owns.
  'deploy_blocked',
  'requirement_review',
  'release_regression',
  'human_test_ready',
  // Deployment-level operational alert — an operator wants it in their ops channel.
  'platform_health',
  // An infrastructure outage is the same shape of alert: routable, so it reaches the ops channel
  // rather than only an in-app banner someone has to be looking at the board to see.
  'infra_unreachable',
  // A budget warning is routable for the same reason, and more sharply: its whole value is
  // arriving BEFORE runs start pausing, which an in-app card only manages if somebody happens to
  // have the board open. `budget_paused` stays in-app-only because by then the damage is done.
  'budget_threshold',
]

/** A mapping entry's role, defaulting to `engineering` when unset (legacy entries). */
export function resolveMemberRole(entry: SlackMemberMappingEntry): SlackMemberRole {
  return entry.role ?? 'engineering'
}

/**
 * Who a notification @-mentions, by audience:
 *   - `roles`         — every mapped member with one of these roles is mentioned.
 *   - `includeCreator`— also mention the task's creator (whoever they are).
 *
 * `requirement_review` is the product surface: product people are told to react to
 * the findings, plus the creator. The engineering notifications target ONLY the
 * creator — a build event is that person's to drive, not the whole workspace's (and
 * product people, who don't care, are never pinged). A type with no policy mentions
 * no one (still posts to its channel).
 */
export interface MentionAudience {
  roles: SlackMemberRole[]
  includeCreator: boolean
}

const MENTION_AUDIENCE: Record<NotificationType, MentionAudience> = {
  merge_review: { roles: [], includeCreator: true },
  pipeline_complete: { roles: [], includeCreator: true },
  // A post-hoc "how much review did that need?" nudge for a PR that already merged: the
  // creator is the only person who can answer, and nobody else needs paging over it.
  merge_tag_request: { roles: [], includeCreator: true },
  ci_failed: { roles: [], includeCreator: true },
  test_failed: { roles: [], includeCreator: true },
  // The creator's, exactly as `ci_failed` is. Classification keeps every cause outside the
  // repository out of this loop, so what is left when the fixer gives up is a defect in the
  // deployment files on their own branch, not something an infrastructure role would take.
  deploy_blocked: { roles: [], includeCreator: true },
  requirement_review: { roles: ['product'], includeCreator: true },
  clarity_review: { roles: ['product'], includeCreator: true },
  // A post-release regression is an operational event: tell the on-call engineers and
  // the task's creator.
  release_regression: { roles: ['engineering'], includeCreator: true },
  decision_required: { roles: [], includeCreator: true },
  // The human-testing gate is a product-facing validation moment: tell the task's creator
  // (whoever owns driving it) and the product reviewers.
  human_test_ready: { roles: ['product'], includeCreator: true },
  // The visual-confirmation gate is a product-facing UI review moment: tell the creator + product.
  visual_confirmation_ready: { roles: ['product'], includeCreator: true },
  // The human-review gate waits on a human code reviewer: tell the engineers + the creator.
  human_review: { roles: ['engineering'], includeCreator: true },
  // The Coder surfaced follow-ups/questions to triage: tell the task's creator (who decides
  // file / send back / answer / dismiss).
  followup_pending: { roles: [], includeCreator: true },
  // The fork-decision phase surfaced materially different implementation approaches: tell the
  // task's creator (who picks the approach before the Coder starts).
  fork_decision_pending: { roles: [], includeCreator: true },
  // A rubric verdict the run parked on: the task's creator decides whether to proceed, send
  // it back, or stop — the engineers are who a rework round lands on, so mention both.
  judge_review: { roles: ['engineering'], includeCreator: true },
  // The PR reviewer surfaced findings to triage: tell the task's creator (who selects which
  // findings to act on) and the engineers.
  pr_review_ready: { roles: ['engineering'], includeCreator: true },
  // An initiative needs attention (a blocked task, or completion): tell the creator (who owns
  // the initiative) and the engineers driving its work.
  initiative: { roles: ['engineering'], includeCreator: true },
  // A platform-health alert is an operational, deployment-wide event with no task creator
  // (block-less): mention the engineers (the operators who watch the deployment).
  platform_health: { roles: ['engineering'], includeCreator: false },
  // A workspace-wide spend pause: no task creator (block-less), so it @-mentions no one. It is
  // in-app-only (absent from SLACK_ROUTABLE_TYPES) — this entry only satisfies the exhaustive map.
  budget_paused: { roles: [], includeCreator: false },
  // The PROACTIVE spend warning, also block-less (no task creator): it goes to the engineers, who
  // are the people who can raise the budget or stop what is burning it.
  budget_threshold: { roles: ['engineering'], includeCreator: false },
  // An ENCRYPTION_KEY-drift alert (ADR 0026 D6.2): an operational, deployment-wide credential
  // issue for the operators who watch the deployment; in-app-only (absent from SLACK_ROUTABLE_TYPES).
  key_drift: { roles: ['engineering'], includeCreator: false },
  // A configured infrastructure connection stopped answering: operational and block-less (no task
  // creator), so it goes to the engineers who can restart the thing, like `platform_health`.
  infra_unreachable: { roles: ['engineering'], includeCreator: false },
}

/** The mention audience for a notification type. */
export function mentionAudience(type: NotificationType): MentionAudience {
  return MENTION_AUDIENCE[type]
}

/**
 * Resolve the Slack member ids to @-mention for a notification, given the account's
 * member map and the (optional) GitHub id of the task creator. Members are matched
 * by role; the creator is added when the audience calls for it AND they have a
 * mapping. De-duplicated, preserving first-seen order (roles first, then creator).
 */
export function resolveMentionTargets(
  type: NotificationType,
  mapping: SlackMemberMappingEntry[],
  creatorUserId: string | null | undefined,
): string[] {
  const audience = mentionAudience(type)
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (slackId: string) => {
    if (!seen.has(slackId)) {
      seen.add(slackId)
      ids.push(slackId)
    }
  }
  if (audience.roles.length > 0) {
    for (const entry of mapping) {
      if (audience.roles.includes(resolveMemberRole(entry))) add(entry.slackUserId)
    }
  }
  if (audience.includeCreator && creatorUserId != null) {
    const creator = mapping.find((e) => e.userId === creatorUserId)
    if (creator) add(creator.slackUserId)
  }
  return ids
}

/**
 * The default settings for a workspace that has never configured Slack: every
 * type present but unrouted (empty channel) and disabled, mentions off. So a
 * fresh workspace posts nothing until a human sets a channel.
 */
export function defaultSlackSettings(updatedAt: number): SlackNotificationSettings {
  const routes: Partial<Record<NotificationType, SlackRoute>> = {}
  for (const type of SLACK_ROUTABLE_TYPES) {
    routes[type] = { enabled: false, channel: '' }
  }
  return {
    routes: routes as SlackNotificationSettings['routes'],
    mentionsEnabled: false,
    updatedAt,
  }
}

/**
 * Resolve the channel a notification should post to, or null when it must not
 * post (no settings, type missing/disabled, or empty channel).
 */
export function resolveRoute(
  settings: SlackNotificationSettings,
  type: NotificationType,
): string | null {
  const route = settings.routes[type]
  if (!route || !route.enabled) return null
  const channel = route.channel.trim()
  return channel.length > 0 ? channel : null
}

/** A short per-type prefix so a Slack reader can triage at a glance. */
const TYPE_LABEL: Record<NotificationType, string> = {
  merge_review: ':eyes: Merge review',
  pipeline_complete: ':white_check_mark: Pipeline complete',
  merge_tag_request: ':label: Tag review effort',
  ci_failed: ':rotating_light: CI failed',
  test_failed: ':rotating_light: Tests failed',
  deploy_blocked: ':construction: Deployment blocked',
  requirement_review: ':memo: Requirement review',
  clarity_review: ':mag: Bug-report triage',
  release_regression: ':rotating_light: Release regression',
  decision_required: ':vertical_traffic_light: Decision needed',
  human_test_ready: ':test_tube: Ready for human testing',
  visual_confirmation_ready: ':camera: Ready for visual confirmation',
  human_review: ':bust_in_silhouette: Awaiting code review',
  followup_pending: ':compass: Follow-ups to decide',
  fork_decision_pending: ':fork_and_knife: Choose an implementation approach',
  judge_review: ':balance_scale: Review verdict needs a decision',
  pr_review_ready: ':clipboard: PR review findings',
  initiative: ':world_map: Initiative update',
  platform_health: ':bar_chart: Platform health alert',
  budget_paused: ':moneybag: Runs paused — spend budget reached',
  budget_threshold: ':chart_with_upwards_trend: Spend budget warning',
  key_drift: ':key: Encryption-key drift — credentials need re-entry',
  infra_unreachable: ':electric_plug: Infrastructure unreachable',
}

/** Format a percentage from a 0..1 score for the assessment context line. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/**
 * A rendered `chat.postMessage` body. A type alias rather than an `interface` so it keeps the
 * implicit index signature `postJson`'s `Record<string, unknown>` parameter needs. As an
 * interface the client had to assert it through `unknown` to post it.
 */
export type SlackMessageBody = {
  channel: string
  text: string
  blocks: unknown[]
}

/**
 * Render a notification into a Slack message. `mentions` are pre-resolved Slack
 * member ids (already filtered to those configured); they are prefixed to the
 * body as `<@id>` so the people are tagged. `text` is the notification fallback
 * (for push/preview); `blocks` carry the rich layout.
 */
export function renderNotificationMessage(
  notification: Notification,
  channel: string,
  mentions: string[],
): SlackMessageBody {
  const label = TYPE_LABEL[notification.type]
  const mentionPrefix = mentions.length ? `${mentions.map((id) => `<@${id}>`).join(' ')} ` : ''

  const bodyLines: string[] = [`*${notification.title}*`]
  if (notification.body) bodyLines.push(notification.body)

  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${label}` } },
    { type: 'section', text: { type: 'mrkdwn', text: `${mentionPrefix}${bodyLines.join('\n')}` } },
  ]

  const contextElements: { type: 'mrkdwn'; text: string }[] = []
  const payload = notification.payload
  if (payload?.pipelineName) {
    contextElements.push({ type: 'mrkdwn', text: `Pipeline: ${payload.pipelineName}` })
  }
  if (typeof payload?.findingCount === 'number') {
    const n = payload.findingCount
    contextElements.push({ type: 'mrkdwn', text: `${n} open finding${n === 1 ? '' : 's'}` })
  }
  if (payload?.assessment) {
    const a = payload.assessment
    contextElements.push({
      type: 'mrkdwn',
      text: `Complexity ${pct(a.complexity)} · Risk ${pct(a.risk)} · Impact ${pct(a.impact)}`,
    })
  }
  if (payload?.prUrl) {
    contextElements.push({ type: 'mrkdwn', text: `<${payload.prUrl}|View PR>` })
  }
  if (contextElements.length) {
    blocks.push({ type: 'context', elements: contextElements })
  }

  return {
    channel,
    text: `${label}: ${notification.title}`,
    blocks,
  }
}
