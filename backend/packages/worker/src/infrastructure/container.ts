import {
  AiAgentExecutor,
  type AgentExecutor,
  type Core,
  type CoreDependencies,
  type Rng,
  SimulatorAgentExecutor,
  createCore,
} from '@cat-factory/core'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { CloudflareModelProvider } from './ai/CloudflareModelProvider'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { CryptoIdGenerator, CryptoRng, SeededRng, SystemClock } from './runtime'

// The infrastructure composition root: turn a Worker `env` into the concrete
// ports (D1 repositories, runtime, the chosen agent executor) and assemble the
// domain core. Built once per request — instantiation is cheap and each request
// gets its own D1 handle from `env`.

export interface Container extends Core {
  config: AppConfig
}

/**
 * Pick the agent that performs pipeline steps:
 *   - agents enabled  → real LLM work via the Vercel AI SDK
 *   - otherwise       → the playful randomised simulator (local / mock runtime)
 * Tests bypass this entirely by overriding `agentExecutor` with a fake.
 */
function selectAgentExecutor(env: Env, config: AppConfig, rng: Rng): AgentExecutor {
  if (config.agents.enabled) {
    return new AiAgentExecutor({
      modelProvider: new CloudflareModelProvider({ env }),
      agentRouting: config.agents.routing,
    })
  }
  return new SimulatorAgentExecutor({ rng })
}

export function buildContainer(env: Env, overrides: Partial<CoreDependencies> = {}): Container {
  const config = loadConfig(env)
  const db = env.DB
  const rng: Rng = env.RNG_SEED ? new SeededRng(Number(env.RNG_SEED)) : new CryptoRng()

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db }),
    idGenerator: new CryptoIdGenerator(),
    clock: new SystemClock(),
    agentExecutor: selectAgentExecutor(env, config, rng),
    ...overrides,
  }

  return { ...createCore(dependencies), config }
}
