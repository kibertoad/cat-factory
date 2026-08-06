import {
  documentRefReasonSchema,
  type DocumentRefReason,
  type ResolvedDocumentRef,
} from '@cat-factory/contracts'
import { apiErrorEnvelope } from '~/composables/api/errors'

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
  const looksLikeRef =
    trimmed.includes('#') || trimmed.includes('/') || /^https?:\/\//i.test(trimmed)
  return looksLikeRef ? trimmed : null
}

/**
 * Classify a failed resolve.
 *
 * A refusal is only a refusal when the backend NAMED a reason we know: the reason vocabulary is
 * the closed contract picklist, so an unrecognised value (an older/newer backend, a proxy's own
 * error page, a network fault) lands as `unchecked`. Guessing "rejected" from the mere presence of
 * an error is the misattribution this whole surface is meant to avoid: it would tell the user
 * their link is malformed on the strength of a 502.
 */
export function classifyRefFailure(error: unknown): RefState {
  const details = (apiErrorEnvelope(error)?.details ?? {}) as Record<string, unknown>
  const reason = details.reason
  if (!isRefReason(reason)) {
    return { status: 'unchecked', message: error instanceof Error ? error.message : String(error) }
  }
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

/** How a resolved reference is presented as an attachable row. */
export interface RefRow {
  /** What the row reads as: the imported page's title when we hold it, else the canonical link. */
  label: string
  /** The paste carried noise the canonical form drops, so the trim is worth stating explicitly. */
  trimmed: boolean
}

/**
 * Describe the row a resolved reference becomes.
 *
 * The label is the CANONICAL form, never the pasted text: showing what was typed would hide the
 * one thing worth confirming, which is that a share link's title segment and `?p=`/`&t=` tracking
 * params are gone and the frame the URL named survived the trim. `trimmed` is what lets the row
 * say so instead of leaving the change to be noticed.
 */
export function refRowFor(
  ref: ResolvedDocumentRef,
  pasted: string,
  importedTitle?: string,
): RefRow {
  const canonical = ref.canonicalUrl ?? ref.externalId
  return { label: importedTitle ?? canonical, trimmed: canonical !== pasted.trim() }
}
