import * as v from 'valibot'
import { binaryGenerationOptionsSchema, binaryOutputSizeSchema } from './binary-capabilities.js'
import { binaryCandidateComparisonSchema } from './binary-candidates.js'
import { binaryModalitySchema, mediaTypeSchema } from './binary-modalities.js'

// Wire vocabulary for BINARY-OUTPUT agent steps (docs/initiatives/binary-output-foundational-storage.md):
// a step whose kind GENERATES binary artifacts (image generation is the canonical example) and
// stores them through a FOUNDATIONAL SERVICE the step selected from the workspace's catalog. An
// org that runs an asset store selects that one; a deployment that runs none selects
// `platform-assets` (see `platform-assets.ts`), the one service the platform registers for
// itself, whose bytes land in the same account-configured store screenshots do under a kind the
// retention sweep never reclaims. Either way the step's storage target is a catalog SELECTION,
// and nothing here branches on which one it names. The step may also select further catalog
// services as generation CONTEXT (an inventory service that can say which entities exist, which
// lack an asset, and how each is described), whose API contracts are injected beside the storage
// service's.

const serviceId = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
)

/**
 * The per-step SELECTION of foundational services a binary-generating kind runs against —
 * the `binaryOutput` field of {@link stepOptionsSchema}. Both halves name ids from the
 * workspace's foundational-services catalog ("selected from the list"), validated at run
 * admission against the RESOLVED catalog rather than at save alone, because the catalog can
 * change between the two.
 */
export const binaryOutputConfigSchema = v.object({
  /**
   * The catalog service every generated binary is STORED through. Must exist in the resolved
   * catalog and carry the `asset-storage` capability tag — storing product assets in the
   * org's audit service is a configuration error, not a judgment call left to the agent.
   */
  storageServiceId: serviceId,
  /**
   * Catalog services consulted for the SCOPE and CONTEXT of the generation — e.g. an entity
   * inventory that answers "what exists, what lacks an image, and what is each thing's
   * description". Existence in the catalog is enforced; no capability tag is, because any
   * service with a readable contract can inform scope. Absent ⇒ the step's own prompt and
   * context files are the whole scope.
   */
  contextServiceIds: v.optional(v.array(serviceId)),
  /**
   * The GENERATIVE INTEGRATIONS this step may call to produce its artifacts — ids from the
   * deployment's code-registered `BinaryGeneratorRegistry` (see `binary-generators.ts`).
   *
   * A separate half of the selection from the two above, because it answers a different
   * question: those say where an artifact GOES, this says what MAKES it. Absent ⇒ the step
   * generates through whatever its agent already has (a model with native image output, a tool
   * server), and its brief says so rather than naming an integration it does not have.
   * Validated at run admission against the registry, never against a saved copy.
   */
  generatorIds: v.optional(v.array(serviceId)),
  /**
   * The CONTENT TYPES this step is expected to deliver. Every one of them must be covered by a
   * selected generator, or the run is refused at admission — a step that must produce a theme
   * song and selected only an image generator cannot do its job, and the failure would
   * otherwise surface as an agent apologising at the end of a paid run.
   *
   * Absent ⇒ no requirement is imposed and the selected generators' own modalities are the
   * whole story. It is deliberately NOT defaulted from the selection: "this step must produce
   * audio" is a statement about the WORK, and deriving it from the current selection would make
   * removing the audio generator look like a change of requirements rather than a break.
   */
  modalities: v.optional(v.array(binaryModalitySchema)),
  /**
   * The concrete FORMATS this step must deliver, one notch finer than {@link modalities}, for the
   * deliverables where the container IS the requirement rather than a rendering preference.
   *
   * 3D is why this exists. PNG versus WebP is a genre question and belongs in a prompt, but GLB,
   * USDZ and FBX are all one modality and none of them substitutes for another: a Godot importer
   * takes the first, a RealityKit pipeline the second, an art pipeline the third. A step whose
   * mesh must load in the game can otherwise be admitted against an integration that cannot emit a
   * loadable container, and the failure arrives at the end of a paid run as an asset nobody can
   * open — which reads as a bad generation rather than as a selection nothing checked.
   *
   * Note the direction that gives this axis its scope: it is what the modality vocabulary does NOT
   * have to split for. `3d-model` and `3d-scene` are two members precisely because no format tells
   * them apart, and `image` stays one because a format tells PNG from JPEG — so a distinction any
   * container can carry is stated HERE, and only what none can carry earns a modality.
   *
   * EVERY entry must be covered, not any one of them: a step needing a GLB for the engine AND an
   * FBX the artists can open in Blender declares both, and both are checked. "Any of these will
   * do" is deliberately not expressible — the agent has to name concrete formats on the vendor
   * call, and a requirement that leaves it a choice hands that decision to the party with the
   * least basis for making it. Declare the format you need, not the set you would accept.
   *
   * Checked by EXACT match against the {@link BinaryGeneratorDefinition.mediaTypes} a selected
   * integration declares (both sides come through `mediaTypeSchema`, so case and parameters are
   * already reconciled), and NOT translated into a modality: `modalityOfMediaType` recognises only
   * the formats the platform happens to know, so inferring one here would make the strength of the
   * check depend on whether we recognise the string — a requirement spelled with a brand-new
   * container would silently lose the coarse check its neighbour keeps. The two lists are
   * independent statements and both are enforced as written.
   *
   * Absent ⇒ no format requirement, which is the ordinary case and stays the ordinary case:
   * {@link modalities} is the statement about the WORK. Like it, this is never defaulted from the
   * current selection — deriving a requirement from what is selected would make REMOVING a
   * generator look like a change of requirements rather than a break.
   */
  mediaTypes: v.optional(v.array(mediaTypeSchema)),
  /**
   * The parameters every generation on this step carries: a reference image, an edit
   * instruction, a seed, a negative prompt, a transparent background (see
   * `binary-capabilities.ts`).
   *
   * A THIRD axis beside the two above, and the one that says what to ask FOR rather than what
   * must come back. Each option is gated by the capability that makes it answerable, and the
   * gate has the same three outcomes the format check does: an option nothing selected can do is
   * refused at admission, an option nothing has DECLARED either way is admitted with the gap
   * stated. That third state is what lets this exist at all without invalidating every
   * integration registered before capabilities did.
   *
   * Absent ⇒ the step's prompt is the whole instruction, which stays the ordinary case. These
   * are for the facts a prompt cannot carry: an agent told "match the reference" with no
   * reference, or told to seed a run by an API that takes no seed, has been told nothing.
   */
  generation: v.optional(binaryGenerationOptionsSchema),
  /**
   * This step generates COMPARABLE CANDIDATES and parks for a human to keep one (or several
   * under distinct ids) rather than letting the agent commit to one producer unobserved. See
   * `binary-candidates.ts`.
   *
   * Absent ⇒ the step generates its deliverables directly, which is the ordinary case and stays
   * it: a comparison costs a human interrupt and at least one extra generation per subject, and
   * it is worth that exactly where the choice between two producers of one content type is a
   * judgement somebody wants to make with the pictures in front of them.
   */
  comparison: v.optional(binaryCandidateComparisonSchema),
})
export type BinaryOutputConfig = v.InferOutput<typeof binaryOutputConfigSchema>

