/**
 * The infrastructure + content-library slice of `createCore`, extracted verbatim (no behaviour
 * change): the provisioning event-log recorder/reader, then the ordered
 * preflight → shared-stacks → environments chain, then the documents → fragment-library →
 * skill-library chain.
 *
 * These belong together because their REGISTRATION ORDER IS their dependency order, and the
 * comments inline at each step say why: preflight is built first so a compose recipe's
 * `prerequisites` re-run at bring-up, shared stacks before environments so a recipe's
 * `sharedStackRefs` come up provider-before-consumer, and documents before the fragment library
 * so a document-backed fragment can re-resolve its linked page. Keeping the chain in one
 * collaborator is what stops that order being disturbed by an unrelated edit to `createCore`.
 *
 * The {@link ModuleRegistry} instance is owned by `createCore` and passed in, so every optional
 * module declared here registers in the SAME order it did inline and `modules.assemble()` at
 * `createCore`'s return still emits them. Only the handles `createCore` itself reads downstream
 * are returned; `documents` and `preflight` are consumed within the chain.
 */

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
import { ProvisioningLogRecorder, ProvisioningLogService } from '@cat-factory/integrations'
import type { ModuleRegistry } from './module-registry.js'
import type { BoardService } from '../modules/board/BoardService.js'
import type { CoreDependencies } from '../container.js'
import type { resolveCoreRuntime } from './runtime.js'

type CoreRuntime = ReturnType<typeof resolveCoreRuntime>

export interface InfrastructureModulesInput {
  dependencies: CoreDependencies
  modules: ModuleRegistry
  caches: CoreRuntime['caches']
  executionEventPublisher: CoreRuntime['executionEventPublisher']
  boardService: BoardService
}

export function createInfrastructureModules(input: InfrastructureModulesInput) {
  const { dependencies, modules, caches, executionEventPublisher, boardService } = input
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
  return { environments, fragmentLibrary, skillLibrary }
}
