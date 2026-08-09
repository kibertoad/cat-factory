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
 * **A capability says the request can CARRY the value; {@link binaryGeneratorAcceptsSchema} says
 * which values are accepted.** The two questions are separate because they fail differently, and
 * collapsing them is what produced both halves of the problem the value axis was added to fix.
 * This member answers only "does asking this reach a parameter at all". An endpoint that has no
 * such parameter declares NOTHING here, however close its behaviour looks: Recraft's
 * `crispUpscale` enlarges at a ratio it fixes itself and takes no factor, so declaring `upscale`
 * for it would admit a step asking for 4x and hand it an enlargement at an unknown multiple. No
 * accepted-value list repairs that, because `upscale: [2]` is not a narrower statement of the
 * truth, it is a fabricated one. The endpoint says what it does in a definition's `guidance` and
 * the step is refused an option the endpoint genuinely cannot answer, which is a visible refusal
 * naming the capability rather than an artifact that checks out everywhere and is wrong where it
 * counts. The honest reading of such a refusal is usually that the option was the wrong way to
 * state the requirement: a step wanting a specific larger deliverable is asking for
 * {@link 'exact-size'}, not for a multiple of something it never measured.
 *
 * An endpoint that DOES take the parameter, but only at values from a closed set, declares the
 * capability and states the set. That is not the per-integration table the design record refuses:
 * a set of accepted values partitions exactly, the same way `mediaTypes` does, and stating it
 * makes an existing ask checkable without unlocking anything new to ask for.
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
   * The request carries an explicit aspect SHAPE: a ratio (`16:9`), or a bucket it maps a shape
   * onto (`image_size: square | portrait | landscape`, `resolution: 1k | 2k`). Unlocks
   * `generation.aspectRatio`.
   *
   * Deliberately NOT "a ratio or an output size", which is what this member said while it was
   * the only one on the axis. A bucketed API honours a ratio exactly and an exact pixel size not
   * at all, so one member covering both made the integrations that CAN be handed dimensions
   * indistinguishable from the ones that cannot: see {@link 'exact-size'}.
   *
   * The line between the two members is WHAT THE REQUEST CARRIES, not how free the answer is. A
   * shape goes here even when the endpoint accepts only a closed list of ratios; dimensions go
   * on `exact-size` even when it accepts only a closed list of those. Which values each takes is
   * {@link binaryGeneratorAcceptsSchema}'s `aspectRatios`, so an endpoint offering ten ratios is
   * a step's `7:3` refused by name rather than admitted and quietly cropped.
   */
  'aspect-ratio',
  /**
   * The request carries output DIMENSIONS in pixels: a width and a height, rather than a shape
   * the endpoint maps onto a size of its own choosing. Unlocks `generation.outputSize`.
   *
   * Its own member rather than a refinement of `aspect-ratio`, because the two partition
   * differently and the difference is the whole deliverable for anything rendered to a fixed
   * grid. A 96x96 inventory icon asked of a bucketed endpoint does not come back slightly
   * wrong: it comes back as a 1K render downscaled 4x, which on pixel art is not the same asset
   * at any level of care, and every check downstream passes (the modality is covered, the
   * format is covered, the upload succeeded). The consumer that rejects it is the game, weeks
   * later.
   *
   * **An endpoint whose `size` parameter takes a closed list of `WxH` values declares THIS
   * member and states the list**, which is the boundary case worth spelling out because it moved.
   * While `accepts` did not exist such an endpoint had to declare `aspect-ratio`, on the ground
   * that it rounds: that classification described a size-taking API as shape-taking, and it left
   * a step needing 96x96 admitted against an endpoint whose nearest listed shape is 1024x1024.
   * Now the capability answers the durable question (can it be handed dimensions at all) and
   * `accepts.outputSizes` answers the vendor-specific one.
   *
   * The vocabulary stays FLAT: an API taking width and height can honour any ratio, so it
   * declares BOTH members rather than this one implying the other. That is the same shape
   * `reference-image` / `multi-reference` already has, and it is chosen for the same reason:
   * an implication table is an ordering over a picklist that every future member would then
   * have to be placed in, to save a deployment one word in its own registration, and the cost
   * of forgetting that word is a loud refusal naming the capability rather than a silent
   * mis-render.
   *
   * An endpoint that renders any pair it is handed, inside limits no list can enumerate (Flux
   * caps at 4 MP and wants multiples of 32; Retro Diffusion's range moves with the style),
   * declares this member and states NO sizes. A per-integration size RANGE stays refused on the
   * design record's own grounds: it is the `resolutionRange` discriminator wearing a new name,
   * and `min`/`max`/`step`/`multiple-of` is a constraint language rather than a fact. The limits
   * stay in the integration's own `guidance`, where a sentence can say what they are.
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
 * The largest pixel extent either axis may carry: a SANITY ceiling on the field, never a claim
 * about what any endpoint supports.
 *
 * Nothing here knows Flux's 4 MP cap or Retro Diffusion's per-style range, and by design nothing
 * will: the platform checks that a step CAN be asked for dimensions (the `exact-size` capability)
 * and states the number to the agent, which is the party holding the vendor's contract when it
 * writes the call. Exported so the read-back that re-checks a reported dimension bounds it against
 * the same number the write boundary does.
 */
