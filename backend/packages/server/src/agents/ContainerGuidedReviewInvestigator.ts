import type {
  AgentJobHandle,
  GitHubInstallationRepository,
  GuidedReviewInvestigationHandle,
  GuidedReviewInvestigationRequest,
  GuidedReviewInvestigationUpdate,
  GuidedReviewInvestigator,
  RepoProjectionRepository,
  RunnerJobRef,
  RunnerJobView,
} from '@cat-factory/kernel'
import {
  appendContainerDispatchDirectives,
  type AgentKindRegistry,
  GUIDED_REVIEW_INVESTIGATOR_KIND,
  guidedReviewInvestigation,
  systemPromptFor,
} from '@cat-factory/agents'
import type { ContainerJobAuthResolver } from './containerJobAuth.js'
import {
  ContainerJobAccounting,
  type ContainerJobAccountingDeps,
} from './containerJobAccounting.js'
import { providerOf } from './containerJobAddressing.js'
import type { ResolveSingleKindModel } from './singleKindModel.js'
import type { MintInstallationToken, ResolveRepoOrigin } from './repoTargeting.js'
import { githubRepoOrigin } from './containerAgentBody.js'
import { RunnerJobClient, type ResolveRunnerTransport } from './RunnerJobClient.js'
import { logger } from '../observability/logger.js'

// The container behind a DEEP guided-review answer: one read-only `explore` job with a checkout of
// the PR's repository, the PR head fetched beside it, whose product is the structured answer on
// `result.custom`. Shaped like `ContainerEnvironmentProbeAgent`, the other standalone dispatch:
// resolve the model per dispatch, open its credential, mint a clone token scoped to the one repo,
// dispatch through the shared `RunnerJobClient`, and file what it spent through the same
// `ContainerJobAccounting` a pipeline step uses (a subscription harness is metered nowhere else).

export interface ContainerGuidedReviewInvestigatorDependencies {
  resolveTransport: ResolveRunnerTransport
  installationRepository: Pick<GitHubInstallationRepository, 'getByWorkspace'>
  repoRepository: Pick<RepoProjectionRepository, 'list'>
  mintInstallationToken: MintInstallationToken
  /** The investigator kind's model: the workspace preset for it, else the deployment routing. */
  resolveModel: ResolveSingleKindModel
  auth: ContainerJobAuthResolver
  accounting?: ContainerJobAccountingDeps
  resolveRepoOrigin?: ResolveRepoOrigin
  githubApiBase?: string
  /** Composes the kind's system prompt with its surface directives, as a pipeline step's is. */
  agentKindRegistry: AgentKindRegistry
}

export class ContainerGuidedReviewInvestigator implements GuidedReviewInvestigator {
  private readonly jobs: RunnerJobClient
  private readonly accounting: ContainerJobAccounting

  constructor(private readonly deps: ContainerGuidedReviewInvestigatorDependencies) {
    this.jobs = new RunnerJobClient(deps.resolveTransport)
    this.accounting = new ContainerJobAccounting(deps.accounting ?? {})
  }

  async supports(workspaceId: string): Promise<boolean> {
    const transport = await this.deps.resolveTransport(workspaceId).catch(() => null)
    return transport !== null
  }

