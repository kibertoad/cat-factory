import {
  deriveProjectStageStates,
  type ProjectDefinition,
  type ProjectStageTask,
} from '@cat-factory/contracts'
import type {
  DecodedProjectOutcome,
  ProjectContextRendering,
  ProjectKindModuleRegistry,
  ProjectOutcomeRow,
} from '@cat-factory/kernel'
import { renderLatestOutcomes } from './projectContext.js'
import { stageResultRows } from './stageUpstream.js'

// A STAGED project's current result as linked context for another task: each stage's accepted
// result, rendered by the handler of the task type that wrote it, in the definition's order. A
// stage with no accepted result yet is stated, never left out. Design:
// `docs/initiatives/staged-project-definitions.md`.

export interface StagedProjectInput {
  modules: ProjectKindModuleRegistry
  kind: string
  definition: ProjectDefinition
  inputs: Record<string, unknown>
  records: readonly ProjectStageTask[]
  envelopes: readonly ProjectOutcomeRow[]
  /** Every outcome of the project, decoded by its handler, by id. */
  decoded: ReadonlyMap<string, DecodedProjectOutcome>
}

/** The rendering, and the newest accepted outcome it includes. */
export function renderStagedProject(input: StagedProjectInput): {
  rendering: ProjectContextRendering
  revision: { id: string; seq: number } | null
} {
  const { definition } = input
  const states = deriveProjectStageStates({
    stages: definition.stages,
    stageTasks: input.records,
    // Liveness decides only which task is still running; an accepted result stands regardless.
    liveTaskIds: new Set(input.records.map((r) => r.taskId)),
    outcomes: input.envelopes,
  })
  const sections: string[] = []
  const coverage: string[] = []
  let revision: { id: string; seq: number } | null = null
  definition.stages.forEach((stage, i) => {
    const accepted = states[i]!.accepted
    if (!accepted) {
      sections.push(`## Stage ${stage.title}`, '', 'No accepted result yet.', '')
      coverage.push(`${stage.title}: no accepted result`)
      return
    }
    const outcomes = stageResultRows(stage, input.records, input.envelopes, accepted).flatMap(
      (row) => input.decoded.get(row.id) ?? [],
    )
    const handler = input.modules.handlerOf(input.kind, stage.taskType)
    const rendering =
      handler?.renderContext?.({
        definition,
        inputs: input.inputs,
        stage: { id: stage.id, title: stage.title, config: stage.config },
        outcomes,
      }) ?? renderLatestOutcomes(outcomes)
    sections.push(`## Stage ${stage.title}`, '', rendering.body, '')
    coverage.push(`${stage.title}: ${rendering.coverage}`)
    if (!revision || accepted.seq > revision.seq) revision = { id: accepted.id, seq: accepted.seq }
  })
  const done = states.filter((s) => s.accepted).length
  return {
    rendering: {
      summary: `${done} of ${definition.stages.length} stage(s) have an accepted result.`,
      coverage: coverage.join('; '),
      body: sections.join('\n'),
    },
    revision,
  }
}
