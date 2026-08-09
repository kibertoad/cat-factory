import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The CONTENT-TYPE vocabulary shared by the two halves of a binary-output step: what a registered
// generative integration PRODUCES (`binary-generators.ts`) and what a step's stored artifacts
// turned out to BE (`binary-outputs.ts`).
//
// Its own leaf module — no imports beyond valibot — because both of those modules need it and one
// of them sits downstream of the entity schemas the other is reached through. A vocabulary this
// small has no business creating an import cycle.
//
// It also holds the two pure rules that read a step's SELECTION against that vocabulary
// ({@link binaryModalityOverlaps}, {@link binaryFormatCoverage}). Both are read by the backend,
// which composes the agent's brief and admits the run, and by the SPA, which offers the selection
// in the first place. The SPA cannot see kernel, so a rule with a home only on one side becomes a
// hand-kept copy on the other, which is how a step comes to be described one way in the builder
// and another way in the brief. Each reads nothing but this vocabulary and a structural view of a
// generator, so neither needs anything the other side cannot import.
// ---------------------------------------------------------------------------

/**
 * The CONTENT TYPE a generative integration produces, as a closed vocabulary.
 *
 * Closed, unlike the free-form capability tags on a foundational service, because this one is
 * the platform's own: it decides which generator a step may be given for which deliverable, it
 * groups the agent-facing brief, and the SPA renders a picker off it. A free-form tag would
 * make `images` and `image` two different content types that look identical to a reader and
 * silently fail to match — the exact failure `reservedCapabilityNearMiss` exists to catch for
 * the tags that genuinely must stay free-form.
 *
 * The members are MODALITIES, not genres: music, speech and sound effects are all `audio`,
 * because what differs between them is the prompt, while what differs between audio and video
 * is the whole integration, its media types and what a step can do with the result. A
 * deployment that must tell a music generator from a speech generator says so in the
 * definition's `mediaTypes` and its description.
 *
 * **3D is TWO members, and the reason is that nothing else can carry the distinction.** A single
 * asset and a composed scene are different products of different integrations, and what a step
 * does with the result is not comparable — one is attached to an entity, the other is loaded as
 * an environment. That passes the audio-versus-video test on the ground that matters. It fails it
 * on one: their MEDIA TYPES are identical. GLB, FBX, USDZ and `.blend` each carry either an
 * object or a whole scene graph, so no format tells you which you were handed and
 * {@link modalitiesOfMediaType} does not pretend otherwise. That is exactly why the split has to
 * live HERE: if the container could say it, a media type would already have said it, and a step
 * that must deliver a level could go on being admitted against a prop generator.
 *
 * What the split is NOT is a licence to slice the others by scope. `image` does not become
 * sprite-versus-background, because a step's format requirement (`binaryOutput.mediaTypes`) is
 * what distinguishes a PNG from a JPEG and a prompt is what distinguishes a sprite from a
 * backdrop. A member earns its place only when neither of those can tell two deliverables apart.
 */
export const binaryModalitySchema = v.picklist([
  /** Still images — `image/png`, `image/webp`, `image/jpeg`, `image/svg+xml`. */
  'image',
  /** Anything heard: music, speech/voice-over, sound effects — `audio/mpeg`, `audio/wav`. */
  'audio',
  /** Moving pictures, with or without an audio track — `video/mp4`, `video/webm`. */
  'video',
  /**
   * ONE 3D asset: a prop, a character, a part — the thing an inventory counts and a scene places.
   * Its container is `model/gltf-binary`, `model/obj`, `application/x-blender`, and so on; which
   * one matters to whoever opens it, and that is what `binaryOutput.mediaTypes` is for.
   */
  '3d-model',
  /**
   * A composed 3D scene: several assets with a hierarchy, and typically transforms, materials,
   * cameras or lights. The SAME containers as {@link '3d-model'} — the difference is in what the
   * file holds, which no media type states, so it is stated here or nowhere.
   */
  '3d-scene',
  /** A rendered, paginated document — `application/pdf`. */
  'document',
])
export type BinaryModality = v.InferOutput<typeof binaryModalitySchema>

