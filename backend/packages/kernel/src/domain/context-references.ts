import { buildExcerpt } from '../shared/markdown.logic.js'
import { redactSecrets } from '../shared/redact-secrets.logic.js'
import { ValidationError } from './errors.js'

// A task's REFERENCED CONTEXT DOCUMENTS — the requirements / RFCs / PRDs a human attached to a
// block (plus anything its description names outright that resolves against the imported corpus)
// — carry the intent the agent is supposed to build against. The invariant this module owns:
//
//   a referenced context document either reaches the agent WHOLE, or the run breaks loudly
//   naming the ones that cannot be delivered.
//
// The failure mode it removes is silent: a reference that resolves to an empty page, or a corpus
// that overflows the job body's byte budget, used to be dropped on the floor. The run then looked
// completely healthy while the agent worked from a spec nobody noticed it never read — the exact
// "'absent' and 'zero' must never render the same" hazard, one layer up.
//
// Both refusals are `ValidationError`s carrying a machine-readable `reason`, and both land on the
// run as a `preflight` failure — the honest kind, since no agent ran. They refuse at DIFFERENT
// depths and are therefore classified by different seams, which must agree:
// `buildContextFiles` refuses inside `startJob`, so `classifyDispatchFailure` sees the throw;
// `resolveLinkedContext` refuses earlier, inside the context builder, so the throw leaves
// `advanceInstance` and the driver's `failureFromAdvanceError` sees it. Both map a `DomainError`
// to `preflight` + its `details.reason`, so the run's failure record keeps the cause code
// alongside the prose either way.
//
// Both remedies are the human's, and both are named in the message: make the reference readable
// (re-import the page), or detach it from the task — a task is allowed to proceed without a
// document, it is just never allowed to do so silently.

/** `error.details.reason` for a reference that resolved to a page with no readable content. */
export const CONTEXT_DOCUMENT_UNREADABLE = 'context_document_unreadable'

/** `error.details.reason` for a corpus that overflows the materialised-context byte budget. */
export const CONTEXT_DOCUMENTS_OVER_BUDGET = 'context_documents_over_budget'

/** The little that is needed to NAME a context reference in a refusal. */
export interface ContextReferenceRef {
  title: string
  url: string
}

/**
 * ` (https://…)` for a document that came from a page, and NOTHING for one that did not.
 *
 * Not every context document has an origin to point at: an `upload` is a body handed to the
 * platform directly, so it stores an empty `url`. Interpolating that yields `Title ()` in the
 * prompt index and a bare `Source:` header on the materialised file, both of which read as a link
 * that broke rather than as a document that never had one, and an agent told a source is missing
 * may go looking for it. Rendering nothing is the honest form, and it lives here so the prompt
 * renderer and the file materialiser cannot disagree about it (the refusal messages above already
 * make the same distinction, in {@link describeRef}).
 */
export function originSuffix(url: string): string {
  const trimmed = url.trim()
  return trimmed ? ` (${trimmed})` : ''
}

/** The materialised context file's `Source:` header line, or nothing. See {@link originSuffix}. */
export function originHeaderLine(url: string): string {
  const trimmed = url.trim()
  return trimmed ? `Source: ${trimmed}\n` : ''
}

/**
 * `"Payments RFC" (https://…)`, or just the title when the reference carries no URL. Both halves
 * are source-authored text landing on a persisted failure record and a rendered surface, and a
 * document URL can legitimately carry a signed/`?token=` query, so it is scrubbed here — at the
 * one site that composes it, before any caller can copy it onward.
 */
function describeRef(ref: ContextReferenceRef): string {
  const title = redactSecrets(ref.title.trim()) || 'untitled'
  const url = redactSecrets(ref.url.trim())
  return url ? `"${title}" (${url})` : `"${title}"`
}

/**
 * The machine-readable `details.references` list: the URL where there is one, else the title.
 * TRIMMED on the same rule {@link describeRef} uses, so the prose and the machine-readable list
 * can never disagree about whether a reference carries a URL.
 */
function referenceIds(refs: readonly ContextReferenceRef[]): string[] {
  return refs.map((r) => redactSecrets(r.url.trim() || r.title.trim()) ?? '')
}

