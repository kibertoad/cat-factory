import type { Notification, NotificationType } from '@cat-factory/kernel'

// Pure helpers for the email notification transport: the per-type subject label, the
// plain-text + HTML bodies, and the deep link back into the app. No I/O, so both facades
// and the tests agree without a mail provider.
//
// Plain-text first, assembled from the notification's OWN machine-readable fields. There is
// no template engine and no prose the backend invents: the card the inbox renders is the
// source of truth, and an email that says something the card does not is a second version of
// the truth to keep in step. The backend also does not localize (see CLAUDE.md), so this is
// deliberately English until per-user locale becomes a slice of its own.

/** A short per-type subject prefix, so a mailbox reader can triage without opening. */
const TYPE_LABEL: Record<NotificationType, string> = {
  merge_review: 'Merge review',
  pipeline_complete: 'Pipeline complete',
  merge_tag_request: 'Tag review effort',
  ci_failed: 'CI failed',
  test_failed: 'Tests failed',
  requirement_review: 'Requirement review',
  clarity_review: 'Bug-report triage',
  release_regression: 'Release regression',
  decision_required: 'Decision needed',
  human_test_ready: 'Ready for human testing',
  visual_confirmation_ready: 'Ready for visual confirmation',
  human_review: 'Awaiting code review',
  followup_pending: 'Follow-ups to decide',
  fork_decision_pending: 'Choose an implementation approach',
  judge_review: 'Review verdict needs a decision',
  pr_review_ready: 'PR review findings',
  initiative: 'Initiative update',
  platform_health: 'Platform health alert',
  budget_paused: 'Runs paused: spend budget reached',
  budget_threshold: 'Spend budget warning',
  key_drift: 'Encryption-key drift: credentials need re-entry',
  infra_unreachable: 'Infrastructure unreachable',
}

/** The subject label for a notification type. */
export function notificationTypeLabel(type: NotificationType): string {
  return TYPE_LABEL[type]
}

/**
 * The board deep link for a notification, or null when the deployment has no public base
 * URL configured. Null is why every body is written to stand on its own: an email whose
 * only content was "click here" would be useless on a deployment that never told the
 * backend where "here" is.
 */
export function notificationDeepLink(
  appBaseUrl: string | undefined,
  workspaceId: string,
  notification: Notification,
): string | null {
  const base = appBaseUrl?.trim()
  if (!base) return null
  // The same `?ws=&block=&run=` shape the PR verification report deep-links with, built by
  // hand for the same reason: this package is runtime-neutral and compiles without the DOM,
  // so `URLSearchParams` is not in its type surface.
  const query = Object.entries({
    ws: workspaceId,
    ...(notification.blockId ? { block: notification.blockId } : {}),
    ...(notification.executionId ? { run: notification.executionId } : {}),
  })
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
  return `${base.replace(/\/$/, '')}/?${query}`
}

export interface RenderedNotificationEmail {
  subject: string
  text: string
  html: string
}

/**
 * Render a notification into a subject/body pair.
 *
 * Only fields the card itself carries are used, and the payload contributes the same
 * context lines the Slack transport shows (pipeline, finding count, PR link). Nothing from
 * an agent context, a prompt or a credential is reachable from here — the notification
 * payload is the redacted projection the inbox already renders to every member of the board.
 */
export function renderNotificationEmail(
  notification: Notification,
  options: { link: string | null; workspaceName?: string | null } = { link: null },
): RenderedNotificationEmail {
  const label = notificationTypeLabel(notification.type)
  const scope = options.workspaceName?.trim()
  const subject = scope
    ? `[${scope}] ${label}: ${notification.title}`
    : `${label}: ${notification.title}`

  const lines: string[] = [notification.title]
  if (notification.body) lines.push('', notification.body)
  const context = contextLines(notification)
  if (context.length) lines.push('', ...context)
  if (options.link) lines.push('', `Open in cat-factory: ${options.link}`)

  const html = [
    `<p><strong>${escapeHtml(label)}</strong></p>`,
    `<p><strong>${escapeHtml(notification.title)}</strong></p>`,
    ...(notification.body ? [`<p>${escapeHtml(notification.body)}</p>`] : []),
    ...(context.length
      ? [`<ul>${context.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`]
      : []),
    ...(options.link
      ? [`<p><a href="${escapeHtml(options.link)}">Open in cat-factory</a></p>`]
      : []),
  ].join('')

  return { subject, text: lines.join('\n'), html }
}

/** The payload-derived context lines, in the order a reader wants them. */
function contextLines(notification: Notification): string[] {
  const payload = notification.payload
  if (!payload) return []
  const lines: string[] = []
  if (payload.pipelineName) lines.push(`Pipeline: ${payload.pipelineName}`)
  if (typeof payload.findingCount === 'number') {
    lines.push(`${payload.findingCount} open finding${payload.findingCount === 1 ? '' : 's'}`)
  }
  if (payload.assessment) {
    const a = payload.assessment
    lines.push(`Complexity ${pct(a.complexity)} · Risk ${pct(a.risk)} · Impact ${pct(a.impact)}`)
  }
  if (payload.prUrl) lines.push(`Pull request: ${payload.prUrl}`)
  return lines
}

function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

/**
 * Escape the five characters that change how HTML parses. The bodies here are
 * model- and user-authored (a task title, an agent's assessment prose), and the HTML part
 * is a rendered surface exactly as a PR body is — an unescaped `<` there is markup someone
 * else's mail client executes the layout of.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch] ?? ch)
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * The addresses a delivery targets: every non-empty email in the audience, de-duplicated
 * case-insensitively and in a stable order. A user with no email (a GitHub-only identity
 * with no public address) simply contributes none — there is nothing to send to, and it is
 * not a failure of this delivery.
 */
export function resolveRecipientAddresses(emails: (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const email of emails) {
    const trimmed = email?.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
