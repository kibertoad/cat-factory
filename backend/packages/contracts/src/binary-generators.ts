import * as v from 'valibot'
import { binaryModalitySchema, mediaTypeSchema } from './binary-modalities.js'
import { uploadApiContractSchema } from './foundational-services.js'

// ---------------------------------------------------------------------------
// Wire vocabulary for GENERATIVE BINARY INTEGRATIONS — the third-party (or in-house) APIs a
// binary-generating agent kind calls to PRODUCE its deliverable: an image generator, a
// music/speech generator, a video generator.
//
// This is the missing half of `binary-outputs.ts`. That module answers "where does a generated
// artifact GO" (a foundational service the org runs, carrying the `asset-storage` capability);
// this one answers "what MAKES it". The two are deliberately separate registries because they
// are separate facts about an org: the storage estate is shared infrastructure every designed
// system consumes, while a generation integration is a vendor a deployment buys and points at
// specific steps. Modelling a generator as a foundational service would put a metered vendor
// API into the catalog an Architect designs AGAINST, where it would be offered to every design
// step as something to build on.
//
// A generator is registered in a deployment's CODE, on the app-owned `BinaryGeneratorRegistry`
// (kernel), exactly as it registers agent kinds, gates, pipelines or its foundational estate —
// so it needs no table, no migration and no UI, and both runtime facades get identical
// behaviour by building the same registry.
// ---------------------------------------------------------------------------

const slug = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-z0-9][a-z0-9-]*$/, 'must be a lower-kebab slug'),
)

/**
 * A credential a generative integration needs, declared by NAME only — never a value.
 *
 * The value is resolved per dispatch through the facade-wired `ToolSecretResolver` port (the
 * same port a tool server's credentials go through) and written straight onto the job body,
 * where the harness injects it into THIS JOB's agent environment. It never reaches
 * `AgentRunContext`, a prompt, or the telemetry snapshot — only the key NAME does, because the
 * agent has to know which variable to read.
 */
export const binaryGeneratorCredentialSchema = v.object({
  /**
   * The credential's key. It is both what the secret resolver is asked for and the ENVIRONMENT
   * VARIABLE the agent reads it from, so it must be a valid POSIX variable name — a generator
   * declaring `x-rd-token` would resolve fine and then be dropped by the harness's env
   * validation, which is a silent "the integration just 401s" at run time.
   */
  key: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1),
    v.maxLength(128),
    v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be a valid environment variable name'),
  ),
  /**
   * How the integration expects the credential to be presented (`X-RD-Token: <value>`,
   * `Authorization: Bearer <value>`). Folded into the brief verbatim: the agent writes the
   * request itself, and a key with no stated header is a key it has to guess the use of.
   */
  usage: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(400))),
  /**
   * When true (the default), an integration whose credential does not resolve is reported to
   * the agent as UNAVAILABLE rather than offered. Set false only for an endpoint that genuinely
   * works unauthenticated — an agent handed an API whose first call 401s burns a run
   * discovering it.
   */
  required: v.optional(v.boolean()),
})
export type BinaryGeneratorCredential = v.InferOutput<typeof binaryGeneratorCredentialSchema>

/**
 * A generative binary integration a deployment registers in code.
 *
 * Shaped like a foundational service on purpose — identity, prose, and API contracts in the
 * SAME `uploadApiContractSchema` vocabulary — so one contract renderer serves both and a
 * deployment writes one kind of definition. What it adds is what a GENERATOR has and a shared
 * service does not: the content types it produces, and the credential it needs.
 */
export const binaryGeneratorDefinitionSchema = v.object({
  /** Stable id, referenced by a step's `stepOptions.binaryOutput.generatorIds`. */
  id: slug,
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  /** One line, shown in the picker and the agent's brief. */
  summary: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400)),
  /**
   * What it is good at and what it is NOT for — style, resolution/length limits, cost profile.
   * The half a model needs to pick between two registered generators of the same modality.
   */
  description: v.pipe(v.string(), v.trim(), v.maxLength(20_000)),
  /**
   * The content types it produces. At least one: a generator that produces nothing is not a
   * generator, and an empty list would make it match every step's requirements by vacuity.
   */
  modalities: v.pipe(v.array(binaryModalitySchema), v.minLength(1)),
  /**
   * The concrete media types it can emit (`image/png`, `audio/mpeg`), when the integration
   * pins them down. Absent ⇒ only the coarse {@link modalities} are known, which the brief
   * states as such rather than implying every format of that modality is available.
   */
  mediaTypes: v.optional(v.array(mediaTypeSchema)),
  /**
   * The API's base URL. Stated to the agent so it does not have to infer one from the contract,
   * and refused at registration unless it is `https` (or loopback) — the credential above rides
   * this request.
   */
  endpoint: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2048))),
  /** Human documentation, for whoever configures the step rather than for the agent. */
  docsUrl: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2048))),
  /**
   * Operating notes folded into the agent's brief verbatim — polling an async job, the shape of
   * a returned payload (base64 vs a signed URL), a rate limit worth respecting. This is where a
   * deployment puts the knowledge that would otherwise be discovered once per run.
   */
  guidance: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(20_000))),
  credential: v.optional(binaryGeneratorCredentialSchema),
  /**
   * The integration's API contract documents, in the same formats the foundational catalog
   * accepts. Injected as `.cat-context/` files beside the brief, so the agent calls the
   * operations the contract declares instead of inventing them.
   */
  contracts: v.optional(v.array(uploadApiContractSchema)),
})
export type BinaryGeneratorDefinition = v.InferOutput<typeof binaryGeneratorDefinitionSchema>

/**
 * The ways `definition` fails {@link binaryGeneratorDefinitionSchema}, as readable lines — empty
 * when it would be accepted.
 *
 * Exists for the same reason `foundationalServiceDefinitionIssues` does: the backend layers that
 * hold a deployment's CODE-registered definitions to this shape (kernel, orchestration's boot
 * validation) cannot depend on valibot, and re-stating the rules in a second place is how a
 * registration ends up accepted where an equivalent one is refused.
 */
export function binaryGeneratorDefinitionIssues(definition: unknown): string[] {
  const parsed = v.safeParse(binaryGeneratorDefinitionSchema, definition)
  if (parsed.success) return []
  return parsed.issues.map((issue) => {
    const path = issue.path?.map((segment) => String(segment.key)).join('.')
    return path ? `${path}: ${issue.message}` : issue.message
  })
}
