import { getAssistantCapabilityContract, runAssistantTurnContract } from '@cat-factory/contracts'
import type { AssistantAnswer } from '~/types/domain'
import type { ApiContext } from './context'

/** In-app assistant: what it can do here, and one prompt-to-action turn. */
export function assistantApi({ send, ws }: ApiContext) {
  return {
    // Whether a model is wired and which actions this deployment offers. Read before the prompt
    // box is shown, so an unconfigured deployment says so instead of failing on submit.
    getAssistantCapability: (workspaceId: string) =>
      send(getAssistantCapabilityContract, { pathPrefix: ws(workspaceId) }),

    // Run one turn. A live model call plus a board write, so it can take a couple of seconds:
    // the modal shows progress and the outcome is rendered from the returned data.
    runAssistantTurn: (workspaceId: string, prompt: string) =>
      send(runAssistantTurnContract, {
        pathPrefix: ws(workspaceId),
        body: { kind: 'prompt', prompt },
      }),

    // Answer a question the last turn asked. The same endpoint, and deliberately: it performs one
    // catalog action exactly as a prompt does. It reaches no model, so it is the fast half.
    answerAssistantTurn: (workspaceId: string, answer: AssistantAnswer) =>
      send(runAssistantTurnContract, {
        pathPrefix: ws(workspaceId),
        body: { kind: 'answer', answer },
      }),
  }
}
