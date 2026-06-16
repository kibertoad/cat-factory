// ---------------------------------------------------------------------------
// Repo-bootstrap domain types. Mirrors the `@cat-factory/contracts` bootstrap
// schemas so backend payloads drop straight into the Pinia store.
//
// A "reference architecture" is a managed base repo (an opinionated starter the
// org wants new services to follow); the "bootstrap repo" task creates a new repo
// from one and runs a bootstrapper agent in a container to adapt it.
// ---------------------------------------------------------------------------

import type { AgentFailure, AgentFailureKind, StepSubtasks } from './execution'

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

/**
 * A bootstrap run's failure is now the shared {@link AgentFailure} (same shape
 * execution runs use), so the board renders one failure banner + retry for any
 * agent. These aliases stay for back-compat / documentation of the bootstrap
 * subset; `bootstrapFailureKindSchema` on the backend stays narrow.
 */
export type BootstrapFailureKind = AgentFailureKind

/** Structured failure diagnostics captured when a bootstrap run fails. */
export type BootstrapFailure = AgentFailure

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
  /** The board service frame this run materialises, or null if none was created. */
  blockId: string | null
  /** Live subtask counts from the bootstrapper agent, or null until it reports. */
  subtasks: StepSubtasks | null
  error: string | null
  /** Structured failure diagnostics when `status` is `failed`; null otherwise. */
  failure: BootstrapFailure | null
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
