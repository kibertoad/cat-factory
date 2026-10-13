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
  Logger,
  ModelProvider,
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
  describeError,
  extractJson,
  getErrorMessage,
  NotFoundError,
  noopLogger,
  RateLimitedError,
  UnavailableError,
  VcsCapabilityUnsupportedError,
} from '@cat-factory/kernel'
import { partitionPatches } from '../guidedReview/guidedReview.logic.js'
import {
  type InlinePrModelDeps,
  resolveInlinePrModel,
  resolveLinkedRepo,
  runAsInitiator,
} from '../guidedReview/linkedPullRequest.js'
import {
  coercePrAssessment,
  evaluatePrAssessmentVerdict,
  PR_ASSESSMENT_INLINE_PATCH_CHARS,
  PR_ASSESSMENT_TIMEOUT_MS,
  selectAssessmentPolicy,
} from './prAssessment.logic.js'

export interface PrAssessmentServiceDeps extends InlinePrModelDeps {
  /** The board's merged risk-policy library, the one a task pin resolves against. */
  listRiskPolicies: (workspaceId: string) => Promise<RiskPolicyLibraryEntry[]>
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /** Runs the VCS reads under the caller's credential scope (initiator PAT policy). */
  runInitiatorScope?: RunInitiatorScope
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  clock: Clock
  logger?: Logger
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
  private readonly logger: Logger

  constructor(private readonly deps: PrAssessmentServiceDeps) {
    this.logger = deps.logger ?? noopLogger
  }

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
    const context = await resolveLinkedRepo(this.deps.resolveRepoFilesForCoords, workspaceId, input)
    const provider = context.provider ?? input.provider ?? 'github'
    const pr = await runAsInitiator(this.deps.runInitiatorScope, workspaceId, userId, () =>
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
    const { assessment, model } = await this.generate(
      workspaceId,
      userId,
      assessmentPrompt({ owner, repo, prNumber: input.prNumber, ...pr }),
    )
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
    prompt: string,
  ): Promise<{ assessment: MergeAssessment; model: string }> {
    const { modelProvider, ref } = await this.resolveModel(workspaceId, userId)
    const model = `${ref.provider}:${ref.model}`
    let text: string
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: PR_ASSESSMENT_SYSTEM_PROMPT,
        prompt,
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
      const message = `The assessment model call failed: ${getErrorMessage(error)}`
      this.logger.warn(message, { workspaceId, model, ...describeError(error) })
      throw new UnavailableError(message, 'generation_failed', { model })
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
    const model = await resolveInlinePrModel(this.deps, workspaceId, userId, PR_ASSESSOR_AGENT_KIND)
    if (!model) {
      throw new UnavailableError(
        'No model is configured for pull request assessment',
        'model_unavailable',
      )
    }
    return model
  }
}

/** The assessment call's user prompt over a PR as read. */
function assessmentPrompt(pr: ReadPr & { owner: string; repo: string; prNumber: number }): string {
  const { inline, omitted } = partitionPatches(pr.files, PR_ASSESSMENT_INLINE_PATCH_CHARS)
  // A file the host sent no patch for is as unseen as one cut for the budget.
  const withheld = pr.files.filter((file) => file.patch === null).map((file) => file.path)
  return renderPrAssessmentPrompt({
    pr,
    body: pr.body?.trim() ? pr.body : null,
    files: pr.files,
    inlinePatches: inline,
    omittedPatchPaths: [...omitted, ...withheld],
  })
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
  const [files, body] = await Promise.all([
    listChangedFiles(prNumber),
    repo.getPullRequestBody ? repo.getPullRequestBody(prNumber) : null,
  ])
  const after = await getPullRequest(prNumber)
  if (after?.headSha !== before.headSha) {
    throw new UnavailableError(
      'The pull request received new commits while it was being read; retry',
      'pr_head_moved',
    )
  }
  return { title: before.title, headSha: before.headSha, baseRef: before.baseRef, body, files }
}
