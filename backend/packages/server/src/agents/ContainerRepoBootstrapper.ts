import type {
  BootstrapJobHandle,
  BootstrapJobRepository,
  BootstrapJobUpdate,
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  GitHubClient,
  MonorepoBootstrapLeg,
  MonorepoTargetRepo,
  ReferenceRepoAccess,
  GitHubInstallationRepository,
  GitHubRepo,
  GroupCacheHandle,
  ModelRef,
  RepoBootstrapper,
  RepoEntry,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause, getErrorMessage, VcsApiError } from '@cat-factory/kernel'
import { isProxyableProvider } from '@cat-factory/agents'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import type { JobPackageRegistrySpec } from './ContainerAgentExecutor.js'
import { makeRepoFiles } from './repoFiles.js'
import type { MintInstallationToken } from './repoTargeting.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

export interface ContainerRepoBootstrapperDependencies {
  /**
   * Resolve which runner backend (Cloudflare container or self-hosted pool) a
   * bootstrap job dispatches to — the same seam the implementation executor rides.
   */
  resolveTransport: ResolveRunnerTransport
  /** Resolve which GitHub installation a workspace's repos live under. */
  installationRepository: GitHubInstallationRepository
  /** Look up a job's target repo name when polling (the poll only carries a job id). */
  bootstrapJobRepository: BootstrapJobRepository
  /** Local repo projection: where the bootstrapped repo is recorded + linked to its frame. */
  repoRepository: RepoProjectionRepository
  /**
   * The workspace repo-projection cache (`AppCaches.repoProjection`, slice 3): projecting
   * a freshly-bootstrapped repo changes what `resolveRepoTarget` lists, so drop the
   * workspace group after the write. Absent (tests / the Worker's pass-through) ⇒ no-op.
   */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
  /** Resolves/validates the pre-created target repository (existence + emptiness). */
  githubClient: GitHubClient
  /**
   * Mints a short-lived GitHub installation token for clone + push, scoped to the single repo
   * being bootstrapped. Bootstrap has no run initiator, so it names no `initiatedBy` and always
   * runs on the deployment credential.
   */
  mintInstallationToken: MintInstallationToken
  /** Mints the signed, model-locked LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /** Model the bootstrapper agent runs with (must be proxyable). */
  model: ModelRef
  /** Public base URL of the Worker's OpenAI-compatible LLM proxy, including `/v1`. */
  proxyBaseUrl: string
  /** GitHub REST base for creating the repo / pushing (Enterprise / api.github.com). */
  githubApiBase?: string
  /** Web base for building the created repo's URL (defaults to github.com). */
  webBaseUrl?: string
  /**
   * Resolve the workspace's private package-registry entries for the bootstrap
   * container (the scaffolder installs dependencies too). Same seam as
   * `ContainerAgentExecutorDependencies.resolvePackageRegistries`; a resolution
   * failure propagates. Absent ⇒ no registry auth is forwarded.
   */
  resolvePackageRegistries?: (workspaceId: string) => Promise<JobPackageRegistrySpec[]>
}

/** The role prompt when adapting a cloned reference architecture. */
const ADAPT_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You have a fresh clone of a reference ' +
  'architecture (a base/golden-template repository). Adapt it in place into the ' +
  'new service per the instructions: rename packages/modules, remove pieces that ' +
  'do not apply, update README and metadata, and leave the project building. Make ' +
  'focused, idiomatic changes that match the existing structure. Do not invent ' +
  'unrelated features.'

/**
 * The role prompt when writing a new service INTO an existing monorepo.
 *
 * Distinct from the two below in the thing it keeps saying: the checkout is not the new
 * service's to reshape. The agent has the monorepo (writable, at a work branch) and the
 * reference template beside it as a read-only sibling, and its whole job is confined to one
 * new subdirectory plus the minimum registration the monorepo's own tooling needs. Every
 * cross-cutting choice it might otherwise make has already been made by a human and is stated
 * in the brief, so the prompt's job is to stop it re-deciding them.
 */
