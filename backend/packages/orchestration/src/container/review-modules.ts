import { applicableFragmentIds, resolveServiceFrameBlock } from '@cat-factory/kernel'
import { getFragment } from '@cat-factory/prompt-fragments'
import { RequirementReviewService } from '../modules/requirements/RequirementReviewService.js'
import { ClarityReviewService } from '../modules/clarity/ClarityReviewService.js'
import { BrainstormService } from '../modules/brainstorm/BrainstormService.js'
import type { NotificationService } from '../modules/notifications/NotificationService.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'
import type { CoreDependencies, FragmentLibraryModule } from '../container.js'
import type { BrainstormModule, ClarityModule, RequirementsModule } from './module-shapes.js'
import { resolveBlockRunContext } from './blockRunContext.js'

// The INLINE ITERATIVE-REVIEW modules: the requirements reviewer (+ its Requirement Writer), the
// bug-report clarity reviewer, and the two brainstorm dialogue stages.
//
// Extracted from `modules.ts` as one cohesive group because they are the same machine three times
// over — all four services extend `IterativeReviewService`, all resolve their model identically
// (block pin > workspace per-kind default > the requirements reviewer's routing default), and all
// now take the same prompt-override resolver — so a change to how an inline reviewer is wired
// touches exactly this file.

/**
 * The workspace's live system prompt for an agent kind, or undefined to run the shipped one — the
 * same append-only revision log the engine reads per dispatch (`AgentPromptService.head`), reaching
 * the INLINE review kinds, which were the one prompt-assembly path that ignored it entirely.
 *
 * A null `text` on the head revision is the deliberate "back to the built-in" state, so it reads as
 * no override — exactly as it does on the dispatch path. Unwired (a facade without the module) ⇒
 * every kind runs its shipped prompt, unchanged.
 */
function resolveInlinePromptOverride(
  deps: CoreDependencies,
): ((workspaceId: string, agentKind: string) => Promise<string | undefined>) | undefined {
  const repository = deps.agentPromptRepository
  if (!repository) return undefined
  return async (workspaceId, agentKind) =>
    (await repository.head(workspaceId, agentKind))?.text ?? undefined
}

export function createRequirementsModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
  fragmentLibrary?: FragmentLibraryModule,
): RequirementsModule | undefined {
  const { requirementReviewRepository } = deps
  if (!requirementReviewRepository) return undefined

  const service = new RequirementReviewService({
    requirementReviewRepository,
    blockRepository: deps.blockRepository,
    resolveSystemPromptOverride: resolveInlinePromptOverride(deps),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    // Tell product people + the task creator to react to a review's findings (when
    // the notifications subsystem is wired). Best-effort; absent → no notification.
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    // The reviewer runs during a parked run, so its execution + initiator come from the
    // block's active run — threaded into the model scope so an inline subscription ref served
    // through a leased per-run activation (local container inline backend) can lease it.
    resolveRunContext: resolveBlockRunContext(deps),
    documentRepository: deps.documentRepository,
    taskRepository: deps.taskRepository,
    // The Requirement Writer (second companion) grounds recommendations on the run's repo
    // (`spec/` + `tech-spec/` via the checkout-free RepoFiles) — wired in all three facades.
    resolveRunRepoContext: deps.resolveRunRepoContext,
    // …and on the block's best-practice fragments (team/org standards), checked FIRST. Uses the
    // SAME task-authoritative rule as the agent context builder (the shared `applicableFragmentIds`
    // helper): a task grounds on its OWN `fragmentIds` only — a per-task removal must stick here too
    // — while a frame-level review re-unions the service's `serviceFragmentIds`. Resolved against
    // the merged tenant catalog when the fragment library is wired (so managed + document-backed
    // fragments ground the review exactly like they reach a code-aware run), else the static pool.
    resolveBlockFragments: async (workspaceId: string, blockId: string) => {
      const block = await deps.blockRepository.get(workspaceId, blockId)
      if (!block) return []
      const serviceFrame = await resolveServiceFrameBlock(
        (id) => deps.blockRepository.get(workspaceId, id),
        blockId,
        block,
      )
      const ids = applicableFragmentIds(block, serviceFrame)
      if (fragmentLibrary) {
        // Resolve the merged tenant catalog ONCE and reuse it for both the titles map and
        // the body resolution (which would otherwise re-resolve the same catalog).
        const catalog = await fragmentLibrary.libraryService.resolveCatalog(workspaceId)
        const titles = new Map(catalog.map((e) => [e.id, e.title]))
        // Reviewer grounding reads the FULL standards (the default verbosity): a review
        // judges built work against what the standard actually says, which is the same
        // reason reviewer kinds never fold a brief.
        const bodies = await fragmentLibrary.libraryService.resolveBodiesForRun(workspaceId, ids, {
          catalog,
        })
        return bodies.map(({ id, body }) => ({ id, title: titles.get(id) ?? id, body }))
      }
      const out: { id: string; title: string; body: string }[] = []
      for (const id of ids) {
        const fragment = getFragment(id)
        if (fragment) out.push({ id, title: fragment.title, body: fragment.body })
      }
      return out
    },
    // `webSearch` (gateway-RAG) is wired by the web-search-connection workstream; until then
    // the Writer still gets provider-hosted web search on Anthropic/OpenAI models.
    // When an upstream `requirements-brainstorm` dialogue settled a converged direction, the
    // reviewer critiques THAT (the refined requirements) instead of the raw description.
    resolveBrainstormDirection: deps.brainstormSessionRepository
      ? async (workspaceId: string, blockId: string) => {
          const session = await deps.brainstormSessionRepository!.getByBlockStage(
            workspaceId,
            blockId,
            'requirements',
          )
          return session?.status === 'incorporated' && session.convergedDirection
            ? session.convergedDirection
            : undefined
        }
      : undefined,
  })
  return { service }
}

