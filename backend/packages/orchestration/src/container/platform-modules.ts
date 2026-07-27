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
 * Returns only what the engine downstream consumes; `documents`, `preflight`, `sharedStacks` and
 * the provisioning-log recorder are internal to this slice.
 */

import { LlmObservabilityService } from '../modules/observability/LlmObservabilityService.js'
import { PlatformObservabilityService } from '../modules/observability/PlatformObservabilityService.js'
import {
  ProvisioningLogRecorder,
  ProvisioningLogService,
  createEnvironmentHandlerSeeder,
} from '@cat-factory/integrations'
import {
  createDocumentsModule,
  createEnvironmentsModule,
  createPreflightModule,
  createSharedStacksModule,
} from './modules.js'
import {
  createFragmentLibraryModule,
  createSkillLibraryModule,
} from '../container-content-libraries.js'
import type { FragmentLibraryModule, SkillLibraryModule } from '../container-content-libraries.js'
import type { ModuleRegistry } from './module-registry.js'
import type { BoardService } from '../modules/board/BoardService.js'
import type { CoreDependencies } from '../container.js'
import type { EnvironmentHandlerSeeder } from '@cat-factory/kernel'
import type { resolveCoreRuntime } from './runtime.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface PlatformModulesInput {
  dependencies: CoreDependencies
  modules: ModuleRegistry
  caches: CoreRuntime['caches']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  boardService: BoardService
}

export interface PlatformModules {
  llmObservability: LlmObservabilityService | undefined
  environments: ReturnType<typeof createEnvironmentsModule> | undefined
  environmentHandlerSeeder: EnvironmentHandlerSeeder | undefined
  fragmentLibrary: FragmentLibraryModule | undefined
  skillLibrary: SkillLibraryModule | undefined
}

export function createPlatformModules(input: PlatformModulesInput): PlatformModules {
  const { dependencies, modules, caches, executionEventPublisher, boardService } = input
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
        })
      : undefined,
  )
  modules.build('platformObservability', () =>
    dependencies.platformMetricsRepository
      ? new PlatformObservabilityService({
          platformMetricsRepository: dependencies.platformMetricsRepository,
          clock: dependencies.clock,
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
  // Built before the fragment library so a document-backed fragment can re-resolve
  // its linked Confluence/Notion/GitHub page through the document module's reader.
  const documents = modules.build('documents', () =>
    createDocumentsModule(dependencies, boardService),
  )
  const fragmentLibrary = modules.build('fragmentLibrary', () =>
    createFragmentLibraryModule(dependencies, documents?.contentResolver, caches),
  )
  const skillLibrary = modules.build('skillLibrary', () =>
    createSkillLibraryModule(dependencies, caches),
  )
  return { llmObservability, environments, environmentHandlerSeeder, fragmentLibrary, skillLibrary }
}
