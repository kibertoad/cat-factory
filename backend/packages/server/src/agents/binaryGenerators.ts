import type {
  AgentRunContext,
  Logger,
  ResolvedBinaryGenerator,
  ResolvedBinaryGeneratorCredential,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import {
  binaryGeneratorCredentialEnvName,
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
 * `key` is the INJECTION name (`envName`, else the lookup key), not necessarily what the resolver
 * was asked for. It has to be, because this is the variable the agent reads, and it is the same
 * name the brief tells it to read.
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

/** One credential that survived the floors, with the name it will be injected under. */
interface WantedCredential {
  credential: ResolvedBinaryGeneratorCredential
  envName: string
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
 * An integration may declare SEVERAL credentials (an API key and the secret it is Basic-paired
 * with, a key and the account id it is scoped to), and they are resolved in ONE call per
 * integration rather than one per value: the port takes a list precisely so a per-workspace
 * sealed store is asked once, and a call per credential inside a loop over an integration's list
 * is the N+1 the port's shape exists to prevent. Each value stands or falls on its own, and the
 * JOINT disposition (a pair with one half missing must not be sent at all) is the brief's, not
 * this resolver's, because only the agent can see what arrived.
 *
 * Deduplicated by INJECTION NAME: two integrations sharing one credential variable (a vendor with
 * an image and a music endpoint behind one account is the obvious case) must not fight over the
 * value, and the first declaration wins deterministically in selection order.
 *
 * The dedupe is decided BEFORE any resolution (the names are on the projection), so the surviving
 * lookups are independent and run CONCURRENTLY — a per-workspace sealed-store resolver is a real
 * round trip, and a step holding three integrations should not pay for three of them in series.
 * Order is preserved by resolving a pre-built list rather than pushing as results arrive.
 */
export async function resolveBinaryGeneratorSecrets(
  input: ResolveBinaryGeneratorSecretsInput,
): Promise<GeneratorSecretJobSpec[]> {
  const generators = input.context.binaryGenerators ?? []
  const resolver = input.resolveToolSecrets
  if (!resolver || generators.length === 0) return []
  // Deduplicated on the INJECTION name rather than the lookup key, because that name is what the
  // job body is keyed by: two integrations that resolve different keys into one variable would
  // otherwise both emit it and the last would silently win. Deduping here also covers the ordinary
  // shared-account case (one vendor behind an image and a music endpoint), since a shared lookup
  // key with no `envName` shares its injection name too.
  const seen = new Set<string>()
  const wanted = generators.map((generator) => ({
    generator,
    credentials: (generator.credentials ?? []).flatMap((credential) => {
      const envName = binaryGeneratorCredentialEnvName(credential)
      if (seen.has(envName) || !passesEnvNameFloors(input, generator, credential, envName))
        return []
      seen.add(envName)
      return [{ credential, envName }]
    }),
  }))
  const resolved = await Promise.all(
    wanted.map(async ({ generator, credentials }) =>
      credentials.length === 0 ? [] : resolveFor(input, resolver, generator, credentials),
    ),
  )
  return resolved.flat()
}

/**
 * The two name floors, applied BEFORE the resolver is asked and reported at the severity a
 * declaration earns. A credential that fails one contributes nothing, exactly as an unresolvable
 * one does, so the brief's "an unset variable means the platform could not provide it" stays the
 * single story the agent is told.
 *
 * Both checks live HERE rather than inside the env-backed default resolver so they hold whatever
 * a facade wired. Boot validation refuses such a declaration through the credential schema, but a
 * MOTHERSHIP-MODE node boot-validates none of the definitions it resolves: they arrive per
 * dispatch over `/internal/binary-generators`, chosen by a process that is not this one, and the
 * environment they would be read from is a developer's own laptop.
 */
function passesEnvNameFloors(
  input: ResolveBinaryGeneratorSecretsInput,
  generator: ResolvedBinaryGenerator,
  credential: ResolvedBinaryGeneratorCredential,
  envName: string,
): boolean {
  // Only the LOOKUP key is held to the platform floor. The injection name reads nothing, so it
  // gets the toolchain rule below instead, which is what lets an integration keep a vendor's
  // documented variable name even when a platform prefix family covers it.
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

/** One resolver call for one integration's whole credential list, mapped to injection names. */
async function resolveFor(
  input: ResolveBinaryGeneratorSecretsInput,
  resolver: ToolSecretResolver,
  generator: ResolvedBinaryGenerator,
  wanted: WantedCredential[],
): Promise<GeneratorSecretJobSpec[]> {
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'resolve binary-generator credentials',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: { kind: 'binary-generator', id: generator.id },
        // The credentials are declared with no `header`, so the default env-var channel applies —
        // an integration is called by the AGENT's own code, not by a client we configure, so a
        // header template would be a shape nothing here could act on. `required` rides the
        // declaration for the BRIEF's benefit, not this resolver's: the disposition for a missing
        // key is stated to the agent, never enforced by dropping something silently here.
        keys: wanted.map(({ credential }) => ({ key: credential.key })),
      }),
    { binaryGeneratorId: generator.id },
  )
  return wanted.flatMap(({ credential, envName }) => {
    const value = resolved?.[credential.key]
    if (value) return [{ key: envName, value }]
    // An unresolved credential is reported at the severity its DECLARATION earns, because the two
    // cases need different reactions and a single severity would train an operator to ignore both.
    // A required key that did not resolve is a misconfiguration that will cost this step its
    // integration; an optional one is a state the deployment declared as normal, so reporting it
    // as a warning would be crying wolf about a working endpoint.
    if (credential.required === false) {
      input.logger?.debug(
        'binary-generator optional credential did not resolve; the agent is told to call it unauthenticated',
        { binaryGeneratorId: generator.id, credentialKey: credential.key },
      )
      return []
    }
    input.logger?.warn(
      'binary-generator credential did not resolve; the agent is told the integration is unavailable',
      { binaryGeneratorId: generator.id, credentialKey: credential.key },
    )
    return []
  })
}
