import {
  GitHubIssuesProvider,
  IssueWritebackService,
  JiraProvider,
  LinearTaskProvider,
  githubIssuesLogic,
} from '@cat-factory/integrations'
import type {
  AppCaches,
  BlockRepository,
  Clock,
  GitHubClient,
  GitHubInstallationRepository,
  IdGenerator,
  ProviderRegistry,
  RateLimitRepository,
  RateLimitSnapshot,
  RepoProjectionRepository,
  ResolveUserGitHubToken,
  TaskConnectionRepository,
  TaskSourceProvider,
  TrackerSettingsRepository,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type GitHubAppRegistry,
  type ResolveRepoTarget,
  FetchGitHubClient,
  FetchGitHubProvisioningClient,
  GitHubBranchUpdater,
  GitHubCiStatusProvider,
  GitHubDocQualityProvider,
  GitHubMergeabilityProvider,
  GitHubPullRequestMerger,
  GitHubPullRequestReviewProvider,
  PatPreferringAppRegistry,
  WebCryptoSecretCipher,
  WebCryptoWebhookVerifier,
  makeResolveRepoFilesForCoords,
  makeResolveRunRepoContext,
} from '@cat-factory/server'
import {
  wireCiStatusProvider,
  wireDocQualityProvider,
  wireMergeabilityProvider,
  wirePullRequestReviewProvider,
} from '@cat-factory/gates'
import { buildNodeGitHubIssueFiler } from './container-executor-deps.js'
import type { DrizzleDb } from './db/client.js'
import { DrizzleDocumentRepository } from './repositories/documents.js'
import {
  DrizzleBranchProjectionRepository,
  DrizzleCheckRunProjectionRepository,
  DrizzleCommitProjectionRepository,
  DrizzleIssueProjectionRepository,
  DrizzlePullRequestProjectionRepository,
} from './repositories/github.js'
import {
  DrizzleTaskConnectionRepository,
  DrizzleTaskRepository,
  DrizzleTaskSourceSettingsRepository,
} from './repositories/tasks.js'
import { DrizzleUserRepoAccessRepository } from './repositories/userRepoAccess.js'

// The engine's CI/mergeability gate reads never persist rate-limit snapshots (that is the
// GitHub sync/webhook path's job), so the client backing them takes a no-op rate-limit store.
class NoopRateLimitRepository implements RateLimitRepository {
  record(_snapshot: RateLimitSnapshot): Promise<void> {
    return Promise.resolve()
  }
  deleteOlderThan(_epochMs: number): Promise<number> {
    return Promise.resolve(0)
  }
}

/** The result shape of {@link selectNodeTasksDeps}: the module deps plus the raw connection repo. */
export interface NodeTasksDeps {
  deps: Partial<CoreDependencies>
  taskConnectionRepository?: TaskConnectionRepository
}

/**
 * Wire the task-source integration for the Node facade (Jira + Linear always; GitHub Issues
 * only when a GitHub client is available, since it reuses the workspace's App installation).
 * Mirrors the Cloudflare facade's `config.github.enabled` gate (see CLAUDE.md parity rule).
 * Whether a workspace OFFERS a source is the per-workspace toggle (task_source_settings), not
 * a deployment env gate.
 */
function selectNodeTasksDeps(
  config: AppConfig,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
): NodeTasksDeps {
  if (!config.tasks.enabled || !config.tasks.encryptionKey) return { deps: {} }
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever a GitHub client is available (the App is configured) — it has no
  // credentials of its own and resolves the installation per issue.
  if (githubClient) {
    providers.push(new GitHubIssuesProvider({ githubClient, installations }))
  }

  const taskConnectionRepository = new DrizzleTaskConnectionRepository(
    db,
    // Source credentials are encrypted at rest under a tasks-scoped HKDF info (the
    // same domain the Cloudflare facade uses), keyed by the shared ENCRYPTION_KEY.
    new WebCryptoSecretCipher({
      masterKeyBase64: config.tasks.encryptionKey,
      info: 'cat-factory:tasks',
    }),
  )
  return {
    deps: {
      taskSourceProviders: providers,
      taskConnectionRepository,
      taskSourceSettingsRepository: new DrizzleTaskSourceSettingsRepository(db),
      taskRepository: new DrizzleTaskRepository(db),
    },
    taskConnectionRepository,
  }
}

