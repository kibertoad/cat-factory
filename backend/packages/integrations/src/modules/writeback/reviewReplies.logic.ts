import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'
import type {
  ReviewReplyAck,
  ReviewQuestionFinding,
  TrackerCommentAuthor,
} from '@cat-factory/kernel'

// The ticket-reply half of the clarification loop: parse a tracker comment into review commands,
// and render the acknowledgement that goes back onto the same issue.
//
// Kept pure and separate from `TrackerWebhookService` for the same reason `reviewQuestions.logic.ts`
// is separate from `IssueWritebackService` — the grammar and the comment body are the parts a human
// actually interacts with, so they must be unit-testable without a tracker. They are DELIBERATELY
// siblings in this directory: the ids this parser matches are exactly the ids
// `renderReviewQuestionsComment` renders, and splitting them across packages is how the two halves
// would silently desync.
//
// Everything here treats the comment as UNTRUSTED third-party text — on a public repo anyone can
// write one. Three properties are load-bearing:
//
//  1. **Only explicit commands are interpreted.** A line counts only when its first non-space token
//     is the trigger. Prose in the same comment is ignored, so a human can answer and discuss in
//     one message, and no amount of natural-language phrasing can be mistaken for an instruction.
//  2. **The grammar cannot reach outside the review.** There is no verb for a model, a pipeline, a
//     repo write, or a scope change — the most a comment can do is answer/dismiss a finding it
//     names, or pick one of the three choices the SPA offers at the iteration cap.
//  3. **Nothing is echoed back raw.** The ack renders through kernel's `hostMarkdown` +
//     `redactSecrets`, exactly like the question comment, because a tracker issue is a host-parsed
//     and frequently PUBLIC surface.

/** The command trigger. Case-insensitive; must be the first token on the line. */
const TRIGGER = '@cat-factory'

/**
 * The prefix every comment the PLATFORM writes onto a tracker issue opens with — the question
 * echo and the reply acknowledgement alike. Exported so both renderers use the one constant and
 * {@link isPlatformAuthoredComment} can never drift from what they emit.
 */
export const PLATFORM_COMMENT_MARKER = '🤖 '

/**
 * Whether a comment body is one WE wrote.
 *
 * The identity checks in {@link isAllowedReplyAuthor} are the first line of defence, but they are
 * not complete by construction: Linear flags no bots on a comment author (`bot: false`, honestly
 * reported) and the default allow-list admits any author, so on Linear the platform's own
 * acknowledgement is an ALLOWED author commenting on an issue it is linked to. Today no loop
 * results, but only because no line of an ack happens to begin with the trigger — an invariant
 * spread across two renderers, enforced by nothing, and one edit away from an unbounded
 * comment loop (each ack carries a fresh comment id, so the ingest claim cannot stop it).
 *
 * So the guard is STRUCTURAL rather than incidental: a body whose first non-blank line opens with
 * the marker is ours, and is never ingested. It costs one string comparison and removes the whole
 * class of failure, on every vendor, whatever a future renderer says.
 */
export function isPlatformAuthoredComment(body: string): boolean {
  const first = body.split(/\r?\n/).find((line) => line.trim().length > 0) ?? ''
  return first.trimStart().startsWith(PLATFORM_COMMENT_MARKER.trimEnd())
}

/**
 * Longest answer text accepted from one command. An answer becomes `item.reply`, which is fed to
 * the incorporation model as delimited untrusted input — so this is a prompt-budget bound, not a
 * storage one. Generous enough for a real paragraph-scale answer; a reporter with more to say has
 * the run's own surfaces.
 */
const MAX_ANSWER_CHARS = 4_000

/** Longest comment scanned. Beyond this a comment is prose, not a command sheet. */
const MAX_COMMENT_CHARS = 64_000

/** Most commands honoured from one comment, so a pathological paste cannot fan out. */
const MAX_COMMANDS = 50

/** A command line the parser recognised. */
export type ReviewReplyCommand =
  | { verb: 'answer'; itemId: string; text: string; line: string }
  | { verb: 'dismiss'; itemId: string; line: string }
  | { verb: 'proceed'; line: string }
  | { verb: 'stop'; line: string }
  | { verb: 'extra-round'; line: string }
  | { verb: 'unknown'; line: string }

