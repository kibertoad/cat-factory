// ---------------------------------------------------------------------------
// Repo-bootstrap domain types. Mirrors the `@cat-factory/contracts` bootstrap
// schemas so backend payloads drop straight into the Pinia store.
//
// A "reference architecture" is a managed base repo (an opinionated starter the
// org wants new services to follow); the "bootstrap repo" task creates a new repo
// from one and runs a bootstrapper agent in a container to adapt it.
// ---------------------------------------------------------------------------

/** A managed base repository new repos are bootstrapped from. */
export interface ReferenceArchitecture {
  id: string
  workspaceId: string
  name: string
  description: string
  repoOwner: string
  repoName: string
  defaultInstructions: string
  createdAt: number
  updatedAt: number
}

/** Body to register a reference architecture. */
export interface CreateReferenceArchitectureInput {
  name: string
  description?: string
  repoOwner: string
  repoName: string
  defaultInstructions?: string
}

/** Body to patch a reference architecture (only supplied fields change). */
export type UpdateReferenceArchitectureInput = Partial<CreateReferenceArchitectureInput>

/** Lifecycle of a single "bootstrap repo" run. */
export type BootstrapStatus = 'pending' | 'running' | 'succeeded' | 'failed'

/** One "bootstrap repo" run with its outcome. */
export interface BootstrapJob {
  id: string
  workspaceId: string
  /** Reference architecture the run was based on, or null for a from-scratch run. */
  referenceArchitectureId: string | null
  /** Denormalized reference architecture name, or null for a from-scratch run. */
  referenceArchitectureName: string | null
  repoName: string
  repoOwner: string | null
  repoUrl: string | null
  instructions: string
  status: BootstrapStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

/** Body to kick off a bootstrap run. Omit `referenceArchitectureId` to bootstrap
 * from a freeform prompt alone (then `instructions` must be non-empty). */
export interface BootstrapRepoInput {
  referenceArchitectureId?: string | null
  repoName: string
  description?: string
  private?: boolean
  instructions?: string
}