/**
 * Whether a stored value is still a member of the vocabulary — DERIVED from the picklist, so it
 * cannot drift from it the way a hand-written second list would.
 *
 * This vocabulary is closed but PERSISTED (`stepOptions.binaryOutput.modalities`), and those two
 * facts together are what makes the guard necessary: a member retired from the union goes on
 * existing in saved pipelines, as `3d` did when it split into `3d-model` and `3d-scene`. A reader
 * that maps a modality through an exhaustive `Record` or `switch` is therefore total against the
 * TYPE and partial against the DATA — the gap where a lookup returns `undefined` and a call on it
 * throws. Narrow with this first, and render the negative case as the retired value it is: nothing
 * can know which current member was meant, and guessing one would quietly rewrite a requirement
 * that the split exists to make someone restate.
 */
export function isBinaryModality(value: string): value is BinaryModality {
  return BINARY_MODALITY_SET.has(value)
}

const BINARY_MODALITY_SET: ReadonlySet<string> = new Set(binaryModalitySchema.options)

/**
 * Whether artifacts of this content type are MEASURED in pixels, so an exact
 * `generation.outputSize` is a statement about them at all.
 *
 * An exhaustive `Record` rather than a set membership test, so a new member of the vocabulary
 * fails the build until someone decides which side of this it falls on. The answers are facts
 * about the media, not preferences: an image and a video frame have a width and a height, while
 * audio has a duration, a 3D asset has model units a renderer scales, and a document has a page
 * size in millimetres. None of the last three becomes measurable by asking harder.
 *
 * It exists because a size requirement on a MIXED step is not a requirement on every artifact.
 * A step selecting an image generator and an audio generator states one size, means it about the
 * images, and a reader that judged the audio against it would report a permanent failure about a
 * step that delivered exactly what was asked. Shared rather than restated in the SPA for the
 * standing reason: the surface that COUNTS a size failure and the layer that states the
 * requirement must not be able to disagree about which artifacts it covers.
 */
export function modalityCarriesPixelDimensions(modality: BinaryModality): boolean {
  return PIXEL_MEASURED_MODALITY[modality]
}

const PIXEL_MEASURED_MODALITY: Record<BinaryModality, boolean> = {
  image: true,
  video: true,
  audio: false,
  '3d-model': false,
  '3d-scene': false,
  document: false,
}

/** A content type that more than one of a step's selected integrations produces. */
export interface BinaryModalityOverlap {
  /** The content type they share. */
  modality: BinaryModality
  /** The ids that produce it, in the order they were given. Always two or more. */
  generatorIds: readonly string[]
}

/**
 * The content types more than one of these integrations produces.
 *
 * A modality DECIDES which generator may serve a step, and it stops deciding at the second
 * producer of one kind: from there the choice is per artifact and it is not one the platform can
 * make. So this computes only the FACT that a choice exists, and deliberately ranks nothing.
 * Narrowness is not correctness (a specialist pixel-art API and a specialist photo API are
 * equally narrow and answer different questions), and the platform has no cost model, no quality
 * model and no view of what the step is for. A confident wrong preference is worse than none,
 * because it displaces the per-integration notes whoever is deciding would otherwise have read.
 *
 * Shared rather than copied, for the reason stated at the top of this module: kernel states the
 * overlap to the AGENT in its brief and the SPA states it to the HUMAN in the step picker, and
 * the two must not be able to disagree about which integrations overlap.
 *
 * Order is derived from the input, so a brief re-rendered per dispatch is byte-identical:
 * modalities come out in first-appearance order and ids in the order they were given. An id
 * repeated in the input contributes ONCE, or a step that happened to name one integration twice
 * would be told it holds two producers of a kind it holds one of.
 */
