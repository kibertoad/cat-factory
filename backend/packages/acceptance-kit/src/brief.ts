// Getting a REAL brief onto a task, whatever its size.
//
// A task's `description` is capped at 2,000 characters, because it is the task's own framing and is
// echoed into every prompt the run assembles. A brief that specifies a service, its Dockerfile, its
// CI workflow and its deployment manifests is several times that, and it is exactly what a
// scaffolding scenario files. So the obvious shape (brief in, `description` out) is a `422` on the
// FIRST task creation of a pass, after the operator has minted a key, created a repository and wired
// a workspace, and the suite discovers the ceiling as a refusal rather than as a rule.
//
// The surface's own answer is an ATTACHED DOCUMENT: `documents: [{ kind: 'upload', … }]` carries up
// to 100,000 characters, is materialised into the run's checkout under `.cat-context/` for a
// container agent and folded into the prompt for an inline one, and is documented as the way to get
// spec-sized input onto a repository-touching run. That is a correct use rather than a workaround.
//
// **The branch is here because the ceiling is not a fact any suite should have to know.** Every
// suite that files a real brief needs the same two lines, the numbers are the platform's own, and a
// suite that gets it wrong gets it wrong in the one place that costs an afternoon of setup. The
// caps are READ from the contracts rather than restated, so a surface that raises one raises it here
// in the same build.

import {
  MAX_TASK_DESCRIPTION_CHARS,
  MAX_UPLOADED_DOCUMENT_CHARS,
  type PublicTaskUploadedDocument,
} from '@cat-factory/contracts'

/**
 * What a brief becomes on `POST /api/v1/services/:serviceId/tasks`, ready to spread into the body.
 *
 * A MUTABLE array, unlike most shapes here: the SDK's generated `CreatePublicTask.documents` is
 * `PublicTaskDocument[]`, so a `readonly` one would be unassignable at the one call site this type
 * exists to feed, and a suite would have to spread a copy back for a hygiene the wire body cannot use.
 */
export type BriefFields = {
  description: string
  /** Present only where the brief went to an attachment; absent leaves an unattached task. */
  documents?: PublicTaskUploadedDocument[]
}

export type BriefOptions = {
  /** The whole brief, as Markdown. */
  brief: string
  /**
   * What the attachment is CALLED, which is both its heading and its filename in the checkout.
   *
   * Required rather than defaulted to something like "Brief", because the agent reads this name
   * beside every other document the task carries and a generic one is what makes a corpus
   * unnavigable. Unused where the brief fits in `description`.
   */
  title: string
  /**
   * The task's own framing when the brief is attached: what this task IS, in a sentence or two.
   *
   * Omitted, it is DERIVED from the brief's opening paragraph, which is a mechanical reduction
   * rather than a judgement about the work. Supply one where the opening paragraph is not a summary
   * (a brief that opens with a heading, or with context before the ask).
   */
  summary?: string
}

/**
 * The `description` (and, where needed, the attached document) for one brief.
 *
 * A brief that fits is byte-for-byte the prior behaviour: `description` and nothing else, no
 * attachment, no note. The branch is invisible to every suite whose briefs are short, which is the
 * property that makes it safe to put in the shared path.
 *
 * A brief past the ATTACHMENT cap is REFUSED rather than truncated. A truncated brief is the failure
 * this whole module exists to prevent one layer down: the run looks perfectly healthy while an agent
 * builds against a spec whose last third it never received, and no assertion on the result can tell
 * that apart from a model that ignored it.
 */
export function briefFields(options: BriefOptions): BriefFields {
  const brief = options.brief.trim()
  if (brief.length === 0) throw new Error('A brief with no text describes no work.')
  if (brief.length <= MAX_TASK_DESCRIPTION_CHARS) return { description: brief }
  if (brief.length > MAX_UPLOADED_DOCUMENT_CHARS) {
    throw new Error(
      `The brief '${options.title}' is ${brief.length} characters, past the ` +
        `${MAX_UPLOADED_DOCUMENT_CHARS} an attached document may carry. Refusing rather than ` +
        `truncating: a run against a brief missing its tail looks exactly like a run against the ` +
        `whole of it. Split the work, or attach the remainder as a second document.`,
    )
  }
  const title = requireTitle(options.title)
  return {
    description: descriptionFor(options, brief, title),
    documents: [{ kind: 'upload', title, content: brief }],
  }
}

/**
 * The attachment's name, checked HERE against the surface's own bound.
 *
 * Checked locally rather than left to the round trip for the reason the whole module exists: a
 * refusal that arrives from the deployment arrives after the setup, and this one names the field
 * and the value.
 */
function requireTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length === 0) throw new Error('An attached brief needs a title; the agent reads it.')
  if (trimmed.length > MAX_DOCUMENT_TITLE_CHARS) {
    throw new Error(
      `A document title may carry ${MAX_DOCUMENT_TITLE_CHARS} characters; '${trimmed}' is ` +
        `${trimmed.length}.`,
    )
  }
  return trimmed
}

/** The bound `publicTaskUploadedDocumentSchema` puts on a title. */
const MAX_DOCUMENT_TITLE_CHARS = 200

/**
 * The framing that goes in `description` when the brief itself is attached.
 *
 * It always ENDS by naming the attachment, and that sentence is not decoration: the description is
 * what every agent reads first, and a framing that stops mid-thought with no pointer reads as the
 * whole of the ask. A supplied summary that cannot fit beside it is refused rather than shortened,
 * because a caller's own words are the one thing here that may not be silently rewritten.
 */
function descriptionFor(options: BriefOptions, brief: string, title: string): string {
  const note = `The full brief is attached as '${title}'.`
  const room = MAX_TASK_DESCRIPTION_CHARS - note.length - 2
  if (options.summary !== undefined) {
    const summary = options.summary.trim()
    if (summary.length > room) {
      throw new Error(
        `The summary for '${title}' is ${summary.length} characters and only ${room} fit beside ` +
          `the sentence naming the attachment. Shorten it: the full text is in the attachment, ` +
          `which is what the description points at.`,
      )
    }
    return summary.length === 0 ? note : `${summary}\n\n${note}`
  }
  return `${opening(brief, room)}\n\n${note}`
}

/**
 * The brief's opening paragraph, cut to fit and SAYING SO when it was cut.
 *
 * Mechanical rather than a judgement: the platform computes, it does not summarise. The marker is
 * what stops a derived framing from reading as a complete one, and the attachment note that follows
 * it is where the reader is sent.
 */
function opening(brief: string, room: number): string {
  const paragraph = (brief.split(/\n\s*\n/)[0] ?? brief).trim()
  if (paragraph.length <= room) return paragraph
  const marker = '…'
  const cut = paragraph.slice(0, room - marker.length)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > room / 2 ? cut.slice(0, boundary) : cut).trimEnd()}${marker}`
}
