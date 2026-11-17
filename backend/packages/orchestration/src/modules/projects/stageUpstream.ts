import type {
  Project,
  ProjectDefinition,
  ProjectStage,
  ProjectStageTask,
} from '@cat-factory/contracts'
import {
  type ProjectContextRendering,
  type ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  type ProjectUpstreamContext,
  redactSecrets,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { decodeOutcome } from './outcomeDecoding.js'
import { renderLatestOutcomes } from './projectContext.js'

// What a staged task reads of the stages its stage consumes. It reads exactly the upstream results
// its stage task STARTED from (the `basis` recorded when the task was created), so what it read is
// what `stale` later compares against, each rendered by the handler of the task type that wrote
// the stream. Design: `docs/initiatives/staged-project-definitions.md`.

export interface StageUpstreamDeps {
  records: Pick<ProjectRecordRepository, 'listOutcomes'>
  outcomes: Pick<ProjectOutcomeStore, 'list'>
  modules: ProjectKindModuleRegistry
}

export interface StagedTask {
  project: Project
  definition: ProjectDefinition
  inputs: Record<string, unknown>
  stage: ProjectStage
  /** The task's own stage-task record, which carries the basis. */
  record: ProjectStageTask
  /** Every stage-task record of the project, to know which task wrote which result. */
  records: readonly ProjectStageTask[]
}

/**
 * Each consumed stage's result up to the outcome the task started from, rendered and scrubbed of
 * secrets. A consumed stage with no accepted result at that time is STATED as such, never left
 * out, so the agent cannot read silence as an empty result. Reads every outcome envelope once and
 * only the bodies it renders.
 */
export async function renderStageUpstream(
  deps: StageUpstreamDeps,
  task: StagedTask,
): Promise<ProjectUpstreamContext[]> {
  const consumed = task.stage.consumes.flatMap(({ stage }) => {
    const upstream = task.definition.stages.find((s) => s.id === stage)
    return upstream ? [upstream] : []
  })
  if (consumed.length === 0) return []
  const envelopes = new Map(
    (await deps.records.listOutcomes(task.project.id)).map((row) => [row.id, row] as const),
  )
  const read = new Map(consumed.map((u) => [u.id, readableRows(u, task, envelopes)] as const))
  const wanted = new Set([...read.values()].flatMap((r) => r.rows.map((row) => row.id)))
  const stored = wanted.size
    ? await deps.outcomes.list(task.project, (row) => wanted.has(row.id))
    : []
  const decoded = stored.map((outcome) => decodeOutcome(deps.modules, task.project.kind, outcome))
  return consumed.map((upstream): ProjectUpstreamContext => {
    const { basis } = read.get(upstream.id)!
    const title = `Stage ${upstream.title}`
    if (!basis) {
      const note = `Stage '${upstream.title}' had no accepted result when this task started.`
      return {
        stageId: upstream.id,
        title,
        revision: null,
        summary: note,
        coverage: 'no accepted result',
        body: note,
      }
    }
    const outcomes = decoded.filter(
      (o) => o.stream === upstream.produces && o.seq <= basis.seq && wanted.has(o.id),
    )
    const handler = deps.modules.handlerOf(task.project.kind, upstream.taskType)
    const rendering: ProjectContextRendering =
      handler?.renderContext?.({
        definition: task.definition,
        inputs: task.inputs,
        stage: { id: upstream.id, title: upstream.title, config: upstream.config },
        outcomes,
      }) ?? renderLatestOutcomes(outcomes)
    return {
      stageId: upstream.id,
      title,
      revision: { id: basis.id, seq: basis.seq },
      summary: redactSecrets(rendering.summary) ?? '',
      coverage: redactSecrets(rendering.coverage) ?? '',
      body: redactSecrets(rendering.body) ?? '',
    }
  })
}

/**
 * The outcomes of `upstream`'s stream its own tasks wrote, up to the one the task started from.
 * `basis` is that outcome, or null when the stage had no accepted result then.
 */
function readableRows(
  upstream: ProjectStage,
  task: StagedTask,
  envelopes: ReadonlyMap<string, ProjectOutcomeRow>,
): { basis: ProjectOutcomeRow | null; rows: ProjectOutcomeRow[] } {
  const basisId = task.record.basis[upstream.id] ?? null
  const basis = basisId ? (envelopes.get(basisId) ?? null) : null
  if (!basis) return { basis: null, rows: [] }
  const writers = new Set(
    task.records.filter((r) => r.stageId === upstream.id).map((r) => r.taskId),
  )
  const rows = [...envelopes.values()].filter(
    (row) =>
      row.stream === upstream.produces &&
      row.taskId !== null &&
      writers.has(row.taskId) &&
      row.seq <= basis.seq,
  )
  return { basis, rows }
}
