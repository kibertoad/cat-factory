import {
  documentRefReasonSchema,
  type DocumentRefReason,
  type DocumentSourceKind,
  type ResolvedDocumentRef,
} from '@cat-factory/contracts'
import { apiErrorEnvelope, apiErrorReason } from '~/composables/api/errors'

// The pure half of ContextDocumentPicker: deciding what counts as a pasted REFERENCE rather than a
// search phrase, reading the backend's verdict on one, and describing the row it becomes.
// Extracted for the reason every `*.logic.ts` here is (a decision worth a test should not need a
// mounted component to reach), and these three carry the whole "don't silently accept a bad link"
// rule the picker exists to enforce.

/** What the picker knows about the reference currently in its input. */
export type RefState =
  /** Nothing pasted, or the text reads as a search phrase. */
  | { status: 'none' }
  | { status: 'checking' }
  | { status: 'ok'; ref: ResolvedDocumentRef }
  /** The SOURCE refused it. `reason` decides which correction the user is offered. */
  | { status: 'rejected'; reason: DocumentRefReason; claimedBy?: string; expected?: string }
  /**
   * The resolve call itself failed (offline, 5xx). The reference is UNJUDGED, not refused, and
   * saying so matters: a pre-flight outage rendered as "your link is wrong" sends the user off to
   * fix a link that was fine.
   */
  | { status: 'unchecked'; message: string }

/**
 * The text to resolve as a reference, or null when there is nothing to resolve.
 *
 * A source with no catalogue search takes any non-empty text (pasting is the only way to attach a
 * page there, mirroring the import modal's single input). A searchable one only treats text that
 * READS as a reference that way, so typing a title does not fire a resolve on every keystroke and
 * does not render a refusal at someone who is simply searching.
 */
export function refCandidateOf(query: string, searchable: boolean): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  if (!searchable) return trimmed
  return looksLikeDocumentRef(trimmed) ? trimmed : null
}

/** The bare-id forms a document source's ref grammar accepts UNAMBIGUOUSLY, so no phrase matches. */
const BARE_ID_SHAPES = [
  /** A Notion page id, dashless. */
  /^[0-9a-f]{32}$/i,
  /** A dashed UUID (Notion, Linear). */
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  /** A Confluence page id. */
  /^\d{4,}$/,
]

/**
 * Whether text typed into a SEARCHABLE source's box is a reference rather than a search phrase.
 *
 * Deliberately narrow, because the consequence of a false positive changed. It used to cost an
 * extra row the user could ignore; now the resolve verdict is RENDERED, so a phrase mistaken for a
 * reference produces "Not a Notion reference" underneath the search box, in amber, above the
 * results for that same phrase. `auth/login flow` and `sprint #4 plan` are searches, so the first
 * rule is that anything containing whitespace is one, whatever punctuation it carries: the old
 * "contains `/` or `#`" test read both of those as malformed links.
 *
 * What remains is a URL (with or without its scheme, which people routinely paste off), or one of
 * the `BARE_ID_SHAPES` no title could be confused with. A bare id in an unrecognised shape simply
 * is not offered here, which is the pre-existing behaviour: the backend stays the judge of every
 * candidate this admits, and this only decides which ones are worth ASKING about.
 */
