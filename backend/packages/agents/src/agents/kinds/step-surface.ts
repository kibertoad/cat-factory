import type { AgentKind } from '@cat-factory/kernel'
import { TASK_ESTIMATOR_AGENT_KIND } from '../prompts/roles.js'
import { registeredAgentKind } from './registry.js'

// Which execution surface a pipeline step's model runs on — the taxonomy the preset
// satisfiability guard keys off. Only INLINE model steps need a special check: an inline
// `generateText` call cannot use a container-only subscription token, so a step that runs a
// model inline must resolve to an INLINE-usable model (see `isModelUsableInline`), whereas a
// container step is satisfied by any usable model (subscription included) and a non-LLM
// gate/one-shot step runs no model at all.
//
// The guard therefore only needs to identify inline steps precisely; container and gate
// steps both keep the lenient `isModelUsable` check, so a mis-classification here can never
// *falsely* refuse a run — the worst case is falling back to the pre-existing behaviour.

// The canonical kind ids of the built-in INLINE engine steps (no container, no
// `registerAgentKind` entry): the requirements + clarity reviewers and the two brainstorm
// dialogues. Defined here — the single source of truth for the inline taxonomy, co-located
// with `isInlineModelStep` — so the classifier can't drift from a string list owned by
// another package (agents can't import orchestration). Orchestration's `ci.logic.ts`
// re-exports these for the engine's existing call sites, exactly as it re-exports the
// gate/helper kinds from kernel. The `task-estimator` id is imported from `roles.ts` (its
// existing home in this package).
export const REQUIREMENTS_REVIEW_AGENT_KIND = 'requirements-review'
export const CLARITY_REVIEW_AGENT_KIND = 'clarity-review'
export const REQUIREMENTS_BRAINSTORM_AGENT_KIND = 'requirements-brainstorm'
export const ARCHITECTURE_BRAINSTORM_AGENT_KIND = 'architecture-brainstorm'

const INLINE_ENGINE_KINDS = new Set<string>([
  REQUIREMENTS_REVIEW_AGENT_KIND,
  CLARITY_REVIEW_AGENT_KIND,
  REQUIREMENTS_BRAINSTORM_AGENT_KIND,
  ARCHITECTURE_BRAINSTORM_AGENT_KIND,
  TASK_ESTIMATOR_AGENT_KIND,
])

/**
 * Whether a pipeline step of this kind runs its model as an INLINE LLM call (as opposed to a
 * container agent or a non-LLM gate/one-shot step). True for the built-in engine-inline kinds
 * and for any custom kind registered with an `inline` agent surface. Used by the start guard
 * to apply the stricter inline-model-usability check to exactly these steps.
 */
export function isInlineModelStep(kind: AgentKind): boolean {
  if (INLINE_ENGINE_KINDS.has(kind)) return true
  return registeredAgentKind(kind)?.agent?.surface === 'inline'
}
