import * as v from 'valibot'

// ---------------------------------------------------------------------------
// What a generative binary integration can DO beyond producing a content type, and the per-step
// GENERATION OPTIONS each of those abilities unlocks.
//
// `binary-modalities.ts` answers what an integration makes. This module answers what it can be
// ASKED FOR while making it: a reference image to condition on, an edit of something that already
// exists, a seed, a negative prompt, a transparent background. The four image APIs a deployment
// is most likely to register (Flux, Nano Banana, Grok Imagine, Retro Diffusion) agree on almost
// none of that, and the disagreement is not a quality difference a description can carry: a step
// that hands a reference image to an integration with no image input does not produce a worse
// picture, it produces an error at the end of a paid run, or (worse) a picture that silently
// ignored the reference.
//
// Its own leaf module, imported by both `binary-generators.ts` (what a definition DECLARES) and
// `binary-outputs.ts` (what a step ASKS FOR), for the reason `binary-modalities.ts` is one: the
// two import each other's neighbours and a vocabulary this small has no business creating a
// cycle. It is read by the backend, which admits the run and composes the agent's brief, and by
// the SPA, which offers the controls in the first place, so the coverage rule lives here where
// both import the same implementation rather than agreeing by hand.
// ---------------------------------------------------------------------------

/**
 * A CAPABILITY a generative binary integration declares, as a closed vocabulary.
 *
 * Closed for the same reason {@link binaryModalitySchema} is: it decides things. A capability
 * gates a per-step generation option (a control the builder shows, a paragraph the brief writes,
 * a requirement admission refuses), so `referenceImage` and `reference-image` would be two
 * capabilities that look identical to a reader and silently never match.
 *
 * **A member earns its place only when the PLATFORM exposes something because of it.** That is a
 * higher bar than "the providers differ", and it is what keeps this from becoming the
 * discriminator field the design record refuses (`style`, `resolutionRange`, `intendedUse`).
 * Those were refused because they do not PARTITION a deliverable, so no predicate could be
 * computed from them and a rule built on one would refuse correctly-configured steps by the taste
 * of whoever wrote the picklist. A capability partitions exactly: an API either accepts an input
 * image or it does not, either takes a mask or it does not, and the answer is a fact about the
 * endpoint rather than an opinion about the art. So `covered` / `uncovered` is computable here,
 * which is the same property that lets `modalities` and `mediaTypes` carry admission rules.
 *
 * It also decides nothing about WHICH of two integrations to call. That question stays exactly
 * where the design record put it (the step's `generatorIds`, its format requirement, and its own
 * prompt); this only says what may be ASKED of whichever one is called. A capability that told
 * two producers of one modality apart without unlocking an option would be the refused
 * discriminator wearing a new name.
 *
 * Anything that does not clear the bar stays prose in `description` / `guidance`, which is where
 * "good at pixel art", "expensive above 2K" and "rate limited to 5/min" belong.
 */
