import { mediaTypeSchema, normalizeMediaType } from '@cat-factory/contracts'
import * as v from 'valibot'

// The pure half of BinaryOutputStepPicker: reading a free-text FORMAT requirement, and telling
// this field's own write apart from one that landed underneath it. Extracted for the reason every
// `*.logic.ts` here is — a decision worth a test should not need a mounted component to reach.

/** A parsed format requirement: what the step will carry, and what was refused on the way in. */
export interface ParsedMediaTypeRequirement {
  /** Normalised, deduplicated, order-preserving — exactly what gets stored. */
  usable: string[]
  /** Entries that are not a `type/subtype` at all, kept VERBATIM so the warning can quote them. */
  unusable: string[]
}

/**
 * Read a comma-separated format requirement the way the field accepts it and the way the backend
 * will hold it.
 *
 * Forgiving on the way IN, exact on the way out, and both halves are the backend's own rules
 * imported rather than re-implemented: `normalizeMediaType` is the same reduction the comparison
 * uses at both ends (a divergent local lowercasing would store a format that matches nothing and
 * reads everywhere as one that was simply never emitted), and `mediaTypeSchema` is what the save
 * boundary holds this to — so what is refused here is exactly what would come back as a 422 one
 * round trip later.
 *
 * A refused entry is REPORTED, never quietly dropped: a requirement someone typed and the step
 * does not carry is the "absent reads as fine" failure the rest of this surface exists to avoid.
 */
export function parseMediaTypeRequirement(text: string): ParsedMediaTypeRequirement {
  const usable: string[] = []
  const unusable: string[] = []
  for (const entry of text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const normalized = normalizeMediaType(entry)
    if (normalized && v.safeParse(mediaTypeSchema, normalized).success) usable.push(normalized)
    else unusable.push(entry)
  }
  return { usable: [...new Set(usable)], unusable }
}

/**
 * Whether two stored format lists are the same write.
 *
 * Order-sensitive on purpose: the field writes back what it read, so a differing order means the
 * value came from somewhere else, which is precisely what the caller is asking about.
 */
export function sameFormats(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean {
  return (a ?? []).join(',') === (b ?? []).join(',')
}
