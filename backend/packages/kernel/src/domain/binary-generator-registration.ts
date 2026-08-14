import {
  type BinaryGeneratorDefinition,
  binaryAcceptsWithoutCapability,
  credentialInjectionName,
  comparableCredentialInjectionName,
  modalitiesOfMediaType,
} from '@cat-factory/contracts'
import {
  BINARY_GENERATING_HARNESSES,
  harnessServesBinaryGeneration,
  isAllowedMcpHttpUrl,
} from './agent-capabilities.js'
import {
  describeFoundationalProblem,
  validateFoundationalDefinition,
} from './foundational-services.js'
import { isHarnessKind } from '../ports/model-provider.js'

// ---------------------------------------------------------------------------
// What a registered GENERATIVE BINARY INTEGRATION must satisfy beyond its parse, as pure rules.
//
// The parse itself is `binaryGeneratorDefinitionIssues` in `@cat-factory/contracts`, which is the
// shape every write path shares. The rules HERE are the ones a parse structurally cannot make,
// each needing something only kernel holds: the URL policy a credential-bearing endpoint is held
// to, the contract-set rules the catalog renderer imposes, the media-type classifier, the list of
// harnesses that carry a generation tool, and the capability↔accepted-value pairing.
//
// They live in kernel rather than in the boot validator that used to own them because they have
// TWO callers with the same question. `collectRegistrationProblems` asks it at boot, where the
// answer is a deployment that refuses to start; a definitions package asks it at AUTHORING time,
// where the answer is a test that never merged. A downstream package that cannot import the rule
// mirrors it instead (`@stefka/binary-generators` did, and says so in its own comments), and a
// mirror of a growing rule set is a copy that silently stops agreeing with the boot it is meant
// to predict.
//
// So this module owns the rules and nothing else: no severity, no problem taxonomy, no registry
// access. `@cat-factory/orchestration` maps each issue onto its `RegistrationProblem` shape (they
// are all errors, and the codes are these codes), and `@cat-factory/binary-generators`' authoring
// seam throws on the same list at import.
// ---------------------------------------------------------------------------

/**
 * The closed set of faults these rules report.
 *
 * A union rather than a bare string so a reader that branches on one (the boot validator's
 * message table, a test asserting the fault it provoked) fails to compile when a member is added
 * or renamed. The spellings are the boot-problem codes verbatim: an operator who searches for the
 * code an unreadable boot printed lands on the rule that emitted it.
 */
export type BinaryGeneratorRegistrationIssueCode =
  | 'insecure_binary_generator_endpoint'
  | 'binary_generator_invalid'
  | 'binary_generator_modality_mismatch'
  | 'binary_generator_unknown_harness'
  | 'binary_generator_accepts_without_capability'
  | 'binary_generator_injection_name_collision'

/** One fault, in the words the deployment reads at boot. */
export interface BinaryGeneratorRegistrationIssue {
  code: BinaryGeneratorRegistrationIssueCode
  message: string
}

/**
 * The per-definition rules a valid PARSE cannot make: the endpoint, the contract set, the media
 * types, the serving harness, and an accepted-value set with no capability behind it.
 *
 * Every one of them is silent at run time and expensive to discover there. A malformed contract
 * becomes an integration the brief describes with no operations; a cleartext endpoint puts the
 * declared credential on the wire from inside the run container; a media type that contradicts
 * the declared modalities makes the integration picked for one job and asked to do another; a
 * harness with no generation tool dispatches a step that produces nothing and reports it as a
 * model problem.
 *
 * Returns EVERY issue rather than the first, so one edit clears a definition instead of several
 * fix-and-retry rounds.
 */
