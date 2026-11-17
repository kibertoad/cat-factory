import type { Project, ProjectStage, ProjectStageState } from '@cat-factory/contracts'
import {
  type Clock,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  ValidationError,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { outcomeIdFor } from './ProjectStepController.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'

// A person's revision of a stage's result as they accept it at the stage's checkpoint: the model
// proposed, the person settles. The handler of the stage's task type says whether it takes a
// revision (and whether it requires one) and applies it; the platform writes the revised body as a
// NEW outcome on the stage's stream, so the model's proposal stays on record beside what the person
// accepted. Design: `docs/initiatives/staged-project-definitions.md`.

export interface StageRevisionDeps {
  records: Pick<ProjectRecordRepository, 'listOutcomes' | 'getPin' | 'reserveSeq'>
  outcomes: Pick<ProjectOutcomeStore, 'bodiesOf' | 'write'>
  modules: ProjectKindModuleRegistry
  clock: Clock
}

export interface StageRevisionInput {
  /** The board the person accepts on, whose outcome-storage policy places the revised body. */
  workspaceId: string
  project: Project
  stage: ProjectStage
  /** The stage's state, awaiting its checkpoint. */
  state: ProjectStageState
  /** What the person sent; undefined when they sent no revision. */
  revision: unknown
  decidedBy: string | null
}

/** The outcome id of a task's revised result: one per task, so a retried acceptance writes once. */
export function revisedOutcomeIdFor(taskId: string): string {
  return `${outcomeIdFor(taskId)}_revised`
}

/**
 * Apply the person's revision, when the stage's handler takes one, and record the revised result.
 * Refuses a revision the handler does not take, a missing one it requires, and one it rejects. A
 * retried acceptance finds the revision already written and keeps it (first write wins).
 */
export async function recordStageRevision(
  deps: StageRevisionDeps,
  input: StageRevisionInput,
): Promise<void> {
  const { project, stage, state, revision } = input
  const handler = deps.modules.handlerOf(project.kind, stage.taskType)
  const accepts = handler?.checkpointRevision
  if (revision === undefined) {
    if (accepts?.required) {
      throw new ValidationError(`Stage '${stage.id}' needs its result settled as it is accepted`, {
        reason: 'project_stage_revision_required',
        stageId: stage.id,
      })
    }
    return
  }
  if (!handler || !accepts) {
    throw new ValidationError(`Stage '${stage.id}' takes no revision of its result`, {
      reason: 'project_stage_revision_unsupported',
      stageId: stage.id,
    })
  }
  const latest = state.latest!
  const envelopes = await deps.records.listOutcomes(project.id)
  const row = envelopes.find((r) => r.id === latest.id)
  const [stored] = row ? await deps.outcomes.bodiesOf(project, [row]) : []
  const decoded = stored ? tryDecodeOutcome(deps.modules, project.kind, stored) : undefined
  if (!decoded) {
    throw new ValidationError(`The result of stage '${stage.id}' cannot be read to revise it`, {
      reason: 'project_stage_upstream_unreadable',
      stageId: stage.id,
      outcomeId: latest.id,
    })
  }
  const revised = accepts.revise({
    stage: { id: stage.id, title: stage.title, config: stage.config },
    body: decoded.body,
    revision,
    decidedBy: input.decidedBy,
    decidedAt: deps.clock.now(),
  })
  if (!revised.ok) {
    throw new ValidationError(`The revision of stage '${stage.id}' does not fit its result`, {
      reason: 'project_stage_revision_invalid',
      stageId: stage.id,
      problems: revised.issues,
    })
  }
  const pin = await deps.records.getPin(project.id)
  await deps.outcomes.write({
    runWorkspaceId: input.workspaceId,
    project,
    row: {
      id: revisedOutcomeIdFor(latest.taskId),
      projectId: project.id,
      stream: stage.produces,
      seq: await deps.records.reserveSeq(project.id),
      intent: 'revise',
      schemaVersion: handler.outcomeSchemaVersion,
      taskId: latest.taskId,
      taskType: handler.taskType,
      definitionKey: pin?.definitionKey ?? null,
      definitionVersion: pin?.definitionVersion ?? null,
      artifactRefs: handler.artifactRefs(revised.value),
      createdAt: deps.clock.now(),
    },
    json: JSON.stringify(revised.value),
  })
}
