import {
  type Project,
  type ProjectStage,
  type ProjectStageState,
  REVISION_INTENT,
} from '@cat-factory/contracts'
import {
  type Clock,
  type ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  ValidationError,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { outcomeIdFor } from './ProjectStepController.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'

// A person's revision of a stage's result as they accept it at the stage's checkpoint: the model
// proposed, the person settles. The handler of the stage's task type says whether it takes a
// revision (and whether it requires one) and applies it; the platform writes the settled body as a
// NEW outcome on the stage's stream, so the model's proposal stays on record. A revision counts
// only once the checkpoint's acceptance NAMES it (`acceptedOutcomeId`), so a revision written by
// an acceptance that then loses the claim changes nothing. Design:
// `docs/initiatives/staged-project-definitions.md`.

export interface StageRevisionDeps {
  records: Pick<ProjectRecordRepository, 'getPin' | 'reserveSeq'>
  outcomes: Pick<ProjectOutcomeStore, 'bodiesOf' | 'get' | 'write'>
  modules: ProjectKindModuleRegistry
  clock: Clock
}

export interface StageRevisionInput {
  /** The board that homes the project, whose outcome-storage policy places the settled body. */
  homeWorkspaceId: string
  project: Project
  stage: ProjectStage
  /** The stage's state, awaiting its checkpoint. */
  state: ProjectStageState
  /** Every outcome envelope of the project, as the acceptance already listed them. */
  envelopes: readonly ProjectOutcomeRow[]
  /** What the person sent; undefined or null when they sent no revision. */
  revision: unknown
  decidedBy: string | null
}

/**
 * Settle the result awaiting the checkpoint with the person's revision, when the stage's handler
 * takes one, and record the settled body. Answers the id of the outcome the acceptance must name,
 * or null to accept the result as recorded. Refuses a revision the handler does not take, a missing
 * one it requires, and one it rejects, before writing anything. A retried acceptance that settles
 * the same body reuses the revision it already wrote rather than writing another.
 */
export async function settleStageRevision(
  deps: StageRevisionDeps,
  input: StageRevisionInput,
): Promise<string | null> {
  const { project, stage, state } = input
  const revision = input.revision ?? undefined
  const handler = deps.modules.handlerOf(project.kind, stage.taskType)
  const accepts = handler?.checkpointRevision
  if (revision === undefined) {
    if (accepts?.required) {
      throw new ValidationError(`Stage '${stage.id}' needs its result settled as it is accepted`, {
        reason: 'project_stage_revision_required',
        stageId: stage.id,
      })
    }
    return null
  }
  if (!handler || !accepts) {
    throw new ValidationError(`Stage '${stage.id}' takes no revision of its result`, {
      reason: 'project_stage_revision_unsupported',
      stageId: stage.id,
    })
  }
  const proposal = state.latest!
  const stored = await deps.outcomes.get(project, proposal.id)
  const decoded = stored ? tryDecodeOutcome(deps.modules, project.kind, stored) : undefined
  if (!decoded) {
    throw new ValidationError(`The result of stage '${stage.id}' cannot be read to settle it`, {
      reason: 'project_stage_result_unreadable',
      stageId: stage.id,
      outcomeId: proposal.id,
    })
  }
  const settled = accepts.revise({
    stage: { id: stage.id, title: stage.title, config: stage.config },
    body: decoded.body,
    revision,
    decidedBy: input.decidedBy,
    decidedAt: deps.clock.now(),
  })
  if (!settled.ok) {
    throw new ValidationError(
      `The revision of stage '${stage.id}' does not fit its result: ${settled.issues.join('; ')}`,
      { reason: 'project_stage_revision_invalid', stageId: stage.id, problems: settled.issues },
    )
  }
  const json = JSON.stringify(settled.value)
  const earlier = input.envelopes.filter(
    (row) => row.taskId === proposal.taskId && row.intent === REVISION_INTENT,
  )
  for (const written of await deps.outcomes.bodiesOf(project, earlier)) {
    if (written.json === json) return written.row.id
  }
  const seq = await deps.records.reserveSeq(project.id)
  const id = `${outcomeIdFor(proposal.taskId)}_rev${seq}`
  const pin = await deps.records.getPin(project.id)
  await deps.outcomes.write({
    runWorkspaceId: input.homeWorkspaceId,
    project,
    row: {
      id,
      projectId: project.id,
      stream: stage.produces,
      seq,
      intent: REVISION_INTENT,
      schemaVersion: handler.outcomeSchemaVersion,
      taskId: proposal.taskId,
      taskType: handler.taskType,
      definitionKey: pin?.definitionKey ?? null,
      definitionVersion: pin?.definitionVersion ?? null,
      artifactRefs: handler.artifactRefs(settled.value),
      createdAt: deps.clock.now(),
    },
    json,
  })
  return id
}
