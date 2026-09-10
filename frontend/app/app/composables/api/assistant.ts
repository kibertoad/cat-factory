import { getAssistantCapabilityContract, runAssistantTurnContract } from '@cat-factory/contracts'
import type { AssistantAnswer } from '~/types/domain'
import type { ApiContext } from './context'

/** In-app assistant: what it can do here, and one prompt-to-action turn. */
export function assistantApi({ send, sendWith, ws, pwHeaders }: ApiContext) {
  return {
    // Whether a model is wired and which actions this deployment offers. Read before the prompt
    // box is shown, so an unconfigured deployment says so instead of failing on submit. `signal`
    // is what lets the store put a deadline on it: the client sets no timeout of its own, and a
    // read that never settles is a modal with no answer, no failure and so no retry either.
    getAssistantCapability: (workspaceId: string, signal?: AbortSignal) =>
      send(getAssistantCapabilityContract, { pathPrefix: ws(workspaceId), signal }),

    // Run one turn. A live model call plus a board write, so it can take a couple of seconds:
    // the modal shows progress and the outcome is rendered from the returned data.
    //
    // Carries the personal password header, like a run start does, because the turn resolves the
    // workspace's own preset: a workspace pinned to an individual-usage subscription runs this
    // surface on it, and without the header it could only ever fall back to another model.
    runAssistantTurn: (workspaceId: string, prompt: string, password?: string) =>
      sendWith(pwHeaders(password), runAssistantTurnContract, {
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