export function binaryGeneratorDetailIssues(
  definition: BinaryGeneratorDefinition,
): BinaryGeneratorRegistrationIssue[] {
  const issues: BinaryGeneratorRegistrationIssue[] = []
  const invalid = (code: BinaryGeneratorRegistrationIssueCode, message: string): void => {
    issues.push({ code, message })
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
  // The transport's one rule that needs more than the definition: whether the named CLI actually
  // carries a generation tool. Here rather than in the contracts schema because kernel owns both
  // the harness list and which of them generate, and contracts (which kernel imports) can see
  // neither.
  //
  // Judged against the GENERATING harnesses rather than every harness this build runs, because the
  // two failures are indistinguishable downstream and both are silent: a definition naming `pi` or
  // `claude-code` passes every structural check, admission resolves the step's model to that same
  // CLI and admits it, the dispatch sets the generation flag, the runner ignores it, and the
  // agent's brief tells it to collect output from a staging directory nothing created. The run
  // then reports a model or vendor problem for what is one string in the deployment's own code.
  if (definition.harness && !harnessServesBinaryGeneration(definition.harness)) {
    const known = isHarnessKind(definition.harness)
    invalid(
      'binary_generator_unknown_harness',
      `Generative binary integration "${definition.id}" is served by harness ` +
        `"${definition.harness}", which ` +
        (known
          ? `this build runs but which carries no built-in generation tool`
          : `is not one this build runs`) +
        `. Only ${BINARY_GENERATING_HARNESSES.join(', ')} can serve a harness-transport ` +
        `integration; a step selecting this one would dispatch and produce nothing.`,
    )
  }
  // The same fault one axis finer: a declaration whose two halves contradict each other, where
  // every reader believes a different half. An `accepts` set states which values the endpoint
  // takes for an option its `capabilities` say it cannot be asked for at all, so the brief
  // renders the set as fact while admission refuses every step that asks, and the value rule
  // (judged over the capability's declarers) never sees the set at all. The accurate half is
  // unreachable, and the remedy is one capability on one definition: the deployment has already
  // written down that the endpoint has it.
  for (const { option, capability } of binaryAcceptsWithoutCapability(definition)) {
    invalid(
      'binary_generator_accepts_without_capability',
      `Generative binary integration "${definition.id}" states the values it accepts for ` +
        `\`${option}\` but does not declare the "${capability}" capability that option needs. ` +
        `A step asking for it is refused as unsupported, so the accepted set is never consulted ` +
        `while the agent's brief states it. Declare "${capability}", or drop the set if the ` +
        `endpoint genuinely takes no such parameter.`,
    )
  }
  return issues
}

/**
 * The one rule that spans DEFINITIONS: two integrations may not inject different values into one
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
 * Takes the definitions that PARSED. Reading a malformed one's credentials here would restate a
 * fault already reported as a second, more confusing one.
 */
export function binaryGeneratorInjectionCollisions(
  definitions: readonly BinaryGeneratorDefinition[],
): BinaryGeneratorRegistrationIssue[] {
  // Grouped by the COMPARABLE (case-folded) name and reported under the spelling the deployment
  // wrote, because `ACME_KEY` and `acme_key` are one variable wherever the environment is
  // case-insensitive and two everywhere else: the pair collides on exactly the platform where the
  // operator has the least chance of noticing.
  const claims = new Map<string, { spelling: string; byKey: Map<string, string[]> }>()
  for (const definition of definitions) {
    for (const credential of definition.credentials ?? []) {
      const comparable = comparableCredentialInjectionName(credential)
      const claim = claims.get(comparable) ?? {
        spelling: credentialInjectionName(credential),
        byKey: new Map<string, string[]>(),
      }
      claim.byKey.set(credential.key, [...(claim.byKey.get(credential.key) ?? []), definition.id])
      claims.set(comparable, claim)
    }
  }
  const issues: BinaryGeneratorRegistrationIssue[] = []
  for (const [, { spelling: envName, byKey }] of claims) {
    if (byKey.size < 2) continue
    const described = [...byKey]
      .map(([key, ids]) => `"${key}" (${ids.join(', ')})`)
      .sort()
      .join(' and ')
    issues.push({
      code: 'binary_generator_injection_name_collision',
      message:
        `Generative binary integrations disagree about environment variable "${envName}": it is ` +
        `declared for lookup keys ${described}. One variable cannot hold both values, so an agent ` +
        `told to read it for one integration would authenticate with the other's credential. Give ` +
        `one of them a distinct \`envName\`, or point both at the same lookup key if they really ` +
        `share an account.`,
    })
  }
  return issues
}
