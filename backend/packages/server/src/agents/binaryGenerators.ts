import type {
  AgentRunContext,
  Logger,
  ResolvedBinaryGenerator,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'

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

/** One `{ key, value }` env pair the harness injects into THIS JOB's agent process. */
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
 * Deduplicated by KEY: two integrations sharing one credential variable (a vendor with an image
 * and a music endpoint behind one account is the obvious case) must not fight over the value, and
 * the first declaration wins deterministically in selection order.
 *
 * The dedupe is decided BEFORE any resolution (the key name is on the projection), so the surviving
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
  const seen = new Set<string>()
  const wanted = generators.flatMap((generator) => {
    const key = generator.credentialKey
    if (!key || seen.has(key)) return []
    seen.add(key)
    return [{ generator, key }]
  })
  const resolved = await Promise.all(
    wanted.map(async ({ generator, key }) => {
      const value = await resolveOne(input, resolver, generator, key)
      return value === undefined ? null : { key, value }
    }),
  )
  return resolved.filter((entry): entry is GeneratorSecretJobSpec => entry !== null)
}

async function resolveOne(
  input: ResolveBinaryGeneratorSecretsInput,
  resolver: ToolSecretResolver,
  generator: ResolvedBinaryGenerator,
  key: string,
): Promise<string | undefined> {
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'resolve binary-generator credential',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: { kind: 'binary-generator', id: generator.id },
        // The credential is declared with no `header`, so the default env-var channel applies —
        // an integration is called by the AGENT's own code, not by a client we configure, so a
        // header template would be a shape nothing here could act on. `required` rides the
        // declaration for the BRIEF's benefit, not this resolver's: the disposition for a missing
        // key is stated to the agent, never enforced by dropping something silently here.
        keys: [{ key }],
      }),
    { binaryGeneratorId: generator.id },
  )
  const value = resolved?.[key]
  if (value) return value
  // An unresolved credential is reported at the severity its DECLARATION earns, because the two
  // cases need different reactions and a single severity would train an operator to ignore both.
  // A required key that did not resolve is a misconfiguration that will cost this step its
  // integration; an optional one is a state the deployment declared as normal, so reporting it as
  // a warning would be crying wolf about a working endpoint.
  if (generator.credentialRequired === false) {
    input.logger?.debug(
      'binary-generator optional credential did not resolve; the agent is told to call it unauthenticated',
      { binaryGeneratorId: generator.id, credentialKey: key },
    )
    return undefined
  }
  input.logger?.warn(
    'binary-generator credential did not resolve; the agent is told the integration is unavailable',
    { binaryGeneratorId: generator.id, credentialKey: key },
  )
  return undefined
}
