// ---------------------------------------------------------------------------
// SINGLE-KIND runs — the agents the PLATFORM starts on their own, with no pipeline behind them.
//
// Both sides have to agree about these strings, which is what puts them here rather than in
// kernel: the backend dispatches the kind and stamps the synthesized id onto the run, and the SPA
// offers the action and then has to recognise the run that comes back. A copy on each side is a
// pair that drifts silently — the run starts, and the surface that was watching for it never sees
// one.
// ---------------------------------------------------------------------------

/**
 * The agent that maps a repository into the service → modules blueprint and populates the board.
 * Run after a bootstrap, and on demand from a service frame's "Map service" action.
 */
export const BLUEPRINT_AGENT_KIND = 'blueprints'

/**
 * The agent that reads a service repo and drafts a Docker Compose stack recipe. Run on demand by
 * the environment setup wizard, which merges the draft over its deterministic detection.
 */
export const ENVIRONMENT_ANALYST_AGENT_KIND = 'environment-analyst'

/**
 * The agent that scaffolds a new repository from a reference architecture, or writes a new
 * service into an existing monorepo and opens the pull request.
 *
 * Deliberately not `architect`, which is what a bootstrap dispatch used to file its telemetry
 * under: the observability panel groups a run's spend and its provided context BY KIND, so a
 * bootstrap filed as an architect is a run whose only phase is labelled as somebody else's work.
 * It is not a registry kind (nothing places it in a pipeline) and it is not the MODEL routing key
 * either: the facades still resolve the model through `architect`'s routing, so a deployment that
 * pinned a model for its architect keeps getting it here.
 */
export const REPO_BOOTSTRAP_AGENT_KIND = 'repo-bootstrapper'

/**
 * The inline agent that reads a monorepo and the reference template and proposes what a new
 * service should adopt from each. The first half of what a monorepo bootstrap spends, and the
 * half a human then settles.
 */
export const MONOREPO_ADOPTION_AGENT_KIND = 'monorepo-adoption-advisor'

/**
 * The id prefix a single-kind run carries in place of a catalog pipeline id. Deliberately not a
 * `pl_` id: nothing defines it and nothing stores it, so a reader who goes looking for the
 * pipeline behind such a run should find a name that says there isn't one rather than a 404.
 */
export const AD_HOC_PIPELINE_ID_PREFIX = 'agent:'

/** The `pipelineId` a single-kind run of `agentKind` reports. */
export function adHocPipelineIdFor(agentKind: string): string {
  return `${AD_HOC_PIPELINE_ID_PREFIX}${agentKind}`
}
