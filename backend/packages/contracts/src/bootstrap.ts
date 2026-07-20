import * as v from 'valibot'
import { agentFailureSchema, stepSubtasksSchema } from './execution.js'
import { frameRepoTypeSchema } from './primitives.js'

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
/**
 * A single GitHub owner OR repository segment (the `owner` or the `name` in
 * `owner/name`), validated on its own — never the combined `owner/name`, so a
 * slash is not allowed. The message reflects exactly what the regex accepts.
 */
const slugField = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^[A-Za-z0-9_.-]+$/, "Only letters, digits, '.', '_' and '-' are allowed"),
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

/**
 * How a bootstrap run faulted, so the board can classify the failure (and decide
 * whether a retry is likely to help):
 *   - `preflight` — rejected before dispatch (repo missing/not empty, not connected).
 *   - `dispatch`  — the container accepted-request itself failed (HTTP / network).
 *   - `evicted`   — the container vanished mid-run (eviction/crash): its in-memory
 *                   job was gone on the next poll. Retrying spins a fresh container.
 *   - `timeout`   — a container watchdog fired (inactivity or max-duration).
 *   - `agent`     — the bootstrapper agent / git push reported a failure.
 *   - `cancelled` — the user (or an orphan sweep) explicitly stopped the run.
 *   - `unknown`   — anything not otherwise classified.
 */
export const bootstrapFailureKindSchema = v.picklist([
  'preflight',
  'dispatch',
  'evicted',
  'timeout',
  'agent',
  'cancelled',
  'unknown',
])
export type BootstrapFailureKind = v.InferOutput<typeof bootstrapFailureKindSchema>

/**
 * Structured diagnostics captured when a bootstrap run fails. This is now the
 * shared {@link agentFailureSchema} (the same shape execution runs use), so the
 * board renders one failure banner + retry for any agent. `bootstrapFailureKind`
 * stays a narrow alias documenting the subset a bootstrap run actually produces.
 */
export const bootstrapFailureSchema = agentFailureSchema
export type BootstrapFailure = v.InferOutput<typeof bootstrapFailureSchema>

/** One "bootstrap repo" run, with its outcome. */
export const bootstrapJobSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** Reference architecture the run was based on, or null for a from-scratch (freeform) run. */
  referenceArchitectureId: v.nullable(v.string()),
  /** Denormalized at creation so the job is self-describing even if the base is later removed; null for from-scratch runs. */
  referenceArchitectureName: v.nullable(v.string()),
  /** Name of the new repository being created. */
  repoName: v.string(),
  /** Owner the new repo was created under (resolved at run time), or null until known. */
  repoOwner: v.nullable(v.string()),
  /** Web URL of the created repository, or null until/unless it succeeds. */
  repoUrl: v.nullable(v.string()),
  /** Effective bootstrapper instructions (defaults + per-run), for transparency. */
  instructions: v.string(),
  status: bootstrapStatusSchema,
  /**
   * The board service frame this run materialises. Created up front (in
   * `running` state) so the bootstrap shows on the board immediately as a
   * provisional "bootstrapping…" card; on success the frame is linked to the new
   * repo and becomes a normal, droppable service. Null only if frame creation
   * was skipped (e.g. an older job recorded before this field existed).
   */
  blockId: v.nullable(v.string()),
  /**
   * Live subtask counts from the bootstrapper agent's todo list while the
   * container runs, so the board can render an "N/M done" progress bar
   * identically to a pipeline step. Null until the agent first reports.
   */
  subtasks: v.nullable(stepSubtasksSchema),
  /** Failure reason when `status` is `failed` (one-line; see `failure` for detail). */
  error: v.nullable(v.string()),
  /** Structured failure diagnostics when `status` is `failed`; null otherwise. */
  failure: v.nullable(bootstrapFailureSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type BootstrapJob = v.InferOutput<typeof bootstrapJobSchema>

/**
 * Kick off a "bootstrap repo" run. Two modes are supported:
 *   - from a reference architecture: supply `referenceArchitectureId` (its base
 *     repo is cloned and adapted), optionally with extra `instructions`.
 *   - from scratch: omit `referenceArchitectureId` and describe the new service
 *     entirely in `instructions` (the bootstrapper scaffolds an empty repo).
 * Either a reference architecture or non-empty instructions must be provided.
 */
export const bootstrapRepoSchema = v.pipe(
  v.object({
    /** Reference architecture to clone from; omit to bootstrap from a freeform prompt. */
    referenceArchitectureId: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1)))),
    /** Name for the new repository. */
    repoName: slugField,
    /**
     * The repository role for the bootstrapped frame (backend service / frontend / library /
     * document repository). Omitted → `service`, so existing callers are unchanged.
     */
    type: v.optional(frameRepoTypeSchema),
    /** Description applied to the new repository. */
    description: v.optional(descriptionField, ''),
    /** Whether the new repository is private (defaults to private). */
    private: v.optional(v.boolean(), true),
    /**
     * Instructions for the bootstrapper agent. With a reference architecture these
     * are appended to its defaults; with no reference they are the whole brief.
     */
    instructions: v.optional(instructionsField, ''),
  }),
  v.check(
    (input) => Boolean(input.referenceArchitectureId) || input.instructions.trim().length > 0,
    'Provide a reference architecture or freeform instructions to bootstrap from.',
  ),
)
export type BootstrapRepoInput = v.InferOutput<typeof bootstrapRepoSchema>