const MONOREPO_SYSTEM_PROMPT =
  'You are adding a NEW service to an existing monorepo. Your working directory is the ' +
  'monorepo checkout, already on a fresh work branch. A reference template repository is ' +
  'checked out READ-ONLY as a sibling directory beside it: read from it freely, copy from it ' +
  'where the brief says to, and never write to it. ' +
  'Create the new service in the subdirectory the brief names, and touch NOTHING else in the ' +
  'monorepo except the minimum registration its own tooling requires (a workspace list, a ' +
  'build-graph entry, a CI matrix entry). Modifying an existing service is out of scope, and ' +
  'so is reformatting, upgrading or "tidying" anything you did not add. ' +
  'The brief carries adoption decisions a human has already reviewed and settled: for each ' +
  'area they say whether the new service follows the monorepo or the template. Follow them ' +
  'exactly. Do not substitute your own preference for one of them, and if a decision cannot be ' +
  'honoured as written, do the closest thing that respects it and say so in the pull request ' +
  'description rather than quietly taking the other side. ' +
  'Match the surrounding monorepo in everything the brief does NOT settle: its naming, its ' +
  'file layout, its dependency versions, its lint and test conventions. Leave the new service ' +
  'building and its tests passing.'

/** The role prompt when scaffolding a brand-new repository from scratch. */
const SCAFFOLD_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You are working in an empty directory and ' +
  'must scaffold a brand-new repository from scratch per the instructions. Create ' +
  'a sensible, idiomatic project layout: source files, a README, and the metadata ' +
  'and build/config files appropriate for the stack, leaving the project building. ' +
  'Keep the scope to what the instructions describe; do not invent unrelated features.'

/**
 * A {@link RepoBootstrapper} that performs the side-effecting half of a
 * "bootstrap repo" run. The empty target repository is created up front — by the
 * user (the default — cat-factory then needs no repo-creation permission) or, for
 * orgs served by the privileged App tier (ADR 0005), via the create-repo endpoint
 * behind the modal's "Create repository" button. This spins up a per-run Cloudflare
 * Container that clones the reference architecture, has the bootstrapper agent adapt
 * it per the instructions, and pushes the result as the new repo's initial commit.
 *
 * It pre-flights that the target repo exists, is reachable by the installation,
 * and is empty (the push is the first commit). Secrets never reach the container
 * image: the per-job GitHub installation token and the model-locked LLM-proxy
 * session token are minted here and handed over in the dispatch body, exactly as
 * the implementation executor does.
 */
export class ContainerRepoBootstrapper implements RepoBootstrapper {
  /** Shared backend-polymorphic dispatch/poll/release plumbing (see RunnerJobClient). */
  private readonly jobs: RunnerJobClient

  constructor(private readonly deps: ContainerRepoBootstrapperDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
  }

  /** An active (non-soft-deleted) installation means the workspace is connected. */
  async isWorkspaceConnected(workspaceId: string): Promise<boolean> {
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    return !!installation && !installation.deletedAt
  }

