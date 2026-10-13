import { generateText } from 'ai'
import type { MergeAssessment, PublicPrAssessment } from '@cat-factory/contracts'
import {
  catFactoryObservability,
  PR_ASSESSMENT_SYSTEM_PROMPT,
  PR_ASSESSOR_AGENT_KIND,
  renderPrAssessmentPrompt,
} from '@cat-factory/agents'
import type {
  Clock,
  GitHubChangedFile,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  RepoFiles,
  ResolveRepoFilesForCoords,
  RiskPolicyLibraryEntry,
  RunInitiatorScope,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  classifyChangedFiles,
  CredentialRequiredError,
  extractJson,
  getErrorMessage,
  NotFoundError,
  RateLimitedError,
  resolveInlineScope,
  resolveScopedModelProvider,
  UnavailableError,
  VcsCapabilityUnsupportedError,
} from '@cat-factory/kernel'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'
import { partitionPatches } from '../guidedReview/guidedReview.logic.js'
import {
  coercePrAssessment,
  evaluatePrAssessmentVerdict,
  PR_ASSESSMENT_INLINE_PATCH_CHARS,
  PR_ASSESSMENT_TIMEOUT_MS,
  selectAssessmentPolicy,
} from './prAssessment.logic.js'

export interface PrAssessmentServiceDeps extends InlineBlockModelDeps {
  /** The board's merged risk-policy library, the one a task pin resolves against. */
  listRiskPolicies: (workspaceId: string) => Promise<RiskPolicyLibraryEntry[]>
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /** Runs the VCS reads under the caller's credential scope (initiator PAT policy). */
  runInitiatorScope?: RunInitiatorScope
  modelProviderResolver?: ModelProviderResolver
  modelProvider?: ModelProvider
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  clock: Clock
}

export interface AssessPullRequestInput {
  owner: string
  repo: string
  prNumber: number
  provider?: VcsProvider
  riskPolicyId?: string
}

/** A pull request as read for one assessment: everything the prompt and the verdict need. */
interface ReadPr {
  title: string
  headSha: string
  baseRef: string
  body: string | null
  files: GitHubChangedFile[]
}

/**
 * Scores a pull request on the merger's three axes in one inline model call and judges it against
 * a risk policy with the merge path's own ladder. Nothing is persisted. Refusals run cheapest
 * first: the policy lookup and the PR reads come before the budget probe, and that before a
 * vendor sees a token.
 */
export class PrAssessmentService {
  constructor(private readonly deps: PrAssessmentServiceDeps) {}

  /** `userId` is the person a key acts for, or null for a key bound to nobody. */
  async assess(
    workspaceId: string,
    userId: string | null,
    input: AssessPullRequestInput,
  ): Promise<PublicPrAssessment> {
    const policy = selectAssessmentPolicy(
      await this.deps.listRiskPolicies(workspaceId),
      input.riskPolicyId,
    )
    const context = await this.repoFor(workspaceId, input)
    const provider = context.provider ?? input.provider ?? 'github'
    const pr = await this.asUser(workspaceId, userId, () =>
      readPr(context.repo, provider, input.prNumber),
    )
    if (await this.deps.isOverBudget?.(workspaceId)) {
      throw new RateLimitedError(
        'This workspace has spent its configured model budget',
        'budget_exhausted',
      )
    }
    const owner = context.owner ?? input.owner
    const repo = context.name ?? input.repo
    const { assessment, model } = await this.generate(workspaceId, userId, {
      pr: { owner, repo, prNumber: input.prNumber, ...pr },
      body: pr.body,
      files: pr.files,
    })
    const { changeClass, fileCount } = classifyChangedFiles(pr.files.map((f) => f.path))
    return {
      provider,
      owner,
      repo,
      prNumber: input.prNumber,
      headSha: pr.headSha,
      changeClass,
      changedFileCount: fileCount,
      assessment,
      model,
      policy: { policyId: policy.id, name: policy.name },
      verdict: evaluatePrAssessmentVerdict(policy, assessment, changeClass),
      assessedAt: this.deps.clock.now(),
    }
  }