/**
 * Parse a tracker comment into review commands.
 *
 * Returns an EMPTY array for a comment with no trigger line — which the caller treats as "ignore
 * this comment entirely", never as an error and never as something to acknowledge. That silence is
 * deliberate: most comments on a linked issue are ordinary human discussion, and acking them would
 * turn every thread into a bot conversation. A BARE mention (`@cat-factory` with no verb after it)
 * counts as discussion for the same reason and yields nothing.
 *
 * An `answer`'s text continues onto following lines until the next trigger line or the end of the
 * comment, so a multi-paragraph answer needs no escaping.
 *
 * An unrecognised verb yields `{ verb: 'unknown' }` rather than being dropped: D4 requires it to be
 * REPORTED in the follow-up, because a reporter who typed `@cat-factory reply CF-2 …` and heard
 * nothing back would reasonably conclude the whole mechanism is broken. That is a near-MISS at a
 * command and stays reported; the bare mention above is not an attempt at one at all, which is the
 * line between the two.
 */
export function parseReviewReplyCommands(comment: string): ReviewReplyCommand[] {
  const lines = comment.slice(0, MAX_COMMENT_CHARS).split(/\r?\n/)
  const commands: ReviewReplyCommand[] = []
  let open: { verb: 'answer'; itemId: string; text: string; line: string } | null = null

  const flush = () => {
    if (!open) return
    commands.push({ ...open, text: open.text.trim().slice(0, MAX_ANSWER_CHARS) })
    open = null
  }

  for (const raw of lines) {
    if (!isTriggerLine(raw)) {
      // A continuation line, but only while an `answer` is open — otherwise it is ordinary prose.
      if (open) open.text += `\n${raw}`
      continue
    }
    flush()
    if (commands.length >= MAX_COMMANDS) break
    const rest = raw.trim().slice(TRIGGER.length).trim()
    const [verb = '', ...tail] = rest.split(/\s+/)
    const line = raw.trim()
    // A BARE mention (`@cat-factory`, or the trigger followed only by prose) is not a malformed
    // command — it is someone tagging us in discussion. Reporting it as `unknown` would be worse
    // than useless: a non-empty command list drives the whole ingest (projection read, review
    // read, a consumed claim) and ends in a follow-up comment telling a human who asked a question
    // that their "command" was unrecognised. Skipping it keeps the parser's own promise that a
    // comment with no commands is ignored ENTIRELY.
    if (!verb) continue
    switch (verb.toLowerCase()) {
      case 'answer': {
        const itemId = tail[0]
        if (!itemId) {
          commands.push({ verb: 'unknown', line })
          break
        }
        // Re-slice from the ORIGINAL line rather than re-joining the split tokens, so the answer
        // keeps the reporter's own spacing instead of being silently normalised.
        //
        // Slice past the VERB first. Searching the whole remainder for the id would find its first
        // occurrence anywhere — including inside the verb itself, so `answer a …` would locate the
        // `a` of `answer` and take the rest of the WORD as the answer text.
        const afterVerb = rest.slice(verb.length)
        const text = afterVerb.slice(afterVerb.indexOf(itemId) + itemId.length).trim()
        open = { verb: 'answer', itemId, text, line }
        break
      }
      case 'dismiss': {
        const itemId = tail[0]
        if (!itemId) commands.push({ verb: 'unknown', line })
        else commands.push({ verb: 'dismiss', itemId, line })
        break
      }
      case 'proceed':
        commands.push({ verb: 'proceed', line })
        break
      case 'stop':
        commands.push({ verb: 'stop', line })
        break
      // Both spellings: the question comment renders the hyphenated form, but a reporter typing it
      // from memory reaches for the underscore about as often, and rejecting that would be a
      // pointless round-trip.
      case 'extra-round':
      case 'extra_round':
        commands.push({ verb: 'extra-round', line })
        break
      default:
        commands.push({ verb: 'unknown', line })
    }
  }
  flush()
  return commands.slice(0, MAX_COMMANDS)
}

/** Whether a line's first non-space token is the trigger (case-insensitive). */
function isTriggerLine(line: string): boolean {
  const trimmed = line.trimStart()
  if (!trimmed.toLowerCase().startsWith(TRIGGER)) return false
  // Require a boundary so `@cat-factory-bot` is not read as a command for `@cat-factory`.
  const next = trimmed.charAt(TRIGGER.length)
  return next === '' || /\s/.test(next)
}

/**
 * Whether an author may drive a parked review from a ticket comment.
 *
 * Two layers, in order:
 *
 * - **Bots are never allowed.** The platform's own writeback comments come back as deliveries, so
 *   without this the ack would feed itself. This is checked FIRST so it cannot be defeated by an
 *   allow-list entry that happens to match a bot's display name.
 * - **The connection's allow-list, when configured.** A comma-separated list of handles, emails or
 *   vendor ids, matched case-insensitively against any of the three. Empty ⇒ any non-bot author,
 *   which is the right default for a private tracker and the wrong one for a public repo — hence
 *   the knob rather than a hard-coded policy.
 */
