import * as v from 'valibot'
import { descriptorFieldValuesSchema } from './form-fields.js'
import { publicTaskStatusSchema } from './public-api.js'
import { createTaskTypeSchema, taskTypeSchema } from './primitives.js'
import { projectKindIdSchema } from './projects.js'
import {
  findingsRevisionMetaSchema,
  questionFindingSchema,
  questionStatusSchema,
  researchCredentialSchema,
  researchDefinitionSchema,
  researchLearningSchema,
  researchTargetSchema,
  researchTopicSchema,
} from './research.js'
import { taskTypeFieldDescriptorSchema } from './task-types.js'

// ---------------------------------------------------------------------------
// The public PROJECTS surface (`/api/v1/projects`, `/api/v1/research-definitions`): research
// definitions an account publishes, projects and their service links, the tasks under a project,
// and a research project's findings. Design: `docs/initiatives/research-projects.md`.
//
// A project task has its own resource, `PublicProjectTask`, because `PublicTask.serviceId` is a
// required string and a project task has no service to put there. Retyping that field would break
// every client (ADR 0034), so the `/api/v1/tasks/{taskId}` operations returning a `PublicTask`
// refuse a project task with `task_owned_by_project` instead.
// ---------------------------------------------------------------------------

const definitionVersionSchema = v.pipe(v.number(), v.integer(), v.minValue(1))

/** A research definition the account can pin, with where it comes from and its content hash. */
export const publicResearchDefinitionSchema = v.object({
  /** `registered`: the deployment ships it in code. `stored`: the account published it. */
  origin: v.picklist(['registered', 'stored']),
  contentHash: v.string(),
  definition: researchDefinitionSchema,
})
export type PublicResearchDefinition = v.InferOutput<typeof publicResearchDefinitionSchema>

export const publicResearchDefinitionListSchema = v.object({
  definitions: v.array(publicResearchDefinitionSchema),
})
export type PublicResearchDefinitionList = v.InferOutput<typeof publicResearchDefinitionListSchema>

/** The body of a published version. Its key and version are the path's. */
export const publishResearchDefinitionSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  brief: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(20_000)),
  topics: v.pipe(v.array(researchTopicSchema), v.minLength(1)),
  credentials: v.optional(v.array(researchCredentialSchema)),
  targets: v.pipe(v.array(researchTargetSchema), v.minLength(1)),
  inputs: v.optional(v.array(taskTypeFieldDescriptorSchema)),
  promptAdditions: v.optional(v.record(v.string(), v.pipe(v.string(), v.maxLength(20_000)))),
})
export type PublishResearchDefinitionInput = v.InferOutput<typeof publishResearchDefinitionSchema>

export const researchDefinitionVersionParamsSchema = v.object({
  key: v.string(),
  version: v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,8}$/, 'must be a positive integer')),
})

/** What a research project pins: one definition version, its content hash and its inputs. */
export const publicResearchPinSchema = v.object({
  definitionKey: v.string(),
  definitionVersion: definitionVersionSchema,
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
  /** The pinned research definition of a research project; null for a kind keeping none. */
  research: v.nullable(publicResearchPinSchema),
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
   * Required by, and only accepted for, a kind that keeps research data. No `definitionVersion`
   * pins the highest version; no `inputs` fills none.
   */
  research: v.optional(
    v.object({
      definitionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
      definitionVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
 * A `research` task takes its mode and ad-hoc questions through `fields`
 * (`researchMode`, `researchQuestions`, `researchQuestionIds`), described by `GET /api/v1/task-types`.
 */
export const createPublicProjectTaskSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(20_000))),
  taskType: v.optional(createTaskTypeSchema),
  fields: v.optional(descriptorFieldValuesSchema),
})
export type CreatePublicProjectTaskInput = v.InferOutput<typeof createPublicProjectTaskSchema>

const coverageCountsSchema = v.object({
  answered: v.number(),
  partial: v.number(),
  unanswered: v.number(),
  blocked: v.number(),
})

/** One question's current answer, the revision it came from, and attempts that did not replace it. */
export const publicFoldedFindingSchema = v.object({
  finding: questionFindingSchema,
  revisionId: v.string(),
  seq: v.number(),
  notes: v.array(
    v.object({
      revisionId: v.string(),
      seq: v.number(),
      status: questionStatusSchema,
      answer: v.string(),
      blockedOn: v.optional(v.object({ credentialKey: v.string() })),
    }),
  ),
})

/** A research project's current findings: its revisions folded by question id, and coverage. */
export const publicProjectFindingsSchema = v.object({
  projectId: v.string(),
  definitionKey: v.string(),
  definitionVersion: definitionVersionSchema,
  summary: v.string(),
  latestRevisionId: v.nullable(v.string()),
  findings: v.array(publicFoldedFindingSchema),
  learnings: v.array(v.object({ ...researchLearningSchema.entries, revisionId: v.string() })),
  coverage: v.object({
    total: coverageCountsSchema,
    byTopic: v.array(v.object({ topicId: v.string(), counts: coverageCountsSchema })),
    adhoc: coverageCountsSchema,
    retiredQuestionIds: v.array(v.string()),
  }),
  /** Every revision, `seq` ascending, without bodies. */
  revisions: v.array(findingsRevisionMetaSchema),
})
export type PublicProjectFindings = v.InferOutput<typeof publicProjectFindingsSchema>

/** A run whose credential wait was resumed: the step re-dispatches. */
export const publicCredentialResumeSchema = v.object({
  runId: v.string(),
  /** The run's status after the resume. */
  status: v.string(),
})
export type PublicCredentialResume = v.InferOutput<typeof publicCredentialResumeSchema>

/** One findings revision with the body its task recorded. */
export const publicFindingsRevisionSchema = v.object({
  ...findingsRevisionMetaSchema.entries,
  summary: v.string(),
  findings: v.array(questionFindingSchema),
  learnings: v.array(researchLearningSchema),
})
export type PublicFindingsRevision = v.InferOutput<typeof publicFindingsRevisionSchema>
