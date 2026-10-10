import type {
  AgentContextRecorder,
  AgentJobHandle,
  BootstrapDeliveryPlan,
  BootstrapJobHandle,
  BootstrapJobRepository,
  BootstrapJobUpdate,
  BootstrapRepoOutcome,
  BootstrapRepoRequest,
  GitHubClient,
  MonorepoBootstrapLeg,
  MonorepoTargetRepo,
  ReferenceRepoAccess,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubRepo,
  GroupCacheHandle,
  ModelRef,
  RepoBootstrapper,
  RepoEntry,
  RepoProjectionRepository,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  failureKindFromHarnessCause,
  getErrorMessage,
  runBestEffort,
  VcsApiError,
} from '@cat-factory/kernel'
import { isProxyableProvider } from '@cat-factory/agents'
import { bootstrapStepIds, REPO_BOOTSTRAP_AGENT_KIND } from '@cat-factory/contracts'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import { recordBootstrapContextSnapshot } from './agentContextRecord.js'
import { drainToolCalls, type ToolTrajectoryDeps } from './toolTrajectory.js'
import type { JobPackageRegistrySpec } from './ContainerAgentExecutor.js'
import { makeRepoFiles } from './repoFiles.js'
import { jobTokenRepoIds, type MintInstallationToken, type RepoTarget } from './repoTargeting.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