export const binaryGeneratorCapabilitySchema = v.picklist([
  /**
   * Accepts an input image the generation is conditioned on: image-to-image, a style reference,
   * a character reference. Unlocks `generation.referenceImages`.
   */
  'reference-image',
  /**
   * Composes SEVERAL reference images in ONE call (subject plus style, or two subjects fused).
   * Its own member rather than a count on the one above, because the difference is structural:
   * an integration that takes exactly one input image cannot be asked twice and have the results
   * combined, so a step handing it three references is not degraded, it is unserved.
   */
  'multi-reference',
  /**
   * Revises a supplied artifact from a natural-language instruction, with no mask. Unlocks
   * `generation.edit` in `instruction` mode.
   */
  'instruction-edit',
  /**
   * Revises the REGION of a supplied artifact named by a mask (inpainting / outpainting).
   * Unlocks `generation.edit` in `mask` mode. Kept apart from the instruction edit above because
   * the two need different inputs and almost no integration has both: a step that must repaint
   * one corner cannot be served by an API that only rewrites whole images from a sentence.
   */
  'mask-edit',
  /** Accepts a NEGATIVE prompt (what to keep out). Unlocks `generation.negativePrompt`. */
  'negative-prompt',
  /**
   * Accepts a SEED, so a generation can be reproduced or deliberately varied. Unlocks
   * `generation.seed`, and it is what makes several candidates from ONE integration comparable
   * rather than accidental.
   */
  'seed',
  /**
   * Accepts an explicit aspect SHAPE: a ratio (`16:9`), or a fixed set of size buckets it
   * rounds to. Unlocks `generation.aspectRatio`.
   *
   * Deliberately NOT "a ratio or an output size", which is what this member said while it was
   * the only one on the axis. A bucketed API (`image_size: square | portrait | landscape`,
   * `resolution: 1k | 2k`) honours a ratio exactly and an exact pixel size not at all, so one
   * member covering both made the two integrations that CAN be handed dimensions
   * indistinguishable from the two that cannot — see {@link 'exact-size'}.
   */
  'aspect-ratio',
  /**
   * Accepts exact output DIMENSIONS in pixels: a width and a height it renders at natively,
   * rather than a shape it rounds to. Unlocks `generation.outputSize`.
   *
   * Its own member rather than a refinement of `aspect-ratio`, because the two partition
   * differently and the difference is the whole deliverable for anything rendered to a fixed
   * grid. A 96x96 inventory icon asked of a bucketed endpoint does not come back slightly
   * wrong: it comes back as a 1K render downscaled 4x, which on pixel art is not the same asset
   * at any level of care, and every check downstream passes (the modality is covered, the
   * format is covered, the upload succeeded). The consumer that rejects it is the game, weeks
   * later.
   *
   * The vocabulary stays FLAT: an API taking width and height can honour any ratio, so it
   * declares BOTH members rather than this one implying the other. That is the same shape
   * `reference-image` / `multi-reference` already has, and it is chosen for the same reason —
   * an implication table is an ordering over a picklist that every future member would then
   * have to be placed in, to save a deployment one word in its own registration, and the cost
   * of forgetting that word is a loud refusal naming the capability rather than a silent
   * mis-render.
   *
   * What this does NOT do is state which sizes an endpoint supports. Flux caps at 4 MP and
   * wants multiples of 32; Retro Diffusion's range moves with the style. A per-integration size
   * TABLE is refused on the design record's own grounds (it is the `resolutionRange`
   * discriminator wearing a new name, and it goes stale in this repo while the vendor changes
   * it in theirs). This member answers only the question that is a durable fact about the
   * endpoint's REQUEST SHAPE: can it be handed dimensions at all. The rest is the integration's
   * own `guidance`, where a sentence can say what the limits are.
   */
  'exact-size',
  /**
   * Returns SEVERAL candidates for one prompt in ONE call. Exposes no control of its own: it
   * changes what the candidate brief ASKS FOR (request `n` in a single call, rather than
   * repeating the call with a different seed), and a brief that got that wrong would either
   * multiply the bill or ask for a parameter the endpoint rejects.
   */
  'candidate-batch',
  /** Can upscale its own output to a larger render. Unlocks `generation.upscale`. */
  'upscale',
  /**
   * Can return an alpha channel / cut-out subject. Unlocks
   * `generation.transparentBackground`, which is a requirement rather than a preference for
   * anything composited (a sprite, an icon, a product cut-out).
   */
  'transparent-background',
  /**
   * Can produce a SEAMLESSLY TILING image. Unlocks `generation.tileable`. A tile that does not
   * tile is not a lesser tile: it is unusable for the one job it exists for, which is what puts
   * this on the axis with a predicate rather than in a description.
   */
  'tileable',
])
export type BinaryGeneratorCapability = v.InferOutput<typeof binaryGeneratorCapabilitySchema>

const BINARY_CAPABILITY_SET: ReadonlySet<string> = new Set(binaryGeneratorCapabilitySchema.options)

