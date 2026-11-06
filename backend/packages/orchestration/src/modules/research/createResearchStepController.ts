import type { FindingsRevisionRepository, ResearchDefinitionSource } from '@cat-factory/kernel'
import type { CoreDependencies } from '../../container/dependencies.js'
import { ResearchFindingsStore } from './ResearchFindingsStore.js'
import { ResearchStepController } from './ResearchStepController.js'

/** The one findings store: the engine writes revisions through it and the HTTP layer reads them. */
export function createResearchFindingsStore(
  deps: CoreDependencies,
  findingsRevisionRepository: FindingsRevisionRepository,
): ResearchFindingsStore {
  return new ResearchFindingsStore({
    blockRepository: deps.blockRepository,
    workspaceRepository: deps.workspaceRepository,
    findingsRevisionRepository,
    ...(deps.findingsStoragePolicyRepository
      ? { findingsStoragePolicyRepository: deps.findingsStoragePolicyRepository }
      : {}),
    ...(deps.resolveBinaryArtifactStore
      ? { resolveBinaryArtifactStore: deps.resolveBinaryArtifactStore }
      : {}),
    logger: deps.logger,
  })
}

/**
 * The research step's engine half, when the facade wires research persistence and projects.
 * Absent otherwise, and then the `project-researcher` step resolves no brief.
 */
export function createResearchStepController(
  deps: CoreDependencies,
  researchDefinitions: ResearchDefinitionSource,
): ResearchStepController | undefined {
  const { projectRepository, researchProjectRepository, findingsRevisionRepository } = deps
  if (!projectRepository || !researchProjectRepository || !findingsRevisionRepository) {
    return undefined
  }
  const findings = createResearchFindingsStore(deps, findingsRevisionRepository)
  return new ResearchStepController({
    blockRepository: deps.blockRepository,
    projectRepository,
    ...(deps.serviceRepository ? { serviceRepository: deps.serviceRepository } : {}),
    researchDefinitions,
    researchProjectRepository,
    findings,
    clock: deps.clock,
  })
}
