import type {
  AccountRepository,
  AgentRunContext,
  Block,
  BlockRepository,
  BrainstormSessionRepository,
  ClarityReviewRepository,
  CloudProvider,
  DocInterviewRepository,
  DocKind,
  DocumentRecord,
  DocumentRepository,
  DocumentSourceKind,
  ExecutionInstance,
  FrontendConfig,
  InitiativeRepository,
  PipelineStep,
  RequirementReviewRepository,
  TaskRecord,
  TaskRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { buildExcerpt, CONTEXT_BUDGET } from '@cat-factory/kernel'
import {
  CODE_AWARE_TRAIT,
  DOC_AWARE_TRAIT,
  DOC_FINALIZER_KIND,
  DOC_WRITER_KIND,
  hasTrait,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  boundServiceFrameIds,
  buildFrontendRunNotes,
  indexLiveServiceEnvUrls,
  resolveFrontendBindings,
  type ResolvedFrontendBinding,
} from './frontend-infra.logic.js'
import { connectionDescription } from '@cat-factory/contracts'
import { frameOf, validInvolvedServiceFrames } from './frame.logic.js'
import { getFragment } from '@cat-factory/prompt-fragments'
import { extractReferences } from '@cat-factory/integrations'
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

/**
 * The step's per-round dispatch epoch (see {@link AgentRunContext.dispatchEpoch}). A
 * looping step carries its round count on its own gate state: the Tester→Fixer loop on
 * `step.test.attempts` (incremented per fixer round) and a polling gate's helper loop on
 * `step.gate.attempts` (incremented per helper dispatch). Either uniquely tags each
 * re-dispatch, so the harness job id changes round to round and a re-test never re-attaches
 * to a prior round's completed job. A step with neither (dispatched once) is epoch 0.
 */
export function dispatchEpochFor(step: PipelineStep): number {
  return step.test?.attempts ?? step.gate?.attempts ?? 0
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

/**
 * Resolve a URL named in prose to the document it refers to, by its stable
 * `(source, externalId)` key. Built from the document providers' `parseRef` so a noisy
 * pasted link (title segment, `&t=` tracking params, dash vs colon node id) still maps to
 * the canonical id the document was imported under. Returns null when no provider claims
 * the URL.
 */
export type DocumentUrlResolver = (
  url: string,
) => { source: DocumentSourceKind; externalId: string } | null

/** The collaborators the context builder reads from (all owned by the engine container). */
export interface AgentContextBuilderDeps {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  accountRepository: AccountRepository
  /** App-owned agent-kind registry: drives the `code-aware` fragment-folding decision. */
  agentKindRegistry: AgentKindRegistry
  documents?: DocumentRepository
  /**
   * Optional: canonicalise a URL named in a block's description to the (source,
   * externalId) of the document it refers to, by delegating to the document providers'
   * `parseRef`. Lets a pasted Figma/Notion/etc. link match the already-imported doc by its
   * STABLE external id instead of by exact URL-string equality — which silently fails when
   * the canonical stored `url` omits the title path segment / tracking query params a real
   * pasted link carries (the Figma auto-match trap). Absent → the url-string `getByUrl`
   * lookup is used alone.
   */
  documentUrlResolver?: DocumentUrlResolver
  tasks?: TaskRepository
  requirementReviews?: RequirementReviewRepository
  /**
   * Optional: the interactive document-interview session store (WS5). When wired, a
   * doc-authoring run folds the block's converged authoring brief into the writer's context.
   * Absent → the writer runs off the raw outline/description.
   */
  docInterviews?: DocInterviewRepository
  clarityReviews?: ClarityReviewRepository
  brainstormSessions?: BrainstormSessionRepository
  /**
   * Optional: the initiative store. When wired, an `initiative`-level run's context carries the
   * planning entity (the interviewer's synthesized goal/constraints + Q&A digest and the
   * analyst's codebase analysis), so the analyst and planner prompts are grounded in the prior
   * steps' findings. Absent → the initiative steps run off the raw block description alone.
   */
  initiatives?: InitiativeRepository
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Optional: resolves fragment ids against the merged tenant catalog (managed +
   * document-backed entries). When wired the engine uses it instead of the static
   * pool, so curated and living-document fragments actually reach a run.
   */
  fragmentResolver?: FragmentBodyResolver
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

  /**
   * Assemble the {@link AgentRunContext} for a step from the run + block state.
   *
   * `options.agentKind` overrides the step's own kind as the kind that will actually
   * RUN — a gate step dispatches its helper (`ci` → `ci-fixer`, `post-release-health` →
   * `on-call`) and the Tester loop its `fixer` off the HOSTING step, whose kind is the
   * gate/tester, not the helper. Trait-driven context (the `code-aware` fragment fold)
   * must key off the helper's kind, else a code-aware helper never receives the
   * service's standards.
   */
  async buildContext(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
    options?: { agentKind?: string },
  ): Promise<AgentRunContext> {
    const agentKind = options?.agentKind ?? step.agentKind
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
    const environment = await this.resolveEnvironment(workspaceId, block)
    const service = await this.resolveServiceConfig(workspaceId, block)
    const frontend = await this.resolveFrontendConfig(workspaceId, block)
    const involvedServices = await this.resolveInvolvedServices(workspaceId, block)
    // An initiative-level run (the planning pipeline) carries the interview + analysis
    // context so the analyst/planner prompts fold in the human's intent and prior findings.
    const initiative = await this.resolveInitiativeContext(workspaceId, block)
    const agentConfig = block.agentConfig
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
    const resolved = await this.resolveFragments(workspaceId, agentKind, step, block)
    // For a document-authoring (doc-aware) kind, resolve the workspace's linked TEMPLATE +
    // EXEMPLAR documents for the task's docKind (WS1 items 2–4). The template body overrides the
    // built-in skeleton in the prompt (and the gate resolves the same override server-side); the
    // exemplars are surfaced as good examples to emulate.
    const docAuthoring = await this.resolveDocAuthoringContext(workspaceId, agentKind, block)
    return {
      agentKind,
      pipelineName: instance.pipelineName,
      workspaceId,
      executionId: instance.id,
      // Carry the run initiator so the container executor can lease their OWN personal
      // (individual-usage) subscription for the step. Null on system/dev runs.
      ...(instance.initiatedBy != null ? { initiatedByUserId: instance.initiatedBy } : {}),
      stepIndex: instance.currentStep,
      // Per-step dispatch epoch (see AgentRunContext.dispatchEpoch): the count of fixer/helper
      // rounds this step has been through, so a re-dispatched job (the Tester re-test after a
      // fixer round, a gate's helper retry) gets a FRESH harness job id and runs anew rather
      // than re-attaching to its prior round's completed job on a container-reusing transport.
      // Both counters increment once per round, so they uniquely tag each re-dispatch; a step
      // dispatched once has neither and stays at epoch 0 (unsuffixed id, unchanged behaviour).
      ...(dispatchEpochFor(step) > 0 ? { dispatchEpoch: dispatchEpochFor(step) } : {}),
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
        // Per-type creation fields (a `document` task's docKind/audience/targetPath/…),
        // so a kind's user-prompt builder can specialise on them — the document-authoring
        // agents read these. Sparse; omitted when none were collected.
        ...(block.taskTypeFields ? { taskTypeFields: block.taskTypeFields } : {}),
        // Workspace-linked template / exemplar documents for a doc-authoring kind (WS1). Omitted
        // when nothing is linked (the prompts then fall back to the built-in skeleton / built-in
        // exemplars) or the kind isn't doc-aware.
        ...(docAuthoring.docTemplateBody ? { docTemplateBody: docAuthoring.docTemplateBody } : {}),
        ...(docAuthoring.docExemplars?.length ? { docExemplars: docAuthoring.docExemplars } : {}),
        // The converged interactive-interview authoring brief (WS5), when the interview ran and
        // synthesized one — the doc-writer folds it in as the refined spec to write from.
        ...(docAuthoring.docInterviewBrief
          ? { docInterviewBrief: docAuthoring.docInterviewBrief }
          : {}),
      },
      ...(environment ? { environment } : {}),
      ...(service ? { service } : {}),
      ...(frontend ? { frontend } : {}),
      ...(involvedServices?.length ? { involvedServices } : {}),
      ...(initiative ? { initiative } : {}),
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

  /**
   * The planning context for an `initiative`-level run: the interviewer's synthesized
   * goal / constraints / non-goals + the answered Q&A digest, and the analyst's codebase
   * analysis. Returns undefined for non-initiative blocks, when no initiative store is wired,
   * or when the block has no initiative entity yet.
   */
  private async resolveInitiativeContext(
    workspaceId: string,
    block: Block,
  ): Promise<AgentRunContext['initiative']> {
    if (block.level !== 'initiative' || !this.deps.initiatives) return undefined
    const initiative = await this.deps.initiatives.getByBlock(workspaceId, block.id)
    if (!initiative) return undefined
    const qa = (initiative.qa ?? [])
      .filter((q) => q.answer?.trim())
      .map((q) => ({ question: q.question, answer: q.answer }))
    return {
      ...(initiative.goal ? { goal: initiative.goal } : {}),
      ...(initiative.constraints?.length ? { constraints: initiative.constraints } : {}),
      ...(initiative.nonGoals?.length ? { nonGoals: initiative.nonGoals } : {}),
      ...(qa.length ? { qa } : {}),
      ...(initiative.analysisSummary ? { analysisSummary: initiative.analysisSummary } : {}),
    }
  }

  /** The service-frame id for a block (walks up frame → module → task; cycle-guarded). */
  async resolveServiceFrameId(workspaceId: string, blockId: string): Promise<string | null> {
    return (await this.resolveServiceFrame(workspaceId, blockId))?.id ?? null
  }

  /**
   * The service-frame BLOCK for a block (walks up frame → module → task; cycle-guarded).
   * Returns the frame itself rather than its id, so a caller that needs the frame's fields
   * (e.g. `frontendConfig`) doesn't re-fetch the row the walk already loaded.
   */
  async resolveServiceFrame(workspaceId: string, blockId: string): Promise<Block | null> {
    let current = await this.deps.blockRepository.get(workspaceId, blockId)
    // Bounded walk (the tree is at most frame → module → task) guarded against cycles.
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current
      current = await this.deps.blockRepository.get(workspaceId, current.parentId)
    }
    return current ?? null
  }

  /**
   * Resolve the service-level (frame) configuration for a run's block — the service-owned
   * `provisioning` (the "what + where" the Tester's infra stand-up + the deployer read) and
   * the cloud provider + instance size — by walking up to the service frame. When the frame
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
    if (frame.provisioning) service.provisioning = frame.provisioning
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
   * Resolve the frontend-frame configuration for a run's block — the frame's
   * `frontendConfig` (build/serve/mock knobs) plus its backend bindings ALREADY resolved to
   * concrete upstreams — by walking up to the service frame. Only a `type: 'frontend'` frame
   * that carries a `frontendConfig` yields a result; every other frame returns undefined so
   * the context stays unchanged for backend services. Each `service` binding whose bound
   * service has a LIVE ephemeral env (status `ready` + a URL) becomes the service under test
   * (its real URL); every other upstream is left for the harness to mock. The live env URLs
   * are read ONCE via {@link EnvironmentProvisioningService.listHandles} and indexed by the
   * service-frame id (no per-binding point read), so this is a single query regardless of
   * binding count.
   */
  async resolveFrontendConfig(
    workspaceId: string,
    block: Block,
  ): Promise<AgentRunContext['frontend'] | undefined> {
    const resolution = await this.resolveFrontendResolution(workspaceId, block)
    if (!resolution) return undefined
    const { config, liveServiceEnvUrls } = resolution
    return { config, bindings: resolveFrontendBindings(config, liveServiceEnvUrls) }
  }

  /**
   * The run-start binding snapshot + soft notes for a frontend UI-test / preview run: the
   * resolved bindings (env-var → live URL | mocked) plus the non-fatal advisories
   * ({@link buildFrontendRunNotes}). Shares the SAME single-read resolution as
   * {@link resolveFrontendConfig}. The engine stamps BOTH results on the run (`frontendBindings`
   * + `notes`) at start, so the SPA's run/step detail projects the frozen start-time resolution
   * with no extra live-env read at view time (and it stays truthful after the envs are torn down).
   * Returns undefined for a non-frontend frame (nothing to project), exactly like
   * {@link resolveFrontendConfig}.
   */
  async resolveFrontendRunInfo(
    workspaceId: string,
    block: Block,
  ): Promise<{ bindings: ResolvedFrontendBinding[]; notes: string[] } | undefined> {
    const resolution = await this.resolveFrontendResolution(workspaceId, block)
    if (!resolution) return undefined
    const { config, liveServiceEnvUrls } = resolution
    return {
      bindings: resolveFrontendBindings(config, liveServiceEnvUrls),
      notes: buildFrontendRunNotes(config, liveServiceEnvUrls),
    }
  }

  /**
   * Resolve a frontend frame's config plus the live env URLs of the services it binds — the one
   * IO step ({@link EnvironmentProvisioningService.listHandles}) shared by both the agent-context
   * resolution and the run-info projection. Only a `type: 'frontend'` frame carrying a
   * `frontendConfig` yields a result; every other frame returns undefined. The live env URLs are
   * read ONCE and indexed by the service-frame id (no per-binding point read), so this is a single
   * query regardless of binding count.
   */
  private async resolveFrontendResolution(
    workspaceId: string,
    block: Block,
  ): Promise<{ config: FrontendConfig; liveServiceEnvUrls: Map<string, string> } | undefined> {
    const frame =
      block.level === 'frame' ? block : await this.resolveServiceFrame(workspaceId, block.id)
    if (!frame || frame.type !== 'frontend' || !frame.frontendConfig) return undefined
    const config = frame.frontendConfig
    // The distinct service FRAMES this frontend binds — the only envs whose live URLs matter.
    const serviceFrameIds = boundServiceFrameIds(config)
    // One list read, then index the ready-with-URL handles for the bound services — never a
    // per-binding `getByBlock` loop (the N+1 the "reuse an already-fetched list" rule bans). The
    // frame-keyed newest-wins indexing is shared with the preview job builder (see the helper).
    const liveServiceEnvUrls =
      this.deps.environmentProvisioning && serviceFrameIds.size > 0
        ? indexLiveServiceEnvUrls(
            await this.deps.environmentProvisioning.listHandles(workspaceId),
            serviceFrameIds,
          )
        : new Map<string, string>()
    return { config, liveServiceEnvUrls }
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
   * fragments reach an agent ONLY when its kind carries the `code-aware` trait (technical
   * standards) OR the `doc-aware` trait (document writing-style fragments): those kinds get
   * the running SERVICE's selected fragments (the frame's `serviceFragmentIds`, seeded from
   * the workspace default and editable per service) unioned with the block's own manual pins
   * (for a document task, the default-on `style.*` pins seeded at creation), resolved against
   * the universal pool. A kind carrying neither trait returns null so `composeBlockSystemPrompt`
   * falls back to the block's own `fragmentIds` unchanged. Records the selected ids on the step
   * for observability; never throws (a lookup failure degrades to the block pins).
   */
  private async resolveFragments(
    workspaceId: string,
    agentKind: string,
    step: PipelineStep,
    block: Block,
  ): Promise<{ fragments: { id: string; body: string }[] } | null> {
    // Recorded per dispatch, so it always reflects the kind that actually ran. A step
    // reused across dispatches (a gate/tester host, then its code-aware helper, then a
    // re-test) must not keep reporting a prior round's fragments: a non-code-aware kind
    // receives none, so clear it here rather than leaving a stale selection behind.
    if (
      !hasTrait(agentKind, CODE_AWARE_TRAIT, this.deps.agentKindRegistry) &&
      !hasTrait(agentKind, DOC_AWARE_TRAIT, this.deps.agentKindRegistry)
    ) {
      step.selectedFragmentIds = undefined
      return null
    }
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
      // Re-recorded per dispatch — including clearing it when a re-dispatch resolves to
      // nothing (the selection was emptied between rounds), so the step never keeps
      // reporting fragments a later round no longer received.
      step.selectedFragmentIds = fragments.length ? fragments.map((f) => f.id) : undefined
      if (fragments.length === 0) return null
      return { fragments }
    } catch {
      // Resolution must never wedge a run; fall back to the block's own pins. Clear any
      // stale selection so observability doesn't keep reporting a prior round's fragments
      // that this dispatch did not actually inject.
      step.selectedFragmentIds = undefined
      return null
    }
  }

  /**
   * Resolve the workspace's linked TEMPLATE + EXEMPLAR documents for a document-authoring
   * (doc-aware) step's kind (WS1 items 2–4). A no-op unless the documents repository is wired AND
   * the running kind is doc-aware — so it stays off the hot path for every non-document run. Two
   * keyed reads (the singular template + the exemplar list), never a loop. The exemplar bodies are
   * summarised to a short excerpt so the reference stays cheap; the template body travels whole
   * (the prompt parses its sections). Never throws — a lookup failure degrades to the built-ins.
   */
  private async resolveDocAuthoringContext(
    workspaceId: string,
    agentKind: string,
    block: Block,
  ): Promise<{
    docTemplateBody?: string
    docExemplars?: NonNullable<AgentRunContext['block']['docExemplars']>
    docInterviewBrief?: string
  }> {
    if (!hasTrait(agentKind, DOC_AWARE_TRAIT, this.deps.agentKindRegistry)) return {}
    // The converged interactive-interview brief (WS5) — folded into the writer's context so the
    // draft starts from the refined spec, not the raw outline. Read independently of the
    // template/exemplar links (they need the documents integration; the interview does not), and
    // ONLY for the two kinds that render it (doc-writer / doc-finalizer) — the researcher /
    // outliner / interviewer / reviewer never consume it, so we skip the session read for them.
    const interviewBrief =
      agentKind === DOC_WRITER_KIND || agentKind === DOC_FINALIZER_KIND
        ? await this.resolveDocInterviewBrief(workspaceId, block)
        : undefined
    const documents = this.deps.documents
    if (!documents) return interviewBrief ? { docInterviewBrief: interviewBrief } : {}
    const docKind = (block.taskTypeFields?.docKind ?? 'other') as DocKind
    try {
      const [template, exemplars] = await Promise.all([
        documents.getRoleLink(workspaceId, 'template', docKind),
        documents.listRoleLinks(workspaceId, 'exemplar', docKind),
      ])
      return {
        ...(template?.body?.trim() ? { docTemplateBody: template.body } : {}),
        ...(exemplars.length
          ? {
              docExemplars: exemplars.map((d) => ({
                title: d.title,
                url: d.url,
                excerpt: buildExcerpt(d.body || d.excerpt, CONTEXT_BUDGET.summaryChars),
              })),
            }
          : {}),
        ...(interviewBrief ? { docInterviewBrief: interviewBrief } : {}),
      }
    } catch {
      // A resolution failure must never wedge a run; fall back to the built-in template/exemplars.
      return interviewBrief ? { docInterviewBrief: interviewBrief } : {}
    }
  }

  /** The block's converged document-interview brief (WS5), or undefined when none / unwired. */
  private async resolveDocInterviewBrief(
    workspaceId: string,
    block: Block,
  ): Promise<string | undefined> {
    if (!this.deps.docInterviews) return undefined
    try {
      const session = await this.deps.docInterviews.getByBlock(workspaceId, block.id)
      if (session?.status === 'done' && session.brief?.trim()) return session.brief
    } catch {
      // Never wedge a run on a lookup failure; fall back to the raw outline/description.
    }
    return undefined
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
      const [linkedDocs, linkedTasks] = await Promise.all([
        this.deps.documents?.listByBlock(workspaceId, blockId) ?? [],
        this.deps.tasks?.listByBlock(workspaceId, blockId) ?? [],
      ])
      for (const d of linkedDocs) addDoc(d)
      for (const t of linkedTasks) addTask(t)
    }

    // Resolve explicitly-named references against the imported corpus by a POINT LOOKUP
    // per reference — never a full-corpus scan. Only items that actually exist are added
    // (a `UTF-8` that happens to match the Jira-key shape just resolves to nothing);
    // nothing is fetched live. The lookups are independent point reads on the per-step
    // dispatch path, so they run concurrently; results are folded in in reference order
    // so the dedupe (and the resulting context ordering) stays deterministic.
    const refs = extractReferences(description ?? '')
    const documents = this.deps.documents
    const taskRepo = this.deps.tasks
    const [keyTasks, refTasks, urlItems] = await Promise.all([
      Promise.all(refs.jiraKeys.map((key) => taskRepo?.get(workspaceId, 'jira', key) ?? null)),
      Promise.all(refs.githubRefs.map((ref) => taskRepo?.get(workspaceId, 'github', ref) ?? null)),
      Promise.all(
        refs.urls.map(async (url) => {
          const [doc, task] = await Promise.all([
            (async () => {
              if (!documents) return null
              // Prefer a precise match by the document's stable (source, externalId) — a pasted
              // link canonicalised through the providers' parseRef — so a Figma/Notion URL with a
              // title segment or tracking params still resolves. Fall back to the url-string
              // lookup for any source the resolver doesn't claim (or when it isn't wired).
              const ref = this.deps.documentUrlResolver?.(url)
              const byRef = ref
                ? await documents.get(workspaceId, ref.source, ref.externalId)
                : null
              return byRef ?? (await documents.getByUrl(workspaceId, url))
            })(),
            taskRepo?.getByUrl(workspaceId, url) ?? null,
          ])
          return { doc, task }
        }),
      ),
    ])
    for (const t of keyTasks) addTask(t)
    for (const t of refTasks) addTask(t)
    for (const { doc, task } of urlItems) {
      addDoc(doc)
      addTask(task)
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
  private async resolveEnvironment(workspaceId: string, block: Block) {
    if (!this.deps.environmentProvisioning) return null
    // Resolve the OWN service frame's env specifically: a task can provision several envs (its own
    // frame's plus each involved-service frame's), all under this block, so a plain block read
    // could surface a peer's. The own env is the one the running task's agent/tester targets.
    const frameId = (await this.resolveServiceFrameId(workspaceId, block.id)) ?? undefined
    return this.deps.environmentProvisioning.resolveForBlock(workspaceId, block.id, frameId)
  }

  /**
   * Resolve the connected services "directly involved" in a task beyond its own (the connections
   * initiative) into the agent-context shape: title + the connection `description` prose + the
   * peer's LIVE ephemeral env URL when one is up this run. Read-time STALE FILTER — a
   * `involvedServiceIds` entry that is no longer a connection neighbour or no longer resolves to a
   * `service` frame is dropped (inert, never a run failure). Only tasks carry involved services
   * (reviews/deploys are task-scoped), so frames/modules resolve nothing. The peers' live env URLs
   * are read ONCE via {@link EnvironmentProvisioningService.listHandles} and indexed by frame id
   * (the same newest-wins helper the frontend bindings use) — a single query regardless of count.
   */
  private async resolveInvolvedServices(
    workspaceId: string,
    block: Block,
  ): Promise<AgentRunContext['involvedServices'] | undefined> {
    if (block.level !== 'task') return undefined
    if ((block.involvedServiceIds?.length ?? 0) === 0) return undefined
    const blocks = await this.deps.blockRepository.listByWorkspace(workspaceId)
    const byId = new Map(blocks.map((b) => [b.id, b]))
    const ownFrameId = frameOf(byId, block.id)?.id
    if (!ownFrameId) return undefined
    const valid = validInvolvedServiceFrames(blocks, block, ownFrameId)
    if (valid.length === 0) return undefined
    const frameIds = new Set(valid.map((b) => b.id))
    const liveEnvUrls =
      this.deps.environmentProvisioning && frameIds.size > 0
        ? indexLiveServiceEnvUrls(
            await this.deps.environmentProvisioning.listHandles(workspaceId),
            frameIds,
          )
        : new Map<string, string>()
    return valid.map((frame) => {
      const description = connectionDescription(blocks, ownFrameId, frame.id)
      const envUrl = liveEnvUrls.get(frame.id)
      return {
        frameId: frame.id,
        title: frame.title,
        ...(description ? { description } : {}),
        ...(envUrl ? { envUrl } : {}),
      }
    })
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