export interface ContainerRepoBootstrapperDependencies extends ToolTrajectoryDeps {
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
   * The provider {@link githubClient} speaks (`engineVcsProvider`), so a workspace whose
   * connection is on ANOTHER one is refused rather than probed with the wrong client.
   *
   * Required rather than defaulted, for the reason `makeResolveRepoFilesForCoords` states it:
   * a deployment serving a GitHub App beside per-workspace GitLab connections binds the App
   * client here, and a GitLab workspace's installation id means nothing to it. Reading the
   * template through it anyway answers 404, which this component would then report as "your
   * reference architecture names the wrong repository" for an entry that is perfectly correct.
   * A facade that forgets to state it must fail to typecheck rather than inherit a guess.
   */
  clientProvider: VcsProvider
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
   * Records the complete context each bootstrap dispatch handed its agent (best-effort, gated
   * inside the recorder). Absent ⇒ a bootstrap's "Provided context" tab is empty, which is the
   * shape every other agent run's would have if its executor skipped this call.
   */
  agentContextObservability?: AgentContextRecorder
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
 * The role prompt when writing a new service INTO an existing monorepo, told where its work
 * lands.
 *
 * Distinct from the ones below in the thing it keeps saying: the checkout is not the new
 * service's to reshape. The agent has the monorepo (writable) and the reference template beside
 * it as a read-only sibling, and its whole job is confined to one new subdirectory plus the
 * minimum registration the monorepo's own tooling needs. Every cross-cutting choice it might
 * otherwise make has already been made by a human and is stated in the brief, so the prompt's
 * job is to stop it re-deciding them.
 *
 * Two of its sentences are delivery-specific, and both are the kind that changes what the agent
 * does. WHICH BRANCH it is on is the licence to commit loosely or not: under `direct_push` the
 * harness checkpoints every commit straight to the branch every other service is built from, and
 * an agent told it is on a "fresh work branch" is being told the opposite of that. And WHERE a
 * deviation goes has to be somewhere that exists: routing it to a pull request description on a
 * run that opens no pull request is how a caveat about a settled decision is silently lost.
 */
function monorepoSystemPrompt(delivery: BootstrapDeliveryPlan['mode']): string {
  const checkout =
    delivery === 'pull_request'
      ? 'Your working directory is the monorepo checkout, already on a fresh work branch. '
      : "Your working directory is the monorepo checkout, on the monorepo's OWN DEFAULT BRANCH: " +
        'every commit you make is pushed to the branch every other service in it is built from, ' +
        'as you make it. So commit only work you would be willing to merge, keep the tree ' +
        'building at every commit, and never rewrite, revert or force-push history that was ' +
        'there before you. '
  const deviation =
    delivery === 'pull_request'
      ? 'say so in the pull request description'
      : 'say so in the commit message that makes the change'
  return (
    'You are adding a NEW service to an existing monorepo. ' +
    checkout +
    'A reference template repository is ' +
    'checked out READ-ONLY as a sibling directory beside it: read from it freely, copy from it ' +
    'where the brief says to, and never write to it. ' +
    'Create the new service in the subdirectory the brief names, and touch NOTHING else in the ' +
    'monorepo except the minimum registration its own tooling requires (a workspace list, a ' +
    'build-graph entry, a CI matrix entry). Modifying an existing service is out of scope, and ' +
    'so is reformatting, upgrading or "tidying" anything you did not add. ' +
    'The brief carries adoption decisions a human has already reviewed and settled: for each ' +
    'area they say whether the new service follows the monorepo or the template. Follow them ' +
    'exactly. Do not substitute your own preference for one of them, and if a decision cannot ' +
    `be honoured as written, do the closest thing that respects it and ${deviation} rather than ` +
    'quietly taking the other side. ' +
    'Match the surrounding monorepo in everything the brief does NOT settle: its naming, its ' +
    'file layout, its dependency versions, its lint and test conventions. Leave the new service ' +
    'building and its tests passing.'
  )
}

/**
 * The role prompt when filling a NEW repository from a reference template, delivered as a pull
 * request.
 *
 * Distinct from {@link ADAPT_SYSTEM_PROMPT} in what the checkout IS: there the agent works in a
 * clone OF the template and reshapes it, here it works in the new repository (which holds only
 * its initial README) with the template read-only beside it. Saying "adapt this in place" to an
 * agent whose cwd is the empty repository is how a run ends with the template untouched and the
 * repository still empty.
 */
const PR_ADAPT_SYSTEM_PROMPT =
  'You are a repository bootstrapper. Your working directory is a BRAND-NEW repository, ' +
  'holding nothing but the initial README/.gitignore/license it was created with, already on a ' +
  'fresh work branch. A reference architecture (a base/golden-template repository) is checked ' +
  'out READ-ONLY as a sibling directory beside it: read from it freely, copy what the new ' +
  'service needs into your working directory, and never write to it. ' +
  'Adapt what you copy into the new service per the instructions: rename packages/modules, ' +
  'leave out pieces that do not apply, write the README and metadata for THIS service, and ' +
  'leave the project building. Make focused, idiomatic changes that match the structure the ' +
  'template establishes. Do not invent unrelated features. ' +
  'Your work is delivered as a pull request a person reviews, so it must stand on its own: no ' +
  'placeholder files you meant to fill in later, and no references to paths that only exist in ' +
  'the template.'

/**
 * The role prompt when scaffolding a new repository from scratch, delivered as a pull request.
 *
 * Same job as {@link SCAFFOLD_SYSTEM_PROMPT}, said to an agent that is NOT in an empty
 * directory: the repository already carries its initial commit, which is what the pull request
 * is opened against.
 */
const PR_SCAFFOLD_SYSTEM_PROMPT =
  'You are a repository bootstrapper. Your working directory is a BRAND-NEW repository, ' +
  'holding nothing but the initial README/.gitignore/license it was created with, already on a ' +
  'fresh work branch. Scaffold the service described in the instructions into it: create a ' +
  'sensible, idiomatic project layout with source files, a README, and the metadata and ' +
  'build/config files appropriate for the stack, leaving the project building. Keep the scope ' +
  'to what the instructions describe; do not invent unrelated features. ' +
  'Your work is delivered as a pull request a person reviews, so it must stand on its own: no ' +
  'placeholder files you meant to fill in later.'

/** The role prompt when scaffolding a brand-new repository from scratch. */
const SCAFFOLD_SYSTEM_PROMPT =
  'You are a repository bootstrapper. You are working in an empty directory and ' +
  'must scaffold a brand-new repository from scratch per the instructions. Create ' +
  'a sensible, idiomatic project layout: source files, a README, and the metadata ' +
  'and build/config files appropriate for the stack, leaving the project building. ' +
  'Keep the scope to what the instructions describe; do not invent unrelated features.'

/**
 * What ONE provider read of the reference template answered, before any caller decides what to
 * do about it. The internal twin of the port's {@link ReferenceRepoAccess}: it carries the raw
 * `repo` (the pre-flight needs a branch, the dispatch needs the id) and the thrown value behind
 * an unreadable verdict, neither of which belongs on a shape that crosses a port.
 */
type TemplateRead =
  | { status: 'reachable'; repo: GitHubRepo }
  | { status: 'not_found' }
  | { status: 'unreadable'; detail: string; cause: unknown }

/** The reference template as a dispatch body names it, resolved at dispatch time. */
interface DispatchReference {
  owner: string
  name: string
  /** The provider's numeric id, stringified: the job token's scope for this leg. */
  repoId: string
  /** The template's OWN default branch, which is the ref the sibling checkout is made at. */
  baseBranch: string
  cloneUrl: string
}

/** One repo a dispatch's job token must reach, as {@link jobTokenRepoIds} wants it. */
type TokenScopeLeg = Omit<RepoTarget, 'installationId'>

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
   * the run's clone has.
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
   *
   * NEVER throws, which is a contract two callers depend on (the survey, whose whole phase is
   * "park with what we know", and the pre-flight, which owes a 503). So the installation read sits
   * INSIDE the try as well: on a mothership-mode node the repository read is an RPC to a process
   * that can be a restart away, and a throw from there would arrive as a platform bug about
   * somebody's own template.
   */
  async resolveReferenceRepo(
    workspaceId: string,
    ref: { owner: string; name: string },
  ): Promise<ReferenceRepoAccess> {
    let installation: GitHubInstallation | null
    try {
      installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    } catch (error) {
      // A connection we cannot READ is not a connection we know to be absent: `not_connected`
      // would tell the operator to install an App that may well already be installed.
      return { status: 'unreadable', detail: getErrorMessage(error) }
    }
    if (!installation || installation.deletedAt) return { status: 'not_connected' }
    // The row's own provider, falling back to this client's for a row predating the column. A
    // connection on another provider is not reachable from here whatever it holds, and reporting
    // that as `not_found` is the misattribution the verdict split exists to prevent.
    if ((installation.provider ?? this.deps.clientProvider) !== this.deps.clientProvider) {
      return { status: 'not_connected' }
    }
    const read = await this.readTemplate(installation.installationId, ref)
    if (read.status === 'not_found') return { status: 'not_found' }
    // Mapped field by field rather than passed through: the verdict crosses a port and becomes an
    // HTTP `details.detail`, and the thrown value the probe kept for its own `cause` chain has no
    // business on a wire shape.
    if (read.status === 'unreadable') return { status: 'unreadable', detail: read.detail }
    return {
      status: 'reachable',
      files: makeRepoFiles(this.deps.githubClient, installation.installationId, {
        owner: ref.owner,
        repo: ref.name,
      }),
      defaultBranch: defaultBranchOf(read.repo),
    }
  }

