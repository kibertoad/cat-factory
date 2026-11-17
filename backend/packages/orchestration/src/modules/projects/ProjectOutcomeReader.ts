import type { Project, ProjectOutcome, ProjectOutcomeMeta } from '@cat-factory/contracts'
import type {
  ProjectDefinitionSource,
  ProjectKindModuleRegistry,
  ProjectRecordRepository,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { decodeOutcome, outcomeMetaOf } from './outcomeDecoding.js'

export interface ProjectOutcomeReaderDeps {
  records: ProjectRecordRepository
  outcomes: ProjectOutcomeStore
  definitions: ProjectDefinitionSource
  modules: ProjectKindModuleRegistry
}

/** A project's current view as its kind computes it; `view` is null for a kind with none. */
export interface ProjectView {
  kind: string
  view: unknown
}

type ReadableProject = Pick<Project, 'id' | 'rootBlockId' | 'kind' | 'accountId'>

/**
 * Reads a project's outcomes for a client, whatever the project's kind. Bodies are decoded by the
 * handler of the task type that wrote them when this process has one, so a reader sees what the kind normalized; without
 * one a body is served as it was stored, since reading it needs no understanding of it.
 */
export class ProjectOutcomeReader {
  constructor(private readonly deps: ProjectOutcomeReaderDeps) {}

  /** The project's outcomes without their bodies, `seq` ascending; one stream's when given. */
  async list(projectId: string, stream?: string): Promise<ProjectOutcomeMeta[]> {
    return (await this.deps.records.listOutcomes(projectId, stream)).map(outcomeMetaOf)
  }

  async get(project: ReadableProject, id: string): Promise<ProjectOutcome | null> {
    const stored = await this.deps.outcomes.get(project, id)
    if (!stored) return null
    const { taskType: _taskType, ...outcome } = decodeOutcome(
      this.deps.modules,
      project.kind,
      stored,
    )
    return outcome
  }

  /**
   * The kind's view over every outcome of the project. A pinned definition that changed or is
   * gone yields a view without it rather than a refusal: the view only reads what was recorded.
   */
  async view(project: ReadableProject): Promise<ProjectView> {
    const module = this.deps.modules.get(project.kind)
    if (!module?.view) return { kind: project.kind, view: null }
    const pin = await this.deps.records.getPin(project.id)
    const resolved = pin
      ? await this.deps.definitions.get(
          project.accountId ?? '',
          project.kind,
          pin.definitionKey,
          pin.definitionVersion,
        )
      : null
    const stored = await this.deps.outcomes.list(project)
    return {
      kind: project.kind,
      view: module.view({
        definition: resolved?.definition ?? null,
        inputs: pin?.inputs ?? {},
        outcomes: stored.map((outcome) => decodeOutcome(this.deps.modules, project.kind, outcome)),
      }),
    }
  }
}
