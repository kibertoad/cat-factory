import type {
  ProjectDefinitionSource,
  ProjectKindModuleRegistry,
  ProjectRecordRepository,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '../../container/dependencies.js'
import { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import type { ProjectStageService } from './ProjectStageService.js'
import { ProjectStepController } from './ProjectStepController.js'
import type { ProjectEngineTask } from './stageSpawner.js'
import { createStageAcceptanceAssessor } from '../../container/inline-producers.js'

/**
 * The project step's engine half, when the facade wires projects and their records. Absent
 * otherwise, and then no project task's step resolves a brief.
 */
export function createProjectStepController(
  deps: CoreDependencies,
  sources: {
    definitions: ProjectDefinitionSource
    modules: ProjectKindModuleRegistry
    /** The projects module's stages, so a recorded outcome starts what it made ready. */
    stages?: Pick<ProjectStageService, 'advance' | 'announceCheckpoint'>
    /** The project task types the engine performs itself. */
    engineTasks?: readonly ProjectEngineTask[]
  },
): ProjectStepController | undefined {
  const { projectRepository, projectRecordRepository } = deps
  if (!projectRepository || !projectRecordRepository) return undefined
  const outcomes = createProjectOutcomeStore(deps, projectRecordRepository)
  const acceptance = createStageAcceptanceAssessor(deps)
  return new ProjectStepController({
    blockRepository: deps.blockRepository,
    projectRepository,
    ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
    definitions: sources.definitions,
    records: projectRecordRepository,
    outcomes,
    modules: sources.modules,
    clock: deps.clock,
    ...(sources.stages ? { stages: sources.stages } : {}),
    ...(sources.engineTasks ? { engineTasks: sources.engineTasks } : {}),
    ...(acceptance ? { acceptance } : {}),
    logger: deps.logger,
  })
}

/** The one outcome store a process builds, shared by the step controller and the outcome reader. */
export function createProjectOutcomeStore(
  deps: CoreDependencies,
  records: ProjectRecordRepository,
): ProjectOutcomeStore {
  return new ProjectOutcomeStore({
    blockRepository: deps.blockRepository,
    workspaceRepository: deps.workspaceRepository,
    records,
    ...(deps.outcomeStoragePolicyRepository
      ? { policies: deps.outcomeStoragePolicyRepository }
      : {}),
    ...(deps.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: deps.resolveBinaryArtifactStore }
      : {}),
    logger: deps.logger,
  })
}
