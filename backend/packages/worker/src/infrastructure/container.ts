import {
  AiAgentExecutor,
  type AgentExecutor,
  type Core,
  type CoreDependencies,
  NoopWorkRunner,
  type Rng,
  SimulatorAgentExecutor,
  type WorkRunner,
  createCore,
} from '@cat-factory/core'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { CloudflareModelProvider } from './ai/CloudflareModelProvider'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
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

/**
 * Pick how runs are driven:
 *   - workflow mode + a Workflows binding → durable, server-driven execution
 *   - otherwise                            → no-op (progress driven by `tick`)
 * Tests override `workRunner` with a fake.
 */
function selectWorkRunner(env: Env, config: AppConfig): WorkRunner {
  if (config.execution.mode === 'workflow' && env.EXECUTION_WORKFLOW) {
    return new WorkflowsWorkRunner({
      workflow: env.EXECUTION_WORKFLOW,
      queue: env.EXECUTION_QUEUE,
    })
  }
  return new NoopWorkRunner()
}

export function buildContainer(env: Env, overrides: Partial<CoreDependencies> = {}): Container {
  const config = loadConfig(env)
  const db = env.DB
  const clock = new SystemClock()
  const rng: Rng = env.RNG_SEED ? new SeededRng(Number(env.RNG_SEED)) : new CryptoRng()

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    idGenerator: new CryptoIdGenerator(),
    clock,
    agentExecutor: selectAgentExecutor(env, config, rng),
    workRunner: selectWorkRunner(env, config),
    ...overrides,
  }

  return { ...createCore(dependencies), config }
}