  private async generate(
    workspaceId: string,
    userId: string | null,
    subject: {
      pr: {
        owner: string
        repo: string
        prNumber: number
        title: string
        headSha: string
        baseRef: string
      }
      body: string | null
      files: GitHubChangedFile[]
    },
  ): Promise<{ assessment: MergeAssessment; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(workspaceId, userId)
    const model = `${ref.provider}:${ref.model}`
    const { inline, omitted } = partitionPatches(subject.files, PR_ASSESSMENT_INLINE_PATCH_CHARS)
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: PR_ASSESSMENT_SYSTEM_PROMPT,
        prompt: renderPrAssessmentPrompt({
          pr: subject.pr,
          body: subject.body?.trim() ? subject.body : null,
          files: subject.files,
          inlinePatches: inline,
          omittedPatchPaths: omitted,
        }),
        temperature: 0,
        maxOutputTokens: 4_000,
        abortSignal: AbortSignal.timeout(PR_ASSESSMENT_TIMEOUT_MS),
        providerOptions: catFactoryObservability({
          agentKind: PR_ASSESSOR_AGENT_KIND,
          workspaceId,
        }),
      })
      text = result.text
    } catch (error) {
      // The one model failure a caller can act on: a personal credential that has to be unlocked.
      if (error instanceof CredentialRequiredError) throw error
      throw new UnavailableError(
        `The assessment model call failed: ${getErrorMessage(error)}`,
        'generation_failed',
        { model },
      )
    }
    const assessment = coercePrAssessment(extractJson(text))
    if (!assessment) {
      throw new UnavailableError(
        'The model did not return a readable assessment',
        'unreadable_reply',
        { model },
      )
    }
    return { assessment, model }
  }

  /** The model under `userId`'s scope, or the workspace's when the key acts for nobody. */
  private async resolveModel(
    workspaceId: string,
    userId: string | null,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await resolveInlineScope(
      userId === null ? { kind: 'workspace', workspaceId } : { kind: 'user', workspaceId, userId },
    )
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await resolveInlineBlockModelRef(this.deps, workspaceId, PR_ASSESSOR_AGENT_KIND, {})
    if (!modelProvider || !ref) {
      throw new UnavailableError(
        'No model is configured for pull request assessment',
        'model_unavailable',
      )
    }
    return { modelProvider, ref }
  }

  private async repoFor(
    workspaceId: string,
    coords: { owner: string; repo: string; provider?: VcsProvider },
  ) {
    const resolve = this.deps.resolveRepoFilesForCoords
    if (!resolve) {
      throw new UnavailableError(
        'No source control integration is configured',
        'vcs_not_configured',
      )
    }
    const context = await resolve(workspaceId, {
      owner: coords.owner,
      repo: coords.repo,
      ...(coords.provider ? { provider: coords.provider } : {}),
    })
    if (!context) {
      throw new NotFoundError('Repository', `${coords.owner}/${coords.repo}`, {
        reason: 'repo_not_linked',
      })
    }
    return context
  }

  private asUser<T>(workspaceId: string, userId: string | null, fn: () => T): T {
    const scope = this.deps.runInitiatorScope
    return scope ? scope({ workspaceId, initiatedBy: userId }, fn) : fn()
  }
}

/**
 * The PR's header, description and changed files. The head is read on both sides of the file
 * listing, so the files reported are known to belong to the commit reported.
 */
async function readPr(repo: RepoFiles, provider: VcsProvider, prNumber: number): Promise<ReadPr> {
  const getPullRequest = repo.getPullRequest?.bind(repo)
  const listChangedFiles = repo.listChangedFiles?.bind(repo)
  if (!getPullRequest || !listChangedFiles) {
    throw new VcsCapabilityUnsupportedError(provider, 'pull request reads')
  }
  const before = await getPullRequest(prNumber)
  if (!before?.headSha || !before.baseRef) {
    throw new NotFoundError('Pull request', String(prNumber), { reason: 'pr_not_found' })
  }
  const files = await listChangedFiles(prNumber)
  const after = await getPullRequest(prNumber)
  if (after?.headSha !== before.headSha) {
    throw new UnavailableError(
      'The pull request received new commits while it was being read; retry',
      'pr_head_moved',
    )
  }
  const body = repo.getPullRequestBody ? await repo.getPullRequestBody(prNumber) : null
  return { title: before.title, headSha: before.headSha, baseRef: before.baseRef, body, files }
}
