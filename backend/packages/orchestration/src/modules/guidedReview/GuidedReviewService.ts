import { generateText, stepCountIs, type ToolSet } from 'ai'
import type {
  EditGuidedReviewDraftInput,
  GuidedReviewChange,
  GuidedReviewCommentDraft,
  GuidedReviewPostResult,
  GuidedReviewDepth,
  GuidedReviewFailure,
  GuidedReviewMessage,
  GuidedReviewMessageKind,
  GuidedReviewSession,
  GuidedReviewThread,
  GuidedReviewThreadSummary,
} from '@cat-factory/contracts'
import {
  catFactoryObservability,
  GUIDED_REVIEW_AGENT_KIND,
  GUIDED_REVIEW_ANSWER_SYSTEM_PROMPT,
  GUIDED_REVIEW_DRAFTS_SYSTEM_PROMPT,
  GUIDED_REVIEW_OVERVIEW_SYSTEM_PROMPT,
  guidedReviewTools,
  renderGuidedReviewAnswerPrompt,
  renderGuidedReviewDraftsPrompt,
  renderGuidedReviewOverviewPrompt,
  type GuidedReviewPrHeader,
} from '@cat-factory/agents'
import type {
  Clock,
  ExecutionEventPublisher,
  GitHubChangedFile,
  GuidedReviewDriver,
  GuidedReviewJob,
  GuidedReviewRepository,
  GuidedReviewRunner,
  GuidedReviewSessionFilter,
  IdGenerator,
  Logger,
  ModelProvider,
  ModelProviderResolver,
  ModelRef,
  RepoFiles,
  ResolveRepoFilesForCoords,
  RunInitiatorScope,
  VcsProvider,
} from '@cat-factory/kernel'
import {
  ConflictError,
  extractJson,
  ForbiddenError,
  getErrorMessage,
  NotFoundError,
  noopLogger,
  resolveInlineScope,
  resolveScopedModelProvider,
  runBestEffort,
  UnavailableError,
  ValidationError,
} from '@cat-factory/kernel'
import { type InlineBlockModelDeps, resolveInlineBlockModelRef } from '../../inlineBlockModel.js'
import {
  anchorDrafts,
  coerceAnswer,
  coerceDraftProposals,
  coerceOverview,
  GUIDED_REVIEW_LEASE_MS,
  GUIDED_REVIEW_MAX_STEPS,
  OVERVIEW_INLINE_PATCH_CHARS,
  partitionPatches,
  THREAD_HISTORY_CHARS,
  threadHistory,
  threadTitleFrom,
} from './guidedReview.logic.js'
import { GuidedReviewDrafts } from './GuidedReviewDrafts.js'
import { PrExplorer } from './PrExplorer.js'

export interface GuidedReviewServiceDeps extends InlineBlockModelDeps {
  repository: GuidedReviewRepository
  /** Absent ⇒ queued work waits for a test or a sweeper to call {@link GuidedReviewService.runJob}. */
  runner?: GuidedReviewRunner
  driver: GuidedReviewDriver
  resolveRepoFilesForCoords?: ResolveRepoFilesForCoords
  /** Runs VCS calls under the session creator's credential scope (initiator PAT policy). */
  runInitiatorScope?: RunInitiatorScope
  modelProviderResolver?: ModelProviderResolver
  modelProvider?: ModelProvider
  isOverBudget?: (workspaceId: string) => Promise<boolean>
  idGenerator: IdGenerator
  clock: Clock
  logger?: Logger
  /** Live `guidedReview` deltas; absent ⇒ clients see changes on their next read. */
  events?: Pick<ExecutionEventPublisher, 'guidedReviewChanged'>
}

export interface OpenGuidedReviewInput {
  owner: string
  repo: string
  prNumber: number
  provider?: VcsProvider
}

export interface AskInput {
  content: string
  depth?: GuidedReviewDepth
}

export interface GuidedReviewSessionView {
  session: GuidedReviewSession
  threads: GuidedReviewThreadSummary[]
  drafts: GuidedReviewCommentDraft[]
}

export interface GuidedReviewThreadView {
  thread: GuidedReviewThread
  messages: GuidedReviewMessage[]
}

