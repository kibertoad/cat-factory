import { hostMarkdown, redactSecrets } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Rendering a structured step outcome into the prose digest that lands on `step.output`.
//
// Several `container-coding` kinds return BOTH a push and a JSON verdict (`repro-test`,
// `integration-test`), and each needs the same thing afterwards: a short human-readable summary
// on `step.output`, because that is the only field `priorOutputs` carries and therefore the only
// way the verdict reaches the merger's assessment and the person at the merge gate. Written
// per-kind, that summary came out as the same heading / label / bulleted-section / notes shape
// twice, with the escaping applied in neither.
//
// The escaping is why this is shared rather than copied a third time. `step.output` holds
// MODEL-AUTHORED text and is not an inert sink: it is rendered in the SPA, re-read by every later
// agent, and re-fed into prompts. An unbalanced code fence in `notes` swallows the sections after
// it, a `## ` at the start of a line hijacks the document's structure, and a captured command tail
// can carry a credential into a persisted row. So every hole here goes through `redactSecrets`
// first (at COMPOSE time, before any truncation, so the scrub can never be sliced in half) and
// then through the `hostMarkdown` boundary.
// ---------------------------------------------------------------------------

/** One bulleted section of a digest: a trusted heading over untrusted values. */
export interface DigestSection {
  /** Engine-authored, rendered as-is. */
  heading: string
  /** Model-authored. Blank entries are dropped; an empty section is omitted entirely. */
  values: readonly string[]
  /**
   * Render each value as a code span. For a path, a command or an identifier, where a reader
   * needs the exact characters and markdown would otherwise eat the underscores in one.
   */
  code?: boolean
}

/** What {@link renderStructuredDigest} composes. */
export interface StructuredDigest {
  /** Engine-authored `## ` heading for the whole digest. */
  heading: string
  /** Engine-authored one-line verdict, straight under the heading. */
  headline: string
  /**
   * Engine-authored lines under the headline: what the PLATFORM found about the report, as
   * opposed to what the report claims. Blank/absent entries are dropped, so a caller can compute
   * one conditionally without branching at the call site.
   */
  caveats?: readonly (string | undefined)[]
  sections?: readonly DigestSection[]
  /** Model-authored closing prose. */
  notes?: string | null | undefined
}

/** Scrub, then neutralise: the order matters, see the module header. */
function safeInline(value: string, code: boolean): string {
  const scrubbed = redactSecrets(value) ?? ''
  return code ? hostMarkdown.inlineCode(scrubbed) : hostMarkdown.inline(scrubbed)
}

/**
 * Render a structured step outcome as the markdown digest for `step.output`.
 *
 * Sections with nothing in them are omitted rather than rendered empty: an empty "Not covered"
 * heading reads as a gap nobody described, where its absence reads as no gap stated, and only the
 * second one is true.
 */
export function renderStructuredDigest(digest: StructuredDigest): string {
  const lines: string[] = [`## ${digest.heading}`, '', digest.headline]
  for (const caveat of digest.caveats ?? []) {
    if (caveat?.trim()) lines.push('', caveat.trim())
  }
  for (const section of digest.sections ?? []) {
    const kept = section.values
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .map((value) => `- ${safeInline(value, section.code === true)}`)
    if (kept.length) lines.push('', `### ${section.heading}`, '', ...kept)
  }
  const notes = digest.notes?.trim()
  if (notes) lines.push('', '### Notes', '', hostMarkdown.prose(redactSecrets(notes) ?? ''))
  return lines.join('\n')
}
