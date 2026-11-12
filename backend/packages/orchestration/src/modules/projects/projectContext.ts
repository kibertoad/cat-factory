import type { Project, ProjectDefinition, ProjectOutcome } from '@cat-factory/contracts'
import {
  type ProjectContextRendering,
  type ProjectDefinitionSource,
  type ProjectKindModule,
  type ProjectKindModuleRegistry,
  type ProjectRecordRepository,
  redactSecrets,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore, StoredOutcome } from './ProjectOutcomeStore.js'

/** A project's current result, rendered for an agent that reads it as linked context. */
export interface ProjectContextEntry extends ProjectContextRendering {
  /** The latest outcome the body includes, recorded on the step that read it. */
  revision: { id: string; seq: number } | null
}

/** What a task reads of the projects it links, for every kind. */
export interface ProjectContextContributor {
  /** Which of these projects have a result to read yet: at least one outcome. */
  withResult(projects: readonly Project[]): Promise<Set<string>>
  /** Each project's current result. Throws when one cannot be read, so the run naming it breaks. */
  render(projects: readonly Project[]): Promise<Map<string, ProjectContextEntry>>
}

export interface ProjectContextDeps {
  records: Pick<ProjectRecordRepository, 'listPins' | 'projectsWithOutcomes'>
  outcomes: Pick<ProjectOutcomeStore, 'listOfProjects'>
  definitions: ProjectDefinitionSource
  modules: ProjectKindModuleRegistry
}

/**
 * Linked context for every project kind. A project has a result once it holds one outcome. Its
 * kind's module renders it (`renderContext`) from the decoded outcomes and the pinned definition;
 * a kind without one, or with no module in this process, contributes the newest outcome of each
 * stream as recorded. An offloaded body that cannot be read throws `outcome_body_unavailable` out
 * of the store, which breaks the run naming the project. Everything rendered is scrubbed of
 * secrets before it reaches an agent.
 */
export function projectContextContributor(deps: ProjectContextDeps): ProjectContextContributor {
  return {
    async withResult(projects) {
      return new Set(await deps.records.projectsWithOutcomes(projects.map((p) => p.id)))
    },
    async render(projects) {
      const [pins, stored] = await Promise.all([
        deps.records.listPins(projects.map((p) => p.id)),
        deps.outcomes.listOfProjects(projects),
      ])
      const pinOf = new Map(pins.map((pin) => [pin.projectId, pin] as const))
      const definitions = await definitionsOf(deps.definitions, projects, pinOf)
      const rendered = new Map<string, ProjectContextEntry>()
      for (const project of projects) {
        const module = deps.modules.get(project.kind)
        const outcomes = (stored.get(project.id) ?? []).map((o) => decode(module, o))
        const input = {
          definition: definitions.get(project.id) ?? null,
          inputs: pinOf.get(project.id)?.inputs ?? {},
          outcomes,
        }
        const rendering = module?.renderContext?.(input) ?? renderLatest(outcomes)
        const latest = outcomes.at(-1)
        rendered.set(project.id, {
          summary: redactSecrets(rendering.summary) ?? '',
          coverage: redactSecrets(rendering.coverage) ?? '',
          body: redactSecrets(rendering.body) ?? '',
          revision: latest ? { id: latest.id, seq: latest.seq } : null,
        })
      }
      return rendered
    },
  }
}

/** Each pinned project's definition, from one list read per account and kind. */
async function definitionsOf(
  source: ProjectDefinitionSource,
  projects: readonly Project[],
  pinOf: ReadonlyMap<string, { definitionKey: string; definitionVersion: number }>,
): Promise<Map<string, ProjectDefinition>> {
  const pinned = projects.filter((p) => pinOf.has(p.id))
  const scopes = [...new Set(pinned.map((p) => `${p.accountId ?? ''}\u0000${p.kind}`))]
  const lists = await Promise.all(
    scopes.map((scope) => {
      const [account, kind] = scope.split('\u0000') as [string, string]
      return source.list(account, kind)
    }),
  )
  const byScope = new Map(scopes.map((scope, i) => [scope, lists[i] ?? []] as const))
  const result = new Map<string, ProjectDefinition>()
  for (const project of pinned) {
    const pin = pinOf.get(project.id)!
    const found = byScope
      .get(`${project.accountId ?? ''}\u0000${project.kind}`)
      ?.find(
        (d) =>
          d.definition.key === pin.definitionKey && d.definition.version === pin.definitionVersion,
      )
    if (found) result.set(project.id, found.definition)
  }
  return result
}

function decode(module: ProjectKindModule<unknown> | undefined, { row, json }: StoredOutcome) {
  const raw = JSON.parse(json) as unknown
  const body = module ? module.parseOutcome(row.schemaVersion, raw) : raw
  if (body === undefined) throw new Error(`Outcome '${row.id}' holds an unreadable body`)
  const { body: _ref, bodyBytes: _bytes, ...meta } = row
  return { ...meta, body } satisfies ProjectOutcome
}

/** The newest outcome of each stream as recorded, for a kind that renders no context itself. */
function renderLatest(outcomes: readonly ProjectOutcome[]): ProjectContextRendering {
  const latest = new Map<string, ProjectOutcome>()
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

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
}
