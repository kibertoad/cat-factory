import * as v from 'valibot'
import { type DefinitionParseResult, describeValibotIssues } from './project-definitions.js'
import { taskTypeRequiresProject } from './primitives.js'

// ---------------------------------------------------------------------------
// The SPAWN task type: a stage that puts work into the services a project links. Its run creates
// one ordinary task in each linked service, links the project to it so the task reads the stages'
// accepted results, and starts its run; its outcome records what it created. The engine performs
// it, with no agent. Its checkpoint is accepted only once every task it created has settled.
// Design: `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** The built-in task type a spawn stage runs as. */
export const SPAWN_TASK_TYPE = 'spawn'

/** The step kind of a spawn stage's run, performed by the engine itself. */
export const PROJECT_SPAWNER_AGENT_KIND = 'project-spawner'

/** The body schema version a spawn record is written in today. */
export const SPAWN_RECORD_SCHEMA_VERSION = 1

/** The token a spawn stage's title and description replace with each service's name. */
export const SPAWN_SERVICE_PLACEHOLDER = '{service}'

export const SPAWN_TEXT_MAX = 20_000
export const SPAWN_TITLE_MAX = 200
export const SPAWN_TASKS_MAX = 200

const id = v.pipe(v.string(), v.minLength(1), v.maxLength(200))
const reason = v.pipe(v.string(), v.maxLength(2000))

/** What a spawn stage creates in each linked service. */
export const spawnStageConfigSchema = v.object({
  /** Each task's title; `{service}` becomes the service's name. */
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(SPAWN_TITLE_MAX)),
  /** Each task's description; `{service}` becomes the service's name. */
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(SPAWN_TEXT_MAX)), ''),
  /** The type of each task; a type that runs only under a project cannot go into a service. */
  taskType: v.optional(
    v.pipe(
      v.string(),
      v.minLength(1),
      v.check((t) => !taskTypeRequiresProject(t), 'must be a task type a service runs'),
    ),
    'feature',
  ),
  /** The pipeline each task runs; absent means the task type's default. */
  pipelineId: v.optional(id),
})
export type SpawnStageConfig = v.InferOutput<typeof spawnStageConfigSchema>

/** One task a spawn created. */
export const spawnedTaskSchema = v.object({
  serviceId: id,
  serviceName: v.string(),
  /** The board that homes the task: its service's. */
  workspaceId: id,
  taskId: id,
  title: v.string(),
  /** Whether its run started; one that did not waits on its board for a person, `note` says why. */
  started: v.boolean(),
  note: v.optional(reason),
})
export type SpawnedTask = v.InferOutput<typeof spawnedTaskSchema>

/** What a spawn stage's run created, and each linked service it could not create a task in. */
export const spawnRecordSchema = v.object({
  tasks: v.pipe(v.array(spawnedTaskSchema), v.maxLength(SPAWN_TASKS_MAX)),
  skipped: v.pipe(
    v.array(v.object({ serviceId: id, serviceName: v.nullable(v.string()), reason })),
    v.maxLength(SPAWN_TASKS_MAX),
  ),
})
export type SpawnRecord = v.InferOutput<typeof spawnRecordSchema>

function parsed<T>(schema: v.GenericSchema<unknown, T>, input: unknown): DefinitionParseResult<T> {
  const result = v.safeParse(schema, input)
  return result.success
    ? { ok: true, value: result.output }
    : { ok: false, issues: describeValibotIssues(result.issues) }
}

export const parseSpawnStageConfig = (input: unknown) => parsed(spawnStageConfigSchema, input)
export const parseSpawnRecord = (input: unknown) => parsed(spawnRecordSchema, input)

/** A spawn stage's title or description for one service. */
export function spawnTextFor(template: string, serviceName: string): string {
  return template.replaceAll(SPAWN_SERVICE_PLACEHOLDER, serviceName)
}

/** A spawn record as Markdown, for a reader of the stage's result. */
export function renderSpawnRecord(title: string, record: SpawnRecord): string {
  const lines = [`# ${title}`, '']
  if (record.tasks.length === 0) lines.push('No task was created.', '')
  for (const task of record.tasks) {
    const run = task.started ? 'run started' : `run not started: ${task.note ?? 'no reason given'}`
    lines.push(`- ${task.serviceName}: task \`${task.taskId}\` "${task.title}" (${run})`)
  }
  if (record.skipped.length) {
    lines.push('', '## Services with no task', '')
    for (const skip of record.skipped) {
      lines.push(`- ${skip.serviceName ?? skip.serviceId}: ${skip.reason}`)
    }
  }
  return lines.join('\n')
}
