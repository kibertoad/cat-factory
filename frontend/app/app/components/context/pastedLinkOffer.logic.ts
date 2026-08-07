import { isHostPinnedSource } from '@cat-factory/contracts'
import type { DocumentSourceKind } from '~/types/domain'

// The pure half of "you pasted a link into the description; want it attached?".
//
// A URL named in a task description already reaches the run path, where an UNIMPORTED one is
// dropped with an info line and the agent gets no context from it. This offer is what turns that
// drop into an attachment while the author is still on the form. What makes it safe to offer at
// all is the same rule the canonicaliser and the refusal-claimant search follow: only a
// HOST-PINNED source may claim a URL, because a host-blind parser claims a SHAPE and will happily
// claim a dashboard link that has nothing to do with it.

/** How much text is scanned for a link. Bounded: this runs as someone types a description. */
const MAX_SCANNED_CHARS = 4000

/**
 * Trailing characters a URL written in prose collects, stripped so the offer resolves the link
 * rather than the sentence it sits in. Brackets and quotes come in Markdown link syntax.
 */
const TRAILING_NOISE = /[)\]}>.,;:!?'"]+$/

/**
 * The first `http(s)` URL in `text`, or null.
 *
 * FIRST rather than all of them: the offer is one chip beside a form field, and a description
 * naming five links needs the attach picker, not five chips. Someone who pasted the design link
 * second can still attach it there, so nothing is lost by declining to guess which of many was
 * meant.
 */
export function firstLinkCandidate(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/i.exec(text.slice(0, MAX_SCANNED_CHARS))
  if (!match) return null
  const trimmed = match[0].replace(TRAILING_NOISE, '')
  return trimmed.length > 0 ? trimmed : null
}

/**
 * The sources worth ASKING about a pasted URL: connected, and host-pinned.
 *
 * Host-pinned is not an optimisation here, it is the whole safety property. Asking Notion (whose
 * parser claims any UUID-shaped run) about a Figma link gets a confident yes, and the offer would
 * then stage a design against Notion's key space — the exact mis-attribution
 * `orderSourcesByClaimConfidence` exists to prevent on every other surface. Sources arrive in
 * registry order and stay in it, so two pinned sources are asked in a stable order.
 */
export function claimCandidates(
  connected: readonly DocumentSourceKind[],
): readonly DocumentSourceKind[] {
  return connected.filter(isHostPinnedSource)
}
