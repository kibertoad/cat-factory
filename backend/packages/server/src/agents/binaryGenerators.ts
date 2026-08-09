import type {
  AgentRunContext,
  BinaryGeneratorCredentialPlan,
  Logger,
  ResolvedBinaryGeneratorCredential,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { noopLogger, planBinaryGeneratorCredentials, runBestEffort } from '@cat-factory/kernel'
import { reservedEnvKeyMessage, toolchainEnvNameMessage } from '@cat-factory/contracts'

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
//
// Which holds only because the brief and this file decide DELIVERABILITY from one computation
// (kernel's `planBinaryGeneratorCredentials`). The one case where an unset variable is not the
// story is an injection name two integrations declare: there the loser's variable is SET, with the
// winner's secret in it, so the brief has to name it as poisoned rather than absent. That is
// exactly why the rule may not be re-derived here.
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

/** One integration's credentials as kernel's shared plan settles them for this dispatch. */
type GeneratorPlan = BinaryGeneratorCredentialPlan<ResolvedBinaryGeneratorCredential>

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
 * WHICH credentials are deliverable at all is decided by kernel's `planBinaryGeneratorCredentials`
 * rather than here, because the BRIEF decides it too and the two must agree exactly: it applies
 * the name floors and settles injection-name conflicts across the whole selection. See that
 * function for why a conflict withholds an integration's whole set. Nothing in this file may
 * re-derive either rule; a second copy is how the brief and the environment drift into naming
 * different variables.
 *
 * The plan is built BEFORE any resolution (it reads only names, which are on the projection), so
 * the surviving lookups are independent and run CONCURRENTLY: a per-workspace sealed-store
 * resolver is a real round trip, and a step holding three integrations should not pay for three of
 * them in series. Order is preserved by resolving a pre-built list rather than pushing as results
 * arrive.
 */
export async function resolveBinaryGeneratorSecrets(
  input: ResolveBinaryGeneratorSecretsInput,
): Promise<GeneratorSecretJobSpec[]> {
  const generators = input.context.binaryGenerators ?? []
  const resolver = input.resolveToolSecrets
  if (!resolver || generators.length === 0) return []
  const plans = planBinaryGeneratorCredentials(generators)
  for (const plan of plans) reportWithheldCredentials(input, plan)
  const resolved = await Promise.all(
    plans.map(async (plan) =>
      plan.injectable.length === 0 ? [] : resolveFor(input, resolver, plan),
    ),
  )
  return resolved.flat()
}

/**
 * What the operator is told about a credential the plan withheld, at the severity its cause earns.
 *
 * Every case here is a DECLARATION defect rather than an unset variable, so each is a `warn` and
 * each names the fix in the deployment's own code. None is reported to the agent from this side:
 * the brief already states what a withheld credential means for the integration it belongs to,
 * and a second declaration from here could only agree with the environment or contradict it.
 */
function reportWithheldCredentials(
  input: ResolveBinaryGeneratorSecretsInput,
  plan: GeneratorPlan,
): void {
  for (const { credential, envName, reason } of plan.refused) {
    if (reason === 'reserved_key') {
      input.logger?.warn(
        'binary-generator declares a reserved credential key; the agent is told the integration is unavailable',
        {
          binaryGeneratorId: plan.generatorId,
          credentialKey: credential.key,
          detail: reservedEnvKeyMessage(credential.key),
        },
      )
      continue
    }
    input.logger?.warn(
      'binary-generator declares a toolchain injection name; the agent is told the integration is unavailable',
      {
        binaryGeneratorId: plan.generatorId,
        credentialEnvName: envName,
        detail: toolchainEnvNameMessage(envName),
      },
    )
  }
  for (const conflict of plan.conflicts) {
    input.logger?.warn(
      'binary-generator credential name is already claimed on this step; none of its credentials is injected',
      {
        binaryGeneratorId: plan.generatorId,
        credentialEnvName: conflict.envName,
        claimedBy: conflict.claimedBy,
      },
    )
  }
}

/** One resolver call for one integration's whole credential list, mapped to injection names. */
async function resolveFor(
  input: ResolveBinaryGeneratorSecretsInput,
  resolver: ToolSecretResolver,
  plan: GeneratorPlan,
): Promise<GeneratorSecretJobSpec[]> {
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'resolve binary-generator credentials',
    () =>
      resolver.resolve({
        workspaceId: input.workspaceId,
        ...(input.blockId ? { blockId: input.blockId } : {}),
        subject: { kind: 'binary-generator', id: plan.generatorId },
        // The credentials are declared with no `header`, so the default env-var channel applies —
        // an integration is called by the AGENT's own code, not by a client we configure, so a
        // header template would be a shape nothing here could act on. `required` rides the
        // declaration for the BRIEF's benefit, not this resolver's: the disposition for a missing
        // key is stated to the agent, never enforced by dropping something silently here.
        keys: plan.injectable.map(({ credential }) => ({ key: credential.key })),
      }),
    { binaryGeneratorId: plan.generatorId },
  )
  return plan.injectable.flatMap(({ credential, envName }) => {
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
        { binaryGeneratorId: plan.generatorId, credentialKey: credential.key },
      )
      return []
    }
    input.logger?.warn(
      'binary-generator credential did not resolve; the agent is told the integration is unavailable',
      { binaryGeneratorId: plan.generatorId, credentialKey: credential.key },
    )
    return []
  })
}