  /**
   * The one provider read behind every reference-template question: the pre-flight's verdict, the
   * survey's reader and the dispatch's clone spec are all this, mapped three ways.
   *
   * Shared because the two callers used to ask it differently: one 404-aware and returning a
   * verdict, the other collapsing every failure into one disposition. So the same rate limit was
   * reported as the entry being wrong at one moment and as an outage at another. One probe, one
   * set of causes, and each caller decides only what to DO about them.
   */
  private async readTemplate(
    installationId: number,
    ref: { owner: string; name: string },
  ): Promise<TemplateRead> {
    try {
      const repo = await this.deps.githubClient.getRepo(installationId, {
        owner: ref.owner,
        repo: ref.name,
      })
      return { status: 'reachable', repo }
    } catch (error) {
      if (error instanceof VcsApiError && error.status === 404) return { status: 'not_found' }
      return { status: 'unreadable', detail: getErrorMessage(error), cause: error }
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
   *
   * THREE dispatch shapes, chosen by the target and the run's delivery. A new repository
   * delivered by `direct_push` is the original one (adapt a clone, reinitialise, force-push);
   * everything else is the ordinary coding shape (clone the writable target, template beside it
   * read-only, work branch, pull request), because the target already holds a history nobody may
   * reset: the monorepo's, or the initial commit a pull request has to be opened against.
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

    // A monorepo run has a completely different pre-flight, so it branches before the new-repo
    // checks below: there is no repository to create and nothing to be empty.
    if (request.monorepo) {
      return await this.startMonorepoBootstrap(request, request.monorepo, installation)
    }

    const target = await this.preflightNewRepoTarget(request, installation, log)

    if (request.delivery.mode === 'pull_request') {
      return await this.startNewRepoPullRequest(request, target, installation, log)
    }

    const owner = installation.accountLogin
    const repoName = request.target.name
    // With a reference architecture the container clones + adapts it; without one
    // it scaffolds an empty repo from the freeform instructions alone.
    const reference = await this.resolveReferenceTemplate(request, installation.installationId, log)
    const webBase = this.webBase()
    const targetCloneUrl = `${webBase}/${owner}/${repoName}.git`
    const defaultBranch = defaultBranchOf(target)

    // Scoped to the repos this run touches: the target it force-pushes, and the template it
    // CLONES. The template belongs on the scope even though nothing pushes to it, because the
    // clone runs on this same token: leaving it off works only for a public reference
    // architecture and 404s on a private one, with nothing in the failure naming the cause.
    // `target` came from the pre-flight `getRepo` above, which is why it costs no extra read.
    const ghToken = await this.mintDispatchToken(
      request,
      installation.installationId,
      { owner, name: repoName, repoId: String(target.githubId), baseBranch: defaultBranch },
      reference,
    )
    // Private-registry auth for the scaffolder's installs, exactly as the
    // implementation executor forwards it.
    const packageRegistries =
      (await this.deps.resolvePackageRegistries?.(request.workspaceId)) ?? []
    const sessionToken = await this.mintSessionToken(request)

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
    // `bootstrap` spec (the divergent force-push to a separate target repo): the SAME path
    // every other built-in coding agent takes, with NO bespoke `/bootstrap` harness handler.
    const body = {
      jobId: request.containerJobId,
      // The run's correlation ids, so the container's own lines join to this bootstrap in the
      // backend's logs: the same fields `buildCommonBody` puts on an execution job. A bootstrap
      // is a first-class agent run (one `agent_runs` table, one retry surface, one observability
      // panel), so it must not be the one agent-kind dispatch whose container logs cannot be
      // joined to anything. The id is the RUN's, matching the session token above: a bootstrap
      // has no separate execution row, so its run id is what every run-scoped read is keyed by.
      workspaceId: request.workspaceId,
      executionId: request.jobId,
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
      // token: there is no per-block model selection on a not-yet-existing repo.
      proxyBaseUrl: this.deps.proxyBaseUrl,
      // This backend serves the phase-tagged completions route (see `ContainerAgentExecutor`),
      // so a bootstrap's calls are attributed rather than landing in the unattributed slice.
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      ...(packageRegistries.length ? { packageRegistries } : {}),
      repo: repoSpec,
      branch: repoSpec.baseBranch,
      // This delivery always resets history to a single commit and force-pushes (the fresh
      // history shares no ancestor with the target repo's boilerplate); that is what the
      // `bootstrap` spec MEANS to the harness, so no per-job flags are needed.
      bootstrap: {
        target: targetSpec,
        ...(reference ? {} : { fromScratch: true }),
      },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    // Dispatch through the shared transport (keyed by job id), exactly like the
    // implementation executor: it hits the harness `POST /jobs` (kind `agent`), starts the
    // background job and returns once accepted; we then poll via the same transport.
    // Idempotent per job id: a replayed dispatch re-attaches rather than duplicating.
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
    await this.recordDispatchContext(request, body, log)
    return {
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      containerJobId: request.containerJobId,
    }
  }

  /**
   * Pre-flight the pre-created target repository of a NEW-REPO run: it exists, the App can
   * write to it, and it holds no real content.
   *
   * The target repo is created up front: by the user via the host's new-repo page, or, for
   * privileged-tier orgs (ADR 0005), programmatically via the create-repo endpoint behind the
   * modal's "Create repository" button.
   *
   * The emptiness rule binds under both deliveries, because both WRITE a whole service into the
   * repository: a force-push would clobber real content and a pull request would propose
   * deleting it. What differs is the FLOOR: a pull request needs an initial commit to branch
   * from, so that delivery also refuses a repository with none.
   */
  private async preflightNewRepoTarget(
    request: BootstrapRepoRequest,
    installation: { installationId: number; accountLogin: string },
    log: ReturnType<typeof logger.child>,
  ): Promise<GitHubRepo> {
    const owner = installation.accountLogin
    const repoName = request.target.name
    const ref = { owner, repo: repoName }
    log.info('bootstrap: pre-flighting target repo', { target: `${owner}/${repoName}` })

    let target: GitHubRepo
    try {
      target = await this.deps.githubClient.getRepo(installation.installationId, ref)
    } catch {
      throw new Error(
        `Repository ${owner}/${repoName} was not found or is not accessible to the GitHub App. ` +
          `Create a repository named "${repoName}" under ${owner} (an initial README, .gitignore ` +
          `or license is fine), make sure the App is installed on it, then run bootstrap again.`,
      )
    }

    // The repo being *readable* is not enough: bootstrapping ends in a push, so the
    // installation must have write access. A public repo the App can read but is
    // not granted (not in the App's selected-repos list, or the App lacks
    // contents:write) reads fine above but 403s on the container's push, so pre-flight
    // it here: that case then fails fast with an actionable message instead of failing
    // deep inside the run after a board frame has been created.
    if (!(await this.deps.githubClient.canPush(installation.installationId, ref))) {
      throw new Error(
        `The GitHub App can see ${owner}/${repoName} but does not have write access to it, so the ` +
          `bootstrapped commit cannot be pushed. Grant the App write access to this repository ` +
          `(GitHub → Settings → Applications → the cat-factory App → Configure → Repository access: ` +
          `add "${repoName}" or allow all repositories), or, in local mode, use a GitHub PAT that ` +
          `can push to it. Then run bootstrap again.`,
      )
    }
    // The run writes a whole repository's worth of content, so the target must be
    // empty, except that GitHub's create-repo page often prepopulates a README,
    // .gitignore and/or license. Those are throwaway boilerplate, so tolerate a repo
    // that holds *only* them; reject anything with real content to avoid clobbering work.
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
          `the repository's contents, so it needs an empty repository, or one prepopulated only ` +
          `with a README, .gitignore, license and/or AGENTS.md.`,
      )
    }
    // A pull request is opened BETWEEN two commits, so a repository holding none cannot take
    // one: there is no default branch to clone, to branch from, or to target.
    // `listRootEntries` answers `[]` for exactly that repository (the contents endpoint 404s
    // where there is no commit), so an empty listing is the tell. Refused here, naming both
    // ways out, rather than surfacing later as a clone failure that reads like an outage.
    if (request.delivery.mode === 'pull_request' && rootEntries.length === 0) {
      throw new Error(
        `Repository ${owner}/${repoName} has no commits yet, so there is no branch to open a ` +
          `pull request against. Either create it with an initial commit (a README is enough), ` +
          `or bootstrap it with "push directly", which writes the repository's first commit.`,
      )
    }
    return target
  }