/**
 * Whether a value is still a member of the vocabulary, DERIVED from the picklist.
 *
 * Unlike {@link isBinaryModality} this vocabulary is not persisted on a step: capabilities are
 * declared in a deployment's own code, so a build that retires a member also stops emitting it.
 * The guard exists for the ONE seam where that is not true: a MOTHERSHIP-MODE node resolves its
 * integrations from a process that may be a build AHEAD of it, so a capability this build has
 * never heard of can arrive over `/internal/binary-generators` and reach a `Record` lookup or a
 * `switch`. Narrow with this first and describe the negative case as the unknown value it is.
 */
export function isBinaryGeneratorCapability(value: string): value is BinaryGeneratorCapability {
  return BINARY_CAPABILITY_SET.has(value)
}

/**
 * Where an artifact the step points a generator AT already lives: a reference image, the source
 * of an edit, a mask.
 *
 * The platform deliberately does NOT fetch it. It is named to the agent in the brief, and the
 * agent reads it exactly as it calls the generation API itself, which is the same division of
 * labour the rest of this feature runs on: the platform states, the agent acts, and nothing here
 * touches bytes. `service` names one of the step's own foundational services when the artifact
 * lives in the org's estate rather than at a URL, so a private object store needs no public link.
 */
export const binaryAssetRefSchema = v.object({
  /** Where it lives, in `service`'s addressing when one is named, else an absolute URL. */
  location: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
  /**
   * The foundational service the location is addressed in. Absent ⇒ `location` is a URL the
   * agent can fetch directly. Not validated against the step's own selection: a reference can
   * legitimately live in a service the step does not otherwise use, and the brief names whatever
   * is here so a wrong id is visible rather than silently dropped.
   */
  service: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(64), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  ),
  /** What this is, in the step author's words, folded into the brief verbatim. */
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
})
export type BinaryAssetRef = v.InferOutput<typeof binaryAssetRefSchema>

/**
 * A reference image plus the ROLE it plays, because "here is an image" is not an instruction.
 * The same file means "match this palette", "this is the character" or "start from this and
 * change it" depending on the answer, and every one of the four reference-capable APIs takes a
 * different parameter for each.
 */
export const binaryReferenceImageSchema = v.object({
  // Spelled out rather than spread from {@link binaryAssetRefSchema}'s entries. A spread composes
  // the two schemas' inference at every use site, and this shape sits four levels down inside the
  // workspace snapshot (`WorkspaceSnapshot` → pipeline → step options → binary output →
  // generation → here), which is deep enough that the extra level tips `tsc` into "type
  // instantiation is excessively deep" in a consumer several packages away. Three duplicated
  // fields is a cheaper price than a build that fails somewhere with no visible connection to
  // this file; the two are kept in step by the shared doc note above.
  location: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048)),
  service: v.optional(
    v.pipe(v.string(), v.trim(), v.maxLength(64), v.regex(/^[a-z0-9][a-z0-9-]*$/)),
  ),
  note: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
  role: v.picklist([
    /** Match its look: palette, rendering, line weight. */
    'style',
    /** This is the thing depicted: the character, the product, the prop. */
    'subject',
    /** Match its layout: framing, pose, camera. */
    'composition',
    /** Start FROM this image and change it (image-to-image at low strength). */
    'base',
  ]),
})
export type BinaryReferenceImage = v.InferOutput<typeof binaryReferenceImageSchema>

/**
 * The step REVISES existing artifacts rather than making new ones.
 *
 * A named schema rather than an inline object inside the options bag below, for the reason the
 * reference-image shape is spelled out: this nests two more object levels under an already-deep
 * chain, and a named const is where `tsc` can stop re-instantiating it.
 */
export const binaryEditRequestSchema = v.object({
  /**
   * `instruction` rewrites a whole artifact from a sentence; `mask` repaints only the region a
   * mask names. Two capabilities, because almost no integration has both.
   */
  mode: v.picklist(['instruction', 'mask']),
  /** What to change, folded into the brief verbatim. */
  instruction: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /**
   * The artifact to revise. Absent ⇒ the step's scope services say which existing asset each
   * generation revises, which is the ordinary case for a step that re-renders an inventory.
   */
  source: v.optional(binaryAssetRefSchema),
  /** The mask, for `mask` mode. Absent in `mask` mode is a gap the brief STATES. */
  mask: v.optional(binaryAssetRefSchema),
})
export type BinaryEditRequest = v.InferOutput<typeof binaryEditRequestSchema>

