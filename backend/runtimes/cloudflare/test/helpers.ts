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
import { NoopBootstrapRunner, NoopEnvConfigRepairRunner, NoopWorkRunner } from '@cat-factory/kernel'
import { driveWorkspace } from '@cat-factory/conformance'
import { createDocumentConnectionStore, createTaskConnectionStore } from '@cat-factory/integrations'
import type { GateProviderOverrides } from '@cat-factory/gates'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { env } from 'cloudflare:test'
import { createApp } from '../src/app'
import { buildContainer } from '../src/infrastructure/container'
import { FakeAgentExecutor } from './fakes/FakeAgentExecutor'
import { FakeGitHubClient } from '@cat-factory/conformance'
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
import { D1TaskSourceSettingsRepository } from '../src/infrastructure/repositories/D1TaskSourceSettingsRepository'
import { D1TaskRepository } from '../src/infrastructure/repositories/D1TaskRepository'
import { D1PromptFragmentRepository } from '../src/infrastructure/repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from '../src/infrastructure/repositories/D1FragmentSourceRepository'
import { WebCryptoSecretCipher } from '../src/infrastructure/environments/WebCryptoSecretCipher'

const BASE = 'https://cat-factory.test'

// The pool runs with the `AI` binding UNBOUND, and that is the same posture Node's harness runs.
//
// `wrangler.toml` binds `[ai]`, and the binding has no local simulator, so an inline LLM call
// inside the pool cannot succeed — it can only reject with "Binding AI needs to be run remotely"
// once the AI SDK has finished retrying it. The product catches that and passes through, which is
// why every assertion stayed green while the suite filed 111 unhandled rejections per run and paid
// the retry backoffs' wall-clock (the shard carrying `conformance.spec.ts` ran ~2x its siblings).
// Since the calls can only ever fail, having them is worth nothing and having them is not free.
//
// Note what this does NOT change: `cloudflareModelsEnabled` below stays ON. The two are different
// facts and only one of them is about the binding — whether the deployment OFFERS Workers AI
// models (the catalog + the run-admission provider guard) versus whether this process can SERVE
// one. Node has held exactly that combination all along, on purpose: flag on so a run can start,
// no binding so nothing is dialled. Coupling them here refused every run instead.
//
// Built once rather than per `makeApp`, because the inline model resolver is memoised per `Env`
// identity — a fresh copy per app would quietly build a fresh resolver per app.
const envWithoutCloudflareAi: typeof env = { ...env, AI: undefined }

export interface TestResponse<T = unknown> {
  status: number
  body: T
}

