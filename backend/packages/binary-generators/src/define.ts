import type {
  BinaryGeneratorCapability,
  BinaryGeneratorCredential,
  BinaryGeneratorDefinition,
  UploadApiContract,
} from '@cat-factory/contracts'
import { binaryGeneratorDefinitionSchema } from '@cat-factory/contracts'
import { binaryGeneratorDetailIssues } from '@cat-factory/kernel'
import * as v from 'valibot'

// ---------------------------------------------------------------------------
// The DEFINITION SEAM: a generative binary integration written as code, checked here, and handed
// to an app-owned `BinaryGeneratorRegistry` by `index.ts`.
//
// Exported rather than kept private to this package, because the platform's own integrations and a
// deployment's are the same kind of thing and should be written the same way. The alternative is
// what actually happened downstream: a deployment reimplemented the boot checks against the same
// leaf helpers, in the same order, and wrote in its own comments that the copy "is a mirror and
// can drift". A rule the platform grows on its own schedule cannot be maintained by copy.
//
// Everything here is about failing EARLY. The engine validates registrations at boot
// (`collectRegistrationProblems`), but a boot failure is a deployment that rolls back, while a
// failure here is a test that never merged.
// ---------------------------------------------------------------------------

/**
 * A validated integration definition: structurally a {@link BinaryGeneratorDefinition} (exactly
 * what `BinaryGeneratorRegistry.register` takes), with the four optional COLLECTIONS settled so
 * consumers never branch on `undefined`.
 *
 * `accepts` is the one optional field left unsettled, and the asymmetry is deliberate: it is a
 * record of sets rather than a collection, and the platform reads an absent entry as "not stated"
 * while refusing an empty array inside one. Settling it would turn a definition that declares no
 * value sets into one that declares empty ones, which is the difference between "unjudged" and
 * "refuses everything".
 */
export interface BinaryGeneratorEntry extends BinaryGeneratorDefinition {
  mediaTypes: string[]
  capabilities: BinaryGeneratorCapability[]
  contracts: UploadApiContract[]
  credentials: BinaryGeneratorCredential[]
}

/** What {@link defineBinaryGenerator} accepts, before defaults are settled. */
export interface BinaryGeneratorInput {
  /** Lower-kebab slug a step names in `stepOptions.binaryOutput.generatorIds`. */
  id: string
  name: string
  /** One line; what the picker and the agent's brief show. */
  summary: string
  /** What it is good at, what it is NOT for, and its cost profile. */
  description: string
  /** The content types it produces. At least one. */
  modalities: readonly BinaryGeneratorDefinition['modalities'][number][]
  /** The concrete formats it emits, when the integration pins them down. */
  mediaTypes?: readonly string[]
  /**
   * What it can be ASKED FOR while generating: the per-step generation options a step may point
   * at it. Omitted (or empty) means "only the coarse facts are known": every option requirement
   * against it is reported as unverifiable rather than refused, which is what lets an integration
   * registered before this axis existed go on running unchanged.
   */
  capabilities?: readonly BinaryGeneratorCapability[]
  /**
   * For the options whose domain is a CLOSED SET, which values this endpoint takes. The axis
   * beside {@link capabilities} rather than part of it: that one says the request can CARRY the
   * value, this says the endpoint will take the one being asked for.
   *
   * Omitted per option means "not stated", and it is the right answer for an endpoint that renders
   * anything inside limits no list can enumerate: those belong in `guidance`. A set is a REFUSAL,
   * so declare one only where the endpoint genuinely has one.
   */
  accepts?: BinaryGeneratorDefinition['accepts']
  /** The API's base URL. `https` (or loopback) only: the credentials ride this request. */
  endpoint?: string
  /** Operating notes folded into the agent's brief verbatim. */
  guidance?: string
  /**
   * The credentials it authenticates with, by NAME. A list because a vendor account is not always
   * one string, and injection names must be distinct, which the schema refuses case-insensitively.
   */
  credentials?: readonly BinaryGeneratorCredential[]
  /** API contract documents, injected as `.cat-context/` files beside the brief. */
  contracts?: readonly UploadApiContract[]
}

/**
 * Validate an integration definition and freeze it.
 *
 * Two checks, and they are the SAME two the engine makes at boot rather than an approximation of
 * them. `binaryGeneratorDefinitionSchema` is the shape every write path shares, and
 * `binaryGeneratorDetailIssues` is the rule set a parse structurally cannot make (a cleartext
 * endpoint, a contract set that reads as garbage to the agent handed it, a media type whose
 * modality contradicts the declared ones, a harness with no generation tool, an accepted-value set
 * with no capability behind it). Calling them rather than restating them is the whole point of the
 * seam: a rule the platform adds fails this definition on the version bump instead of on the boot
 * that follows a deploy.
 *
 * What it does NOT check is the one thing no schema could: whether a declared capability is one the
 * registered CONTRACT can actually be asked for. That is a claim about a vendor's request body, so
 * it is pinned per integration in a test beside the document.
 */
export function defineBinaryGenerator(input: BinaryGeneratorInput): BinaryGeneratorEntry {
  const parsed = v.parse(binaryGeneratorDefinitionSchema, {
    ...input,
    modalities: [...input.modalities],
    mediaTypes: [...(input.mediaTypes ?? [])],
    capabilities: [...(input.capabilities ?? [])],
    credentials: (input.credentials ?? []).map((credential) => ({ ...credential })),
    contracts: (input.contracts ?? []).map((contract) => ({ ...contract })),
  })
  const issues = binaryGeneratorDetailIssues(parsed)
  if (issues.length > 0) {
    throw new Error(`Binary generator '${parsed.id}': ${issues.map((i) => i.message).join('; ')}`)
  }
  return Object.freeze({
    ...parsed,
    mediaTypes: parsed.mediaTypes ?? [],
    // Settled to an array like the two beside it, and settling it changes NOTHING about how it is
    // read: the coverage rule treats an empty capability list and an absent one as the same
    // documented state ("only the coarse facts are known"), and the registry's own projection
    // settles it to `[]` on the way to the engine either way.
    capabilities: parsed.capabilities ?? [],
    contracts: parsed.contracts ?? [],
    // Settled for the same reason `contracts` is: every reader here loops rather than branching on
    // one optional object, and a loop over `undefined` is the one shape that does not degrade
    // quietly. `accepts` is deliberately NOT settled beside these, since an empty object and an
    // absent one are the same fact there while an empty ARRAY inside one is refused, so
    // manufacturing one would invent a refusal nobody declared.
    credentials: parsed.credentials ?? [],
  })
}

/**
 * Turn an OpenAPI document written as a TypeScript object into the uploadable contract shape.
 *
 * The document stays a VALUE in source rather than a string, and this is the one place it becomes
 * the text the registry stores: a typo'd `operationId` or a parameter with no `in` is then a
 * compile error at the document, where `satisfies OpenAPIV3_1.Document` can see it.
 *
 * `document` is deliberately structural here rather than typed against `openapi-types`, which
 * would put that package in every consumer's type resolution for a helper that only serializes.
 * Two-space indentation because an agent reads the body verbatim.
 */
export function openApiContract(params: {
  contractId: string
  title: string
  document: Record<string, unknown>
}): UploadApiContract {
  return {
    contractId: params.contractId,
    format: 'openapi',
    title: params.title,
    body: `${JSON.stringify(params.document, null, 2)}\n`,
  }
}