/** One stored artifact a binary-generating step declared in its reply's machine-read block. */
export const binaryOutputArtifactSchema = v.object({
  /**
   * The foundational-service id the agent says it stored the artifact through, LOWERCASED on
   * read-back — catalog ids are lower-kebab slugs, so a model that capitalises one means the
   * same service and must not be reported as unknown. (The sibling `location` is not
   * normalised: it is the service's own addressing, where case can be significant.)
   */
  service: v.string(),
  /**
   * Where the artifact lives IN that service's own addressing — an object key, a path, a URL;
   * whatever the service's API returns. Recorded verbatim (capped), never interpreted.
   */
  location: v.string(),
  /** The domain entity the artifact belongs to, in the agent's words (`product:tea-kettle`). */
  entity: v.optional(v.string()),
  /** The artifact's media type as the agent reports it (`image/png`). */
  contentType: v.optional(v.string()),
  /** A one-line description of what was generated. */
  description: v.optional(v.string()),
  /**
   * The artifact's pixel dimensions as the agent reports them, for the steps that asked for an
   * exact `generation.outputSize`.
   *
   * The same epistemic status as {@link contentType} beside it, and recorded on the same terms:
   * it is the agent's own claim, the platform never holds the bytes, and a reader judges it. It
   * earns its place because the size requirement is otherwise checked only at the grain of "can
   * this integration be ASKED for dimensions" — admission's half — and the failure the
   * requirement exists to catch is a DELIVERY fact. `undeliveredMediaTypes` is the same
   * judgement one axis over, made from the same kind of self-report.
   *
   * ABSENT is a third state and not a pass: an artifact reporting no dimensions is not judged
   * against the step's size, because "we were not told" and "it came back wrong" are different
   * facts and only the second is evidence of anything.
   */
  dimensions: v.optional(binaryOutputSizeSchema),
  /**
   * The generative integration the agent says PRODUCED the artifact, lowercased on read-back
   * like {@link service}. Optional because a step may generate without a registered integration
   * (a model with native image output), and a claim of "no generator" is a different fact from
   * a claim naming one the deployment does not register — which is why an unrecognised id is
   * NAMED in the report rather than dropped.
   */
  generator: v.optional(v.string()),
  /**
   * What ran over the generated bytes AFTER the integration produced them and BEFORE they were
   * stored, in the agent's own words (`pixel-snapper`, `sharp resize`).
   *
   * A post-processing pass gives an artifact two producers, and {@link generator} can name only
   * one. Both single answers are wrong: naming the integration records a producer of something
   * that is not what is stored (the bytes are not the ones it returned, and neither are the
   * dimensions), and naming nothing loses the vendor attribution the field exists for, along with
   * the spend story behind it. So the delivery gets its own hole rather than a contested one.
   *
   * A FREE STRING rather than a registry reference, deliberately. A post-processor is not a
   * registered thing and must not become one: `binaryGeneratorCapabilitySchema` admits a member
   * only when it partitions an ENDPOINT's request, and a step's choice to snap a render onto a
   * pixel grid is a property of the WORK, whose home is the step's own prompt. There is nothing to
   * check this against, so it is recorded verbatim (capped) and judged by whoever reads the run,
   * exactly as `location` is. It gets no `unknownGenerators`-style report for the same reason.
   *
   * The same epistemic status as everything else the agent declares here, and the same third
   * state: ABSENT means "not stated", which is what every artifact recorded before this field
   * existed says, and is never evidence that nothing ran.
   */
  processedBy: v.optional(v.string()),
  /**
   * The CONTENT TYPE of the artifact, DERIVED in code from {@link contentType} — never read off
   * the model's prose. Absent when no media type was declared, or when the declared one is not
   * one the platform recognises: "we do not know what this is" and "this is not an image" are
   * different answers, and only the second could justify a warning.
   */
  modality: v.optional(binaryModalitySchema),
})
export type BinaryOutputArtifact = v.InferOutput<typeof binaryOutputArtifactSchema>

