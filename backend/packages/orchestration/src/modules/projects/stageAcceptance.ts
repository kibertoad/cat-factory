import {
  type Project,
  type ProjectDefinition,
  type ProjectStage,
  type StageAcceptanceReport,
  computeStageAcceptance,
  unassessedStageAcceptance,
} from '@cat-factory/contracts'
import {
  type Block,
  type Clock,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  type StageAcceptanceAssessor,
  getErrorMessage,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'
import { renderStageResult } from './stageRendering.js'
import { stageResultRows } from './stageUpstream.js'

// A stage task's result assessed against its stage's acceptance criteria, once the task records
// it. The assessor argues each criterion and the report computes its status from the passages it
// quotes; the report rides the stage-task record and is shown at the checkpoint, where a person
// decides. One that could not be made says why, so it never reads as a pass. Design:
// `docs/initiatives/staged-project-definitions.md`.

export interface StageAcceptanceDeps {
  records: Pick<
    ProjectRecordRepository,
    'listOutcomes' | 'listStageTasks' | 'setStageTaskAcceptance'
  >
  outcomes: Pick<ProjectOutcomeStore, 'bodiesOf'>
  modules: ProjectKindModuleRegistry
  clock: Clock
  assessor?: StageAcceptanceAssessor
}

export interface StageAcceptanceInput {
  workspaceId: string
  project: Project
  definition: ProjectDefinition
  inputs: Record<string, unknown>
  stage: ProjectStage
  /** The stage task, and the outcome it recorded. */
  task: Block
  outcome: { id: string; seq: number }
}

/** Assess and record the report, unless the task already has one (a replayed completion). */
export async function assessStageResult(
  deps: StageAcceptanceDeps,
  input: StageAcceptanceInput,
): Promise<void> {
  const criteria = input.stage.acceptance
  if (!criteria) return
  const records = await deps.records.listStageTasks(input.project.id)
  if (records.find((r) => r.taskId === input.task.id)?.acceptance) return
  const report = await reportFor(deps, input, records, criteria)
  await deps.records.setStageTaskAcceptance(input.project.id, input.task.id, report)
}

async function reportFor(
  deps: StageAcceptanceDeps,
  input: StageAcceptanceInput,
  records: Awaited<ReturnType<StageAcceptanceDeps['records']['listStageTasks']>>,
  criteria: NonNullable<ProjectStage['acceptance']>,
): Promise<StageAcceptanceReport> {
  const base = { outcomeId: input.outcome.id, assessedAt: deps.clock.now(), criteria }
  const assessor = deps.assessor
  if (!assessor?.enabled) {
    return unassessedStageAcceptance({
      ...base,
      state: 'unavailable',
      note: 'No model is configured to assess acceptance criteria on this deployment.',
    })
  }
  try {
    const result = await renderedResult(deps, input, records)
    const { reply, model } = await assessor.assess({
      workspaceId: input.workspaceId,
      block: input.task,
      stage: { id: input.stage.id, title: input.stage.title },
      criteria,
      result,
    })
    return computeStageAcceptance({ ...base, model, result, reply })
  } catch (error) {
    return unassessedStageAcceptance({ ...base, state: 'failed', note: getErrorMessage(error) })
  }
}

/** The stage's result up to and including the outcome, as its handler renders it for a reader. */
async function renderedResult(
  deps: StageAcceptanceDeps,
  input: StageAcceptanceInput,
  records: Awaited<ReturnType<StageAcceptanceDeps['records']['listStageTasks']>>,
): Promise<string> {
  const envelopes = await deps.records.listOutcomes(input.project.id)
  const rows = stageResultRows(input.stage, records, envelopes, input.outcome)
  const outcomes = (await deps.outcomes.bodiesOf(input.project, rows)).flatMap(
    (stored) => tryDecodeOutcome(deps.modules, input.project.kind, stored) ?? [],
  )
  return renderStageResult({
    modules: deps.modules,
    kind: input.project.kind,
    definition: input.definition,
    inputs: input.inputs,
    stage: input.stage,
    outcomes,
  }).body
}
