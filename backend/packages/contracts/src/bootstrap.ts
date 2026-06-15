import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Repo-bootstrap wire contracts. A "reference architecture" is a named base repo
// (an opinionated starter / golden template an org wants new services to follow)
// that the platform clones to spin up a brand-new repository. The bootstrap task
// creates that new repo from the chosen reference architecture and runs a
// bootstrapper agent inside a sandbox container to adapt it per free-form
// instructions (rename packages, prune unused pieces, wire in the new domain…).
//
// Two managed resources live here:
//   - reference architectures: a workspace-scoped, CRUD-managed list of bases.
//   - bootstrap jobs: one record per "bootstrap repo" run, tracking its outcome.
// ---------------------------------------------------------------------------

const nameField = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
/** A GitHub owner or repository slug (the `owner`/`name` in `owner/name`). */
const slugField = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[A-Za-z0-9_.-]+$/, 'Must be a valid GitHub owner/repo slug'),
  v.minLength(1),
  v.maxLength(100),
)
const descriptionField = v.pipe(v.string(), v.maxLength(2000))
const instructionsField = v.pipe(v.string(), v.maxLength(8000))

// ---- Reference architectures ----------------------------------------------

/** A managed base repository new repos are bootstrapped from. */
export const referenceArchitectureSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  name: v.string(),
  description: v.string(),
  /** GitHub owner of the base repo (e.g. `acme`). */
  repoOwner: v.string(),
  /** GitHub name of the base repo (e.g. `service-template`). */
  repoName: v.string(),
  /** Default bootstrapper instructions, prepended to any per-run instructions. */
  defaultInstructions: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type ReferenceArchitecture = v.InferOutput<typeof referenceArchitectureSchema>

/** Register a new reference architecture. */
export const createReferenceArchitectureSchema = v.object({
  name: nameField,
  description: v.optional(descriptionField, ''),
  repoOwner: slugField,
  repoName: slugField,
  defaultInstructions: v.optional(instructionsField, ''),
})
export type CreateReferenceArchitectureInput = v.InferOutput<
  typeof createReferenceArchitectureSchema
>

/** Patch an existing reference architecture (only the supplied fields change). */
export const updateReferenceArchitectureSchema = v.object({
  name: v.optional(nameField),
  description: v.optional(descriptionField),
  repoOwner: v.optional(slugField),
  repoName: v.optional(slugField),
  defaultInstructions: v.optional(instructionsField),
})
export type UpdateReferenceArchitectureInput = v.InferOutput<
  typeof updateReferenceArchitectureSchema
>

// ---- Bootstrap jobs --------------------------------------------------------

/** Lifecycle of a single "bootstrap repo" run. */
export const bootstrapStatusSchema = v.picklist(['pending', 'running', 'succeeded', 'failed'])
export type BootstrapStatus = v.InferOutput<typeof bootstrapStatusSchema>

/** One "bootstrap repo" run, with its outcome. */
export const bootstrapJobSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  referenceArchitectureId: v.string(),
  /** Denormalized at creation so the job is self-describing even if the base is later removed. */
  referenceArchitectureName: v.string(),
  /** Name of the new repository being created. */
  repoName: v.string(),
  /** Owner the new repo was created under (resolved at run time), or null until known. */
  repoOwner: v.nullable(v.string()),
  /** Web URL of the created repository, or null until/unless it succeeds. */
  repoUrl: v.nullable(v.string()),
  /** Effective bootstrapper instructions (defaults + per-run), for transparency. */
  instructions: v.string(),
  status: bootstrapStatusSchema,
  /** Failure reason when `status` is `failed`. */
  error: v.nullable(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type BootstrapJob = v.InferOutput<typeof bootstrapJobSchema>

/** Kick off a "bootstrap repo" run from a reference architecture. */
export const bootstrapRepoSchema = v.object({
  referenceArchitectureId: v.pipe(v.string(), v.minLength(1)),
  /** Name for the new repository. */
  repoName: slugField,
  /** Description applied to the new repository. */
  description: v.optional(descriptionField, ''),
  /** Whether the new repository is private (defaults to private). */
  private: v.optional(v.boolean(), true),
  /** Extra instructions for the bootstrapper agent, appended to the base defaults. */
  instructions: v.optional(instructionsField, ''),
})
export type BootstrapRepoInput = v.InferOutput<typeof bootstrapRepoSchema>
