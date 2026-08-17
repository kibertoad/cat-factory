import {
  GitHubIssuesProvider,
  GitLabIssuesProvider,
  IssueWritebackService,
  JiraProvider,
  LinearTaskProvider,
  VcsPatConnectionService,
  createTaskConnectionStore,
  gitlabWebBaseFromApiBase,
} from '@cat-factory/integrations'
import { GitLabIdentityResolver, buildGitLabConnectClient } from '@cat-factory/gitlab'
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
  BranchProjectionRepository,
  CheckRunProjectionRepository,
  CommitProjectionRepository,
  IssueProjectionRepository,
  PullRequestProjectionRepository,
  RepoProjectionRepository,
  TaskConnectionStore,
  TaskSourceProvider,
  TrackerSettingsRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type GitHubAppRegistry,
  type ResolveRepoTarget,
  type ResolveRepoTargets,
  type ResolveRepoOrigin,
  type ResolveRunInitiatorToken,
  FetchGitHubClient,
  FetchGitHubProvisioningClient,
  GitHubBranchUpdater,
  GitHubCiStatusProvider,
  GitHubDocQualityProvider,
  GitHubMergeabilityProvider,
  GitHubPrReportPublisher,
  GitHubPullRequestMerger,
  GitHubPullRequestReviewProvider,
  PatPreferringAppRegistry,
  providerRoutingGitHubClient,
  logger,
  resolveVcsWebUrls,
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
  DrizzleTaskConnectionRepository,
  DrizzleTaskRepository,
  DrizzleTaskSourceSettingsRepository,
} from './repositories/tasks.js'
import {
  DrizzleReviewQuestionPostRepository,
  DrizzleTrackerCommentIngestRepository,
} from './repositories/drizzle/settings.js'
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

/**
 * The result shape of {@link selectNodeTasksDeps}: the module deps plus the connection STORE the
 * facade's own tracker/writeback closures read credentials through (the repository beside it holds
 * only sealed rows).
 */
export interface NodeTasksDeps {
  deps: Partial<CoreDependencies>
  taskConnectionStore?: TaskConnectionStore
}

/**
 * Wire the task-source integration for the Node facade (Jira + Linear always; the two VCS-backed
 * issue sources only when their client is available, since each reuses the workspace's own VCS
 * connection). Mirrors the Cloudflare facade's gating (see CLAUDE.md parity rule). Whether a
 * workspace OFFERS a source is the per-workspace toggle (task_source_settings), not a deployment
 * env gate.
 */