export const MAX_BINARY_PIXEL_EXTENT = 16384

/**
 * Exact output DIMENSIONS in pixels, for the deliverables where the size IS the requirement.
 *
 * A named schema rather than an inline object, for the reason {@link binaryEditRequestSchema} is
 * one: this nests another object level under an already-deep chain and a named const is where
 * `tsc` stops re-instantiating it.
 *
 * Both members are required together: a width with no height describes no deliverable, and half a
 * pair would let a size comparison downstream read one axis as matching.
 */
export const binaryOutputSizeSchema = v.object({
  width: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_BINARY_PIXEL_EXTENT)),
  height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_BINARY_PIXEL_EXTENT)),
})
export type BinaryOutputSize = v.InferOutput<typeof binaryOutputSizeSchema>

/**
 * An aspect ratio, `W:H`.
 *
 * Named rather than inlined into the one option that used to be its only reader, because an
 * integration now declares the ratios it ACCEPTS ({@link binaryGeneratorAcceptsSchema}) and the
 * two have to be the same rule: a declaration validated more loosely than the request could hold
 * a value no step is able to spell, so the endpoint's own list would silently accept nothing.
 */
export const binaryAspectRatioSchema = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(16),
  v.regex(/^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$/, 'must be an aspect ratio of the form W:H'),
)

/**
 * How many times the integration's native size to render at. Named for the reason
 * {@link binaryAspectRatioSchema} is: the accepted-factor list and the step's own field are one
 * rule read from two places.
 */
export const binaryUpscaleFactorSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(2),
  v.maxValue(8),
)

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
  aspectRatio: v.optional(binaryAspectRatioSchema),
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
  upscale: v.optional(binaryUpscaleFactorSchema),
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

/**
 * A generation option that states the DELIVERED DIMENSIONS a second time, beside an exact
 * `outputSize`. The union is the option keys themselves, so a reader on either side of the wire
 * names the field the composer has to delete.
 */
export type ConflictingOutputSizeOption = 'aspectRatio' | 'upscale'

/**
 * The options that restate the delivered dimensions beside an exact {@link BinaryOutputSize}, in a
 * stable order. Empty when the step asks for no exact size, which stays the ordinary case.
 *
 * `aspectRatio` states the shape the size already fixes, and `upscale` states a multiple of
 * whatever the integration renders natively, so either one held beside a size leaves the
 * deliverable's actual dimensions undetermined at exactly the point the step went to the trouble of
 * determining them. The platform refuses that rather than resolving it by precedence: the party a
 * precedence rule hands the leftover decision to is the AGENT writing the vendor call, which reads
 * "96x96" and "16:9" in one brief and picks. Two contradicting statements of one fact is a
 * mis-configured step and the fix (delete one) is unambiguous, which is what makes refusing it the
 * cheap option.
 *
 * Shared rather than restated on each side, like {@link binaryFormatCoverage} one axis over: the
 * backend REFUSES the save with it and the SPA has to state the same refusal in the builder, where
 * it is fixable without a round trip. A rule with a home on only one side becomes a hand-kept copy
 * on the other, and the two then disagree about which selection is legal.
 */
