import type {
  Project,
  ProjectBoardView,
  ProjectCredentialReadiness,
  ProjectDefinition,
  ProjectOutcomeDetail,
  ProjectOutcomeEntry,
} from '@cat-factory/contracts'
import {
  type DecodedProjectOutcome,
  NotFoundError,
  type ProjectDefinitionSource,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  UnavailableError,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore, ReadOutcome } from './ProjectOutcomeStore.js'
import type { MountedProject } from './ProjectService.js'
import type { ProjectStageService } from './ProjectStageService.js'
import { outcomeMetaOf, tryDecodeOutcome } from './outcomeDecoding.js'

export interface ProjectBoardViewsDeps {
  /** Each stage of the pinned definition with where it stands. */
  stages: Pick<ProjectStageService, 'views'>
  getMounted: (workspaceId: string, projectId: string) => Promise<MountedProject>
  records: Pick<ProjectRecordRepository, 'getPin'>
  definitions: ProjectDefinitionSource
  outcomes: ProjectOutcomeStore
  modules: ProjectKindModuleRegistry
}

/** Whether each credential a definition declares resolves for the reading board. */
export type CredentialReadinessCheck = (
  project: Project,
  definition: ProjectDefinition,
) => Promise<ProjectCredentialReadiness[]>

/**
 * The app's read of one project mounted on a board, for every kind: the pin, the definition it
 * names, every outcome with where its body lives, the credential readiness the HTTP layer checks
 * through the same resolver a dispatch reads, and the view the kind's module computes. An outcome
 * whose body cannot be read just now is listed as unreadable and left out of the view, so the
 * reader states what is missing beside what it can show.
 */
export class ProjectBoardViews {
  constructor(private readonly deps: ProjectBoardViewsDeps) {}

  async read(
    workspaceId: string,
    projectId: string,
    checkCredentials: CredentialReadinessCheck,
  ): Promise<ProjectBoardView> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const module = this.deps.modules.get(project.kind)
    const pin = await this.deps.records.getPin(project.id)
    const [resolved, read] = await Promise.all([
      pin
        ? this.deps.definitions.get(
            project.accountId ?? '',
            project.kind,
            pin.definitionKey,
            pin.definitionVersion,
          )
        : null,
      this.deps.outcomes.readAll(project),
    ])
    const decoded = read.map((outcome) => ({
      outcome,
      decoded: tryDecodeOutcome(this.deps.modules, project.kind, outcome),
    }))
    const readable: DecodedProjectOutcome[] = decoded.flatMap(({ decoded }) =>
      decoded ? [decoded] : [],
    )
    const definition = resolved?.definition ?? null
    const [credentials, stages] = await Promise.all([
      definition ? checkCredentials(project, definition) : [],
      this.deps.stages.views(
        project,
        definition,
        read.map(({ row }) => row),
      ),
    ])
    return {
      projectId: project.id,
      kind: project.kind,
      pin: pin
        ? {
            definitionKey: pin.definitionKey,
            definitionVersion: pin.definitionVersion,
            definitionHash: pin.definitionHash,
            inputs: pin.inputs,
          }
        : null,
      definition,
      definitionChanged: !!pin && !!resolved && resolved.contentHash !== pin.definitionHash,
      outcomes: decoded.map(({ outcome, decoded }) => entryOf(outcome, decoded !== undefined)),
      credentials,
      view: module?.view
        ? module.view({ definition, inputs: pin?.inputs ?? {}, outcomes: readable })
        : null,
      stages,
    }
  }

  async outcome(
    workspaceId: string,
    projectId: string,
    outcomeId: string,
  ): Promise<ProjectOutcomeDetail> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const read = await this.deps.outcomes.readOne(project, outcomeId)
    if (!read) throw new NotFoundError('ProjectOutcome', outcomeId)
    const decoded = tryDecodeOutcome(this.deps.modules, project.kind, read)
    if (!decoded) {
      throw new UnavailableError(
        'A project outcome body is stored in the blob store, which cannot serve it now',
        'outcome_body_unavailable',
        { outcomeId },
      )
    }
    return { ...entryOf(read, true), body: decoded.body }
  }
}

function entryOf(read: ReadOutcome, readable: boolean): ProjectOutcomeEntry {
  const storage = { placement: read.row.body.kind, bytes: read.row.bodyBytes, readable }
  return { ...outcomeMetaOf(read.row), storage }
}
