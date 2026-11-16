import type { ProjectDefinitionSource, ProjectKindModuleRegistry } from '@cat-factory/kernel'
import type { CoreDependencies } from '../../container/dependencies.js'
import { ProjectStepController } from './ProjectStepController.js'

/**
 * The project step's engine half, when the facade wires projects and their records. Absent
 * otherwise, and then no project task's step resolves a brief.
 */
export function createProjectStepController(
  deps: CoreDependencies,
  sources: { definitions: ProjectDefinitionSource; modules: ProjectKindModuleRegistry },
): ProjectStepController | undefined {
  const { projectRepository, projectRecordRepository } = deps
  if (!projectRepository || !projectRecordRepository) return undefined
  return new ProjectStepController({
    blockRepository: deps.blockRepository,
    projectRepository,
    ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
    workspaceRepository: deps.workspaceRepository,
    definitions: sources.definitions,
    records: projectRecordRepository,
    ...(deps.outcomeStoragePolicyRepository
      ? { policies: deps.outcomeStoragePolicyRepository }
      : {}),
    modules: sources.modules,
    clock: deps.clock,
  })
}