function selectNodeTasksDeps(input: {
  config: AppConfig
  db: DrizzleDb
  githubClient: GitHubClient | undefined
  /** Whichever client can read the workspace's GitLab connection (the caller resolves which). */
  gitlabClient: GitHubClient | undefined
  installations: GitHubInstallationRepository
  sourced: NodeGitHubDepsInput['sourced']
  secretDelegate: CoreDependencies['secretDelegate']
}): NodeTasksDeps {
  const { config, db, githubClient, gitlabClient, installations, sourced, secretDelegate } = input
  if (!config.tasks.enabled || !config.tasks.encryptionKey) return { deps: {} }
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever a GitHub client is available (the App is configured) — it has no
  // credentials of its own and resolves the installation per issue.
  if (githubClient) {
    providers.push(new GitHubIssuesProvider({ githubClient, installations }))
  }
  // GitLab Issues are the same credentialless shape over whichever client can read the
  // workspace's GitLab connection (the caller resolves which). Fed that client DIRECTLY, never
  // the provider-routing one: this source answers GitLab questions only, and the availability
  // check keys on the connection row's own provider.
  if (gitlabClient) {
    providers.push(
      new GitLabIssuesProvider({
        gitlabClient,
        installations,
        webBaseUrl: gitlabWebBaseFromApiBase(config.gitlab.apiBase),
      }),
    )
  }

  // Every repo here rides the `pickRepoSource` seam: these rows are org state, and since the
  // connection row now carries its credential bag SEALED, the whole integration is serveable over
  // the persistence RPC. A mothership-mode node opens the bag by naming the row.
  const taskConnectionRepository = sourced(
    'taskConnectionRepository',
    (d) => new DrizzleTaskConnectionRepository(d),
  )
  const taskConnectionStore = createTaskConnectionStore({
    taskConnectionRepository,
    // Source credentials are sealed at rest under a tasks-scoped HKDF info (the same domain the
    // Cloudflare facade uses), keyed by the shared ENCRYPTION_KEY.
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.tasks.encryptionKey,
      info: 'cat-factory:tasks',
    }),
    ...(secretDelegate ? { secretDelegate } : {}),
  })
  return {
    deps: {
      taskSourceProviders: providers,
      taskConnectionRepository,
      taskConnectionStore,
      taskSourceSettingsRepository: sourced(
        'taskSourceSettingsRepository',
        (d) => new DrizzleTaskSourceSettingsRepository(d),
      ),
      taskRepository: new DrizzleTaskRepository(db),
      // Idempotency markers for INBOUND tracker comments. Wired alongside the task module rather
      // than the writeback, because it guards the INGEST half (a redelivered comment applying its
      // answers twice), which exists only when the task projection does.
      trackerCommentIngestRepository: new DrizzleTrackerCommentIngestRepository(db),
    },
    taskConnectionStore,
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
  /**
   * Present ONLY on a mothership-mode node: opens a tracker connection sealed under the
   * MOTHERSHIP's key, which this process holds none of. The tracker step files a ticket on the
   * RUN path, so without it a mothership-mode run reaches that step and fails there.
   */
  secretDelegate?: CoreDependencies['secretDelegate']
  idGenerator: IdGenerator
  clock: Clock
  appRegistry: GitHubAppRegistry | undefined
  /** An injected client (the local facade's PAT-backed one) wins over the App-minted client. */
  githubClientOverride?: GitHubClient
  /**
   * The shared "does this run act with its initiator's own token?" decision, built once at the
   * composition root. Absent ⇒ no per-user secret store is wired and the engine client always
   * authenticates as the App.
   */
  resolveRunInitiatorToken?: ResolveRunInitiatorToken
  /** The GitLab-backed engine client, used as the gate/merge fallback when no GitHub App is set. */
  gitlabEngineClient: GitHubClient | undefined
  providerRegistry: ProviderRegistry
  resolveRepoTarget: ResolveRepoTarget
  /**
   * The MULTI-REPO resolver, so the verification report reaches a cross-service run's PEER pull
   * requests as well as its own-service one (it supplies the connection each peer repo's write
   * goes through). Absent ⇒ own-service PRs only, which is also the only kind a deployment
   * without the involved-services fan-out ever opens.
   */
  resolveRepoTargets?: ResolveRepoTargets
  /**
   * Maps a resolved repo to its origin. Threaded through so the verification report states the
   * deployment's real provider instead of assuming GitHub; absent ⇒ the shared `githubRepoOrigin`
   * default, exactly as on every other clone/dispatch path.
   */
  resolveRepoOrigin?: ResolveRepoOrigin
  githubInstallationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  /**
   * The four entity projections + the check-run one, sourced once by the run platform (remote in
   * mothership mode, else Drizzle) so the mothership's persistence registry and this module share
   * ONE instance each.
   */
  entityProjectionRepositories: {
    branchProjectionRepository: BranchProjectionRepository
    pullRequestProjectionRepository: PullRequestProjectionRepository
    issueProjectionRepository: IssueProjectionRepository
    commitProjectionRepository: CommitProjectionRepository
    checkRunProjectionRepository: CheckRunProjectionRepository
  }
  blockRepository: BlockRepository
  trackerSettingsRepository: TrackerSettingsRepository
  /** Needed by the per-workspace GitLab PAT connect service (workspace existence guard). */
  workspaceRepository: WorkspaceRepository
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
    resolveRunInitiatorToken,
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
  // Prefer the run initiator's per-user PAT (when stored AND the workspace permits it) over
  // the App token for the engine's CI gate + merge reads, so those are attributed to them too.
  // The engine sets the run's credential scope in ambient context around the gate-probe /
  // merge boundaries.
  const engineRegistry =
    appRegistry && resolveRunInitiatorToken
      ? new PatPreferringAppRegistry(appRegistry, resolveRunInitiatorToken)
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

  // Per-workspace GitLab PAT connect (opt-in): the GitLab-backed client whose token source
  // decrypts each workspace's sealed PAT, plus the connect service the controller drives.
  // Built HERE rather than inside the module-deps builder because two consumers need it: the
  // `github` module's routing client and the GitLab Issues task source below.
  const gitlabConnect = selectVcsConnectDeps({
    config,
    installations: githubInstallationRepository,
    workspaceRepository: input.workspaceRepository,
    clock,
  })

  // The client the GitLab Issues task source reads through. A hosted deployment uses the
  // per-workspace connect client. LOCAL mode has no such connection and needs no second client:
  // it is single-provider, and the injected client already ROUTES by the deployment credential,
  // so the same client backs both VCS-backed sources there. Registering both is not ambiguous,
  // because availability is the connection row's own `provider` — exactly one of the two is ever
  // offered, and in local GitLab mode that is this one rather than a GitHub Issues source whose
  // `owner/repo#n` grammar cannot spell a subgroup project.
  const gitlabTasksClient = gitlabConnect?.client ?? githubClientOverride

  // Task-source integration (Jira + Linear + the two VCS-backed issue sources). Tenants connect
  // their own Jira site through the UI (credentials stored per-workspace, encrypted at rest); the
  // tracker resolves each workspace's own credentials from this same store. GitHub and GitLab
  // issues reuse the workspace's own VCS connection, so each wires only when its client is
  // available — kept here, after the clients are built, for parity with the Worker.
  const tasks = selectNodeTasksDeps({
    config,
    db,
    githubClient,
    gitlabClient: gitlabTasksClient,
    installations: githubInstallationRepository,
    sourced,
    secretDelegate: input.secretDelegate,
  })

  // Issue-tracker writeback (comment-on-PR-open + close-on-merge of a task's linked
  // issue), gated per workspace + per task inside the provider.
  const issueWritebackProvider = buildNodeIssueWriteback({
    trackerSettingsRepository,
    sourced,
    clock,
    taskSourceProviders: tasks.deps.taskSourceProviders ?? [],
    taskConnectionStore: tasks.taskConnectionStore,
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
      // Keeps the engine-maintained verification report current on every pull request the run
      // opened — the own-service one plus each peer repo's. Reads through the same
      // `engineVcsClient`, so a GitLab-only deployment gets it too.
      prVerificationReportPublisher: new GitHubPrReportPublisher({
        githubClient: engineVcsClient,
        resolveRepoTarget,
        resolveRepoTargets: input.resolveRepoTargets,
        blockRepository,
        resolveRepoOrigin: input.resolveRepoOrigin,
        logger,
      }),
    }
  }

  const githubModuleDeps = buildNodeGitHubModuleDeps({
    input,
    githubClient,
    gitlabConnect,
  })

  return {
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
  }
}

