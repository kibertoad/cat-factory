import type {
  AdoptionPlan,
  AdoptionPlanUnavailableReason,
  MonorepoBootstrapRef,
  MonorepoBootstrapTarget,
  ResolvedAdoption,
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
  PR_ADOPTION_MARKERS,
  redactSecrets,
  renderAdoptionPrSection,
  spliceManagedSection,
  UnavailableError,
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
  /**
   * Checkout-free reads, scoped to the workspace's LINKED repos. Required in practice: the
   * target-directory pre-flight cannot run without it, so an unwired deployment refuses a
   * monorepo bootstrap rather than accepting one it could not check.
   */
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /** The suggestion seam; absent or disabled ⇒ the run parks with an `unavailable` plan. */
  adoptionAdvisor?: MonorepoAdoptionAdvisor
  /**
   * The workspace spend safeguard. The survey's suggestion is a billable model call that NO run
   * start gates (a bootstrap is not a pipeline run), so it answers to the same budget
   * `RunAdmission` applies before a run, exactly as the bug hunt's ranking does. Absent ⇒ no
   * budget is enforced, which is the pre-existing behaviour for a facade that wires no spend
   * service at all.
   */
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  clock: Clock
  logger?: Logger | undefined
}

/**
 * The pull-request number in a host PR/MR url, or null when the url does not carry one.
 *
 * Both host shapes, because the engine's VCS client is provider-neutral and a GitLab deployment
 * reaches this path through the same adapter. Null rather than a guess: the number addresses a
 * WRITE to somebody else's repository, so an unreadable url must stop the write rather than send
 * it somewhere arbitrary.
 */
