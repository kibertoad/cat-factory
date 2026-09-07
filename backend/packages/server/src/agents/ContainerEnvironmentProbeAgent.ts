import type {
  EnvironmentProbeAgent,
  EnvironmentProbeHandle,
  EnvironmentProbeRequest,
  EnvironmentProbeSurface,
  EnvironmentProbeUpdate,
  GitHubInstallationRepository,
  Logger,
  ModelRef,
  RepoProjectionRepository,
  RunnerImageVariant,
  RunnerJobRef,
  TestSecretEntry,
  TestSecretRef,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause, runBestEffort } from '@cat-factory/kernel'
import {
  environmentProbeSystemPrompt,
  environmentProbeUserPrompt,
  ENVIRONMENT_PROBE_SHAPE_HINT,
  isProxyableProvider,
} from '@cat-factory/agents'
import {
  ENVIRONMENT_PROBE_API_AGENT_KIND,
  ENVIRONMENT_PROBE_UI_AGENT_KIND,
} from '@cat-factory/contracts'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'
import type { MintInstallationToken, ResolveRepoOrigin } from './repoTargeting.js'
import { githubRepoOrigin } from './containerAgentBody.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

// ---------------------------------------------------------------------------
// The AGENT DRY RUN's dispatcher: one read-only `explore` job pointed at a freshly provisioned
// ephemeral environment, whose whole product is the structured report on `result.custom`.
//
// It implements the kernel {@link EnvironmentProbeAgent} port and is shaped exactly like
// {@link import('./ContainerEnvConfigRepairer.js').ContainerEnvConfigRepairer}: mint the tokens,
// build the harness body, dispatch through the shared {@link RunnerJobClient}, poll, reclaim. What
// differs from that flow is only what the job IS: `mode: 'explore'` with a structured output and
// NO push (this agent must never change the repository), against `infra: ephemeral`, which stands
// nothing up and hands the environment's URL to the harness so a container backend can bridge it.
//
// Three details are load-bearing and each cost a real bug elsewhere in this codebase first:
//
//  - The dispatch DECLARES its environment through `RunnerDispatchOptions.environments`. That is
//    what feeds the container's hosts entry (`--add-host` / `hostAliases`), and a transport is
//    documented never to reach into the body for it. Omitted, the local backend cannot bridge the
//    environment's name and every operation the prober attempts reports `unreachable`.
//  - The IMAGE is pinned per surface, and the same value rides the `RunnerJobRef` on every poll
//    and release. A per-run container backend puts a differently-imaged job in its own container,
//    so a poll that forgot the variant polls a container that was never started, and a release
//    that forgot it leaves a browser container running for its full lifetime.
//  - The TEST SECRETS are resolved ONCE here: the values go on the body's dedicated `testSecrets`
//    field (the harness turns them into the agent process's environment) and the key +
//    description pairs of that SAME list are what the prompt advertises. One resolution, so the
//    prompt cannot name a variable the container does not carry.
// ---------------------------------------------------------------------------

/** Which executor image each surface needs. */
const IMAGE_BY_SURFACE: Record<EnvironmentProbeSurface, RunnerImageVariant | undefined> = {
  // The plain harness image: `curl` and the repo's own runtime are all an HTTP prober needs.
  api: undefined,
  // The heavier UI image, which bundles Playwright and a browser. A browser prober on the plain
  // image discovers it has no browser only after the container is up and the model has started
  // reasoning, and reports it as `tooling_missing`: a spent dispatch that says nothing about the
  // environment.
  ui: 'ui',
}

/** The telemetry agent kind each surface's spend is filed under. */
const KIND_BY_SURFACE: Record<EnvironmentProbeSurface, string> = {
  api: ENVIRONMENT_PROBE_API_AGENT_KIND,
  ui: ENVIRONMENT_PROBE_UI_AGENT_KIND,
}

export interface ContainerEnvironmentProbeAgentDependencies {
  /** Resolve which runner backend the probe dispatches to: the seam every container flow rides. */
  resolveTransport: ResolveRunnerTransport
  /** Resolve which installation a workspace's repos live under (the prober's read-only clone). */
  installationRepository: Pick<GitHubInstallationRepository, 'getByWorkspace'>
  /**
   * The workspace's repo projection, read to turn `owner`/`name` into the neutral id the token
   * scope speaks in. Required rather than optional for the reason the repairer states: it is the
   * only thing between this container and an installation-wide credential.
   */
  repoRepository: Pick<RepoProjectionRepository, 'list'>
  /** Mints the short-lived clone token, scoped to the one repo the prober reads. */
  mintInstallationToken: MintInstallationToken
  /** Mints the signed, model-locked LLM-proxy session token the container uses. */
  sessionService: ContainerSessionService
  /** Model the prober runs with (must be proxyable, like the other Pi-harness flows). */
  model: ModelRef
  /** Public base URL of the LLM proxy, including `/v1`. */
  proxyBaseUrl: string
  /**
   * Resolves the service frame's sealed test credentials. Absent ⇒ the deployment has no sealed
   * store, which the prompt STATES ("no test credentials are configured") rather than omitting: a
   * prober that cannot tell an unconfigured store from one it was not shown files the platform's
   * own gap as its own ignorance, and `missingContext` is the field that gap belongs in.
   */
  resolveTestSecrets?: (workspaceId: string, blockId: string) => Promise<TestSecretEntry[]>
  /**
   * Where the container clones from, per VCS provider. Defaults to GitHub; a GitLab deployment
   * injects `deploymentRepoOrigin` so the prober clones the right host instead of a same-named
   * project on github.com.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  /** REST base for the clone host (Enterprise / api.github.com). */
  githubApiBase?: string
}

