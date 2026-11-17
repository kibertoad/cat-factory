import * as v from 'valibot'
import { taskTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Project stages: the ordered steps a project definition may declare, each running one task type
// and writing one outcome stream, with earlier stages feeding later ones. A definition without
// stages runs its tasks in any order. A stage's state is DERIVED from the project's
// outcomes and the stage-task records (which task belongs to which stage, and when a person
// cleared its checkpoint); nothing else about a stage is stored. Design:
// `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** The slug project stages, outcome streams and outcome intents are named with. */
export const projectSlugSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9-]{0,39}$/, 'must be a lowercase slug'),
)

export const PROJECT_STAGES_MAX = 30
export const PROJECT_STAGE_TITLE_MAX = 200
export const PROJECT_STAGE_DESCRIPTION_MAX = 4000

/** A stage id, unique within its definition. */
export const projectStageIdSchema = projectSlugSchema

/** An upstream stage whose result a stage's tasks read. */
export const projectStageInputSchema = v.object({ stage: projectStageIdSchema })
export type ProjectStageInput = v.InferOutput<typeof projectStageInputSchema>

export const projectStageSchema = v.object({
  id: projectStageIdSchema,
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROJECT_STAGE_TITLE_MAX)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(PROJECT_STAGE_DESCRIPTION_MAX))),
  /** The task type a task of this stage runs; its project kind must offer it. */
  taskType: taskTypeSchema,
  /** The stages that must each have an accepted result before this one may start. */
  after: v.optional(v.array(projectStageIdSchema), []),
  /** The upstream stages whose results this stage's tasks read, each among `after`'s ancestry. */
  consumes: v.optional(v.array(projectStageInputSchema), []),
  /** The outcome stream this stage's tasks write; no two stages share one. */
  produces: projectSlugSchema,
  /** `auto` starts a task as soon as the stage is ready; `manual` waits for a person. */
  start: v.optional(v.picklist(['auto', 'manual']), 'manual'),
  /** A person accepts each result before stages after this one count it. */
  checkpoint: v.optional(v.boolean(), false),
  /** Whether a stage with an accepted result may run again. */
  repeatable: v.optional(v.boolean(), false),
  /**
   * Whether this stage's runs may write to the targets that allow writes. Every other run is
   * read-only. A writing stage must run after a stage whose result a person accepts at a
   * checkpoint, so nothing is written before a person has seen what will be.
   */
  writes: v.optional(v.boolean(), false),
  /** What the stage's task handler is configured with, validated by that handler. */
  config: v.optional(v.unknown()),
})
export type ProjectStage = v.InferOutput<typeof projectStageSchema>

/** Every structural problem with a definition's stages, one line each. */
export function projectStageIssues(stages: readonly ProjectStage[]): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  const streams = new Map<string, string>()
  for (const stage of stages) {
    if (ids.has(stage.id)) issues.push(`stage ids must be unique: '${stage.id}' repeats`)
    ids.add(stage.id)
    const owner = streams.get(stage.produces)
    if (owner) {
      issues.push(`stages '${owner}' and '${stage.id}' both produce the stream '${stage.produces}'`)
    }
    streams.set(stage.produces, stage.id)
  }
  for (const stage of stages) {
    for (const upstream of stage.after) {
      if (!ids.has(upstream))
        issues.push(`stage '${stage.id}' runs after unknown stage '${upstream}'`)
    }
  }
  const cycle = findCycle(stages)
  if (cycle) issues.push(`stages run after each other in a cycle: ${cycle.join(' -> ')}`)
  else {
    const checkpointed = new Set(stages.filter((s) => s.checkpoint).map((s) => s.id))
    for (const stage of stages) {
      const ancestry = ancestorsOf(stages, stage.id)
      if (stage.writes && ![...ancestry].some((id) => checkpointed.has(id))) {
        issues.push(
          `stage '${stage.id}' writes, so it must run after a stage a person accepts at a checkpoint`,
        )
      }
      const read = stage.consumes.map((c) => c.stage)
      for (const repeated of new Set(read.filter((id, i) => read.indexOf(id) !== i))) {
        issues.push(`stage '${stage.id}' reads stage '${repeated}' more than once`)
      }
      for (const input of stage.consumes) {
        if (!ancestry.has(input.stage)) {
          issues.push(
            `stage '${stage.id}' reads stage '${input.stage}', which it does not run after`,
          )
        }
      }
    }
  }
  return issues
}