/**
 * Wire the per-workspace GitLab PAT connect deps: the GitLab-backed `GitHubClient` (its token
 * source decrypts each workspace's sealed PAT) that the `github` module reads through for a
 * `gitlab` connection, plus the `VcsPatConnectionService` the connect controller drives. Enabled
 * only when GitLab is configured AND a sealing key is present. Runtime-neutral inputs, so the
 * Worker facade wires it the same way (per "keep the runtimes symmetric").
 */
function selectVcsConnectDeps(input: {
  config: AppConfig
  installations: GitHubInstallationRepository
  workspaceRepository: WorkspaceRepository
  clock: Clock
}): { client: GitHubClient; service: VcsPatConnectionService } | undefined {
  const { config, installations, workspaceRepository, clock } = input
  const gitlab = config.gitlab
  if (!gitlab.enabled || !gitlab.encryptionKey) return undefined
  // One cipher seals (connect) and unseals (token source) under the same domain, so the two
  // instances the client + service build from the same key + info interoperate.
  const cipher = new WebCryptoSecretCipher({
    masterKeyBase64: gitlab.encryptionKey,
    info: 'cat-factory:vcs-token',
  })
  const client = buildGitLabConnectClient({
    installations,
    cipher,
    apiBase: gitlab.apiBase,
    clock,
    logger,
  })
  const service = new VcsPatConnectionService({
    provider: 'gitlab',
    installations,
    workspaceRepository,
    identityResolver: new GitLabIdentityResolver({ apiBase: gitlab.apiBase }),
    cipher,
    clock,
    // Where this connection's projects can be opened in a browser, from the SAME resolver the
    // App connect path and the connect-capability route read.
    webUrls: resolveVcsWebUrls(config),
  })
  return { client, service }
}

/**
 * Assemble the deps for the `github` module (installation + the five projections + sync/webhook),
 * including the per-workspace GitLab PAT connect wiring and the provider-routing client that
 * fronts them when BOTH a GitHub App and GitLab connect are configured. Split out of
 * {@link selectNodeGitHubDeps} along the module-deps seam so that selector stays within the
 * per-function line budget, in the same shape as its {@link selectNodeTasksDeps} sibling.
 * Behaviour-neutral: the same values are built in the same order.
 */
