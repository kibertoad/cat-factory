import type {
  AgentJobHandle,
  EnvironmentProbeAgent,
  EnvironmentProbeDispatchCheck,
  EnvironmentProbeHandle,
  EnvironmentProbeRequest,
  EnvironmentProbeSurface,
  EnvironmentProbeUpdate,
  GitHubInstallationRepository,
  RepoProjectionRepository,
  RunnerImageVariant,
  RunnerJobRef,
  RunnerJobView,
  TestSecretEntry,
} from '@cat-factory/kernel'
import { failureKindFromHarnessCause, getErrorMessage } from '@cat-factory/kernel'
import {
  environmentProbeSystemPrompt,
  environmentProbeUserPrompt,
  ENVIRONMENT_PROBE_SHAPE_HINT,
} from '@cat-factory/agents'
import { environmentProbeAgentKind, isEnvironmentProbeReportPayload } from '@cat-factory/contracts'
import type { ContainerJobAuthResolver } from './containerJobAuth.js'
import {
  ContainerJobAccounting,
  type ContainerJobAccountingDeps,
} from './containerJobAccounting.js'
import { providerOf } from './containerJobAddressing.js'
import { resolveTestCredentials } from './testCredentials.js'
import type { ResolveSingleKindModel, SingleKindModel } from './singleKindModel.js'
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
// Four details are load-bearing and each cost a real bug elsewhere in this codebase first:
//
//  - The dispatch DECLARES its environment through `RunnerDispatchOptions.environments`. That is
//    what feeds the container's hosts entry (`--add-host` / `hostAliases`), and a transport is
//    documented never to reach into the body for it. Omitted, the local backend cannot bridge the
//    environment's name and every operation the prober attempts reports `unreachable`.
//  - The IMAGE is pinned per surface, and the same value rides the `RunnerJobRef` on every poll
//    and release. A per-run container backend puts a differently-imaged job in its own container,
//    so a poll that forgot the variant polls a container that was never started, and a release
//    that forgot it leaves a browser container running for its full lifetime.
//  - The MODEL is resolved PER DISPATCH, by the same precedence a pipeline step's is (the frame's
//    pin, else the workspace's model preset for this prober's kind, else the deployment's env
//    routing), and with it the HARNESS and the credential that opens it. Read at wiring from the
//    env routing instead, it is whatever that deployment defaults to: a workspace running
//    everything on its Claude preset had its dry run dispatched at Qwen, which the LLM proxy then
//    refused for having no key, and the prober's subscription was never asked for at all.
//  - The TEST SECRETS are resolved ONCE here: the values go on the body's dedicated `testSecrets`
//    field (the harness turns them into the agent process's environment) and the key +
//    description pairs of that SAME list are what the prompt advertises. One resolution, so the
//    prompt cannot name a variable the container does not carry, and the three states that
//    resolution can END in are stated to the prober rather than collapsed into an empty list.
//  - What the dispatch RESOLVED rides back on the handle and is persisted by the caller, and what
//    the job SPENT is filed through the same `ContainerJobAccounting` a pipeline step's is. A
//    subscription-routed dry run talks straight to the vendor, so the LLM proxy meters none of it:
//    with no accounting here its whole burn was absent from `llm_call_metrics`, from the leased
//    token's usage-aware rotation, and from the modeled quota cycle. Free and invisible, on the one
//    flow whose own admission gate is a budget.
// ---------------------------------------------------------------------------

/**
 * The `provider:model` label a dispatch is recorded under, spelled the same way the step path
 * spells it (`ContainerAgentExecutor`'s `buildJobBody`), so one reader can parse either.
 */
