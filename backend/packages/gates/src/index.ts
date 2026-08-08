import {
  CI_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  DOC_QUALITY_AGENT_KIND,
  type GateRegistry,
  HUMAN_REVIEW_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  defaultGateRegistry,
} from '@cat-factory/kernel'
import {
  ciGate,
  conflictsGate,
  docQualityGate,
  humanReviewGate,
  postReleaseHealthGate,
} from './gates.js'
import {
  CI_GATE_CONFIG_FIELDS,
  CONFLICTS_GATE_CONFIG_FIELDS,
  DOC_QUALITY_GATE_CONFIG_FIELDS,
  HUMAN_REVIEW_GATE_CONFIG_FIELDS,
  POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
} from './gateConfigFields.js'

// ---------------------------------------------------------------------------
// The built-in polling-gate suite, authored ENTIRELY through the public gate-registry
// seam (`registerGate`) — depending only on @cat-factory/kernel + @cat-factory/contracts,
// never on the engine. This is the dogfood: if the platform's own CI / conflict /
// post-release-health gates can be expressed as an external package, so can any
// deployment's. The engine no longer hard-codes them; it merges whatever gates are
// registered when its ExecutionService first builds its gate registry.
//
// A deployment opts in by installing the built-in gates into its app-owned gate registry,
// then wiring each gate's provider at startup:
//
//   const gates = defaultGateRegistry()
//   registerBuiltinGates(gates)                  // installs ci / conflicts / … into the instance
//   wireCiStatusProvider(new GitHubCiStatusProvider(...))
//   wireMergeabilityProvider(new GitHubMergeabilityProvider(...))
//   wireReleaseHealthProvider(new RegistryReleaseHealthProvider(...))
//   wireIncidentEnrichment(new CompositeIncidentEnrichmentProvider(...))
//   // …then thread `gates` through `CoreDependencies.gateRegistry`.
//
// Until a gate's provider is wired it is a harmless pass-through. The registry is an
// app-owned INSTANCE (`GateRegistry`), not a module global — so registering the built-ins is
// an explicit call the composition root makes, not an import side effect.
// ---------------------------------------------------------------------------

export {
  CI_STATUS_PROVIDER,
  MERGEABILITY_PROVIDER,
  RELEASE_HEALTH_PROVIDER,
  INCIDENT_ENRICHMENT_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  DOC_QUALITY_PROVIDER,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
  wirePullRequestReviewProvider,
  wireDocQualityProvider,
  clearGateProviders,
  applyGateProviders,
  warnUnwiredGates,
  type GateProviderOverrides,
} from './providers.js'
export {
  ciGate,
  conflictsGate,
  postReleaseHealthGate,
  humanReviewGate,
  docQualityGate,
} from './gates.js'
export {
  CI_GATE_CONFIG_FIELDS,
  CONFLICTS_GATE_CONFIG_FIELDS,
  DOC_QUALITY_GATE_CONFIG_FIELDS,
  HUMAN_REVIEW_GATE_CONFIG_FIELDS,
  POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
  gateConfigNumber,
} from './gateConfigFields.js'
export {
  classifyHumanReview,
  isApproved,
  outstandingThreads,
  outstandingConversation,
  renderReviewFeedbackForFixer,
  requiredApprovals,
  type HumanReviewVerdict,
} from './review.logic.js'

/**
 * Install the built-in gate suite into an app-owned {@link GateRegistry}. The composition
 * root calls this once with the instance it threads through `CoreDependencies.gateRegistry`.
 * Idempotent (the registry replaces by kind), so a deployment can call it then override a
 * built-in by re-registering the same kind.
 */
export function registerBuiltinGates(registry: GateRegistry): void {
  registry.register(CI_AGENT_KIND, ciGate, { configFields: CI_GATE_CONFIG_FIELDS })
  registry.register(CONFLICTS_AGENT_KIND, conflictsGate, {
    configFields: CONFLICTS_GATE_CONFIG_FIELDS,
  })
  registry.register(POST_RELEASE_HEALTH_AGENT_KIND, postReleaseHealthGate, {
    configFields: POST_RELEASE_HEALTH_GATE_CONFIG_FIELDS,
    // A watch window that outlasts the driver's poll budget saw NO regression, which is a
    // healthy pass rather than a timeout.
    pollExhaustion: 'pass',
  })
  registry.register(HUMAN_REVIEW_AGENT_KIND, humanReviewGate, {
    configFields: HUMAN_REVIEW_GATE_CONFIG_FIELDS,
    // There is no deadline for a human reviewer, so a spent poll budget is not a verdict: this
    // gate re-arms and the run waits. Declared HERE rather than on the built definition because
    // public-API admission reads it at request time to refuse a `write` key a start that would
    // park on a person (`parkSurfacesOf`), where building the definition is not an option.
    pollExhaustion: 'rearm',
  })
  registry.register(DOC_QUALITY_AGENT_KIND, docQualityGate, {
    configFields: DOC_QUALITY_GATE_CONFIG_FIELDS,
  })
}

/**
 * A fresh app-owned {@link GateRegistry} pre-loaded with the built-in gate suite — the single
 * named factory a composition root reaches for when it is NOT handed an injected registry.
 * Prefer this over the `defaultGateRegistry()` + `registerBuiltinGates()` two-step at every
 * construction site: kernel's `defaultGateRegistry()` is empty by design (it cannot depend on
 * this package), so a site that forgets the second step silently drops the platform's own
 * CI / conflicts / merge gates. Collapsing the pair into one call makes that hazard
 * unrepresentable — the obvious "I need the built-in gates" helper installs them.
 */
export function gateRegistryWithBuiltins(): GateRegistry {
  const registry = defaultGateRegistry()
  registerBuiltinGates(registry)
  return registry
}
