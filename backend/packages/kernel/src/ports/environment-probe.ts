import type {
  AgentFailureKind,
  EnvironmentAccessHandle,
  EnvironmentProbeSurface,
  EnvironmentReachabilityNote,
  StepSubtasks,
} from '../domain/types.js'
import type { VcsProvider } from '../domain/vcs-types.js'

// ---------------------------------------------------------------------------
// The AGENT DRY RUN's side-effecting half: dispatch an agent at a freshly provisioned
// ephemeral environment, have it try to operate the service, and read back what it reported.
//
// Kept as a port for the reason the bootstrapper and the config repairer are: the orchestration
// that owns the run's state machine (EnvironmentTestService) must stay free of container
// dispatch, token minting and harness body shapes, all of which live in a facade. The shape
// mirrors {@link import('./env-config-repair.js').EnvConfigRepairer} deliberately: `start`
// pre-flights and dispatches (returning once accepted), `poll` reports progress or the terminal
// report, `stop` reclaims the container, so the two single-job container flows read alike.
//
// The service's sealed TEST SECRETS are deliberately NOT on the request. The implementation
// resolves them inside the facade, where the cipher lives, and from that ONE resolution derives
// both halves: the values it injects into the container environment and the non-secret key +
// description pairs it advertises in the prompt. Orchestration passes the block id and never sees
// either. Resolving them once rather than passing refs in is what makes the prompt advertise
// exactly the variables the container carries: two resolutions could disagree, and the shape of
// that disagreement is an agent told to read a variable that is not there.
//
// The environment's own access credentials DO ride the request, because they are already decrypted
// in orchestration: the engine puts the same handle on a tester's `AgentRunContext.environment`
// through the same seam.
// ---------------------------------------------------------------------------

/** The repository the probe reads to work out what the service exposes and how it authenticates. */
export interface EnvironmentProbeRepo {
  owner: string
  name: string
  /** The throwaway branch the environment was provisioned from: the tree that is actually live. */
  branch: string
  /** Which VCS hosts it; absent means the deployment's own engine provider. */
  provider?: VcsProvider
  /** For a service in a monorepo, the subdirectory it lives in. Absent means the whole repo. */
  serviceDirectory?: string
}

/** The live environment the probe drives, exactly as the engine hands one to a tester. */
export interface EnvironmentProbeTarget {
  url: string | null
  status: string
  /** The environment's own access credentials, when its provider issued any. */
  access?: EnvironmentAccessHandle | null
  /** What dialling it proved, so a probe that cannot connect knows whether the platform could. */
  reachability?: EnvironmentReachabilityNote
}

/** One dry-run dispatch. `jobId` keys both the self-test run row and the container job. */
export interface EnvironmentProbeRequest {
  workspaceId: string
  jobId: string
  /** The service frame under test: the key the sealed test secrets are resolved by. */
  blockId: string
  /** Which prober to run: HTTP calls for a backend service, a browser for a frontend. */
  surface: EnvironmentProbeSurface
  repo: EnvironmentProbeRepo
  environment: EnvironmentProbeTarget
  /** The frame's own title and description, so the prompt names the system under test. */
  service: { title: string; description?: string }
  /** Who started the run, for per-user credential leasing and attribution. Null for a system run. */
  initiatedBy: string | null
}

/**
 * Handle for a dispatched dry run, enough to poll and reclaim it.
 *
 * It carries the FRAME as well as the job, because a poll is not only an address: the settled
 * report is stamped with the model that produced it, and which model that was is a fact about this
 * workspace's frame and preset. The durable driver polls from a fresh process, so nothing the
 * dispatch resolved is still in memory to read back; a handle that named only the container would
 * leave the implementation re-deriving the model from a deployment default that no longer decides
 * it, and reporting a model the run never ran.
 */
export interface EnvironmentProbeHandle {
  workspaceId: string
  jobId: string
  surface: EnvironmentProbeSurface
  /** The service frame the dry run is about: the same id {@link EnvironmentProbeRequest} names. */
  blockId: string
  /** Who started the run, as the request carried it. Null for a system run. */
  initiatedBy: string | null
}

/** One poll of a dispatched dry run. */
export type EnvironmentProbeUpdate =
  | { state: 'running'; subtasks?: StepSubtasks }
  /**
   * The agent finished and produced a reply. `report` is the RAW extracted JSON value, not a
   * validated report: the caller owns the shape (`coerceEnvironmentProbeReport`), mirroring
   * `JudgeAssessor.assess` and the environment investigator, so a model that invents an outcome
   * or a failure kind cannot reach the domain unvalidated.
   */
  | { state: 'done'; report: unknown; model?: string }
  /**
   * The dry run itself broke: the container was evicted, the agent errored, the reply carried no
   * JSON at all. Distinct from a report whose verdict is `inoperable`: that is a completed
   * diagnostic with a finding, this is a diagnostic that never happened, and presenting the second
   * as the first would tell an operator their service is broken when the platform's own step is.
   */
  | { state: 'failed'; failureKind: AgentFailureKind; error: string; detail?: string }

export interface EnvironmentProbeAgent {
  /**
   * Whether this deployment can actually run a dry run on `surface`, asked at ADMISSION: before a
   * throwaway branch exists, before an environment is provisioned, before anything has been spent.
   *
   * A prober being wired is not the same question. Each surface runs on its OWN executor image
   * (the browser one needs Playwright), and a deployment that binds the plain image and not the UI
   * one can serve an `api` dry run and not a `ui` one. Asked only at dispatch, that gap costs a
   * branch, a full provision and a teardown to discover, which is precisely what the admission
   * refusal exists to prevent.
   *
   * FALSE means a resolved backend said it cannot serve the surface's image. A backend that cannot
   * answer (a self-hosted pool, which resolves images on the pool side) answers TRUE: an unknown
   * is not a refusal, and a dry run that fails at dispatch on such a deployment is the behaviour
   * every other container flow already has there.
   */
  supports(workspaceId: string, surface: EnvironmentProbeSurface): Promise<boolean>
  /**
   * Pre-flight (a reachable environment URL, a connected repo, a proxyable model) and dispatch the
   * probe container. Returns once accepted; the work continues in the container and is read through
   * {@link poll}. Throws on a pre-flight or dispatch failure so the run fails fast at the stage it
   * failed in, rather than reporting a phantom probe. Idempotent per job id (a re-dispatch
   * re-attaches to the running job rather than starting a second agent).
   */
  start(request: EnvironmentProbeRequest): Promise<EnvironmentProbeHandle>
  /** Poll a dispatched dry run for progress or its terminal outcome. */
  poll(handle: EnvironmentProbeHandle): Promise<EnvironmentProbeUpdate>
  /**
   * Best-effort: stop and reclaim the probe's container. Safe to call when it is already
   * gone, which implementations swallow exactly as the repairer's `stopRepair` does.
   */
  stop(handle: EnvironmentProbeHandle): Promise<void>
}
