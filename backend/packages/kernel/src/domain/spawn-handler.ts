import {
  DEFAULT_OUTCOME_STREAM,
  PROJECT_SPAWNER_AGENT_KIND,
  SPAWN_RECORD_SCHEMA_VERSION,
  SPAWN_TASK_TYPE,
  type SpawnRecord,
  type SpawnStageConfig,
  parseSpawnRecord,
  parseSpawnStageConfig,
  renderSpawnRecord,
  spawnRecordSchema,
} from '@cat-factory/contracts'
import { ValidationError } from './errors.js'
import type { ProjectTaskHandler, ProjectTaskInput } from './project-kind-module.js'

// ---------------------------------------------------------------------------
// The handler of the built-in `spawn` task type: a stage that puts work into the services a
// project links. The engine performs its run (no agent), creating one task per linked service with
// the project linked, and records what it created. A person accepts the stage at its checkpoint
// once every task it created has settled. Any project kind may offer it beside its own handlers.
// Design: `backend/docs/adr/0070-staged-project-definitions.md`.
// ---------------------------------------------------------------------------

function configOf(input: ProjectTaskInput<SpawnRecord>): SpawnStageConfig {
  if (!input.stage) {
    throw new ValidationError('A spawn task runs only as a stage of a staged definition', {
      reason: 'project_task_type_needs_stage',
      taskType: SPAWN_TASK_TYPE,
    })
  }
  const parsed = parseSpawnStageConfig(input.stage.config)
  if (parsed.ok) return parsed.value
  throw new ValidationError(`Spawn stage '${input.stage.id}' carries no readable config`, {
    reason: 'project_definition_invalid',
    stageId: input.stage.id,
    problems: parsed.issues,
  })
}

function describe(record: SpawnRecord): string {
  const waiting = record.tasks.filter((t) => !t.started).length
  const parts = [`Created ${record.tasks.length} task(s) in the project's services.`]
  if (waiting) parts.push(`${waiting} of them wait on their board for a person to start them.`)
  if (record.skipped.length) {
    parts.push(`${record.skipped.length} service(s) got no task: see the stage's result.`)
  }
  return parts.join(' ')
}

export const spawnTaskHandler: ProjectTaskHandler<SpawnRecord> = {
  taskType: SPAWN_TASK_TYPE,
  agentKind: PROJECT_SPAWNER_AGENT_KIND,
  performedBy: 'engine',
  outcomeSchemaVersion: SPAWN_RECORD_SCHEMA_VERSION,

  parseOutcome: (schemaVersion, value) => {
    if (schemaVersion !== SPAWN_RECORD_SCHEMA_VERSION) return undefined
    const parsed = parseSpawnRecord(value)
    return parsed.ok ? parsed.value : undefined
  },

  planTask: (input) => ({ intent: 'spawn', stream: DEFAULT_OUTCOME_STREAM, plan: configOf(input) }),

  // The engine performs the run from the plan, so there is no agent to brief beyond it.
  brief: (input) => input.plan,

  mergeCheckpoint: (_earlier, later) => later,

  finish: ({ reply }) => ({ body: reply, output: describe(reply) }),

  describe: ({ body }) => describe(body),

  artifactRefs: () => [],

  parseConfig: parseSpawnStageConfig,

  renderContext: ({ stage, outcomes }) => {
    const record = outcomes.at(-1)?.body
    if (!record) {
      const note = `Spawn stage '${stage.title}' has created no task yet.`
      return { summary: note, coverage: 'no task created', body: note }
    }
    return {
      summary: describe(record),
      coverage: `${record.tasks.length} task(s) created, ${record.skipped.length} service(s) skipped`,
      body: renderSpawnRecord(`Tasks created by ${stage.title}`, record),
    }
  },

  checkpointAwaits: (record) =>
    record.tasks.map((t) => ({ workspaceId: t.workspaceId, taskId: t.taskId })),

  // Each created task links the project, and a link reads the stages a person already accepted.
  stageRequires: { after: true },

  schemas: { outcome: spawnRecordSchema },
}
