import type { BinaryGeneratorRegistry } from '@cat-factory/kernel'
import {
  describeFoundationalProblem,
  isAllowedMcpHttpUrl,
  validateFoundationalDefinition,
} from '@cat-factory/kernel'
import {
  type BinaryGeneratorDefinition,
  binaryCredentialInjectionName,
  binaryGeneratorDefinitionIssues,
  comparableCredentialInjectionName,
  modalitiesOfMediaType,
} from '@cat-factory/contracts'
// Type-only, so the pairing with the module this section was extracted from stays a compile-time
// fact and no import cycle exists at runtime.
import type { RegistrationProblem } from './validateRegistrations.js'

/**
 * Section 9 of `collectRegistrationProblems`: every generative binary integration a deployment
 * registers must be a definition the platform can actually dispatch against.
 *
 * Its own module rather than more of `validateRegistrations.ts` because the section is a cohesive
 * concern with a growing rule set, and its host had reached the file-size ratchet.
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
  problems.push(...checkInjectionNameCollisions(valid))
  return problems
}

/**
 * The one check that spans DEFINITIONS: two integrations may not inject different values into one
 * environment variable.
 *
 * Within a definition the schema already refuses a repeated injection name. Across definitions the
 * same name is legitimate and common, because one vendor behind an image endpoint and a music
 * endpoint is one account: what makes that case safe is that both look the value up under the SAME
 * key, so whichever integration is resolved first sets the variable to exactly what the other
 * wanted. Different keys behind one name is the opposite, and there is no arbitration that makes
 * it right. Serving the first claimant sets the variable the second integration's brief tells the
 * agent to read, so the agent authenticates one vendor with another's key; withholding it (what
 * dispatch does, since a mothership node validates nothing) costs both integrations every run.
 *
 * Neither outcome is what the deployment meant, and the remedy is one `envName` on one definition,
 * which is why this is an error at boot rather than a warning nobody acts on. Only definitions
 * that PARSED are compared: a malformed one has already been reported, and reading its credentials
 * here would restate that fault as a second, more confusing one.
 */
function checkInjectionNameCollisions(
  definitions: readonly BinaryGeneratorDefinition[],
): RegistrationProblem[] {
  // Grouped by the COMPARABLE (case-folded) name and reported under the spelling the deployment
  // wrote, because `ACME_KEY` and `acme_key` are one variable wherever the environment is
  // case-insensitive and two everywhere else: the pair collides on exactly the platform where the
  // operator has the least chance of noticing.
  const claims = new Map<string, { spelling: string; byKey: Map<string, string[]> }>()
  for (const definition of definitions) {
    for (const credential of definition.credentials ?? []) {
      const claim = claims.get(comparableCredentialInjectionName(credential)) ?? {
        spelling: binaryCredentialInjectionName(credential),
        byKey: new Map<string, string[]>(),
      }
      claim.byKey.set(credential.key, [...(claim.byKey.get(credential.key) ?? []), definition.id])
      claims.set(comparableCredentialInjectionName(credential), claim)
    }
  }
  const problems: RegistrationProblem[] = []
  for (const [, { spelling: envName, byKey }] of claims) {
    if (byKey.size < 2) continue
    const described = [...byKey]
      .map(([key, ids]) => `"${key}" (${ids.join(', ')})`)
      .sort()
      .join(' and ')
    problems.push({
      severity: 'error',
      code: 'binary_generator_injection_name_collision',
      message:
        `Generative binary integrations disagree about environment variable "${envName}": it is ` +
        `declared for lookup keys ${described}. One variable cannot hold both values, so an agent ` +
        `told to read it for one integration would authenticate with the other's credential. Give ` +
        `one of them a distinct \`envName\`, or point both at the same lookup key if they really ` +
        `share an account.`,
    })
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
