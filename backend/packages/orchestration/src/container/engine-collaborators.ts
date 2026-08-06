/**
 * The engine's pre-construction collaborators, extracted verbatim from `createCore` (no behaviour
 * change): the initiative + interactive-planning services, the review/interview surfaces the
 * engine's gate steps drive (requirements, clarity, brainstorm, doc-interview, fork-chat, kaizen)
 * and the task module the `bug-intake` step reads through.
 *
 * The {@link ModuleRegistry} instance is owned by `createCore` and passed in, so every optional
 * module declared here registers in the SAME order it did inline — registration order IS
 * dependency order — and `modules.assemble()` at `createCore`'s return still emits them.
 *
 * The initiative EXECUTION LOOP is built later (it drives the engine), so the terminal-hook poke
 * is returned as a closure over a ref this factory owns; `setInitiativeLoop` late-binds it from
 * `registerEngineDependentModules`, exactly as the inline `initiativeLoopRef` did.
 */

import { InitiativeService } from '../modules/initiative/InitiativeService.js'
import { InitiativeInterviewService } from '../modules/initiative/InitiativeInterviewService.js'
import type { InitiativeLoopService } from '../modules/initiative/InitiativeLoopService.js'
import type { InitiativeRunHarvest } from '../modules/initiative/initiative.logic.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'
import { resolveBlockRunContext } from './blockRunContext.js'
import {
  createBrainstormModule,
  createClarityModule,
  createDocInterviewService,
  createForkChatService,
  createJudgeAssessor,
  createKaizenModule,
  createRequirementsModule,
  createTasksModule,
} from './modules.js'
import type { SpendService } from '@cat-factory/spend'
import type { ModuleRegistry } from './module-registry.js'
import type { BoardService } from '../modules/board/BoardService.js'
import type { createFragmentLibraryModule } from '../container-content-libraries.js'
import type { CoreDependencies, DocumentsModule, NotificationsModule } from '../container.js'
import type { resolveCoreRuntime } from './runtime.js'
import {
  linkedContextSourcesFrom,
  resolveLinkedContext,
} from '../modules/execution/linked-context.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface EngineCollaboratorsInput {
  dependencies: CoreDependencies
  modules: ModuleRegistry
  initiativePresetRegistry: CoreRuntime['initiativePresetRegistry']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  notifications: NotificationsModule | undefined
  fragmentLibrary: ReturnType<typeof createFragmentLibraryModule> | undefined
  /**
   * The document module, for its dispatch-time linked-document refresher. Both inline readers of a
   * block's attachments take it, for one reason: an inline step that resolves the same linked
   * context a later dispatch will must re-confirm it the same way, or it reasons about a revision
   * the build no longer matches. The initiative INTERVIEWER is one; the REQUIREMENTS REVIEW is the
   * other, and the more consequential, being the first step of the default pipelines and the one a
   * human signs off on.
   */
  documents: DocumentsModule | undefined
  boardService: BoardService
  /** The spend safeguard, so the bug hunt's billable ranking honours the same budget a run does. */
  spend: SpendService
}