export function binaryModalityOverlaps(
  generators: readonly { id: string; modalities: readonly BinaryModality[] }[],
): BinaryModalityOverlap[] {
  const byModality = new Map<BinaryModality, string[]>()
  const seen = new Set<string>()
  for (const generator of generators) {
    if (seen.has(generator.id)) continue
    seen.add(generator.id)
    // Deduplicated per generator for the same reason ids are deduplicated across them: a
    // definition listing one modality twice is not two producers of it.
    for (const modality of new Set(generator.modalities)) {
      const ids = byModality.get(modality)
      if (ids) ids.push(generator.id)
      else byModality.set(modality, [generator.id])
    }
  }
  return [...byModality]
    .filter(([, generatorIds]) => generatorIds.length > 1)
    .map(([modality, generatorIds]) => ({ modality, generatorIds }))
}

/** How a step's declared FORMATS stand against what its selected integrations say they emit. */
export interface BinaryFormatCoverage {
  /** Declared formats no selected integration emits, judged against integrations that DECLARED
   *  theirs. These refuse the run. */
  uncovered: string[]
  /** Declared formats nothing selected claims, where at least one selected integration declares
   *  no formats at all — so the requirement MIGHT be met and nothing here may say otherwise. */
  unverifiable: string[]
}

/**
 * Judge `required` against what `selected` declares it emits.
 *
 * THREE outcomes, not two, and the third is the whole reason this is its own function. A
 * generator declaring no `mediaTypes` is an explicit, documented state — "only the coarse
 * modality is known" — so a requirement it cannot be judged against is UNVERIFIABLE, not
 * uncovered. Refusing there would punish the honest declaration and break every integration that
 * has not pinned its formats down; calling it covered would be the mirror mistake, a clean bill
 * of health nobody issued, on the surface that decides whether the run may start. So the run is
 * admitted and the gap is STATED — to the agent in its brief, and to whoever composes the step —
 * which is the same disposition `generatorsUnverified` takes on the settlement side.
 *
 * Shared by admission, the brief and the picker, so none of them can hold a different opinion
 * about the same selection. An ABSENT `mediaTypes` and an empty one are one state here, because
 * that is the one state the wire type and the registry view are each spelling: the wire type
 * omits the field, a code-registered definition may list nothing, and both mean "only my
 * modality is known".
 */
export function binaryFormatCoverage(
  required: readonly string[],
  selected: readonly { mediaTypes?: readonly string[] }[],
): BinaryFormatCoverage {
  const emitted = new Set(selected.flatMap((generator) => generator.mediaTypes ?? []))
  // An EMPTY selection declares nothing and hides nothing: with no integration to be silent, a
  // format requirement is uncovered outright, exactly as a modality requirement already is.
  const undeclared = selected.some((generator) => (generator.mediaTypes ?? []).length === 0)
  const uncovered: string[] = []
  const unverifiable: string[] = []
  for (const mediaType of required) {
    if (emitted.has(mediaType)) continue
    if (undeclared) unverifiable.push(mediaType)
    else uncovered.push(mediaType)
  }
  return { uncovered, unverifiable }
}

/** The 3D containers, which say the content is 3D and DELIBERATELY nothing more. */
const THREE_D: BinaryModality[] = ['3d-model', '3d-scene']

/**
 * Every {@link BinaryModality} a media type is CONSISTENT with — empty when nothing here
 * recognises it.
 *
 * A LIST rather than one answer, because for 3D there is genuinely more than one and saying so
 * is the whole point. `model/gltf-binary` is a GLB; a GLB is one prop or an entire environment
 * and the container does not record which. Returning `3d-model` for it would classify every
 * delivered scene as an asset, and picking either would make the boot check below refuse a
 * correct registration.
 *
 * Empty is a REAL answer and callers must keep it apart from a modality: it means the platform
 * does not know what this content is, which is different from knowing it is not an image. Two
 * things read this — a registration's declared media types are checked against its declared
 * modalities (a generator claiming `audio` while listing `image/png` is a configuration error,
 * not a judgement call), and a settled step's declared artifacts are CLASSIFIED in code rather
 * than by asking the model what kind of thing it just made. Each has to say what it does with a
 * MULTI-member answer: the first passes when the sets INTERSECT, the second declines to classify
 * at all, because an ambiguous answer is not a verdict.
 */