  /**
   * Dispatch a NEW-REPO run delivered as a pull request: the ordinary coding shape against the
   * (already-initialised) target repository, with the reference template beside it as a
   * READ-ONLY sibling checkout.
   *
   * Deliberately NOT the `bootstrap` spec, which is the whole reason this path exists
   * separately: that spec reinitialises history and force-pushes, and a branch whose history
   * shares no ancestor with the default branch is not something a pull request can be opened
   * from. Here the target's own initial commit is the base, so the diff a reviewer reads is the
   * service being added.
   */
  private async startNewRepoPullRequest(
    request: BootstrapRepoRequest,
    target: GitHubRepo,
    installation: { installationId: number; accountLogin: string },
    log: ReturnType<typeof logger.child>,
  ): Promise<BootstrapJobHandle> {
    const owner = installation.accountLogin
    const repoName = request.target.name
    log.info('bootstrap(new-repo pr): dispatching container', { target: `${owner}/${repoName}` })
    return await this.dispatchCodingShape(request, installation, log, {
      repo: {
        owner,
        name: repoName,
        baseBranch: defaultBranchOf(target),
        cloneUrl: `${this.webBase()}/${owner}/${repoName}.git`,
      },
      repoGithubId: target.githubId,
      systemPrompt: request.referenceRepo ? PR_ADAPT_SYSTEM_PROMPT : PR_SCAFFOLD_SYSTEM_PROMPT,
      userPrompt:
        request.instructions ||
        (request.referenceRepo
          ? 'Adapt the reference architecture for the new service.'
          : 'Scaffold a new repository for the service.'),
    })
  }

