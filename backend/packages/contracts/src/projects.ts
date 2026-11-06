import * as v from 'valibot'
import { descriptorFieldValuesSchema } from './form-fields.js'
import { positionSchema, taskTypeSchema } from './primitives.js'

// ---------------------------------------------------------------------------
// Projects: account-owned peers of services. A project owns a root block (level and type
// `project`) whose tasks are ordinary blocks beneath it, is mounted onto boards exactly as a
// service is, and links to zero or more services as read-only context. Its kind is registered
// by the deployment. Design: `docs/initiatives/research-projects.md`.
// ---------------------------------------------------------------------------

export const PROJECT_TITLE_MAX = 200
export const PROJECT_DESCRIPTION_MAX = 2000
export const PROJECT_SERVICE_LINKS_MAX = 50

/** A project kind id, e.g. `research`. */
export const projectKindIdSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z][a-z0-9-]{0,39}$/, 'must be a lowercase slug'),
)

/** The canonical, account-owned project record. Its title lives on its root block. */
export const projectSchema = v.object({
  /** Globally unique (`prj_…`), distinct from every service id. */
  id: v.string(),
  accountId: v.nullable(v.string()),
  kind: projectKindIdSchema,
  /** The root block this project owns; its subtree is the project. */
  rootBlockId: v.string(),
  /** Linked services, as read-only context for the project's tasks. */
  serviceIds: v.array(v.string()),
  createdAt: v.number(),
  /** How many boards mount the project. Derived on the catalog only; absent means not computed. */
  mountCount: v.optional(v.number()),
})
export type Project = v.InferOutput<typeof projectSchema>

const serviceIdsSchema = v.pipe(
  v.array(v.pipe(v.string(), v.minLength(1))),
  v.maxLength(PROJECT_SERVICE_LINKS_MAX),
  v.check((ids) => new Set(ids).size === ids.length, 'service ids must be unique'),
)

/**
 * The research definition a research project pins at creation, and the values for its `inputs`.
 * No version pins the highest one the account can see.
 */
export const researchPinInputSchema = v.object({
  definitionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  definitionVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  inputs: v.optional(descriptorFieldValuesSchema, {}),
})
export type ResearchPinInput = v.InferOutput<typeof researchPinInputSchema>

export const createProjectInputSchema = v.object({
  kind: projectKindIdSchema,
  title: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROJECT_TITLE_MAX)),
  description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(PROJECT_DESCRIPTION_MAX))),
  serviceIds: v.optional(serviceIdsSchema, []),
  /** Where to drop the root on the creating board; laid out on the board's grid when absent. */
  position: v.optional(positionSchema),
  /** Required by, and only accepted for, a kind that keeps `research` data. */
  research: v.optional(researchPinInputSchema),
})
export type CreateProjectInput = v.InferOutput<typeof createProjectInputSchema>

/** Replace a project's service links. */
export const setProjectServicesInputSchema = v.object({
  serviceIds: serviceIdsSchema,
})
export type SetProjectServicesInput = v.InferOutput<typeof setProjectServicesInputSchema>

/**
 * What a project task does with repositories: `none` never touches one, `linked-read-only`
 * reads the linked services' repos as context. A project has no repository to write to, so no
 * kind can offer a task type that needs one.
 */
export const projectRepoAccessSchema = v.picklist(['none', 'linked-read-only'])
export type ProjectRepoAccess = v.InferOutput<typeof projectRepoAccessSchema>

/** The project-level data a kind keeps, a closed vocabulary the platform implements. */
export const projectKindDataSchema = v.picklist(['research'])
export type ProjectKindData = v.InferOutput<typeof projectKindDataSchema>

/** One task type a project kind offers. */
export const projectKindTaskTypeSchema = v.object({
  taskType: taskTypeSchema,
  /** The pipeline a task of this type starts with when the creator picks none. */
  defaultPipelineId: v.optional(v.string()),
  repoAccess: projectRepoAccessSchema,
})
export type ProjectKindTaskType = v.InferOutput<typeof projectKindTaskTypeSchema>

/** A registered project kind, as the board offers it. */
export const projectKindDescriptorSchema = v.object({
  id: projectKindIdSchema,
  label: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
  description: v.optional(v.pipe(v.string(), v.maxLength(PROJECT_DESCRIPTION_MAX))),
  /** At least one, so a project of this kind can hold work. */
  taskTypes: v.pipe(v.array(projectKindTaskTypeSchema), v.minLength(1)),
  /**
   * The project-level data the kind keeps. `research` pins a research definition at creation;
   * absent means the project keeps nothing beyond its tasks.
   */
  data: v.optional(projectKindDataSchema),
})
export type ProjectKindDescriptor = v.InferOutput<typeof projectKindDescriptorSchema>

/** Validate a project kind descriptor, reporting every issue with its path. */
export function parseProjectKindDescriptor(
  input: unknown,
): { ok: true; kind: ProjectKindDescriptor } | { ok: false; issues: string[] } {
  const result = v.safeParse(projectKindDescriptorSchema, input)
  if (result.success) return { ok: true, kind: result.output }
  return {
    ok: false,
    issues: result.issues.map((issue) => {
      const path = v.getDotPath(issue)
      return path ? `${path}: ${issue.message}` : issue.message
    }),
  }
}
