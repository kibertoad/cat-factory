import * as v from 'valibot'
import { descriptorFieldValuesSchema } from './form-fields.js'
import { publicTaskStatusSchema } from './public-api.js'
import { createTaskTypeSchema, taskTypeSchema } from './primitives.js'
import {
  PROJECT_DEFINITION_PROSE_MAX,
  projectCredentialSchema,
  projectDefinitionEntries,
  projectDefinitionKeySchema,
  projectDefinitionSchema,
  projectDefinitionVersionSchema,
  projectTargetSchema,
} from './project-definitions.js'
import { taskTypeFieldDescriptorSchema } from './task-types.js'
import { outcomeStreamSchema, projectOutcomeMetaSchema } from './project-outcomes.js'
import { projectStageSchema, projectStageStatusSchema } from './project-stages.js'
import { stageAcceptanceReportSchema } from './stage-acceptance.js'
import {
  projectKindDescriptorSchema,
  projectKindIdSchema,
  projectPinInputSchema,
} from './projects.js'

// ---------------------------------------------------------------------------
// The public PROJECTS surface (`/api/v1/projects`, `/api/v1/project-kinds`): the project kinds a
// deployment offers, the definitions an account publishes for them, projects and their service
// links, the tasks under a project, and a project's outcomes. Design:
// `backend/docs/adr/0069-projects-and-research-projects.md`.
//
// Nothing here knows a kind. A definition's `spec`, an outcome's `body` and a project's `view`
// are opaque, and each kind serves their JSON Schemas from `GET /api/v1/project-kinds/{kind}`, so
// a new kind needs no SDK release and the SDKs carry no kind's classes.
//
// A project task has its own resource, `PublicProjectTask`, because `PublicTask.serviceId` is a
// required string and a project task has no service to put there. Retyping that field would break
// every client (ADR 0034), so the `/api/v1/tasks/{taskId}` operations returning a `PublicTask`
// refuse a project task with `task_owned_by_project` instead.
// ---------------------------------------------------------------------------

/** A JSON Schema document. */
const jsonSchemaSchema = v.record(v.string(), v.unknown())

/** A project kind the deployment offers. */
export const publicProjectKindSchema = projectKindDescriptorSchema
export type PublicProjectKind = v.InferOutput<typeof publicProjectKindSchema>

export const publicProjectKindListSchema = v.object({ kinds: v.array(publicProjectKindSchema) })
export type PublicProjectKindList = v.InferOutput<typeof publicProjectKindListSchema>

/** A project kind with the JSON Schemas of its own shapes; null where the kind declares none. */
export const publicProjectKindDetailSchema = v.object({
  ...projectKindDescriptorSchema.entries,
  schemas: v.object({
    /** A definition's `spec`. */
    spec: v.nullable(jsonSchemaSchema),
    /**
     * An outcome's `body`, in the schema version the deployment writes, for a kind with one task
     * type; null for a kind with several, whose bodies `outcomes` states per task type.
     */
    outcome: v.nullable(jsonSchemaSchema),
    /** Each task type's outcome `body`, keyed by the `taskType` an outcome carries. */
    outcomes: v.record(v.string(), v.nullable(jsonSchemaSchema)),
    /** A project's `view`. */
    view: v.nullable(jsonSchemaSchema),
  }),
})
export type PublicProjectKindDetail = v.InferOutput<typeof publicProjectKindDetailSchema>

/** A definition the account can pin, with where it comes from and its content hash. */
export const publicProjectDefinitionSchema = v.object({
  /** `registered`: the deployment ships it in code. `stored`: the account published it. */
  origin: v.picklist(['registered', 'stored']),
  contentHash: v.string(),
  definition: projectDefinitionSchema,
})
export type PublicProjectDefinition = v.InferOutput<typeof publicProjectDefinitionSchema>

export const publicProjectDefinitionListSchema = v.object({
  definitions: v.array(publicProjectDefinitionSchema),
})
export type PublicProjectDefinitionList = v.InferOutput<typeof publicProjectDefinitionListSchema>

/**
 * The body of a published version. Its kind, key and version are the path's; its `spec` is
 * validated by the kind, against the schema `GET /api/v1/project-kinds/{kind}` serves.
 */