export function isAllowedReplyAuthor(author: TrackerCommentAuthor, allowList: string): boolean {
  if (author.bot) return false
  const allowed = allowList
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  if (allowed.length === 0) return true
  const identities = [author.handle, author.email, author.id]
    .filter((v): v is string => v != null)
    .map((v) => v.toLowerCase())
  return identities.some((identity) => allowed.includes(identity))
}

const MAX_TITLE_CHARS = 200
const MAX_LINE_CHARS = 300
const MAX_OUTSTANDING = 25

/**
 * Render the follow-up comment that closes a ticket reply.
 *
 * Its job is to tell the reporter the ONE thing they cannot see from the tracker: what the run did.
 * So the outcome leads, the still-open findings follow (with their ids, so the next reply can name
 * them), and anything rejected is stated explicitly — a silently ignored command reads exactly like
 * a broken integration.
 */
export function renderReviewReplyAck(ack: ReviewReplyAck): string {
  const lines: string[] = [PLATFORM_COMMENT_MARKER + outcomeLine(ack)]
  const applied: string[] = []
  if (ack.answered.length > 0) applied.push(`answered ${idList(ack.answered)}`)
  if (ack.dismissed.length > 0) applied.push(`dismissed ${idList(ack.dismissed)}`)
  if (applied.length > 0) lines.push('', `Applied: ${applied.join('; ')}.`)

  if (ack.outstanding.length > 0) {
    const shown = ack.outstanding.slice(0, MAX_OUTSTANDING)
    const omitted = ack.outstanding.length - shown.length
    lines.push('', 'Still open:')
    for (const finding of shown) {
      lines.push(`- **\`${finding.id}\`** — ${safeInline(finding.title, MAX_TITLE_CHARS)}`)
    }
    if (omitted > 0) {
      lines.push(`- _${omitted} more — open run \`${ack.runId}\` to see them all._`)
    }
    lines.push(
      '',
      'Reply with `@cat-factory answer <id> <your answer>` (or `@cat-factory dismiss <id>`) ' +
        'on its own line for each.',
    )
  }

  if (ack.rejected.length > 0) {
    lines.push('', 'Not applied:')
    for (const rejection of ack.rejected) {
      lines.push(`- \`${safeInline(rejection.command, MAX_LINE_CHARS)}\` — ${rejection.reason}`)
    }
  }

  if (ack.outcome === 'exceeded') {
    lines.push(
      '',
      'This review has used its full iteration budget. Reply `@cat-factory proceed` to go ahead ' +
        `with the ${SUBJECT_NOUN[ack.subject]} as it stands, \`@cat-factory extra-round\` for ` +
        'one more pass, or `@cat-factory stop` to park the task for reworking.',
    )
  }

  return lines.join('\n')
}

/**
 * What each subject's loop folds the answers INTO, named so the headline below reads as a
 * statement about this ticket rather than about requirements the reporter never wrote. A
 * `Record` over the closed union, so a third subject cannot inherit the first one's noun.
 */
const SUBJECT_NOUN: Record<ReviewReplyAck['subject'], string> = {
  requirements: 'requirements',
  clarity: 'bug report',
}

/** The headline: what the RUN is doing now, in the reporter's terms. */
function outcomeLine(ack: ReviewReplyAck): string {
  switch (ack.outcome) {
    case 'incorporating':
      return `Thanks — that answers everything outstanding. The ${SUBJECT_NOUN[ack.subject]} is being folded in and re-reviewed; the run will continue on its own.`
    case 'awaiting':
      return 'Thanks — your answers were recorded. The run is still waiting on the questions below.'
    case 'exceeded':
      return 'Your answers were recorded, but this review has reached its iteration cap and needs a decision.'
    case 'resolved':
      return 'Done — the run has been moved on as requested.'
    case 'settled':
      return 'This review has already moved on, so nothing was applied. The run is no longer waiting on these questions.'
  }
}

/** Ids are platform-minted, so they are the one thing rendered verbatim (in code spans). */
function idList(ids: string[]): string {
  return ids.map((id) => `\`${id}\``).join(', ')
}

/** Scrub secrets, THEN hand to the host boundary — the order `reviewQuestions.logic.ts` fixes. */
function safeInline(value: string, max: number): string {
  return hostMarkdown.inline(redactSecrets(value) ?? '', max)
}

export type { ReviewQuestionFinding }
