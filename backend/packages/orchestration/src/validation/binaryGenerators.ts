import type { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import {
  describeFoundationalProblem,
  isAllowedMcpHttpUrl,
  validateFoundationalDefinition,
} from '@cat-factory/kernel'
import {
  type BinaryGeneratorDefinition,
  binaryGeneratorCredentialEnvName,
  binaryGeneratorDefinitionIssues,
  modalitiesOfMediaType,
} from '@cat-factory/contracts'
import type { RegistrationProblem } from './registrationProblem.js'

// ---------------------------------------------------------------------------
// Boot-time validation of the deployment's registered GENERATIVE BINARY INTEGRATIONS, split out of
// `validateRegistrations.ts` when that file hit its size ratchet. One registry's checks, reachable
// only through `collectRegistrationProblems`, so the split costs a reader nothing: everything about
// this registry's boot rules is now in one place rather than one section of fourteen.
// ---------------------------------------------------------------------------

/**
 * Section 9 of {@link collectRegistrationProblems}: every generative binary integration a
 * deployment registers must be a definition the platform can actually dispatch against.
 *
 * Boot is the only place these can be caught. There is no write boundary that ever refused them
 * (they are code), and every failure below is silent at run time in the same expensive way: a
 * malformed definition or an unparseable contract becomes an integration the brief describes with
 * no operations, a credential key that is not a valid environment-variable name is dropped by the
 * harness's env validation and reappears as an unexplained 401 mid-run, and a cleartext endpoint
 * puts that credential on the wire from inside the run container. Each of those costs a run to
 * discover and names nothing that points back at the registration.
 *
 * A declared MEDIA TYPE that contradicts the declared modalities is an error too, not a warning:
 * both halves drive selection (a step's content-type coverage is checked against `modalities`,
 * while the brief tells the agent the `mediaTypes`), so an integration claiming `audio` while
 * listing `image/png` will be picked for one job and asked to do the other.
 */
export function checkBinaryGenerators(
  registry: BinaryGeneratorRegistry | undefined,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  if (!registry) return problems
  const valid: BinaryGeneratorDefinition[] = []
  for (const definition of registry.all()) {
    const issues = binaryGeneratorDefinitionIssues(definition)
    if (issues.length > 0) {
      problems.push({
        severity: 'error',
        code: 'binary_generator_invalid',
        message: `Generative binary integration "${definition.id}" is not a valid definition: ${issues.join('; ')}`,
      })
      // The checks below read fields this parse just called malformed, so reporting them too
      // would restate one fault as several.
      continue
    }
    valid.push(definition)
    problems.push(...checkBinaryGeneratorDetails(definition))
  }
  problems.push(...checkBinaryGeneratorCredentialNames(valid))
  return problems
}

/**
 * Two integrations that would inject a credential under ONE environment variable.
 *
 * The definition schema already refuses this WITHIN one definition, where both values are
 * certainly wanted at once. Across two it is a latent version of the same fault: an agent process
 * has one variable per name, and the credential resolver is scoped per integration by design
 * (`ToolSecretSubject` exists so a per-workspace store can hold a different secret per subject
 * under one key name), so the second integration cannot be handed its own value there. A step
 * selecting both gets the first integration's credentials and NONE of the second's, which
 * `planBinaryGeneratorCredentials` settles at dispatch and states in the agent's brief.
 *
 * A WARNING rather than an error, on the reasoning `tool_servers_over_budget` uses: nothing is
 * broken until a step selects both, and the dispatch degrades honestly when one does. What boot
 * adds is the only place the DECLARATIONS can be named together, since the two are routinely
 * registered by different packages neither of which is wrong on its own. The remedy costs nothing:
 * a distinct `envName` on one of them, which may keep the same lookup `key`, so a shared vendor
 * account still resolves from a single deployment variable.
 */
function checkBinaryGeneratorCredentialNames(
  definitions: readonly BinaryGeneratorDefinition[],
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  // Case-INSENSITIVE, matching the within-definition rule: environment lookup is case-insensitive
  // on Windows, so `ACME_KEY` and `acme_key` are one variable on a developer's laptop.
  const claimedBy = new Map<string, string>()
  for (const definition of definitions) {
    for (const credential of definition.credentials ?? []) {
      const envName = binaryGeneratorCredentialEnvName(credential)
      const owner = claimedBy.get(envName.toUpperCase())
      if (owner === undefined) {
        claimedBy.set(envName.toUpperCase(), definition.id)
        continue
      }
      problems.push({
        severity: 'warn',
        code: 'binary_generator_credential_name_collision',
        message:
          `Generative binary integrations "${owner}" and "${definition.id}" both inject a ` +
          `credential as the environment variable "${envName}". A step that selects both can only ` +
          `be given one value under that name, so "${owner}" is authenticated and "${definition.id}" ` +
          `is dispatched with none of its credentials at all. Give one of them a distinct ` +
          `credential envName; they may keep the same lookup key.`,
      })
    }
  }
  return problems
}

/** The per-definition checks a valid PARSE cannot make: the endpoint, contracts, media types. */
function checkBinaryGeneratorDetails(definition: BinaryGeneratorDefinition): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const invalid = (code: string, message: string): void => {
    problems.push({ severity: 'error', code, message })
  }
  // The same rule an HTTP tool server's URL is held to, and for the same reason the helper
  // states: a declared credential rides this request, so cleartext off loopback puts it on the
  // wire. (The helper is MCP-named because that was its first caller; the rule is not.)
  if (definition.endpoint && !isAllowedMcpHttpUrl(definition.endpoint)) {
    invalid(
      'insecure_binary_generator_endpoint',
      `Generative binary integration "${definition.id}" has endpoint "${definition.endpoint}". Its ` +
        `credential is sent with every request, so the endpoint must be https (plain http is ` +
        `accepted only on loopback).`,
    )
  }
  for (const problem of validateFoundationalDefinition({ contracts: definition.contracts })) {
    invalid(
      'binary_generator_invalid',
      `Generative binary integration "${definition.id}": ${describeFoundationalProblem(problem)}`,
    )
  }
  const declared = new Set(definition.modalities)
  for (const mediaType of definition.mediaTypes ?? []) {
    const consistent = modalitiesOfMediaType(mediaType)
    // An UNRECOGNISED media type is not a fault: the platform's classifier is not a registry of
    // every format that exists, and refusing one would make registering a new codec impossible.
    // A recognised one that CONTRADICTS the declaration is, because both drive selection.
    //
    // Contradiction is an empty INTERSECTION, not an absent member, and for 3D that is the whole
    // difference: a `.glb` is consistent with both `3d-model` and `3d-scene` because the container
    // does not record which it holds, so requiring every member would refuse a scene generator
    // for declaring the only format it can emit.
    if (consistent.length > 0 && !consistent.some((modality) => declared.has(modality))) {
      const names = consistent.join('/')
      invalid(
        'binary_generator_modality_mismatch',
        `Generative binary integration "${definition.id}" declares media type "${mediaType}" ` +
          `(${names}) but lists none of those among its modalities ` +
          `(${definition.modalities.join(', ')}). A step selecting it for ${names} would be ` +
          `refused, and one selecting it for the listed modalities would be told it can emit this.`,
      )
    }
  }
  return problems
}