function modelLabel(ref: { provider: string; model: string }): string {
  return `${ref.provider}:${ref.model}`
}

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
  /**
   * Which model this dispatch runs, resolved PER DISPATCH by the shared single-job resolution:
   * the frame's own pin, else the workspace's model preset for the prober's kind, else the
   * deployment's env routing: the precedence a pipeline step already gets.
   *
   * Per dispatch rather than per WIRING, because the answer is a per-workspace fact and the
   * facade has none in hand when it builds this. It is also per SURFACE by construction, since
   * the two probers ask under their own agent kinds ({@link environmentProbeAgentKind}): a
   * deployment that pointed its browser prober at a vision-capable model and its HTTP one at a
   * cheap text model still gets the split.
   */
  resolveModel: ResolveSingleKindModel
  /**
   * The per-job auth channel, resolved from the model above: a short-lived, model-locked proxy
   * session token for a Pi model, a leased subscription credential for a Claude Code / Codex one,
   * or the ambient-CLI flag in native local mode.
   *
   * Shared with the step dispatcher rather than reimplemented, which is what makes a
   * subscription-routed prober possible at all: this flow used to serve only the proxy branch, so
   * a subscription model was refused at wiring and the whole feature was disabled for the
   * deployment that had one.
   */
  auth: ContainerJobAuthResolver
  /**
   * Where a settled job's tokens are recorded: the per-call telemetry rows, the leased pool token's
   * usage-aware rotation counters, and the modeled quota cycle. The SAME collaborator the step
   * executor files through, so a dry run's spend is readable exactly like a step's.
   *
   * Only a SUBSCRIPTION harness has anything to report here: a Pi job reaches its model through the
   * LLM proxy, which is the single metering point for it and files the rows itself. That is
   * precisely why this cannot be omitted now the prober can resolve a subscription model: the
   * proxy sees nothing of that job. Absent ⇒ no channel is wired (a facade with no telemetry store
   * and no pool), which every method here treats as the no-op it is.
   */
  accounting?: ContainerJobAccountingDeps
  /**
   * Resolves the service frame's sealed test credentials. Absent ⇒ the deployment has no sealed
   * store, which the prompt STATES as a DEPLOYMENT fact rather than omitting: a prober that cannot
   * tell an unconfigured store from one it was not shown files the platform's own gap as its own
   * ignorance, and `missingContext` is the field that gap belongs in. A store that is wired and
   * will not OPEN is a third state, stated as such: the resolution and the three states are the
   * SHARED `resolveTestCredentials` / `TestCredentialBrief` the tester step's dispatch uses, which
   * is what makes a dry run's answer about authenticating here predict the tester's.
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
  private readonly accounting: ContainerJobAccounting

  constructor(private readonly deps: ContainerEnvironmentProbeAgentDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
    this.accounting = new ContainerJobAccounting(deps.accounting ?? {})
  }

  /**
   * Whether the workspace's resolved runner backend can serve this surface's executor image.
   *
   * The backend is asked because it is the only thing that knows: a Worker binds container
   * classes, a local transport pins image tags, and a self-hosted pool resolves images on its own
   * side and cannot answer at all. That last case answers TRUE (see the port): an unknown is not a
   * refusal, and a deployment whose pool has no UI image still fails at dispatch exactly as every
   * other container flow does there.
   *
   * A transport that cannot even be RESOLVED is `false`: a dry run needs a runner, and refusing at
   * admission is the whole point of asking here.
   */
  async supports(workspaceId: string, surface: EnvironmentProbeSurface): Promise<boolean> {
    const transport = await this.deps.resolveTransport(workspaceId).catch(() => null)
    if (!transport) return false
    return transport.supportsImage?.(IMAGE_BY_SURFACE[surface]) ?? true
  }

  /**
   * Whether the model this frame's dry run resolves to can actually be dispatched, run at ADMISSION
   * over the same two steps `start` takes: resolve the model (which refuses a provider the LLM proxy
   * cannot serve), then ask the auth resolver whether the harness that model names has a credential
   * to open it.
   *
   * Asked here rather than left to the dispatch because both answers are already knowable, and
   * neither is knowable cheaply later: reached from inside `stage.dispatch`, each one fails the run
   * at `probing` after a throwaway branch, a full provision and a teardown, to report something the
   * workspace's own preset said before anything was created.
   *
   * A resolution that THROWS is the refusal, carried verbatim: `resolveDispatchRef`'s message
   * already names the fix (pick a Workers AI model, configure a provider key, add a local runner),
   * and re-wording it here would hand the operator two spellings of one problem.
   */
  async checkDispatchable(subject: {
    workspaceId: string
    blockId: string
    surface: EnvironmentProbeSurface
    initiatedBy: string | null
  }): Promise<EnvironmentProbeDispatchCheck> {
    let resolved: SingleKindModel
    try {
      resolved = await this.resolveModel(subject, subject.surface)
    } catch (error) {
      return { ok: false, detail: getErrorMessage(error) }
    }
    const gap = await this.deps.auth.describeAuthGap({
      harness: resolved.harness,
      subscriptionVendor: resolved.subscriptionVendor,
      workspaceId: subject.workspaceId,
      ...(subject.initiatedBy ? { initiatedByUserId: subject.initiatedBy } : {}),
    })
    return gap ? { ok: false, detail: gap } : { ok: true, model: modelLabel(resolved.ref) }
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
    if (!environment.url) {
      throw new Error('The environment exposed no URL, so there is nothing for an agent to drive.')
    }

    const agentKind = environmentProbeAgentKind(surface)
    // The model this dispatch runs, then the credential that opens it. Both per dispatch, and in
    // this order: the harness the model names decides which auth channel there is to resolve.
    const { ref, harness, subscriptionVendor } = await this.resolveModel(request, surface)
    const { auth, subscriptionTokenId } = await this.deps.auth.resolve({
      harness,
      ref,
      subscriptionVendor,
      workspaceId,
      // The self-test run IS this flow's run, so its id is what the container's calls are metered
      // under, and (for an individual-usage vendor) the id the initiator's credential activation
      // was minted against by the start gate.
      executionId: jobId,
      agentKind,
      ...(request.initiatedBy ? { initiatedByUserId: request.initiatedBy } : {}),
    })

    // ONE resolution, two consumers: the values become the container's environment variables and
    // the keys + descriptions of the same list are what the prompt advertises. See the class note.
    // The SAME resolution the tester step's dispatch uses: one read, two projections (the values
    // for the container, the state for the prompt). Shared because a dry run's claim is that it
    // predicts what a tester will be handed, which it cannot do from a different read.
    const secrets = await resolveTestCredentials({
      ...(this.deps.resolveTestSecrets ? { resolve: this.deps.resolveTestSecrets } : {}),
      workspaceId,
      blockId: request.blockId,
      logger: log,
    })
    const repoIds = await this.resolveRepoScope(workspaceId, repo.owner, repo.name)
    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: jobId,
      workspaceId,
      repoIds,
      ...(request.initiatedBy ? { initiatedBy: request.initiatedBy } : {}),
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
        testSecrets: secrets.brief,
        // Carried straight from the request, which read it off the frame: the prober is told
        // what the tester will be told, which is the only reason its verdict predicts theirs.
        ...(request.testingContext ? { testingContext: request.testingContext } : {}),
        repo: {
          owner: repo.owner,
          name: repo.name,
          branch: repo.branch,
          ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
        },
      }),
      model: ref.model,
      // The resolved auth channel, spread exactly as a pipeline step's body spreads it, so the
      // harness cannot tell a dry run's dispatch from a step's by how it was authenticated.
      ...auth,
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
    return {
      workspaceId,
      jobId,
      surface,
      blockId: request.blockId,
      initiatedBy: request.initiatedBy,
      // What only THIS moment knows, handed back for the caller to persist: see
      // `EnvironmentProbeDispatch`. The leased pooled token id in particular has no second source,
      // and it is the row the settled job's tokens are attributed back to.
      dispatch: {
        model: modelLabel(ref),
        ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
        ...(subscriptionVendor ? { subscriptionVendor } : {}),
      },
    }
  }

  async poll(handle: EnvironmentProbeHandle): Promise<EnvironmentProbeUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, this.ref(handle.jobId, handle.surface))
    // What the job has SPENT, filed on every poll and on every terminal state alike, exactly as the
    // step path files it. See `settleAccounting` for why the failed branches below are not
    // shortcuts past it.
    await this.accounting.recordCalls(this.jobHandle(handle), view.callMetrics)
    if (view.state === 'running') {
      return view.progress ? { state: 'running', subtasks: view.progress } : { state: 'running' }
    }
    await this.settleAccounting(handle, view)
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
    if (!isEnvironmentProbeReportPayload(result.custom)) {
      // The job completed and returned nothing a report can be read out of: no `custom` at all, or
      // a top-level array/string/number the harness's repair pass let through. Reported as a
      // FAILED dry run rather than as an empty report, and the shape question is asked with the
      // SAME predicate the coercion applies: an agent that produced nothing has established
      // nothing about the environment, while an empty report is graded `inoperable` and rendered
      // as a finding about the service.
      return {
        state: 'failed',
        failureKind: failureKindFromHarnessCause(view.failureCause) ?? 'agent',
        error:
          'The agent dry run finished without returning a usable report, so nothing was ' +
          'established about the environment.',
      }
    }
    // The model the container RAN, as the dispatch recorded it and the caller handed it back: never
    // re-resolved here. A fresh poll process asking the frame and the preset again would answer
    // about them as they are NOW, so a pin cleared while the container worked stamps the report
    // with a model nobody ran, which is the one label an operator weighs the verdict by. Absent is
    // a state the report already documents ("absent when the dispatch did not say"), so a handle
    // that carries none leaves the field off rather than guessing at one.
    return {
      state: 'done',
      report: result.custom,
      ...(handle.dispatch?.model ? { model: handle.dispatch.model } : {}),
    }
  }

  /**
   * Everything a SETTLED job owes the ledger, run once the poll knows the job is terminal and
   * BEFORE any of the failure branches return.
   *
   * Before them deliberately: a dry run that spent tokens and then failed (an evicted container, a
   * reply with no JSON) is exactly the run an operator most needs the spend for, and it is the one
   * whose numbers a `return` above this line would drop. The three writes are the step path's own,
   * each idempotent per job id, so the durable driver's replay of a terminal poll cannot
   * double-count.
   *
   * A Pi job reports none of this: the LLM proxy is its single metering point and files its rows
   * itself, so every call here is a no-op for it and the whole method exists for the subscription
   * harnesses, which talk to the vendor direct and are metered nowhere else.
   */
  private async settleAccounting(
    handle: EnvironmentProbeHandle,
    view: RunnerJobView,
  ): Promise<void> {
    const job = this.jobHandle(handle)
    const result = view.result ?? {}
    await this.accounting.recordCallsOnce(job, result)
    await this.accounting.recordPooledUsageOnce(job, result)
    await this.accounting.recordQuotaUsageOnce(job, result)
  }

  /**
   * The dry run's handle as the shared accounting reads one.
   *
   * A self-test is a SINGLE-JOB flow, so the run and the job are one row and `runId` is the job id
   * (which is what makes the recorded rows join to the self-test run the SPA renders). The model,
   * the leased token and the initiator all come off the persisted dispatch attribution rather than
   * being re-derived, for the reason `EnvironmentProbeDispatch` states.
   */
  private jobHandle(handle: EnvironmentProbeHandle): AgentJobHandle {
    const model = handle.dispatch?.model
    return {
      jobId: handle.jobId,
      runId: handle.jobId,
      workspaceId: handle.workspaceId,
      agentKind: environmentProbeAgentKind(handle.surface),
      ...(model ? { model, provider: providerOf(model) } : {}),
      ...(handle.dispatch?.subscriptionTokenId
        ? { subscriptionTokenId: handle.dispatch.subscriptionTokenId }
        : {}),
      ...(handle.dispatch?.subscriptionVendor
        ? { subscriptionVendor: handle.dispatch.subscriptionVendor }
        : {}),
      ...(handle.initiatedBy ? { initiatedByUserId: handle.initiatedBy } : {}),
    }
  }

  async stop(handle: EnvironmentProbeHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, this.ref(handle.jobId, handle.surface))
  }

  /**
   * The model + harness + vendor this surface's prober runs on, asked under the prober's OWN agent
   * kind.
   *
   * Its own kind rather than the tester's, which is what {@link environmentProbeAgentKind}
   * documents: a workspace routes its probers by editing the preset entry named after them, and
   * the START gate resolves an individual-usage vendor for that same kind. Borrowing `tester-api`
   * here would put the gate and the dispatch on two different questions.
   */
  private resolveModel(
    subject: { workspaceId: string; blockId: string; initiatedBy?: string | null },
    surface: EnvironmentProbeSurface,
  ): Promise<SingleKindModel> {
    return this.deps.resolveModel({
      workspaceId: subject.workspaceId,
      blockId: subject.blockId,
      agentKind: environmentProbeAgentKind(surface),
      ...(subject.initiatedBy ? { initiatedByUserId: subject.initiatedBy } : {}),
    })
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
