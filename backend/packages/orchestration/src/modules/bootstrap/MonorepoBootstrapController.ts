import type {
  AdoptionPlan,
  AdoptionPlanUnavailableReason,
  MonorepoBootstrapRef,
  MonorepoBootstrapTarget,
} from '@cat-factory/contracts'
import type {
  BootstrapJobRecord,
  Clock,
  Logger,
  MonorepoAdoptionAdvisor,
  ReferenceArchitectureRecord,
  RepoBootstrapper,
  ResolveRepoFilesForCoords,
} from '@cat-factory/kernel'
import {
  ConflictError,
  getErrorMessage,
  monorepoBootstrapBranch,
  NotFoundError,
  parseAdoptionDecisions,
  redactSecrets,
  ValidationError,
} from '@cat-factory/kernel'
import { normalizeServiceDirectory } from '../board/serviceRepoLinkage.js'
import { surveyMonorepo, type SurveySide } from './monorepoSurvey.js'

// ---------------------------------------------------------------------------
// The monorepo half of a bootstrap run, kept apart from `BootstrapService` because it is a
// different flow rather than an option on the existing one: two drives with a human park
// between them, a pre-flight about a repository that already holds other people's code, and a
// suggestion whose whole value is that a person can check it.
//
// `BootstrapService` keeps the lifecycle (records, frames, events, the durable driver) and
// delegates the monorepo-specific decisions here.
// ---------------------------------------------------------------------------

export interface MonorepoBootstrapDeps {
  /** Checkout-free reads, scoped to the workspace's LINKED repos. */
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /** The suggestion seam; absent or disabled ⇒ the run parks with an `unavailable` plan. */
  adoptionAdvisor?: MonorepoAdoptionAdvisor
  clock: Clock
  logger?: Logger | undefined
}

/** A resolved monorepo target plus what the survey will need to read it. */
export interface ResolvedMonorepoTarget {
  ref: MonorepoBootstrapRef
  /** The installation the monorepo is reached through, for the container dispatch. */
  installationId: number
}

export class MonorepoBootstrapController {
  constructor(private readonly deps: MonorepoBootstrapDeps) {}

  /**
   * Pre-flight a monorepo target and resolve it to the stored ref.
   *
   * Three refusals, each naming a way the run would otherwise damage a repository that is not
   * its own:
   *
   *  - the repo must be one the WORKSPACE projects. Resolving an arbitrary `owner/name` the
   *    deployment credential can reach would make this endpoint a way to open pull requests
   *    against any repository the installation touches.
   *  - the directory must not already exist. A bootstrap WRITES a service; landing it on top of
   *    one that is already there is not a merge, it is a silent overwrite of somebody's work.
   *  - the path must stay inside the repository (`normalizeServiceDirectory`), since it becomes
   *    an agent's working directory.
   *
   * Flipping the repo's `isMonorepo` flag is part of the resolution, not a side effect of it:
   * `resolveRepoTarget` hands an agent a service's subdirectory only while the flag is on, so a
   * service pinned to a directory of a repo not marked as a monorepo would be dispatched at the
   * repository ROOT: the run would build in the wrong place and nothing would say so.
   */
  async resolveTarget(
    bootstrapper: RepoBootstrapper,
    workspaceId: string,
    target: MonorepoBootstrapTarget,
  ): Promise<ResolvedMonorepoTarget> {
    const directory = normalizeServiceDirectory(target.directory)
    if (!directory) {
      throw new ValidationError('Name the subdirectory the new service will live in.', {
        reason: 'monorepo_requires_directory',
      })
    }
    const repo = await bootstrapper.prepareMonorepoTarget(workspaceId, target.repoGithubId)
    if (!repo) {
      // 404 on a repo the workspace does not project, on the same 404-hides-everything rule the
      // rest of the surface follows: a repository somebody else linked is ABSENT here, not
      // forbidden, so the refusal cannot be used to probe what the deployment can reach.
      throw new NotFoundError('Repository', String(target.repoGithubId), {
        reason: 'repo_not_linked',
      })
    }

    const files = await this.deps.resolveRepoFilesForCoords?.(workspaceId, {
      owner: repo.owner,
      repo: repo.name,
    })
    if (files) {
      // `listDirectory` answers `[]` for an absent path, so a non-empty listing is the directory
      // existing. A read FAILURE throws out of here rather than being read as "absent": letting
      // a rate limit stand in for an empty directory is exactly how a run would overwrite one.
      const existing = await files.repo.listDirectory(directory, files.baseBranch)
      if (existing.length > 0) {
        throw new ConflictError(
          `\`${directory}\` already exists in ${repo.owner}/${repo.name}. Bootstrapping creates a new service; pick a directory that does not exist yet, or import the existing one as a service instead.`,
          'monorepo_directory_taken',
          { directory },
        )
      }
    }

    return {
      ref: {
        repoGithubId: target.repoGithubId,
        directory,
        repoOwner: repo.owner,
        repoName: repo.name,
        branch: null,
      },
      installationId: repo.installationId,
    }
  }