/**
 * Exact output DIMENSIONS in pixels, for the deliverables where the size IS the requirement.
 *
 * A named schema rather than an inline object, for the reason {@link binaryEditRequestSchema} is
 * one: this nests another object level under an already-deep chain and a named const is where
 * `tsc` stops re-instantiating it.
 *
 * The bounds are a SANITY floor and ceiling on the field, never a claim about what any endpoint
 * supports. Nothing here knows Flux's 4 MP cap or Retro Diffusion's per-style range, and by
 * design nothing will: the platform checks that a step CAN be asked for dimensions (the
 * `exact-size` capability) and states the number to the agent, which is the party holding the
 * vendor's contract when it writes the call.
 */
export const MAX_BINARY_PIXEL_EXTENT = 16384

export const binaryOutputSizeSchema = v.object({
  width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_BINARY_PIXEL_EXTENT)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_BINARY_PIXEL_EXTENT)),
})
export type BinaryOutputSize = v.InferOutput<typeof binaryOutputSizeSchema>

/**
 * The per-step GENERATION OPTIONS: the parameters a step wants every generation to carry, each
 * gated by the capability that makes it answerable ({@link BINARY_OPTION_CAPABILITIES}).
 *
 * They are a statement about the WORK, exactly like `modalities` and `mediaTypes` beside them,
 * and they are checked the same way: a step asking for something nothing it selected can do is
 * refused at admission rather than discovering it at the end of a paid run. What they are NOT is
 * a passthrough of any vendor's request body. Everything here is a fact about the deliverable
 * that more than one of the registered APIs can express in its own parameters, and the agent
 * translates it on the call it writes; a knob only one vendor has (`prompt_upsampling`,
 * `safety_tolerance`, a sampler name) stays in that integration's `guidance`, where it can say
 * what it means, rather than becoming a field every other integration ignores.
 */
/**
 * The raw object schema. Exported ONLY so the drift guard in `binary-capabilities.test.ts` can
 * infer its output type and compare it against the hand-written {@link BinaryGenerationOptions};
 * every other consumer takes {@link binaryGenerationOptionsSchema}, whose whole purpose is to
 * stop that inference from happening at each use site. See the interface's note for why.
 */
export const binaryGenerationOptionsObject = v.object({
  /**
   * Images every generation is conditioned on. Needs `reference-image`; more than one also needs
   * `multi-reference`, since an API that takes a single input image cannot compose two.
   */
  referenceImages: v.optional(v.pipe(v.array(binaryReferenceImageSchema), v.maxLength(8))),
  /**
   * The step REVISES existing artifacts rather than making new ones. Needs `instruction-edit` or
   * `mask-edit` depending on `mode`.
   */
  edit: v.optional(binaryEditRequestSchema),
  /** What to keep out. Needs `negative-prompt`. */
  negativePrompt: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /**
   * A fixed seed, so the run is reproducible. Needs `seed`.
   *
   * A step comparing candidates deliberately does NOT get its seed varied for it: a fixed seed
   * across integrations is how two renders of one subject are told apart by the integration
   * rather than by luck, and the brief says so.
   */
  seed: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(4294967295))),
  /** `16:9`, `1:1`, `3:2`. Needs `aspect-ratio`. */
  aspectRatio: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(16),
      v.regex(/^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$/, 'must be an aspect ratio of the form W:H'),
    ),
  ),
  /**
   * Exact pixel dimensions every artifact must be delivered at. Needs `exact-size`.
   *
   * Mutually exclusive with `aspectRatio` and `upscale`, refused structurally at pipeline save
   * (`assertUnambiguousOutputSize`): each of those states the final dimensions in a second,
   * possibly disagreeing way, and the party who would reconcile them is the agent writing the
   * call — the one with the least basis for deciding, which is the same argument that keeps
   * `mediaTypes` from meaning "any of these".
   */
  outputSize: v.optional(binaryOutputSizeSchema),
  /** Render at this multiple of the integration's native size. Needs `upscale`. */
  upscale: v.optional(v.pipe(v.number(), v.integer(), v.minValue(2), v.maxValue(8))),
  /** Deliver an alpha channel rather than a background. Needs `transparent-background`. */
  transparentBackground: v.optional(v.literal(true)),
  /** Deliver a seamlessly tiling image. Needs `tileable`. */
  tileable: v.optional(v.literal(true)),
})

