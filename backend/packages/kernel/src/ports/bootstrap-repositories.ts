import type {
  AdoptionPlan,
  BootstrapFailure,
  BootstrapPhase,
  BootstrapStatus,
  MonorepoBootstrapRef,
  ResolvedAdoption,
  StepSubtasks,
} from '../domain/types.js'

// Persistence ports for the repo-bootstrap feature. The worker implements these
// against D1 (migration 0010); tests supply in-memory fakes. All rows are scoped
// by workspace, mirroring the board / GitHub / environment repositories.

/**
 * A managed reference architecture: a base repo new repositories are
 * bootstrapped from, plus default bootstrapper instructions.
 */
export interface ReferenceArchitectureRecord {
  id: string
  workspaceId: string
  name: string
  description: string
  repoOwner: string
  repoName: string
  defaultInstructions: string
  createdAt: number
  updatedAt: number
  /** Set when the entry is removed (tombstone). */
  deletedAt: number | null
}

export type ReferenceArchitectureRecordPatch = Partial<
  Pick<
    ReferenceArchitectureRecord,
    'name' | 'description' | 'repoOwner' | 'repoName' | 'defaultInstructions' | 'updatedAt'
  >
>

export interface ReferenceArchitectureRepository {
  insert(record: ReferenceArchitectureRecord): Promise<void>
  update(workspaceId: string, id: string, patch: ReferenceArchitectureRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<ReferenceArchitectureRecord | null>
  listByWorkspace(workspaceId: string): Promise<ReferenceArchitectureRecord[]>
  softDelete(workspaceId: string, id: string, at: number): Promise<void>
}

/** One "bootstrap repo" run and its outcome, projected locally. */
export interface BootstrapJobRecord {
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
  /** The monorepo this run bootstraps a service INTO; null for a run creating its own repo. */
  monorepo: MonorepoBootstrapRef | null
  /** Which half of the monorepo flow the run is in; null on a new-repo run. */
  phase: BootstrapPhase | null
  /**
   * The id of the run's CURRENT drive: the durable driver's instance/singleton key, and the
   * container job id when a container is dispatched.
   *
   * Distinct from `id` because a monorepo run is driven TWICE (once for the survey, once for
   * the apply that a human's review releases), and neither driver can be re-keyed on the run:
   * a Workflows instance id cannot be recreated after its instance went terminal, and a pg-boss
   * singleton key would dedupe the resumed drive against the finished one. Equal to `id` for a
   * single-drive run, so a plain bootstrap is unchanged.
   */
  driveId: string
  /** The suggestion a human reviews; null until the survey produces one. */
  adoptionPlan: AdoptionPlan | null
  /** What the human settled; null until the review is submitted. */
  adoptionReview: ResolvedAdoption | null
  /** The pull request the apply phase opened against the monorepo; null until it does. */
  prUrl: string | null
  createdAt: number
  updatedAt: number
}

export type BootstrapJobRecordPatch = Partial<
  Pick<
    BootstrapJobRecord,
    | 'status'
    | 'repoOwner'
    | 'repoUrl'
    | 'blockId'
    | 'subtasks'
    | 'error'
    | 'failure'
    | 'monorepo'
    | 'phase'
    | 'driveId'
    | 'adoptionPlan'
    | 'adoptionReview'
    | 'prUrl'
    | 'updatedAt'
  >
>

export interface BootstrapJobRepository {
  insert(record: BootstrapJobRecord): Promise<void>
  update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void>
  get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null>
  listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]>
  /**
   * Every bootstrap run belonging to ANY of the given services, in a single (chunked) query, so
   * a shared service's in-flight bootstrap renders on every board that mounts it. Matches the
   * `service_id` column stamped from the run's service frame. Empty input → empty.
   */
  listByServices(serviceIds: string[]): Promise<BootstrapJobRecord[]>
}
