import type { AgentKindRegistry } from '@cat-factory/agents'
import { BINARY_OUTPUT_TRAIT, FOUNDATIONAL_CONTRACTS_TRAIT, hasTrait } from '@cat-factory/agents'
import type { PipelineStep } from '@cat-factory/contracts'
import type { AgentKind, Logger, ResolvedServiceCredentials } from '@cat-factory/kernel'
import { noopLogger, runBestEffort } from '@cat-factory/kernel'
import { declaredSelection, type FoundationalServiceResolver } from './run-foundational-services.js'

// ---------------------------------------------------------------------------
// The CREDENTIAL slice of one dispatch's catalog context: which foundational services this job
// must be able to authenticate to, projected down to the key NAMES the container executor
// resolves values for.
//
// The sibling of `dispatchBinaryGeneratorsFor` one layer over. That one authenticates what MAKES
// an artifact; this one authenticates what the run reads and writes it THROUGH. The platform had
// the first and not the second, so a step storing through an org's own object service was handed
// a bearer-authenticated contract and nothing to satisfy it with, and the service's description
// had to say so as a caveat.
//
// Its own module rather than a fourth function in `run-foundational-services.ts`, because the id
// set it resolves spans BOTH catalog readers: a binary-output step's own selection and a consumer
// kind's declared set are two different joins onto one catalog, and the union of them is exactly
// "the services this dispatch was briefed on".
// ---------------------------------------------------------------------------

export interface DispatchFoundationalCredentialsInput {
  workspaceId: string
  /** The EFFECTIVE dispatched kind (a gate helper dispatches its own kind, not the step's). */
  agentKind: AgentKind
  agentKindRegistry: AgentKindRegistry
  /** The step being dispatched: its `stepOptions.binaryOutput` is the generating selection. */
  step: PipelineStep
  /** The run's steps BEFORE this one, newest-last, where a design step's declaration lives. */
  priorSteps: PipelineStep[]
  foundationalServiceResolver?: FoundationalServiceResolver
  logger?: Logger
}

/**
 * The foundational services this dispatch was BRIEFED on, so it may be given their credentials.
 *
 * Gated on the same traits as the two injected-file reads, and that pairing is the whole safety
 * property: a credential is delivered only for a service whose contract the agent was also handed.
 * The alternative in either direction is a defect. Credentials with no brief put a live secret in
 * a process that was never told the service exists; a brief with no credentials is the state this
 * function was added to end.
 *
 * The two id sets are unioned rather than chosen between, because one kind can carry both traits:
 * a generating step that also consumes a prior design's declared services reads two catalogs'
 * worth of contracts in one dispatch, and dropping either half would leave one of them
 * unauthenticated for a reason no layer states.
 */
export async function dispatchFoundationalCredentialsFor(
  input: DispatchFoundationalCredentialsInput,
): Promise<ResolvedServiceCredentials[]> {
  const resolver = input.foundationalServiceResolver
  if (!resolver) return []
  const ids = briefedServiceIds(input)
  if (ids.length === 0) return []
  // BEST-EFFORT, and the degraded state is one the agent already understands: an unresolved
  // credential is an unset variable, which every brief on this seam defines as "the platform
  // could not provide it — report the gap rather than calling the service". Failing the dispatch
  // instead would turn an unreachable catalog into a run that produces nothing and explains
  // nothing, where one that runs and NAMES what it could not reach is strictly more useful.
  const resolved = await runBestEffort(
    input.logger ?? noopLogger,
    'foundationalServices.credentials',
    () => resolver.credentialsFor(input.workspaceId, ids),
    { workspaceId: input.workspaceId, agentKind: input.agentKind },
  )
  return resolved ?? []
}

/**
 * Every catalog service id this dispatch has been told about, deduped and in a stable order.
 *
 * Order is stable because the job body is persisted with the dispatch and read back on the poll
 * path: a set that reshuffled per resolve would make two identical dispatches differ on the wire
 * for no reason anyone could act on.
 */
function briefedServiceIds(input: DispatchFoundationalCredentialsInput): string[] {
  const { agentKind, agentKindRegistry } = input
  const ids = new Set<string>()
  if (hasTrait(agentKind, BINARY_OUTPUT_TRAIT, agentKindRegistry)) {
    const selection = input.step.stepOptions?.binaryOutput
    if (selection?.storageServiceId) ids.add(selection.storageServiceId)
    for (const id of selection?.contextServiceIds ?? []) ids.add(id)
  }
  if (hasTrait(agentKind, FOUNDATIONAL_CONTRACTS_TRAIT, agentKindRegistry)) {
    // The DECLARED half only, never `unknown`: an id the catalog does not contain resolves to no
    // service, so there is nothing to authenticate to and the index file already states the gap.
    for (const id of declaredSelection(input.priorSteps)?.declared ?? []) ids.add(id)
  }
  return [...ids]
}
