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
  'requirement_review',
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
  ci_failed: { roles: [], includeCreator: true },
  requirement_review: { roles: ['product'], includeCreator: true },
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
  creatorGithubId: number | null | undefined,
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
  if (audience.includeCreator && creatorGithubId != null) {
    const creator = mapping.find((e) => e.githubUserId === creatorGithubId)
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
  ci_failed: ':rotating_light: CI failed',
  requirement_review: ':memo: Requirement review',
}

/** Format a percentage from a 0..1 score for the assessment context line. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

export interface SlackMessageBody {
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