/**
 * The generation options as a TYPE, written out rather than inferred.
 *
 * The one hand-written shape in this module, and it is not a style choice. This bag sits at the
 * bottom of the deepest schema chain the product has: `WorkspaceSnapshot` → pipeline → step
 * options → binary output → here → a reference image → its pipes: and inferring it pushed `tsc`
 * past its instantiation limit in `@cat-factory/workspaces`, several packages away, with an error
 * pointing at a line that has nothing to do with any of this. Naming the type stops the recursion
 * at this node: every consumer resolves `BinaryGenerationOptions` instead of re-deriving it.
 *
 * A hand-written type beside a schema is exactly the drift this codebase avoids elsewhere, so it
 * is pinned: `binary-capabilities.test.ts` asserts the inferred output and this interface are
 * mutually assignable, which fails the build if either side gains a field the other does not.
 * That check lives in a TEST rather than here because performing the inference in this file is
 * what the annotation exists to stop doing at every use site, and doing it once in one place is
 * affordable.
 */
export interface BinaryGenerationOptions {
  referenceImages?: BinaryReferenceImage[] | undefined
  edit?: BinaryEditRequest | undefined
  negativePrompt?: string | undefined
  seed?: number | undefined
  aspectRatio?: string | undefined
  outputSize?: BinaryOutputSize | undefined
  upscale?: number | undefined
  transparentBackground?: true | undefined
  tileable?: true | undefined
}

/**
 * The generation options as a SCHEMA, typed against the interface above so consumers stop
 * re-inferring it. `unknown` on the input side is what a parser accepts anyway, and nothing in
 * this repo reads `InferInput` of a step's options.
 */
export const binaryGenerationOptionsSchema: v.GenericSchema<unknown, BinaryGenerationOptions> =
  binaryGenerationOptionsObject

/**
 * Which option needs which capability, as the ONE table both sides read.
 *
 * A `Record` over the option keys rather than a chain of `if`s at each reader, so an option added
 * to the schema without a capability fails the typecheck here instead of shipping as a control
 * nothing checks. `referenceImages` maps to a LIST because its requirement grows with its length,
 * and `edit` maps to one of two by its mode, which is why the derivation below is a function and
 * not a lookup.
 */
export const BINARY_OPTION_CAPABILITIES: Record<
  keyof BinaryGenerationOptions,
  readonly BinaryGeneratorCapability[]
> = {
  referenceImages: ['reference-image', 'multi-reference'],
  edit: ['instruction-edit', 'mask-edit'],
  negativePrompt: ['negative-prompt'],
  seed: ['seed'],
  aspectRatio: ['aspect-ratio'],
  outputSize: ['exact-size'],
  upscale: ['upscale'],
  transparentBackground: ['transparent-background'],
  tileable: ['tileable'],
}

/**
 * The capabilities a step's generation options actually REQUIRE, in a stable order.
 *
 * Derived rather than declared, so a step never carries a requirement it does not exercise: a
 * `referenceImages` list of one needs `reference-image` and NOT `multi-reference`, and an `edit`
 * needs exactly the one capability its mode names. Deriving it is also what keeps the refusal
 * honest in the other direction, since a requirement nobody stated cannot be silently dropped by
 * an integration that does not declare it.
 *
 * Deliberately NOT extended with `candidate-batch` for a comparison step: an integration without
 * it can still produce several candidates by repeating the call, so a refusal there would reject
 * a selection that works. The brief states which of the two the agent should do.
 */