/**
 * What a settled binary-generating step DECLARED it stored, read back from the fenced
 * ```binary-outputs block of its reply (see kernel `parseBinaryOutputDeclaration`) and recorded
 * on the step (`PipelineStep.binaryOutputs`).
 *
 * Degrade-loudly bookkeeping, mirroring `foundationalServiceSelectionSchema`: an ABSENT field
 * means no binary-generating step settled (the step was skipped, or the run predates the
 * feature); `undeclared: true` means the step ran but its reply carried no declaration block at
 * all — a different failure from an empty `stored`, which is the agent explicitly reporting it
 * stored nothing. Every way entries were lost is COUNTED (`invalidEntries`, `omitted`,
 * `parseFailed`) rather than silently shortened, and a service id the catalog does not know is
 * NAMED in `unknownServices` while its entries are still retained verbatim in `stored` — the
 * platform records what the agent claimed; a reader judges it against the step's configured
 * target.
 */
export const binaryOutputReportSchema = v.object({
  stored: v.array(binaryOutputArtifactSchema),
  /** Distinct `service` ids named in entries that the resolved catalog does not contain. */
  unknownServices: v.array(v.string()),
  /**
   * Distinct `generator` ids named in entries that the deployment does not register. Kept apart
   * from {@link unknownServices} because they resolve against different registries and need
   * different fixes — a storage id points at the workspace's foundational catalog, a generator
   * id at the deployment's code. Entries are RETAINED either way: the platform records what the
   * agent claimed and a reader judges it.
   */
  unknownGenerators: v.array(v.string()),
  /**
   * Set when the deployment's registered integrations could not be READ at settlement, so no
   * claimed `generator` id could be checked against them (a mothership-mode node whose mothership
   * was unreachable). Its own field rather than an empty {@link unknownGenerators}, for the
   * reason that runs through this whole feature: "every id checked out" and "nothing could be
   * checked" are the same value and opposite facts, and only one of them is evidence. The
   * artifacts themselves — and the STORAGE half's verdict, which resolves against a different
   * catalog and is unaffected — are recorded either way, because what could be derived must be.
   */
  generatorsUnverified: v.optional(v.literal(true)),
  /** Entries dropped because they were not an object with `service` + `location` strings. */
  invalidEntries: v.number(),
  /** Valid entries dropped past the per-report cap. */
  omitted: v.number(),
  /** True when the block was present but its body was not `none` and not parseable JSON. */
  parseFailed: v.optional(v.boolean()),
  /** True when the reply carried no ```binary-outputs block at all. */
  undeclared: v.optional(v.boolean()),
})
export type BinaryOutputReport = v.InferOutput<typeof binaryOutputReportSchema>
