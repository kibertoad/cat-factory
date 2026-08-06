/**
 * The platform slice of `createCore`, extracted verbatim (no behaviour change): the optional
 * modules built AFTER the foundation but BEFORE the engine collaborators — observability
 * (LLM + platform metrics), the provisioning event log, the infrastructure chain
 * (preflight → shared stacks → environments → the deployment-declared handler seeder), and the
 * content chain (documents → fragment library → skill library).
 *
 * Registration order is preserved — it IS dependency order for the {@link ModuleRegistry}, and
 * two of the chains are order-sensitive beyond that: preflight is built before shared stacks +
 * environments (a recipe's `prerequisites` re-run through it), and documents before the fragment
 * library (a document-backed fragment re-resolves through the document module's reader).
 *
 * Returns only what the engine downstream consumes; `preflight`, `sharedStacks` and the
 * provisioning-log recorder are internal to this slice.
 */

import { LlmObservabilityService } from '../modules/observability/LlmObservabilityService.js'
import { PlatformObservabilityService } from '../modules/observability/PlatformObservabilityService.js'
import { ReportsService } from '../modules/reports/ReportsService.js'
import { RunDebugService } from '../modules/debug/RunDebugService.js'
import { ToolCallObservabilityService } from '../modules/observability/ToolCallObservabilityService.js'
import {
  ProvisioningLogRecorder,
  ProvisioningLogService,
  createEnvironmentHandlerSeeder,
  createSharedStackSeeder,
} from '@cat-factory/integrations'
import { DEFAULT_SPEND_PRICING, ratesFor } from '@cat-factory/spend'
import {
  createDocumentsModule,
  createEnvironmentsModule,
  createPreflightModule,
  createSharedStacksModule,
} from './modules.js'
import {
  createFragmentLibraryModule,
  createFoundationalServiceModule,
  createSkillLibraryModule,
} from '../container-content-libraries.js'
import type {
  FoundationalServiceModule,
  FragmentLibraryModule,
  SkillLibraryModule,
} from '../container-content-libraries.js'
import type { ModuleRegistry } from './module-registry.js'
import type { BoardService } from '../modules/board/BoardService.js'
import type { CoreDependencies, DocumentsModule } from '../container.js'
import type { EnvironmentHandlerSeeder, SharedStackSeeder } from '@cat-factory/kernel'
import type { resolveCoreRuntime } from './runtime.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface PlatformModulesInput {
  dependencies: CoreDependencies
  modules: ModuleRegistry
  caches: CoreRuntime['caches']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  boardService: BoardService
  /**
   * Where the catalog's `builtin` tier is read from: this process's own registry, or — on a
   * mothership-mode node — the mothership's over the machine API. Resolved once by
   * `resolveCoreRuntime`.
   */
  foundationalBuiltins: CoreRuntime['foundationalBuiltins']
}

export interface PlatformModules {
  llmObservability: LlmObservabilityService | undefined
  /**
   * Returned (not just registered) because the ENGINE reads one of its seams: the dispatch-time
   * linked-document refresher threads into `AgentContextBuilder`. Undefined when no document source
   * is configured, in which case there is nothing to refresh either.
   */
  documents: DocumentsModule | undefined
  environments: ReturnType<typeof createEnvironmentsModule> | undefined
  environmentHandlerSeeder: EnvironmentHandlerSeeder | undefined
  sharedStackSeeder: SharedStackSeeder | undefined
  fragmentLibrary: FragmentLibraryModule | undefined
  skillLibrary: SkillLibraryModule | undefined
  foundationalServices: FoundationalServiceModule | undefined
}