function looksLikeDocumentRef(text: string): boolean {
  if (/\s/.test(text)) return false
  if (/^https?:\/\//i.test(text)) return true
  if (/^[\w-]+(\.[\w-]+)+\/\S/.test(text)) return true
  return BARE_ID_SHAPES.some((shape) => shape.test(text))
}

/**
 * Classify a failed resolve.
 *
 * A refusal is only a refusal when the backend NAMED a reason we know: the reason vocabulary is
 * the closed contract picklist, so an unrecognised value (an older/newer backend, a proxy's own
 * error page, a network fault) lands as `unchecked`. Guessing "rejected" from the mere presence of
 * an error is the misattribution this whole surface is meant to avoid: it would tell the user
 * their link is malformed on the strength of a 502.
 *
 * The reason is read through `apiErrorReason`, the one helper that normalises this contract (which
 * client threw, a non-object `details`, a non-string `reason`); only the two extra details each
 * correction needs are picked off the envelope here.
 */
export function classifyRefFailure(error: unknown): RefState {
  const reason = apiErrorReason(error)
  if (!isRefReason(reason)) {
    return { status: 'unchecked', message: error instanceof Error ? error.message : String(error) }
  }
  const details = (apiErrorEnvelope(error)?.details ?? {}) as Record<string, unknown>
  return {
    status: 'rejected',
    reason,
    ...(typeof details.claimedBy === 'string' ? { claimedBy: details.claimedBy } : {}),
    ...(typeof details.expected === 'string' ? { expected: details.expected } : {}),
  }
}

/** Narrow an unknown `details.reason` to the contract's own picklist, never a bare cast. */
function isRefReason(value: unknown): value is DocumentRefReason {
  return (
    typeof value === 'string' &&
    (documentRefReasonSchema.options as readonly string[]).includes(value)
  )
}

/** How a reference is presented as an attachable row. */
export interface RefRow {
  /** The reference to stage: the resolved canonical id, or the pasted text when unjudged. */
  externalId: string
  /** The source that claimed it; null when the pre-flight never got a verdict. */
  source: DocumentSourceKind | null
  /** The canonical link, when the source can rebuild one from the id alone. */
  canonicalUrl: string | null
  /** What the row reads as: the imported page's title when we hold it, else the canonical form. */
  label: string
  /** The paste carried NOISE the canonical form drops, so the trim is worth stating explicitly. */
  trimmed: boolean
  /**
   * The frame/screen the paste named that this reference does NOT cover (see the contract's
   * `droppedScope`). Kept apart from {@link trimmed} because they are opposite facts wearing the
   * same clothes: a trim resolves the same page, a drop WIDENS one frame to a whole design file.
   */
  droppedScope: string | null
  /** The pre-flight could not reach a verdict. Stageable, with the import as the backstop. */
  unchecked: boolean
}

/**
 * Describe the row a reference becomes, or null when there is nothing to offer.
 *
 * The label is the CANONICAL form, never the pasted text: showing what was typed would hide the
 * one thing worth confirming, which is that a share link's title segment and `?p=`/`&t=` tracking
 * params are gone and the frame the URL named survived the trim. `trimmed` is what lets the row
 * say so instead of leaving the change to be noticed, and `droppedScope` is what keeps a widened
 * reference from hiding behind that same note.
 *
 * An UNCHECKED reference still yields a row, carrying the pasted text. "The source refused this"
 * and "we could not ask" are different facts and only the first is a reason to refuse a paste: a
 * transient 502 or an offline moment must not make attaching a perfectly good link impossible,
 * which is what suppressing the row does. The import remains the backstop it always was, so the
 * worst case is the pre-PR behaviour rather than a dead end.
 */
export function refRowFor(state: RefState, pasted: string, importedTitle?: string): RefRow | null {
  if (state.status === 'ok') {
    const canonical = state.ref.canonicalUrl ?? state.ref.externalId
    return {
      externalId: state.ref.externalId,
      source: state.ref.source,
      canonicalUrl: state.ref.canonicalUrl,
      label: importedTitle ?? canonical,
      trimmed: canonical !== pasted.trim(),
      droppedScope: state.ref.droppedScope,
      unchecked: false,
    }
  }
  if (state.status === 'unchecked') {
    const text = pasted.trim()
    if (!text) return null
    return {
      externalId: text,
      // Unknown: only the resolve answers which source claims a paste, and guessing it here is
      // what would stage a Figma link against the Notion picker's key space.
      source: null,
      canonicalUrl: null,
      label: text,
      trimmed: false,
      droppedScope: null,
      unchecked: true,
    }
  }
  return null
}
