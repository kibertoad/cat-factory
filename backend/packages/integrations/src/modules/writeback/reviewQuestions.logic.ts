import {
  replyPublicRunClarityFindingContract,
  replyPublicRunFindingContract,
} from '@cat-factory/contracts'
import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import type { ReviewQuestionPost, ReviewQuestionSubject, TaskRecord } from '@cat-factory/kernel'
// The marker every platform-authored tracker comment opens with. Shared with the reply renderer
// (and the ingest guard that keys off it) so the two can never emit different prefixes — a comment
// this side stopped marking is a comment the reply path would start ingesting as a human's.
import { PLATFORM_COMMENT_MARKER } from './reviewReplies.logic.js'

// Pure rendering + keying for the headless clarification loop's question writeback (slice 2a
// of `backend/docs/adr/0047-headless-clarification-loop.md`). Kept out of `IssueWritebackService`
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
 * Per-subject copy: what the run stopped to establish, and which decision route answers it.
 *
 * A `Record` over the closed {@link ReviewQuestionSubject} union rather than a branch, so adding a
 * subject cannot ship with the requirements loop's wording (and, worse, the requirements loop's
 * route) on a comment about something else.
 *
 * Both members are FUNCTIONS, and both for the same reason: a string with holes in it is a
 * contract nothing checks. `opening` was a `{n}`/`{s}`/`{i}`/`{max}` mini-template filled by
 * sequential `.replace()`, so a mistyped placeholder shipped a literal `{n}` to a bug reporter
 * with nothing failing; as a function the arity is a typecheck. And `replyPath` delegates to the
 * ROUTE CONTRACT's own `pathResolver` rather than restating the path, because the hand-written
 * copy said `…/items/<id>/reply` where the surface serves `…/findings/:itemId/reply` — a 404
 * printed on a reporter's ticket, pinned by a test that had copied the same mistake. Deriving it
 * from the one source the server routes off means the two cannot disagree again.
 */
const SUBJECT_COPY: Record<
  ReviewQuestionSubject,
  {
    opening: (findings: number, iteration: number, maxIterations: number) => string
    replyPath: (runId: string, itemId: string) => string
  }
> = {
  requirements: {
    opening: (n, i, max) =>
      `cat-factory paused this work to get its requirements straight. It raised ${n} ` +
      `open question${n === 1 ? '' : 's'} (review pass ${i} of ${max}) and the run is waiting ` +
      'for answers before any code is written.',
    replyPath: (runId, itemId) => replyPublicRunFindingContract.pathResolver({ runId, itemId }),
  },
  clarity: {
    opening: (n, i, max) =>
      `cat-factory cannot confidently fix this bug from the report as written. It raised ${n} ` +
      `open question${n === 1 ? '' : 's'} (triage pass ${i} of ${max}) and the run is waiting ` +
      'for answers.',
    replyPath: (runId, itemId) =>
      replyPublicRunClarityFindingContract.pathResolver({ runId, itemId }),
  },
}

/** The `<id>` stand-in rendered into the API path, since one comment covers every finding. */
const ID_PLACEHOLDER = '<id>'

/** What a reader of this comment can actually answer through. */
export interface ReviewQuestionChannels {
  /**
   * Whether a reply typed on THIS ticket reaches the run.
   *
   * Load-bearing, and REQUIRED rather than defaulted, because it decides which channel the copy
   * puts first and a wrong default is invisible: the inbound path needs a minted per-connection
   * webhook secret, so a workspace on pull-based intake has none, and telling that reporter to
   * reply on the ticket is the "question with no reply channel" this renderer's own contract
   * calls worse than no question. A caller that has not established the fact must say `false`.
   */
  ticketReplies: boolean
}

/**
 * Render a parked review's open findings as a tracker comment.
 *
 * Three properties are load-bearing:
 *
 * - **Every finding is rendered with its stable id.** That id is what a caller passes to the
 *   subject's reply route, and what a ticket reply names. A comment without ids is unanswerable,
 *   so the id leads each entry. Ids are platform-minted, so they are the ONE thing here rendered
 *   verbatim.
 * - **It offers only channels that WORK.** Where a ticket reply reaches the run, the grammar comes
 *   first: the reporter is reading this in their tracker, and telling them only about an HTTP
 *   route asks the one person who came through the ticket to leave it. Where it does not
 *   ({@link ReviewQuestionChannels}), the grammar is OMITTED rather than printed as advice that
 *   silently does nothing, and the API line carries the whole answer path on its own.
 * - **The wording matches the SUBJECT.** A bug reporter asked to "get the requirements straight"
 *   reasonably concludes the comment landed on the wrong ticket.
 *
 * Markdown is the common denominator: GitHub renders it natively, and the Jira/Linear paths
 * convert it (Jira via the ADF payload builder, Linear natively) exactly as they already do
 * for the PR-open/PR-merge comments.
 */
export function renderReviewQuestionsComment(
  post: ReviewQuestionPost,
  channels: ReviewQuestionChannels,
): string {
  const copy = SUBJECT_COPY[post.subject]
  const shown = post.findings.slice(0, MAX_FINDINGS)
  const omitted = post.findings.length - shown.length
  const lines = [
    PLATFORM_COMMENT_MARKER +
      copy.opening(post.findings.length, post.iteration, post.maxIterations),
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
  const apiPath = `\`POST ${copy.replyPath(post.runId, ID_PLACEHOLDER)}\``
  lines.push(
    channels.ticketReplies
      ? 'Answer here by replying with `@cat-factory answer <id> <your answer>` on its own line ' +
          'for each (or `@cat-factory dismiss <id>` for the ones that do not apply). The same ' +
          `answers go through the platform API at ${apiPath}. The run resumes as soon as none ` +
          'are left open.'
      : `Answer each question by its id through the platform API — ${apiPath} — or dismiss the ` +
          'ones that do not apply. The run resumes as soon as none are left open.',
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
