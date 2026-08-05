/**
 * The modules that depend on the ASSEMBLED execution engine, extracted verbatim from `createCore`
 * (no behaviour change): they drive `executionService` (bootstrap's post-run blueprint start, the
 * recurring scheduler) or feed the late-bound initiative loop. Registration order is preserved —
 * it IS dependency order for the {@link ModuleRegistry} — and the last registration late-binds the
 * initiative loop through `setInitiativeLoop` so the engine's terminal poke resolves it.
 */

import { InitiativeLoopService } from '../modules/initiative/InitiativeLoopService.js'
import type { InitiativeService } from '../modules/initiative/InitiativeService.js'
import { BLUEPRINT_PIPELINE_ID } from '@cat-factory/kernel'
import {
  createBootstrapModule,
  createGitHubModule,
  createRecurringModule,
  createRunnersModule,
  createServicesModule,
  createTrackerModule,
  createTrackerWebhookModule,
} from './modules.js'
import type { ModuleRegistry } from './module-registry.js'
import type { createEnvironmentsModule, createTasksModule } from './modules.js'
import type { ExecutionService } from '../modules/execution/ExecutionService.js'
import { makeExternalMergeObserver } from '../modules/merge/externalMergeObserver.js'
import type { CoreDependencies } from '../container.js'
import type { MergeTrackRecordModule, NotificationsModule } from './module-shapes.js'
import type { resolveCoreRuntime } from './runtime.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface EngineDependentModulesInput {
  dependencies: CoreDependencies
  modules: ModuleRegistry
  caches: CoreRuntime['caches']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  executionService: ExecutionService
  environments: ReturnType<typeof createEnvironmentsModule> | undefined
  tasks: ReturnType<typeof createTasksModule> | undefined
  notifications: NotificationsModule | undefined
  /**
   * The merge track record, when wired: the VCS webhook ingest attributes an externally-merged PR
   * through it (and raises the reviewer-effort nudge). Absent ⇒ the observer is not wired and an
   * external merge leaves the record as it was.
   */
  mergeTrackRecords: MergeTrackRecordModule | undefined
  initiativeService: InitiativeService | undefined
  setInitiativeLoop: (loop: InitiativeLoopService | undefined) => void
}

export function registerEngineDependentModules(input: EngineDependentModulesInput): void {
  const {
    dependencies,
    modules,
    caches,
    executionEventPublisher,
    executionService,
    environments,
    tasks,
    notifications,
    mergeTrackRecords,
    initiativeService,
    setInitiativeLoop,
  } = input
  const externalMergeObserver = mergeTrackRecords
    ? makeExternalMergeObserver({
        trackRecord: mergeTrackRecords.service,
        notifications: notifications?.service,
      })
    : undefined
  modules.build('github', () => createGitHubModule(dependencies, caches, externalMergeObserver))
  modules.build('runners', () => createRunnersModule(dependencies))
  // After a bootstrap succeeds, map the new repo into a blueprint + the board by
  // starting the blueprint-only pipeline against the service frame.
  modules.build('bootstrap', () =>
    createBootstrapModule(dependencies, executionEventPublisher, (ws, blockId) =>
      executionService.start(ws, blockId, BLUEPRINT_PIPELINE_ID).then(() => undefined),
    ),
  )
  modules.build('tracker', () => createTrackerModule(dependencies))
  modules.build('recurring', () =>
    createRecurringModule(
      dependencies,
      executionService,
      executionEventPublisher,
      tasks?.connectionService,
      tasks,
    ),
  )
  // Inbound tracker webhooks. Built LAST of the intake modules because it composes the two
  // surfaces above it — the recurring scheduler (a qualifying issue event fires a schedule) and
  // the engine's review actions (a ticket reply drives the parked requirements or clarity
  // review) — so it must see both already assembled. `modules.get` rather than a local, because
  // `recurring` is itself registered through the registry just above.
  modules.build('trackerWebhook', () =>
    createTrackerWebhookModule(dependencies, {
      tasks,
      recurring: modules.get('recurring'),
      requirements: modules.get('requirements'),
      clarity: modules.get('clarity'),
      executionService,
    }),
  )
  // The env-config-repair module is a sub-module of `environments` — surfaced as its own top-level
  // `Core.envConfigRepair` key. Registered here (not in the `environments` build above) so it emits
  // through the same registry rather than a bespoke return spread.
  modules.build('envConfigRepair', () => environments?.envConfigRepair)
  // Close the PR verification report's environment-lifecycle proof. The teardown that completes
  // it happens on the TTL sweep, long after the run's last step settled and therefore long after
  // the settlement hook stopped firing, so the report is re-published from the teardown itself.
  // Fires on a FAILED attempt too, which is how an environment the provider refuses to reclaim
  // reaches the PR as an operator's job rather than as one nobody has got to yet.
  // Late-bound here for the ordering reason this whole module exists: the teardown service is
  // built with the environments module, before the engine that owns the report.
  environments?.teardownService.setTeardownRecordedHook(async (record) => {
    if (!record.executionId) return
    await executionService.refreshVerificationReport(record.workspaceId, record.executionId)
  })
  // Observability + per-account settings that a facade builds and passes through on the deps bag.
  modules.build('agentContextObservability', () => dependencies.agentContextObservability)
  modules.build('searchQueryObservability', () => dependencies.searchQueryObservability)
  modules.build('vcsConnectionService', () => dependencies.vcsConnectionService)
  modules.build('accountSettings', () =>
    dependencies.accountSettings ? { service: dependencies.accountSettings } : undefined,
  )
  // The initiative EXECUTION LOOP (slice 3): built after the engine (it drives
  // `executionService.start` to spawn tasks), then late-bound into the terminal poke above so a
  // settling child run advances its owning initiative immediately. Present only when initiatives
  // are wired; the cron/interval sweepers call `loop.runDue`.
  const initiativeLoop =
    initiativeService && dependencies.initiativeRepository
      ? new InitiativeLoopService({
          initiativeRepository: dependencies.initiativeRepository,
          initiativeService,
          blockRepository: dependencies.blockRepository,
          pipelineRepository: dependencies.pipelineRepository,
          executionService,
          events: executionEventPublisher,
          clock: dependencies.clock,
          idGenerator: dependencies.idGenerator,
          notificationService: notifications?.service,
          resolveRunRepoContext: dependencies.resolveRunRepoContext,
          serviceRepository: dependencies.serviceRepository,
          // Every tick is isolated and swallowed, so without this a permanently-failing
          // initiative is indistinguishable from an idle one.
          logger: dependencies.logger,
        })
      : undefined
  setInitiativeLoop(initiativeLoop)
  modules.build('initiatives', () =>
    initiativeService && initiativeLoop
      ? { service: initiativeService, loop: initiativeLoop }
      : undefined,
  )
  modules.build('services', () => createServicesModule(dependencies))
}