/** The stages `id` runs after, directly or through others. Assumes no cycle. */
export function ancestorsOf(stages: readonly ProjectStage[], id: string): Set<string> {
  const byId = new Map(stages.map((s) => [s.id, s] as const))
  const seen = new Set<string>()
  const visit = (current: string) => {
    for (const upstream of byId.get(current)?.after ?? []) {
      if (seen.has(upstream)) continue
      seen.add(upstream)
      visit(upstream)
    }
  }
  visit(id)
  return seen
}

function findCycle(stages: readonly ProjectStage[]): string[] | null {
  const byId = new Map(stages.map((s) => [s.id, s] as const))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null
    if (state.get(id) === 'visiting') return [...path.slice(path.indexOf(id)), id]
    state.set(id, 'visiting')
    path.push(id)
    for (const upstream of byId.get(id)?.after ?? []) {
      if (!byId.has(upstream)) continue
      const found = visit(upstream)
      if (found) return found
    }
    path.pop()
    state.set(id, 'done')
    return null
  }
  for (const stage of stages) {
    const found = visit(stage.id)
    if (found) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Derived stage state
// ---------------------------------------------------------------------------

/** Which stage a task belongs to, and when a person cleared the checkpoint on its result. */
export const projectStageTaskSchema = v.object({
  taskId: v.string(),
  projectId: v.string(),
  stageId: projectStageIdSchema,
  createdAt: v.number(),
  /** When the task recorded its outcome; null while it has none, which holds its stage's slot. */
  recordedAt: v.nullable(v.number()),
  /** When a person accepted this task's result at the stage's checkpoint; null until then. */
  clearedAt: v.nullable(v.number()),
  /** Who accepted it, or null for an acceptance with no attributable person. */
  clearedBy: v.nullable(v.string()),
  /**
   * The accepted result of each upstream stage (`after` and `consumes`) when the task was created,
   * by stage id: the outcome id, or null for a stage with none. What `stale` compares against.
   */
  basis: v.record(v.string(), v.nullable(v.string())),
})
export type ProjectStageTask = v.InferOutput<typeof projectStageTaskSchema>

/**
 * Where a stage stands. `blocked`: a stage it runs after has no accepted result. `ready`: it may
 * start. `in-progress`: a task of it exists with no result yet. `awaiting-checkpoint`: its newest
 * result waits for a person to accept it. `done`: its newest result is accepted.
 */
export const projectStageStatusSchema = v.picklist([
  'blocked',
  'ready',
  'in-progress',
  'awaiting-checkpoint',
  'done',
])
export type ProjectStageStatus = v.InferOutput<typeof projectStageStatusSchema>

const stageOutcomeRefSchema = v.object({ id: v.string(), seq: v.number(), taskId: v.string() })

export const projectStageStateSchema = v.object({
  stageId: projectStageIdSchema,
  status: projectStageStatusSchema,
  /**
   * An upstream stage's accepted result is no longer the one this stage's accepted result was
   * started from, so this result may be out of date. Stated, never acted on.
   */
  stale: v.boolean(),
  /** The stages it runs after that have no accepted result, for a `blocked` stage. */
  waitingOn: v.array(projectStageIdSchema),
  /** The task of it with no result yet, for an `in-progress` stage. */
  activeTaskId: v.nullable(v.string()),
  /** Its newest result, accepted or not. */
  latest: v.nullable(stageOutcomeRefSchema),
  /** The newest result a person accepted, or its newest one when it has no checkpoint. */
  accepted: v.nullable(stageOutcomeRefSchema),
})
export type ProjectStageState = v.InferOutput<typeof projectStageStateSchema>

/** What deriving a project's stage state reads. */
export interface ProjectStageStateInput {
  stages: readonly ProjectStage[]
  /** The project's stage-task records. */
  stageTasks: readonly ProjectStageTask[]
  /**
   * The ids of the project's tasks that still exist. A deleted task with no result is no longer
   * running; a deleted task's recorded result still counts.
   */
  liveTaskIds: ReadonlySet<string>
  /** The project's outcomes, any order. */
  outcomes: ReadonlyArray<{ id: string; seq: number; stream: string; taskId: string | null }>
}

/** Each stage's state, in the definition's order. */
export function deriveProjectStageStates(input: ProjectStageStateInput): ProjectStageState[] {
  const tasksOf = new Map<string, ProjectStageTask[]>()
  for (const task of input.stageTasks) {
    tasksOf.set(task.stageId, [...(tasksOf.get(task.stageId) ?? []), task])
  }
  const resolved = new Map(
    input.stages.map(
      (stage) =>
        [
          stage.id,
          resolveStage(stage, tasksOf.get(stage.id) ?? [], input.outcomes, input.liveTaskIds),
        ] as const,
    ),
  )
  return input.stages.map((stage) => {
    const own = resolved.get(stage.id)!
    const waitingOn = stage.after.filter((id) => !resolved.get(id)?.accepted)
    const basis = own.acceptedBasis
    const stale =
      basis !== null &&
      upstreamOf(stage).some(
        (id) => (resolved.get(id)?.accepted?.id ?? null) !== (basis[id] ?? null),
      )
    const status: ProjectStageStatus = own.activeTaskId
      ? 'in-progress'
      : own.latest && own.latest.id !== own.accepted?.id
        ? 'awaiting-checkpoint'
        : own.accepted
          ? 'done'
          : waitingOn.length
            ? 'blocked'
            : 'ready'
    return {
      stageId: stage.id,
      status,
      stale,
      waitingOn,
      activeTaskId: own.activeTaskId,
      latest: own.latest,
      accepted: own.accepted,
    }
  })
}

/** The stages whose accepted result a stage's task starts from: what it runs after and reads. */
export function upstreamOf(stage: ProjectStage): string[] {
  return [...new Set([...stage.after, ...stage.consumes.map((c) => c.stage)])]
}

function resolveStage(
  stage: ProjectStage,
  tasks: readonly ProjectStageTask[],
  outcomes: ProjectStageStateInput['outcomes'],
  liveTaskIds: ReadonlySet<string>,
) {
  const byTask = new Map(tasks.map((t) => [t.taskId, t] as const))
  const results = outcomes
    .filter((o) => o.stream === stage.produces && o.taskId !== null && byTask.has(o.taskId))
    .sort((a, b) => a.seq - b.seq)
    .map((o) => ({ id: o.id, seq: o.seq, taskId: o.taskId! }))
  const isAccepted = (r: { taskId: string }) =>
    !stage.checkpoint || byTask.get(r.taskId)?.clearedAt !== null
  const recorded = new Set(results.map((r) => r.taskId))
  const active = [...tasks]
    .filter((t) => !recorded.has(t.taskId) && liveTaskIds.has(t.taskId))
    .sort((a, b) => b.createdAt - a.createdAt)[0]
  const accepted = results.filter(isAccepted).at(-1) ?? null
  return {
    latest: results.at(-1) ?? null,
    accepted,
    acceptedBasis: accepted ? (byTask.get(accepted.taskId)?.basis ?? {}) : null,
    activeTaskId: active?.taskId ?? null,
  }
}

/** A stage as a board reads it: the definition's stage without its config, and where it stands. */
export const projectStageViewSchema = v.object({
  stage: v.omit(projectStageSchema, ['config']),
  state: projectStageStateSchema,
})
export type ProjectStageView = v.InferOutput<typeof projectStageViewSchema>
