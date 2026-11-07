import type { Project, ProjectKindData } from '@cat-factory/contracts'

/** A project's current result, rendered for an agent that reads it as linked context. */
export interface ProjectContextEntry {
  /** One line for the in-prompt index. */
  summary: string
  /** How complete the result is, in one line. */
  coverage: string
  /** The full result as Markdown, materialised as a file. */
  body: string
  /** The latest result the body includes, recorded on the step that read it. */
  revision: { id: string; seq: number } | null
}

/**
 * What a kind keeping project-level data contributes when a task links one of its projects. The
 * kind decides what its result is, so the next kind plugs in here rather than in the resolver.
 */
export interface ProjectContextContributor {
  /** Which of these projects have a result to read yet. */
  withResult(projects: readonly Project[]): Promise<Set<string>>
  /** Each project's current result. Throws when one cannot be read, so the run naming it breaks. */
  render(projects: readonly Project[]): Promise<Map<string, ProjectContextEntry>>
}

/** One contributor per kind of project data. A kind keeping none contributes nothing. */
export type ProjectContextContributors = Record<ProjectKindData, ProjectContextContributor>