export function createEngineCollaborators(input: EngineCollaboratorsInput) {
  const {
    dependencies,
    modules,
    initiativePresetRegistry,
    executionEventPublisher,
    notifications,
    fragmentLibrary,
    boardService,
    spend,
  } = input
  // Built before the execution engine so the planning pipeline's plan ingest + the
  // committer step's tracker mirror can run through it.
  const initiativeService = dependencies.initiativeRepository
    ? new InitiativeService({
        workspaceRepository: dependencies.workspaceRepository,
        blockRepository: dependencies.blockRepository,
        initiativeRepository: dependencies.initiativeRepository,
        initiativePresetRegistry,
        events: executionEventPublisher,
        clock: dependencies.clock,
        idGenerator: dependencies.idGenerator,
        // Validate the plan's pipeline ids at ingest (fail a plan that names a missing pipeline
        // loudly during planning, rather than surfacing it as a per-item spawn deviation later).
        pipelineRepository: dependencies.pipelineRepository,
      })
    : undefined
  // The interactive-planning interviewer's inline LLM (slice 2). Resolves its model exactly
  // like the requirements reviewer — the routing default, honouring a block pin and the
  // workspace's model preset for the `initiative-interviewer` kind — so it needs no dedicated
  // facade wiring. `enabled` gates it: with no model provider the interviewer gate passes
  // through and planning runs off the raw block description.
  const initiativeInterviewService = new InitiativeInterviewService({
    initiativePresetRegistry,
    modelProviderResolver: dependencies.modelProviderResolver,
    modelProvider: dependencies.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(dependencies),
    resolveRunContext: resolveBlockRunContext(dependencies),
    // The initiative's attached requirements / RFCs / issues. Wired from the same repositories and
    // URL canonicaliser `AgentContextBuilder` reads, so the interviewer sees exactly what the
    // analyst and planner will — including anything the brief names outright, which is why the
    // description is threaded through. `includeLinked` is unconditionally true: the
    // reworked-description path it guards is task-only, and an initiative block never has one.
    resolveLinkedContext: (workspaceId, blockId, description) =>
      resolveLinkedContext(
        linkedContextSourcesFrom({
          ...dependencies,
          documentRefresher: input.documents?.linkedRefresher,
        }),
        workspaceId,
        blockId,
        description,
        {
          includeLinked: true,
        },
      ),
  })
  // Built before the execution engine so the special `requirements-review` gate step can
  // drive the inline reviewer + the iterative answer → incorporate → re-review loop.
  const requirements = modules.build('requirements', () =>
    createRequirementsModule(
      dependencies,
      notifications?.service,
      fragmentLibrary,
      input.documents?.linkedRefresher,
    ),
  )
  const docInterview = createDocInterviewService(dependencies)
  const forkChat = createForkChatService(dependencies)
  // The judge assessor rides the same inline model deps as the reviewers, so a facade that
  // wired a model gets working judges with no judge-specific wiring (see the tracker's D-notes).
  const judgeAssessor = createJudgeAssessor(dependencies)
  const clarity = modules.build('clarity', () =>
    createClarityModule(dependencies, notifications?.service),
  )
  const brainstorm = modules.build('brainstorm', () =>
    createBrainstormModule(dependencies, notifications?.service),
  )
  // Built before the execution engine so the engine's terminal hook can schedule a
  // post-run Kaizen grading for each completed agent step.
  const kaizen = modules.build('kaizen', () => createKaizenModule(dependencies))

  // Late-bound so the engine's terminal hooks can poke the execution loop, which is built AFTER
  // the engine (the loop depends on `executionService.start`). Fire-and-forget; a null ref (the
  // loop unwired, or the settled block not part of an initiative) is a no-op.
  let initiativeLoopRef: InitiativeLoopService | undefined
  const pokeInitiativeLoop = (
    workspaceId: string,
    initiativeBlockId: string,
    harvest?: InitiativeRunHarvest,
  ): void => {
    void initiativeLoopRef?.pokeForInitiativeBlock(workspaceId, initiativeBlockId, harvest)
  }

  // Built before the execution engine so the engine's `bug-intake` step can drive the
  // read-and-claim intake helper (`tasks.bugIntakeService`). Also feeds the recurring module's
  // schedule intake-config validation below.
  const tasks = modules.build('tasks', () => createTasksModule(dependencies, boardService, spend))

  return {
    initiativeService,
    initiativeInterviewService,
    requirements,
    docInterview,
    forkChat,
    judgeAssessor,
    clarity,
    brainstorm,
    kaizen,
    tasks,
    pokeInitiativeLoop,
    /** Late-bind the initiative execution loop once the engine-dependent modules build it. */
    setInitiativeLoop: (loop: InitiativeLoopService | undefined) => {
      initiativeLoopRef = loop
    },
  }
}