/** A PR bound for reading: its files, the commit under review and its target branch. */
interface BoundPr {
  repo: RepoFiles
  files: GitHubChangedFile[]
  header: GuidedReviewPrHeader
}

/** A model failure the job settles onto its row, rather than a fault the driver should retry. */
class JobFailure extends Error {
  constructor(
    readonly failure: GuidedReviewFailure,
    readonly model: string | null,
  ) {
    super(failure.detail ?? failure.reason)
  }
}

/**
 * Guided PR review (docs/initiatives/guided-pr-review.md). Requests persist work and return at
 * once; a durable driver calls {@link runJob} to produce the overview or an assistant message.
 *
 * `runJob` claims its row before any model call, so a duplicate delivery is a no-op. A model or
 * VCS failure is settled onto the row with a reason the SPA translates. A repository failure
 * propagates, so the driver retries; the claim lease lets the retry take the job back over.
 */
export class GuidedReviewService {
  private readonly logger: Logger
  private readonly drafts: GuidedReviewDrafts

  constructor(private readonly deps: GuidedReviewServiceDeps) {
    this.logger = deps.logger ?? noopLogger
    this.drafts = new GuidedReviewDrafts({
      repository: deps.repository,
      clock: deps.clock,
      ownedSession: (workspaceId, userId, sessionId) =>
        this.ownedSession(workspaceId, userId, sessionId),
      repoOf: async (workspaceId, session) => (await this.repoFor(workspaceId, session)).repo,
      asUser: (workspaceId, userId, fn) => this.asUser(workspaceId, userId, fn),
      notify: (workspaceId, change) => this.notify(workspaceId, change),
    })
  }

  /** Edit, re-anchor or discard a comment draft; refused as `draft_conflict` from a stale rev. */
  editDraft(
    workspaceId: string,
    userId: string,
    sessionId: string,
    draftId: string,
    input: EditGuidedReviewDraftInput,
  ): Promise<GuidedReviewCommentDraft> {
    return this.drafts.edit(workspaceId, userId, sessionId, draftId, input)
  }

  /** Post the named drafts to the pull request as one review. */
  postDrafts(
    workspaceId: string,
    userId: string,
    sessionId: string,
    input: { draftIds: string[]; summary?: string },
  ): Promise<GuidedReviewPostResult> {
    return this.drafts.post(workspaceId, userId, sessionId, input)
  }

  async open(
    workspaceId: string,
    userId: string,
    input: OpenGuidedReviewInput,
  ): Promise<GuidedReviewSession> {
    const context = await this.repoFor(workspaceId, input)
    const pr = await this.readPr(workspaceId, userId, context.repo, input.prNumber)
    const now = this.deps.clock.now()
    const candidate: GuidedReviewSession = {
      id: this.deps.idGenerator.next('grs'),
      provider: context.provider ?? input.provider ?? 'github',
      repoId: context.repoId,
      owner: context.owner ?? input.owner,
      repo: context.name ?? input.repo,
      prNumber: input.prNumber,
      prTitle: pr.title,
      reviewedHeadSha: pr.headSha,
      baseRef: pr.baseRef,
      createdBy: userId,
      overview: { status: 'pending', generation: 1, content: null, failure: null, model: null },
      createdAt: now,
      updatedAt: now,
    }
    const session = await this.deps.repository.openSession(workspaceId, candidate, this.deps.driver)
    if (session.id === candidate.id) {
      await this.notify(workspaceId, { sessionId: session.id, scope: 'session' })
      await this.wake(workspaceId, { kind: 'overview', sessionId: session.id, generation: 1 })
    }
    return session
  }

