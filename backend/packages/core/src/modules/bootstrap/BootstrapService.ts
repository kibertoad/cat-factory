import type {
  BootstrapJob,
  BootstrapRepoInput,
  CreateReferenceArchitectureInput,
  ReferenceArchitecture,
  UpdateReferenceArchitectureInput,
} from '../../domain/types'
import type { Clock, IdGenerator } from '../../ports/runtime'
import type { WorkspaceRepository } from '../../ports/repositories'
import type {
  BootstrapJobRecord,
  BootstrapJobRepository,
  ReferenceArchitectureRecord,
  ReferenceArchitectureRepository,
} from '../../ports/bootstrap-repositories'
import type { RepoBootstrapper } from '../../ports/repo-bootstrapper'
import { assertFound } from '../../domain/errors'
import { requireWorkspace } from '../workspaces/WorkspaceService'

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
  idGenerator: IdGenerator
  clock: Clock
  /** Performs the side-effecting create-repo + container bootstrap; optional. */
  repoBootstrapper?: RepoBootstrapper
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
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

/** Join the reference architecture's default instructions with per-run extras. */
function composeInstructions(defaults: string, extra: string): string {
  return [defaults.trim(), extra.trim()].filter((part) => part.length > 0).join('\n\n')
}

export class BootstrapService {
  constructor(private readonly deps: BootstrapServiceDependencies) {}

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
    const records = await this.deps.bootstrapJobRepository.listByWorkspace(workspaceId)
    return records.map(toBootstrapJob)
  }

  async getJob(workspaceId: string, id: string): Promise<BootstrapJob> {
    return toBootstrapJob(
      assertFound(await this.deps.bootstrapJobRepository.get(workspaceId, id), 'Bootstrap job', id),
    )
  }

  /**
   * Create a new repository from a reference architecture and run the bootstrapper
   * agent against it. Records a job throughout: `running` while the container works,
   * then `succeeded` (with the repo URL) or `failed` (with the reason). The job is
   * returned in its terminal state. Requires {@link canBootstrap}.
   */
  async bootstrap(workspaceId: string, input: BootstrapRepoInput): Promise<BootstrapJob> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const bootstrapper = this.deps.repoBootstrapper
    if (!bootstrapper) {
      throw new Error('Repository bootstrapping is not configured')
    }

    const reference = assertFound(
      await this.deps.referenceArchitectureRepository.get(
        workspaceId,
        input.referenceArchitectureId,
      ),
      'Reference architecture',
      input.referenceArchitectureId,
    )

    const instructions = composeInstructions(reference.defaultInstructions, input.instructions)
    const now = this.deps.clock.now()
    const record: BootstrapJobRecord = {
      id: this.deps.idGenerator.next('boot'),
      workspaceId,
      referenceArchitectureId: reference.id,
      referenceArchitectureName: reference.name,
      repoName: input.repoName,
      repoOwner: null,
      repoUrl: null,
      instructions,
      status: 'running',
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.bootstrapJobRepository.insert(record)

    try {
      const outcome = await bootstrapper.bootstrap({
        workspaceId,
        jobId: record.id,
        referenceRepo: { owner: reference.repoOwner, name: reference.repoName },
        target: {
          name: input.repoName,
          description: input.description,
          private: input.private,
        },
        instructions,
      })
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, {
        status: 'succeeded',
        repoOwner: outcome.owner,
        repoUrl: outcome.repoUrl,
        updatedAt: this.deps.clock.now(),
      })
      return toBootstrapJob({
        ...record,
        status: 'succeeded',
        repoOwner: outcome.owner,
        repoUrl: outcome.repoUrl,
        updatedAt: this.deps.clock.now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.deps.bootstrapJobRepository.update(workspaceId, record.id, {
        status: 'failed',
        error: message,
        updatedAt: this.deps.clock.now(),
      })
      return toBootstrapJob({
        ...record,
        status: 'failed',
        error: message,
        updatedAt: this.deps.clock.now(),
      })
    }
  }
}