export function conflictingOutputSizeOptions(
  options: BinaryGenerationOptions | undefined,
): ConflictingOutputSizeOption[] {
  if (!options?.outputSize) return []
  const conflicts: ConflictingOutputSizeOption[] = []
  if (options.aspectRatio) conflicts.push('aspectRatio')
  if (options.upscale !== undefined) conflicts.push('upscale')
  return conflicts
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

// ---------------------------------------------------------------------------
// The VALUE axis: not "can this endpoint be asked", which is the capability above, but "will it
// take the value this step is asking for".
//
// The capability axis is a yes/no, and for several real endpoints the honest answer is "yes, at
// one of these". Grok Imagine and Nano Banana take an aspect ratio from a closed picklist while
// Flux and Retro Diffusion honour any ratio at all, and all four declare `aspect-ratio`, so a
// step asking for `7:3` is admitted against every one of them and served by two. Nothing reports
// the crop: the modality is covered, the format is covered, the upload succeeded. That is the
// silent wrong artifact the capability axis exists to prevent, arriving through the capability
// axis, and no wording of a yes/no fixes it.
//
// What the platform will NOT do is negotiate. A "closest supported value" rule turns a refusal
// into a substitution chosen by whoever wrote the fallback, which is the failure this axis is
// about. A step either asks for something the endpoint takes or it is told, by name, that it
// does not.
// ---------------------------------------------------------------------------

/**
 * The values an integration ACCEPTS for the generation options whose domain is enumerable.
 *
 * A sibling of `capabilities` rather than a change to it, so a definition that declares only tags
 * keeps working unchanged and absent goes on meaning "only the coarse facts are known".
 *
 * **Only the options with a CLOSED domain appear here, and each entry is a SET.** A range is
 * deliberately unrepresentable: `min`/`max`/`step`/`multiple-of` is a constraint language, and
 * the moment one exists it grows to cover Flux's "any pair up to 4 MP in multiples of 32", which
 * is the `resolutionRange` discriminator the design record refuses. An endpoint with a genuine
 * range declares the capability, states no set, and puts its limits in `guidance`: its steps are
 * then judged exactly as they were before this field existed.
 *
 * **An empty list is refused rather than read as "accepts nothing".** Absent is the one spelling
 * of "not stated", so a `[]` that fell out of a filter would otherwise refuse every value the
 * endpoint has, silently, on a declaration whose author meant to say nothing at all.
 */
export const binaryGeneratorAcceptsSchema = v.object({
  /** The aspect ratios it takes, when it takes a closed set of them. Compared in LOWEST TERMS. */
  aspectRatios: v.optional(
    v.pipe(v.array(binaryAspectRatioSchema), v.minLength(1), v.maxLength(64)),
  ),
  /** The exact `WxH` pairs it renders, when its size parameter is a closed list. */
  outputSizes: v.optional(v.pipe(v.array(binaryOutputSizeSchema), v.minLength(1), v.maxLength(64))),
  /** The upscale factors it takes, when it takes a closed set of them. */
  upscaleFactors: v.optional(
    v.pipe(v.array(binaryUpscaleFactorSchema), v.minLength(1), v.maxLength(8)),
  ),
})
export type BinaryGeneratorAccepts = v.InferOutput<typeof binaryGeneratorAcceptsSchema>

/** A generation option whose accepted values an integration can enumerate. */
export type BinaryValueOption = 'aspectRatio' | 'outputSize' | 'upscale'

/**
 * One value option's three parts, as the ONE table every reader folds over: which capability
 * gates it, how to read the step's request, and how to read an integration's accepted set.
 *
 * A `Record` over the union, so a member added to {@link BinaryValueOption} fails the typecheck
 * here rather than shipping as an option nothing checks. The capability is restated rather than
 * read out of {@link BINARY_OPTION_CAPABILITIES}, whose values are LISTS ("any of these", which
 * is what `edit` and `referenceImages` need); `binary-capabilities.test.ts` pins that each entry
 * here names exactly the one capability that table maps its option to, so the two cannot drift.
 *
 * Values are compared as STRINGS, in the spelling each renders to below, because that is also
 * what a refusal has to say back to a human. The one normalisation is the ratio's: `1920:1080`
 * and `16:9` are the same shape asked for twice, and refusing the first against an endpoint that
 * declared the second would be a false refusal over spelling.
 */
const BINARY_VALUE_OPTIONS: Record<
  BinaryValueOption,
  {
    capability: BinaryGeneratorCapability
    requested: (options: BinaryGenerationOptions) => string | undefined
    accepted: (accepts: BinaryGeneratorAccepts) => string[] | undefined
  }
> = {
  aspectRatio: {
    capability: 'aspect-ratio',
    requested: (options) =>
      options.aspectRatio ? reduceAspectRatio(options.aspectRatio) : undefined,
    accepted: (accepts) => accepts.aspectRatios?.map(reduceAspectRatio),
  },
  outputSize: {
    capability: 'exact-size',
    requested: (options) => (options.outputSize ? formatOutputSize(options.outputSize) : undefined),
    accepted: (accepts) => accepts.outputSizes?.map(formatOutputSize),
  },
  upscale: {
    capability: 'upscale',
    requested: (options) => (options.upscale === undefined ? undefined : String(options.upscale)),
    accepted: (accepts) => accepts.upscaleFactors?.map(String),
  },
}

/** `WxH`, the spelling the brief and every refusal already use for a size. */
function formatOutputSize(size: BinaryOutputSize): string {
  return `${size.width}x${size.height}`
}

/**
 * An aspect ratio in lowest terms, so `1920:1080` and `16:9` compare equal.
 *
 * Total by construction: the string has already passed {@link binaryAspectRatioSchema} at both
 * ends (a step's field and an integration's declaration), and a value that somehow has not is
 * returned unchanged rather than dropped, which compares as itself and cannot silently match.
 */
function reduceAspectRatio(ratio: string): string {
  const match = /^([1-9][0-9]{0,3}):([1-9][0-9]{0,3})$/.exec(ratio.trim())
  if (!match) return ratio
  let a = Number(match[1])
  let b = Number(match[2])
  while (b !== 0) [a, b] = [b, a % b]
  return `${Number(match[1]) / a}:${Number(match[2]) / a}`
}

/** A value a step asks for that no selected integration accepts. Refuses the run. */
export interface BinaryUnacceptedValue {
  option: BinaryValueOption
  /** What the step asks for, in the spelling a message states back. */
  requested: string
  /** What the integrations that DID state a set accept, deduplicated, in selection order. */
  accepted: string[]
}

/** How a step's requested option VALUES stand against what its selected integrations accept. */
export interface BinaryValueCoverage {
  /** Requested values every integration that stated a set excludes, and none left open. Refuses. */
  unaccepted: BinaryUnacceptedValue[]
  /**
   * Requested values no stated set contains, where another integration declaring the capability
   * stated NO set, so the value may still be served and nothing may say otherwise. Advisory.
   */
  unverifiable: BinaryValueOption[]
}

/**
 * Judge the VALUES a step asks for against the sets its selected integrations accept.
 *
 * Four outcomes rather than the three the axes above it have, and the extra one is the reason
 * this can ship at all. Judged per option, over the integrations that DECLARE the gating
 * capability (an integration that declares none of it is already the coarse axis's answer, and
 * counting it here would report one fault twice):
 *
 * - **Nobody stated a set.** SILENT. This is the state every registration is in until somebody
 *   audits an endpoint, and it is exactly what the platform knew before this field existed. An
 *   advisory that fired here would ride nearly every step with an aspect ratio, which is how a
 *   line stops being read.
 * - **A stated set contains the value.** Covered.
 * - **No stated set contains it, and some declarer stated none.** UNVERIFIABLE. One integration
 *   refuses the value and another has not said, so the step may well be served: reported, never
 *   refused, the same disposition {@link binaryCapabilityCoverage} gives its own third state.
 * - **No stated set contains it, and every declarer stated one.** UNACCEPTED, and this is the
 *   refusal the axis exists for: every endpoint that could serve the option has enumerated what
 *   it takes, and this is not among them.
 *
 * Takes the step's OPTIONS rather than a pre-derived requirement list, unlike its neighbours,
 * because the judgement needs the value and not only the capability it implies.
 */
export function binaryValueCoverage(
  options: BinaryGenerationOptions | undefined,
  selected: readonly {
    capabilities?: readonly BinaryGeneratorCapability[]
    accepts?: BinaryGeneratorAccepts
  }[],
): BinaryValueCoverage {
  const unaccepted: BinaryUnacceptedValue[] = []
  const unverifiable: BinaryValueOption[] = []
  if (!options) return { unaccepted, unverifiable }
  for (const [key, entry] of Object.entries(BINARY_VALUE_OPTIONS)) {
    const option = key as BinaryValueOption
    const requested = entry.requested(options)
    if (requested === undefined) continue
    const declarers = selected.filter((generator) =>
      (generator.capabilities ?? []).includes(entry.capability),
    )
    const stated = declarers.flatMap((generator) => {
      const values = generator.accepts ? entry.accepted(generator.accepts) : undefined
      return values ? [values] : []
    })
    if (stated.length === 0) continue
    if (stated.some((values) => values.includes(requested))) continue
    if (stated.length < declarers.length) {
      unverifiable.push(option)
      continue
    }
    unaccepted.push({ option, requested, accepted: [...new Set(stated.flat())] })
  }
  return { unaccepted, unverifiable }
}
