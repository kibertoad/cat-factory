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
 * the first resolution wins deterministically in selection order.
 */
export async function resolveBinaryGeneratorSecrets(
  input: ResolveBinaryGeneratorSecretsInput,
): Promise<GeneratorSecretJobSpec[]> {
  const generators = input.context.binaryGenerators ?? []
  const resolver = input.resolveToolSecrets
  if (!resolver || generators.length === 0) return []
  const secrets: GeneratorSecretJobSpec[] = []
  const seen = new Set<string>()
  for (const generator of generators) {
    const key = generator.credentialKey
    if (!key || seen.has(key)) continue
    seen.add(key)
    const resolved = await resolveOne(input, resolver, generator, key)
    if (resolved) secrets.push({ key, value: resolved })
  }
  return secrets
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
  input.logger?.warn(
    'binary-generator credential did not resolve; the agent is told the integration is unavailable',
    { binaryGeneratorId: generator.id, credentialKey: key },
  )
  return undefined
}
