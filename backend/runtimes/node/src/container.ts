import { AiAgentExecutor } from '@cat-factory/agents'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import type { AppConfig, ServerContainer } from '@cat-factory/server'
import { loadNodeConfig } from './config.js'
import { createNodeGateways } from './gateways.js'
import { createNodeModelProvider } from './modelProvider.js'
import { createInMemoryRepositories } from './repositories/inMemory.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'

export interface NodeContainerOptions {
  /** Pre-resolved config; defaults to `loadNodeConfig(env)`. */
  config?: AppConfig
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
}

/**
 * The Node composition root: assemble the framework-agnostic domain `Core` with
 * Node implementations of the runtime ports, then attach the shared-controller
 * extras (`config`, the kind-spanning agent-run repo, the runtime gateways).
 *
 * Unlike the Worker — which builds a fresh container per request around a new D1
 * handle — the Node server builds this ONCE and reuses it, so the (currently
 * in-memory) persistence layer is shared across requests. Swapping in a
 * Drizzle/Postgres layer keeps the same shape; the pool is just a singleton too.
 */
export function buildNodeContainer(options: NodeContainerOptions = {}): ServerContainer {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  const repos = createInMemoryRepositories(() => clock.now())

  const agentExecutor = new AiAgentExecutor({
    modelProvider: createNodeModelProvider(env),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
  })

  const dependencies: CoreDependencies = {
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
    ...options.overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: repos.agentRunRepository,
    gateways: createNodeGateways(env),
  }
}