export function modalitiesOfMediaType(value: string): BinaryModality[] {
  const type = normalizeMediaType(value) ?? ''
  const [top, subtype] = type.split('/')
  if (!top || !subtype) return []
  if (top === 'image') return ['image']
  if (top === 'audio') return ['audio']
  if (top === 'video') return ['video']
  if (top === 'model') return THREE_D
  if (top === 'application') {
    if (subtype === 'pdf') return ['document']
    // The 3D formats that predate `model/*` and are still what tooling emits: `sla` is STL, and
    // `x-tgif` is what the shared mime database maps `.obj` to (an old collision with the TGIF
    // drawing format, but it IS the type an OBJ file is served as, so recognising it is right).
    // `octet-stream` stays empty on purpose — it is the "no idea" type, and guessing 3D from it
    // would classify every unlabelled download as a model.
    if (subtype === 'octet-stream') return []
    // `x-blender` is the shared mime database's type for a `.blend` file, which is what an
    // EDITABLE 3D deliverable looks like when the consumer is an artist rather than an engine —
    // the same reason `sla` and `x-tgif` are here rather than only the registered `model/*` names.
    if (['gltf+json', 'x-gltf', 'sla', 'x-tgif', 'x-blender'].includes(subtype)) return THREE_D
    return []
  }
  return []
}

/**
 * The modality a media type UNAMBIGUOUSLY identifies, or `null` when it identifies none or more
 * than one.
 *
 * For classifying something that already exists — a stored artifact — where a guess is worse than
 * an absence. A `.glb` collapses `3d-model` and `3d-scene`, so it classifies as neither and the
 * artifact carries no modality: "we cannot tell what this is" is not "this is not an image", and
 * the step's own declaration is the only thing that ever knew which of the two was being made.
 */
export function modalityOfMediaType(value: string): BinaryModality | null {
  const modalities = modalitiesOfMediaType(value)
  return modalities.length === 1 ? (modalities[0] ?? null) : null
}

/**
 * A media type reduced to the `type/subtype` two people mean the same thing by — lowercased,
 * trimmed, parameters dropped — or `null` when there is no `type/subtype` in it at all.
 *
 * The ONE definition of "the same format", because three places compare media types and two of
 * them receive text nobody normalised. A step's declared formats and a generator's declared
 * formats both come through {@link mediaTypeSchema}, which already lowercases and refuses
 * parameters, so those two match on plain equality; a SETTLED artifact's `contentType` is the
 * agent's own prose (`image/PNG`, `model/gltf-binary; charset=binary`) and matches nothing until
 * it comes through here. A second copy of this reduction is how `model/GLTF-binary` becomes a
 * format the platform reports as undelivered while the file sits exactly where it was asked for.
 *
 * Note what it deliberately does NOT do: it maps no synonyms. `model/obj` and
 * `application/x-tgif` are the same file and stay different values here, because a step's format
 * requirement is checked by EXACT match against what a generator declared, and a matcher that
 * quietly accepted a near-neighbour would admit a GLB where an OBJ was required — which is the
 * failure the requirement exists to prevent. The two sides agree by spelling the format the same
 * way, and the brief tells the agent the exact string.
 */
export function normalizeMediaType(value: string): string | null {
  const type = value.trim().toLowerCase().split(';')[0]?.trim() ?? ''
  const [top, subtype] = type.split('/')
  return top && subtype ? `${top}/${subtype}` : null
}

/**
 * A media type as `type/subtype` (parameters are NOT accepted — a generator declares what it
 * produces, not how one request happened to be encoded).
 */
export const mediaTypeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.toLowerCase(),
  v.minLength(3),
  v.maxLength(128),
  v.regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    'must be a media type of the form type/subtype',
  ),
)
