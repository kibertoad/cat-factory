import type { AgentKind } from '@cat-factory/kernel'
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

/**
 * The built-in agent kinds whose step is an INLINE LLM call handled by the engine (no
 * container, no `registerAgentKind` entry): the requirements + clarity reviewers, the two
 * brainstorm dialogues and the task-estimator. Their canonical kind-id constants live with
 * their services (orchestration `ci.logic.ts`, agents `roles.ts`); the string values are the
 * stable wire ids, matched here the same way `CompositeAgentExecutor`'s `CONTAINER_KINDS`
 * matches container kinds.
 */
const INLINE_ENGINE_KINDS = new Set<string>([
  'requirements-review',
  'clarity-review',
  'requirements-brainstorm',
  'architecture-brainstorm',
  'task-estimator',
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
