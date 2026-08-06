import type {
  AccountRepository,
  AgentPromptRepository,
  WorkspaceAgentSettingsRepository,
  AgentRunContext,
  BinaryGeneratorSource,
  Block,
  BlockRepository,
  BrainstormSessionRepository,
  ClarityReviewRepository,
  CloudProvider,
  ConsensusGroupRepository,
  ConsensusStepConfig,
  DocInterviewRepository,
  DocKind,
  DocumentRepository,
  ExecutionInstance,
  FrontendConfig,
  Initiative,
  GroupCacheHandle,
  InitiativePresetRegistry,
  InitiativeRepository,
  LinkedDocumentRefresher,
  Logger,
  ModelPresetCacheValue,
  ModelPresetRepository,
  PipelineStep,
  RequirementReviewRepository,
  ResolvedSkill,
  SkillVersionPin,
  TaskRepository,
  TaskTypeRegistry,
  TestSecretRef,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  applicableFragmentIds,
  applyConsensusGroup,
  buildExcerpt,
  CONTEXT_BUDGET,
  describeCustomTaskType,
  describeOwnService,
  resolveServiceFrameBlock,
  selectConsensusGroup,
} from '@cat-factory/kernel'
import {
  CODE_AWARE_TRAIT,
  DOC_AWARE_TRAIT,
  DOC_FINALIZER_KIND,
  DOC_WRITER_KIND,
  hasTrait,
  standardsVerbosityFor,
} from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { resolveDispatchSettings } from './dispatchPromptSettings.js'
import {
  boundServiceFrameIds,
  buildFrontendRunNotes,
  indexLiveServiceEnvUrls,
  resolveFrontendBindings,
  type ResolvedFrontendBinding,
} from './frontend-infra.logic.js'
import { connectionDescription } from '@cat-factory/contracts'
import type { ResolvedValidationChecks } from '@cat-factory/contracts'
import { reproductionFor, validationChecksFor } from './builder-validation-context.js'
import { stepObservations, type StepObservations } from './builder-step-observations.js'
import { frameOf, validInvolvedServiceFrames } from './frame.logic.js'
import { buildImplementationChoice } from './forkDecision.logic.js'
import { buildRalphValidation } from './ralph.logic.js'
import { isTesterKind } from './ci.logic.js'
import { interviewFollowsStep } from '../initiative/initiative.logic.js'
import { resolveRunSkills } from './run-skills.js'
import {
  linkedContextWithDesignFlag,
  mergeInjectedContextFiles,
  priorPrReviewContextFor,
} from './builder-context-files.js'
import { type FoundationalServiceResolver } from './run-foundational-services.js'
import { CatalogRunContext } from './run-catalog-context.js'
import { getFragment, withDesignContextFragment } from '@cat-factory/prompt-fragments'
import {
  type DocumentUrlResolver,
  type LinkedContext,
  resolveLinkedContext as resolveLinkedContextFor,
} from './linked-context.js'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'

/**
 * The `revision` slice of an agent context when a step is being re-run with feedback
 * — either a human's "request changes" on its approval gate, or a downstream
 * companion's automatic rework (`step.rework`). The companion path wins when both are
 * present. Empty object when neither applies (no revision context).
 */