/** Inputs {@link selectNodeGitHubDeps} needs from the composition root. */
export interface NodeGitHubDepsInput {
  config: AppConfig
  db: DrizzleDb
  /** Undefined in a standard build; the full-surface remote registry in mothership mode. */
  remoteRepos: Record<string, unknown> | undefined
  /** Source one org/durable repo from the remote registry (mothership) else the Drizzle db. */
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T
  idGenerator: IdGenerator
  clock: Clock
  appRegistry: GitHubAppRegistry | undefined
  /** An injected client (the local facade's PAT-backed one) wins over the App-minted client. */
  githubClientOverride?: GitHubClient
  resolveUserGitHubToken?: ResolveUserGitHubToken
  /** The GitLab-backed engine client, used as the gate/merge fallback when no GitHub App is set. */
  gitlabEngineClient: GitHubClient | undefined
  providerRegistry: ProviderRegistry
  resolveRepoTarget: ResolveRepoTarget
  githubInstallationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  blockRepository: BlockRepository
  trackerSettingsRepository: TrackerSettingsRepository
  caches?: AppCaches
}

/** The GitHub-client-dependent wiring {@link selectNodeGitHubDeps} produces. */
export interface NodeGitHubDeps {
  /** The GitHub-issue-specific client (App or injected); NOT the GitLab fallback. */
  githubClient: GitHubClient | undefined
  tasks: NodeTasksDeps
  fileGitHubIssue: ReturnType<typeof buildNodeGitHubIssueFiler>
  issueWritebackProvider: IssueWritebackService
  githubGateDeps: Partial<CoreDependencies>
  githubModuleDeps: Partial<CoreDependencies>
}

/**
 * The GitHub-client-dependent slice of the Node composition root, lifted out of
 * `buildNodeContainer` so that root stays within the file-size budget (the same reason
 * `container-executor-deps.ts` / `container-content-library-deps.ts` exist). Mirrors the
 * Worker's `selectGitHubDeps`: build the engine's GitHub client, wire the CI / mergeability /
 * review / doc-quality gate providers onto the app-owned `providerRegistry`, and assemble the
 * GitHub gate + projection/sync module deps. As a side effect it registers the gate providers;
 * call it at the point the region occupied so the ordering (before `applyGateProviders`) holds.
 */
