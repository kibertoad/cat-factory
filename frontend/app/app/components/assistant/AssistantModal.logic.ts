import type { AssistantActionResult } from '~/types/domain'

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