function buildNodeGitHubModuleDeps(args: {
  input: NodeGitHubDepsInput
  /** The engine/App client already resolved by the caller (an override or App-minted). */
  githubClient: GitHubClient | undefined
  /** The per-workspace GitLab connect wiring, resolved once by the caller (two consumers). */
  gitlabConnect: ReturnType<typeof selectVcsConnectDeps>
}): Partial<CoreDependencies> {
  const { input, githubClient, gitlabConnect } = args
  const { config, db, appRegistry, githubInstallationRepository, repoProjectionRepository } = input
  const { entityProjectionRepositories } = input

  // GitHub installation + projections + sync/webhook module: wired when the App is
  // configured (a real githubClient), mirroring the Worker's selectGitHubDeps. This
  // turns the GitHub read endpoints + the inline webhook/backfill sync on for Node —
  // the sync engine (GitHubSyncService) is runtime-neutral, so populating the
  // projection repos here makes the inline ingest actually persist (parity with the
  // Worker, which fans the same sync through a queue/Workflow). `canCreateRepos` /
  // `workflowsGranted` come from the App registry when present (advisory).
  // The per-workspace GitLab PAT connect wiring (resolved by the caller): a GitLab-backed client
  // whose token source decrypts each workspace's sealed PAT, plus the connect service that
  // validates + seals a pasted PAT. This lets a workspace connect GitLab through the UI and reuse
  // the SAME GitHub-shaped projection/sync surface. Mirrors the Worker's `selectGitHubDeps` (per
  // "keep the runtimes symmetric").
  const gitlabConnectClient = gitlabConnect?.client
  const vcsConnectionService = gitlabConnect?.service

  // The client the `github` module (installation / sync / service) reads through. When BOTH a
  // GitHub App and GitLab connect are configured, route each installation-keyed call to the
  // matching client by the connection's stored provider; otherwise the single configured client
  // serves the module directly.
  const appClient = config.github.enabled ? githubClient : undefined
  const moduleClient: GitHubClient | undefined =
    appClient && gitlabConnectClient
      ? providerRoutingGitHubClient({
          installations: githubInstallationRepository,
          github: appClient,
          gitlab: gitlabConnectClient,
        })
      : (appClient ?? gitlabConnectClient)

  return moduleClient
    ? {
        githubClient: moduleClient,
        // Surfaced on the container for the GitLab connect controller (a CoreDependency, so it
        // flows through `createCore` onto the ServerContainer). Present only with GitLab connect.
        ...(vcsConnectionService ? { vcsConnectionService } : {}),
        githubInstallationRepository,
        repoProjectionRepository,
        // The five GitHub projection repos share one shape (remote in mothership mode, else
        // Drizzle over `db`). Sourced ONCE in `container-run-platform.ts` and passed in, because
        // the mothership's persistence registry reflects the same instances whether or not this
        // module is wired.
        ...entityProjectionRepositories,
        // Per-user PAT-reachable repo projection (picker expansion + redaction); Postgres-only,
        // so absent in a no-DB mothership node (the picker keeps its App-only behaviour there).
        userRepoAccessRepository: db ? new DrizzleUserRepoAccessRepository(db) : undefined,
        // The GitHub webhook verifier is App-specific (a GitLab-only deployment ingests via the
        // neutral `/vcs/:provider/webhooks` route, not this verifier), so wire it only with the App.
        ...(appClient
          ? { webhookVerifier: new WebCryptoWebhookVerifier(config.github.webhookSecret) }
          : {}),
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
                const perms = await appRegistry.installationPermissions(installation.installationId)
                return perms.workflows === 'write'
              },
            }
          : {}),
      }
    : {}
}

/**
 * Assemble the issue-tracker writeback provider (comment-on-PR-open + close/label-on-merge of a
 * task's linked issue), gated per workspace + per task inside the provider. Every vendor detail
 * now rides the task-source providers themselves (each declares a `writeback` adapter), so this
 * hands over the SAME provider array the tasks module registers and the SAME connection store the
 * reads authenticate through. Split out of {@link selectNodeGitHubDeps} for the per-function line
 * budget, in the same shape as its {@link selectNodeTasksDeps} sibling.
 */
function buildNodeIssueWriteback(args: {
  trackerSettingsRepository: TrackerSettingsRepository
  sourced: NodeGitHubDepsInput['sourced']
  clock: Clock
  taskSourceProviders: readonly TaskSourceProvider[]
  taskConnectionStore: TaskConnectionStore | undefined
}): IssueWritebackService {
  const { trackerSettingsRepository, sourced, clock, taskSourceProviders, taskConnectionStore } =
    args
  return new IssueWritebackService({
    trackerSettingsRepository,
    taskRepository: sourced('taskRepository', (d) => new DrizzleTaskRepository(d)),
    // BY REFERENCE, the same array `selectNodeTasksDeps` hands the tasks module: a source is
    // registered once and is then both readable and writeable, so a deployment's own tracker
    // cannot end up with intake and no way to answer it.
    taskSourceProviders,
    // Idempotency markers for the headless clarification loop's question echo — without them
    // the writeback passes through, since a replaying driver would otherwise re-post.
    reviewQuestionPostRepository: sourced(
      'reviewQuestionPostRepository',
      (d) => new DrizzleReviewQuestionPostRepository(d),
    ),
    clock,
    // Every hook here is fire-and-forget; without a logger a permanently broken tracker
    // connection produces no symptom but comments that never appear.
    logger,
    // The store the adapters authenticate through, and the one fact the parked-review question
    // comment needs before it tells a reporter to answer on the ticket: whether an inbound
    // webhook secret was ever minted for that connection. Without it the reply path fails closed,
    // so the copy offers the API route alone. Mirrored in the Worker's `selectRecurringDeps`.
    ...(taskConnectionStore ? { taskConnectionStore } : {}),
  })
}
