import type { ReviewQuestionPost, TaskRecord } from '@cat-factory/kernel'

// Pure rendering + keying for the headless clarification loop's question writeback (slice 2a
// of `docs/initiatives/headless-clarification-loop.md`). Kept out of `IssueWritebackService`
// so the comment body — the one part of the feature a human actually reads — is unit-testable
// without a tracker, and so slice 2b's reply parser can be written against the SAME rendered
// ids rather than re-deriving them.

/**
 * The source-qualified external id a marker row is keyed by. The task projection's natural
 * key is `(source, externalId)`, so both halves are needed: two trackers can legitimately
 * hand out the same external id.
 */
export function issueRefFor(issue: Pick<TaskRecord, 'source' | 'externalId'>): string {
  return `${issue.source}:${issue.externalId}`
}

/**
 * Longest finding detail rendered into the comment. Jira in particular rejects an oversized
 * comment outright, which would turn a long review into NO writeback at all; truncating one
 * finding is strictly better than losing every one of them. The cut is marked so a reader
 * knows to open the run rather than assuming the question ended there.
 */
const MAX_DETAIL_CHARS = 1200

/** Findings rendered per comment. A review past this is a signal to look at the run itself. */
const MAX_FINDINGS = 25

function clamp(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}… (truncated)`
}

/**
 * Render a parked headless requirements review's open findings as a tracker comment.
 *
 * Two properties are load-bearing:
 *
 * - **Every finding is rendered with its stable id.** That id is what a caller passes to
 *   `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply`, and (slice 2b) what
 *   a ticket reply names. A comment without ids is unanswerable, so the id leads each entry.
 * - **The comment states where answers go.** A headless run has no human in the app by
 *   definition; a question with no reply channel is worse than no question.
 *
 * Markdown is the common denominator: GitHub renders it natively, and the Jira/Linear paths
 * convert it (Jira via the ADF payload builder, Linear natively) exactly as they already do
 * for the PR-open/PR-merge comments.
 */
export function renderReviewQuestionsComment(post: ReviewQuestionPost): string {
  const shown = post.findings.slice(0, MAX_FINDINGS)
  const omitted = post.findings.length - shown.length
  const lines = [
    '🤖 cat-factory paused this work to get its requirements straight. It raised ' +
      `${post.findings.length} open question${post.findings.length === 1 ? '' : 's'} ` +
      `(review pass ${post.iteration} of ${post.maxIterations}) and the run is waiting for ` +
      'answers before any code is written.',
    '',
  ]
  for (const finding of shown) {
    lines.push(
      `**\`${finding.id}\`** — ${clamp(finding.title, 200)}`,
      '',
      clamp(finding.detail, MAX_DETAIL_CHARS),
      '',
    )
  }
  if (omitted > 0) {
    lines.push(
      `_${omitted} further question${omitted === 1 ? '' : 's'} omitted for length — open ` +
        `run \`${post.runId}\` to see all of them._`,
      '',
    )
  }
  lines.push(
    'Answer each question by its id through the platform API — ' +
      `\`POST /api/v1/runs/${post.runId}/decisions/requirements/items/<id>/reply\` — or dismiss ` +
      'the ones that do not apply. The run resumes as soon as none are left open.',
  )
  return lines.join('\n')
}
