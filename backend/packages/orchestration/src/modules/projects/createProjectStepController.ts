import type { ProjectDefinitionSource, ProjectKindModuleRegistry } from '@cat-factory/kernel'
import type { CoreDependencies } from '../../container/dependencies.js'
import { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
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
  const outcomes = new ProjectOutcomeStore({
    blockRepository: deps.blockRepository,
    workspaceRepository: deps.workspaceRepository,
    records: projectRecordRepository,
    ...(deps.outcomeStoragePolicyRepository
      ? { policies: deps.outcomeStoragePolicyRepository }
      : {}),
    ...(deps.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: deps.resolveBinaryArtifactStore }
      : {}),
    logger: deps.logger,
  })
  return new ProjectStepController({
    blockRepository: deps.blockRepository,
    projectRepository,
    ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
    definitions: sources.definitions,
    records: projectRecordRepository,
    outcomes,
    modules: sources.modules,
    clock: deps.clock,
  })
}