export function selectNodeGitHubDeps(input: NodeGitHubDepsInput): NodeGitHubDeps {
  const {
    config,
    db,
    remoteRepos,
    sourced,
    idGenerator,
    clock,
    appRegistry,
    githubClientOverride,
    resolveUserGitHubToken,
    gitlabEngineClient,
    providerRegistry,
    resolveRepoTarget,
    githubInstallationRepository,
    repoProjectionRepository,
    blockRepository,
    trackerSettingsRepository,
    caches,
  } = input

  // GitHub-issue tracker: file the tech-debt pipeline's issue through the workspace's
  // own GitHub App installation (per-tenant), resolving the service's repo from the
  // github_repos projection — the same per-tenant infra the container executor uses.
  const fileGitHubIssue = buildNodeGitHubIssueFiler(config, appRegistry, resolveRepoTarget)

  // The GitHub client backing the CI gate + merge / mergeability providers: an injected
  // one wins (the local facade supplies a PAT-backed client), else — when the GitHub App
  // is configured — one minted from the shared App registry, so a stock Node deployment
  // with an App ALSO gates on real GitHub Actions CI and merges the PR for real (parity
  // with the Worker). Undefined → these stay unwired and the gates pass through.
  // Prefer the run initiator's per-user PAT (when stored) over the App token for the
  // engine's CI gate + merge reads, so those are attributed to them too. The engine
  // sets the initiator in ambient context around the gate-probe / merge boundaries.
  const engineRegistry =
    appRegistry && resolveUserGitHubToken
      ? new PatPreferringAppRegistry(appRegistry, resolveUserGitHubToken)
      : appRegistry
  const githubClient: GitHubClient | undefined =
    githubClientOverride ??
    (engineRegistry
      ? new FetchGitHubClient({
          registry: engineRegistry,
          rateLimitRepository: new NoopRateLimitRepository(),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        })
      : undefined)

  // The client the engine's gate / merge / RepoFiles seams read through: the real GitHub client
  // when present, else the GitLab-backed fallback so a GitLab-only deployment still gates on real
  // CI and merges for real (the GitHub App wins when both are configured). Kept SEPARATE from
  // `githubClient` on purpose — the GitHub-issue-specific consumers below (the GitHub Issues task
  // source, issue writeback, the App projection module) must NOT be fed the GitLab client, or a
  // GitLab-only deployment would offer a non-functional "GitHub Issues" source (it resolves the
  // empty github_installations projection). Parity with the Worker, which keeps the App client
  // distinct from its GitLab engine fallback.
  const engineVcsClient: GitHubClient | undefined = githubClient ?? gitlabEngineClient

  // Task-source integration (Jira + GitHub issues). Tenants connect their own Jira
  // site through the UI (credentials stored per-workspace, encrypted at rest); the
  // tracker resolves each workspace's own credentials from this same store. GitHub
  // issues reuse the workspace's installed App, so they wire only when `githubClient`
  // is available — kept here, after the client is built, for parity with the Worker.
  const tasks = selectNodeTasksDeps(config, db, githubClient, githubInstallationRepository)

  // Issue-tracker writeback (comment-on-PR-open + close-on-merge of a task's linked
  // issue), gated per workspace + per task inside the provider. GitHub uses the same
  // per-tenant client + installation lookup as the tracker/CI/merge providers; Jira
  // reuses the workspace's encrypted connection. Wired whenever the tracker-settings
  // repo exists (always on Node) so the engine can write back when a tracker is set.
  const resolveWritebackIssue = githubClient
    ? async (workspaceId: string, externalId: string) => {
        const parsed = githubIssuesLogic.parseGitHubIssueExternalId(externalId)
        if (!parsed) return null
        const installation = await githubInstallationRepository.getByWorkspace(workspaceId)
        if (!installation) return null
        return { installationId: installation.installationId, parsed }
      }
    : undefined
  const issueWritebackProvider = new IssueWritebackService({
    trackerSettingsRepository,
    taskRepository: sourced('taskRepository', (d) => new DrizzleTaskRepository(d)),
    fetchImpl: fetch,
    ...(githubClient && resolveWritebackIssue
      ? {
          commentOnGitHubIssue: async (workspaceId, externalId, body) => {
            const target = await resolveWritebackIssue(workspaceId, externalId)
            if (!target) return
            await githubClient.comment(
              target.installationId,
              { owner: target.parsed.owner, repo: target.parsed.repo },
              target.parsed.number,
              body,
            )
          },
          closeGitHubIssue: async (workspaceId, externalId) => {
            const target = await resolveWritebackIssue(workspaceId, externalId)
            if (!target) return
            await githubClient.closeIssue(
              target.installationId,
              { owner: target.parsed.owner, repo: target.parsed.repo },
              target.parsed.number,
            )
          },
          labelGitHubIssue: async (workspaceId, externalId, label) => {
            const target = await resolveWritebackIssue(workspaceId, externalId)
            if (!target) return
            await githubClient.applyIssueLabel?.(
              target.installationId,
              { owner: target.parsed.owner, repo: target.parsed.repo },
              target.parsed.number,
              label,
            )
          },
        }
      : {}),
    ...(tasks.taskConnectionRepository
      ? {
          resolveJiraConnection: async (workspaceId: string) => {
            const connection = await tasks.taskConnectionRepository!.getByWorkspace(
              workspaceId,
              'jira',
            )
            const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
            if (!baseUrl || !accountEmail || !apiToken) return null
            return { baseUrl, accountEmail, apiToken }
          },
          resolveLinearConnection: async (workspaceId: string) => {
            const connection = await tasks.taskConnectionRepository!.getByWorkspace(
              workspaceId,
              'linear',
            )
            const { apiKey, token } = connection?.credentials ?? {}
            return apiKey || token ? { apiKey, token } : null
          },
        }
      : {}),
  })

  let githubGateDeps: Partial<CoreDependencies> = {}
  if (engineVcsClient) {
    // The `ci` / `conflicts` gates now live in `@cat-factory/gates`; wire their providers into
    // the gate suite instead of onto the engine's CoreDependencies (single-process startup, so
    // the deployment-global handles are set once here). Parity with the Worker's selectGitHubDeps.
    // These read through `engineVcsClient` (GitHub App or the GitLab fallback), so a GitLab-only
    // deployment gates + merges for real too.
    wireCiStatusProvider(
      providerRegistry,
      new GitHubCiStatusProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
      }),
    )
    wireMergeabilityProvider(
      providerRegistry,
      new GitHubMergeabilityProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
      }),
    )
    wirePullRequestReviewProvider(
      providerRegistry,
      new GitHubPullRequestReviewProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
      }),
    )
    wireDocQualityProvider(
      providerRegistry,
      new GitHubDocQualityProvider({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
        // The gate resolves a workspace-linked template (WS1) for the block's kind, so it checks
        // against the SAME sections the doc-writer followed. In db-less mothership mode the writer
        // resolves the template through the RPC-proxied documents repo (getRoleLink is run-path
        // allow-listed), so the gate MUST use that same repo — not `undefined` — or a doc written
        // to the workspace template would be graded against the built-in skeleton (writer/gate drift).
        documentRepository: db
          ? new DrizzleDocumentRepository(db)
          : (remoteRepos?.documentRepository as CoreDependencies['documentRepository']),
      }),
    )
    githubGateDeps = {
      // The engine binds a registered custom kind's pre/post-op hooks to a run's repo
      // via this checkout-free RepoFiles resolver, composed from the same client +
      // repo-target walk the gates/merger use — parity with the Worker. The `repoFiles`
      // cache (slice 4) makes the post-op idempotency re-reads a read-through hit.
      resolveRunRepoContext: makeResolveRunRepoContext(
        engineVcsClient,
        resolveRepoTarget,
        caches?.repoFiles,
      ),
      // Block-less repo resolver for the environments module's on-demand repo
      // validation / config bootstrap (operator names owner+repo).
      resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
        engineVcsClient,
        githubInstallationRepository,
        repoProjectionRepository,
      ),
      branchUpdater: new GitHubBranchUpdater({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
      }),
      pullRequestMerger: new GitHubPullRequestMerger({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        blockRepository,
      }),
    }
  }

  // GitHub installation + projections + sync/webhook module: wired when the App is
  // configured (a real githubClient), mirroring the Worker's selectGitHubDeps. This
  // turns the GitHub read endpoints + the inline webhook/backfill sync on for Node —
  // the sync engine (GitHubSyncService) is runtime-neutral, so populating the
  // projection repos here makes the inline ingest actually persist (parity with the
  // Worker, which fans the same sync through a queue/Workflow). `canCreateRepos` /
  // `workflowsGranted` come from the App registry when present (advisory).
  const githubModuleDeps: Partial<CoreDependencies> =
    config.github.enabled && githubClient
      ? {
          githubClient,
          githubInstallationRepository,
          repoProjectionRepository,
          // The five GitHub projection repos share one shape (remote in mothership mode, else
          // Drizzle over `db`), routed through the shared `sourced` helper.
          branchProjectionRepository: sourced(
            'branchProjectionRepository',
            (d) => new DrizzleBranchProjectionRepository(d),
          ),
          pullRequestProjectionRepository: sourced(
            'pullRequestProjectionRepository',
            (d) => new DrizzlePullRequestProjectionRepository(d),
          ),
          issueProjectionRepository: sourced(
            'issueProjectionRepository',
            (d) => new DrizzleIssueProjectionRepository(d),
          ),
          commitProjectionRepository: sourced(
            'commitProjectionRepository',
            (d) => new DrizzleCommitProjectionRepository(d),
          ),
          checkRunProjectionRepository: sourced(
            'checkRunProjectionRepository',
            (d) => new DrizzleCheckRunProjectionRepository(d),
          ),
          // Per-user PAT-reachable repo projection (picker expansion + redaction); Postgres-only,
          // so absent in a no-DB mothership node (the picker keeps its App-only behaviour there).
          userRepoAccessRepository: db ? new DrizzleUserRepoAccessRepository(db) : undefined,
          webhookVerifier: new WebCryptoWebhookVerifier(config.github.webhookSecret),
          // Bound the initial backfill to the commit retention horizon (0 = full).
          commitBackfillHorizonMs: config.retention.commitMs || undefined,
          ...(appRegistry
            ? {
                // Privileged App tier (ADR 0005): when configured, its client backs the
                // create-repo endpoint; `canCreateRepos` flags a connection whose
                // installation is owned by the privileged App. Absent → repo creation
                // stays the manual flow (parity with the Worker's selectGitHubDeps).
                repoProvisioningClient: config.github.privilegedApp
                  ? new FetchGitHubProvisioningClient({
                      registry: appRegistry,
                      apiBase: config.github.apiBase,
                    })
                  : undefined,
                canCreateRepos: (installation) => appRegistry.canCreateRepos(installation),
                workflowsGranted: async (installation) => {
                  const perms = await appRegistry.installationPermissions(
                    installation.installationId,
                  )
                  return perms.workflows === 'write'
                },
              }
            : {}),
        }
      : {}

  return {
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
  }
}