  /** Point the session at the PR's current head and regenerate the overview. Threads are kept. */
  async refresh(
    workspaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<GuidedReviewSession> {
    const session = await this.ownedSession(workspaceId, userId, sessionId)
    const context = await this.repoFor(workspaceId, session)
    const pr = await this.readPr(workspaceId, userId, context.repo, session.prNumber)
    const generation = session.overview.generation
    const moved = await this.deps.repository.restartOverview(
      workspaceId,
      sessionId,
      generation,
      { prTitle: pr.title, reviewedHeadSha: pr.headSha, baseRef: pr.baseRef },
      this.deps.driver,
      this.deps.clock.now(),
    )
    if (moved) {
      await this.notify(workspaceId, { sessionId, scope: 'session' })
      await this.wake(workspaceId, { kind: 'overview', sessionId, generation: generation + 1 })
    }
    return this.requireSession(workspaceId, sessionId)
  }

  listSessions(
    workspaceId: string,
    filter: GuidedReviewSessionFilter,
  ): Promise<GuidedReviewSession[]> {
    return this.deps.repository.listSessions(workspaceId, filter)
  }

  async getSession(workspaceId: string, sessionId: string): Promise<GuidedReviewSessionView> {
    const session = await this.requireSession(workspaceId, sessionId)
    const [threads, drafts] = await Promise.all([
      this.deps.repository.listThreads(workspaceId, sessionId),
      this.deps.repository.listDrafts(workspaceId, sessionId),
    ])
    return { session, threads, drafts }
  }

  async deleteSession(workspaceId: string, userId: string, sessionId: string): Promise<void> {
    await this.ownedSession(workspaceId, userId, sessionId)
    await this.deps.repository.deleteSession(workspaceId, sessionId)
    await this.notify(workspaceId, { sessionId, scope: 'deleted' })
  }

  /** Open a thread, asking its first question when one is given. */
  async openThread(
    workspaceId: string,
    userId: string,
    sessionId: string,
    input: { title?: string; question?: AskInput },
  ): Promise<GuidedReviewThreadView> {
    await this.ownedSession(workspaceId, userId, sessionId)
    const title =
      input.title?.trim() || (input.question ? threadTitleFrom(input.question.content) : '')
    const now = this.deps.clock.now()
    const thread: GuidedReviewThread = {
      id: this.deps.idGenerator.next('grt'),
      sessionId,
      title,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    }
    await this.deps.repository.createThread(workspaceId, thread)
    if (input.question) {
      await this.exchange(workspaceId, thread, 'answer', input.question)
    } else {
      await this.notify(workspaceId, { sessionId, scope: 'thread', threadId: thread.id })
    }
    return this.getThread(workspaceId, sessionId, thread.id)
  }

  async getThread(
    workspaceId: string,
    sessionId: string,
    threadId: string,
  ): Promise<GuidedReviewThreadView> {
    const thread = await this.requireThread(workspaceId, sessionId, threadId)
    const messages = await this.deps.repository.listMessages(workspaceId, threadId)
    return { thread, messages }
  }

  /** Ask a question in a thread. Refused as `thread_busy` while the thread awaits an answer. */
  async ask(
    workspaceId: string,
    userId: string,
    sessionId: string,
    threadId: string,
    input: AskInput,
  ): Promise<{ question: GuidedReviewMessage; placeholder: GuidedReviewMessage }> {
    const thread = await this.ownedThread(workspaceId, userId, sessionId, threadId)
    return this.exchange(workspaceId, thread, 'answer', input)
  }

  /** Ask the model to turn the thread's conclusions into comment drafts. */
  async requestDrafts(
    workspaceId: string,
    userId: string,
    sessionId: string,
    threadId: string,
    instructions: string,
  ): Promise<{ question: GuidedReviewMessage; placeholder: GuidedReviewMessage }> {
    const thread = await this.ownedThread(workspaceId, userId, sessionId, threadId)
    return this.exchange(workspaceId, thread, 'comment-drafts', { content: instructions })
  }

  /** Drive one job. Idempotent: an already-claimed or settled job is a no-op. */
  async runJob(workspaceId: string, job: GuidedReviewJob): Promise<void> {
    if (job.kind === 'overview') await this.runOverview(workspaceId, job.sessionId, job.generation)
    else await this.runMessage(workspaceId, job.messageId)
  }

  /**
   * Settle a job its driver has given up on (repeated repository faults) as failed, taking over
   * any claim, so the thread stops reading as busy. A settled job is left alone.
   */
  async abandonJob(workspaceId: string, job: GuidedReviewJob, detail: string): Promise<void> {
    const now = this.deps.clock.now()
    // A cutoff in the future takes over whatever claim the failed attempts left behind.
    const takeover = now + 1
    const failure: GuidedReviewFailure = { reason: 'generation_failed', detail }
    if (job.kind === 'overview') {
      const claimed = await this.deps.repository.claimOverview(
        workspaceId,
        job.sessionId,
        job.generation,
        takeover,
        now,
      )
      if (!claimed) return
      await this.deps.repository.settleOverview(
        workspaceId,
        job.sessionId,
        job.generation,
        { status: 'failed', failure, model: null },
        now,
      )
      await this.notify(workspaceId, { sessionId: job.sessionId, scope: 'session' })
      return
    }
    const message = await this.deps.repository.getMessage(workspaceId, job.messageId)
    if (!message) return
    if (!(await this.deps.repository.claimMessage(workspaceId, job.messageId, takeover, now))) {
      return
    }
    await this.deps.repository.settleMessage(
      workspaceId,
      job.messageId,
      { status: 'failed', failure, model: null },
      now,
    )
    await this.notify(workspaceId, {
      sessionId: message.sessionId,
      scope: 'thread',
      threadId: message.threadId,
    })
  }

  /** Re-wake this driver's jobs that no claim has settled within the lease. */
  async redriveStale(limit = 50): Promise<number> {
    const cutoff = this.deps.clock.now() - GUIDED_REVIEW_LEASE_MS
    const stale = await this.deps.repository.listStaleJobs(this.deps.driver, cutoff, limit)
    for (const job of stale) {
      const { workspaceId, ...rest } = job
      await this.wake(
        workspaceId,
        rest.kind === 'overview'
          ? { kind: 'overview', sessionId: rest.sessionId, generation: rest.generation }
          : { kind: 'message', messageId: rest.messageId },
      )
    }
    return stale.length
  }

  private async exchange(
    workspaceId: string,
    thread: GuidedReviewThread,
    kind: GuidedReviewMessageKind,
    input: AskInput,
  ): Promise<{ question: GuidedReviewMessage; placeholder: GuidedReviewMessage }> {
    const content = input.content.trim()
    if (kind === 'answer' && !content) {
      throw new ValidationError('A question cannot be empty', { reason: 'empty_question' })
    }
    const now = this.deps.clock.now()
    const depth = input.depth ?? 'inline'
    const base = {
      threadId: thread.id,
      sessionId: thread.sessionId,
      kind,
      depth,
      citations: [],
      failure: null,
      draftReport: null,
      model: null,
      createdAt: now,
      updatedAt: now,
    }
    const result = await this.deps.repository.appendExchange(
      workspaceId,
      { ...base, id: this.deps.idGenerator.next('grm'), role: 'user', content, status: 'complete' },
      {
        ...base,
        id: this.deps.idGenerator.next('grm'),
        role: 'assistant',
        content: '',
        status: 'pending',
      },
      this.deps.driver,
    )
    if (!result.ok) {
      throw new ConflictError('This thread is still waiting for its previous answer', 'thread_busy')
    }
    await this.notify(workspaceId, {
      sessionId: thread.sessionId,
      scope: 'thread',
      threadId: thread.id,
    })
    await this.wake(workspaceId, { kind: 'message', messageId: result.placeholder.id })
    return { question: result.question, placeholder: result.placeholder }
  }

  private async runOverview(
    workspaceId: string,
    sessionId: string,
    generation: number,
  ): Promise<void> {
    const now = this.deps.clock.now()
    const claimed = await this.deps.repository.claimOverview(
      workspaceId,
      sessionId,
      generation,
      now - GUIDED_REVIEW_LEASE_MS,
      now,
    )
    if (!claimed) return
    const session = await this.requireSession(workspaceId, sessionId)
    let outcome: Parameters<GuidedReviewRepository['settleOverview']>[3]
    try {
      const pr = await this.bindPr(workspaceId, session)
      const body = await this.asUser(workspaceId, session.createdBy, () =>
        pr.repo.getPullRequestBody ? pr.repo.getPullRequestBody(session.prNumber) : null,
      )
      const { inline, omitted } = partitionPatches(pr.files, OVERVIEW_INLINE_PATCH_CHARS)
      const { text, model } = await this.generate(workspaceId, session, 'overview', {
        system: GUIDED_REVIEW_OVERVIEW_SYSTEM_PROMPT,
        prompt: renderGuidedReviewOverviewPrompt({
          pr: pr.header,
          body: body?.trim() ? body : null,
          files: pr.files,
          inlinePatches: inline,
          omittedPatchPaths: omitted,
        }),
        tools: guidedReviewTools(new PrExplorer(pr.repo, this.target(session), pr.files)),
      })
      const content = coerceOverview(extractJson(text), () => this.deps.idGenerator.next('grq'))
      if (!content)
        throw new JobFailure({ reason: 'unreadable_reply', detail: excerpt(text) }, model)
      outcome = { status: 'complete', content, model }
    } catch (error) {
      outcome = { status: 'failed', ...this.failureOf(error, workspaceId, sessionId) }
    }
    const landed = await this.deps.repository.settleOverview(
      workspaceId,
      sessionId,
      generation,
      outcome,
      this.deps.clock.now(),
    )
    if (landed) await this.notify(workspaceId, { sessionId, scope: 'session' })
  }

  private async runMessage(workspaceId: string, messageId: string): Promise<void> {
    const message = await this.deps.repository.getMessage(workspaceId, messageId)
    if (!message || message.role !== 'assistant') return
    const now = this.deps.clock.now()
    const claimed = await this.deps.repository.claimMessage(
      workspaceId,
      messageId,
      now - GUIDED_REVIEW_LEASE_MS,
      now,
    )
    if (!claimed) return
    const [session, messages] = await Promise.all([
      this.requireSession(workspaceId, message.sessionId),
      this.deps.repository.listMessages(workspaceId, message.threadId),
    ])
    const settledAt = () => this.deps.clock.now()
    let landed = false
    let draftsLanded = false
    try {
      if (message.depth === 'deep') {
        throw new JobFailure({ reason: 'depth_unavailable', detail: null }, null)
      }
      const pr = await this.bindPr(workspaceId, session)
      const thread = threadHistory(
        messages.filter((m) => m.seq < message.seq),
        THREAD_HISTORY_CHARS,
      )
      const promptInput = { pr: pr.header, overview: session.overview.content, ...thread }
      const tools = guidedReviewTools(new PrExplorer(pr.repo, this.target(session), pr.files))
      if (message.kind === 'answer') {
        const { text, model } = await this.generate(workspaceId, session, 'answer', {
          system: GUIDED_REVIEW_ANSWER_SYSTEM_PROMPT,
          prompt: renderGuidedReviewAnswerPrompt(promptInput),
          tools,
        })
        const answer = coerceAnswer(extractJson(text))
        if (!answer)
          throw new JobFailure({ reason: 'unreadable_reply', detail: excerpt(text) }, model)
        landed = await this.deps.repository.settleMessage(
          workspaceId,
          messageId,
          { status: 'complete', ...answer, draftReport: null, model },
          settledAt(),
        )
      } else {
        draftsLanded = landed = await this.settleDraftJob(
          workspaceId,
          session,
          message,
          pr.files,
          promptInput,
          tools,
        )
      }
    } catch (error) {
      const { failure, model } = this.failureOf(error, workspaceId, session.id)
      landed = await this.deps.repository.settleMessage(
        workspaceId,
        messageId,
        { status: 'failed', failure, model },
        settledAt(),
      )
    }
    if (landed) {
      await this.notify(workspaceId, {
        sessionId: session.id,
        scope: 'thread',
        threadId: message.threadId,
      })
    }
    if (draftsLanded) await this.notify(workspaceId, { sessionId: session.id, scope: 'drafts' })
  }

  /** Produce a `comment-drafts` message's drafts and land them with it, atomically. */
  private async settleDraftJob(
    workspaceId: string,
    session: GuidedReviewSession,
    message: GuidedReviewMessage,
    files: GitHubChangedFile[],
    promptInput: Parameters<typeof renderGuidedReviewDraftsPrompt>[0],
    tools: ToolSet,
  ): Promise<boolean> {
    const { text, model } = await this.generate(workspaceId, session, 'drafts', {
      system: GUIDED_REVIEW_DRAFTS_SYSTEM_PROMPT,
      prompt: renderGuidedReviewDraftsPrompt(promptInput),
      tools,
    })
    const raw = extractJson(text)
    if (raw === null || typeof raw !== 'object') {
      throw new JobFailure({ reason: 'unreadable_reply', detail: excerpt(text) }, model)
    }
    const { proposals, incomplete } = coerceDraftProposals(raw)
    const { kept, report } = anchorDrafts(proposals, incomplete, files)
    const at = this.deps.clock.now()
    const drafts: GuidedReviewCommentDraft[] = kept.map((p) => ({
      id: this.deps.idGenerator.next('grd'),
      sessionId: session.id,
      threadId: message.threadId,
      messageId: message.id,
      ...p,
      status: 'proposed',
      postError: null,
      postedUrl: null,
      rev: 1,
      createdAt: at,
      updatedAt: at,
    }))
    return this.deps.repository.settleDrafts(
      workspaceId,
      message.id,
      drafts,
      { status: 'complete', content: '', citations: [], draftReport: report, model },
      at,
    )
  }

  /** Run one bounded tool loop under the session creator's model scope and budget. */
  private async generate(
    workspaceId: string,
    session: GuidedReviewSession,
    phase: keyof typeof GUIDED_REVIEW_MAX_STEPS,
    call: { system: string; prompt: string; tools: ToolSet },
  ): Promise<{ text: string; model: string }> {
    if (await this.deps.isOverBudget?.(workspaceId)) {
      throw new JobFailure({ reason: 'budget_exhausted', detail: null }, null)
    }
    const { modelProvider, ref } = await this.resolveModel(workspaceId, session.createdBy)
    const model = `${ref.provider}:${ref.model}`
    const maxSteps = GUIDED_REVIEW_MAX_STEPS[phase]
    try {
      const result = await generateText({
        model: modelProvider.resolve(ref),
        system: call.system,
        prompt: call.prompt,
        tools: call.tools,
        stopWhen: stepCountIs(maxSteps),
        // The last step may not call a tool, so a loop that reaches the cap still ends on a reply.
        prepareStep: ({ stepNumber }) =>
          stepNumber >= maxSteps - 1 ? { toolChoice: 'none' as const } : {},
        temperature: 0.2,
        maxOutputTokens: 8_000,
        providerOptions: catFactoryObservability({
          agentKind: GUIDED_REVIEW_AGENT_KIND,
          workspaceId,
        }),
      })
      const text = result.text.trim()
      if (!text) throw new JobFailure({ reason: 'unreadable_reply', detail: null }, model)
      return { text, model }
    } catch (error) {
      if (error instanceof JobFailure) throw error
      throw new JobFailure({ reason: 'generation_failed', detail: getErrorMessage(error) }, model)
    }
  }

  private async resolveModel(
    workspaceId: string,
    userId: string,
  ): Promise<{ modelProvider: ModelProvider; ref: ModelRef }> {
    const scope = await resolveInlineScope({ kind: 'user', workspaceId, userId })
    const modelProvider = await resolveScopedModelProvider(scope, this.deps)
    const ref = await resolveInlineBlockModelRef(
      this.deps,
      workspaceId,
      GUIDED_REVIEW_AGENT_KIND,
      {},
    )
    if (!modelProvider || !ref) {
      throw new JobFailure({ reason: 'model_unavailable', detail: null }, null)
    }
    return { modelProvider, ref }
  }

  /** The PR as reviewed: its changed files at the session's head, bound for reading. */
  private async bindPr(workspaceId: string, session: GuidedReviewSession): Promise<BoundPr> {
    let context
    try {
      context = await this.repoFor(workspaceId, session)
    } catch (error) {
      throw new JobFailure({ reason: 'repo_unavailable', detail: getErrorMessage(error) }, null)
    }
    const listChangedFiles = context.repo.listChangedFiles?.bind(context.repo)
    if (!listChangedFiles) {
      throw new JobFailure(
        { reason: 'repo_unavailable', detail: 'This VCS connection cannot list PR files' },
        null,
      )
    }
    let files: GitHubChangedFile[]
    try {
      files = await this.asUser(workspaceId, session.createdBy, () =>
        listChangedFiles(session.prNumber),
      )
    } catch (error) {
      throw new JobFailure({ reason: 'repo_unavailable', detail: getErrorMessage(error) }, null)
    }
    return {
      repo: context.repo,
      files,
      header: {
        owner: session.owner,
        repo: session.repo,
        prNumber: session.prNumber,
        title: session.prTitle,
        headSha: session.reviewedHeadSha,
        baseRef: session.baseRef,
      },
    }
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

  private async readPr(workspaceId: string, userId: string, repo: RepoFiles, prNumber: number) {
    const getPullRequest = repo.getPullRequest?.bind(repo)
    if (!getPullRequest || !repo.listChangedFiles) {
      throw new UnavailableError(
        'This source control connection cannot read pull requests',
        'vcs_pull_requests_unsupported',
      )
    }
    const pr = await this.asUser(workspaceId, userId, () => getPullRequest(prNumber))
    if (!pr || !pr.headSha || !pr.baseRef) {
      throw new NotFoundError('Pull request', String(prNumber), { reason: 'pr_not_found' })
    }
    return { title: pr.title, headSha: pr.headSha, baseRef: pr.baseRef }
  }

  /** Run a VCS call under `userId`'s credential scope (the initiator-PAT policy applies). */
  private asUser<T>(workspaceId: string, userId: string, fn: () => T): T {
    const scope = this.deps.runInitiatorScope
    return scope ? scope({ workspaceId, initiatedBy: userId }, fn) : fn()
  }

  private target(session: GuidedReviewSession) {
    return { headSha: session.reviewedHeadSha, baseRef: session.baseRef }
  }

  /** Map a job's failure to what is settled on its row; anything unexpected is logged once. */
  private failureOf(
    error: unknown,
    workspaceId: string,
    sessionId: string,
  ): { failure: GuidedReviewFailure; model: string | null } {
    if (error instanceof JobFailure) return { failure: error.failure, model: error.model }
    this.logger.warn('guided review job failed unexpectedly', {
      workspaceId,
      sessionId,
      err: getErrorMessage(error),
    })
    return { failure: { reason: 'generation_failed', detail: getErrorMessage(error) }, model: null }
  }

  private async wake(workspaceId: string, job: GuidedReviewJob): Promise<void> {
    const runner = this.deps.runner
    if (!runner) return
    // Best-effort: the row is already committed, and a lost wake is re-driven by the sweeper.
    await runBestEffort(this.logger, 'guidedReview.wake', () => runner.start(workspaceId, job), {
      workspaceId,
      job: job.kind,
    })
  }

  private async requireSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<GuidedReviewSession> {
    const session = await this.deps.repository.getSession(workspaceId, sessionId)
    if (!session) throw new NotFoundError('Guided review session', sessionId)
    return session
  }

  private async ownedSession(
    workspaceId: string,
    userId: string,
    sessionId: string,
  ): Promise<GuidedReviewSession> {
    const session = await this.requireSession(workspaceId, sessionId)
    if (session.createdBy !== userId) {
      throw new ForbiddenError('Only the reviewer who opened this guided review can change it', {
        reason: 'not_session_owner',
      })
    }
    return session
  }

  /** A thread of `sessionId`; one belonging to another session is reported as absent. */
  private async requireThread(
    workspaceId: string,
    sessionId: string,
    threadId: string,
  ): Promise<GuidedReviewThread> {
    const thread = await this.deps.repository.getThread(workspaceId, threadId)
    if (!thread || thread.sessionId !== sessionId) {
      throw new NotFoundError('Guided review thread', threadId)
    }
    return thread
  }

  private async ownedThread(
    workspaceId: string,
    userId: string,
    sessionId: string,
    threadId: string,
  ): Promise<GuidedReviewThread> {
    const thread = await this.requireThread(workspaceId, sessionId, threadId)
    await this.ownedSession(workspaceId, userId, sessionId)
    return thread
  }

  private async notify(workspaceId: string, change: GuidedReviewChange): Promise<void> {
    const events = this.deps.events
    if (!events?.guidedReviewChanged) return
    // Best-effort: the write is committed, and a client re-reads on reconnect.
    await runBestEffort(
      this.logger,
      'guidedReview.notify',
      () => events.guidedReviewChanged!(workspaceId, change),
      { workspaceId, sessionId: change.sessionId },
    )
  }
}

function excerpt(text: string): string | null {
  const trimmed = text.trim()
  return trimmed ? trimmed.slice(0, 2000) : null
}
