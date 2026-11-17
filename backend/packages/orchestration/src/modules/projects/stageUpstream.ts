import {
  type Project,
  type ProjectDefinition,
  type ProjectStage,
  type ProjectStageTask,
  REVISION_INTENT,
} from '@cat-factory/contracts'
import {
  type DecodedProjectOutcome,
  type ProjectContextRendering,
  type ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectUpstreamContext,
  ValidationError,
  redactSecrets,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'
import { renderLatestOutcomes } from './projectContext.js'

// What a staged task reads of the stages its stage consumes. It reads exactly the upstream results
// its stage task STARTED from (the `basis` recorded when the task was created), so what it read is
// what `stale` later compares against, each rendered by the handler of the task type that wrote
// the stream. Design: `docs/initiatives/staged-project-definitions.md`.

export interface StageUpstreamDeps {
  outcomes: Pick<ProjectOutcomeStore, 'bodiesOf'>
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
  /** Every outcome envelope of the project, as the dispatch already listed them. */
  envelopes: readonly ProjectOutcomeRow[]
  /** Outcomes the dispatch already decoded, reused rather than read again. */
  decoded: readonly DecodedProjectOutcome[]
}

/**
 * Each consumed stage's result up to the outcome the task started from, rendered and scrubbed of
 * secrets. A consumed stage with no accepted result at that time is STATED as such, never left
 * out, so the agent cannot read silence as an empty result; a result it started from that cannot
 * be read now refuses the dispatch naming the stage. Reads only the bodies the dispatch has not
 * already decoded.
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
  const envelopes = new Map(task.envelopes.map((row) => [row.id, row] as const))
  const read = new Map(consumed.map((u) => [u.id, readableRows(u, task, envelopes)] as const))
  const known = new Map(task.decoded.map((o) => [o.id, o] as const))
  const missing = [...read.values()].flatMap((r) => r.rows).filter((row) => !known.has(row.id))
  for (const stored of await deps.outcomes.bodiesOf(task.project, missing)) {
    const decoded = tryDecodeOutcome(deps.modules, task.project.kind, stored)
    if (!decoded) {
      const upstream = consumed.find((u) => u.produces === stored.row.stream)
      throw unreadable(upstream?.id ?? stored.row.stream, stored.row.id)
    }
    known.set(decoded.id, decoded)
  }
  return consumed.map((upstream): ProjectUpstreamContext => {
    const { basisId, basis, rows } = read.get(upstream.id)!
    const entry = {
      stageId: upstream.id,
      projectId: task.project.id,
      kind: task.project.kind,
      title: `Stage ${upstream.title}`,
    }
    if (basisId && !basis) throw unreadable(upstream.id, basisId)
    if (!basis) {
      const note = `Stage '${upstream.title}' had no accepted result when this task started.`
      return { ...entry, revision: null, summary: note, coverage: 'no accepted result', body: note }
    }
    const outcomes = rows.map((row) => known.get(row.id)!)
    const handler = deps.modules.handlerOf(task.project.kind, upstream.taskType)
    const rendering: ProjectContextRendering =
      handler?.renderContext?.({
        definition: task.definition,
        inputs: task.inputs,
        stage: { id: upstream.id, title: upstream.title, config: upstream.config },
        outcomes,
      }) ?? renderLatestOutcomes(outcomes)
    return {
      ...entry,
      revision: { id: basis.id, seq: basis.seq },
      summary: redactSecrets(rendering.summary) ?? '',
      coverage: redactSecrets(rendering.coverage) ?? '',
      body: redactSecrets(rendering.body) ?? '',
    }
  })
}

/** A consumed result the task started from that cannot be read: the run refuses, naming it. */
function unreadable(stageId: string, outcomeId: string): ValidationError {
  return new ValidationError(
    `The result of stage '${stageId}' this task started from cannot be read`,
    { reason: 'project_stage_upstream_unreadable', stageId, outcomeId },
  )
}

/**
 * The outcomes of `upstream`'s stream its own tasks wrote, up to the one the task started from.
 * `basisId` names that outcome (null when the stage had no accepted result then), and `basis` is
 * its envelope, or null when that envelope is gone.
 */
function readableRows(
  upstream: ProjectStage,
  task: StagedTask,
  envelopes: ReadonlyMap<string, ProjectOutcomeRow>,
): { basisId: string | null; basis: ProjectOutcomeRow | null; rows: ProjectOutcomeRow[] } {
  const basisId = task.record.basis[upstream.id] ?? null
  const basis = basisId ? (envelopes.get(basisId) ?? null) : null
  if (!basis) return { basisId, basis: null, rows: [] }
  const writers = new Set(
    task.records.filter((r) => r.stageId === upstream.id).map((r) => r.taskId),
  )
  // A revision counts only once an acceptance named it; one written by a losing acceptance is not
  // the stage's result and never reaches a later stage.
  const accepted = new Set(task.records.flatMap((r) => r.acceptedOutcomeId ?? []))
  const rows = [...envelopes.values()].filter(
    (row) =>
      row.stream === upstream.produces &&
      row.taskId !== null &&
      writers.has(row.taskId) &&
      row.seq <= basis.seq &&
      (row.intent !== REVISION_INTENT || accepted.has(row.id)),
  )
  return { basisId, basis, rows }
}
