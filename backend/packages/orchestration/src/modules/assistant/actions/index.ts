import type { AssistantActionDefinition } from '../types.js'
import type { AssistantActionDeps } from './deps.js'
import { addServiceFromRepoAction } from './serviceFromRepo.js'
import { createTaskFromIssueAction } from './taskFromIssue.js'
import { declareServiceDependencyAction } from './serviceDependency.js'

export type {
  AssistantActionDeps,
  AssistantBoardDeps,
  AssistantIssueDeps,
  AssistantIssueMatch,
  AssistantRepoDeps,
} from './deps.js'

/**
 * The built-in action catalog, in the order the model is shown it and the SPA suggests it.
 *
 * An action whose integration a deployment did not wire is OMITTED rather than registered and left
 * to fail: the catalog is what the model routes against, so an unwired action is one the model can
 * still choose, and the turn would then answer a legitimate request with an internal-sounding
 * refusal. Omitted, the same request declines with "nothing in the catalog does that", which is
 * both true of this deployment and what its `available` capability read already said.
 *
 * The catalog is a plain list rather than a registry: every member performs a board write through
 * an engine-internal service, which is the same reason the `merger` step resolver is a privileged
 * built-in rather than a registry entry. Opening it to deployment-registered actions means giving
 * an action a public, minimal context first, and that is a design decision of its own. See
 * `docs/initiatives/in-app-assistant.md`.
 */
export function createAssistantActions(deps: AssistantActionDeps): AssistantActionDefinition[] {
  const actions: AssistantActionDefinition[] = [declareServiceDependencyAction(deps.board)]
  if (deps.repos) actions.push(addServiceFromRepoAction(deps.repos))
  if (deps.issues) {
    actions.push(createTaskFromIssueAction(deps.board, deps.issues, deps.repos))
  }
  return actions
}