export const publishProjectDefinitionSchema = v.object({
  title: projectDefinitionEntries.title,
  credentials: v.optional(v.array(projectCredentialSchema)),
  targets: v.optional(v.array(projectTargetSchema)),
  inputs: v.optional(v.array(taskTypeFieldDescriptorSchema)),
  promptAdditions: v.optional(
    v.record(v.string(), v.pipe(v.string(), v.maxLength(PROJECT_DEFINITION_PROSE_MAX))),
  ),
  spec: v.unknown(),
})
export type PublishProjectDefinitionInput = v.InferOutput<typeof publishProjectDefinitionSchema>

export const projectKindParamsSchema = v.object({ kind: projectKindIdSchema })

export const projectDefinitionKeyParamsSchema = v.object({
  kind: projectKindIdSchema,
  key: v.string(),
})

export const projectDefinitionVersionParamsSchema = v.object({
  kind: projectKindIdSchema,
  key: v.string(),
  version: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer')),
})

/** What a project pins: one definition version, its content hash and its inputs. */
export const publicProjectPinSchema = v.object({
  definitionKey: projectDefinitionKeySchema,
  definitionVersion: projectDefinitionVersionSchema,
  definitionHash: v.string(),
  inputs: descriptorFieldValuesSchema,
})

/** A project as exposed externally. */
export const publicProjectSchema = v.object({
  projectId: v.string(),
  kind: projectKindIdSchema,
  title: v.string(),
  description: v.string(),
  /**
   * Linked services, as read-only context for the project's tasks, by the `serviceId`
   * `/api/v1/services` serves. A linked service homed on a board this key cannot list still
   * appears here by its id.
   */
  serviceIds: v.array(v.string()),
  /** Whether the key's workspace is the board that homes the project. Only that board runs its tasks. */
  homedHere: v.boolean(),
  /** The definition the project pinned; null for a project of a kind that pins none. */
  pin: v.nullable(publicProjectPinSchema),
  createdAt: v.number(),
})
export type PublicProject = v.InferOutput<typeof publicProjectSchema>

export const publicProjectListSchema = v.object({ projects: v.array(publicProjectSchema) })
export type PublicProjectList = v.InferOutput<typeof publicProjectListSchema>

export const createPublicProjectSchema = v.object({
  kind: projectKindIdSchema,
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(2000))),
  /** Absent: no linked services. */
  serviceIds: v.optional(v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.maxLength(50))),
  /**
   * Required by a kind whose `definition` is `required`, refused by a kind that pins none. No
   * `version` pins the highest one; no `inputs` fills none.
   */
  definition: v.optional(
    v.object({
      key: projectPinInputSchema.entries.key,
      version: projectPinInputSchema.entries.version,
      inputs: v.optional(descriptorFieldValuesSchema),
    }),
  ),
})
export type CreatePublicProjectInput = v.InferOutput<typeof createPublicProjectSchema>

/** Services to link to, or unlink from, a project. */
export const publicProjectServicesSchema = v.object({
  serviceIds: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1), v.maxLength(50)),
})
export type PublicProjectServicesInput = v.InferOutput<typeof publicProjectServicesSchema>

/** A task under a project as exposed externally. */
export const publicProjectTaskSchema = v.object({
  taskId: v.string(),
  projectId: v.string(),
  title: v.string(),
  description: v.string(),
  taskType: taskTypeSchema,
  status: publicTaskStatusSchema,
  /** 0..1 progress of the task's current run; 0 when not started. */
  progress: v.number(),
  /** The run's id once the task has been started; null while `planned`. */
  runId: v.nullable(v.string()),
})
export type PublicProjectTask = v.InferOutput<typeof publicProjectTaskSchema>

export const publicProjectTaskListSchema = v.object({
  tasks: v.array(publicProjectTaskSchema),
})
export type PublicProjectTaskList = v.InferOutput<typeof publicProjectTaskListSchema>

/**
 * Create a task under a project. `taskType` defaults to the first one the project's kind offers.
 * What a task of that type asks for goes in `fields`, described by `GET /api/v1/task-types`.
 */
export const createPublicProjectTaskSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(20_000))),
  taskType: v.optional(createTaskTypeSchema),
  fields: v.optional(descriptorFieldValuesSchema),
})
export type CreatePublicProjectTaskInput = v.InferOutput<typeof createPublicProjectTaskSchema>

