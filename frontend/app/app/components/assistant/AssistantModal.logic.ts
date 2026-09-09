import type { AssistantActionResult, AssistantAnswer, AssistantOutcome } from '~/types/domain'
import type { CapabilityRead } from '~/stores/assistant'

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
 * Which of the four things the modal can show: the box, or the reason there is no box.
 *
 * Derived rather than read off a nullable capability, so the states cannot collapse into each
 * other. `reading` is temporary and says so, `unreadable` is an outage the person can retry,
 * `unwired` is a deployment fact retrying will not change, and only `ready` offers the box. Read
 * off the capability alone, all three of the first ones offer the box with a dead Run button.
 */
export type AssistantSurface = 'reading' | 'unreadable' | 'unwired' | 'ready'

export function assistantSurface(read: CapabilityRead, available: boolean): AssistantSurface {
  switch (read) {
    case 'unread':
    case 'reading':
      return 'reading'
    case 'failed':
      return 'unreadable'
    case 'read':
      return available ? 'ready' : 'unwired'
  }
}

/**
 * Whether the typed request can be sent, and when it cannot, WHY.
 *
 * A disabled button owes an answer, and the two reasons differ in what the person does next: an
 * empty box is answered by the placeholder and the examples under it, while an over-long one has
 * to name the numbers, since nothing on screen tells you a sentence is 40 characters too long.
 * The length is measured on the TRIMMED text because that is what the wire schema caps.
 */
export type SubmitGate =
  | { state: 'ready' }
  | { state: 'running' }
  | { state: 'empty' }
  | { state: 'too_long'; length: number; limit: number }

export function submitGate(prompt: string, running: boolean, limit: number): SubmitGate {
  if (running) return { state: 'running' }
  const length = prompt.trim().length
  if (length === 0) return { state: 'empty' }
  if (length > limit) return { state: 'too_long', length, limit }
  return { state: 'ready' }
}
