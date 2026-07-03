// Pure initiative vocabulary shared by the agent-kind definitions
// (`@cat-factory/agents`), the execution engine (`@cat-factory/orchestration`)
// and the facades — mirroring `gate-logic.ts` so no package has to depend on
// another just for the kind strings.

/** The Initiative Planning pipeline's plan-authoring container agent. */
export const INITIATIVE_PLANNER_AGENT_KIND = 'initiative-planner'
/** The LLM-less step that persists the approved plan + commits the tracker. */
export const INITIATIVE_COMMITTER_AGENT_KIND = 'initiative-committer'

/** Every agent kind that may ONLY run against an `initiative`-level block. */
export const INITIATIVE_AGENT_KINDS: ReadonlySet<string> = new Set([
  INITIATIVE_PLANNER_AGENT_KIND,
  INITIATIVE_COMMITTER_AGENT_KIND,
])

/** Whether an agent kind belongs to the initiative-planning family. */
export function isInitiativeAgentKind(kind: string): boolean {
  return INITIATIVE_AGENT_KINDS.has(kind)
}

/**
 * Whether a pipeline shape contains any initiative-planning step. Used by the
 * engine's runnable guard: such a pipeline may only start on an initiative
 * block, and an initiative block accepts only such pipelines (bidirectional —
 * see `ExecutionService.assertRunnable`).
 */
export function hasInitiativeKinds(agentKinds: readonly string[]): boolean {
  return agentKinds.some(isInitiativeAgentKind)
}
