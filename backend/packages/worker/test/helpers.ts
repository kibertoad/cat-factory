import type {
  AgentExecutor,
  CoreDependencies,
  DocumentSourceProvider,
  ExecutionInstance,
  GitHubClient,
  WebhookVerifier,
  WorkspaceSnapshot,
} from '@cat-factory/core'
import { NoopWorkRunner } from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { createApp } from '../src/app'
import { buildContainer } from '../src/infrastructure/container'
import { FakeAgentExecutor } from './fakes/FakeAgentExecutor'
import { FakeGitHubClient } from './fakes/FakeGitHubClient'
import { FakeWebhookVerifier } from './fakes/FakeWebhookVerifier'
import { FakeDocumentSourceProvider } from './fakes/FakeDocumentSourceProvider'
import { D1GitHubInstallationRepository } from '../src/infrastructure/repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from '../src/infrastructure/repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from '../src/infrastructure/repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from '../src/infrastructure/repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from '../src/infrastructure/repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from '../src/infrastructure/repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from '../src/infrastructure/repositories/D1CheckRunProjectionRepository'
import { D1DocumentConnectionRepository } from '../src/infrastructure/repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from '../src/infrastructure/repositories/D1DocumentRepository'

const BASE = 'https://cat-factory.test'

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

export interface TestApp {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate), then return the latest executions. Reproduces the
   * old `tick` loop over the durable `advanceInstance` entry point — in production
   * the Cloudflare Workflows driver does this; tests drive it directly. Uses the
   * same agent/overrides this app was built with, against the shared `env.DB`.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
}

/**
 * Build the real Hono app against the real local D1 (`env.DB`), injecting a
 * deterministic agent so tests assert exact engine behaviour. Requests go
 * through `app.fetch` — the actual Worker fetch handler — inside workerd.
 */
export function makeApp(
  agentExecutor: AgentExecutor = new FakeAgentExecutor(),
  overrides: Partial<CoreDependencies> = {},
): TestApp {
  // Default to a no-op work runner so starting a run doesn't spawn a real
  // Cloudflare Workflows instance in the test pool (the wrangler.toml binding is
  // present). Tests drive runs deterministically via `drive`; specs that exercise
  // the durable runner pass their own `workRunner` in `overrides`.
  const coreOverrides: Partial<CoreDependencies> = {
    agentExecutor,
    workRunner: new NoopWorkRunner(),
    ...overrides,
  }
  const app = createApp({ overrides: coreOverrides })

  async function call<T>(method: string, path: string, body?: unknown): Promise<TestResponse<T>> {
    const hasBody = body !== undefined
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: hasBody ? { 'content-type': 'application/json' } : undefined,
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
      env,
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    const res = await call<WorkspaceSnapshot>('POST', '/workspaces', options)
    return res.body
  }

  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    const c = buildContainer(env, coreOverrides)
    for (let round = 0; round < maxRounds; round++) {
      const { executions } = await c.workspaceService.snapshot(workspaceId)
      // Mirror the old tick: advance running/paused runs; a run parked on a
      // decision stays put until it is resolved (then it is running again).
      const active = executions.filter((e) => e.status === 'running' || e.status === 'paused')
      if (active.length === 0) break
      for (const e of active) await c.executionService.advanceInstance(workspaceId, e.id)
    }
    return (await c.workspaceService.snapshot(workspaceId)).executions
  }

  return { call, createWorkspace, drive }
}

/**
 * Build GitHub-module core overrides backed by the real local D1 plus a fake
 * GitHubClient and webhook verifier. Spread into `makeApp`'s overrides to make
 * `container.github` available in tests (the module assembles whenever all its
 * deps are present, independent of the GITHUB_APP_ID env gate).
 */
export function githubDeps(
  opts: { client?: GitHubClient; verifier?: WebhookVerifier } = {},
): Partial<CoreDependencies> {
  const db = env.DB
  return {
    githubClient: opts.client ?? new FakeGitHubClient(),
    githubInstallationRepository: new D1GitHubInstallationRepository({ db }),
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    branchProjectionRepository: new D1BranchProjectionRepository({ db }),
    pullRequestProjectionRepository: new D1PullRequestProjectionRepository({ db }),
    issueProjectionRepository: new D1IssueProjectionRepository({ db }),
    commitProjectionRepository: new D1CommitProjectionRepository({ db }),
    checkRunProjectionRepository: new D1CheckRunProjectionRepository({ db }),
    webhookVerifier: opts.verifier ?? new FakeWebhookVerifier(true),
    // Mirror production's default commit retention/backfill horizon (90 days).
    commitBackfillHorizonMs: 90 * 24 * 60 * 60 * 1000,
  }
}

/** A fresh installation id per test so the global installations table stays isolated. */
export function uniqueInstallationId(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1
}

/**
 * Build document-source core overrides backed by the real local D1 plus fake
 * providers. No model provider is wired, so the planner uses its deterministic
 * heading parser — letting tests assert exact spawned structure without an LLM.
 * Spread into `makeApp`'s overrides to make `container.documents` available (the
 * module assembles whenever its deps are present, independent of the
 * DOCUMENTS_ENABLED env gate). Defaults to a Confluence + Notion fake pair.
 */
export function documentsDeps(
  opts: { providers?: DocumentSourceProvider[] } = {},
): Partial<CoreDependencies> {
  const db = env.DB
  return {
    documentSourceProviders: opts.providers ?? [
      new FakeDocumentSourceProvider('confluence'),
      new FakeDocumentSourceProvider('notion'),
    ],
    documentConnectionRepository: new D1DocumentConnectionRepository({ db }),
    documentRepository: new D1DocumentRepository({ db }),
  }
}