  /**
   * Dispatch a monorepo bootstrap's APPLY phase: an ordinary coding job on the monorepo, with
   * the reference template alongside it as a READ-ONLY sibling checkout.
   *
   * Deliberately the plain coding shape rather than a `bootstrap` spec, and that is the design:
   * the harness already knows how to clone a writable primary (at a work branch, or at the
   * default branch it commits onto, per the run's delivery), clone `referenceRepos` beside it
   * without ever branching or pushing them, and open one pull request for the primary when it
   * was given one to open. A bespoke bootstrap mode here would be a second implementation of
   * that with one extra way to get the push wrong, against a repository that holds other
   * people's code.
   *
   * `repo.serviceDirectory` is what scopes the agent to the new subdirectory: the same field
   * every monorepo-service run rides, so the working-directory rule is stated in one place.
   *
   * Two pre-flights, both about the monorepo rather than about a new repo: the App must be able
   * to WRITE to it (a read-only grant reads fine and 403s on the push, after a board frame
   * exists), and the target directory must still be absent at dispatch time, because the
   * orchestration pre-flighted it before the survey and a review can be settled days later.
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
      defaultBranch,
    )
    if (existing.length > 0) {
      throw new Error(
        `\`${monorepo.directory}\` already exists in ${monorepo.owner}/${monorepo.name}. It was ` +
          `empty when this bootstrap started; something has since created it. Pick a different ` +
          `directory and start a new bootstrap rather than writing over it.`,
      )
    }

    log.info('bootstrap(monorepo): dispatching container', {
      directory: monorepo.directory,
      delivery: request.delivery.mode,
    })
    return await this.dispatchCodingShape(request, installation, log, {
      repo: {
        owner: monorepo.owner,
        name: monorepo.name,
        baseBranch: defaultBranch,
        cloneUrl: `${this.webBase()}/${monorepo.owner}/${monorepo.name}.git`,
        serviceDirectory: monorepo.directory,
      },
      repoGithubId: target.githubId,
      systemPrompt: monorepoSystemPrompt(request.delivery.mode),
      userPrompt: request.instructions,
    })
  }

  /**
   * The dispatch both non-force-push shapes share: clone the writable target, fetch the
   * reference template beside it read-only, and either open a work branch plus a pull request
   * or commit onto the target's own default branch.
   *
   * ONE builder rather than one per target, because the delivery rule is the interesting part
   * and a second copy of it is a second place for `newBranch` and `pr` to disagree: a body
   * carrying a branch but no PR pushes work onto a branch nobody is told about.
   */
  private async dispatchCodingShape(
    request: BootstrapRepoRequest,
    installation: { installationId: number; accountLogin: string },
    log: ReturnType<typeof logger.child>,
    spec: {
      repo: {
        owner: string
        name: string
        baseBranch: string
        cloneUrl: string
        serviceDirectory?: string
      }
      /** Numeric id of the writable target, for the token's repo scope. */
      repoGithubId: number
      systemPrompt: string
      userPrompt: string
    },
  ): Promise<BootstrapJobHandle> {
    // Re-flighted here for the same reason the monorepo's target directory is: an apply dispatch
    // can be days after the review, and a template that has since moved out of reach is a clone
    // this run is about to fail.
    const reference = await this.resolveReferenceTemplate(request, installation.installationId, log)
    const referenceRepos = reference
      ? [
          {
            repo: {
              owner: reference.owner,
              name: reference.name,
              baseBranch: reference.baseBranch,
              cloneUrl: reference.cloneUrl,
            },
          },
        ]
      : []

    // Scoped to the repos this run touches: the one it pushes to, and the template it reads.
    const ghToken = await this.mintDispatchToken(
      request,
      installation.installationId,
      {
        owner: spec.repo.owner,
        name: spec.repo.name,
        repoId: String(spec.repoGithubId),
        baseBranch: spec.repo.baseBranch,
      },
      reference,
    )
    const packageRegistries =
      (await this.deps.resolvePackageRegistries?.(request.workspaceId)) ?? []
    const sessionToken = await this.mintSessionToken(request)

    // The delivery decides the two fields TOGETHER: with `newBranch` and `pr` the harness pushes
    // a work branch and opens one pull request; with neither it commits onto `branch`, the
    // target's own default. Omitting only one of the pair is the bug this single site prevents.
    const delivery =
      request.delivery.mode === 'pull_request'
        ? { newBranch: request.delivery.branch, pr: request.delivery.pr }
        : {}

    const body = {
      jobId: request.containerJobId,
      workspaceId: request.workspaceId,
      // The RUN, not this phase's drive id: see the session mint above.
      executionId: request.jobId,
      mode: 'coding',
      systemPrompt: spec.systemPrompt,
      userPrompt: spec.userPrompt,
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      ...(packageRegistries.length ? { packageRegistries } : {}),
      repo: spec.repo,
      branch: spec.repo.baseBranch,
      ...delivery,
      ...(referenceRepos.length ? { referenceRepos } : {}),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    await this.jobs.dispatch(
      request.workspaceId,
      { runId: request.jobId, jobId: request.containerJobId },
      body,
      'agent',
    )
    // The BRANCH is the field an operator needs first when a run reports done with no pull
    // request (the orchestration then fails it as delivered nowhere) or faults mid-way under
    // `direct_push`: it names where the commits are. Nothing else in the backend's logs does.
    log.info('bootstrap: container accepted job', {
      delivery: request.delivery.mode,
      branch:
        request.delivery.mode === 'pull_request' ? request.delivery.branch : spec.repo.baseBranch,
      reference: reference ? `${reference.owner}/${reference.name}` : null,
    })
    await this.recordDispatchContext(request, body, log)
    return {
      workspaceId: request.workspaceId,
      jobId: request.jobId,
      containerJobId: request.containerJobId,
    }
  }

  /**
   * Resolve the reference template a run reads from: its clone spec, plus the numeric id the
   * run's installation token has to be scoped to.
   *
   * ONE resolution for every dispatch shape, because they all CLONE the template and all mint the
   * token that clone runs on. Two copies is what left the force-push path granting only its push
   * target while cloning the template with that same token, so a PRIVATE reference architecture
   * 404s on clone under one delivery and works under the other, and what left it assuming the
   * template's base branch was `main`.
   *
   * It THROWS on a template it cannot resolve, rather than dispatching with no id and the
   * conventional branch: the container is about to clone it, so the run is over either way, and
   * the difference is whether the report names the reference architecture and what to do about it
   * or arrives as a git error from inside a container that had to be started first.
   *
   * The MESSAGE follows the cause the shared probe reported. "Point the reference architecture at
   * a repository this workspace can reach" is the wrong instruction for a rate limit or a 500,
   * and a monorepo apply dispatches days after a human settled its review, so the failure read
   * here is as likely to be an outage as a typo. The provider error rides as `cause`, so a log
   * describer walking the chain can still see which it was.
   *
   * Re-read rather than carried over from the run-start pre-flight, deliberately: this is the
   * moment the clone happens, and on a monorepo run the pre-flight sits on the other side of a
   * human review. An id plumbed through the request would be a claim about the repository as it
   * was, dispatched against the repository as it is.
   */
  private async resolveReferenceTemplate(
    request: BootstrapRepoRequest,
    installationId: number,
    log: ReturnType<typeof logger.child>,
  ): Promise<DispatchReference | undefined> {
    const reference = request.referenceRepo
    if (!reference) return undefined
    const repo = `${reference.owner}/${reference.name}`
    const read = await this.readTemplate(installationId, reference)
    if (read.status === 'reachable') {
      return {
        owner: reference.owner,
        name: reference.name,
        repoId: String(read.repo.githubId),
        baseBranch: defaultBranchOf(read.repo),
        cloneUrl: `${this.webBase()}/${reference.owner}/${reference.name}.git`,
      }
    }
    log.warn('bootstrap: reference template could not be resolved', {
      reference: repo,
      verdict: read.status,
    })
    if (read.status === 'not_found') {
      throw new Error(
        `The reference template ${repo} cannot be seen through this workspace's source-control ` +
          `connection, so it cannot be cloned. Point the reference architecture at a repository ` +
          `this workspace can reach, or grant the App access to it, then retry.`,
      )
    }
    throw new Error(
      `The reference template ${repo} could not be read just now, so this run was not dispatched ` +
        `rather than dispatched against a template it may be unable to clone. Nothing here is ` +
        `misconfigured: retry once the source-control connection recovers. Cause: ${read.detail}`,
      { cause: read.cause },
    )
  }

  /**
   * Mint the job's clone/push token, scoped to the repos this dispatch resolved.
   *
   * The scope goes through the SHARED `jobTokenRepoIds` rather than a hand-built array, for the
   * case the hand-built one got wrong: a reference architecture naming the run's own target (or
   * its monorepo) is one repository asked for twice, and a `repository_ids` list is a set.
   *
   * A refusal is re-thrown NAMING the template, because a scoped mint has one failure mode this
   * component cannot pre-flight away. GitHub narrows a token only to repositories the
   * installation was GRANTED, while a PUBLIC repository reads perfectly well through the API
   * without being one, so a template outside the App's repository access resolves cleanly above
   * and is refused here. There is no read on this port that separates the two cheaply and
   * correctly on every provider (`getRepoById` answers from a bounded listing on the GitLab
   * adapter, so a null there is not evidence of anything), and dropping the leg would only move
   * the failure to the clone. What is left is to make the refusal say which repository to grant.
   */
  private async mintDispatchToken(
    request: BootstrapRepoRequest,
    installationId: number,
    primary: TokenScopeLeg,
    template: DispatchReference | undefined,
  ): Promise<string> {
    const asTarget = (leg: TokenScopeLeg): RepoTarget => ({ installationId, ...leg })
    try {
      return await this.deps.mintInstallationToken(installationId, {
        // The RUN, not this phase's drive id: see the session mint below.
        executionId: request.jobId,
        workspaceId: request.workspaceId,
        repoIds: jobTokenRepoIds(asTarget(primary), template ? [asTarget(template)] : []),
      })
    } catch (error) {
      if (!template) throw error
      throw new Error(
        `The source-control token for this run could not be issued for both ` +
          `${primary.owner}/${primary.name} and the reference template ` +
          `${template.owner}/${template.name}. A GitHub App token can only cover repositories ` +
          `the installation has been GRANTED, and a public repository reads through the API ` +
          `without being one. Grant the App access to ${template.owner}/${template.name}, or ` +
          `point the reference architecture at a repository it already covers, then retry. ` +
          `Cause: ${getErrorMessage(error)}`,
        { cause: error },
      )
    }
  }

  /**
   * The model-locked LLM-proxy session token a bootstrap container runs under.
   *
   * Keyed on the RUN, never on the drive: a monorepo run's apply phase is dispatched under its
   * own container job id, so minting on that id files the apply's model calls under a key no
   * run-scoped read asks for, and the run reports only what its survey spent.
   */
  private mintSessionToken(request: BootstrapRepoRequest): Promise<string> {
    return this.deps.sessionService.mint({
      workspaceId: request.workspaceId,
      executionId: request.jobId,
      agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })
  }

  /** The host's web base, trailing slashes stripped, for building clone URLs. */
  private webBase(): string {
    return (this.deps.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
  }

  /** Poll a dispatched bootstrap job, mapping the runner job view into an update. */
  async pollBootstrap(handle: BootstrapJobHandle): Promise<BootstrapJobUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, {
      runId: handle.jobId,
      jobId: handle.containerJobId,
    })
    // The tool calls the harness drained on this poll, to the same two destinations an
    // execution step's go to. Filed under the RUN (`runId`) and grouped by the container job,
    // so a monorepo run's apply trajectory reads under the run a person opened. Isolated +
    // best-effort inside `drainToolCalls`: it can never affect this poll's verdict.
    // Correlated by the same two ids every other line about this run carries, so a drain that
    // warns (an image too old to number its calls) names the run it was about.
    await drainToolCalls(
      this.deps,
      this.jobHandle(handle),
      view.spans,
      logger.child({ jobId: handle.jobId, workspaceId: handle.workspaceId }),
    )

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
    // What a completed run can NAME is decided by its target, never by whether a `prUrl` came
    // back. A monorepo run created no repository, so building a `repoUrl` here would name one
    // that does not exist; a new-repo run created one under either delivery, and under
    // `pull_request` it has BOTH a repository and a pull request to report. Reading the record
    // is what tells them apart: `prUrl`'s presence cannot, now that a new-repo run may carry
    // one. A run that promised a pull request and reports none is left to the ORCHESTRATION to
    // fail, which is where "delivered nowhere" is a statement about the run rather than about
    // this poll.
    const record = await this.requireRecord(handle)
    const pr = result.prUrl ? { prUrl: result.prUrl } : {}
    if (record.monorepo) return { state: 'done', ...pr }
    const outcome = await this.buildOutcome(handle, record.repoName, result.defaultBranch)
    return { state: 'done', outcome, ...pr }
  }

