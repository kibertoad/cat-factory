import * as v from 'valibot'
import { blockTypeSchema } from './primitives'

// ---------------------------------------------------------------------------
// Board-scan wire contracts. The "scan repository" command decomposes an existing
// codebase into one canonical board structure — a single service, the modules
// inside it, and the features within each module — anchored to the codebase by
// explicit file/directory references on every node. The result is persisted as a
// reusable "repository blueprint": a durable, LLM-friendly map of the repo that
// future work is scoped against (and re-scanned to keep current).
//
// The shape is deliberately shallow and uniform (service → modules → features),
// mirroring the board's frame → module → task levels, so a blueprint spawns
// directly onto the board and reads the same way an LLM would navigate the code.
// ---------------------------------------------------------------------------

/** A GitHub owner or repository slug (the `owner`/`name` in `owner/name`). */
const slugField = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[A-Za-z0-9_.-]+$/, 'Must be a valid GitHub owner/repo slug'),
  v.minLength(1),
  v.maxLength(100),
)
const nameField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
const summaryField = v.pipe(v.string(), v.maxLength(2000))
const instructionsField = v.pipe(v.string(), v.maxLength(8000))
/** A single codebase reference: a repo-relative file or directory path. */
const referenceField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(400))
/** The file/directory paths a node maps to — what to read to work on it. */
const referencesField = v.array(referenceField)

// ---- Blueprint tree (service → modules → features) ------------------------

/** A unit of behaviour within a module, anchored to the files that implement it. */
export const blueprintFeatureSchema = v.object({
  /** Short, imperative name, e.g. `Token refresh`. */
  title: nameField,
  /** One or two sentences on what the feature does. */
  summary: v.optional(summaryField, ''),
  /** Repo-relative paths implementing the feature. */
  references: v.optional(referencesField, []),
})
export type BlueprintFeature = v.InferOutput<typeof blueprintFeatureSchema>

/** A cohesive area of the service (e.g. `auth`, `billing`) grouping features. */
export const blueprintModuleSchema = v.object({
  /** Module name, typically the owning directory's domain (e.g. `Auth`). */
  name: nameField,
  /** One or two sentences on the module's responsibility. */
  summary: v.optional(summaryField, ''),
  /** Repo-relative paths the module owns (its directories / key files). */
  references: v.optional(referencesField, []),
  features: v.optional(v.array(blueprintFeatureSchema), []),
})
export type BlueprintModule = v.InferOutput<typeof blueprintModuleSchema>

/** The repository as a single top-level service frame with its modules. */
export const blueprintServiceSchema = v.object({
  /** Board frame type the repo presents as (service / api / frontend / …). */
  type: blockTypeSchema,
  /** Human name for the service (defaults to the repo name). */
  name: nameField,
  /** One or two sentences describing the service overall. */
  summary: v.optional(summaryField, ''),
  /** Repo-relative entrypoints / root files (e.g. `package.json`, `src/index.ts`). */
  references: v.optional(referencesField, []),
  modules: v.optional(v.array(blueprintModuleSchema), []),
})
export type BlueprintService = v.InferOutput<typeof blueprintServiceSchema>

/** How a blueprint was produced: an LLM scan, or the deterministic tree heuristic. */
export const blueprintSourceSchema = v.picklist(['llm', 'heuristic'])
export type BlueprintSource = v.InferOutput<typeof blueprintSourceSchema>

/**
 * A persisted decomposition of one repository: the durable map kept per workspace
 * and re-scanned in place (one blueprint per `owner/name`). The board can be
 * spawned from it, and agents read it to scope work against real files.
 */
export const repoBlueprintSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** GitHub owner of the scanned repo. */
  repoOwner: v.string(),
  /** GitHub name of the scanned repo. */
  repoName: v.string(),
  source: blueprintSourceSchema,
  service: blueprintServiceSchema,
  createdAt: v.number(),
  /** Last (re)scan time (epoch ms). */
  updatedAt: v.number(),
})
export type RepoBlueprint = v.InferOutput<typeof repoBlueprintSchema>

// ---- Request bodies / responses -------------------------------------------

/** Kick off (or refresh) a scan of a repository into a blueprint. */
export const scanRepoSchema = v.object({
  repoOwner: slugField,
  repoName: slugField,
  /** Extra guidance for the scanner agent (focus areas, naming, granularity). */
  instructions: v.optional(instructionsField, ''),
  /** Also materialise the blueprint onto the board as a frame/modules/tasks. */
  spawn: v.optional(v.boolean(), false),
})
export type ScanRepoInput = v.InferOutput<typeof scanRepoSchema>

/** Counts of board blocks created when a scan also spawns the blueprint. */
export const boardScanSpawnResultSchema = v.object({
  /** Id of the service frame created for the blueprint. */
  frameId: v.string(),
  modules: v.number(),
  features: v.number(),
})
export type BoardScanSpawnResult = v.InferOutput<typeof boardScanSpawnResultSchema>

/** Result of a scan: the persisted blueprint, plus spawn counts when requested. */
export const scanRepoResultSchema = v.object({
  blueprint: repoBlueprintSchema,
  spawn: v.optional(boardScanSpawnResultSchema),
})
export type ScanRepoResult = v.InferOutput<typeof scanRepoResultSchema>
