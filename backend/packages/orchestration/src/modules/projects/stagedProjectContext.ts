import {
  deriveProjectStageStates,
  type ProjectDefinition,
  type ProjectStage,
  type ProjectStageTask,
} from '@cat-factory/contracts'
import type {
  DecodedProjectOutcome,
  ProjectContextRendering,
  ProjectKindModuleRegistry,
  ProjectOutcomeRow,
} from '@cat-factory/kernel'
import { demoteHeadings, renderStageResult } from './stageRendering.js'
import { stageResultRows } from './stageUpstream.js'

// A STAGED project's current result as linked context for another task: each stage's ACCEPTED
// result, rendered by the handler of the task type that wrote it, in the definition's order. A
// stage with no accepted result yet is stated, never left out, and a result still awaiting its
// checkpoint is not one. Design: `docs/initiatives/staged-project-definitions.md`.

/** What a staged project's result is made of: per stage, its accepted result and its rows. */
export interface StagedSelection {
  stages: {
    stage: ProjectStage
    accepted: { id: string; seq: number } | null
    rows: ProjectOutcomeRow[]
  }[]
}

/** Which outcomes make up each stage's accepted result, read from envelopes alone. */
export function selectStagedResult(
  definition: ProjectDefinition,
  records: readonly ProjectStageTask[],
  envelopes: readonly ProjectOutcomeRow[],
): StagedSelection {
  const states = deriveProjectStageStates({
    stages: definition.stages,
    stageTasks: records,
    // Liveness decides only which task is still running; an accepted result stands regardless.
    liveTaskIds: new Set(records.map((r) => r.taskId)),
    outcomes: envelopes,
  })
  return {
    stages: definition.stages.map((stage, i) => {
      const accepted = states[i]!.accepted
      return {
        stage,
        accepted: accepted ? { id: accepted.id, seq: accepted.seq } : null,
        rows: accepted ? stageResultRows(stage, records, envelopes, accepted) : [],
      }
    }),
  }
}

/** Whether a staged project has a result to read: some stage has an accepted one. */
export function hasStagedResult(selection: StagedSelection): boolean {
  return selection.stages.some((s) => s.accepted !== null)
}

/**
 * The rendering, and the revision it reflects: every stage's accepted outcome, so two readings
 * built from different accepted results never share one revision id.
 */
export function renderStagedProject(input: {
  modules: ProjectKindModuleRegistry
  kind: string
  definition: ProjectDefinition
  inputs: Record<string, unknown>
  selection: StagedSelection
  /** The bodies of the selected rows, decoded by their handlers, by id. */
  decoded: ReadonlyMap<string, DecodedProjectOutcome>
}): { rendering: ProjectContextRendering; revision: { id: string; seq: number } | null } {
  const sections: string[] = []
  const coverage: string[] = []
  const accepted: { id: string; seq: number }[] = []
  for (const { stage, accepted: result, rows } of input.selection.stages) {
    sections.push(`## Stage ${stage.title}`, '')
    if (!result) {
      sections.push('No accepted result yet.', '')
      coverage.push(`${stage.title}: no accepted result`)
      continue
    }
    const rendering = renderStageResult({
      modules: input.modules,
      kind: input.kind,
      definition: input.definition,
      inputs: input.inputs,
      stage,
      outcomes: rows.flatMap((row) => input.decoded.get(row.id) ?? []),
    })
    sections.push(demoteHeadings(rendering.body), '')
    coverage.push(`${stage.title}: ${rendering.coverage}`)
    accepted.push(result)
  }
  const total = input.selection.stages.length
  return {
    rendering: {
      summary: `${accepted.length} of ${total} stage(s) have an accepted result.`,
      coverage: coverage.join('; '),
      body: sections.join('\n'),
    },
    revision: accepted.length
      ? {
          id: accepted.map((a) => a.id).join('+'),
          seq: Math.max(...accepted.map((a) => a.seq)),
        }
      : null,
  }
}