/**
 * Assemble the brainstorm (structured-dialogue) module when its repository is present (both
 * runtime facades wire it unconditionally). Mirrors {@link createClarityModule}: it builds ONE
 * {@link BrainstormService} per stage (sharing the repository) and reuses the requirements
 * reviewer's model config since all the inline reviewers resolve their model identically. The
 * architecture stage seeds from the refined requirements (a requirements review's incorporated
 * doc, else the requirements-brainstorm's converged direction).
 */
export function createBrainstormModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): BrainstormModule | undefined {
  const { brainstormSessionRepository } = deps
  if (!brainstormSessionRepository) return undefined

  // The architecture stage's seed: the most refined requirements available — a settled
  // requirements review's incorporated doc, else the requirements-brainstorm's direction.
  const resolveRefinedRequirements = async (
    workspaceId: string,
    blockId: string,
  ): Promise<string | undefined> => {
    const review = await deps.requirementReviewRepository?.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.incorporatedRequirements) {
      return review.incorporatedRequirements
    }
    const session = await brainstormSessionRepository.getByBlockStage(
      workspaceId,
      blockId,
      'requirements',
    )
    return session?.status === 'incorporated' && session.convergedDirection
      ? session.convergedDirection
      : undefined
  }

  const common = {
    brainstormSessionRepository,
    blockRepository: deps.blockRepository,
    resolveSystemPromptOverride: resolveInlinePromptOverride(deps),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    // Brainstorm stages are pipeline gate steps that run during a parked run, so their
    // execution + initiator come from the block's active run — threaded into the model scope
    // so an inline subscription ref served through a leased per-run activation (local container
    // inline backend) can lease it, exactly like the requirements/clarity reviewers.
    resolveRunContext: resolveBlockRunContext(deps),
  }

  return {
    services: {
      requirements: new BrainstormService({ ...common, stage: 'requirements' }),
      architecture: new BrainstormService({
        ...common,
        stage: 'architecture',
        resolveRefinedRequirements,
      }),
    },
  }
}

/**
 * Assemble the clarity-review module when its repository is present (both runtime facades
 * wire it unconditionally). Mirrors {@link createRequirementsModule}: it reuses the
 * requirements reviewer's model config (the same routing default) since both reviewers
 * resolve their model identically.
 */
export function createClarityModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): ClarityModule | undefined {
  const { clarityReviewRepository } = deps
  if (!clarityReviewRepository) return undefined

  const service = new ClarityReviewService({
    clarityReviewRepository,
    blockRepository: deps.blockRepository,
    resolveSystemPromptOverride: resolveInlinePromptOverride(deps),
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
  return { service }
}