  /**
   * The dispatched container job as an {@link AgentJobHandle}, the shape the shared trajectory
   * drain speaks. `runId` is the bootstrap RUN and `jobId` the container job it dispatched,
   * which is the same split every execution step's handle carries.
   */
  private jobHandle(handle: BootstrapJobHandle): AgentJobHandle {
    return {
      jobId: handle.containerJobId,
      runId: handle.jobId,
      workspaceId: handle.workspaceId,
      agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      model: this.resolvedModel(),
      provider: this.deps.model.provider,
    }
  }

  /**
   * The resolved model as every OTHER producer writes it: `provider:model`, which is the format
   * `AgentJobHandle.model` and `agentContextSnapshotSchema.model` both document. A bare model id
   * renders beside prefixed ones on the same panel and gives nothing to a reader that splits the
   * field to recover the provider.
   */
  private resolvedModel(): string {
    return `${this.deps.model.provider}:${this.deps.model.model}`
  }

  /**
   * File what this dispatch handed the agent, so a bootstrap's Provided-context tab answers the
   * same question every other agent run's does.
   *
   * AWAITED for the reason `recordAgentContextSnapshot` states: it runs after the container has
   * already been accepted, so it delays nothing but the handle's return, and an un-awaited insert
   * is dropped outright on the Worker, where this runs inside a Workflow step.
   */
  private async recordDispatchContext(
    request: BootstrapRepoRequest,
    body: Record<string, unknown>,
    log: typeof logger,
  ): Promise<void> {
    await recordBootstrapContextSnapshot(this.deps.agentContextObservability, log, {
      body,
      model: this.resolvedModel(),
      agentKind: REPO_BOOTSTRAP_AGENT_KIND,
      workspaceId: request.workspaceId,
      executionId: request.jobId,
      stepIndex: dispatchStepIndex(request),
    })
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

  /**
   * Construct the success outcome from the installation + the recorded job's repo name.
   *
   * `resultDefaultBranch` is what the HARNESS reported, and only the `bootstrap` spec reports one
   * (it echoes back the branch it force-pushed, which it also created). The plain coding shape a
   * `pull_request` run takes reports none, so the branch is READ off the target repository rather
   * than defaulted to `main`: this field states which branch the work lands on, and a repository
   * whose default is `master`, `trunk` or an org-wide choice would otherwise be recorded as a ref
   * that does not exist. One read, on the terminal poll only. A failed read keeps the
   * conventional fallback and says so in a warning, rather than failing a delivered run over the
   * one field nothing reads back.
   */
  private async buildOutcome(
    handle: BootstrapJobHandle,
    repoName: string,
    resultDefaultBranch: string | undefined,
  ): Promise<BootstrapRepoOutcome> {
    const installation = await this.deps.installationRepository.getByWorkspace(handle.workspaceId)
    if (!installation)
      throw new Error(`Workspace '${handle.workspaceId}' is not connected to GitHub`)
    const owner = installation.accountLogin
    const log = logger.child({ jobId: handle.jobId, workspaceId: handle.workspaceId })
    const target = resultDefaultBranch
      ? null
      : await runBestEffort(
          log,
          'bootstrap: read the target repo default branch',
          () =>
            this.deps.githubClient.getRepo(installation.installationId, {
              owner,
              repo: repoName,
            }),
          { repo: `${owner}/${repoName}` },
        )
    return {
      repoUrl: `${this.webBase()}/${owner}/${repoName}`,
      owner,
      name: repoName,
      defaultBranch: resultDefaultBranch ?? (target ? defaultBranchOf(target) : 'main'),
    }
  }

  /** The run's stored row, which a poll addresses only by id. */
  private async requireRecord(handle: BootstrapJobHandle) {
    const record = await this.deps.bootstrapJobRepository.get(handle.workspaceId, handle.jobId)
    if (!record) throw new Error(`Bootstrap job '${handle.jobId}' not found`)
    return record
  }
}

/**
 * Which of the RUN's own steps this dispatch is, numbered exactly as the board numbers them.
 *
 * The container dispatch is always the run's LAST move: a new-repo run is only `scaffold`, and a
 * monorepo run's apply follows the survey and the human review. So it is read off the end of the
 * shared `bootstrapStepIds` list rather than by searching it for a step NAME, which cannot
 * answer `-1`. A snapshot filed at a step the run never had is a row every step-scoped read
 * silently drops.
 */
function dispatchStepIndex(request: BootstrapRepoRequest): number {
  return bootstrapStepIds({ monorepo: request.monorepo ?? null }).length - 1
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