  /**
   * Resolve the reference template through the workspace's INSTALLATION, which is the same reach
   * the apply phase's clone has.
   *
   * Deliberately NOT the workspace's repo projection (`resolveRepoFilesForCoords`), the way every
   * other checkout-free read here is scoped. A reference architecture is an admin-managed entry
   * naming `owner/name`, not a repository the board has linked, so the projection answers "no such
   * repo" for a template the run then clones without trouble: the survey used to report the
   * template as unsurveyed on every deployment whose template is not also a board service. What
   * scopes this instead is the entry itself plus the installation's own grant, which is the pair
   * that decides whether the clone works.
   *
   * A 404 is the provider's answer that this credential cannot see the repository, which on GitHub
   * covers both "no such repo" and "the App was not granted it", and it is one verdict because
   * they take the same fix. Any other failure is reported as UNREADABLE rather than as an absence,
   * so an outage cannot be presented to an operator as a typo in their configuration.
   */
  async resolveReferenceRepo(
    workspaceId: string,
    ref: { owner: string; name: string },
  ): Promise<ReferenceRepoAccess> {
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) return { status: 'not_connected' }
    try {
      const repo = await this.deps.githubClient.getRepo(installation.installationId, {
        owner: ref.owner,
        repo: ref.name,
      })
      return {
        status: 'reachable',
        files: makeRepoFiles(this.deps.githubClient, installation.installationId, {
          owner: ref.owner,
          repo: ref.name,
        }),
        defaultBranch: defaultBranchOf(repo),
      }
    } catch (error) {
      if (error instanceof VcsApiError && error.status === 404) return { status: 'not_found' }
      return { status: 'unreadable', detail: getErrorMessage(error) }
    }
  }

  /**
   * Resolve a monorepo bootstrap target out of the WORKSPACE's own repo projection.
   *
   * Nothing here consults the provider: the projection is the workspace's declared set of
   * repositories, so a numeric id it does not hold is absent regardless of what the deployment's
   * credential could reach. The dispatch's own pre-flight is where write access and the target
   * directory are checked, against the provider, at the moment the run actually pushes.
   */
  async resolveMonorepoTarget(
    workspaceId: string,
    repoGithubId: number,
  ): Promise<MonorepoTargetRepo | null> {
    const repo = await this.deps.repoRepository.get(workspaceId, repoGithubId)
    if (!repo) return null
    return {
      owner: repo.owner,
      name: repo.name,
      installationId: repo.installationId,
      defaultBranch: repo.defaultBranch,
    }
  }

  /** Flip the projection's monorepo flag, once the caller's pre-flights have all passed. */
  async markRepoAsMonorepo(workspaceId: string, repoGithubId: number): Promise<void> {
    const repo = await this.deps.repoRepository.get(workspaceId, repoGithubId)
    if (!repo || repo.isMonorepo) return
    await this.deps.repoRepository.setMonorepo(workspaceId, repoGithubId, true)
    await this.deps.repoProjectionCache?.invalidateGroup(workspaceId)
  }

  /**
   * Pre-flight the target repo and dispatch the bootstrap container as a
   * background job (returns once accepted, like `/run`). Throws on a pre-flight
   * failure so the run fails fast before a board frame is created.
   */
  async startBootstrap(request: BootstrapRepoRequest): Promise<BootstrapJobHandle> {
    const log = logger.child({ jobId: request.jobId, workspaceId: request.workspaceId })
    const installation = await this.deps.installationRepository.getByWorkspace(request.workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${request.workspaceId}' is not connected to GitHub`)
    }

    if (!isProxyableProvider(this.deps.model.provider)) {
      throw new Error(
        `Repo bootstrapping needs a model the LLM proxy can serve ` +
          `(Workers AI, or a direct OpenAI-compatible provider); ` +
          `'${this.deps.model.provider}' is not supported.`,
      )
    }

    // A monorepo run has a completely different pre-flight and a completely different push, so
    // it branches before the new-repo checks below: there is no repository to create, nothing to
    // be empty, and force-pushing a fresh history would destroy the target.
    if (request.monorepo) {
      return await this.startMonorepoBootstrap(request, request.monorepo, installation)
    }

    // The target repo is created up front — by the user via GitHub's new-repo page,
    // or, for privileged-tier orgs (ADR 0005), programmatically via the create-repo
    // endpoint behind the modal's "Create repository" button. Resolve it under the
    // installation account to confirm it exists, is reachable by the App, and is
    // empty — the run pushes the bootstrapped contents as the initial commit.
    const owner = installation.accountLogin
    const repoName = request.target.name
    const ref = { owner, repo: repoName }
    log.info('bootstrap: pre-flighting target repo', { target: `${owner}/${repoName}` })

    let target
    try {
      target = await this.deps.githubClient.getRepo(installation.installationId, ref)
    } catch {
      throw new Error(
        `Repository ${owner}/${repoName} was not found or is not accessible to the GitHub App. ` +
          `Create a repository named "${repoName}" under ${owner} (an initial README, .gitignore ` +
          `or license is fine), make sure the App is installed on it, then run bootstrap again.`,
      )
    }

    // The repo being *readable* is not enough: bootstrapping ends in a force-push, so
    // the installation must have write access. A public repo the App can read but is
    // not granted (not in the App's selected-repos list, or the App lacks
    // contents:write) reads fine above but 403s on the container's push — pre-flight
    // it here so that case fails fast with an actionable message instead of failing
    // deep inside the run after a board frame has been created.
    if (!(await this.deps.githubClient.canPush(installation.installationId, ref))) {
      throw new Error(
        `The GitHub App can see ${owner}/${repoName} but does not have write access to it, so the ` +
          `bootstrapped commit cannot be pushed. Grant the App write access to this repository ` +
          `(GitHub → Settings → Applications → the cat-factory App → Configure → Repository access — ` +
          `add "${repoName}" or allow all repositories), or, in local mode, use a GitHub PAT that ` +
          `can push to it. Then run bootstrap again.`,
      )
    }
    // The run replaces the repo's contents with a fresh single-commit history, so
    // the target must be empty — except that GitHub's create-repo page often
    // prepopulates a README, .gitignore and/or license. Those are throwaway
    // boilerplate, so tolerate a repo that holds *only* them (the push force-
    // overwrites them); reject anything with real content to avoid clobbering work.
    const rootEntries = await this.deps.githubClient.listRootEntries(
      installation.installationId,
      ref,
    )
    const realContent = rootEntries.filter((entry) => !isBootstrapBoilerplate(entry))
    if (realContent.length > 0) {
      const sample = realContent
        .map((entry) => entry.path)
        .slice(0, 5)
        .join(', ')
      throw new Error(
        `Repository ${owner}/${repoName} already has content (${sample}). Bootstrapping replaces ` +
          `the repository's contents, so it needs an empty repository — or one prepopulated only ` +
          `with a README, .gitignore, license and/or AGENTS.md.`,
      )
    }

    // The template the run CLONES, resolved rather than assumed: its numeric id is what puts it
    // inside the token's scope and its own default branch is what the clone checks out. Assuming
    // `main` and scoping the token to the target alone made a private template uncloneable and a
    // template on any other default branch a clone failure, both reported as a generic git error.
    const referenceRepo = request.referenceRepo
      ? await this.resolveDispatchReference(installation.installationId, request.referenceRepo)
      : null

    // Scoped to the repos this run touches: the target it force-pushes, plus the template it
    // clones to adapt. `target` came from the pre-flight `getRepo` above, which is why that half
    // costs no extra read.
    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: request.containerJobId,
      workspaceId: request.workspaceId,
      repoIds: [
        String(target.githubId),
        ...(referenceRepo ? [String(referenceRepo.githubId)] : []),
      ],
    })
    // Private-registry auth for the scaffolder's installs, exactly as the
    // implementation executor forwards it.
    const packageRegistries =
      (await this.deps.resolvePackageRegistries?.(request.workspaceId)) ?? []
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: request.containerJobId,
      agentKind: 'architect',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })

    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    const targetCloneUrl = `${webBase}/${owner}/${repoName}.git`
    const defaultBranch = target.defaultBranch ?? 'main'

    // With a reference architecture the container clones + adapts it; without one
    // it scaffolds an empty repo from the freeform instructions alone.
    const reference =
      request.referenceRepo && referenceRepo
        ? {
            owner: request.referenceRepo.owner,
            name: request.referenceRepo.name,
            cloneUrl: `${webBase}/${request.referenceRepo.owner}/${request.referenceRepo.name}.git`,
            baseBranch: defaultBranchOf(referenceRepo),
          }
        : undefined

    const targetSpec = { owner, name: repoName, cloneUrl: targetCloneUrl, defaultBranch }
    // The generic agent `repo` is the clone source: the reference when adapting one, or the
    // (uncloned) target placeholder when scaffolding from scratch. The real push destination
    // is always `bootstrap.target`, which the harness force-pushes a fresh history to.
    const repoSpec = reference
      ? {
          owner: reference.owner,
          name: reference.name,
          baseBranch: reference.baseBranch,
          cloneUrl: reference.cloneUrl,
        }
      : { owner, name: repoName, baseBranch: defaultBranch, cloneUrl: targetCloneUrl }

    // Bootstrap dispatches the generic, manifest-driven `agent` kind in `coding` mode with a
    // `bootstrap` spec (the divergent force-push to a separate target repo) — the SAME path
    // every other built-in coding agent takes, with NO bespoke `/bootstrap` harness handler.
    const body = {
      jobId: request.containerJobId,
      // The run's correlation ids, so the container's own lines join to this bootstrap in the
      // backend's logs — the same fields `buildCommonBody` puts on an execution job. A bootstrap
      // is a first-class agent run (one `agent_runs` table, one retry surface), so it must not be
      // the one agent-kind dispatch whose container logs cannot be joined to anything. Its run id
      // IS its job id: a bootstrap has no separate execution row, which is exactly what
      // `sessionService.mint` above is told.
      workspaceId: request.workspaceId,
      executionId: request.containerJobId,
      mode: 'coding',
      systemPrompt: reference ? ADAPT_SYSTEM_PROMPT : SCAFFOLD_SYSTEM_PROMPT,
      userPrompt:
        request.instructions ||
        (reference
          ? 'Adapt the reference architecture for the new service.'
          : 'Scaffold a new repository for the service.'),
      model: this.deps.model.model,
      // Bootstrap runs on the Pi harness only (proxy + session token); it does not
      // select a subscription harness. The job schema tolerates `harness` (shared
      // HarnessAuthFields), but bootstrap is the one container flow that always uses
      // the deployment's proxyable model rather than a workspace's pooled subscription
      // token — there is no per-block model selection on a not-yet-existing repo.
      proxyBaseUrl: this.deps.proxyBaseUrl,
      // This backend serves the phase-tagged completions route (see `ContainerAgentExecutor`),
      // so a bootstrap's calls are attributed rather than landing in the unattributed slice.
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      ...(packageRegistries.length ? { packageRegistries } : {}),
      repo: repoSpec,
      branch: repoSpec.baseBranch,
      // Bootstrap always resets history to a single commit and force-pushes (the fresh
      // history shares no ancestor with the target repo's boilerplate); that is implicit
      // in the bootstrap flow, so no per-job flags are needed.
      bootstrap: {
        target: targetSpec,
        ...(reference ? {} : { fromScratch: true }),
      },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // Dispatch through the shared transport (keyed by job id), exactly like the
    // implementation executor: it hits the harness `POST /jobs` (kind `agent`), starts the
    // background job and returns once accepted; we then poll via the same transport.
    // Idempotent per job id — a replayed dispatch re-attaches rather than duplicating.
    log.info('bootstrap: dispatching container', {
      reference: reference ? `${reference.owner}/${reference.name}` : null,
    })
    // A new-repo bootstrap is a single-job flow: its run IS its one job, so `containerJobId`
    // equals the run id (no per-step fan-out into a shared container, and no second phase).
    await this.jobs.dispatch(
      request.workspaceId,
      { runId: request.jobId, jobId: request.containerJobId },
      body,
      'agent',
    )
    log.info('bootstrap: container accepted job')
    return {
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      containerJobId: request.containerJobId,
    }
  }

  /**
   * Dispatch a monorepo bootstrap's APPLY phase: an ordinary coding job on the monorepo, with
   * the reference template alongside it as a READ-ONLY sibling checkout.
   *
   * Deliberately the plain coding shape rather than a `bootstrap` spec, and that is the design:
   * the harness already knows how to clone a writable primary at a work branch, clone
   * `referenceRepos` beside it without ever branching or pushing them, and open one pull request
   * for the primary. A bespoke bootstrap mode here would be a second implementation of that with
   * one extra way to get the push wrong, against a repository that holds other people's code.
   *
   * `repo.serviceDirectory` is what scopes the agent to the new subdirectory: the same field
   * every monorepo-service run rides, so the working-directory rule is stated in one place.
   *
   * Two pre-flights, both about the monorepo rather than about a new repo: the App must be able
   * to WRITE to it (a read-only grant reads fine and 403s on the push, after a board frame
   * exists), and the target directory must still be absent at dispatch time, because the orchestration
   * pre-flighted it before the survey, and a review can be settled days later.
   */
  private async startMonorepoBootstrap(
    request: BootstrapRepoRequest,
    monorepo: MonorepoBootstrapLeg,
    installation: { installationId: number; accountLogin: string },
  ): Promise<BootstrapJobHandle> {
    const log = logger.child({ jobId: request.jobId, workspaceId: request.workspaceId })
    const ref = { owner: monorepo.owner, repo: monorepo.name }
    log.info('bootstrap(monorepo): pre-flighting target', {
      target: `${monorepo.owner}/${monorepo.name}`,
      directory: monorepo.directory,
    })

    const target = await this.deps.githubClient.getRepo(installation.installationId, ref)
    const defaultBranch = defaultBranchOf(target)
    if (!(await this.deps.githubClient.canPush(installation.installationId, ref))) {
      throw new Error(
        `The GitHub App can see ${monorepo.owner}/${monorepo.name} but does not have write access ` +
          `to it, so the new service cannot be pushed. Grant the App write access to this ` +
          `repository, then retry.`,
      )
    }
    const existing = await this.deps.githubClient.listDirectory(
      installation.installationId,
      ref,
      monorepo.directory,
      defaultBranchOf(target),
    )
    if (existing.length > 0) {
      throw new Error(
        `\`${monorepo.directory}\` already exists in ${monorepo.owner}/${monorepo.name}. It was ` +
          `empty when this bootstrap started; something has since created it. Pick a different ` +
          `directory and start a new bootstrap rather than writing over it.`,
      )
    }

    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    // Scoped to the repos this run touches: the monorepo it pushes to, and the template it
    // reads. A template outside the installation simply is not cloneable, which the harness
    // reports as a clone failure rather than silently running without it.
    const repoIds = [String(target.githubId)]
    const reference = request.referenceRepo
    let referenceRepos: { repo: Record<string, string> }[] = []
    if (reference) {
      // Re-flighted here for the same reason the target directory is: an apply dispatch can be
      // days after the review, and a template that has since moved out of reach is a clone this
      // run is about to fail. It used to be swallowed, which scoped the token to the monorepo
      // alone and left the harness reporting a bare git error about a sibling checkout.
      const templateRepo = await this.resolveDispatchReference(
        installation.installationId,
        reference,
      )
      repoIds.push(String(templateRepo.githubId))
      referenceRepos = [
        {
          repo: {
            owner: reference.owner,
            name: reference.name,
            baseBranch: defaultBranchOf(templateRepo),
            cloneUrl: `${webBase}/${reference.owner}/${reference.name}.git`,
          },
        },
      ]
    }

    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: request.containerJobId,
      workspaceId: request.workspaceId,
      repoIds,
    })
    const packageRegistries =
      (await this.deps.resolvePackageRegistries?.(request.workspaceId)) ?? []
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: request.containerJobId,
      agentKind: 'architect',
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })

    const body = {
      jobId: request.containerJobId,
      workspaceId: request.workspaceId,
      executionId: request.containerJobId,
      mode: 'coding',
      systemPrompt: MONOREPO_SYSTEM_PROMPT,
      userPrompt: request.instructions,
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      ...(packageRegistries.length ? { packageRegistries } : {}),
      repo: {
        owner: monorepo.owner,
        name: monorepo.name,
        baseBranch: defaultBranch,
        cloneUrl: `${webBase}/${monorepo.owner}/${monorepo.name}.git`,
        serviceDirectory: monorepo.directory,
      },
      branch: defaultBranch,
      newBranch: monorepo.branch,
      pr: monorepo.pr,
      ...(referenceRepos.length ? { referenceRepos } : {}),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    log.info('bootstrap(monorepo): dispatching container', {
      branch: monorepo.branch,
      reference: reference ? `${reference.owner}/${reference.name}` : null,
    })
    await this.jobs.dispatch(
      request.workspaceId,
      { runId: request.jobId, jobId: request.containerJobId },
      body,
      'agent',
    )
    log.info('bootstrap(monorepo): container accepted job')
    return {
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      containerJobId: request.containerJobId,
    }
  }

  /**
   * The reference template as the DISPATCH needs it: the row whose numeric id scopes the job's
   * installation token and whose default branch the clone checks out.
   *
   * Throws, and that is the point. `startBootstrap`'s contract is that a pre-flight failure fails
   * the run fast with an actionable message, and a template that cannot be resolved is one: the
   * container is about to clone it. The previous shape swallowed the failure, minted a token that
   * did not cover the template, and left the harness to report a bare `git clone` error naming
   * neither the repository nor the reference architecture that chose it.
   */
  private async resolveDispatchReference(
    installationId: number,
    ref: { owner: string; name: string },
  ): Promise<GitHubRepo> {
    try {
      return await this.deps.githubClient.getRepo(installationId, {
        owner: ref.owner,
        repo: ref.name,
      })
    } catch (error) {
      throw new Error(
        `The reference template ${ref.owner}/${ref.name} cannot be read through this workspace's ` +
          `source-control connection, so it cannot be cloned. Point the reference architecture at ` +
          `a repository this workspace can reach, or grant the App access to it, then retry. ` +
          `Cause: ${getErrorMessage(error)}`,
      )
    }
  }

  /** Poll a dispatched bootstrap job, mapping the runner job view into an update. */
  async pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, {
      runId: handle.jobId,
      jobId: handle.containerJobId,
    })

    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      // The transport maps an evicted/crashed container (a 404 poll) to a failed
      // view; the harness redacts + labels watchdog kills. Classify both kinds so the
      // board surfaces a clear, actionable reason.
      const error = view.error ?? 'Bootstrap job failed'
      return {
        state: 'failed',
        // Prefer the transport's STRUCTURED eviction verdict, then the harness's structured cause;
        // default to the coarse `agent` when neither is present (the watchdog-phrase string
        // fallback is gone — current images always emit a cause). Both eviction kinds
        // (`crash` / `transient`) collapse to the single `evicted` failure kind here on purpose —
        // bootstrap has no transient-vs-crash recovery budget (only the run driver's
        // `recoverContainerEviction` splits them), so the distinction carries no meaning downstream.
        failureKind: view.evicted
          ? 'evicted'
          : (failureKindFromHarnessCause(view.failureCause) ?? 'agent'),
        error,
        detail: view.detail ?? view.error,
      }
    }
    // Completed: a structured `error` (e.g. push rejected) is still a failure.
    const result = view.result ?? {}
    if (result.error) {
      return {
        state: 'failed',
        failureKind: failureKindFromHarnessCause(view.failureCause) ?? 'agent',
        error: `Bootstrap failed: ${result.error}`,
        detail: view.detail ?? result.error,
      }
    }
    // A MONOREPO run's product is the pull request, and NOTHING else it could report stands in
    // for it: there is no repository it created, so building a `repoUrl` here would name one
    // that does not exist. A `prUrl` is the shape's own tell (the new-repo flow force-pushes a
    // default branch and never opens one), so it is reported alone, and a completed apply that
    // opened none reports neither, leaving the ORCHESTRATION to say what that means (it fails
    // the run: the service was delivered nowhere).
    if (result.prUrl) return { state: 'done', prUrl: result.prUrl }
    const outcome = await this.buildOutcome(handle, result.defaultBranch)
    return { state: 'done', outcome }
  }

  /**
   * Best-effort: reclaim the per-run container for a job. Releases through the same
   * transport the run dispatched to (keyed by job id) — for the Cloudflare backend
   * this SIGKILLs the per-run container and clears its live-inventory row. Safe to
   * call when the container is already gone — a release on a non-running instance is
   * a no-op, and any error is swallowed by the caller.
   */
  async stopBootstrap(handle: BootstrapJobHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, {
      runId: handle.jobId,
      jobId: handle.containerJobId,
    })
    logger
      .child({ jobId: handle.jobId, workspaceId: handle.workspaceId })
      .info('bootstrap: stopped container')
  }

  /**
   * After a successful run: record the bootstrapped repo in the local projection (a
   * brand-new repo may not be there yet) and return its identity, so the caller binds
   * the board frame's account-owned {@link Service} to it (tasks dropped on that service
   * then resolve to, and are implemented against, it).
   */
  async projectBootstrappedRepo(
    workspaceId: string,
    outcome: BootstrapRepoOutcome,
  ): Promise<{ installationId: number; githubId: number }> {
    const log = logger.child({ workspaceId })
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(`Workspace '${workspaceId}' is not connected to GitHub`)
    }
    const repo = await this.deps.githubClient.getRepo(installation.installationId, {
      owner: outcome.owner,
      repo: outcome.name,
    })
    // The bootstrapped repo is reached through this connection, so it inherits its provider.
    await this.deps.repoRepository.upsertMany(workspaceId, [
      { ...repo, provider: installation.provider },
    ])
    await this.deps.repoProjectionCache?.invalidateGroup(workspaceId)
    log.info('bootstrap: projected repo for service frame', {
      repo: `${outcome.owner}/${outcome.name}`,
      githubId: repo.githubId,
    })
    return { installationId: installation.installationId, githubId: repo.githubId }
  }

  /** Construct the success outcome from the installation + the recorded job's repo name. */
  private async buildOutcome(
    handle: BootstrapJobHandle,
    resultDefaultBranch: string | undefined,
  ): Promise<BootstrapRepoOutcome> {
    const installation = await this.deps.installationRepository.getByWorkspace(handle.workspaceId)
    if (!installation)
      throw new Error(`Workspace '${handle.workspaceId}' is not connected to GitHub`)
    const record = await this.deps.bootstrapJobRepository.get(handle.workspaceId, handle.jobId)
    if (!record) throw new Error(`Bootstrap job '${handle.jobId}' not found`)
    const owner = installation.accountLogin
    const webBase = (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
    return {
      repoUrl: `${webBase}/${owner}/${record.repoName}`,
      owner,
      name: record.repoName,
      defaultBranch: resultDefaultBranch ?? 'main',
    }
  }
}

/** A repo's default branch, or the conventional fallback when the provider reported none. */
function defaultBranchOf(repo: { defaultBranch?: string | null }): string {
  return repo.defaultBranch ?? 'main'
}

/**
 * Whether a repo's root entry is throwaway boilerplate GitHub commonly prepopulates
 * at create time — a README, a `.gitignore`, or a license file — or an `AGENTS.md`
 * that a prior (incomplete) bootstrap attempt left behind. The push force-overwrites
 * all of these, so tolerating them lets bootstrap re-run over a repo seeded only with
 * agent context. Only top-level files qualify (a directory means real project
 * content), and the match is case-insensitive across the usual extensions
 * (`README.md`, `LICENSE.txt`, …).
 */
function isBootstrapBoilerplate(entry: RepoEntry): boolean {
  if (entry.type !== 'file') return false
  const name = entry.path.toLowerCase()
  return (
    name === '.gitignore' ||
    name === 'readme' ||
    name.startsWith('readme.') ||
    name === 'license' ||
    name.startsWith('license.') ||
    name === 'licence' ||
    name.startsWith('licence.') ||
    name === 'agents.md'
  )
}
