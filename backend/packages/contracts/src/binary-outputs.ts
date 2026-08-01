import * as v from 'valibot'

// Wire vocabulary for BINARY-OUTPUT agent steps (docs/initiatives/binary-output-foundational-storage.md):
// a step whose kind GENERATES binary artifacts (image generation is the canonical example) and
// stores them through a FOUNDATIONAL SERVICE the step selected from the workspace's catalog —
// never through the platform's own artifact store, which holds run evidence (screenshots), not
// product deliverables. The step may also select further catalog services as generation CONTEXT
// (an inventory service that can say which entities exist, which lack an asset, and how each is
// described), whose API contracts are injected beside the storage service's.

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
   * catalog and carry the `binary-storage` capability tag — storing product assets in the
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
})
export type BinaryOutputConfig = v.InferOutput<typeof binaryOutputConfigSchema>

/** One stored artifact a binary-generating step declared in its reply's machine-read block. */
export const binaryOutputArtifactSchema = v.object({
  /** The foundational-service id the agent says it stored the artifact through. */
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
