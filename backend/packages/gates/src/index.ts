import {
  CI_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  HUMAN_REVIEW_AGENT_KIND,
  POST_RELEASE_HEALTH_AGENT_KIND,
  registerGate,
} from '@cat-factory/kernel'
import { ciGate, conflictsGate, humanReviewGate, postReleaseHealthGate } from './gates.js'

// ---------------------------------------------------------------------------
// The built-in polling-gate suite, authored ENTIRELY through the public gate-registry
// seam (`registerGate`) — depending only on @cat-factory/kernel + @cat-factory/contracts,
// never on the engine. This is the dogfood: if the platform's own CI / conflict /
// post-release-health gates can be expressed as an external package, so can any
// deployment's. The engine no longer hard-codes them; it merges whatever gates are
// registered when its ExecutionService first builds its gate registry.
//
// A deployment opts in by importing this package once for its side effect, then wiring each
// gate's provider at startup:
//
//   import '@cat-factory/gates'
//   wireCiStatusProvider(new GitHubCiStatusProvider(...))
//   wireMergeabilityProvider(new GitHubMergeabilityProvider(...))
//   wireReleaseHealthProvider(new RegistryReleaseHealthProvider(...))
//   wireIncidentEnrichment(new CompositeIncidentEnrichmentProvider(...))
//
// Until a gate's provider is wired it is a harmless pass-through, so a bare import is safe.
// ---------------------------------------------------------------------------

export {
  CI_STATUS_PROVIDER,
  MERGEABILITY_PROVIDER,
  RELEASE_HEALTH_PROVIDER,
  INCIDENT_ENRICHMENT_PROVIDER,
  PULL_REQUEST_REVIEW_PROVIDER,
  wireCiStatusProvider,
  wireMergeabilityProvider,
  wireReleaseHealthProvider,
  wireIncidentEnrichment,
  wirePullRequestReviewProvider,
  clearGateProviders,
  applyGateProviders,
  type GateProviderOverrides,
} from './providers.js'
export { ciGate, conflictsGate, postReleaseHealthGate, humanReviewGate } from './gates.js'
export {
  classifyHumanReview,
  isApproved,
  outstandingThreads,
  outstandingComments,
  renderReviewFeedbackForFixer,
  requiredApprovals,
  type HumanReviewVerdict,
} from './review.logic.js'

/**
 * Register the built-in gate suite. Idempotent (the registry replaces by kind), so importing
 * the package and calling this explicitly are safe to combine. Called automatically as an
 * import side effect below.
 */
export function registerBuiltinGates(): void {
  registerGate(CI_AGENT_KIND, ciGate)
  registerGate(CONFLICTS_AGENT_KIND, conflictsGate)
  registerGate(POST_RELEASE_HEALTH_AGENT_KIND, postReleaseHealthGate)
  registerGate(HUMAN_REVIEW_AGENT_KIND, humanReviewGate)
}

// Side-effect registration: `import '@cat-factory/gates'` is enough.
registerBuiltinGates()
