import {
  binaryReferenceImageSchema,
  MAX_BINARY_PIXEL_EXTENT,
  mediaTypeSchema,
  normalizeMediaType,
  requiredBinaryCapabilities,
  type BinaryGenerationOptions,
  type BinaryGeneratorCapability,
  type BinaryReferenceImage,
} from '@cat-factory/contracts'
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

/** A parsed reference-image list: what the step will carry, and what was refused on the way in. */
export interface ParsedReferenceImages {
  /** Well-formed entries, in the order typed: exactly what gets stored. */
  usable: BinaryReferenceImage[]
  /** Lines that are not `role|location[|service]`, kept VERBATIM so the warning can quote them. */
  unusable: string[]
}

/**
 * Read a reference-image list from the one-per-line `role|location[|service]` text the builder
 * accepts.
 *
 * Free TEXT rather than a picker, for the reason the format requirement beside it is: what a
 * reference points at is an object in the org's own storage or a URL, and neither is a set the
 * platform can enumerate. The three fields are positional because the shape is small and a
 * three-input row per reference would dominate a step row that is already dense; the ROLE comes
 * first because it is the constrained field, so a typo lands on the half the parser can name.
 *
 * A refused line is REPORTED, never quietly dropped, exactly as a refused format is: a reference
 * someone typed and the step does not carry is a generation that silently ignores it.
 */
export function parseReferenceImages(text: string): ParsedReferenceImages {
  const usable: BinaryReferenceImage[] = []
  const unusable: string[] = []
  for (const line of text
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [role, location, service] = line.split('|').map((part) => part.trim())
    const parsed = v.safeParse(binaryReferenceImageSchema, {
      role,
      location,
      ...(service ? { service } : {}),
    })
    if (parsed.success) usable.push(parsed.output)
    else unusable.push(line)
  }
  return { usable, unusable }
}

/** Render a stored reference list back into the text the field shows. */
export function formatReferenceImages(
  references: readonly BinaryReferenceImage[] | undefined,
): string {
  return (references ?? [])
    .map((ref) => [ref.role, ref.location, ref.service].filter(Boolean).join('|'))
    .join('\n')
}

/**
 * Read one half of an exact output size out of the field, or null when what is typed is not a
 * pixel extent the step could carry.
 *
 * Held to the SAME bounds the schema holds it to, {@link MAX_BINARY_PIXEL_EXTENT} imported rather
 * than repeated, so a number this accepts is one the save accepts. Blank is null like anything
 * else here: the caller's job is to tell "nothing typed yet" from "typed and unusable", and it has
 * the raw text to do it with.
 */
export function parseExtent(raw: string): number | null {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isInteger(value) || value < 1 || value > MAX_BINARY_PIXEL_EXTENT) return null
  return value
}

/** Render a stored extent back into the text its field shows; absent is an empty field. */
export function formatExtent(value: number | undefined): string {
  return value === undefined ? '' : String(value)
}

/**
 * Build the predicate that decides whether the control for a generation option is OFFERED, given
 * what the step's selected integrations declare and what its stored options already require.
 *
 * Three rules, and the third is the one that is easy to miss:
 *
 *  - An integration that declares NOTHING pins nothing down, so while one is selected (or nothing
 *    is) every control stays offered and the advisory line says the support is unconfirmed.
 *    Hiding one would be a claim about a vendor's API that nobody established.
 *  - Otherwise a control is offered exactly when something selected declares its capability.
 *  - And a control whose option is ALREADY SET stays offered whatever the selection says. Changing
 *    the selection does not clear options authored against the old one, so hiding the control on
 *    the way past strands a stored requirement that refuses the run at admission, under an error
 *    telling the reader to remove an option whose only control has just disappeared. The platform
 *    will not silently drop an authored requirement, so the person who stated it needs the control
 *    that withdraws it. This is the SPA's standing rule that a hidden field must leave behind
 *    exactly the default it would have shown.
 *
 * Returned as a closure over ONE pass across the selection rather than recomputed per capability:
 * the template asks it once per control, and the sets are the same for all of them.
 */
export function generationControlOffer(
  selected: readonly { capabilities?: readonly BinaryGeneratorCapability[] }[],
  options: BinaryGenerationOptions | undefined,
): (capability: BinaryGeneratorCapability) => boolean {
  const declared = new Set(selected.flatMap((generator) => generator.capabilities ?? []))
  const undeclared =
    selected.length === 0 || selected.some((g) => (g.capabilities ?? []).length === 0)
  // The same derivation admission judges the step by, imported rather than re-implemented, so the
  // control a person is offered and the requirement the run is refused for cannot disagree.
  const required = new Set(requiredBinaryCapabilities(options))
  return (capability) => undeclared || declared.has(capability) || required.has(capability)
}
