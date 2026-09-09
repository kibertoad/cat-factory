import type {
  AssistantActionResult,
  AssistantAnswer,
  AssistantCapability,
  AssistantOutcome,
} from '~/types/domain'
import { ASSISTANT_PROMPT_MAX } from '~/types/domain'
import type { LoadState } from '~/types/load-state'

/**
 * The block a performed turn should reveal on the board.
 *
 * Per action, the SUBJECT of what happened rather than the first id in the result: a filed task
 * is the task, an added service is its frame, and a declared dependency is the CONSUMER, which is
 * the frame the edge was written onto and the one whose panel shows it. Selecting the provider
 * there would open the service that did not change.
 *
 * Exhaustive over the action union, so a fourth action fails to compile until it says what its
 * turn produced. That is the point of extracting three lines: a `default` that fell back to some
 * id would silently reveal the wrong block for whatever is added next.
 */
export function revealTarget(result: AssistantActionResult): string {
  switch (result.actionId) {
    case 'declare-service-dependency':
      return result.consumer.blockId
    case 'add-service-from-repo':
      return result.service.blockId
    case 'create-task-from-issue':
      return result.task.blockId
  }
}

/**
 * The answer to a clarification, once a person has picked one of its candidates.
 *
 * The chosen value REPLACES the field the platform named and everything else is carried over
 * untouched, so the next turn re-runs the same action with the one unresolved argument settled.
 *
 * Appending the candidate to the prompt and routing it again is what this replaces, and it could
 * not terminate: the words that produced the question are still in the sentence (a repository
 * under the wrong owner sits there beside the right one), and a candidate with no declared
 * argument to land in is dropped on the way through.
 */
export function answerFor(
  outcome: Extract<AssistantOutcome, { status: 'needs_input' }>,
  candidate: string,
): AssistantAnswer {
  return {
    actionId: outcome.actionId,
    arguments: { ...outcome.arguments, [outcome.field]: candidate },
  }
}

/**
 * Which panel the modal shows: the prompt box, or the reason there is none.
 *
 * Derived from the ANSWER rather than from the read's progress, so the states cannot collapse into
 * each other. Three of them are reasons no box is offered, and they differ in what the person does
 * next: `unreadable` is an outage a retry may clear, `unwired` is a deployment with no model, and
 * `no_actions` is a deployment whose catalog is empty. The last two both look like "available is
 * not true enough to submit" and have completely different remedies, which is why an empty catalog
 * is not folded into `unwired`: every submit against one 503s with `assistant_no_actions`, and a
 * box over an empty examples list is exactly the surface this is here to stop offering.
 *
 * A read still IN FLIGHT is not one of them. Withholding the box until the read answers would drop
 * the characters typed in the gap: the modal is opened from the sidebar and from the command
 * palette, where the hands are already on the keyboard, and a textarea that mounts one round trip
 * later is not focused yet, so those keystrokes land nowhere. So an unanswered read shows the box
 * and refuses SUBMISSION with a stated reason ({@link submitGate}), and the box is withheld only
 * once the read has answered that it cannot be submitted.
 */
export type AssistantSurface = 'prompt' | 'unreadable' | 'unwired' | 'no_actions'

export function assistantSurface(
  read: LoadState,
  capability: AssistantCapability | null,
): AssistantSurface {
  if (capability === null) return read === 'error' ? 'unreadable' : 'prompt'
  if (!capability.available) return 'unwired'
  return capability.actions.length === 0 ? 'no_actions' : 'prompt'
}

/**
 * Whether the typed request can be sent, and when it cannot, WHY.
 *
 * A disabled button owes an answer, and the reasons differ in what the person does next: an empty
 * box is answered by the placeholder and the examples under it, an over-long one has to name the
 * numbers (nothing on screen tells you a sentence is 40 characters too long), and a request typed
 * while the capability read is still in flight is neither of those: nothing is wrong with it and it
 * becomes sendable on its own, which is why `checking` is stated rather than left to look like a
 * button that does nothing.
 *
 * `unavailable` is the surface's own refusal, restated here rather than left implicit. It never
 * renders, because a surface that is not the box renders no button either. It exists because this
 * function is the submit AUTHORITY: read off the prompt and `running` alone it would answer `ready`
 * for an unwired deployment, and the next caller (a shortcut, a command-palette entry) would
 * inherit a submit that 503s. Deriving it from {@link assistantSurface} is what keeps the two from
 * disagreeing about the same capability.
 *
 * The length is measured on the TRIMMED text because that is what the wire schema caps, and against
 * the schema's OWN constant, so the box cannot promise a limit the backend does not hold to.
 */
export type SubmitGate =
  | { state: 'ready' }
  | { state: 'running' }
  | { state: 'unavailable' }
  | { state: 'checking' }
  | { state: 'empty' }
  | { state: 'too_long'; length: number; limit: number }

export function submitGate(input: {
  read: LoadState
  capability: AssistantCapability | null
  prompt: string
  running: boolean
}): SubmitGate {
  const { read, capability, prompt, running } = input
  if (running) return { state: 'running' }
  if (assistantSurface(read, capability) !== 'prompt') return { state: 'unavailable' }
  if (capability === null) return { state: 'checking' }
  const length = prompt.trim().length
  if (length === 0) return { state: 'empty' }
  if (length > ASSISTANT_PROMPT_MAX) {
    return { state: 'too_long', length, limit: ASSISTANT_PROMPT_MAX }
  }
  return { state: 'ready' }
}
