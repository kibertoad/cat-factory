import type {
  Project,
  ProjectBoardView,
  ProjectCredentialReadiness,
  ProjectDefinition,
  ProjectOutcome,
  ProjectOutcomeDetail,
  ProjectOutcomeEntry,
  ProjectOutcomeMeta,
} from '@cat-factory/contracts'
import {
  NotFoundError,
  type ProjectDefinitionSource,
  type ProjectKindModule,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  UnavailableError,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore, ReadOutcome } from './ProjectOutcomeStore.js'
import type { MountedProject } from './ProjectService.js'

export interface ProjectBoardViewsDeps {
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
    const decoded = read.map((outcome) => ({ outcome, body: decode(module, outcome) }))
    const readable: ProjectOutcome[] = decoded.flatMap(({ outcome, body }) =>
      body === undefined ? [] : [{ ...metaOf(outcome), body }],
    )
    const definition = resolved?.definition ?? null
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
      outcomes: decoded.map(({ outcome, body }) => entryOf(outcome, body !== undefined)),
      credentials: definition ? await checkCredentials(project, definition) : [],
      view: module?.view
        ? module.view({ definition, inputs: pin?.inputs ?? {}, outcomes: readable })
        : null,
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
    const body = decode(this.deps.modules.get(project.kind), read)
    if (body === undefined) {
      throw new UnavailableError(
        'A project outcome body is stored in the blob store, which cannot serve it now',
        'outcome_body_unavailable',
        { outcomeId },
      )
    }
    return { ...entryOf(read, true), body }
  }
}

function metaOf({ row }: ReadOutcome): ProjectOutcomeMeta {
  const { body: _ref, bodyBytes: _bytes, ...meta } = row
  return meta
}

function entryOf(read: ReadOutcome, readable: boolean): ProjectOutcomeEntry {
  const storage = { placement: read.row.body.kind, bytes: read.row.bodyBytes, readable }
  return { ...metaOf(read), storage }
}

/**
 * A body as its kind decodes it, or undefined when it cannot be read or does not parse. Without a
 * module in this process the stored JSON is served as it is, since showing it needs no
 * understanding of it.
 */
function decode(
  module: ProjectKindModule<unknown> | undefined,
  { row, json }: ReadOutcome,
): unknown {
  if (json === null) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return undefined
  }
  return module ? module.parseOutcome(row.schemaVersion, raw) : raw
}
