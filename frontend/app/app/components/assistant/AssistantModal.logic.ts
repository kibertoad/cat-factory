import type { AssistantActionResult, AssistantAnswer, AssistantOutcome } from '~/types/domain'

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