export function requiredBinaryCapabilities(
  options: BinaryGenerationOptions | undefined,
): BinaryGeneratorCapability[] {
  if (!options) return []
  const required: BinaryGeneratorCapability[] = []
  const references = options.referenceImages ?? []
  if (references.length > 0) required.push('reference-image')
  if (references.length > 1) required.push('multi-reference')
  if (options.edit) {
    required.push(options.edit.mode === 'mask' ? 'mask-edit' : 'instruction-edit')
  }
  if (options.negativePrompt) required.push('negative-prompt')
  if (options.seed !== undefined) required.push('seed')
  if (options.aspectRatio) required.push('aspect-ratio')
  if (options.outputSize) required.push('exact-size')
  if (options.upscale !== undefined) required.push('upscale')
  if (options.transparentBackground) required.push('transparent-background')
  if (options.tileable) required.push('tileable')
  return required
}

/** How a step's required capabilities stand against what its selected integrations declare. */
export interface BinaryCapabilityCoverage {
  /** Required capabilities no selected integration declares, judged against integrations that
   *  DECLARED theirs. These refuse the run. */
  uncovered: BinaryGeneratorCapability[]
  /** Required capabilities nothing selected claims, where at least one selected integration
   *  declares NO capabilities at all, so the requirement might be met and nothing may say
   *  otherwise. */
  unverifiable: BinaryGeneratorCapability[]
}

/**
 * Judge `required` against what `selected` declares it can do.
 *
 * The same THREE outcomes as {@link binaryFormatCoverage}, and deliberately the same rule, because
 * the two axes are in the same position: a declaration that pins nothing down is an explicit
 * documented state ("only the coarse facts are known") rather than a denial. That reading is what
 * lets this ship without breaking a single integration registered before capabilities existed:
 * they declare none, so every requirement against them is UNVERIFIABLE, the run is admitted, and
 * the gap is stated to the agent in its brief and to the composer in the picker. Refusing there
 * would retroactively invalidate every registration in existence; calling it covered would be a
 * clean bill of health nobody issued on the surface that decides whether the run may start.
 *
 * Kept as its own function rather than a generic over the format one: they read different fields
 * of different shapes, and a shared generic would be a parameterised `some`/`has` that saves four
 * lines and hides which axis a caller is asking about.
 */
export function binaryCapabilityCoverage(
  required: readonly BinaryGeneratorCapability[],
  selected: readonly { capabilities?: readonly BinaryGeneratorCapability[] }[],
): BinaryCapabilityCoverage {
  const declared = new Set(selected.flatMap((generator) => generator.capabilities ?? []))
  // An EMPTY selection declares nothing and hides nothing: with no integration to be silent, a
  // capability requirement is uncovered outright, exactly as a format requirement already is.
  const undeclared = selected.some((generator) => (generator.capabilities ?? []).length === 0)
  const uncovered: BinaryGeneratorCapability[] = []
  const unverifiable: BinaryGeneratorCapability[] = []
  for (const capability of required) {
    if (declared.has(capability)) continue
    if (undeclared) unverifiable.push(capability)
    else uncovered.push(capability)
  }
  return { uncovered, unverifiable }
}

/**
 * The integrations that declare each required capability, so a surface can say WHICH of a
 * step's selection will actually honour an option rather than only that something will.
 *
 * The question a person asks the moment a step holds two producers of one modality and one
 * option: an aspect ratio honoured by one of them and ignored by the other is not a covered
 * requirement in any useful sense, and coverage alone cannot say so. Ids come out in selection
 * order and a capability with no declarer is absent, never an empty list, so "nobody" and "not
 * asked" stay different answers.
 */
export function binaryCapabilityProviders(
  required: readonly BinaryGeneratorCapability[],
  selected: readonly { id: string; capabilities?: readonly BinaryGeneratorCapability[] }[],
): { capability: BinaryGeneratorCapability; generatorIds: string[] }[] {
  const out: { capability: BinaryGeneratorCapability; generatorIds: string[] }[] = []
  for (const capability of required) {
    const generatorIds = selected
      .filter((generator) => (generator.capabilities ?? []).includes(capability))
      .map((generator) => generator.id)
    if (generatorIds.length > 0) out.push({ capability, generatorIds })
  }
  return out
}