export class ContainerEnvironmentProbeAgent implements EnvironmentProbeAgent {
  private readonly jobs: RunnerJobClient

  constructor(private readonly deps: ContainerEnvironmentProbeAgentDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
  }

  async start(request: EnvironmentProbeRequest): Promise<EnvironmentProbeHandle> {
    const { workspaceId, jobId, surface, repo, environment } = request
    const log = logger.child({
      jobId,
      workspaceId,
      surface,
      repo: `${repo.owner}/${repo.name}`,
    })

    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(
        `Workspace '${workspaceId}' is not connected to a source-control provider, so the ` +
          'agent dry run has no repository to read.',
      )
    }
    if (!isProxyableProvider(this.deps.model.provider)) {
      throw new Error(
        `An agent dry run needs a model the LLM proxy can serve (Workers AI, or a direct ` +
          `OpenAI-compatible provider); '${this.deps.model.provider}' is not supported.`,
      )
    }
    if (!environment.url) {
      throw new Error('The environment exposed no URL, so there is nothing for an agent to drive.')
    }

    // ONE resolution, two consumers: the values become the container's environment variables and
    // the keys + descriptions of the same list are what the prompt advertises. See the class note.
    const secrets = await this.resolveSecrets(workspaceId, request.blockId, log)
    const repoIds = await this.resolveRepoScope(workspaceId, repo.owner, repo.name)
    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: jobId,
      workspaceId,
      repoIds,
      ...(request.initiatedBy ? { initiatedBy: request.initiatedBy } : {}),
    })
    const agentKind = KIND_BY_SURFACE[surface]
    const sessionToken = await this.deps.sessionService.mint({
      workspaceId,
      executionId: jobId,
      agentKind,
      provider: this.deps.model.provider,
      model: this.deps.model.model,
    })
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)({
      installationId: installation.installationId,
      repoId: repoIds[0] ?? '',
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.branch,
      ...(repo.provider ? { provider: repo.provider } : {}),
      ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
    })

    const body = {
      jobId,
      workspaceId,
      // A single-job flow: its run IS its one job, so the correlation id the container logs bind
      // to is the self-test run id, exactly as bootstrap and config-repair do.
      executionId: jobId,
      mode: 'explore',
      systemPrompt: environmentProbeSystemPrompt(surface),
      userPrompt: environmentProbeUserPrompt({
        surface,
        service: request.service,
        environment,
        testSecretRefs: secrets.refs,
        repo: {
          owner: repo.owner,
          name: repo.name,
          branch: repo.branch,
          ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
        },
      }),
      model: this.deps.model.model,
      proxyBaseUrl: this.deps.proxyBaseUrl,
      proxyPhasePath: true,
      sessionToken,
      ghToken,
      repo: {
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.branch,
        cloneUrl: origin.cloneUrl,
        provider: origin.provider,
        ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
      },
      // The THROWAWAY branch the environment was provisioned from, so the tree the prober reads
      // is the tree that is running.
      branch: repo.branch,
      // `repair: true` because a dry run's whole deliverable is this JSON and a single malformed
      // field would discard a report somebody has to act on. Deliberately NOT
      // `failOnUnusableFinal`: the coercion is lenient by design, so a partial report is worth
      // more than a failed stage, and a reply with nothing in it at all still reaches the caller
      // as an `inoperable` verdict with no operations, which reads exactly as what happened.
      output: { kind: 'structured', shapeHint: ENVIRONMENT_PROBE_SHAPE_HINT, repair: true },
      // Stand NOTHING up: the environment is already deployed and the URL is echoed for context.
      // The same spec a Tester gets for a provisioned service, which is what keeps the harness
      // free of any knowledge that this flow exists.
      infra: { kind: 'service', environment: 'ephemeral', environmentUrl: environment.url },
      // Narrowed to `{ key, value }`, exactly as the step executor's `testSecretEnv` is: the
      // DESCRIPTION is prompt-facing metadata, and this is the secret-bearing channel the
      // agent-context snapshot's allow-list omits. Sending it here would put prose in a field
      // nothing reads and the harness does not parse.
      ...(secrets.env.length ? { testSecrets: secrets.env } : {}),
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }

    log.info('environment dry run: dispatching container')
    await this.jobs.dispatch(workspaceId, this.ref(jobId, surface), body, 'agent', {
      ...(IMAGE_BY_SURFACE[surface] ? { image: IMAGE_BY_SURFACE[surface] } : {}),
      // Declared, never read back out of the body: see the class note. `address` rides along
      // whenever the platform proved one, because a name that resolves nowhere from inside the
      // container is the whole reason the bridge exists.
      environments: [
        {
          url: environment.url,
          ...(environment.reachability?.address
            ? { address: environment.reachability.address }
            : {}),
        },
      ],
    })
    log.info('environment dry run: container accepted job')
    return { workspaceId, jobId, surface }
  }

  async poll(handle: EnvironmentProbeHandle): Promise<EnvironmentProbeUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, this.ref(handle.jobId, handle.surface))
    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    if (view.state === 'failed') {
      return {
        state: 'failed',
        // The transport's structured eviction verdict first, then the harness's own cause. Both
        // eviction kinds collapse to `evicted`: a dry run has no recovery budget to split them
        // with (only the run driver's `recoverContainerEviction` does), so the distinction would
        // be recorded and never acted on.
        failureKind: view.evicted
          ? 'evicted'
          : (failureKindFromHarnessCause(view.failureCause) ?? 'agent'),
        error: view.error ?? 'The agent dry run job failed.',
        ...(view.error ? { detail: view.error } : {}),
      }
    }
    const result = view.result ?? {}
    if (result.error) {
      return {
        state: 'failed',
        failureKind: failureKindFromHarnessCause(view.failureCause) ?? 'agent',
        error: `The agent dry run failed: ${result.error}`,
        detail: result.error,
      }
    }
    if (result.custom === undefined || result.custom === null) {
      // The job completed and returned no JSON. Reported as a FAILED dry run rather than as an
      // empty report: an agent that produced nothing has established nothing about the
      // environment, and an empty report would be graded `inoperable` and read as a finding
      // about the service.
      return {
        state: 'failed',
        failureKind: failureKindFromHarnessCause(view.failureCause) ?? 'agent',
        error:
          'The agent dry run finished without returning a report, so nothing was established ' +
          'about the environment.',
      }
    }
    return {
      state: 'done',
      report: result.custom,
      model: `${this.deps.model.provider}:${this.deps.model.model}`,
    }
  }

  async stop(handle: EnvironmentProbeHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, this.ref(handle.jobId, handle.surface))
  }

  /**
   * The job's address. The IMAGE is part of it on every call, not only the dispatch: see the
   * class note on why a poll or release that drops it addresses the wrong container.
   */
  private ref(jobId: string, surface: EnvironmentProbeSurface): RunnerJobRef {
    const image = IMAGE_BY_SURFACE[surface]
    return { runId: jobId, jobId, ...(image ? { image } : {}) }
  }

  /**
   * The service frame's sealed test credentials, as the two projections this dispatch needs.
   *
   * Best-effort: a store that will not open is a reason to run the dry run WITHOUT credentials
   * and let the prober report `auth_missing`, not a reason to fail the diagnostic: an operator
   * who cannot read their own secret store learns more from a report naming what was missing than
   * from a stage that refused to run. The warn carries the cause.
   */
  private async resolveSecrets(
    workspaceId: string,
    blockId: string,
    log: Logger,
  ): Promise<{ env: { key: string; value: string }[]; refs: TestSecretRef[] }> {
    const resolve = this.deps.resolveTestSecrets
    if (!resolve) return { env: [], refs: [] }
    const entries: TestSecretEntry[] =
      (await runBestEffort(log, 'resolve dry-run test secrets', () =>
        resolve(workspaceId, blockId),
      )) ?? []
    return {
      env: entries.map((entry) => ({ key: entry.key, value: entry.value })),
      refs: entries.map((entry) => ({ key: entry.key, description: entry.description })),
    }
  }

  /**
   * The repo the prober's token may reach, as the neutral id the mint's scope speaks in. An empty
   * result is returned rather than thrown, for the reason the repairer states: a projection
   * lagging behind a just-linked repo is a reason to widen the token and report it, not to refuse
   * a diagnostic the developer asked for.
   */
  private async resolveRepoScope(
    workspaceId: string,
    owner: string,
    repo: string,
  ): Promise<string[]> {
    const projected = await this.deps.repoRepository.list(workspaceId)
    const match = projected.find(
      (row) =>
        row.owner.toLowerCase() === owner.toLowerCase() &&
        row.name.toLowerCase() === repo.toLowerCase(),
    )
    return match ? [String(match.githubId)] : []
  }
}
