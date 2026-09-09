import type { WorkspaceService } from '@cat-factory/workspaces'
import type { SpendService } from '@cat-factory/spend'
import type { TaskSourceKind } from '@cat-factory/contracts'
import { AssistantService } from '../modules/assistant/AssistantService.js'
import {
  type AssistantIssueDeps,
  type AssistantIssueMatch,
  type AssistantRepoDeps,
  createAssistantActions,
} from '../modules/assistant/actions/index.js'
import type { BoardService } from '../modules/board/BoardService.js'
import type { CoreDependencies, TasksModule } from '../container.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'

// ---------------------------------------------------------------------------
// The in-app assistant's wiring: where the board writes, the repository projection and the tracker
// integration are joined into the catalog one turn routes against.
//
// This is the ONE place the three halves meet, and that is deliberate. An action performs the same
// operation as the board's own button, so it holds the bound method rather than the service; the
// composition root is where a board write (this package) and a tracker read (the integrations
// package) can be handed to the same object without either module reaching across the seam.
//
// Every group past the board is CONDITIONAL, and an unwired one drops its action from the catalog
// rather than registering a member that fails when chosen: the catalog is what the model routes
// against, so a deployment with no VCS integration should decline "add this repository" as
// something it does not do, not accept it and then 503.
// ---------------------------------------------------------------------------

export interface AssistantModule {
  service: AssistantService
}

export interface AssistantModuleInput {
  dependencies: CoreDependencies
  workspaceService: WorkspaceService
  boardService: BoardService
  /** The task-source integration, when configured; absent ⇒ no issue can be filed as a task. */
  tasks: TasksModule | undefined
  /** The workspace budget safeguard a turn's billable model call answers to. */
  spend: SpendService
}

/**
 * Assemble the assistant. Always built: the board actions need nothing beyond the board itself,
 * and a deployment with no model wired reports `available: false` through the capability read
 * rather than being absent, so the SPA can say WHY the prompt box is not offered.
 */
export function createAssistantModule(input: AssistantModuleInput): AssistantModule {
  const { dependencies, workspaceService, boardService, tasks, spend } = input
  const repos = repoDeps(dependencies, boardService)
  return {
    service: new AssistantService({
      actions: createAssistantActions({
        board: {
          listBoardBlocks: (workspaceId) => workspaceService.boardBlocks(workspaceId),
          updateBlock: (workspaceId, id, patch, editor) =>
            boardService.updateBlock(workspaceId, id, patch, editor),
        },
        ...(repos ? { repos } : {}),
        ...(tasks ? { issues: issueDeps(tasks) } : {}),
      }),
      modelProviderResolver: dependencies.modelProviderResolver,
      modelProvider: dependencies.modelProvider,
      // The routing default, the block-model resolver, the local-mode inline predicate, and the
      // preset's per-kind default model + route order, wired as ONE slice (see the factory).
      ...inlineModelResolutionDeps(dependencies),
      // The same tiered guard `RunAdmission` applies before a run: a turn is a billable model call
      // that no run start gates, exactly like the bug hunt's ranking and the monorepo survey.
      isOverBudget: (workspaceId) => spend.isOverBudget(workspaceId),
      ...(dependencies.logger ? { logger: dependencies.logger } : {}),
    }),
  }
}

/** The repository half, present only when a VCS integration projected repositories to read. */
function repoDeps(
  dependencies: CoreDependencies,
  boardService: BoardService,
): AssistantRepoDeps | undefined {
  const { repoProjectionRepository, serviceRepository } = dependencies
  if (!repoProjectionRepository || !serviceRepository) return undefined
  return {
    listRepos: (workspaceId) => repoProjectionRepository.list(workspaceId),
    addServiceFromRepo: (workspaceId, input) => boardService.addServiceFromRepo(workspaceId, input),
    listServicesForFrames: (frameBlockIds) => serviceRepository.listByFrameBlocks(frameBlockIds),
  }
}

/** The tracker half: which sources recognise a URL, the import, and the task it becomes. */
function issueDeps(tasks: TasksModule): AssistantIssueDeps {
  return {
    matchIssueSources: async (workspaceId, ref) => {
      // Asked of every ENABLED source rather than guessed from the URL's host: which tracker a
      // reference belongs to is the providers' own judgement (a self-managed GitLab is on the
      // deployment's domain, and a bare key is both a Jira and a Linear identifier), and a host
      // table here would be a second, silently drifting copy of `parseRef`.
      const matches: AssistantIssueMatch[] = []
      for (const provider of tasks.registry.list()) {
        const source: TaskSourceKind = provider.descriptor.source
        if (!(await tasks.connectionService.isEnabled(workspaceId, source))) continue
        const externalId = provider.parseRef(ref)
        if (externalId) matches.push({ source, externalId })
      }
      return matches
    },
    importIssue: (workspaceId, source, ref) => tasks.importService.import(workspaceId, source, ref),
    createTaskFromIssue: (request) => tasks.linkService.createTaskFromIssue(request),
  }
}