export interface TestApp {
  call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<TestResponse<T>>
  /**
   * Issue a request whose success carries BYTES rather than JSON (the artifact blob endpoint).
   *
   * A separate method rather than a flag on {@link ConformanceApp.call}: that one JSON-decodes
   * every body, so a PNG reaches it as a parse error rather than a response. Returns the recorded
   * content type beside the bytes, because clamping it to the image allow-list is half of what
   * the endpoint promises: an artifact served as something a browser would execute is the bug.
   */
  callBinary(
    method: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }>
  createWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /** Create an unseeded workspace owned by a fresh ORG account (via the real services). */
  createOrgWorkspace(options?: { name?: string; seed?: boolean }): Promise<WorkspaceSnapshot>
  /**
   * Drive every active run in a workspace to a standstill (done, or parked on a
   * decision / the spend gate), then return the latest executions. Reproduces the
   * old `tick` loop over the durable `advanceInstance` entry point — in production
   * the Cloudflare Workflows driver does this; tests drive it directly. Uses the
   * same agent/overrides this app was built with, against the shared `env.DB`.
   */
  drive(workspaceId: string, maxRounds?: number): Promise<ExecutionInstance[]>
  /**
   * Start a run straight through the real `ExecutionService`, optionally with a per-run gate
   * override (the initiative-preset gate-override seam) — a path no HTTP route exposes. Uses the
   * same core overrides `drive` does (against the shared local D1), so the conformance suite can
   * assert the override lands on the persisted run steps + drives identically to Node/local.
   */
  startExecution(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    opts?: { gates?: boolean[] },
  ): Promise<ExecutionInstance>
  /**
   * Drive a bootstrap job's poll loop to a terminal state, mirroring what the
   * durable BootstrapWorkflow does in production. Returns the number of polls.
   */
  driveBootstrap(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
  /**
   * Drive an env-config-repair job's poll loop to a terminal state, mirroring what the
   * durable EnvConfigRepairWorkflow does in production. Returns the number of polls.
   */
  driveEnvConfigRepair(workspaceId: string, jobId: string, maxPolls?: number): Promise<number>
}

/**
 * Build the real Hono app against the real local D1 (`env.DB`), injecting a
 * deterministic agent so tests assert exact engine behaviour. Requests go
 * through `app.fetch` — the actual Worker fetch handler — inside workerd.
 */
export function makeApp(
  agentExecutor: AgentExecutor = new FakeAgentExecutor(),
  overrides: Partial<CoreDependencies> = {},
  appOptions: { cloudflareModelsEnabled?: boolean; gateProviders?: GateProviderOverrides } = {},
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
    // Like bootstrapRunner: avoid spawning a real Cloudflare Workflows instance for an
    // env-config-repair run in the test pool (the binding is present). Specs drive the
    // repair poll loop deterministically via `driveEnvConfigRepair`.
    envConfigRepairRunner: new NoopEnvConfigRepairRunner(),
    ...overrides,
  }
  // One env for the whole app: the request path and every direct `buildContainer` below must see
  // the same provider set, or a run driven through `drive` would resolve models differently from
  // the same run started over HTTP. See `envWithoutCloudflareAi`.
  const appEnv = envWithoutCloudflareAi
  // Default the Cloudflare-models flag ON, matching Node's harness verbatim: the built-in default
  // model preset points every agent kind at a Cloudflare-served model, so the run-admission guard
  // needs that provider OFFERED or no run starts. Specs exercising the unconfigured-provider path
  // still force it off. Passed explicitly because `appEnv` no longer carries the binding the
  // container would otherwise derive this from.
  const containerOptions = {
    cloudflareModelsEnabled: appOptions.cloudflareModelsEnabled ?? true,
    gateProviders: appOptions.gateProviders,
  }
  const app = createApp({ overrides: coreOverrides, ...appOptions, ...containerOptions })

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<TestResponse<T>> {
    const hasBody = body !== undefined
    const res = await app.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      }),
      appEnv,
    )
    const text = await res.text()
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T }
  }

  async function callBinary(
    method: string,
    path: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }> {
    const res = await app.fetch(
      new Request(`${BASE}${path}`, { method, headers: { ...extraHeaders } }),
      appEnv,
    )
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: new Uint8Array(await res.arrayBuffer()),
    }
  }

  async function createWorkspace(options: { name?: string; seed?: boolean } = {}) {
    const res = await call<WorkspaceSnapshot>('POST', '/workspaces', options)
    return res.body
  }

  // Create an org account + owner and a workspace owned by it directly through the
  // container's services — dev-open has no signed-in user, so the HTTP account flow
  // (which requires one) can't be used to set up an org-scoped workspace.
  async function createOrgWorkspace(
    options: { name?: string; seed?: boolean } = {},
  ): Promise<WorkspaceSnapshot> {
    const c = buildContainer(appEnv, coreOverrides, containerOptions)
    // The org creator must be a real users row — the accounts/memberships FKs to users(id)
    // reject a nonexistent owner. Production always mints it at login, so do the same here
    // (mirrors the conformance `makeOrgOwner` probe) instead of a phantom id.
    const owner = await c.userService.findOrCreateByIdentity('github', 'org-owner', {
      name: 'Org Owner',
    })
    const user = { id: owner.id, login: 'org-owner', name: 'Org Owner' }
    const name = options.name ?? 'Org board'
    const org = await c.accountService.createOrg(user, { name: `${name} org` })
    return c.workspaceService.create({ name, seed: options.seed ?? false }, user.id, org.id)
  }

  // Drive every active run to a standstill through the SHARED production driver
  // (`driveExecution`, via `driveWorkspace`). The Cloudflare ExecutionWorkflow wraps the
  // same advance/poll calls in durable steps; using the shared loop here (against the real
  // local D1) means the suite exercises the production driving logic — including the
  // single `failRun` funnel — rather than a hand-rolled copy that can diverge from it.
  async function drive(workspaceId: string, maxRounds = 50): Promise<ExecutionInstance[]> {
    const c = buildContainer(appEnv, coreOverrides, containerOptions)
    return driveWorkspace(
      c.executionService,
      workspaceId,
      // Enumerate runs straight from the repository (as production does — it drives by run id),
      // NOT via the SPA snapshot, which now hides the public-API "initiative" runs' executions.
      () => c.executionRepository.listByWorkspace(workspaceId),
      maxRounds,
    )
  }

  async function startExecution(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    opts?: { gates?: boolean[] },
  ): Promise<ExecutionInstance> {
    const c = buildContainer(appEnv, coreOverrides, containerOptions)
    return c.executionService.start(workspaceId, blockId, pipelineId, {
      gatesOverride: opts?.gates,
    })
  }

  async function driveBootstrap(
    workspaceId: string,
    jobId: string,
    maxPolls = 50,
  ): Promise<number> {
    const c = buildContainer(appEnv, coreOverrides, containerOptions)
    if (!c.bootstrap) throw new Error('bootstrap module is not configured in this app')
    for (let p = 0; p < maxPolls; p++) {
      const result = await c.bootstrap.service.pollBootstrapJob(workspaceId, jobId)
      if (result.state !== 'running') return p + 1
    }
    return maxPolls
  }

  async function driveEnvConfigRepair(
    workspaceId: string,
    jobId: string,
    maxPolls = 50,
  ): Promise<number> {
    const c = buildContainer(appEnv, coreOverrides, containerOptions)
    if (!c.envConfigRepair) {
      throw new Error('env-config-repair module is not configured in this app')
    }
    for (let p = 0; p < maxPolls; p++) {
      const result = await c.envConfigRepair.service.pollJob(workspaceId, jobId)
      if (result.state !== 'running') return p + 1
    }
    return maxPolls
  }

  return {
    call,
    callBinary,
    createWorkspace,
    createOrgWorkspace,
    drive,
    startExecution,
    driveBootstrap,
    driveEnvConfigRepair,
  }
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
  const documentConnectionRepository = new D1DocumentConnectionRepository({ db })
  return {
    documentSourceProviders: opts.providers ?? [
      new FakeDocumentSourceProvider('confluence'),
      new FakeDocumentSourceProvider('notion'),
    ],
    documentConnectionRepository,
    documentConnectionStore: createDocumentConnectionStore({
      documentConnectionRepository,
      secretCipher: new WebCryptoSecretCipher({
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
  const taskConnectionRepository = new D1TaskConnectionRepository({ db })
  return {
    taskSourceProviders: opts.providers ?? [new FakeTaskSourceProvider('jira')],
    taskConnectionRepository,
    taskConnectionStore: createTaskConnectionStore({
      taskConnectionRepository,
      secretCipher: new WebCryptoSecretCipher({
        // The shared master key, always set in the test bindings (see vitest.config.ts).
        masterKeyBase64: env.ENCRYPTION_KEY!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskSourceSettingsRepository: new D1TaskSourceSettingsRepository({ db }),
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
