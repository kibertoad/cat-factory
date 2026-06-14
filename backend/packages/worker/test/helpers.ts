import type {
  AgentExecutor,
  ConfluenceClient,
  CoreDependencies,
  GitHubClient,
  WebhookVerifier,
  WorkspaceSnapshot,
} from '@cat-factory/core'
import { env } from 'cloudflare:test'
import { createApp } from '../src/app'
import { FakeAgentExecutor } from './fakes/FakeAgentExecutor'
import { FakeGitHubClient } from './fakes/FakeGitHubClient'
import { FakeWebhookVerifier } from './fakes/FakeWebhookVerifier'
import { FakeConfluenceClient } from './fakes/FakeConfluenceClient'
import { D1GitHubInstallationRepository } from '../src/infrastructure/repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from '../src/infrastructure/repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from '../src/infrastructure/repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from '../src/infrastructure/repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from '../src/infrastructure/repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from '../src/infrastructure/repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from '../src/infrastructure/repositories/D1CheckRunProjectionRepository'
import { D1ConfluenceConnectionRepository } from '../src/infrastructure/repositories/D1ConfluenceConnectionRepository'
import { D1ConfluenceDocumentRepository } from '../src/infrastructure/repositories/D1ConfluenceDocumentRepository'

const BASE = 'https://cat-factory.test'

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

export interface TestApp {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
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
  const app = createApp({ overrides: { agentExecutor, ...overrides } })

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

  return { call, createWorkspace }
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
 * Build Confluence-module core overrides backed by the real local D1 plus a fake
 * client. No model provider is wired, so the planner uses its deterministic
 * heading parser — letting tests assert exact spawned structure without an LLM.
 * Spread into `makeApp`'s overrides to make `container.confluence` available
 * (the module assembles whenever its deps are present, independent of the
 * CONFLUENCE_ENABLED env gate).
 */
export function confluenceDeps(
  opts: { client?: ConfluenceClient } = {},
): Partial<CoreDependencies> {
  const db = env.DB
  return {
    confluenceClient: opts.client ?? new FakeConfluenceClient(),
    confluenceConnectionRepository: new D1ConfluenceConnectionRepository({ db }),
    confluenceDocumentRepository: new D1ConfluenceDocumentRepository({ db }),
  }
}
