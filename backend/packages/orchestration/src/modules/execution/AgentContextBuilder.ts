import type {
  AccountRepository,
  AgentRunContext,
  Block,
  BlockRepository,
  ClarityReviewRepository,
  CloudProvider,
  DocumentRepository,
  ExecutionInstance,
  PipelineStep,
  RequirementReviewRepository,
  TaskRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { CODE_AWARE_TRAIT, hasTrait } from '@cat-factory/agents'
import { getFragment } from '@cat-factory/prompt-fragments'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'

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

/** The collaborators the context builder reads from (all owned by the engine container). */
export interface AgentContextBuilderDeps {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  accountRepository: AccountRepository
  documents?: DocumentRepository
  tasks?: TaskRepository
  requirementReviews?: RequirementReviewRepository
  clarityReviews?: ClarityReviewRepository
  environmentProvisioning?: EnvironmentProvisioningService
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
    const contextDocs = reworked ? [] : await this.resolveContextDocs(workspaceId, block.id)
    const contextTasks = reworked ? [] : await this.resolveContextTasks(workspaceId, block.id)
    const environment = await this.resolveEnvironment(workspaceId, block.id)
    const service = await this.resolveServiceConfig(workspaceId, block)
    const priorOutputs = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.output)
      .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
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
        modelId: block.modelId,
        ...(block.agentConfig ? { agentConfig: block.agentConfig } : {}),
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
      const fragments = ids
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
   * Resolve documents (from any source) linked to the running block into compact
   * agent context. A no-op unless the document-source integration is wired (the
   * repository is an optional dependency), so the engine stays unchanged when it
   * is off.
   */
  private async resolveContextDocs(
    workspaceId: string,
    blockId: string,
  ): Promise<{ title: string; url: string; excerpt: string }[]> {
    if (!this.deps.documents) return []
    const docs = await this.deps.documents.listByBlock(workspaceId, blockId)
    return docs.map((d) => ({ title: d.title, url: d.url, excerpt: d.excerpt }))
  }

  /**
   * Resolve tracker issues (from any source) linked to the running block into
   * structured agent context. A no-op unless the task-source integration is
   * wired (the repository is an optional dependency), so the engine stays
   * unchanged when it is off.
   */
  private async resolveContextTasks(workspaceId: string, blockId: string) {
    if (!this.deps.tasks) return []
    const tasks = await this.deps.tasks.listByBlock(workspaceId, blockId)
    return tasks.map((t) => ({
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
    }))
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
