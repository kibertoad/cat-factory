import type { OwnServiceContext } from '@cat-factory/kernel'

// The "which system is this work for?" section shared by every INLINE review / dialogue prompt
// (requirements review + rework, clarity triage, both brainstorm stages).
//
// These agents get no checkout, so unlike a container agent they cannot look around and work out
// what software they are reasoning about: the block's own title and description are the whole of
// their world, and a short title ("implement webhooks") names no system at all. Omitting the
// owning service made that indistinguishable from a task whose product is obvious from context, so
// a model supplied one itself and stated it as confidently as a fact.
//
// One renderer for all three flows because the property only holds if they agree: a reviewer that
// stays with the stated system, a dialogue that proposes options for it, and an editor that does
// not write an assumed one into the document the next pass treats as authoritative.

/** What an agent should do with the fact that no owning system was resolved. */
export type UnstatedProductGuidance = 'reason' | 'propose'

const UNSTATED_GUIDANCE: Record<UnstatedProductGuidance, string> = {
  reason:
    'Reason only from the text below; do not infer a product, vendor, platform or domain it ' +
    'does not name.',
  propose:
    'Propose options only for what the text below describes; do not adopt a product, vendor, ' +
    'platform or domain it does not name.',
}

const HEADING = '## The system this work belongs to'

/**
 * Render the owning-service section as prompt lines, STATING the unresolved case.
 *
 * Returns no lines for a frame-level subject (the block IS the service and its own heading already
 * names it) and for a context that resolved nothing at all — a caller that never populated the
 * field makes no claim either way, rather than asserting an absence it did not check.
 */
export function renderProductContextLines(
  service: OwnServiceContext | undefined,
  guidance: UnstatedProductGuidance,
  /** Extra grounding to append under a resolved service, e.g. its `spec/overview.md` intent. */
  extra?: { label: string; body: string },
): string[] {
  if (!service) return []
  if (!service.stated) {
    if (service.reason === 'block-is-the-service') return []
    return [
      '',
      HEADING,
      'NOT STATED — this work is not under a service on the board, so no owning system, product ' +
        `or domain was resolved for it. ${UNSTATED_GUIDANCE[guidance]}`,
    ]
  }
  const lines = ['', HEADING, `**${service.title}**`]
  if (service.description?.trim()) lines.push('', service.description.trim())
  if (extra?.body.trim()) lines.push('', extra.label, extra.body.trim())
  return lines
}

/**
 * Whether the context identifies the system under discussion — a service resolved, or the subject
 * IS the service. Total over {@link OwnServiceContext} rather than a truthiness check, because its
 * two "no service" cases mean opposite things.
 */
export function productIsIdentifiedFrom(service: OwnServiceContext | undefined): boolean {
  if (!service) return false
  return service.stated || service.reason === 'block-is-the-service'
}
