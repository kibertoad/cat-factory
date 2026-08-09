import type {
  AgentRunContext,
  Logger,
  ResolvedBinaryGenerator,
  ResolvedBinaryGeneratorCredential,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  binaryCredentialInjectionName,
  comparableCredentialInjectionName,
  isReservedPlatformEnvKey,
  isToolchainEnvName,
  reservedEnvKeyMessage,
  toolchainEnvNameMessage,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// GENERATIVE BINARY INTEGRATIONS for one container dispatch: take the integrations the ENGINE
// resolved onto the run context (`stepOptions.binaryOutput.generatorIds`, resolved against the
// deployment's `BinaryGeneratorRegistry`), resolve each declared credential, and hand the values
// to the job body.
//
// The split mirrors tool servers exactly, for the same reason: WHICH integrations a step has is
// runtime-neutral engine state, while whether their credentials can be RESOLVED depends on the
// facade-wired `ToolSecretResolver`, which only this layer holds. And as with tool servers, the
// two channels stay apart — the prompt-facing half (what the agent is told about each
// integration, including the NAME of the variable its key arrives in) is the injected
// `.cat-context/binary-output/brief.md` the engine already rendered, and only the VALUES travel
// here, on a dedicated top-level body field the agent-context snapshot's allow-list omits.
//
// Nothing here reports an unresolvable credential to the agent, and that is deliberate rather
// than an omission: the brief already states, per integration, that an unset variable means the
// platform could not provide the key and the integration must not be called. The agent can SEE
// the variable; a second declaration from this side could only ever agree with the environment or
// contradict it.
// ---------------------------------------------------------------------------

/**
 * One `{ key, value }` env pair the harness injects into THIS JOB's agent process.
 *
 * `key` is the INJECTION name (`binaryCredentialInjectionName`), not necessarily what the resolver
 * was asked for. It has to be, because this is the variable the agent reads, and it is the same
 * name the brief tells it to read: both sides call that one helper so they cannot name different
 * variables.
 */
export interface GeneratorSecretJobSpec {
  key: string
  value: string
}

export interface ResolveBinaryGeneratorSecretsInput {
  context: AgentRunContext
  workspaceId: string
  blockId?: string
  /** Facade-wired; absent ⇒ nothing resolves, and the brief's "unset means unavailable" holds. */
  resolveToolSecrets?: ToolSecretResolver
  logger?: Logger
}

/**
 * Resolve the credentials of this dispatch's generative integrations into job-body env pairs.
 *
 * Never throws and never fails a dispatch: an integration whose key does not resolve simply
 * contributes no pair, which is exactly the state the agent's brief tells it to report. Failing
 * the run instead would turn a missing key — the most ordinary misconfiguration there is — into
 * a run that produces nothing and explains nothing, when a run that generates what it can and
 * NAMES the gap is strictly more useful.
 *
 * Every lookup an integration needs travels in ONE resolver call, which is the port's stated
 * contract (once per dispatch per subject) and not merely a saving: the per-workspace sealed-store
 * implementation re-reads and decrypts the whole workspace bag per call, so a key pair asked for
 * one name at a time pays that twice under an identical subject.
 *
 * Integrations are resolved CONCURRENTLY, since their subjects are genuinely different. Order is
 * preserved by resolving a pre-built plan rather than pushing as results arrive.
 */
export async function resolveBinaryGeneratorSecrets(
  input: ResolveBinaryGeneratorSecretsInput,
): Promise<GeneratorSecretJobSpec[]> {
  const generators = input.context.binaryGenerators ?? []
  const resolver = input.resolveToolSecrets
  if (!resolver || generators.length === 0) return []
  const plans = planLookups(input, generators)
  const resolved = await Promise.all(plans.map((plan) => resolveGenerator(input, resolver, plan)))
  return resolved.flat()
}

/** One credential to resolve, with both names settled and every floor already applied. */
interface PlannedCredential {
  credential: ResolvedBinaryGeneratorCredential
  key: string
  /** The variable the value is injected as, and the exact spelling the brief tells the agent. */
  envName: string
  /** The same name case-folded, which is the form a COLLISION between two of them is judged in. */
  comparableName: string
}

/** One integration's surviving credentials, which resolve together in a single call. */
interface GeneratorPlan {
  generator: ResolvedBinaryGenerator
  credentials: PlannedCredential[]
}

/**
 * Decide, before any I/O, exactly which lookup each integration gets to make.
 *
 * Planning is separate from resolving because two of the three rules below are about the dispatch
 * AS A WHOLE rather than about one credential, and a rule of that shape cannot be applied by a
 * function that sees one credential at a time.
 */
function planLookups(
  input: ResolveBinaryGeneratorSecretsInput,
  generators: readonly ResolvedBinaryGenerator[],
): GeneratorPlan[] {
  const admissible = generators.map((generator) => ({
    generator,
    credentials: generator.credentials
      .filter((credential) => passesEnvNameFloors(input, generator, credential))
      .map((credential) => ({
        credential,
        key: credential.key,
        envName: binaryCredentialInjectionName(credential),
        comparableName: comparableCredentialInjectionName(credential),
      })),
  }))
  const contested = contestedInjectionNames(input, admissible)
  const claimed = new Set<string>()
  return admissible.map(({ generator, credentials }) => ({
    generator,
    credentials: credentials.filter((planned) => {
      // Contest is judged on the CASE-FOLDED name, because two spellings of one variable collide
      // wherever the environment is case-insensitive. The dedupe below is judged on the exact
      // name, because that is the string the brief tells the agent to read: dropping `acme_key`
      // as a duplicate of `ACME_KEY` would leave a variable named in the brief and set nowhere on
      // every platform that keeps them apart.
      if (contested.has(planned.comparableName)) return false
      // A name already claimed by an earlier integration is the SHARED-ACCOUNT case and nothing
      // else, because a contested name was dropped above: the claimant looks the same value up
      // under the same key, so the variable this integration reads is already being set to
      // exactly what it wanted. Asking a second time would only duplicate the round trip.
      if (claimed.has(planned.envName)) return false
      claimed.add(planned.envName)
      return true
    }),
  }))
}

/**
 * The injection names two integrations want to mean DIFFERENT values, withheld from both.
 *
 * One vendor behind an image and a music endpoint legitimately shares a variable, and that case is
 * indistinguishable from a collision by the NAME alone: what separates them is whether the lookup
 * key behind the name is the same value. Where it is not, no arbitration can be right. Serving the
 * first claimant sets the variable the SECOND integration's brief tells the agent to read, so the
 * agent authenticates one vendor with another's key, and every layer that could report it sees a
 * variable that is present and a call that failed. A pair loses a half the same way, with the
 * brief still telling the agent the two names belong together.
 *
 * So the value is withheld from everyone, which is the one disposition the brief already describes
 * truthfully: an unset variable means the platform could not provide the credential, and both
 * integrations are reported unavailable rather than one being quietly wrong. Registration refuses
 * this across a deployment's definitions (`binary_generator_injection_name_collision`); reaching
 * here means a MOTHERSHIP node was served definitions it never boot-validated.
 */
function contestedInjectionNames(
  input: ResolveBinaryGeneratorSecretsInput,
  admissible: readonly GeneratorPlan[],
): ReadonlySet<string> {
  // Keyed by the case-folded name and reported under the spelling that reached the dispatch: two
  // integrations declaring `ACME_KEY` and `acme_key` for different keys are one variable on a
  // case-insensitive environment, which is where the wrong value would be read.
  const byName = new Map<string, { spelling: string; keys: Set<string>; generatorIds: string[] }>()
  for (const { generator, credentials } of admissible) {
    for (const planned of credentials) {
      const entry = byName.get(planned.comparableName) ?? {
        spelling: planned.envName,
        keys: new Set<string>(),
        generatorIds: [],
      }
      entry.keys.add(planned.key)
      if (!entry.generatorIds.includes(generator.id)) entry.generatorIds.push(generator.id)
      byName.set(planned.comparableName, entry)
    }
  }
  const contested = new Set<string>()
  for (const [comparableName, entry] of byName) {
    if (entry.keys.size < 2) continue
    contested.add(comparableName)
    input.logger?.warn(
      'binary-generators disagree about what one injected variable holds; withholding it from all of them',
      {
        credentialEnvName: entry.spelling,
        binaryGeneratorIds: entry.generatorIds,
        credentialKeys: [...entry.keys],
      },
    )
  }
  return contested
}

/**
 * The two name floors, applied per credential.
 *
 * Both are re-applied HERE rather than trusted from registration so they hold whatever a facade
 * wired, and because a MOTHERSHIP-MODE node boot-validates none of the definitions it resolves:
 * they arrive per dispatch over `/internal/binary-generators`, chosen by a process that is not
 * this one, and the environment they would be read from is a developer's own laptop.
 */
function passesEnvNameFloors(
  input: ResolveBinaryGeneratorSecretsInput,
  generator: ResolvedBinaryGenerator,
  credential: ResolvedBinaryGeneratorCredential,
): boolean {
  // The platform's own configuration variables are never resolvable as an integration credential.
  // Only the LOOKUP key is held to it. The injection name reads nothing, so it gets the toolchain
  // rule below instead, which is what lets an integration keep a vendor's documented variable name
  // even when a platform prefix family covers it.
  if (isReservedPlatformEnvKey(credential.key)) {
    // Reported at WARN, not at the `debug` an optional missing key gets: this is never a
    // deployment's stated normal, and its fix is a declaration rather than a variable to set.
    input.logger?.warn(
      'binary-generator declares a reserved credential key; the agent is told the integration is unavailable',
      {
        binaryGeneratorId: generator.id,
        credentialKey: credential.key,
        detail: reservedEnvKeyMessage(credential.key),
      },
    )
    return false
  }
  // A value injected under a toolchain name reconfigures the agent's process instead of
  // authenticating a call. Registration refuses one; this is the mothership case again.
  const envName = binaryCredentialInjectionName(credential)
  if (isToolchainEnvName(envName)) {
    input.logger?.warn(
      'binary-generator declares a toolchain injection name; the agent is told the integration is unavailable',
      {
        binaryGeneratorId: generator.id,
        credentialEnvName: envName,
        detail: toolchainEnvNameMessage(envName),
      },
    )
    return false
  }
  return true
}

/** Resolve one integration's whole credential set in a single call, in declaration order. */
async function resolveGenerator(
  input: ResolveBinaryGeneratorSecretsInput,
  resolver: ToolSecretResolver,
  plan: GeneratorPlan,
): Promise<GeneratorSecretJobSpec[]> {
  if (plan.credentials.length === 0) return []
  // Distinct LOOKUP keys, because one stored value delivered under two injection names is an
  // allowed declaration and asking for the same key twice in one call is not.
  const keys = [...new Set(plan.credentials.map((planned) => planned.key))].map((key) => ({ key }))
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'resolve binary-generator credentials',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: { kind: 'binary-generator', id: plan.generator.id },
        // The credentials are declared with no `header`, so the default env-var channel applies.
        // An integration is called by the AGENT's own code, not by a client we configure, so a
        // header template would be a shape nothing here could act on. `required` rides the
        // declaration for the BRIEF's benefit, not this resolver's: the disposition for a missing
        // key is stated to the agent, never enforced by dropping something silently here.
        keys,
      }),
    { binaryGeneratorId: plan.generator.id },
  )
  const pairs: GeneratorSecretJobSpec[] = []
  for (const planned of plan.credentials) {
    const value = resolved?.[planned.key]
    if (value) {
      pairs.push({ key: planned.envName, value })
      continue
    }
    reportUnresolved(input, plan.generator, planned)
  }
  return pairs
}

/**
 * An unresolved credential reported at the severity its DECLARATION earns.
 *
 * The two cases need different reactions and a single severity would train an operator to ignore
 * both. A required key that did not resolve is a misconfiguration that will cost this step its
 * integration; an optional one is a state the deployment declared as normal, so reporting it as a
 * warning would be crying wolf about a working endpoint.
 */
function reportUnresolved(
  input: ResolveBinaryGeneratorSecretsInput,
  generator: ResolvedBinaryGenerator,
  planned: PlannedCredential,
): void {
  if (planned.credential.required === false) {
    input.logger?.debug(
      'binary-generator optional credential did not resolve; the agent is told to call it without that value',
      { binaryGeneratorId: generator.id, credentialKey: planned.key },
    )
    return
  }
  input.logger?.warn(
    'binary-generator credential did not resolve; the agent is told the integration is unavailable',
    { binaryGeneratorId: generator.id, credentialKey: planned.key },
  )
}
