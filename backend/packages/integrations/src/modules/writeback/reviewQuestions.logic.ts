import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import type { ReviewQuestionPost, TaskRecord } from '@cat-factory/kernel'

// Pure rendering + keying for the headless clarification loop's question writeback (slice 2a
// of `docs/initiatives/headless-clarification-loop.md`). Kept out of `IssueWritebackService`
// so the comment body — the one part of the feature a human actually reads — is unit-testable
// without a tracker, and so slice 2b's reply parser can be written against the SAME rendered
// ids rather than re-deriving them.
//
// Everything interpolated below except the platform's own ids is UNTRUSTED: a reviewer finding
// is model-authored prose derived from a task description a customer wrote. A tracker issue is
// a host-parsed surface (and often a PUBLIC one), so each hole goes through kernel's
// `hostMarkdown` boundary — the same one the PR verification report renders through — and
// through `redactSecrets` first. Concretely, without that: `@alice` in a finding pages whoever
// owns that handle, `#42` cross-links an unrelated issue, an unbalanced ``` fence swallows the
// answer instructions this comment exists to deliver, and a token pasted into a task
// description is republished to the world.

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

/** Longest finding title rendered on the id line. */
const MAX_TITLE_CHARS = 200

/** Findings rendered per comment. A review past this is a signal to look at the run itself. */
const MAX_FINDINGS = 25

/**
 * Hard ceiling for the whole comment, mirroring the report's `MAX_SECTION_CHARS`. The per-field
 * caps above already keep a realistic review far below it; this exists because defusing an
 * auto-link trigger EXPANDS the text (`#` becomes `&#35;`), so pathological input could still
 * outgrow a host limit — Jira Cloud rejects a comment over ~32k outright, and a rejected
 * comment is a silently unasked question. Degrade visibly instead.
 */
const MAX_COMMENT_CHARS = 30_000

/** Marks where a value was cut, so a reader never mistakes a truncation for the whole story. */
const TRUNCATION_NOTE = '… (truncated)'

/** Scrub secrets, then hand to the host boundary. Order matters: scrub BEFORE any cut, so a
 * half-truncated credential can never survive as plausible-looking text. */
function safeInline(value: string, max: number): string {
  return hostMarkdown.inline(redactSecrets(value) ?? '', max)
}

function safeProse(value: string, max: number): string {
  return hostMarkdown.prose(redactSecrets(value) ?? '', max)
}

/**
 * Render a parked headless requirements review's open findings as a tracker comment.
 *
 * Two properties are load-bearing:
 *
 * - **Every finding is rendered with its stable id.** That id is what a caller passes to
 *   `POST /api/v1/runs/:runId/decisions/requirements/items/:itemId/reply`, and (slice 2b) what
 *   a ticket reply names. A comment without ids is unanswerable, so the id leads each entry.
 *   Ids are platform-minted, so they are the ONE thing here rendered verbatim.
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
      `**\`${finding.id}\`** — ${safeInline(finding.title, MAX_TITLE_CHARS)}`,
      '',
      safeProse(finding.detail, MAX_DETAIL_CHARS),
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
  return capComment(lines.join('\n'))
}

/**
 * Last-resort whole-comment cut. Anything trimmed here has already survived the per-field caps,
 * so it is pathological rather than merely long — but a host that rejects the payload posts
 * NOTHING, which is the one outcome worse than a marked truncation.
 */
function capComment(body: string): string {
  if (body.length <= MAX_COMMENT_CHARS) return body
  // The budget covers the note and the newline joining it, so the result is <= the cap rather
  // than a character over it — the point of a hard ceiling is that it actually holds.
  const room = MAX_COMMENT_CHARS - TRUNCATION_NOTE.length - 1
  return `${body.slice(0, room).trimEnd()}\n${TRUNCATION_NOTE}`
}