export function createPlatformModules(input: PlatformModulesInput): PlatformModules {
  const {
    dependencies,
    modules,
    caches,
    executionEventPublisher,
    boardService,
    foundationalBuiltins,
  } = input
  // The price table the run-telemetry rollups are costed against: the DEPLOYMENT base table,
  // deliberately, and its own currency. A workspace may override the budget's currency without
  // overriding the prices (`mergeSpendPricing` keeps the base `prices`), so labelling these
  // amounts with a workspace's currency would put the wrong symbol on unchanged EUR figures.
  const rollupPricing = dependencies.spendPricing ?? DEFAULT_SPEND_PRICING
  const llmObservability = modules.build('llmObservability', () =>
    dependencies.llmCallMetricRepository
      ? new LlmObservabilityService({
          llmCallMetricRepository: dependencies.llmCallMetricRepository,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          recordPrompts: dependencies.recordLlmPrompts ?? true,
          traceSink: dependencies.llmTraceSink,
          workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
          workspaceSettingsCache: caches.workspaceSettings,
          // The trace fan-out is best-effort; without this a sink that rejects every export
          // (a revoked Langfuse key) leaves the deployment exporting nothing, silently.
          logger: dependencies.logger,
          modelRates: (provider, model) => ratesFor(rollupPricing, { provider, model }),
          costCurrency: rollupPricing.currency,
        })
      : undefined,
  )
  modules.build('platformObservability', () =>
    dependencies.platformMetricsRepository
      ? new PlatformObservabilityService({
          platformMetricsRepository: dependencies.platformMetricsRepository,
          gateOutcomeRepository: dependencies.gateOutcomeRepository,
          clock: dependencies.clock,
        })
      : undefined,
  )
  // Cross-cutting usage analytics (the "where does the spend and the work go" dual of the
  // health rollups above). Costs are reported in the DEPLOYMENT's base currency: an
  // account-wide report spans boards that may each override it, so a per-workspace
  // currency would be summing different denominations into one number.
  modules.build('reports', () =>
    dependencies.reportsRepository
      ? new ReportsService({
          reportsRepository: dependencies.reportsRepository,
          clock: dependencies.clock,
          currency: (dependencies.spendPricing ?? DEFAULT_SPEND_PRICING).currency,
        })
      : undefined,
  )
  // The provisioning event log lives in a separate high-churn store. When its
  // repository is wired, build a best-effort recorder (threaded into the env
  // services) + the read service (exposed for the logs controller). The container
  // transports are wrapped with their own recorder in each facade's resolveTransport.
  const provisioningLogRecorder = dependencies.provisioningLogRepository
    ? new ProvisioningLogRecorder({
        repository: dependencies.provisioningLogRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
      })
    : undefined
  modules.build('provisioningLogs', () =>
    dependencies.provisioningLogRepository
      ? {
          service: new ProvisioningLogService({
            repository: dependencies.provisioningLogRepository,
          }),
        }
      : undefined,
  )
  // The tool-call trajectory READ the observability panel drills into. Built from the repository
  // rather than passed down from the facade like the two sibling sinks, for the reason stated on
  // `CoreDependencies.agentToolCallRepository`: those are WRITE services carrying a capture gate
  // and a redaction pass, and a read needs neither. The facades' own recorder instances stay
  // where the write path builds them; a second stateless reader over the same rows cannot
  // disagree with them, where a second CAPTURE GATE could.
  modules.build('toolCallObservability', () =>
    dependencies.agentToolCallRepository
      ? new ToolCallObservabilityService({
          agentToolCallRepository: dependencies.agentToolCallRepository,
          clock: dependencies.clock,
        })
      : undefined,
  )
  // The remote debugging reader (`/api/v1/debug/*`). Built UNCONDITIONALLY, unlike every other
  // module here: its run index and overview need only the execution store, and each telemetry
  // sink it reads is independently optional. Gating the whole surface on any one of them would
  // mean a deployment that retains no agent context also loses the ability to list its runs —
  // and would turn a partially-configured deployment into a 503 the caller cannot interpret,
  // where an `available: false` sink says exactly what is missing.
  modules.build(
    'runDebug',
    () =>
      new RunDebugService({
        executionRepository: dependencies.executionRepository,
        clock: dependencies.clock,
        llmCallMetricRepository: dependencies.llmCallMetricRepository,
        agentContextSnapshotRepository: dependencies.agentContextSnapshotRepository,
        agentSearchQueryRepository: dependencies.agentSearchQueryRepository,
        agentToolCallRepository: dependencies.agentToolCallRepository,
        provisioningLogRepository: dependencies.provisioningLogRepository,
        // Bound to the SAME priced fold the board rollups read, so the debug overview and a
        // step's metrics bar can never quote different money for one run.
        priceRollup: llmObservability
          ? (workspaceId, executionId) =>
              llmObservability.summarizeByExecution(workspaceId, executionId)
          : undefined,
        costCurrency: llmObservability?.rollupCurrency ?? null,
      }),
  )
  // Built before the shared-stacks + environments modules so a compose stack recipe's
  // `prerequisites` (and a shared stack's own prerequisites) are re-run at provision / bring-up
  // start through this service. The host probes exist only on the local facade; absent ⇒ a recipe /
  // stack that declares prerequisites fails loudly (the preflight API 503s too).
  const preflight = modules.build('preflight', () => createPreflightModule(dependencies))
  // Built before the environments module so a compose stack recipe's `sharedStackRefs` can be
  // brought up (provider-before-consumer) through this service during provisioning. Persistence is
  // runtime-symmetric (present on every facade); the lifecycle only runs where a host daemon is
  // wired (`composeRuntime` — the local facade), else `ensureRefsUp` returns a clean error. It gets
  // the preflight service so a shared stack re-checks its own machine prerequisites at bring-up.
  const sharedStacks = modules.build('sharedStacks', () =>
    createSharedStacksModule(dependencies, preflight?.service),
  )
  const environments = modules.build('environments', () =>
    createEnvironmentsModule(
      dependencies,
      provisioningLogRecorder,
      executionEventPublisher,
      sharedStacks?.service,
      preflight?.service,
    ),
  )
  // The deployment-declared environment-handler seeder, built over the environments module's
  // connection service (so it can list/register handlers). Built only when the environments module
  // is wired; it is a no-op when `seedEnvironmentHandlers` is empty. Returned so `createCore` can
  // fill the late-bound ref WorkspaceService.create's on-create hook resolves, and exposed on the
  // container return (via the registry) so the runtime can boot-backfill every existing workspace.
  const environmentHandlerSeeder = modules.build('environmentHandlerSeeder', () =>
    environments
      ? createEnvironmentHandlerSeeder({
          connectionService: environments.connectionService,
          seeds: dependencies.seedEnvironmentHandlers ?? [],
          logger: dependencies.logger,
        })
      : undefined,
  )
  // The deployment-declared SHARED-STACK seeder, the sibling of the handler seeder above and
  // wired at the same two sites (workspace creation + a boot backfill). Built only when the
  // shared-stacks module is wired; a no-op when `seedSharedStacks` is empty. Its persistence is
  // runtime-symmetric, so seeding works on every facade even though only the local one can bring
  // a stack UP.
  const sharedStackSeeder = modules.build('sharedStackSeeder', () =>
    sharedStacks
      ? createSharedStackSeeder({
          service: sharedStacks.service,
          seeds: dependencies.seedSharedStacks ?? [],
          logger: dependencies.logger,
        })
      : undefined,
  )
  // Built before the fragment library so a document-backed fragment can re-resolve
  // its linked Confluence/Notion/GitHub page through the document module's reader.
  const documents = modules.build('documents', () =>
    createDocumentsModule(dependencies, boardService, caches),
  )
  const fragmentLibrary = modules.build('fragmentLibrary', () =>
    createFragmentLibraryModule(dependencies, documents?.contentResolver, caches),
  )
  const skillLibrary = modules.build('skillLibrary', () =>
    createSkillLibraryModule(dependencies, caches),
  )
  const foundationalServices = modules.build('foundationalServices', () =>
    createFoundationalServiceModule(dependencies, caches, foundationalBuiltins),
  )
  return {
    llmObservability,
    documents,
    environments,
    environmentHandlerSeeder,
    sharedStackSeeder,
    fragmentLibrary,
    skillLibrary,
    foundationalServices,
  }
}
