import type { ProjectDefinition, ProjectStage } from '@cat-factory/contracts'
import type {
  DecodedProjectOutcome,
  ProjectContextRendering,
  ProjectKindModuleRegistry,
} from '@cat-factory/kernel'

// How a project's outcomes read as context for another agent, shared by every reader: the newest
// outcome of each stream for a kind that renders nothing itself, and one stage's result through
// the handler of the task type that wrote it.

/** The newest outcome of each stream as recorded, for a kind that renders no context itself. */
export function renderLatestOutcomes(
  outcomes: readonly DecodedProjectOutcome[],
): ProjectContextRendering {
  const latest = new Map<string, DecodedProjectOutcome>()
  for (const outcome of outcomes) latest.set(outcome.stream, outcome)
  const lines: string[] = []
  for (const [stream, outcome] of latest) {
    const json = JSON.stringify(outcome.body, null, 2)
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(json) + 1))
    lines.push(`## ${stream} (outcome ${outcome.seq}, ${outcome.intent})`, '', `${fence}json`)
    lines.push(json, fence, '')
  }
  return {
    summary: `${outcomes.length} outcome(s) recorded.`,
    coverage: `${outcomes.length} outcome(s) across ${latest.size} stream(s)`,
    body: lines.join('\n'),
  }
}

/** One stage's result, rendered by its task type's handler, or as recorded when it renders none. */
export function renderStageResult(input: {
  modules: ProjectKindModuleRegistry
  kind: string
  definition: ProjectDefinition
  inputs: Record<string, unknown>
  stage: ProjectStage
  outcomes: readonly DecodedProjectOutcome[]
}): ProjectContextRendering {
  const { stage } = input
  const handler = input.modules.handlerOf(input.kind, stage.taskType)
  return (
    handler?.renderContext?.({
      definition: input.definition,
      inputs: input.inputs,
      stage: { id: stage.id, title: stage.title, config: stage.config },
      outcomes: input.outcomes,
    }) ?? renderLatestOutcomes(input.outcomes)
  )
}

/**
 * Markdown with every heading one level deeper, outside code fences, so a rendering nests under a
 * heading of its own without its sections reading as siblings of it.
 */
export function demoteHeadings(markdown: string): string {
  let fence: string | null = null
  return markdown
    .split('\n')
    .map((line) => {
      const opening = /^(`{3,}|~{3,})/.exec(line)?.[1]
      if (opening) {
        if (fence === null) fence = opening
        else if (line.startsWith(fence)) fence = null
        return line
      }
      return fence === null && /^#{1,5} /.test(line) ? `#${line}` : line
    })
    .join('\n')
}

export function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}