  async start(request: GuidedReviewInvestigationRequest): Promise<GuidedReviewInvestigationHandle> {
    const { workspaceId, jobId, repo } = request
    const log = logger.child({ jobId, workspaceId, repo: `${repo.owner}/${repo.name}` })
    const installation = await this.deps.installationRepository.getByWorkspace(workspaceId)
    if (!installation || installation.deletedAt) {
      throw new Error(
        `Workspace '${workspaceId}' is not connected to a source-control provider, so there is ` +
          'no repository to check out.',
      )
    }
    const { ref, harness, subscriptionVendor } = await this.deps.resolveModel({
      workspaceId,
      agentKind: GUIDED_REVIEW_INVESTIGATOR_KIND,
      initiatedByUserId: request.initiatedBy,
    })
    const { auth, subscriptionTokenId } = await this.deps.auth.resolve({
      harness,
      ref,
      subscriptionVendor,
      workspaceId,
      // A single-job flow: the job id is its run id, so its calls are metered under the message.
      executionId: jobId,
      agentKind: GUIDED_REVIEW_INVESTIGATOR_KIND,
      initiatedByUserId: request.initiatedBy,
    })
    const repoIds = await this.resolveRepoScope(workspaceId, repo.owner, repo.name)
    const ghToken = await this.deps.mintInstallationToken(installation.installationId, {
      executionId: jobId,
      workspaceId,
      repoIds,
      initiatedBy: request.initiatedBy,
    })
    const origin = (this.deps.resolveRepoOrigin ?? githubRepoOrigin)({
      installationId: installation.installationId,
      repoId: repoIds[0] ?? '',
      owner: repo.owner,
      name: repo.name,
      baseBranch: request.baseRef,
      ...(repo.provider ? { provider: repo.provider } : {}),
    })
    const body = {
      jobId,
      workspaceId,
      executionId: jobId,
      mode: 'explore',
      systemPrompt: appendContainerDispatchDirectives(
        systemPromptFor(GUIDED_REVIEW_INVESTIGATOR_KIND, this.deps.agentKindRegistry),
      ),
      userPrompt:
        `The commit under review is \`${request.headSha}\` (pull request #${request.prNumber}, ` +
        `targeting \`${request.baseRef}\`).\n\n${request.userPrompt}`,
      model: ref.model,
      ...auth,
      ghToken,
      repo: {
        owner: repo.owner,
        name: repo.name,
        baseBranch: request.baseRef,
        cloneUrl: origin.cloneUrl,
        provider: origin.provider,
      },
      branch: request.baseRef,
      full: true,
      // The harness fetches the PR head into `origin/pr-head`; the prompt checks out the reviewed
      // commit from there, since a clone can only start from a branch.
      reviewPrNumber: request.prNumber,
      output: { ...guidedReviewInvestigation.spec, repair: true },
      ...(this.deps.githubApiBase ? { githubApiBase: this.deps.githubApiBase } : {}),
    }
    log.info('guided review investigation: dispatching container')
    await this.jobs.dispatch(workspaceId, this.ref(jobId), body, 'agent', {})
    return {
      workspaceId,
      jobId,
      initiatedBy: request.initiatedBy,
      dispatch: {
        model: `${ref.provider}:${ref.model}`,
        ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
        ...(subscriptionVendor ? { subscriptionVendor } : {}),
      },
    }
  }

  async poll(handle: GuidedReviewInvestigationHandle): Promise<GuidedReviewInvestigationUpdate> {
    const view = await this.jobs.poll(handle.workspaceId, this.ref(handle.jobId))
    await this.accounting.recordCalls(this.jobHandle(handle), view.callMetrics)
    if (view.state === 'running') return { state: 'running' }
    await this.settleAccounting(handle, view)
    if (view.state === 'failed') {
      return { state: 'failed', error: view.error ?? 'The investigation container failed.' }
    }
    const result = view.result ?? {}
    if (result.error) return { state: 'failed', error: result.error }
    if (result.custom === undefined || result.custom === null) {
      return { state: 'failed', error: 'The investigation finished without an answer.' }
    }
    return { state: 'done', report: result.custom, model: handle.dispatch.model }
  }

  async stop(handle: GuidedReviewInvestigationHandle): Promise<void> {
    await this.jobs.release(handle.workspaceId, this.ref(handle.jobId))
  }

  /** Each write is idempotent per job, so a replayed terminal poll cannot double-count. */
  private async settleAccounting(
    handle: GuidedReviewInvestigationHandle,
    view: RunnerJobView,
  ): Promise<void> {
    const job = this.jobHandle(handle)
    const result = view.result ?? {}
    await this.accounting.recordCallsOnce(job, result)
    await this.accounting.recordPooledUsageOnce(job, result)
    await this.accounting.recordQuotaUsageOnce(job, result)
  }

  private jobHandle(handle: GuidedReviewInvestigationHandle): AgentJobHandle {
    const { model, subscriptionTokenId, subscriptionVendor } = handle.dispatch
    return {
      jobId: handle.jobId,
      runId: handle.jobId,
      workspaceId: handle.workspaceId,
      agentKind: GUIDED_REVIEW_INVESTIGATOR_KIND,
      model,
      provider: providerOf(model),
      ...(subscriptionTokenId ? { subscriptionTokenId } : {}),
      ...(subscriptionVendor ? { subscriptionVendor } : {}),
      initiatedByUserId: handle.initiatedBy,
    }
  }

  private ref(jobId: string): RunnerJobRef {
    return { runId: jobId, jobId }
  }

  /** The repo the clone token may reach, as the neutral id the mint's scope speaks in. */
  private async resolveRepoScope(workspaceId: string, owner: string, repo: string) {
    const projected = await this.deps.repoRepository.list(workspaceId)
    const match = projected.find(
      (row) =>
        row.owner.toLowerCase() === owner.toLowerCase() &&
        row.name.toLowerCase() === repo.toLowerCase(),
    )
    return match ? [String(match.githubId)] : []
  }
}