  /** The branch the apply phase pushes; stable per run so a retry resumes rather than forks. */
  branchFor(jobId: string): string {
    return monorepoBootstrapBranch(jobId)
  }

  /**
   * Survey both repositories and produce the plan a human reviews. NEVER throws: every failure
   * becomes a plan recorded `unavailable` with the cause, because the run parks either way and a
   * reviewer who is shown nothing must be told whether that means "the two agree" or "the
   * analysis never ran".
   */
  async buildAdoptionPlan(
    workspaceId: string,
    record: BootstrapJobRecord,
    reference: ReferenceArchitectureRecord | null,
  ): Promise<AdoptionPlan> {
    const monorepo = record.monorepo
    if (!monorepo) {
      return this.unavailable('repo_unreadable', 'This run has no monorepo target recorded.')
    }
    const log = this.deps.logger?.child({ workspaceId, jobId: record.id })

    const monoSide = await this.side(workspaceId, monorepo.repoOwner, monorepo.repoName)
    if (!monoSide) {
      return this.unavailable(
        'repo_unreadable',
        `${monorepo.repoOwner}/${monorepo.repoName} could not be read through this workspace's VCS connection.`,
      )
    }
    // A reference architecture the workspace has not LINKED is unreadable from here even though
    // the apply phase's container can still clone it with the installation token. Stated rather
    // than silently surveyed as empty: "the template ships nothing for this area" and "nobody
    // looked at the template" lead a reviewer to opposite conclusions.
    const templateSide = reference
      ? await this.side(workspaceId, reference.repoOwner, reference.repoName)
      : undefined

    const { survey, files } = await surveyMonorepo({
      monorepo: monoSide,
      ...(templateSide ? { template: templateSide } : {}),
      directory: monorepo.directory,
      logger: log,
    })
    if (reference && !templateSide) {
      survey.unreadablePaths.push(
        `template:${reference.repoOwner}/${reference.repoName} (not linked to this workspace, so it was not surveyed)`,
      )
    }

    const advisor = this.deps.adoptionAdvisor
    if (!advisor?.enabled) {
      return {
        ...this.unavailable(
          'model_unavailable',
          'No model is configured for the adoption survey, so the platform has no suggestion to offer. The decisions are still yours to make.',
        ),
        survey,
      }
    }

    try {
      // The file bodies are whatever is committed in two repositories, so they are scrubbed
      // before they reach a model, and at COMPOSE time, before the survey's own clipping is
      // read back, so the prompt and anything derived from it stay consistent.
      const scrubbed: Record<string, string> = {}
      for (const [key, body] of Object.entries(files)) scrubbed[key] = redactSecrets(body) ?? ''
      const { plan, model } = await advisor.advise({
        workspaceId,
        directory: monorepo.directory,
        instructions: record.instructions,
        survey,
        files: scrubbed,
      })
      const { decisions, dropped } = parseAdoptionDecisions(plan, survey)
      if (decisions.length === 0) {
        return {
          ...this.unavailable(
            'analysis_unusable',
            dropped.length > 0
              ? `The suggestion carried no usable decision: ${dropped.join('; ')}.`
              : 'The suggestion carried no decisions.',
          ),
          survey,
          droppedUnevidenced: dropped,
          model,
        }
      }
      log?.info('monorepo bootstrap: adoption plan ready', {
        decisions: decisions.length,
        dropped: dropped.length,
        model,
      })
      return {
        status: 'ready',
        unavailableReason: null,
        unavailableDetail: null,
        survey,
        decisions,
        droppedUnevidenced: dropped,
        model,
        generatedAt: this.deps.clock.now(),
      }
    } catch (error) {
      // The advisor already logged the cause; here it becomes the reviewer-facing reason.
      return { ...this.unavailable('analysis_unusable', getErrorMessage(error)), survey }
    }
  }

  /** Bind a `RepoFiles` for one side, or undefined when the workspace cannot read that repo. */
  private async side(
    workspaceId: string,
    owner: string,
    repo: string,
  ): Promise<SurveySide | undefined> {
    const resolved = await this.deps.resolveRepoFilesForCoords?.(workspaceId, { owner, repo })
    if (!resolved) return undefined
    return { files: resolved.repo, gitRef: resolved.baseBranch }
  }

  /** An empty plan that STATES why there is nothing to suggest. */
  private unavailable(reason: AdoptionPlanUnavailableReason, detail: string): AdoptionPlan {
    return {
      status: 'unavailable',
      unavailableReason: reason,
      unavailableDetail: detail,
      survey: {
        monorepoPaths: [],
        templatePaths: [],
        unreadablePaths: [],
        siblingService: null,
      },
      decisions: [],
      droppedUnevidenced: [],
      model: null,
      generatedAt: this.deps.clock.now(),
    }
  }
}