/** `a`, `b` and `c` — an oxford-comma-free list for a one-line refusal. */
function joinRefs(refs: readonly ContextReferenceRef[]): string {
  const described = refs.map(describeRef)
  if (described.length <= 1) return described.join('')
  return `${described.slice(0, -1).join(', ')} and ${described[described.length - 1]}`
}

/**
 * Whether a stored document has anything an agent could actually read. The materialised file (and
 * the inline injection) is `body || excerpt`, so a row where BOTH are blank delivers a filename, a
 * URL the agent cannot open, and nothing else.
 *
 * An empty page is not a hypothetical: `import` persists whatever the provider returned, and a
 * permission-limited Confluence page, an empty Notion page and a design node whose extraction
 * yielded nothing all project to a blank body.
 */
export function hasReadableContent(doc: {
  body?: string | null
  excerpt?: string | null
}): boolean {
  return !!(doc.body?.trim() || doc.excerpt?.trim())
}

/**
 * The readable text an EXCERPT-ONLY caller actually puts in front of its model: the stored
 * excerpt, else one derived from the body. Empty ⇒ that caller has nothing to show.
 *
 * {@link hasReadableContent} is the right test where the RAW body is delivered — a container agent
 * opens the materialised markdown source and can at least see what is in it. A caller with no
 * checkout renders this projection instead, and it can come back empty from a body that is NOT
 * blank: `import` stores `buildExcerpt(body)`, i.e. `markdownToText`, so a body that is pure
 * MARKUP — the empty fenced block an extractor emits for an embed it cannot render — collapses to
 * nothing. Asserting over the body and then rendering this is how such a caller would re-open the
 * very hole this module closes, one field narrower — so it asserts over what it renders.
 */
export function contextExcerptFor(doc: { body?: string | null; excerpt?: string | null }): string {
  return doc.excerpt?.trim() || buildExcerpt(doc.body ?? '').trim()
}

/**
 * Refuse the run when any referenced context document resolved to an unreadable page, naming each
 * one plus the two remedies. Nothing to report ⇒ a no-op, so every caller can assert
 * unconditionally.
 */
export function assertContextDocumentsReadable(unreadable: readonly ContextReferenceRef[]): void {
  if (!unreadable.length) return
  const plural = unreadable.length === 1 ? 'document' : 'documents'
  throw new ValidationError(
    `This task references ${unreadable.length} context ${plural} with no readable content, so the ` +
      `agent would run without ${unreadable.length === 1 ? 'it' : 'them'}: ${joinRefs(unreadable)}. ` +
      `Re-import the page (its source may have returned an empty body), or detach it from the task ` +
      `to run without it.`,
    { reason: CONTEXT_DOCUMENT_UNREADABLE, references: referenceIds(unreadable) },
  )
}

/**
 * Refuse the run when the referenced context does not fit the materialised-context byte budget,
 * naming what did not fit and how far over the corpus is. Dropping the overflow instead would put
 * an agent in front of a partial corpus it has no way to notice is partial — and unlike an
 * unreadable page, there is nothing to re-import here: the human has to decide what this task
 * actually needs.
 *
 * The remedy is worded for LINKED CONTEXT rather than for documents, because linked TRACKER ISSUES
 * are sized into the same budget and can be what overflows it: "re-import a shorter page" is
 * nonsense advice about an issue, and the message names the items, so the reader can already see
 * which kind each one is.
 */
export function assertContextReferencesFit(
  omitted: readonly ContextReferenceRef[],
  sizes: { totalBytes: number; budgetBytes: number },
): void {
  if (!omitted.length) return
  const kb = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`
  const plural = omitted.length === 1 ? 'item' : 'items'
  throw new ValidationError(
    `The context attached to this task totals ${kb(sizes.totalBytes)}, over the ` +
      `${kb(sizes.budgetBytes)} an agent's checkout can carry, so ${omitted.length} ${plural} ` +
      `would not reach it: ${joinRefs(omitted)}. Detach the linked context this task does not ` +
      `need to unblock the run.`,
    {
      reason: CONTEXT_DOCUMENTS_OVER_BUDGET,
      references: referenceIds(omitted),
      totalBytes: sizes.totalBytes,
      budgetBytes: sizes.budgetBytes,
    },
  )
}
