import type {
  AdoptionReviewInput,
  Block,
  BlockType,
  BootstrapFailure,
  BootstrapFailureKind,
  BootstrapJob,
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  MonorepoBootstrapRef,
  ReferenceArchitecture,
  StepSubtasks,
  UpdateReferenceArchitectureInput,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  BlockRepository,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type {
  BootstrapJobRecord,
  BootstrapJobRepository,
  ReferenceArchitectureRecord,
  ReferenceArchitectureRepository,
} from '@cat-factory/kernel'
import type { MonorepoBootstrapLeg, RepoBootstrapper } from '@cat-factory/kernel'
import type { BootstrapRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { Logger } from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  isDispatchFailure,
  noopLogger,
  redactSecrets,
  renderAdoptionBrief,
  renderAdoptionPrSection,
  resolveAdoptionReview,
  runBestEffort,
  sameSubtasks,
} from '@cat-factory/kernel'
import { registerServiceForFrame, requireWorkspace } from '@cat-factory/kernel'
import { bootstrapResumeStep } from '@cat-factory/contracts'
import { monorepoBootstrapPrTitle } from '@cat-factory/agents'
import {
  MonorepoBootstrapController,
  type MonorepoBootstrapDeps,
} from './MonorepoBootstrapController.js'

/**
 * The poll's terminal-ness, returned to the durable driver so it knows when to stop.
 *
 * `awaiting_review` is a STOP that is not an end: the monorepo flow's survey has parked the run
 * on a human decision, so the driver returns (a park can last days, and holding a Workflows
 * instance or a pg-boss job open across it buys nothing) and the review's own resume starts a
 * fresh drive. Kept distinct from `done` because the run has produced no service yet: a caller
 * that collapsed the two would report a bootstrap as finished with nothing committed.
 */
export interface BootstrapPollResult {
  state: 'running' | 'awaiting_review' | 'done' | 'failed'
  /** Present when `state === 'failed'`. */
  error?: string
}

// ---------------------------------------------------------------------------
// BootstrapService: owns the managed list of reference architectures and the
// "bootstrap repo" task. CRUD over reference architectures always works; running
// a bootstrap additionally needs the RepoBootstrapper port (the GitHub + sandbox
// container machinery) to be wired — when it is absent, `canBootstrap` is false
// and callers should surface "unavailable" rather than attempt a run.
// ---------------------------------------------------------------------------

export interface BootstrapServiceDependencies {
  referenceArchitectureRepository: ReferenceArchitectureRepository
  bootstrapJobRepository: BootstrapJobRepository
  workspaceRepository: WorkspaceRepository
  /** Board blocks: a bootstrap materialises a provisional service frame up front. */
  blockRepository: BlockRepository
  /**
   * In-org shared services. When wired, the provisional service frame is registered as an
   * account-owned service + mount (so a bootstrapped service is shareable like any other), and
   * `listJobs` surfaces a shared service's in-flight bootstrap on every board that mounts it.
   */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
  /**
   * The workspace's default service-fragment selection. When wired, the provisional
   * service frame inherits the workspace default onto its `serviceFragmentIds`, so a
   * bootstrapped service starts with the org's standards like any other new service.
   */
  serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository
  idGenerator: IdGenerator
  clock: Clock
  /** Performs the side-effecting pre-flight + container bootstrap; optional. */
  repoBootstrapper?: RepoBootstrapper
  /** Durably drives the run's poll loop; optional (tests poll directly). */
  bootstrapRunner?: BootstrapRunner
  /** Pushes live bootstrap progress / board changes to subscribed clients. */
  eventPublisher?: ExecutionEventPublisher
  /**
   * Optional: invoked (best-effort) after a bootstrap succeeds and its repo is
   * linked to the service frame, to kick off the initial blueprint run that maps
   * the freshly bootstrapped repo and populates the board. Wired to start the
   * blueprint-only pipeline; absent in tests / when blueprints aren't configured.
   */
  onBootstrapSucceeded?: (workspaceId: string, blockId: string) => Promise<void>
  /**
   * The monorepo flow's collaborators (checkout-free reads, the adoption advisor, the budget
   * probe). Absent ⇒ a request naming a `monorepo` target is refused with a 503, because
   * `resolveTarget` cannot pre-flight the target directory without the reader; a plain new-repo
   * bootstrap is unaffected, which is what keeps the two flows independently wireable.
   */
  monorepo?: Omit<MonorepoBootstrapDeps, 'clock' | 'logger'>
  /** Facade logger; the survey's reads and drops are otherwise unowned. */
  logger?: Logger
}

function toReferenceArchitecture(record: ReferenceArchitectureRecord): ReferenceArchitecture {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    description: record.description,
    repoOwner: record.repoOwner,
    repoName: record.repoName,
    defaultInstructions: record.defaultInstructions,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

function toBootstrapJob(record: BootstrapJobRecord): BootstrapJob {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    referenceArchitectureId: record.referenceArchitectureId,
    referenceArchitectureName: record.referenceArchitectureName,
    repoName: record.repoName,
    repoOwner: record.repoOwner,
    repoUrl: record.repoUrl,
    instructions: record.instructions,
    status: record.status,
    blockId: record.blockId,
    subtasks: record.subtasks,
    error: record.error,
    failure: record.failure,
    monorepo: record.monorepo,
    phase: record.phase,
    adoptionPlan: record.adoptionPlan,
    adoptionReview: record.adoptionReview,
    prUrl: record.prUrl,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/**
 * Drop the adoption transcript from a run that is past its review.
 *
 * This list is EVERY bootstrap run the workspace has ever made, and it rides the workspace
 * snapshot that every connected browser re-fetches on a full refresh. The transcript is up to
 * {@link MAX_ADOPTION_READS} rows of reviewer detail read by exactly one surface: the review a
 * parked run waits on. So a run that is still awaiting one keeps it, and every other run sends
 * `null`, which is the shape's way of saying "not carried here" rather than `[]`, which is what a
 * survey that read nothing looks like.
 */
function withoutSettledTranscript(job: BootstrapJob): BootstrapJob {
  const plan = job.adoptionPlan
  if (!plan || job.status === 'awaiting_review') return job
  return { ...job, adoptionPlan: { ...plan, survey: { ...plan.survey, reads: null } } }
}

/** The fields every new bootstrap run starts with; the monorepo half overrides what it owns. */
function newRunDefaults(
  id: string,
): Pick<
  BootstrapJobRecord,
  'monorepo' | 'phase' | 'driveId' | 'adoptionPlan' | 'adoptionReview' | 'prUrl'
> {
  return {
    monorepo: null,
    phase: null,
    // A single-drive run keys its driver on its own id, which is what every existing bootstrap
    // did before the monorepo flow needed a second drive.
    driveId: id,
    adoptionPlan: null,
    adoptionReview: null,
    prUrl: null,
  }
}

/** Join the reference architecture's default instructions with per-run extras. */
function composeInstructions(defaults: string, extra: string): string {
  return [defaults.trim(), extra.trim()].filter((part) => part.length > 0).join('\n\n')
}

/**
 * How long a survey claim holds before another drive may take it.
 *
 * Sized against what the claim covers: a bounded set of checkout-free reads plus one inline model
 * call, so minutes rather than hours. It exists because a claimer can die between taking the claim
 * and writing the plan (an evicted isolate, a restarted worker), and a claim with no expiry would
 * leave that run parked on nothing with no way back in.
 */
const SURVEY_CLAIM_TTL_MS = 10 * 60_000

export class BootstrapService {
  /** The monorepo flow's decisions; a plain new-repo run never reaches it. */
  private readonly monorepo: MonorepoBootstrapController
  /** Normalised once, so the best-effort paths stay unit-testable with no logger wired. */
  private readonly log: Logger

  constructor(private readonly deps: BootstrapServiceDependencies) {
    this.log = deps.logger ?? noopLogger
    this.monorepo = new MonorepoBootstrapController({
      ...deps.monorepo,
      clock: deps.clock,
      logger: deps.logger,
    })
  }

  /** True when a bootstrap run can actually be performed (the bootstrapper is wired). */
  get canBootstrap(): boolean {
    return this.deps.repoBootstrapper !== undefined
  }

  // ---- reference architecture management ----------------------------------

  async listReferenceArchitectures(workspaceId: string): Promise<ReferenceArchitecture[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const records = await this.deps.referenceArchitectureRepository.listByWorkspace(workspaceId)
    return records.map(toReferenceArchitecture)
  }

  async createReferenceArchitecture(
    workspaceId: string,
    input: CreateReferenceArchitectureInput,
  ): Promise<ReferenceArchitecture> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const now = this.deps.clock.now()
    const record: ReferenceArchitectureRecord = {
      id: this.deps.idGenerator.next('refarch'),
      workspaceId,
      name: input.name,
      description: input.description,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      defaultInstructions: input.defaultInstructions,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await this.deps.referenceArchitectureRepository.insert(record)
    return toReferenceArchitecture(record)
  }

  async updateReferenceArchitecture(
    workspaceId: string,
    id: string,
    input: UpdateReferenceArchitectureInput,
  ): Promise<ReferenceArchitecture> {
    const existing = assertFound(
      await this.deps.referenceArchitectureRepository.get(workspaceId, id),
      'Reference architecture',
      id,
    )
    await this.deps.referenceArchitectureRepository.update(workspaceId, id, {
      ...input,
      updatedAt: this.deps.clock.now(),
    })
    return toReferenceArchitecture({ ...existing, ...input, updatedAt: this.deps.clock.now() })
  }

  async deleteReferenceArchitecture(workspaceId: string, id: string): Promise<void> {
    assertFound(
      await this.deps.referenceArchitectureRepository.get(workspaceId, id),
      'Reference architecture',
      id,
    )
    await this.deps.referenceArchitectureRepository.softDelete(
      workspaceId,
      id,
      this.deps.clock.now(),
    )
  }

  // ---- bootstrap jobs -----------------------------------------------------

  async listJobs(workspaceId: string): Promise<BootstrapJob[]> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    // The workspace's own bootstrap runs UNION the runs of every shared service it mounts, so a
    // service bootstrapped on another board shows its live "bootstrapping…" card here too (the
    // run is one row that fires once per org). Dedup by id. No mount repo → own runs only.
    const seen = new Set<string>()
    const out: BootstrapJob[] = []
    const add = (record: BootstrapJobRecord) => {
      if (seen.has(record.id)) return
      seen.add(record.id)
      out.push(withoutSettledTranscript(toBootstrapJob(record)))
    }
    for (const record of await this.deps.bootstrapJobRepository.listByWorkspace(workspaceId)) {
      add(record)
    }
    if (this.deps.workspaceMountRepository) {
      const mounts = await this.deps.workspaceMountRepository.listByWorkspace(workspaceId)
      // One batched query for every mounted service's runs (not one round-trip per mount).
      for (const record of await this.deps.bootstrapJobRepository.listByServices(
        mounts.map((m) => m.serviceId),
      )) {
        add(record)
      }
    }
    return out
  }

  /**
   * ONE bootstrap run, scoped to the workspace, or a 404 carrying `bootstrap_job_not_found`.
   *
   * The reason code is on the refusal rather than left to the caller because `/api/v1` documents it
   * as the code a headless poller branches on, and this method is where the absence is known: a
   * job in another workspace is ABSENT here rather than forbidden, which is the same
   * 404-hides-everything rule the public surface follows everywhere else.
   */
  async getJob(workspaceId: string, id: string): Promise<BootstrapJob> {
    return toBootstrapJob(
      assertFound(
        await this.deps.bootstrapJobRepository.get(workspaceId, id),
        'Bootstrap job',
        id,
        {
          reason: 'bootstrap_job_not_found',
        },
      ),
    )
  }

  /**
   * Kick off a "bootstrap repo" run and return immediately with the `running`
   * job. The run is asynchronous and observable: it pre-flights GitHub + the
   * target repo, dispatches the bootstrapper container, materialises a provisional
   * **service frame** on the board (so the user sees a "bootstrapping…" card right
   * away), then asks the durable runner to drive the poll loop — which streams
   * live subtask progress and, on success, links the new repo to the frame so it
   * becomes a real, droppable service. On a dispatch/pre-flight failure the job is
   * returned already `failed` (no frame is left behind). Requires {@link canBootstrap}.
   */
  async bootstrap(workspaceId: string, input: BootstrapRepoInput): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) {
      throw new Error('Repository bootstrapping is not configured')
    }

    // Pre-flight: a bootstrap run creates and pushes to a GitHub repo, so the
    // workspace must be connected to GitHub first. Check before recording any job
    // so an unconnected workspace fails fast with a clear 409 instead of leaving a
    // job that immediately fails deep inside the container run.
    if (!(await bootstrapper.isWorkspaceConnected(workspaceId))) {
      throw new ConflictError(
        'Workspace is not connected to GitHub. Install the GitHub App for this workspace before bootstrapping a repository.',
        'github_not_connected',
      )
    }

    // A reference architecture is optional: when supplied the run clones and adapts
    // its base repo; when omitted the run scaffolds a new repo from the freeform
    // instructions alone. The contract guarantees at least one is present.
    const reference = input.referenceArchitectureId
      ? assertFound(
          await this.deps.referenceArchitectureRepository.get(
            workspaceId,
            input.referenceArchitectureId,
          ),
          'Reference architecture',
          input.referenceArchitectureId,
        )
      : null

    const instructions = composeInstructions(
      reference?.defaultInstructions ?? '',
      input.instructions,
    )
    // Pre-flight the monorepo BEFORE any row is written, the same ordering the new-repo path
    // gets from dispatching before it creates a frame: a refused target (unlinked repo, a
    // directory that already holds a service) leaves neither a job nor a board card behind.
    const monorepo = input.monorepo
      ? await this.monorepo.resolveTarget(bootstrapper, workspaceId, input.monorepo)
      : null

    const now = this.deps.clock.now()
    const id = this.deps.idGenerator.next('boot')
    const record: BootstrapJobRecord = {
      ...newRunDefaults(id),
      id,
      workspaceId,
      referenceArchitectureId: reference?.id ?? null,
      referenceArchitectureName: reference?.name ?? null,
      repoName: input.repoName,
      repoOwner: null,
      repoUrl: null,
      instructions,
      status: 'running',
      blockId: null,
      subtasks: null,
      error: null,
      failure: null,
      ...(monorepo ? { monorepo: monorepo.ref, phase: 'survey' as const } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.bootstrapJobRepository.insert(record)

    // A monorepo run dispatches NOTHING yet. Its first phase is the survey, which is a bounded
    // set of checkout-free reads plus one inline model call (no container, no clone), so the
    // durable driver runs it on its first poll and the request returns immediately, exactly as
    // the container path does. The frame is materialised now rather than after a dispatch,
    // because the pre-flight above has already taken every refusal this phase can raise.
    if (monorepo) {
      const frame = await this.createServiceFrame(
        workspaceId,
        input.repoName,
        input.type ?? 'service',
        monorepo.ref,
      )
      const started = { blockId: frame.id, updatedAt: this.deps.clock.now() }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, started)
      const job = toBootstrapJob({ ...record, ...started })
      await this.deps.bootstrapRunner?.startRun(workspaceId, record.id, record.driveId)
      await this.emitBootstrap(workspaceId, job, frame)
      return job
    }

    // Dispatch the container first: its pre-flight (target exists, reachable,
    // empty-or-boilerplate) is the gate that most runs fail on, so failing here
    // before creating a board frame keeps the board clean on the common errors.
    try {
      await bootstrapper.startBootstrap({
        workspaceId,
        jobId: record.id,
        containerJobId: record.driveId,
        referenceRepo: reference
          ? { owner: reference.repoOwner, name: reference.repoName }
          : undefined,
        target: {
          name: input.repoName,
          description: input.description,
          private: input.private,
        },
        instructions,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      // A transport dispatch rejection (the container/runner never accepted the job) is
      // `dispatch`; everything else here is a pre-flight rejection (repo missing / not empty /
      // not connected). Classified by the structured DispatchError (with a legacy message
      // fallback), not by regex-matching the prose.
      const kind: BootstrapFailureKind = isDispatchFailure(error) ? 'dispatch' : 'preflight'
      const failure = this.buildFailure(kind, message, null, null)
      const patch = {
        status: 'failed' as const,
        error: message,
        failure,
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
      // A failed dispatch may still have spun a container up; reclaim it best-effort.
      await this.stopContainer(workspaceId, record.id, record.driveId)
      const failed = toBootstrapJob({ ...record, ...patch })
      await this.emitBootstrap(workspaceId, failed, null)
      return failed
    }

    // Accepted: materialise the provisional service frame and record it on the job
    // so the board shows a live "bootstrapping…" card the poll loop then updates.
    const frame = await this.createServiceFrame(
      workspaceId,
      input.repoName,
      input.type ?? 'service',
    )
    const started = { blockId: frame.id, updatedAt: this.deps.clock.now() }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, started)
    const job = toBootstrapJob({ ...record, ...started })

    // Hand off the long poll loop to the durable driver (the worker's
    // BootstrapWorkflow). Without a runner (tests) the caller polls directly.
    await this.deps.bootstrapRunner?.startRun(workspaceId, record.id, record.driveId)
    await this.emitBootstrap(workspaceId, job, frame)
    return job
  }

  /**
   * Retry a failed "bootstrap repo" run. Spins a **fresh** container (and a new
   * durable driver instance) for the same target, reusing the original job's
   * service frame so the board card stays put — it flips from the failed badge
   * back to "bootstrapping…". A new job record is created (the prior one is kept as
   * history and so the durable driver, keyed by job id, gets a clean instance).
   * Only a `failed` job can be retried. Returns the new running job.
   */
  async retry(workspaceId: string, jobId: string): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) throw new Error('Repository bootstrapping is not configured')

    const previous = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(
        `Only a failed bootstrap can be retried (job is '${previous.status}').`,
        'bootstrap_not_retryable',
        { status: previous.status },
      )
    }

    // The original job stored only the reference architecture id, so re-resolve the
    // base repo to clone. If the architecture was since deleted there's nothing to
    // clone from — fail clearly rather than silently scaffolding from scratch.
    let referenceRepo: { owner: string; name: string } | undefined
    if (previous.referenceArchitectureId) {
      const reference = await this.deps.referenceArchitectureRepository.get(
        workspaceId,
        previous.referenceArchitectureId,
      )
      if (!reference) {
        throw new ConflictError(
          `The reference architecture this run was based on no longer exists; recreate it or start a new bootstrap.`,
          'bootstrap_reference_missing',
        )
      }
      referenceRepo = { owner: reference.repoOwner, name: reference.repoName }
    }

    const now = this.deps.clock.now()
    const id = this.deps.idGenerator.next('boot')
    const record: BootstrapJobRecord = {
      ...newRunDefaults(id),
      id,
      workspaceId,
      referenceArchitectureId: previous.referenceArchitectureId,
      referenceArchitectureName: previous.referenceArchitectureName,
      repoName: previous.repoName,
      repoOwner: null,
      repoUrl: null,
      // `instructions` is already the composed brief from the original run — reuse
      // it verbatim (don't re-compose, which would double the reference defaults).
      instructions: previous.instructions,
      status: 'running',
      blockId: null,
      subtasks: null,
      error: null,
      failure: null,
      // A monorepo retry carries the SETTLED review forward, and the plan it was settled
      // against with it. Re-surveying would throw away a decision a human already made and ask
      // them for it again, which is the one thing a retry must not do: the failure being
      // retried is a container fault, not a change of mind. The phase is preserved too: a run
      // that failed during the survey retries the survey.
      //
      // A plan that is NOT ready is dropped instead, and that is what makes a retry the way out
      // of an unavailable one: the causes are an unwired model, an unreadable repository and an
      // exhausted budget, all of which an operator fixes OUTSIDE the run, so carrying the stale
      // plan forward would re-park on the old failure and no state transition would ever reach
      // the working advisor. The new row also carries no survey claim (it is a new id), so the
      // re-survey is claimable.
      monorepo: previous.monorepo,
      phase: previous.phase,
      adoptionPlan: previous.adoptionPlan?.status === 'ready' ? previous.adoptionPlan : null,
      adoptionReview: previous.adoptionReview,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.bootstrapJobRepository.insert(record)

    // A monorepo retry re-enters at the step the run REACHED rather than dispatching from the
    // top: a survey or review resume re-runs the reads on the next poll (a carried ready plan
    // short-circuits them and re-parks), and an apply resume re-dispatches through the same path
    // the review's own resume uses, so neither has a second copy of the dispatch here.
    //
    // WHICH step that is comes from `bootstrapResumeStep`, the shared rule: the board offers this
    // retry as "resume from <step>", and a second statement of the rule here is how the button
    // and the behaviour come to name different steps.
    if (record.monorepo) {
      const frame = previous.blockId
        ? await this.markFrame(
            workspaceId,
            previous.blockId,
            'in_progress',
            'Bootstrapping into the monorepo… retrying after a failed run.',
          )
        : null
      const blockId = frame?.id ?? previous.blockId
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, { blockId })
      const resumed = { ...record, blockId }
      if (bootstrapResumeStep(record) === 'apply' && record.adoptionReview) {
        return await this.dispatchApply(workspaceId, resumed, record.adoptionReview)
      }
      await this.deps.bootstrapRunner?.startRun(workspaceId, record.id, record.driveId)
      const job = toBootstrapJob(resumed)
      await this.emitBootstrap(workspaceId, job, frame)
      return job
    }

    // Dispatch a fresh container under the new job id (description/private aren't
    // forwarded — the target repo already exists — so defaults are harmless).
    try {
      await bootstrapper.startBootstrap({
        workspaceId,
        jobId: record.id,
        containerJobId: record.driveId,
        referenceRepo,
        target: { name: record.repoName, description: '', private: true },
        instructions: record.instructions,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      const kind: BootstrapFailureKind = isDispatchFailure(error) ? 'dispatch' : 'preflight'
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure(kind, message, null, null),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
      await this.stopContainer(workspaceId, record.id, record.driveId)
      // Re-mark the reused frame blocked (it briefly belonged to this attempt).
      const block = previous.blockId
        ? await this.markFrame(
            workspaceId,
            previous.blockId,
            'blocked',
            `Bootstrap failed: ${message}`,
          )
        : null
      const failed = toBootstrapJob({ ...record, blockId: previous.blockId, ...patch })
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, {
        blockId: previous.blockId,
      })
      await this.emitBootstrap(workspaceId, failed, block)
      return failed
    }

    // Accepted: reuse the original frame (flip it back to in-progress) so the card
    // stays in place; if the prior run never made one, materialise a fresh frame.
    const frame = previous.blockId
      ? await this.markFrame(
          workspaceId,
          previous.blockId,
          'in_progress',
          'Bootstrapping repository… retrying after a failed run.',
        )
      : await this.createServiceFrame(workspaceId, record.repoName)
    const blockId = frame?.id ?? previous.blockId
    const started = { blockId, updatedAt: this.deps.clock.now() }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, started)
    const job = toBootstrapJob({ ...record, ...started })

    await this.deps.bootstrapRunner?.startRun(workspaceId, record.id, record.driveId)
    await this.emitBootstrap(workspaceId, job, frame)
    return job
  }

  /**
   * Advance one running bootstrap job by polling its container once: stream the
   * latest subtask counts while it runs, and on a terminal outcome finalise the
   * job and its board frame (link the repo + flip to a ready service on success,
   * mark blocked on failure). Idempotent — a job already in a terminal state is
   * returned as-is, so the durable driver's retries/replays are safe. Returns the
   * poll's terminal-ness so the driver knows when to stop.
   */
  async pollBootstrapJob(workspaceId: string, jobId: string): Promise<BootstrapPollResult> {
    const record = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
    )
    if (record.status === 'succeeded') return { state: 'done' }
    if (record.status === 'failed') return { state: 'failed', error: record.error ?? undefined }
    if (record.status === 'awaiting_review') return { state: 'awaiting_review' }

    // The monorepo flow's SURVEY phase has no container to poll: it reads both repositories
    // through the checkout-free port and asks a model to judge. Doing it here rather than in
    // `bootstrap()` keeps the start request fast and puts the work on the durable driver, which
    // is what makes it survive an eviction. Re-entering an already-surveyed run is a no-op
    // (the stored plan is the claim), so the driver's retries and replays are safe.
    if (record.phase === 'survey') return await this.runSurvey(workspaceId, record)

    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) throw new Error('Repository bootstrapping is not configured')

    const update = await bootstrapper.pollBootstrap({
      workspaceId,
      jobId,
      containerJobId: record.driveId,
    })

    if (update.state === 'running') {
      // Only persist + push when the counts actually changed, to avoid a write +
      // broadcast on every idle poll.
      if (update.subtasks && !sameSubtasks(record.subtasks, update.subtasks)) {
        const patch = { subtasks: update.subtasks, updatedAt: this.deps.clock.now() }
        await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
        await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), null)
      }
      return { state: 'running' }
    }

    if (update.state === 'failed') {
      const message = update.error ?? 'Bootstrap failed'
      const failure = this.buildFailure(
        update.failureKind ?? 'unknown',
        message,
        update.detail ?? null,
        record.subtasks,
      )
      const patch = {
        status: 'failed' as const,
        error: message,
        failure,
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
      // Reclaim the per-run container so a faulted/leaked instance doesn't idle
      // until its sleep timer (best-effort; an evicted container is already gone).
      await this.stopContainer(workspaceId, jobId, record.driveId)
      const block = await this.markFrame(
        workspaceId,
        record.blockId,
        'blocked',
        `Bootstrap failed: ${message}`,
      )
      await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
      return { state: 'failed', error: message }
    }

    // Done on a MONOREPO run: the deliverable is a pull request against a repository that
    // already exists, so there is no repo to create, project or name: the frame is bound to the
    // monorepo it was pre-flighted against, pinned to its directory.
    if (record.monorepo) return await this.finishMonorepoApply(workspaceId, record, update.prUrl)

    // Done: record the repo, link it to the frame (so dropped tasks target it),
    // and flip the frame to a ready, droppable service.
    const outcome = update.outcome
    if (!outcome) throw new Error('Bootstrap reported done without an outcome')
    const patch = {
      status: 'succeeded' as const,
      repoOwner: outcome.owner,
      repoUrl: outcome.repoUrl,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
    // Reclaim the per-run container on success too (the failure path above already
    // does): a bootstrapped repo otherwise leaves its container to idle out its
    // sleep timer. Best-effort — an evicted/auto-slept container is already gone.
    await this.stopContainer(workspaceId, jobId, record.driveId)
    if (record.blockId) {
      // Best-effort: a failure to link must not flip a successful run to failed —
      // the repo is bootstrapped; the projection reconciles on the next sync. Project
      // the new repo, then bind the frame's account-owned Service to it (the sole
      // repo↔frame linkage `resolveRepoTarget` reads).
      try {
        const projected = await bootstrapper.projectBootstrappedRepo(workspaceId, outcome)
        const service = await this.deps.serviceRepository?.getByFrameBlock(record.blockId)
        if (service) {
          await this.deps.serviceRepository?.update(service.id, {
            installationId: projected.installationId,
            repoGithubId: projected.githubId,
          })
        }
      } catch {
        // swallow: see above
      }
    }
    const block = await this.markFrame(
      workspaceId,
      record.blockId,
      'ready',
      `Service bootstrapped from ${outcome.owner}/${outcome.name}. Drop tasks here to implement against it.`,
    )
    // `emitBootstrap` pairs the frame it was handed with the coarse board signal that carries the
    // ready flip to every board mounting this service.
    await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)

    // Kick off the initial blueprint run for the new repo (best-effort): it maps
    // the bootstrapped code into the in-repo `blueprints/` folder and reconciles
    // the board from it. A failure here must not flip the successful bootstrap to
    // failed — the repo is live; the user can re-run the mapping.
    if (record.blockId) {
      try {
        await this.deps.onBootstrapSucceeded?.(workspaceId, record.blockId)
      } catch {
        // swallow: see above
      }
    }
    return { state: 'done' }
  }

  /**
   * Explicitly stop a *running* bootstrap (the unified `POST /agent-runs/:id/stop`
   * surface): kill its per-run container, tear down the durable driver, then mark
   * the job `failed` (kind `cancelled`) and its service frame `blocked` so the board
   * shows it stopped — with retry — instead of "bootstrapping…" forever. Idempotent:
   * a job already in a terminal state is returned unchanged. `opts.reason`/`opts.kind`
   * let the orphan sweep reuse this with its own wording.
   */
  async stop(
    workspaceId: string,
    jobId: string,
    opts: { reason?: string; kind?: BootstrapFailureKind } = {},
  ): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
    )
    if (record.status === 'succeeded' || record.status === 'failed') return toBootstrapJob(record)

    // Kill the per-run container first, then the durable driver, so neither is left
    // running once the job is marked terminal. Both are best-effort/idempotent.
    await this.stopContainer(workspaceId, jobId, record.driveId)
    await this.deps.bootstrapRunner?.cancelRun(workspaceId, record.driveId)

    const message = opts.reason ?? 'Stopped by the user.'
    const patch = {
      status: 'failed' as const,
      error: message,
      failure: this.buildFailure(opts.kind ?? 'cancelled', message, null, record.subtasks),
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.bootstrapJobRepository.update(workspaceId, jobId, patch)
    const block = await this.markFrame(
      workspaceId,
      record.blockId,
      'blocked',
      `Bootstrap stopped: ${message}`,
    )
    await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
    return toBootstrapJob({ ...record, ...patch })
  }

  /**
   * The durable-driver key a run is CURRENTLY driven under, for the stale-run sweeper.
   *
   * The sweeper reads `agent_runs` generically and only ever learns a run's id, but a monorepo
   * run in its apply phase is driven under a different key, so probing and re-driving it by run
   * id would find no instance and finalize a perfectly healthy run as an orphan. Falls back to
   * the run id for a run it cannot read, which is the key every single-drive run uses.
   */
  async driveIdOf(workspaceId: string, jobId: string): Promise<string> {
    const record = await this.deps.bootstrapJobRepository.get(workspaceId, jobId)
    return record?.driveId ?? jobId
  }

  // ---- the monorepo flow's three moves ------------------------------------

  /**
   * The SURVEY phase, run on the durable driver's first poll: read the monorepo and the
   * reference template, ask the advisor what the new service should adopt from each, and park
   * the run on the human decision.
   *
   * It never fails the run. A missing model, an unreadable repository or an unusable reply all
   * park with a plan recorded `unavailable` and the cause, because the DECISION is the point of
   * the phase and the suggestion is only an aid: a human bootstrapping into a monorepo on a
   * deployment with no model still gets to make the call, unaided and told so.
   *
   * Guarded by an ATOMIC CLAIM taken BEFORE the model call, not by the plan written after it. A
   * stored plan short-circuits a LATER drive, but two drives racing the FIRST one both read no
   * plan, and the survey's cost is a vendor call plus a `park` that would replace the plan under
   * a reviewer already looking at the other one (whose answers then 422). `claimSurvey` is one
   * conditional UPDATE, so exactly one drive proceeds and the loser leaves the run alone.
   */
  private async runSurvey(
    workspaceId: string,
    record: BootstrapJobRecord,
  ): Promise<BootstrapPollResult> {
    if (record.adoptionPlan) {
      // A plan is already recorded. Bring the row's status in line with it (a driver that died
      // between producing the plan and recording the park re-enters here) and stop. That holds
      // for an `unavailable` plan too: re-surveying would spend again on a park a human can
      // already settle, and `retry` is the deliberate re-survey (it clears a non-ready plan).
      if (record.status !== 'awaiting_review') {
        await this.park(workspaceId, record, record.adoptionPlan)
      }
      return { state: 'awaiting_review' }
    }
    const now = this.deps.clock.now()
    const claimed = await this.deps.bootstrapJobRepository.claimSurvey(workspaceId, record.id, {
      at: now,
      staleBefore: now - SURVEY_CLAIM_TTL_MS,
    })
    if (!claimed) {
      // Another drive holds the claim and will park the run. Reported as still RUNNING because
      // that is what the row says: the next poll reads the winner's plan and parks.
      return { state: 'running' }
    }
    const reference = record.referenceArchitectureId
      ? await this.deps.referenceArchitectureRepository.get(
          workspaceId,
          record.referenceArchitectureId,
        )
      : null
    const plan = await this.monorepo.buildAdoptionPlan(workspaceId, record, reference)
    await this.park(workspaceId, record, plan)
    return { state: 'awaiting_review' }
  }

  /** Record the plan, flip the run + its frame to "waiting for you", and announce it. */
  private async park(
    workspaceId: string,
    record: BootstrapJobRecord,
    adoptionPlan: BootstrapJobRecord['adoptionPlan'],
  ): Promise<void> {
    const patch = {
      status: 'awaiting_review' as const,
      adoptionPlan,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
    const block = await this.markFrame(
      workspaceId,
      record.blockId,
      'blocked',
      adoptionPlan?.status === 'ready'
        ? `Waiting for review: which conventions this service should adopt from ${record.monorepo?.repoOwner}/${record.monorepo?.repoName} and which to keep from the template.`
        : `Waiting for review: the platform could not produce an adoption suggestion, so the decisions are yours to make before the service is written.`,
    )
    await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
  }

  /**
   * Settle a parked run's adoption decisions and resume it.
   *
   * The refusals are the interesting half. A run that is not parked is a 409 naming where it
   * actually is (the reviewer is looking at a stale tab, and applying their answers to a run
   * that has moved on would build under a review given for a different proposal), and an
   * incomplete or mismatched set of choices is a 422 from `resolveAdoptionReview`, never a
   * silent fill from the recommendation, which would erase the difference between a human
   * agreeing with the suggestion and never having read it.
   */
  async submitAdoptionReview(
    workspaceId: string,
    jobId: string,
    input: AdoptionReviewInput,
    reviewedByUserId: string | null,
  ): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const record = assertFound(
      await this.deps.bootstrapJobRepository.get(workspaceId, jobId),
      'Bootstrap job',
      jobId,
      { reason: 'bootstrap_job_not_found' },
    )
    if (record.status !== 'awaiting_review') {
      throw new ConflictError(
        `This bootstrap is not waiting for an adoption review (it is '${record.status}').`,
        'bootstrap_not_awaiting_review',
        { status: record.status },
      )
    }
    if (!record.monorepo || !record.adoptionPlan) {
      throw new ConflictError(
        'This bootstrap has no adoption plan recorded, so there is nothing to approve.',
        'adoption_plan_unavailable',
        { unavailableReason: null },
      )
    }
    const resolved = resolveAdoptionReview(record.adoptionPlan, input.choices, {
      reviewedByUserId,
      reviewedAt: this.deps.clock.now(),
      notes: input.notes,
    })
    return await this.dispatchApply(workspaceId, record, resolved)
  }

  /**
   * The APPLY phase: dispatch the container that writes the service into the monorepo under the
   * settled decisions and opens the pull request.
   *
   * Its own drive id, because this is the run's SECOND durable drive: the survey's already went
   * terminal, and neither facade's driver can be re-keyed on a key that has (a Workflows
   * instance id cannot be recreated; a pg-boss singleton would dedupe against the finished job).
   */
  private async dispatchApply(
    workspaceId: string,
    record: BootstrapJobRecord,
    resolved: NonNullable<BootstrapJobRecord['adoptionReview']>,
  ): Promise<BootstrapJob> {
    const bootstrapper = this.deps.repoBootstrapper
    const monorepo = record.monorepo
    if (!bootstrapper || !monorepo) {
      throw new Error('Repository bootstrapping is not configured')
    }
    const reference = record.referenceArchitectureId
      ? await this.deps.referenceArchitectureRepository.get(
          workspaceId,
          record.referenceArchitectureId,
        )
      : null
    const branch = this.monorepo.branchFor(record.id)
    // `-apply`, not `:apply`: this string becomes a Cloudflare Workflows INSTANCE ID, whose
    // accepted character set is narrower than a run id's and does not include a colon, and a
    // rejected `create` is swallowed by design (a duplicate start is normal), so the failure
    // would be an approved bootstrap that silently never dispatches.
    const driveId = `${record.id}-apply`
    const leg: MonorepoBootstrapLeg = {
      repoGithubId: monorepo.repoGithubId,
      owner: monorepo.repoOwner,
      name: monorepo.repoName,
      directory: monorepo.directory,
      branch,
      pr: {
        title: monorepoBootstrapPrTitle(record.repoName, monorepo.directory),
        // The HOST rendering (neutralised holes, scrubbed at compose time), never the agent
        // brief: this string lands on a pull request body, where a reviewer's note reading
        // "fixes #412" would close an unrelated issue on merge. It is the FALLBACK body; the
        // engine also publishes the same decisions as its own marker region once the pull
        // request exists, because the harness lets an agent-authored description replace this.
        body: redactSecrets(renderAdoptionPrSection(resolved, monorepo.directory)) ?? '',
      },
    }
    const started: MonorepoBootstrapRef = { ...monorepo, branch }
    const patch = {
      status: 'running' as const,
      phase: 'apply' as const,
      driveId,
      adoptionReview: resolved,
      monorepo: started,
      error: null,
      failure: null,
      updatedAt: this.deps.clock.now(),
    }
    // Record the settled review BEFORE dispatching. The decisions are the human's, and losing
    // them to a dispatch failure would send them back to a review they already gave; with them
    // committed first, a retry re-dispatches under the same decisions.
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)

    try {
      await bootstrapper.startBootstrap({
        workspaceId,
        jobId: record.id,
        containerJobId: driveId,
        referenceRepo: reference
          ? { owner: reference.repoOwner, name: reference.repoName }
          : undefined,
        target: { name: record.repoName, description: '', private: true },
        monorepo: leg,
        // The agent's brief is the run's own instructions PLUS the settled decisions, rendered
        // as instructions rather than as context: an agent told only what the areas are decides
        // them again, which is precisely what the review exists to prevent.
        instructions: `${record.instructions}\n\n${renderAdoptionBrief(
          resolved,
          monorepo.directory,
        )}`,
      })
    } catch (error) {
      const message = getErrorMessage(error)
      const kind: BootstrapFailureKind = isDispatchFailure(error) ? 'dispatch' : 'preflight'
      const failed = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure(kind, message, null, record.subtasks),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, failed)
      await this.stopContainer(workspaceId, record.id, driveId)
      const block = await this.markFrame(
        workspaceId,
        record.blockId,
        'blocked',
        `Bootstrap failed: ${message}`,
      )
      const job = toBootstrapJob({ ...record, ...patch, ...failed })
      await this.emitBootstrap(workspaceId, job, block)
      return job
    }

    const frame = await this.markFrame(
      workspaceId,
      record.blockId,
      'in_progress',
      `Writing ${monorepo.directory} into ${monorepo.repoOwner}/${monorepo.repoName}…`,
    )
    await this.deps.bootstrapRunner?.startRun(workspaceId, record.id, driveId)
    const job = toBootstrapJob({ ...record, ...patch })
    await this.emitBootstrap(workspaceId, job, frame)
    return job
  }

  /**
   * Finish a monorepo apply: bind the frame's service to the monorepo AT ITS DIRECTORY and
   * report the pull request.
   *
   * A completed apply with NO pull request is a failure, not a success with a null field: the
   * deliverable of a monorepo bootstrap is the PR (nothing is merged for the reviewer), so a run
   * that reports done without one has left the work somewhere nobody can find it. Failing here
   * says that, where marking the frame ready would claim a service that does not exist.
   */
  private async finishMonorepoApply(
    workspaceId: string,
    record: BootstrapJobRecord,
    prUrl: string | undefined,
  ): Promise<BootstrapPollResult> {
    const monorepo = record.monorepo
    await this.stopContainer(workspaceId, record.id, record.driveId)
    if (!monorepo || !prUrl) {
      const message =
        'The bootstrap agent finished without opening a pull request, so the new service was not delivered anywhere.'
      const patch = {
        status: 'failed' as const,
        error: message,
        failure: this.buildFailure('agent', message, null, record.subtasks),
        updatedAt: this.deps.clock.now(),
      }
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
      const blocked = await this.markFrame(
        workspaceId,
        record.blockId,
        'blocked',
        `Bootstrap failed: ${message}`,
      )
      await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), blocked)
      return { state: 'failed', error: message }
    }

    const patch = {
      status: 'succeeded' as const,
      repoOwner: monorepo.repoOwner,
      // `repoUrl` stays null. It is the public API's "web URL of the created repository", and a
      // monorepo run creates none: writing the pull request there would re-scope a released
      // field in place, and an integration that clones `repoUrl` would clone a PR link. `prUrl`
      // is the field this run's deliverable belongs in, and it is projected publicly beside it.
      prUrl,
      updatedAt: this.deps.clock.now(),
    }
    await this.deps.bootstrapJobRepository.update(workspaceId, record.id, patch)
    const review = record.adoptionReview
    if (review) {
      // Best-effort: the pull request is open, the decisions are on the run record the board
      // renders, and failing the run over a description write would discard a delivered service.
      // The warning is what makes the omission visible rather than silent.
      await runBestEffort(
        this.log,
        'monorepo bootstrap: publish adoption decisions onto the pull request',
        () => this.monorepo.publishAdoptionDecisions(workspaceId, monorepo, prUrl, review),
        { workspaceId, jobId: record.id, prUrl },
      )
    }
    if (record.blockId) {
      // Best-effort, as on the new-repo path: the pull request is open either way, and a
      // linkage failure must not report the run as failed. The `directory` is what makes the
      // linkage a monorepo one: `resolveRepoTarget` scopes every agent working on this service
      // to that subtree, and the repo's monorepo flag was set at pre-flight so it is honoured.
      try {
        const service = await this.deps.serviceRepository?.getByFrameBlock(record.blockId)
        if (service) {
          await this.deps.serviceRepository?.update(service.id, {
            repoGithubId: monorepo.repoGithubId,
            directory: monorepo.directory,
          })
        }
      } catch {
        // swallow: see above
      }
    }
    const block = await this.markFrame(
      workspaceId,
      record.blockId,
      'ready',
      `Service bootstrapped into ${monorepo.repoOwner}/${monorepo.repoName} at ${monorepo.directory}. Review and merge the pull request, then drop tasks here.`,
    )
    await this.emitBootstrap(workspaceId, toBootstrapJob({ ...record, ...patch }), block)
    return { state: 'done' }
  }

  // ---- helpers ------------------------------------------------------------

  /** The workspace default fragment ids a new service inherits; empty / never throws. */
  private async defaultServiceFragmentIds(workspaceId: string): Promise<string[]> {
    if (!this.deps.serviceFragmentDefaultsRepository) return []
    try {
      return await this.deps.serviceFragmentDefaultsRepository.get(workspaceId)
    } catch {
      return []
    }
  }

  /**
   * Create the provisional, in-progress service frame a bootstrap run materialises.
   *
   * A monorepo run's frame carries its `directory` from the start, while the repo binding waits
   * for the run to succeed exactly as the new-repo path's does: the directory is a fact the
   * pre-flight already settled (and what the board card is about), whereas the linkage is a
   * claim that there is code there, which is only true once the pull request exists.
   */
  private async createServiceFrame(
    workspaceId: string,
    repoName: string,
    frameType: BlockType = 'service',
    monorepo?: MonorepoBootstrapRef,
  ): Promise<Block> {
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const frames = blocks.filter((b) => b.level === 'frame').length
    const type: BlockType = frameType
    const serviceFragmentIds = await this.defaultServiceFragmentIds(workspaceId)
    const block: Block = {
      id: this.deps.idGenerator.next('blk'),
      title: repoName,
      type,
      description: monorepo
        ? `Bootstrapping ${monorepo.directory} in ${monorepo.repoOwner}/${monorepo.repoName}… surveying the monorepo's conventions.`
        : 'Bootstrapping repository… a container is adapting and pushing the initial commit.',
      // Stagger so a fresh frame doesn't land exactly on an existing one.
      position: { x: 80 + (frames % 5) * 48, y: 80 + (frames % 5) * 48 },
      status: 'in_progress',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
      ...(serviceFragmentIds.length ? { serviceFragmentIds } : {}),
    }
    // Register the bootstrapped frame as an account-owned service + mount (no-op when sharing
    // isn't wired), so a bootstrapped service is shareable and its run is service-discoverable.
    const serviceId = await registerServiceForFrame(
      {
        serviceRepository: this.deps.serviceRepository,
        workspaceMountRepository: this.deps.workspaceMountRepository,
        workspaceRepository: this.deps.workspaceRepository,
        idGenerator: this.deps.idGenerator,
        clock: this.deps.clock,
      },
      workspaceId,
      block,
      // The repo ids stay unset until the run delivers (see the doc comment): a service
      // pinned to a repo it has not written to yet would dispatch tasks into an empty
      // directory. `directory` is carried now because it is what the frame IS.
      monorepo ? { directory: monorepo.directory } : undefined,
    )
    await this.deps.blockRepository.insert(workspaceId, block, serviceId)
    return block
  }

  /** Flip a bootstrap's frame to a terminal status + description; null-safe. */
  private async markFrame(
    workspaceId: string,
    blockId: string | null,
    status: Block['status'],
    description: string,
  ): Promise<Block | null> {
    if (!blockId) return null
    const existing = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!existing) return null
    const progress = status === 'ready' ? 1 : existing.progress
    await this.deps.blockRepository.update(workspaceId, blockId, { status, description, progress })
    return { ...existing, status, description, progress }
  }

  /** Assemble the structured failure diagnostics stored on a faulted job. */
  private buildFailure(
    kind: BootstrapFailureKind,
    message: string,
    detail: string | null,
    lastSubtasks: StepSubtasks | null,
  ): BootstrapFailure {
    return {
      kind,
      message,
      detail,
      hint: FAILURE_HINTS[kind],
      occurredAt: this.deps.clock.now(),
      lastSubtasks: lastSubtasks ?? null,
    }
  }

  /** Best-effort: reclaim a job's per-run container (never throws). */
  private async stopContainer(
    workspaceId: string,
    jobId: string,
    containerJobId: string,
  ): Promise<void> {
    try {
      await this.deps.repoBootstrapper?.stopBootstrap({ workspaceId, jobId, containerJobId })
    } catch {
      // The container may already be gone (the common case for an eviction); the
      // job is already recorded failed, so a stop failure changes nothing.
    }
  }

  /**
   * Best-effort push of a bootstrap transition to subscribed clients.
   *
   * A `block` is given exactly on the passes where the run's service FRAME changed on the board:
   * it was materialised, flipped to ready, or flipped to blocked. The frame cannot ride as a
   * payload (`deliverableBoardBlock` refuses it, because a frame's geometry is a per-board mount
   * override and one published payload has to be correct on every board the fan-out reaches), so
   * the frame transition is announced as a coarse board signal NAMING it and each board re-reads
   * its own projection. Naming it is also what fans the signal out past the origin workspace.
   *
   * A plain progress tick passes no block and so costs no refresh anywhere: that split is the
   * point, since the poll loop ticks far more often than the frame changes.
   */
  private async emitBootstrap(
    workspaceId: string,
    job: BootstrapJob,
    block: Block | null,
  ): Promise<void> {
    await this.deps.eventPublisher?.bootstrapChanged?.(workspaceId, job, block)
    if (!block) return
    await this.deps.eventPublisher?.boardChanged(workspaceId, {
      reason: `bootstrap-${job.status}`,
      blockId: block.id,
    })
  }
}

/** A next-step pointer per failure kind, surfaced on the board's failed card. */
const FAILURE_HINTS: Record<BootstrapFailureKind, string> = {
  preflight:
    'Check the target repository exists under the connected account, is empty (or holds only README/.gitignore/license/AGENTS.md), and that the GitHub App is installed on it. Then retry.',
  dispatch:
    'The container could not be reached to start the job. This is usually transient — retry. If it persists, check the Worker logs in the Cloudflare dashboard.',
  evicted:
    'The container that was running this job no longer has it — it was evicted, restarted, or crashed before completing. Inspect its stdout/stderr in the Cloudflare dashboard (Workers Observability → container logs, filtered by this job id), then retry to spin a fresh container.',
  timeout:
    'A container watchdog fired (no agent activity, or the max run duration was exceeded). Check the container logs for where it stalled, then retry.',
  agent:
    'The bootstrapper agent or the git push reported a failure. See the detail below and the container logs, fix the cause if needed, then retry.',
  cancelled: 'You stopped this run; its container was killed. Retry to start it again.',
  unknown: 'See the detail below and the container logs in the Cloudflare dashboard, then retry.',
}
