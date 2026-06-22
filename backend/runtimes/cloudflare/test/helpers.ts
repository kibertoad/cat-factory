import type {
  AgentExecutor,
  DocumentSourceProvider,
  ExecutionInstance,
  FragmentSelector,
  GitHubClient,
  TaskSourceProvider,
  WebhookVerifier,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import { NoopBootstrapRunner, NoopWorkRunner } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { env } from 'cloudflare:test'
import { createApp } from '../src/app'
import { buildContainer } from '../src/infrastructure/container'
import { FakeAgentExecutor } from './fakes/FakeAgentExecutor'
import { FakeGitHubClient } from './fakes/FakeGitHubClient'
import { FakeWebhookVerifier } from './fakes/FakeWebhookVerifier'
import { FakeDocumentSourceProvider } from './fakes/FakeDocumentSourceProvider'
import { FakeTaskSourceProvider } from './fakes/FakeTaskSourceProvider'
import { D1GitHubInstallationRepository } from '../src/infrastructure/repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from '../src/infrastructure/repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from '../src/infrastructure/repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from '../src/infrastructure/repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from '../src/infrastructure/repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from '../src/infrastructure/repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from '../src/infrastructure/repositories/D1CheckRunProjectionRepository'
import { D1DocumentConnectionRepository } from '../src/infrastructure/repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from '../src/infrastructure/repositories/D1DocumentRepository'
import { D1TaskConnectionRepository } from '../src/infrastructure/repositories/D1TaskConnectionRepository'
import { D1TaskRepository } from '../src/infrastructure/repositories/D1TaskRepository'
import { D1PromptFragmentRepository } from '../src/infrastructure/repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from '../src/infrastructure/repositories/D1FragmentSourceRepository'
import { WebCryptoSecretCipher } from '../src/infrastructure/environments/WebCryptoSecretCipher'

const BASE = 'https://cat-factory.test'

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

export interface TestApp {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /** Create an unseeded workspace owned by a fresh ORG account (via the real services). */
  createOrgWorkspace(options?: { name?: string }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate), then return the latest executions. Reproduces the
   * old `tick` loop over the durable `advanceInstance` entry point — in production
   * the Cloudflare Workflows driver does this; tests drive it directly. Uses the
   * same agent/overrides this app was built with, against the shared `env.DB`.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
  /**
   * Drive a bootstrap job's poll loop to a terminal state, mirroring what the
   * durable BootstrapWorkflow does in production. Returns the number of polls.
   */
  driveBootstrap(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
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
    // Like workRunner: avoid spawning a real Cloudflare Workflows instance for a
    // bootstrap in the test pool (the binding is present). Specs drive the
    // bootstrap poll loop deterministically via `driveBootstrap`.
    bootstrapRunner: new NoopBootstrapRunner(),
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

  // Create an org account + owner and a workspace owned by it directly through the
  // container's services — dev-open has no signed-in user, so the HTTP account flow
  // (which requires one) can't be used to set up an org-scoped workspace.
  async function createOrgWorkspace(options: { name?: string } = {}): Promise<WorkspaceSnapshot> {
    const c = buildContainer(env, coreOverrides)
    const user = { id: 'usr_org-owner', login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await c.accountService.createOrg(user, { name: `${name} org` })
    return c.workspaceService.create({ name, seed: false }, user.id, org.id)
  }

  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    const c = buildContainer(env, coreOverrides)
    for (let round = 0; round < maxRounds; round++) {
      const { executions } = await c.workspaceService.snapshot(workspaceId)
      // Mirror the old tick: advance running/paused runs; a run parked on a
      // decision stays put until it is resolved (then it is running again).
      const active = executions.filter((e) => e.status === 'running' || e.status === 'paused')
      if (active.length === 0) break
      for (const e of active) {
        // Mirror the durable driver: an advance that parks on an async job / CI / conflicts
        // gate is drained by polling, so a polled (container-style) agent step completes
        // here exactly as it does under Cloudflare Workflows. Inert for the inline fake
        // (which never parks on a job — no worker test reaches these gate kinds via drive).
        let r = await c.executionService.advanceInstance(workspaceId, e.id)
        for (let hops = 0; hops < 500; hops++) {
          if (r.kind === 'awaiting_job')
            r = await c.executionService.pollAgentJob(workspaceId, e.id)
          else if (r.kind === 'awaiting_ci') r = await c.executionService.pollCi(workspaceId, e.id)
          else if (r.kind === 'awaiting_conflicts')
            r = await c.executionService.pollConflicts(workspaceId, e.id)
          else break
        }
      }
    }
    return (await c.workspaceService.snapshot(workspaceId)).executions
  }

  async function driveBootstrap(
    workspaceId: string,
    jobId: string,
    maxPolls = 50,
  ): Promise<number> {
    const c = buildContainer(env, coreOverrides)
    if (!c.bootstrap) throw new Error('bootstrap module is not configured in this app')
    for (let p = 0; p < maxPolls; p++) {
      const result = await c.bootstrap.service.pollBootstrapJob(workspaceId, jobId)
      if (result.state !== 'running') return p + 1
    }
    return maxPolls
  }

  return { call, createWorkspace, createOrgWorkspace, drive, driveBootstrap }
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
    documentConnectionRepository: new D1DocumentConnectionRepository({
      db,
      cipher: new WebCryptoSecretCipher({
        // The shared master key, always set in the test bindings (see vitest.config.ts).
        masterKeyBase64: env.ENCRYPTION_KEY!,
        info: 'cat-factory:documents',
      }),
    }),
    documentRepository: new D1DocumentRepository({ db }),
  }
}

/**
 * Build task-source core overrides backed by the real local D1 plus fake
 * providers. Spread into `makeApp`'s overrides to make `container.tasks`
 * available (the module assembles whenever its deps are present, independent of
 * the TASKS_ENABLED env gate). Defaults to a single Jira fake.
 */
export function tasksDeps(
  opts: { providers?: TaskSourceProvider[] } = {},
): Partial<CoreDependencies> {
  const db = env.DB
  return {
    taskSourceProviders: opts.providers ?? [new FakeTaskSourceProvider('jira')],
    taskConnectionRepository: new D1TaskConnectionRepository({
      db,
      cipher: new WebCryptoSecretCipher({
        // The shared master key, always set in the test bindings (see vitest.config.ts).
        masterKeyBase64: env.ENCRYPTION_KEY!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskRepository: new D1TaskRepository({ db }),
  }
}

/**
 * Build prompt-fragment library core overrides backed by the real local D1
 * (migration 0020). Spread into `makeApp`'s overrides to make
 * `container.fragmentLibrary` available (the module assembles whenever its deps
 * are present, independent of the PROMPT_LIBRARY_ENABLED env gate). Pass a
 * `client` to also wire repo-sourced fragments; defaults to the deterministic
 * selector so runs stay deterministic, overridable via `selector`.
 */
export function fragmentLibraryDeps(
  opts: { client?: GitHubClient; selector?: FragmentSelector; installationId?: number } = {},
): Partial<CoreDependencies> {
  const db = env.DB
  const base: Partial<CoreDependencies> = {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    ...(opts.selector ? { fragmentSelector: opts.selector } : {}),
  }
  if (opts.client) {
    base.githubClient = opts.client
    base.resolveFragmentInstallationId = async () => opts.installationId ?? 4242
  }
  return base
}