function buildRevisionContext(step: PipelineStep): {
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
 *
 * Eviction recoveries count too — the deploy path has always done this
 * (`deployEvictionEpoch`, whose comment calls itself "analogous to the agent path's
 * `dispatchEpochFor`"), and the agent path owes the same for a stronger reason. A pool is
 * told to keep routing STICKY BY JOB ID (see `backend/docs/runner-pool-integration.md` §7) so
 * a replay or sweeper re-drive reaches the same job — correct for a live job, and exactly
 * wrong after an eviction, where reusing the id routes the recovery straight back to the dead
 * job instead of onto a fresh member. That would make the whole eviction-recovery budget a
 * no-op for pool-backed runs. A fresh id is right for every other transport too: nothing can
 * re-attach to a container that no longer exists.
 *
 * Every component is monotonic per step, so the sum is monotonic and each re-dispatch after
 * any increment mints a strictly larger epoch — two different rounds can never collide on one id.
 */
export function dispatchEpochFor(step: PipelineStep): number {
  const evictions = (step.evictionRecoveries ?? 0) + (step.transientEvictionRecoveries ?? 0)
  // A manually RESUMED PR review counts for the same reason an eviction recovery does, and more
  // sharply: the whole point of the resume is that the previous job is WEDGED, so re-attaching to
  // it (which is what a container-reusing transport does for a known job id) would replace the
  // stuck run with itself. The review is the only step kind carrying none of the loop counters
  // above, so without this term its epoch would stay 0 across every resume.
  const resumes = step.prReview?.resumeAttempts ?? 0
  const base =
    (step.test?.attempts ?? step.gate?.attempts ?? step.ralph?.attempts ?? 0) + evictions + resumes
  // The optional fork-decision phase dispatches the read-only proposer on the coder step
  // BEFORE the Coder itself (Phase A then Phase B). Both dispatch on the same step, so once
  // the phase resolves (`chosen` / `single_path`) bump the epoch by one — the Phase-B Coder
  // then gets a distinct harness job id and never re-attaches to the proposer's completed job
  // on a container-reusing transport (the same guarantee fixer/helper rounds get).
  const status = step.forkDecision?.status
  const forkResolved = status === 'chosen' || status === 'single_path'
  return base + (forkResolved ? 1 : 0)
}

/**
 * Resolves already-selected fragment ids to their bodies against the merged
 * tenant catalog, live-resolving any document-backed entries. Implemented by the
 * fragment-library service; wired only when the library is configured. Absent →
 * the builder falls back to the static `getFragment` pool (built-ins only).
 */
export interface FragmentBodyResolver {
  resolveBodiesForRun(
    workspaceId: string,
    ids: string[],
    options?: {
      /**
       * The dispatching kind's standards verbosity. `brief` (an implementer kind) is what
       * makes the resolver produce condensed variants — including generating and persisting
       * one for a long standard that has none — so a kind that folds full bodies never pays
       * for a condensation it would discard.
       */
      verbosity?: 'full' | 'brief'
      /**
       * The run being dispatched. A `brief` resolution may GENERATE a condensation, which is
       * a model call on the run path; passing the run is what files it against the step that
       * spent it instead of against nothing.
       */
      executionId?: string
    },
  ): Promise<{ id: string; title?: string; body: string; brief?: string }[]>
}

/**
 * Resolves a `skill` step's picked skill (`stepOptions.skillId`) to the payload the container
 * executor renders — the persisted instructions + the resource bodies fetched at the skill's
 * pinned commit — plus the version pin recorded on the step. Implemented by the skill library's
 * {@link SkillRunResolver}; wired only when the skill library is configured. Unlike the fragment
 * resolver (whose absence degrades to the static pool), a MISSING skill resolver on a step that
 * DID pick a skill is a hard {@link ValidationError} at dispatch — a skill step running against
 * nothing is a silent wrong run, not a graceful degrade.
 */
export interface SkillResolver {
  resolveForRun(
    workspaceId: string,
    skillId: string,
  ): Promise<{ skill: ResolvedSkill; version: SkillVersionPin }>
}

export type { DocumentUrlResolver } from './linked-context.js'

/** The collaborators the context builder reads from (all owned by the engine container). */
export interface AgentContextBuilderDeps {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  accountRepository: AccountRepository
  /** App-owned agent-kind registry: drives the `code-aware` fragment-folding decision. */
  agentKindRegistry: AgentKindRegistry
  /** App-owned initiative-preset registry: resolves a spawned/planning run's preset steering. */
  initiativePresetRegistry: InitiativePresetRegistry
  /**
   * Optional: the app-owned custom task-type registry, read to LABEL the per-case parameters a
   * custom-typed task collected at creation (a reusable operation's brief). Absent, or missing
   * the block's type (the normal state on a node whose build predates the registration), it
   * degrades to the raw bag keys, never to a dropped value.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * Optional: the workspace's agent system-prompt override log. When wired, each dispatch
   * resolves the live revision for the kind being run and folds it onto the context, so the
   * container / inline / consensus executors all send the workspace's own prompt. Absent (or
   * no revision for the kind) ⇒ the shipped prompt, unchanged.
   */
  agentPrompts?: AgentPromptRepository
  /**
   * Optional: the workspace's per-agent-kind generation settings. When wired, each dispatch
   * resolves the kind's configured output-token ceiling, which the step's own
   * `stepOptions.maxOutputTokens` still overrides. Absent (or no row for the kind) ⇒ the
   * deployment routing ceiling, unchanged.
   */
  agentSettings?: WorkspaceAgentSettingsRepository
  /**
   * Optional: the workspace's model-preset library, read for the ROUTE ORDER the block's preset
   * states (`providerPreference`). Resolved here — once per dispatch — for the same reason the
   * prompt override and the output budget are: the container, inline and consensus paths must not
   * disagree about which route a step ran on. Absent (or a preset stating none) ⇒ the deployment's
   * default order, unchanged.
   */
  modelPresets?: ModelPresetRepository
  /**
   * Optional: the `AppCaches.modelPreset` slice the preset read above goes through — the row is
   * slow-moving admin config that every dispatch resolves. Absent ⇒ the read runs live.
   */
  modelPresetCache?: GroupCacheHandle<ModelPresetCacheValue>
  /**
   * Optional: the workspace's consensus-GROUP library. When wired, a consensus step naming a
   * tier set (`consensus.groupIds`) resolves it here — ONE batched read per dispatch — and the
   * group the task's estimate earns is materialised onto the context. Absent (or the step names
   * no groups) ⇒ the inline participants authored on the step, unchanged.
   */
  consensusGroups?: ConsensusGroupRepository
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
  /**
   * Optional: re-confirm each linked document against its source at dispatch, so an agent reads the
   * CURRENT revision of a page rather than the copy import stored (the freshness half of design
   * support: a frame edited after import otherwise feeds every later run the old markdown). Absent →
   * no refresh and no freshness note, byte-for-byte the prior behaviour.
   */
  documentRefresher?: LinkedDocumentRefresher
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
   * Optional: resolve the NON-secret references (key + description) of the sensitive test
   * credentials configured for a run block's service frame — folded into the tester prompt so
   * the agent knows which env vars are injected and what each is for. Wired from the facade's
   * `TestSecretsService`; absent ⇒ the tester runs with no advertised secrets. NEVER returns a
   * value — the values reach only the container environment, resolved separately at dispatch.
   */
  resolveTestSecretRefs?: (workspaceId: string, blockId: string) => Promise<TestSecretRef[]>
  /**
   * Optional: resolve the PRE-PR VALIDATION CHECKS configured for a run block's service frame
   * (walked up the frame chain) — the commands the harness runs against the checkout before
   * opening a PR. Wired from the facade's `ValidationConfigService`; absent (or resolving to
   * `null` — the service configured none) ⇒ nothing is folded onto the context, so the job body
   * carries no checks and the harness runs its existing path unchanged.
   */
  resolveValidationChecks?: (
    workspaceId: string,
    frameId: string,
  ) => Promise<ResolvedValidationChecks | null>
  /**
   * Optional: resolves fragment ids against the merged tenant catalog (managed +
   * document-backed entries). When wired the engine uses it instead of the static
   * pool, so curated and living-document fragments actually reach a run.
   */
  fragmentResolver?: FragmentBodyResolver
  /**
   * Optional: resolves a `skill` step's picked skill (`stepOptions.skillId`) to its instructions
   * + resource bodies for the run. Wired only when the repo-sourced Claude Skills library is
   * configured. A skill step dispatched with this UNWIRED fails loudly (see {@link SkillResolver}).
   */
  skillResolver?: SkillResolver
  /**
   * Optional: the FOUNDATIONAL SERVICES catalog seam — the design-time catalog for a
   * `foundational-catalog` kind and the lazily-resolved contract documents for a
   * `foundational-contracts` one, both delivered as injected `.cat-context/` files. Wired only
   * when the catalog is configured; absent ⇒ neither is injected (the prior behaviour).
   */
  foundationalServiceResolver?: FoundationalServiceResolver
  /**
   * Optional: the deployment's GENERATIVE BINARY INTEGRATIONS (image / music / video generation
   * APIs registered in code). Read for a binary-generating step's brief and for the non-secret
   * projection the container executor resolves credentials from. Absent ⇒ no integration
   * resolves, and the brief states that rather than implying the step has one.
   */
  binaryGeneratorSource?: BinaryGeneratorSource
  /**
   * Optional: the run logger, used to report a capability that was declared but skipped (an
   * unregistered bundled-skill id, an optional catalog skill that could not resolve). Absent ⇒
   * those degradations are silent, which is why every facade wires it.
   */
  logger?: Logger
}

/** How a caller of {@link AgentContextBuilder.buildContext} means the resolution to be read. */
export interface BuildContextOptions {
  /**
   * Override the step's own kind as the kind that will actually RUN (a gate step dispatching its
   * helper, the Tester loop dispatching its fixer off the hosting step).
   */
  agentKind?: string
  /**
   * Whether THIS call is the resolution that a job about to start will run under, and so the one
   * the step's PER-DISPATCH observability fields must describe (`selectedFragmentIds`,
   * `validationConfigUnreadable`). Those fields are rewritten from each resolution, including
   * being CLEARED when this round resolved nothing, so a call that is not a dispatch would
   * overwrite the record of the dispatch that actually produced the tree.
   *
   * Defaults to `true`, which is the safe direction for a caller that forgets: over-recording is
   * a fact stated about a resolution that never shipped (visible, and corrected by the next real
   * dispatch), where under-recording silently deletes evidence and restores exactly the
   * fabricated-fact reading `validationConfigUnreadable` exists to refuse. The two callers that
   * pass `false` are the ones that resolve a context WITHOUT starting a job: the over-budget
   * exemption probe, and a re-attach to a job a prior (possibly replayed) dispatch already
   * started.
   */
  recordsDispatch?: boolean
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
   *
   * `options.recordsDispatch` says whether this resolution is the one the step's per-dispatch
   * observability describes; see {@link BuildContextOptions}.
   */
  async buildContext(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
    options?: BuildContextOptions,
  ): Promise<AgentRunContext> {
    const agentKind = options?.agentKind ?? step.agentKind
    const observations = stepObservations(step, options)
    // When a block's requirements have been reworked, that standardized document is
    // the single source of truth for every agent step: it already folds in the
    // description plus the linked docs / tracker issues, so it REPLACES the
    // description and the (now-redundant) doc/task context. Reviews are only ever run
    // on task blocks, so skip the lookup entirely for frames/modules — that keeps the
    // extra read off every container/frame step rather than on the whole hot path.
    // A converged clarity (bug-report triage) report substitutes downstream exactly like a
    // reworked requirements doc. When both exist on one task the requirements doc — which
    // runs after clarity and is the more refined artifact — takes precedence.
    // The (possibly reworked/clarified) description is the single substitution every step
    // reads, and the owning service frame is walked to by four of the resolvers below. Resolve
    // BOTH first (independently, so in one wave): the description feeds linked-context + the
    // block payload, and threading the pre-resolved `serviceFrame` into the frame resolvers
    // collapses their four separate frame→module→task walks into ONE (reuse-not-cache).
    const [reworked, serviceFrame] = await Promise.all([
      this.resolveSubstituteDescription(workspaceId, block),
      this.serviceFrameFor(workspaceId, block),
    ])
    const description = reworked ?? block.description
    // One promise, two consumers: the wave's first entry below, and the fragment fold, which needs to
    // know whether this run carries a DESIGN document without re-resolving the corpus to find out.
    const { linkedContext, hasDesignContext } = linkedContextWithDesignFlag(() =>
      this.resolveLinkedContext(workspaceId, block.id, description, { includeLinked: !reworked }),
    )
    // The remaining context resolutions are mutually independent — the frame resolvers all read
    // from the shared `serviceFrame`, and the rest read disjoint sources — so fan them out in one
    // `Promise.all` wave instead of awaiting each in turn (the initiative's "parallel waves"
    // pattern), turning a chain of per-dispatch round-trips into a single wave's latency.
    const [
      // High-confidence external context = the docs/tasks a human attached to the block
      // (skipped when `reworked`, since the incorporated doc already folds them in) UNION any
      // items the effective description names explicitly (a Jira key, a URL), resolved against
      // the already-imported corpus. Explicitly-named refs are included even in reworked mode —
      // the human may name an issue in the doc that was never attached.
      { docs: contextDocs, tasks: contextTasks },
      environment,
      service,
      frontend,
      involvedServices,
      // The SENSITIVE test-credential refs (key + description, NEVER values) for the tester kinds
      // only — the kinds that receive the values out of band. Advertised in the tester prompt so
      // the agent knows which env vars are injected; values are resolved separately at dispatch.
      testSecrets,
      // The service frame's validation config (walked up the frame chain): TWO independently
      // gated context fields from ONE read, and `{}` for a service that declared neither OR a
      // read that failed, told apart on the step rather than here. See `validationChecksFor`.
      validationChecks,
      // An initiative-level run (the planning pipeline) carries the interview + analysis context
      // so the analyst/planner prompts fold in the human's intent and prior findings, plus the
      // preset steering resolved for THIS step's kind.
      initiative,
      // A finalized architecture-brainstorm direction is surfaced ADDITIVELY (it does not replace
      // the description) as a synthetic prior output so the architect and downstream agents read
      // it as context (reviews are task-scoped, so frames/modules skip the lookup).
      architectureDirection,
      resolved,
      docAuthoring,
      // The skills this dispatch applies: the running KIND's declared playbooks (bundled with the
      // deployment's package or referenced from the account catalog) plus a `skill` step's own
      // picked skill, each catalog one pinned onto the step. A kind that declares none and a step
      // that picked none skip it entirely (no extra read). Throws when a REQUIRED skill can't
      // resolve — a step asked to apply a skill must never run against nothing.
      runSkills,
      // The three per-dispatch GENERATION settings — the workspace's own system prompt for the
      // kind, the output-token ceiling, and the ROUTE order the block's preset prefers. Resolved
      // HERE, once per dispatch in the engine, rather than in each executor, so the container /
      // inline / consensus paths cannot disagree about what a step ran under.
      dispatchSettings,
      // The consensus config this dispatch actually runs under: the step's own config when it
      // authored inline participants, the workspace group its estimate earned when it named a
      // tier set, or nothing at all when no tier cleared (⇒ the standard single-actor agent).
      consensus,
      // Everything this dispatch gets from the CATALOG side — the foundational-services files,
      // the binary-output brief, and the generative integrations the executor resolves
      // credentials from. One entry rather than three because they share a collaborator, a
      // failure policy and (on a mothership-mode node) a transport, so the collaborator owns
      // the fan-out and the shared reads inside it; see `CatalogRunContext.sliceFor`.
      catalogSlice,
    ] = await Promise.all([
      linkedContext,
      this.resolveEnvironment(workspaceId, block, serviceFrame),
      this.serviceConfigFrom(workspaceId, serviceFrame),
      this.frontendConfigFrom(workspaceId, serviceFrame),
      this.resolveInvolvedServices(workspaceId, block),
      isTesterKind(agentKind) && this.deps.resolveTestSecretRefs
        ? this.deps.resolveTestSecretRefs(workspaceId, block.id)
        : Promise.resolve<TestSecretRef[]>([]),
      validationChecksFor(this.deps, workspaceId, serviceFrame, step, observations),
      this.resolveInitiativeContext(workspaceId, block, agentKind, instance),
      block.level === 'task'
        ? this.resolveBrainstormDirection(workspaceId, block.id)
        : Promise.resolve<string | null>(null),
      // The fragment fold keys off the EFFECTIVE dispatched kind and reads the shared frame's
      // `serviceFragmentIds`; it records the selection through `observations` (safe under the
      // wave — single-threaded, no other resolver touches the step).
      this.resolveFragments(workspaceId, agentKind, observations, block, serviceFrame, {
        executionId: instance.id,
        hasDesignContext,
      }),
      this.resolveDocAuthoringContext(workspaceId, agentKind, block),
      this.resolveSkillsForStep(workspaceId, agentKind, step),
      resolveDispatchSettings(this.deps, workspaceId, agentKind, step, block),
      // A consensus step's TIER SET: resolve the named groups and materialise the one this
      // task's estimate earns. In the same read wave as the rest of the context, so a tiered
      // step costs one extra batched query and nothing else.
      this.resolveConsensusConfig(workspaceId, step, block),
      this.catalogContext().sliceFor(workspaceId, agentKind, step, instance),
    ])
    const agentConfig = block.agentConfig
    const customTaskType = this.customTaskTypeFor(block)
    const reproduction = reproductionFor(agentKind, agentConfig, instance, validationChecks)
    const priorOutputs = [
      ...(architectureDirection
        ? [{ agentKind: 'architecture-brainstorm', output: architectureDirection }]
        : []),
      ...instance.steps
        .slice(0, instance.currentStep)
        .filter((s) => s.output)
        .map((s) => ({ agentKind: s.agentKind, output: s.output! })),
    ]
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
      ...dispatchSettings,
      // The future-looking Follow-up companion is enabled for this (coder) step: the
      // container executor appends the follow-up guidance + sets the harness to stream items.
      // Gated on the EFFECTIVE dispatched kind matching the step's own kind, so a HELPER
      // dispatch off the coder step (the fork-proposer) never inherits the Coder's follow-up
      // streaming guidance.
      ...(step.followUps?.enabled && agentKind === step.agentKind
        ? { followUpCompanion: true }
        : {}),
      // The chosen implementation fork (Phase B): folded ONLY when dispatching the step's own
      // coder kind (never on the proposer helper dispatch). Absent when the phase was skipped /
      // a single path / not configured. See {@link buildImplementationChoice}.
      ...(agentKind === step.agentKind
        ? (() => {
            const choice = buildImplementationChoice(step.forkDecision)
            return choice ? { implementationChoice: choice } : {}
          })()
        : {}),
      // Ralph loop: fold the iteration's programmatic completion command + progress-log path
      // + 1-based iteration number (`attempts + 1`) into the context so the container executor
      // forwards them to the harness as the coding job's `validation` block. Only when
      // dispatching the step's own `ralph` kind (there is no helper kind for the loop). Absent
      // for a step with no `ralph` state / any other kind. See {@link buildRalphValidation}.
      ...(agentKind === step.agentKind
        ? (() => {
            const validation = buildRalphValidation(step.ralph)
            return validation ? { ralphValidation: validation } : {}
          })()
        : {}),
      // Consensus config for this dispatch, already tier-resolved (see
      // {@link resolveConsensusConfig}). Read only by the optional consensus executor, which
      // decides — possibly gated on the block estimate below — whether to run the multi-model
      // process. Absent ⇒ standard single-actor agent.
      ...consensus,
      // The resolved skills for this dispatch — instructions + resource bodies, rendered
      // harness-aware by the container executor. Catalog versions are pinned onto the step
      // (skillVersions) inside the resolver. Absent when the run applies no skills.
      ...(runSkills.skills.length ? { skills: runSkills.skills } : {}),
      block: this.buildBlockPayload({
        block,
        description,
        resolved,
        agentConfig,
        contextDocs,
        contextTasks,
        docAuthoring,
      }),
      ...(environment ? { environment } : {}),
      ...(service ? { service } : {}),
      ...(frontend ? { frontend } : {}),
      ...(involvedServices?.length ? { involvedServices } : {}),
      // WHICH SYSTEM this work belongs to — the enclosing service frame, or the positive reason
      // there is none. Always set (never conditionally spread): the "not under a service" case is
      // the one the prompt has to STATE, so leaving it out would be the silent gap this exists to
      // close. Derived from the `serviceFrame` already resolved above, so it costs no extra read.
      ownService: describeOwnService(block, serviceFrame),
      // The per-case parameters a custom-typed task was invoked with (see `customTaskTypeFor`).
      ...customTaskType,
      ...(testSecrets.length ? { testSecrets } : {}),
      // Spreads BOTH the pre-PR checks and the dependency-prepopulation install — one frame-chain
      // read, two independently-gated context fields (see `validationChecksFor`).
      ...validationChecks,
      ...reproduction,
      // Read-only reference repos for a doc-authoring task, lifted verbatim from the block —
      // the executor clones them as read-only siblings for the doc-writer. A pure projection
      // (identities are self-contained), so no repo reads here.
      ...(block.referenceRepos?.length ? { referenceRepos: block.referenceRepos } : {}),
      // Pre-existing branches attached to this task as run input (apriori branches), lifted
      // verbatim from the block — a pure projection (identities are self-contained). The
      // executor swaps a `working` entry in for the deterministic work branch; the reference
      // entries steer a later harness fetch. Absent when the task attaches none.
      ...(block.aprioriBranches?.length ? { aprioriBranches: block.aprioriBranches } : {}),
      ...(initiative ? { initiative } : {}),
      // The builder's own injected context files. Two producers CONTRIBUTE here and they must
      // ACCUMULATE rather than replace one another (a preOp's repo-derived files are merged in
      // separately, downstream): a RESUMED PR review's prior slice reports
      // (`.cat-context/pr-prior-review.md`, see {@link priorPrReviewContextFor}) and the
      // foundational-services catalog/contracts. Spreading both objects would silently drop
      // whichever came first, so they are concatenated.
      ...mergeInjectedContextFiles(
        priorPrReviewContextFor(agentKind, step).injectedContextFiles,
        catalogSlice.foundationalContextFiles,
        catalogSlice.binaryOutputContextFiles,
      ),
      ...(catalogSlice.binaryGenerators.length
        ? { binaryGenerators: catalogSlice.binaryGenerators }
        : {}),
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
   * The per-case PARAMETERS a custom-typed task was invoked with (a REUSABLE OPERATION's brief),
   * labelled from the registered descriptor. Resolved here, once per dispatch, for the same reason
   * the prompt override and the output budget are: the container, inline and consensus paths must
   * not disagree about what the operation was asked for.
   *
   * Returns a SPREAD-READY partial (like `validationChecksFor`) rather than a nullable value, so
   * the hot builder gains no branch. Costs no read: the registry is in-process, and an absent one
   * degrades to the raw bag keys rather than dropping the values (see `describeCustomTaskType`).
   * Empty for every run that collected nothing, which is every run of a built-in type.
   */
  private customTaskTypeFor(block: Block): Pick<AgentRunContext, 'customTaskType'> {
    if (!block.taskType) return {}
    const customTaskType = describeCustomTaskType(
      block.taskType,
      block.taskTypeFields?.custom,
      this.deps.taskTypeRegistry?.get(block.taskType),
    )
    return customTaskType ? { customTaskType } : {}
  }

  /**
   * Assemble the `block` sub-payload of the agent context — the block identity plus its many
   * OPTIONAL fields (resolved fragments, technical label, model preset, PR + peer PRs, linked
   * context docs/tasks, estimate, per-type creation fields, doc-authoring template/exemplars/
   * brief). Extracted verbatim from {@link buildContext} so that hot builder stays within the
   * cyclomatic-complexity budget; behaviour is byte-identical.
   */
  private buildBlockPayload(args: {
    block: Block
    description: string
    resolved: Awaited<ReturnType<AgentContextBuilder['resolveFragments']>>
    agentConfig: Block['agentConfig']
    contextDocs: Awaited<ReturnType<AgentContextBuilder['resolveLinkedContext']>>['docs']
    contextTasks: Awaited<ReturnType<AgentContextBuilder['resolveLinkedContext']>>['tasks']
    docAuthoring: Awaited<ReturnType<AgentContextBuilder['resolveDocAuthoringContext']>>
  }): AgentRunContext['block'] {
    const { block, description, resolved, agentConfig, contextDocs, contextTasks, docAuthoring } =
      args
    return {
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
      // Peer PRs from a multi-repo run (own-service PR stays on `pullRequest`) — the merger
      // reads these to clone each peer's PR branch and score the combined cross-repo diff.
      ...(block.peerPullRequests?.length ? { peerPullRequests: block.peerPullRequests } : {}),
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
    }
  }

  /**
   * The initiative context a run carries, in one of two shapes:
   *
   * - An `initiative`-level (planning) run gets the FULL planning context: the interviewer's
   *   synthesized goal / constraints / non-goals + the answered Q&A digest, the analyst's codebase
   *   analysis, and — when created from a PRESET — the preset's per-kind planning-prompt steering +
   *   declarative phase template, resolved for `agentKind` (analyst / planner).
   * - A run whose block was SPAWNED by an initiative (a task/module/frame carrying
   *   `block.initiativeId`) gets a PRESET-ONLY context — `{ preset: { label, promptAddition } }` —
   *   so the org's standing per-kind methodology reaches the child coder / tester / custom kind
   *   (D1). Deliberately NO goal/qa/analysis fold: the item description is the child's task
   *   contract, and bleeding planning context into children regresses prompt hygiene + token
   *   budgets.
   *
   * Returns undefined when no initiative store is wired, the block is neither initiative-level nor
   * initiative-spawned, the initiative entity is missing, or — for a spawned run — the preset
   * contributes no `promptAddition` for the running kind (so the child prompt stays byte-identical).
   * The spawned branch is gated on `block.initiativeId`, so a plain task keeps the non-initiative
   * hot path (zero extra reads); an initiative-spawned step does exactly one point-read (no loop →
   * no N+1).
   */
  private async resolveInitiativeContext(
    workspaceId: string,
    block: Block,
    agentKind: string,
    instance: ExecutionInstance,
  ): Promise<AgentRunContext['initiative']> {
    if (!this.deps.initiatives) return undefined
    // A run spawned INSIDE an initiative (not the planning run itself): the preset steering only.
    if (block.level !== 'initiative') {
      if (!block.initiativeId) return undefined
      const initiative = await this.deps.initiatives.getByBlock(workspaceId, block.initiativeId)
      if (!initiative) return undefined
      const preset = this.resolveSpawnedPresetContext(initiative, agentKind)
      return preset ? { preset } : undefined
    }
    const initiative = await this.deps.initiatives.getByBlock(workspaceId, block.id)
    if (!initiative) return undefined
    const qa = (initiative.qa ?? [])
      .filter((q) => q.answer?.trim())
      .map((q) => ({ question: q.question, answer: q.answer }))
    const preset = this.resolveInitiativePresetContext(initiative, agentKind)
    return {
      ...(initiative.goal ? { goal: initiative.goal } : {}),
      ...(initiative.constraints?.length ? { constraints: initiative.constraints } : {}),
      ...(initiative.nonGoals?.length ? { nonGoals: initiative.nonGoals } : {}),
      ...(qa.length ? { qa } : {}),
      ...(initiative.analysisSummary ? { analysisSummary: initiative.analysisSummary } : {}),
      // Read off THIS run's chain, so a planning pipeline with no interviewer (`pl_initiative_docs`,
      // any `interview: 'skip'` preset, a deployment's own chain) tells the analyst the truth about
      // what follows it rather than inheriting `pl_initiative`'s shape. Always present — `false` is
      // the load-bearing half of this flag, so it must not be elided like the sparse fields above.
      interviewFollows: interviewFollowsStep(instance.steps, instance.currentStep),
      ...(preset ? { preset } : {}),
    }
  }

  /**
   * The preset steering an initiative-SPAWNED run carries: the registered preset's label + its
   * `promptAdditions` entry for the RUNNING kind (coder / tester / a custom kind). Returns undefined
   * — so the child prompt is byte-identical — when the entity carries no `presetId`, names an
   * unknown preset, or the preset contributes no (trimmed, non-empty) addition for this kind. Unlike
   * {@link resolveInitiativePresetContext} it never carries the `phaseTemplate` (that is planner-only
   * plan shape, irrelevant to a spawned child).
   */
  private resolveSpawnedPresetContext(
    initiative: Pick<Initiative, 'presetId'>,
    agentKind: string,
  ): NonNullable<AgentRunContext['initiative']>['preset'] | undefined {
    if (!initiative.presetId) return undefined
    const registration = this.deps.initiativePresetRegistry.get(initiative.presetId)
    if (!registration) return undefined
    const promptAddition = registration.promptAdditions?.[agentKind]?.trim()
    if (!promptAddition) return undefined
    return { label: registration.descriptor.presentation.label, promptAddition }
  }

  /**
   * Resolve the preset steering an initiative's planning step carries: the registered preset's
   * label + its `promptAdditions` entry for the RUNNING kind (analyst / planner) + its declarative
   * `phaseTemplate` (the plan shape the planner prompt fold renders). Returns undefined — so the
   * prompt is unchanged — when the entity carries no `presetId`, names an unknown preset, or the
   * preset contributes NEITHER a prompt addition for this kind NOR a phase template. The built-in
   * generic preset registers neither, so it contributes nothing and the generic planning prompt
   * stays byte-for-byte today's. (The frozen form reaches the prompt via the seeded `qa` digest,
   * not here.)
   */
  private resolveInitiativePresetContext(
    initiative: Pick<Initiative, 'presetId'>,
    agentKind: string,
  ): NonNullable<AgentRunContext['initiative']>['preset'] | undefined {
    if (!initiative.presetId) return undefined
    const registration = this.deps.initiativePresetRegistry.get(initiative.presetId)
    if (!registration) return undefined
    const promptAddition = registration.promptAdditions?.[agentKind]?.trim()
    const phaseTemplate = registration.descriptor.phaseTemplate
    if (!promptAddition && !phaseTemplate) return undefined
    return {
      label: registration.descriptor.presentation.label,
      ...(promptAddition ? { promptAddition } : {}),
      ...(phaseTemplate ? { phaseTemplate } : {}),
    }
  }

  /** The service-frame id for a block (walks up frame → module → task; cycle-guarded). */
  async resolveServiceFrameId(workspaceId: string, blockId: string): Promise<string | null> {
    return (await this.resolveServiceFrame(workspaceId, blockId))?.id ?? null
  }

  /**
   * The owning service FRAME for a block we ALREADY hold, walking up from the block in hand
   * (frame → module → task; cycle-guarded) rather than re-fetching it by id like the public
   * {@link resolveServiceFrame}. {@link buildContext} resolves this ONCE and threads it into
   * every service-frame resolver (environment / service config / frontend / fragments) so the
   * ancestry walk runs a single time per dispatch instead of once per resolver. A `frame`-level
   * block is its own frame (no reads); every other level walks up via `parentId`.
   *
   * Delegates to the shared {@link resolveServiceFrameBlock} walk, passing the block in hand as
   * the pre-fetched start so the walk skips re-fetching it (the only difference from the public
   * {@link resolveServiceFrame}, which starts from a block id).
   */
  private async serviceFrameFor(workspaceId: string, block: Block): Promise<Block | null> {
    return resolveServiceFrameBlock(
      (id) => this.deps.blockRepository.get(workspaceId, id),
      block.id,
      block,
    )
  }

  /**
   * The reworked/clarified substitute description for a block, or `null` when none applies —
   * the incorporated requirements doc (winner), else the clarified bug report. Reviews are only
   * ever run on task blocks, so frames/modules resolve to `null` with no read. Shared by
   * {@link buildContext} (which also needs the raw null to decide `includeLinked`) and
   * {@link resolveEffectiveDescription}.
   */
  private async resolveSubstituteDescription(
    workspaceId: string,
    block: Block,
  ): Promise<string | null> {
    if (block.level !== 'task') return null
    return (
      (await this.resolveReworkedRequirements(workspaceId, block.id)) ??
      (await this.resolveClarifiedBrief(workspaceId, block.id))
    )
  }

  /**
   * The service-frame BLOCK for a block (walks up frame → module → task; cycle-guarded).
   * Returns the frame itself rather than its id, so a caller that needs the frame's fields
   * (e.g. `frontendConfig`) doesn't re-fetch the row the walk already loaded.
   */
  async resolveServiceFrame(workspaceId: string, blockId: string): Promise<Block | null> {
    return resolveServiceFrameBlock((id) => this.deps.blockRepository.get(workspaceId, id), blockId)
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
    return this.serviceConfigFrom(workspaceId, await this.serviceFrameFor(workspaceId, block))
  }

  /**
   * {@link resolveServiceConfig} against an ALREADY-resolved service frame — the shape
   * {@link buildContext} calls once it has walked the ancestry a single time. Returns undefined
   * when the frame is absent. (The public method above resolves the frame then delegates here, so
   * external callers keep the walk-from-a-block-id contract while the hot path reuses the frame.)
   */
  private async serviceConfigFrom(
    workspaceId: string,
    frame: Block | null,
  ): Promise<AgentRunContext['service'] | undefined> {
    if (!frame) return undefined
    const service: NonNullable<AgentRunContext['service']> = {}
    // Always carry the frame's block `type` — it is the source of the frame capability profile
    // (`frameProfile`), so a `library` frame with no provisioning/provider still reaches the
    // deployer skip + the tester's suite posture. Setting it unconditionally also means `service`
    // is defined whenever a frame resolves (its only consumers read specific fields off it).
    service.type = frame.type
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
    return this.frontendConfigFrom(workspaceId, await this.serviceFrameFor(workspaceId, block))
  }

  /**
   * {@link resolveFrontendConfig} against an ALREADY-resolved service frame — the shape
   * {@link buildContext} calls with the shared frame so the ancestry walk isn't repeated.
   */
  private async frontendConfigFrom(
    workspaceId: string,
    frame: Block | null,
  ): Promise<AgentRunContext['frontend'] | undefined> {
    const resolution = await this.frontendResolutionFrom(workspaceId, frame)
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
   * The one IO step ({@link EnvironmentProvisioningService.listHandles}) shared by the frontend
   * agent-context resolution and the run-info projection, against an ALREADY-resolved service
   * frame. Only a `type: 'frontend'` frame carrying a `frontendConfig` yields a result; every
   * other frame returns undefined. The live env URLs are read ONCE and indexed by service-frame
   * id (no per-binding point read), so this is a single query regardless of binding count.
   */
  private async frontendResolutionFrom(
    workspaceId: string,
    frame: Block | null,
  ): Promise<{ config: FrontendConfig; liveServiceEnvUrls: Map<string, string> } | undefined> {
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
    return this.frontendResolutionFrom(workspaceId, await this.serviceFrameFor(workspaceId, block))
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
   * The EFFECTIVE task description an agent step actually runs against: the incorporated
   * requirements doc when one exists, else the clarified bug report, else the block's raw
   * description — the SAME resolution {@link buildContext} folds in (see the `reworked`
   * substitution). Reviews are only ever run on task blocks, so a frame/module resolves to its
   * own description. Exposed so the fork-decision chat responder grounds on the same brief every
   * agent sees, rather than re-deriving it.
   */
  async resolveEffectiveDescription(workspaceId: string, block: Block): Promise<string> {
    return (await this.resolveSubstituteDescription(workspaceId, block)) ?? block.description ?? ''
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
   * Resolve the best-practice fragments to fold into a step's system prompt. Fragments reach an
   * agent ONLY when its kind carries the `code-aware` trait (technical standards) OR the
   * `doc-aware` trait (document writing-style fragments); a kind carrying neither returns null so
   * `composeBlockSystemPrompt` falls back to the block's own `fragmentIds` unchanged.
   *
   * A TASK owns its fragment selection outright: its inheritance from the service is materialised
   * onto `block.fragmentIds` at creation (see `BoardService.addTask`), so the service's fragments
   * are NOT re-unioned here — that is what lets a per-task removal actually take effect. Only a
   * FRAME-level run (e.g. `blueprints` on the service itself) folds in the service's own
   * `serviceFragmentIds` (there `serviceFrame === block`), so the service's standards still govern
   * the frame's own agents. Ids are deduped, service-then-block order, resolved against the
   * universal pool. Records the selected ids on the step for observability; never throws (a lookup
   * failure degrades to the block pins).
   *
   * The selection is recorded through {@link StepObservations}, which is also the only reason the
   * step is reachable from here; the fold itself is unaffected, so a resolution that records
   * nothing still gets the fragments it would have run with.
   *
   * `dispatch` carries the two per-RUN facts (as opposed to the block/kind identity above):
   * `executionId` for the resolver's own telemetry, and `hasDesignContext`, which adds the
   * design-context guidance for a run that actually carries a design document (see
   * {@link withDesignContextFragment}). The latter is a PROMISE because linked context resolves in the
   * same read wave as this — see {@link linkedContextWithDesignFlag} for why that is the cheap shape.
   */
  private async resolveFragments(
    workspaceId: string,
    agentKind: string,
    observations: StepObservations,
    block: Block,
    serviceFrame: Block | null,
    dispatch: { executionId: string; hasDesignContext: Promise<boolean> },
  ): Promise<{ fragments: { id: string; title?: string; body: string; brief?: string }[] } | null> {
    // Recorded per dispatch, so it always reflects the kind that actually ran. A step
    // reused across dispatches (a gate/tester host, then its code-aware helper, then a
    // re-test) must not keep reporting a prior round's fragments: a non-code-aware kind
    // receives none, so clear it here rather than leaving a stale selection behind.
    if (
      !hasTrait(agentKind, CODE_AWARE_TRAIT, this.deps.agentKindRegistry) &&
      !hasTrait(agentKind, DOC_AWARE_TRAIT, this.deps.agentKindRegistry)
    ) {
      observations.fragmentIds(undefined)
      return null
    }
    try {
      // The applicable fragment ids for this block — the shared, task-authoritative rule (a task
      // folds only its own `fragmentIds`; only a frame-level run re-unions the service's
      // `serviceFragmentIds`, where `serviceFrame === block`). Kept in one kernel helper so this
      // and the requirements-review grounding can't drift.
      const ids = withDesignContextFragment(
        applicableFragmentIds(block, serviceFrame),
        await dispatch.hasDesignContext,
      )
      // The verbosity the prompt composer will fold at — resolved HERE, at the same
      // chokepoint that resolves the bodies, because a condensed variant has to be produced
      // for the body that actually won the tier merge. Re-deriving it downstream (where only
      // the id is left) is exactly the "brief travels WITH its body" rule this feature must
      // not break.
      const verbosity = standardsVerbosityFor(agentKind, this.deps.agentKindRegistry)
      // Prefer the tenant-catalog resolver (managed + live document-backed
      // fragments) when wired; otherwise resolve against the static built-in pool.
      const fragments = this.deps.fragmentResolver
        ? await this.deps.fragmentResolver.resolveBodiesForRun(workspaceId, ids, {
            verbosity,
            executionId: dispatch.executionId,
          })
        : ids
            .map((id) => {
              const fragment = getFragment(id)
              // The brief travels WITH the body it condenses — see `ComposableFragment.brief`.
              return fragment
                ? {
                    id,
                    title: fragment.title,
                    body: fragment.body,
                    ...(fragment.brief ? { brief: fragment.brief } : {}),
                  }
                : null
            })
            .filter(
              (f): f is { id: string; title: string; body: string; brief?: string } => f !== null,
            )
      // Re-recorded per dispatch — including clearing it when a re-dispatch resolves to
      // nothing (the selection was emptied between rounds), so the step never keeps
      // reporting fragments a later round no longer received.
      observations.fragmentIds(fragments.length ? fragments.map((f) => f.id) : undefined)
      if (fragments.length === 0) return null
      return { fragments }
    } catch {
      // Resolution must never wedge a run; fall back to the block's own pins. Clear any
      // stale selection so observability doesn't keep reporting a prior round's fragments
      // that this dispatch did not actually inject.
      observations.fragmentIds(undefined)
      return null
    }
  }

  /**
   * Resolve the consensus config this dispatch runs under, applying the step's TIER SET when
   * it names one.
   *
   * A step either authors its panel inline (unchanged: the config is passed through for the
   * executor to gate) or names a set of workspace consensus GROUPS, each with its own estimate
   * bar. In the second case the groups are read in ONE batched query and
   * {@link selectConsensusGroup} picks the most demanding tier the task's estimate clears; its
   * panel is materialised onto the config and the tier is stamped for the transcript.
   *
   * Resolving here rather than in the consensus executor is what keeps the library out of the
   * optional package: the executor stays a pure ConsensusStepConfig consumer that need not know
   * a group store exists, and the container/inline paths see one already-decided config.
   *
   * Three ways this yields NO consensus, all meaning "run the standard single-actor agent":
   * the step isn't consensus-enabled, no tier cleared the estimate, or the library isn't wired
   * on this deployment while the step names only groups (which would otherwise dispatch a panel
   * with zero participants). Returns the spread-ready slice, like the sibling resolvers.
   */
  private async resolveConsensusConfig(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
  ): Promise<{ consensus?: ConsensusStepConfig }> {
    const config = step.consensus
    // A step with consensus switched OFF carries no consensus at all, rather than passing the
    // disabled config through for the executor to reject. The executor's own `enabled` check
    // makes the two equivalent for dispatch, and dropping it is what lets everything downstream
    // read `context.consensus` as "this dispatch runs a panel" — which the repo-op layer now
    // does to decide whether the agent it prepares context for will have a checkout.
    if (!config?.enabled) return {}
    const groupIds = config.groupIds ?? []
    if (!groupIds.length) return { consensus: config }
    // A step that names ONLY groups has no usable inline panel, so an unwired library must not
    // silently degrade to the two-participant backstop — it degrades to the standard agent.
    if (!this.deps.consensusGroups) return {}
    const groups = await this.deps.consensusGroups.listByIds(workspaceId, groupIds)
    const selected = selectConsensusGroup(groups, block.estimate)
    if (!selected) return {}
    return { consensus: applyConsensusGroup(config, selected) }
  }

  /**
   * The CATALOG-backed slices of a dispatch's context — the foundational-services pair and the
   * binary-output brief — plus their declaration read-backs, extracted as the cohesive
   * {@link CatalogRunContext} collaborator. The two `record*` delegates below stay PUBLIC here
   * because the completion hub reaches them through the builder, which handed the agent its
   * catalog context in the first place.
   *
   * Built ONCE and memoised: it is stateless and its four entry points are reached on every
   * dispatch (twice inside one `Promise.all`) and every settlement, so re-deriving the
   * optional-spread deps each time was allocation with no purpose — and a collaborator rebuilt
   * per call invites someone to give it per-call state it cannot keep.
   */
  private catalogRunContext?: CatalogRunContext

  private catalogContext(): CatalogRunContext {
    this.catalogRunContext ??= new CatalogRunContext({
      agentKindRegistry: this.deps.agentKindRegistry,
      ...(this.deps.foundationalServiceResolver
        ? { foundationalServiceResolver: this.deps.foundationalServiceResolver }
        : {}),
      ...(this.deps.binaryGeneratorSource
        ? { binaryGeneratorSource: this.deps.binaryGeneratorSource }
        : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    })
    return this.catalogRunContext
  }

  recordFoundationalDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return this.catalogContext().recordFoundationalDeclaration(workspaceId, step, output)
  }

  recordBinaryOutputDeclaration(
    workspaceId: string,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<void> {
    return this.catalogContext().recordBinaryOutputDeclaration(workspaceId, step, output)
  }

  /**
   * Resolve the skills this dispatch applies — the agent KIND's declared playbooks plus a `skill`
   * step's own picked skill — and PIN each catalog skill's version onto the step
   * (`step.skillVersions`), so the run records exactly which skills (and at which commit/blob)
   * ran. Delegates to {@link resolveRunSkills}, which owns the precedence, the dedup and the
   * per-source failure policy; a kind with no declarations and a step with no pick costs nothing.
   */
  private resolveSkillsForStep(
    workspaceId: string,
    agentKind: string,
    step: PipelineStep,
  ): Promise<{ skills: ResolvedSkill[]; versions: SkillVersionPin[] }> {
    return resolveRunSkills({
      workspaceId,
      agentKind,
      step,
      agentKindRegistry: this.deps.agentKindRegistry,
      ...(this.deps.skillResolver ? { skillResolver: this.deps.skillResolver } : {}),
      ...(this.deps.logger ? { logger: this.deps.logger } : {}),
    })
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
   * Resolve the block's linked context (attachments UNION the references its description names)
   * through the shared {@link resolveLinkedContextFor} — the same resolver the initiative-planning
   * interviewer uses, so an inline planning step and a container one can never disagree about what
   * a human attached.
   */
  private resolveLinkedContext(
    workspaceId: string,
    blockId: string,
    description: string,
    opts: { includeLinked: boolean },
  ): Promise<LinkedContext> {
    return resolveLinkedContextFor(
      {
        ...(this.deps.documents ? { documents: this.deps.documents } : {}),
        ...(this.deps.tasks ? { tasks: this.deps.tasks } : {}),
        ...(this.deps.documentUrlResolver
          ? { documentUrlResolver: this.deps.documentUrlResolver }
          : {}),
        ...(this.deps.documentRefresher ? { refresher: this.deps.documentRefresher } : {}),
        ...(this.deps.logger ? { logger: this.deps.logger } : {}),
      },
      workspaceId,
      blockId,
      description,
      opts,
    )
  }

  /**
   * Resolve the live ephemeral environment provisioned for the running block
   * into compact agent context. A no-op unless the environment integration is
   * wired (the provisioning service is an optional dependency), so the engine
   * stays unchanged when it is off.
   */
  private async resolveEnvironment(workspaceId: string, block: Block, serviceFrame: Block | null) {
    if (!this.deps.environmentProvisioning) return null
    // Resolve the OWN service frame's env specifically: a task can provision several envs (its own
    // frame's plus each involved-service frame's), all under this block, so a plain block read
    // could surface a peer's. The own env is the one the running task's agent/tester targets. The
    // frame is the one `buildContext` already walked to (threaded in), not a fresh ancestry walk.
    const frameId = serviceFrame?.id ?? undefined
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
