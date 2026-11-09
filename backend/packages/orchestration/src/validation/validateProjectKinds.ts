import type { ProjectKindRegistry, TaskTypeRegistry } from '@cat-factory/kernel'
import { BUILTIN_TASK_TYPES } from '@cat-factory/contracts'
import type { RegistrationProblem } from './validateRegistrations.js'

/**
 * Deployment-registered PROJECT KINDS: every task type a kind offers must be one a task can carry
 * (built in or registered), and every default pipeline it names must exist. Either fault would
 * otherwise reach a person only when they tried to create a task under the project.
 */
export function projectKindProblems(
  kinds: ProjectKindRegistry,
  taskTypes: TaskTypeRegistry | undefined,
  knownPipelineIds: ReadonlySet<string>,
): RegistrationProblem[] {
  const problems: RegistrationProblem[] = []
  const knownTaskTypes = new Set<string>([
    ...BUILTIN_TASK_TYPES,
    ...(taskTypes?.all().map((t) => t.taskType) ?? []),
  ])
  for (const kind of kinds.all()) {
    for (const entry of kind.taskTypes) {
      if (!knownTaskTypes.has(entry.taskType)) {
        problems.push({
          severity: 'error',
          code: 'project_kind_unknown_task_type',
          message:
            `Project kind "${kind.id}" offers task type "${entry.taskType}", which is neither a ` +
            `built-in nor a registered task type.`,
        })
      }
      if (entry.defaultPipelineId !== undefined && !knownPipelineIds.has(entry.defaultPipelineId)) {
        problems.push({
          severity: 'error',
          code: 'project_kind_unknown_pipeline',
          message:
            `Project kind "${kind.id}" names defaultPipelineId "${entry.defaultPipelineId}" for ` +
            `"${entry.taskType}", which is neither a built-in nor a registered pipeline.`,
        })
      }
    }
  }
  return problems
}
