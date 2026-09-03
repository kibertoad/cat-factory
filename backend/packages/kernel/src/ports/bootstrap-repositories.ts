import type {
  AdoptionPlan,
  BootstrapDelivery,
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
   * How this run delivers its work, resolved at start. Stored rather than re-derived because a
   * RETRY re-dispatches under it and a finished run is read back to say which shape it took;
   * a row written before the delivery toggle existed resolves to the target's own default,
   * which is what that run actually did.
   */
  delivery: BootstrapDelivery
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

/** The window a survey claim holds before another drive may take it (see `claimSurvey`). */
export interface SurveyClaim {
  /** Now, stamped on the winning claim. */
  at: number
  /**
   * A claim stamped at or before this instant is re-claimable. Answers the "what if the claimer
   * dies" question every claim has to: the drive that took the claim can be killed between the
   * claim and the plan (an isolate eviction, a container restart), and without a TTL the run
   * would then park on nothing forever with no way back in.
   */
  staleBefore: number
}

export interface BootstrapJobRepository {
  insert(record: BootstrapJobRecord): Promise<void>
  update(workspaceId: string, id: string, patch: BootstrapJobRecordPatch): Promise<void>
  /**
   * Take the exclusive right to run this run's adoption SURVEY, returning whether this caller won.
   *
   * One conditional UPDATE, which is the whole point: the survey ends in a billable model call and
   * both durable drivers replay (a Workflows step re-run, a pg-boss retry, the stale-run sweeper
   * re-driving a run whose drive died). Two drives that each read "no plan yet" and then each
   * surveyed would bill twice AND have the loser's `park` replace the plan under a reviewer who
   * had already loaded the winner's, whose answers then 422 as `adoption_choice_unknown`. A marker
   * written AFTER the call cannot prevent either; only a claim taken before it can.
   *
   * A lost claim is not an error: the winner is authoritative and the caller returns without
   * doing anything, leaving the run for the winner to park.
   */
  claimSurvey(workspaceId: string, id: string, claim: SurveyClaim): Promise<boolean>
  get(workspaceId: string, id: string): Promise<BootstrapJobRecord | null>
  listByWorkspace(workspaceId: string): Promise<BootstrapJobRecord[]>
  /**
   * Every bootstrap run belonging to ANY of the given services, in a single (chunked) query, so
   * a shared service's in-flight bootstrap renders on every board that mounts it. Matches the
   * `service_id` column stamped from the run's service frame. Empty input → empty.
   */
  listByServices(serviceIds: string[]): Promise<BootstrapJobRecord[]>
}