function prNumberFromUrl(url: string): number | null {
  const match = /\/(?:pull|merge_requests)\/(\d+)/.exec(url)
  const parsed = match ? Number(match[1]) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
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
   * Four refusals, each naming a way the run would otherwise damage a repository that is not
   * its own:
   *
   *  - the repo must be one the WORKSPACE projects. Resolving an arbitrary `owner/name` the
   *    deployment credential can reach would make this endpoint a way to open pull requests
   *    against any repository the installation touches.
   *  - it must be READABLE through this workspace's connection. Never optional, which is the
   *    point: the directory check below is the only thing standing between a bootstrap and
   *    somebody else's service, and a check that quietly disappears when the binding fails is
   *    worse than no check, because the flow claims to have made it. The binding is also
   *    provider-matched, so this is where a repo projected under a provider the bootstrapper
   *    cannot push to is refused, rather than at a dispatch that would build its clone URL off
   *    the wrong host.
   *  - the directory must not already exist. A bootstrap WRITES a service; landing it on top of
   *    one that is already there is not a merge, it is a silent overwrite of somebody's work.
   *  - the path must stay inside the repository (`normalizeServiceDirectory`), since it becomes
   *    an agent's working directory.
   *
   * Only then is the repo MARKED a monorepo. That ordering is load-bearing: `resolveRepoTarget`
   * hands an agent a service's subdirectory only while the flag is on, so the mark cannot be
   * skipped (a service pinned to a directory of an unmarked repo is dispatched at the repository
   * ROOT, building in the wrong place with nothing to say so) and it cannot be written early
   * either, because a refused request would then leave every service already pinned to that repo
   * running somewhere else.
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
    const resolveFiles = this.deps.resolveRepoFilesForCoords
    if (!resolveFiles) {
      // A wiring gap, so the status class's generic copy ("this deployment has not configured the
      // capability this action needs") states it correctly and the refusal carries no reason.
      throw new UnavailableError(
        'Bootstrapping into a monorepo needs checkout-free repository reads, which this deployment has not wired.',
      )
    }
    const repo = await bootstrapper.resolveMonorepoTarget(workspaceId, target.repoGithubId)
    if (!repo) {
      // 404 on a repo the workspace does not project, on the same 404-hides-everything rule the
      // rest of the surface follows: a repository somebody else linked is ABSENT here, not
      // forbidden, so the refusal cannot be used to probe what the deployment can reach.
      throw new NotFoundError('Repository', String(target.repoGithubId), {
        reason: 'repo_not_linked',
      })
    }

    const files = await resolveFiles(workspaceId, { owner: repo.owner, repo: repo.name })
    if (!files) {
      throw new ValidationError(
        `${repo.owner}/${repo.name} cannot be read through this workspace's source-control connection, so the target directory cannot be checked before writing to it. Re-connect the repository's provider and try again.`,
        { reason: 'monorepo_repo_unreadable', repoGithubId: target.repoGithubId },
      )
    }
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

    await bootstrapper.markRepoAsMonorepo(workspaceId, target.repoGithubId)
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

    // Checked BEFORE the call, and reported as its OWN reason rather than folded into
    // `model_unavailable`: an exhausted budget is not an unwired model, and "raise the budget or
    // wait for the window to roll" is not the fix for "configure a provider". A probe that itself
    // throws is treated as over budget, which is the only safe direction for a spend guard.
    const overBudget = await this.overBudget(workspaceId, log)
    if (overBudget) {
      return {
        ...this.unavailable(
          'budget_exhausted',
          'This workspace is over its model budget, so the platform did not pay for an adoption suggestion. The decisions are still yours to make, or raise the budget and retry the run for a suggestion.',
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

  /**
   * Whether the workspace is over its model budget. Fails CLOSED: a probe that throws counts as
   * over budget, because the alternative is spending on a ledger nobody could read.
   */
  private async overBudget(workspaceId: string, log: Logger | undefined): Promise<boolean> {
    const probe = this.deps.isOverBudget
    if (!probe) return false
    try {
      return await probe(workspaceId)
    } catch (error) {
      log?.warn('monorepo bootstrap: budget probe failed; withholding the suggestion', {
        err: getErrorMessage(error),
      })
      return true
    }
  }

  /**
   * Publish the settled decisions onto the pull request the apply phase opened, as an
   * engine-managed marker region of its body.
   *
   * A REGION rather than the body itself, because the body is not the engine's to own: the
   * harness folds an agent-authored `.cat-pr-description.md` over the dispatch-time body
   * field-wise, and it asks the agent to write one whenever the monorepo ships a PR template, so
   * the dispatch-time copy of this section is routinely replaced. The reviewed decisions are the
   * one thing on that pull request the agent did not choose and cannot restate, so they get their
   * own region: read-splice-write against the CURRENT body, so the agent's narrative and any
   * human edit above and below it survive, and idempotent, so a retry replaces the region rather
   * than appending a second copy.
   *
   * Throws on failure; the caller runs it best-effort. The pull request is open either way, the
   * decisions are on the run record the board renders, and failing the run over a description
   * write would discard a delivered service.
   */
  async publishAdoptionDecisions(
    workspaceId: string,
    monorepo: MonorepoBootstrapRef,
    prUrl: string,
    resolved: ResolvedAdoption,
  ): Promise<void> {
    const number = prNumberFromUrl(prUrl)
    if (number === null) throw new Error(`Could not read a pull request number from ${prUrl}`)
    const bound = await this.deps.resolveRepoFilesForCoords?.(workspaceId, {
      owner: monorepo.repoOwner,
      repo: monorepo.repoName,
    })
    const read = bound?.repo.getPullRequestBody
    const write = bound?.repo.updatePullRequestBody
    if (!read || !write) {
      throw new Error('The bound repository client cannot read or write a pull request body')
    }
    const current = await read(number)
    // Scrubbed at COMPOSE time, before the section is capped, so the prose a reviewer reads and
    // the text the caps measured are the same text.
    const section = redactSecrets(renderAdoptionPrSection(resolved, monorepo.directory)) ?? ''
    const next = spliceManagedSection(current, section, PR_ADOPTION_MARKERS)
    if (next === (current ?? '')) return
    await write(number, next)
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
