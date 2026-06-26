import type {
  AccountRepository,
  AgentRunContext,
  Block,
  BlockRepository,
  BrainstormSessionRepository,
  ClarityReviewRepository,
  CloudProvider,
  DocumentRecord,
  DocumentRepository,
  ExecutionInstance,
  PipelineStep,
  RequirementReviewRepository,
  TaskRecord,
  TaskRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { buildExcerpt, CONTEXT_BUDGET } from '@cat-factory/kernel'
import { CODE_AWARE_TRAIT, hasTrait } from '@cat-factory/agents'
import { getFragment } from '@cat-factory/prompt-fragments'
import { extractReferences } from '@cat-factory/integrations'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import { resolveTesterEnvironment, type TesterEnvironment } from './tester-infra.logic.js'

/**
 * The `revision` slice of an agent context when a step is being re-run with feedback
 * — either a human's "request changes" on its approval gate, or a downstream
 * companion's automatic rework (`step.rework`). The companion path wins when both are
 * present. Empty object when neither applies (no revision context).
 */
export function buildRevisionContext(step: PipelineStep): {
  revision?: {
    previousProposal: string
    feedback: string
    comments?: { quotedSource?: string; body: string }[]
  }
} {
  const source = step.rework
    ? {
        previousProposal: step.rework.previousProposal,
        feedback: step.rework.feedback,
        comments: step.rework.comments,
      }
    : step.approval?.status === 'changes_requested'
      ? {
          previousProposal: step.approval.proposal,
          feedback: step.approval.feedback ?? '',
          comments: step.approval.comments,
        }
      : undefined
  if (!source) return {}
  return {
    revision: {
      previousProposal: source.previousProposal,
      feedback: source.feedback,
      ...(source.comments?.length
        ? {
            comments: source.comments.map((c) => ({
              ...(c.quotedSource ? { quotedSource: c.quotedSource } : {}),
              body: c.body,
            })),
          }
        : {}),
    },
  }
}

/**
 * Resolves already-selected fragment ids to their bodies against the merged
 * tenant catalog, live-resolving any document-backed entries. Implemented by the
 * fragment-library service; wired only when the library is configured. Absent →
 * the builder falls back to the static `getFragment` pool (built-ins only).
 */
export interface FragmentBodyResolver {
  resolveBodiesForRun(workspaceId: string, ids: string[]): Promise<{ id: string; body: string }[]>
}

/** The collaborators the context builder reads from (all owned by the engine container). */
export interface AgentContextBuilderDeps {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  accountRepository: AccountRepository
  documents?: DocumentRepository
  tasks?: TaskRepository
  requirementReviews?: RequirementReviewRepository
  clarityReviews?: ClarityReviewRepository
  brainstormSessions?: BrainstormSessionRepository
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Optional: resolves fragment ids against the merged tenant catalog (managed +
   * document-backed entries). When wired the engine uses it instead of the static
   * pool, so curated and living-document fragments actually reach a run.
   */
  fragmentResolver?: FragmentBodyResolver
  /**
   * Optional: the deployment's default Tester environment when neither the task nor its
   * service frame pins one (the floor of {@link resolveTesterEnvironment}). Absent →
   * `ephemeral`. MUST match the resolver `ExecutionService` uses for its start-time infra
   * gate, so the materialised value the job runs with agrees with what the gate checked.
   */
  resolveTesterFallbackDefault?: (workspaceId: string) => Promise<TesterEnvironment>
}

/**
 * Assembles the {@link AgentRunContext} for a pipeline step from the run + block state:
 * the (possibly reworked) requirements, linked docs/tracker issues, the live environment,
 * the service-frame config, the best-practice fragments, prior step outputs, recorded
 * decisions and any revision feedback. Pure inputs → output (it only reads repositories),
 * extracted out of `ExecutionService` so the engine stays a thin state machine. Also the
 * single home for service-frame resolution (`resolveServiceFrameId`/`resolveServiceConfig`),
 * which a few other engine paths reuse.
 */
export class AgentContextBuilder {
  constructor(private readonly deps: AgentContextBuilderDeps) {}

  /** Assemble the {@link AgentRunContext} for a step from the run + block state. */
  async buildContext(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
  ): Promise<AgentRunContext> {
    // When a block's requirements have been reworked, that standardized document is
    // the single source of truth for every agent step: it already folds in the
    // description plus the linked docs / tracker issues, so it REPLACES the
    // description and the (now-redundant) doc/task context. Reviews are only ever run
    // on task blocks, so skip the lookup entirely for frames/modules — that keeps the
    // extra read off every container/frame step rather than on the whole hot path.
    // A converged clarity (bug-report triage) report substitutes downstream exactly like a
    // reworked requirements doc. When both exist on one task the requirements doc — which
    // runs after clarity and is the more refined artifact — takes precedence.
    const reworked =
      block.level === 'task'
        ? ((await this.resolveReworkedRequirements(workspaceId, block.id)) ??
          (await this.resolveClarifiedBrief(workspaceId, block.id)))
        : null
    const description = reworked ?? block.description
    // High-confidence external context = the docs/tasks a human attached to the block
    // (skipped when `reworked`, since the incorporated doc already folds them in) UNION
    // any items the effective description names explicitly (a Jira key, a URL), resolved
    // against the already-imported corpus. Explicitly-named refs are included even in
    // reworked mode — the human may name an issue in the doc that was never attached.
    const { docs: contextDocs, tasks: contextTasks } = await this.resolveLinkedContext(
      workspaceId,
      block.id,
      description,
      { includeLinked: !reworked },
    )
    const environment = await this.resolveEnvironment(workspaceId, block.id)
    const service = await this.resolveServiceConfig(workspaceId, block)
    // A task inherits its service frame's default test environment unless it pins its
    // own `tester.environment`. Materialise the resolved choice onto the run's
    // agentConfig so the Tester job body, the prompt fragment and the start-time infra
    // gate all read the same value — the stored block is left untouched (the per-task
    // override stays explicit).
    // Resolve the effective environment (task pin > service default > deployment fallback)
    // and materialise it when the task hasn't pinned its own, so the Tester job body, the
    // prompt fragment and the start-time infra gate all read the SAME value. The fallback
    // (local mode: `local` by default, `ephemeral` when delegating to a provider) is the
    // same resolver the gate uses, so the run can't disagree with what was checked at start.
    const agentConfig = block.agentConfig?.['tester.environment']
      ? block.agentConfig
      : {
          ...block.agentConfig,
          'tester.environment': resolveTesterEnvironment(
            undefined,
            service?.defaultTestEnvironment,
            await this.deps.resolveTesterFallbackDefault?.(workspaceId),
          ),
        }
    // A finalized architecture-brainstorm direction is surfaced ADDITIVELY (it does not
    // replace the description) as a synthetic prior output so the architect and downstream
    // agents read it as context — the brainstorm session's converged direction feeding the
    // next stage's prompt (reviews are task-scoped, so frames/modules skip the lookup).
    const architectureDirection =
      block.level === 'task' ? await this.resolveBrainstormDirection(workspaceId, block.id) : null
    const priorOutputs = [
      ...(architectureDirection
        ? [{ agentKind: 'architecture-brainstorm', output: architectureDirection }]
        : []),
      ...instance.steps
        .slice(0, instance.currentStep)
        .filter((s) => s.output)
        .map((s) => ({ agentKind: s.agentKind, output: s.output! })),
    ]
    // Resolve the best-practice fragments to inject for this step. `code-aware` kinds
    // get the running service's selected fragments unioned with the block's own pins;
    // other kinds keep only their block pins. Recorded on the step for observability.
    const resolved = await this.resolveFragments(workspaceId, step, block)
    return {
      agentKind: step.agentKind,
      pipelineName: instance.pipelineName,
      workspaceId,
      executionId: instance.id,
      // Carry the run initiator so the container executor can lease their OWN personal
      // (individual-usage) subscription for the step. Null on system/dev runs.
      ...(instance.initiatedBy != null ? { initiatedByUserId: instance.initiatedBy } : {}),
      stepIndex: instance.currentStep,
      isFinalStep,
      // The future-looking Follow-up companion is enabled for this (coder) step: the
      // container executor appends the follow-up guidance + sets the harness to stream items.
      ...(step.followUps?.enabled ? { followUpCompanion: true } : {}),
      // Consensus config for this step (copied onto the step at run start). Read only
      // by the optional consensus executor, which decides — possibly gated on the
      // block estimate below — whether to run the multi-model process. Absent ⇒ standard.
      ...(step.consensus ? { consensus: step.consensus } : {}),
      block: {
        id: block.id,
        title: block.title,
        type: block.type,
        description,
        fragmentIds: block.fragmentIds,
        ...(resolved ? { resolvedFragments: resolved.fragments } : {}),
        // The resolved technical label, threaded whenever a concrete determination exists
        // (true ⇒ task definition is primary + spec-writer may skip specs; false ⇒ explicit
        // business, spec-writer must produce specs). Omitted only when unset, so an
        // undetermined task keeps the unchanged spec-led behaviour.
        ...(typeof block.technical === 'boolean' ? { technical: block.technical } : {}),
        modelId: block.modelId,
        ...(block.modelPresetId ? { modelPresetId: block.modelPresetId } : {}),
        ...(agentConfig ? { agentConfig } : {}),
        ...(block.pullRequest ? { pullRequest: block.pullRequest } : {}),
        ...(contextDocs.length ? { contextDocs } : {}),
        ...(contextTasks.length ? { contextTasks } : {}),
        // The task-estimator's triage, when produced earlier in this run — the
        // consensus executor's gating input.
        ...(block.estimate ? { estimate: block.estimate } : {}),
      },
      ...(environment ? { environment } : {}),
      ...(service ? { service } : {}),
      priorOutputs,
      decisions: instance.steps
        .filter((s, i) => i < instance.currentStep && s.decision?.chosen)
        .map((s) => ({ question: s.decision!.question, chosen: s.decision!.chosen! })),
      resolvedDecision: step.decision?.chosen
        ? { question: step.decision.question, chosen: step.decision.chosen }
        : null,
      // A re-run triggered either by a human "Request changes" on this step's
      // approval gate OR by a downstream companion looping it back for rework: hand
      // the agent its previous proposal plus the feedback so it revises rather than
      // starting over. The companion's automatic rework (`step.rework`) and the
      // human's gate feedback share one revision shape; the companion path takes
      // precedence when both are present.
      ...buildRevisionContext(step),
    }
  }

  /** The service-frame id for a block (walks up frame → module → task; cycle-guarded). */
  async resolveServiceFrameId(workspaceId: string, blockId: string): Promise<string | null> {
    let current = await this.deps.blockRepository.get(workspaceId, blockId)
    // Bounded walk (the tree is at most frame → module → task) guarded against cycles.
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.id
      current = await this.deps.blockRepository.get(workspaceId, current.parentId)
    }
    return current?.id ?? null
  }

  /**
   * Resolve the service-level (frame) configuration for a run's block — the
   * Tester's local-infra docker-compose path / "no infra" flag and the provisioning
   * provider + instance size — by walking up to the service frame. When the frame
   * pins no cloud provider it inherits the owning account's `defaultCloudProvider`
   * (so the account-level default actually reaches dispatch, not just the UI).
   * Returns undefined when no frame carries any of these settings, so callers can
   * spread it conditionally onto the agent context.
   */
  async resolveServiceConfig(
    workspaceId: string,
    block: Block,
  ): Promise<AgentRunContext['service'] | undefined> {
    const frame =
      block.level === 'frame'
        ? block
        : await this.resolveServiceFrameId(workspaceId, block.id).then((id) =>
            id ? this.deps.blockRepository.get(workspaceId, id) : null,
          )
    if (!frame) return undefined
    const service: NonNullable<AgentRunContext['service']> = {}
    if (frame.testComposePath) service.testComposePath = frame.testComposePath
    if (frame.noInfraDependencies) service.noInfraDependencies = frame.noInfraDependencies
    if (frame.defaultTestEnvironment) service.defaultTestEnvironment = frame.defaultTestEnvironment
    if (frame.cloudProvider) service.cloudProvider = frame.cloudProvider
    else {
      // No per-service override: fall back to the owning account's default provider
      // so a pool/local deployment honours the account-level choice at dispatch.
      const accountDefault = await this.resolveAccountDefaultProvider(workspaceId)
      if (accountDefault) service.cloudProvider = accountDefault
    }
    if (frame.instanceSize) service.instanceSize = frame.instanceSize
    return Object.keys(service).length ? service : undefined
  }

  /**
   * The owning account's `defaultCloudProvider`, or undefined when the workspace
   * has no account or the account pins no default (so the transport keeps its own).
   */
  private async resolveAccountDefaultProvider(
    workspaceId: string,
  ): Promise<CloudProvider | undefined> {
    const workspace = await this.deps.workspaceRepository.get(workspaceId)
    if (!workspace?.accountId) return undefined
    const account = await this.deps.accountRepository.get(workspace.accountId)
    return account?.defaultCloudProvider
  }

  /**
   * The reworked ("incorporated") requirements for a block — the standard-format
   * document the requirements-rework step produced — or `null` when the feature is
   * unwired or the block has no incorporated review yet. Used both to substitute the
   * agent context for every step and to feed the spec-writer.
   */
  private async resolveReworkedRequirements(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    if (!this.deps.requirementReviews) return null
    const review = await this.deps.requirementReviews.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.incorporatedRequirements) {
      return review.incorporatedRequirements
    }
    return null
  }

  /**
   * The clarified bug report for a block — the standard-format document the clarity-rework
   * step produced — or `null` when the feature is unwired or the block has no incorporated
   * clarity review yet. The clarity mirror of {@link resolveReworkedRequirements}.
   */
  private async resolveClarifiedBrief(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    if (!this.deps.clarityReviews) return null
    const review = await this.deps.clarityReviews.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.clarifiedReport) {
      return review.clarifiedReport
    }
    return null
  }

  /**
   * The converged architecture direction for a block — the document the
   * `architecture-brainstorm` dialogue settled on — or `null` when the feature is unwired or
   * the block has no settled architecture session. Surfaced additively as a prior output (it
   * augments, never replaces, the description), the brainstorm analogue of
   * {@link resolveReworkedRequirements}.
   */
  private async resolveBrainstormDirection(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    if (!this.deps.brainstormSessions) return null
    const session = await this.deps.brainstormSessions.getByBlockStage(
      workspaceId,
      blockId,
      'architecture',
    )
    if (session?.status === 'incorporated' && session.convergedDirection) {
      return session.convergedDirection
    }
    return null
  }

  /**
   * Resolve the best-practice fragments to fold into a step's system prompt. Service
   * fragments reach an agent ONLY when its kind carries the `code-aware` trait: those
   * kinds get the running SERVICE's selected fragments (the frame's
   * `serviceFragmentIds`, seeded from the workspace default and editable per service)
   * unioned with the block's own manual pins, resolved against the universal pool. A
   * non-code-aware kind returns null so `composeBlockSystemPrompt` falls back to the
   * block's own `fragmentIds` unchanged. Records the selected ids on the step for
   * observability; never throws (a lookup failure degrades to the block pins).
   */
  private async resolveFragments(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
  ): Promise<{ fragments: { id: string; body: string }[] } | null> {
    if (!hasTrait(step.agentKind, CODE_AWARE_TRAIT)) return null
    try {
      const serviceIds = await this.resolveServiceFragmentIds(workspaceId, block)
      // Service standards first, then the block's own pins; deduped, stable order.
      const ids: string[] = []
      const seen = new Set<string>()
      for (const id of [...serviceIds, ...(block.fragmentIds ?? [])]) {
        if (seen.has(id)) continue
        seen.add(id)
        ids.push(id)
      }
      // Prefer the tenant-catalog resolver (managed + live document-backed
      // fragments) when wired; otherwise resolve against the static built-in pool.
      const fragments = this.deps.fragmentResolver
        ? await this.deps.fragmentResolver.resolveBodiesForRun(workspaceId, ids)
        : ids
            .map((id) => {
              const fragment = getFragment(id)
              return fragment ? { id, body: fragment.body } : null
            })
            .filter((f): f is { id: string; body: string } => f !== null)
      if (fragments.length === 0) return null
      step.selectedFragmentIds = fragments.map((f) => f.id)
      return { fragments }
    } catch {
      // Resolution must never wedge a run; fall back to the block's own pins.
      return null
    }
  }

  /**
   * The selected best-practice fragment ids of the block's owning service frame. Walks
   * up from the block we already hold (bounded: frame → module → task, cycle-guarded),
   * reading the frame's `serviceFragmentIds` — without re-fetching the block in hand or
   * fetching the frame twice.
   */
  private async resolveServiceFragmentIds(workspaceId: string, block: Block): Promise<string[]> {
    let current: Block | null = block
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.serviceFragmentIds ?? []
      current = await this.deps.blockRepository.get(workspaceId, current.parentId)
    }
    return []
  }

  /**
   * Resolve the high-confidence external context for a block: the docs/tasks a human
   * attached to it (only when `includeLinked` — skipped in reworked mode, where the
   * incorporated requirements doc already folds them in) UNIONed with any items the
   * `description` names explicitly (a Jira key, a fully-qualified GitHub `owner/repo#N`,
   * or a URL), each resolved against the imported corpus by a POINT LOOKUP (no
   * full-corpus scan — a single keyed/URL query per named reference). Each source repo
   * is optional, so this is a no-op for sources that aren't wired. Deduped by
   * (source, externalId). The full body travels to the container as a materialised
   * file; the prompt carries only the one-line `summary` (see the executor +
   * `linkedContextSection`).
   */
  private async resolveLinkedContext(
    workspaceId: string,
    blockId: string,
    description: string,
    opts: { includeLinked: boolean },
  ): Promise<{
    docs: NonNullable<AgentRunContext['block']['contextDocs']>
    tasks: NonNullable<AgentRunContext['block']['contextTasks']>
  }> {
    const docs = new Map<string, DocumentRecord>()
    const tasks = new Map<string, TaskRecord>()
    const docKey = (d: DocumentRecord) => `${d.source}:${d.externalId}`
    const taskKey = (t: TaskRecord) => `${t.source}:${t.externalId}`
    const addDoc = (d: DocumentRecord | null) => {
      if (d && !docs.has(docKey(d))) docs.set(docKey(d), d)
    }
    const addTask = (t: TaskRecord | null) => {
      if (t && !tasks.has(taskKey(t))) tasks.set(taskKey(t), t)
    }

    if (opts.includeLinked) {
      if (this.deps.documents)
        for (const d of await this.deps.documents.listByBlock(workspaceId, blockId)) addDoc(d)
      if (this.deps.tasks)
        for (const t of await this.deps.tasks.listByBlock(workspaceId, blockId)) addTask(t)
    }

    // Resolve explicitly-named references against the imported corpus by a POINT LOOKUP
    // per reference — never a full-corpus scan. Only items that actually exist are added
    // (a `UTF-8` that happens to match the Jira-key shape just resolves to nothing);
    // nothing is fetched live.
    const refs = extractReferences(description ?? '')
    if (this.deps.tasks) {
      for (const key of refs.jiraKeys) addTask(await this.deps.tasks.get(workspaceId, 'jira', key))
      for (const ref of refs.githubRefs)
        addTask(await this.deps.tasks.get(workspaceId, 'github', ref))
    }
    for (const url of refs.urls) {
      if (this.deps.documents) addDoc(await this.deps.documents.getByUrl(workspaceId, url))
      if (this.deps.tasks) addTask(await this.deps.tasks.getByUrl(workspaceId, url))
    }

    return {
      docs: [...docs.values()].map((d) => toContextDoc(d)),
      tasks: [...tasks.values()].map((t) => toContextTask(t)),
    }
  }

  /**
   * Resolve the live ephemeral environment provisioned for the running block
   * into compact agent context. A no-op unless the environment integration is
   * wired (the provisioning service is an optional dependency), so the engine
   * stays unchanged when it is off.
   */
  private async resolveEnvironment(workspaceId: string, blockId: string) {
    if (!this.deps.environmentProvisioning) return null
    return this.deps.environmentProvisioning.resolveForBlock(workspaceId, blockId)
  }
}

/** Map a document record to the agent-context doc shape (summary index + materialisable body). */
function toContextDoc(
  d: DocumentRecord,
): NonNullable<AgentRunContext['block']['contextDocs']>[number] {
  return {
    title: d.title,
    url: d.url,
    excerpt: d.excerpt,
    summary: buildExcerpt(d.body || d.excerpt, CONTEXT_BUDGET.summaryChars),
    body: d.body,
  }
}

/** Map a task record to the agent-context task shape (adds the index `summary`). */
function toContextTask(
  t: TaskRecord,
): NonNullable<AgentRunContext['block']['contextTasks']>[number] {
  return {
    key: t.externalId,
    url: t.url,
    title: t.title,
    status: t.status,
    type: t.type,
    assignee: t.assignee,
    priority: t.priority,
    labels: t.labels,
    description: t.description,
    comments: t.comments,
    summary: buildExcerpt(t.description || t.title, CONTEXT_BUDGET.summaryChars),
  }
}