/** An outcome as the API serves it, with the task type whose handler decodes it. */
export const publicProjectOutcomeMetaSchema = v.object({
  ...projectOutcomeMetaSchema.entries,
  /**
   * The task type whose handler decodes `body`, naming its shape among the kind's
   * `schemas.outcomes`; null when no handler in this deployment decodes it.
   */
  taskType: v.nullable(v.string()),
})
export type PublicProjectOutcomeMeta = v.InferOutput<typeof publicProjectOutcomeMetaSchema>

/** A project's outcomes without their bodies, `seq` ascending. */
export const publicProjectOutcomeListSchema = v.object({
  outcomes: v.array(publicProjectOutcomeMetaSchema),
})
export type PublicProjectOutcomeList = v.InferOutput<typeof publicProjectOutcomeListSchema>

export const publicProjectOutcomeListQuerySchema = v.object({
  /** Only this stream's outcomes. */
  stream: v.optional(outcomeStreamSchema),
})

/** One outcome with its body, in the schema its kind serves. */
export const publicProjectOutcomeSchema = v.object({
  ...publicProjectOutcomeMetaSchema.entries,
  body: v.unknown(),
})
export type PublicProjectOutcome = v.InferOutput<typeof publicProjectOutcomeSchema>

/**
 * The project's current state as its kind reads every outcome, in the `view` schema the kind
 * serves. Null for a kind that computes no view, whose outcomes are read one by one instead.
 */
export const publicProjectViewSchema = v.object({
  projectId: v.string(),
  kind: projectKindIdSchema,
  view: v.unknown(),
})
export type PublicProjectView = v.InferOutput<typeof publicProjectViewSchema>

/** A run whose credential wait was resumed: the step re-dispatches. */
export const publicCredentialResumeSchema = v.object({
  runId: v.string(),
  /** The run's status after the resume. */
  status: v.string(),
})
export type PublicCredentialResume = v.InferOutput<typeof publicCredentialResumeSchema>

// ---- Stages ------------------------------------------------------------------------------------
// The public projection of a staged project's stages. Its own schemas, so a change to the board's
// stage view does not reach `/api/v1` unnoticed (ADR 0034).

const publicStageOutcomeRefSchema = v.object({
  id: v.string(),
  seq: v.number(),
  taskId: v.string(),
})

/** Where a stage stands, derived from its tasks and the project's outcomes. */
export const publicProjectStageStateSchema = v.object({
  stageId: v.string(),
  /** `blocked`, `ready`, `in-progress`, `awaiting-checkpoint` or `done`. */
  status: projectStageStatusSchema,
  /** An upstream stage's accepted result changed since this stage's accepted result started. */
  stale: v.boolean(),
  /** The stages it runs after that have no accepted result, for a `blocked` stage. */
  waitingOn: v.array(v.string()),
  /** The task of it with no result yet, for an `in-progress` stage. */
  activeTaskId: v.nullable(v.string()),
  /** Its newest result, accepted or not. */
  latest: v.nullable(publicStageOutcomeRefSchema),
  /** The newest result a person accepted, or its newest one when it has no checkpoint. */
  accepted: v.nullable(publicStageOutcomeRefSchema),
  /** How its newest result meets the stage's acceptance criteria; null with no criteria. */
  acceptance: v.nullable(stageAcceptanceReportSchema),
})
export type PublicProjectStageState = v.InferOutput<typeof publicProjectStageStateSchema>

/** A stage of the pinned definition, without its task type's config, and where it stands. */
export const publicProjectStageSchema = v.object({
  stage: v.omit(projectStageSchema, ['config']),
  state: publicProjectStageStateSchema,
})
export type PublicProjectStage = v.InferOutput<typeof publicProjectStageSchema>

/** A staged project's stages, in the definition's order. */
export const publicProjectStageListSchema = v.object({ stages: v.array(publicProjectStageSchema) })
export type PublicProjectStageList = v.InferOutput<typeof publicProjectStageListSchema>

/** A person's settlement of a stage's result, for a task type that takes one. */
export const acceptPublicProjectStageSchema = v.object({ revision: v.optional(v.unknown()) })
