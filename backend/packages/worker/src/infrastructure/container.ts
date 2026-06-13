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
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from './repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from './repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from './repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from './repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from './repositories/D1CheckRunProjectionRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { CryptoIdGenerator, CryptoRng, SeededRng, SystemClock } from './runtime'
import type { Clock, IdGenerator } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

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

/**
 * Build the GitHub integration's concrete ports when an App is configured,
 * mirroring `selectWorkRunner`. Returns an empty object otherwise, so `createCore`
 * leaves the `github` module unassembled and the feature stays opt-in.
 */
function selectGitHubDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  if (!config.github.enabled) return {}

  const githubInstallationRepository = new D1GitHubInstallationRepository({ db })
  const auth = new GitHubAppAuth({
    appId: config.github.appId,
    privateKeyPem: env.GITHUB_APP_PRIVATE_KEY!,
    installationRepository: githubInstallationRepository,
    clock,
    apiBase: config.github.apiBase,
  })
  const githubClient = new FetchGitHubClient({
    auth,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })
  return {
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    branchProjectionRepository: new D1BranchProjectionRepository({ db }),
    pullRequestProjectionRepository: new D1PullRequestProjectionRepository({ db }),
    issueProjectionRepository: new D1IssueProjectionRepository({ db }),
    commitProjectionRepository: new D1CommitProjectionRepository({ db }),
    checkRunProjectionRepository: new D1CheckRunProjectionRepository({ db }),
    webhookVerifier: new WebCryptoWebhookVerifier(env.GITHUB_WEBHOOK_SECRET!),
  }
}

export function buildContainer(env: Env, overrides: Partial<CoreDependencies> = {}): Container {
  const config = loadConfig(env)
  const db = env.DB
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  const rng: Rng = env.RNG_SEED ? new SeededRng(Number(env.RNG_SEED)) : new CryptoRng()

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    idGenerator,
    clock,
    agentExecutor: selectAgentExecutor(env, config, rng),
    workRunner: selectWorkRunner(env, config),
    spendPricing: config.spend,
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...overrides,
  }

  return { ...createCore(dependencies), config }
}
