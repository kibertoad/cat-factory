import type {
  Project,
  ProjectDefinition,
  ProjectPin,
  ProjectStageTask,
} from '@cat-factory/contracts'
import {
  type ProjectContextRendering,
  type ProjectDefinitionSource,
  type ProjectKindModuleRegistry,
  type ProjectOutcomeRow,
  type ProjectRecordRepository,
  redactSecrets,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { decodeOutcome } from './outcomeDecoding.js'
import {
  hasStagedResult,
  renderStagedProject,
  selectStagedResult,
  type StagedSelection,
} from './stagedProjectContext.js'
import { renderLatestOutcomes } from './stageRendering.js'

/** A project's current result, rendered for an agent that reads it as linked context. */
export interface ProjectContextEntry extends ProjectContextRendering {
  /** The outcomes the body reflects, recorded on the step that read it. */
  revision: { id: string; seq: number } | null
}

/** What a task reads of the projects it links, for every kind. */
export interface ProjectContextContributor {
  /** Which of these projects have a result to read yet. */
  withResult(projects: readonly Project[]): Promise<Set<string>>
  /** Each project's current result. Throws when one cannot be read, so the run naming it breaks. */
  render(projects: readonly Project[]): Promise<Map<string, ProjectContextEntry>>
}

export interface ProjectContextDeps {
  records: Pick<
    ProjectRecordRepository,
    'listPins' | 'projectsWithOutcomes' | 'listStageTasksOfProjects'
  >
  outcomes: Pick<ProjectOutcomeStore, 'envelopesOfProjects' | 'bodiesOfProjects'>
  definitions: ProjectDefinitionSource
  modules: ProjectKindModuleRegistry
}

/** How one project's result is read: through its stages, through its kind, or not at all. */
type Reading =
  | { kind: 'staged'; definition: ProjectDefinition; selection: StagedSelection }
  | { kind: 'unstaged'; definition: ProjectDefinition | null }
  | { kind: 'definition_missing'; pin: ProjectPin }

/**
 * Linked context for every project kind. A STAGED project has a result once some stage has an
 * accepted one, and reads as its stages' accepted results (`stagedProjectContext.ts`). Any other
 * project has a result once it holds one outcome; its kind's module renders it (`renderContext`)
 * from the outcomes its handlers decoded and the pinned definition, and a kind without one
 * contributes the newest outcome of each stream as recorded. A project pinned to a definition this
 * process cannot resolve is stated as such. Only the bodies a rendering uses are read, and an
 * offloaded one that cannot be read throws `outcome_body_unavailable` out of the store, which
 * breaks the run naming the project. Everything rendered is scrubbed of secrets.
 */
export function projectContextContributor(deps: ProjectContextDeps): ProjectContextContributor {
  return {
    async withResult(projects) {
      const pinOf = await pinsOf(deps, projects)
      const definitions = await definitionsOf(deps.definitions, projects, pinOf)
      const staged = projects.filter((p) => definitions.get(p.id)?.stages.length)
      const others = projects.filter((p) => !staged.includes(p))
      const [withOutcomes, { readings }] = await Promise.all([
        others.length ? deps.records.projectsWithOutcomes(others.map((p) => p.id)) : [],
        readingsOf(deps, staged, pinOf, definitions),
      ])
      const result = new Set(withOutcomes)
      for (const [id, reading] of readings) {
        if (reading.kind === 'staged' && hasStagedResult(reading.selection)) result.add(id)
      }
      return result
    },
    async render(projects) {
      const pinOf = await pinsOf(deps, projects)
      const definitions = await definitionsOf(deps.definitions, projects, pinOf)
      const { readings, envelopes } = await readingsOf(deps, projects, pinOf, definitions)
      const rowsOf = new Map(
        projects.map((p) => [p.id, rowsToRead(readings.get(p.id)!, envelopes.get(p.id) ?? [])]),
      )
      const bodies = await deps.outcomes.bodiesOfProjects(projects, rowsOf)
      const rendered = new Map<string, ProjectContextEntry>()
      for (const project of projects) {
        const outcomes = (bodies.get(project.id) ?? []).map((o) =>
          decodeOutcome(deps.modules, project.kind, o),
        )
        const reading = readings.get(project.id)!
        const inputs = pinOf.get(project.id)?.inputs ?? {}
        let rendering: ProjectContextRendering
        let revision: { id: string; seq: number } | null
        if (reading.kind === 'staged') {
          const staged = renderStagedProject({
            modules: deps.modules,
            kind: project.kind,
            definition: reading.definition,
            inputs,
            selection: reading.selection,
            decoded: new Map(outcomes.map((o) => [o.id, o] as const)),
          })
          ;({ rendering, revision } = staged)
        } else if (reading.kind === 'definition_missing') {
          rendering = missingDefinition(reading.pin)
          revision = null
        } else {
          const input = { definition: reading.definition, inputs, outcomes }
          rendering =
            deps.modules.get(project.kind)?.renderContext?.(input) ?? renderLatestOutcomes(outcomes)
          const latest = outcomes.at(-1)
          revision = latest ? { id: latest.id, seq: latest.seq } : null
        }
        rendered.set(project.id, {
          summary: redactSecrets(rendering.summary) ?? '',
          coverage: redactSecrets(rendering.coverage) ?? '',
          body: redactSecrets(rendering.body) ?? '',
          revision,
        })
      }
      return rendered
    },
  }
}

async function pinsOf(
  deps: ProjectContextDeps,
  projects: readonly Project[],
): Promise<Map<string, ProjectPin>> {
  if (projects.length === 0) return new Map()
  const pins = await deps.records.listPins(projects.map((p) => p.id))
  return new Map(pins.map((pin) => [pin.projectId, pin] as const))
}

/**
 * How each project is read, with every project's envelopes. Stage records and envelopes come from
 * one read each, whatever the number of projects.
 */
async function readingsOf(
  deps: ProjectContextDeps,
  projects: readonly Project[],
  pinOf: ReadonlyMap<string, ProjectPin>,
  definitions: ReadonlyMap<string, ProjectDefinition>,
): Promise<{ readings: Map<string, Reading>; envelopes: Map<string, ProjectOutcomeRow[]> }> {
  const staged = projects.filter((p) => definitions.get(p.id)?.stages.length)
  const [envelopes, stageTasks] = await Promise.all([
    projects.length
      ? deps.outcomes.envelopesOfProjects(projects)
      : new Map<string, ProjectOutcomeRow[]>(),
    staged.length ? deps.records.listStageTasksOfProjects(staged.map((p) => p.id)) : [],
  ])
  const tasksOf = new Map<string, ProjectStageTask[]>()
  for (const task of stageTasks) {
    tasksOf.set(task.projectId, [...(tasksOf.get(task.projectId) ?? []), task])
  }
  const readings = new Map<string, Reading>()
  for (const project of projects) {
    const definition = definitions.get(project.id) ?? null
    const pin = pinOf.get(project.id)
    if (pin && !definition) readings.set(project.id, { kind: 'definition_missing', pin })
    else if (definition?.stages.length) {
      const selection = selectStagedResult(
        definition,
        tasksOf.get(project.id) ?? [],
        envelopes.get(project.id) ?? [],
      )
      readings.set(project.id, { kind: 'staged', definition, selection })
    } else readings.set(project.id, { kind: 'unstaged', definition })
  }
  return { readings, envelopes }
}

/** The envelopes whose bodies a reading renders: none for a missing definition. */
function rowsToRead(
  reading: Reading,
  envelopes: readonly ProjectOutcomeRow[],
): ProjectOutcomeRow[] {
  if (reading.kind === 'staged') return reading.selection.stages.flatMap((s) => s.rows)
  if (reading.kind === 'definition_missing') return []
  return [...envelopes]
}

function missingDefinition(pin: ProjectPin): ProjectContextRendering {
  const note =
    `This project is pinned to definition '${pin.definitionKey}' version ` +
    `${pin.definitionVersion}, which this deployment cannot resolve, so its result cannot be read.`
  return { summary: note, coverage: 'definition unavailable', body: note }
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
