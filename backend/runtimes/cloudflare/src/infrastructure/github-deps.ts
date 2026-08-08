import type {
  CachedRepoRead,
  Clock,
  GitHubClient,
  GroupCacheHandle,
  IdGenerator,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  makeResolveRepoFilesForCoords,
  makeResolveRunRepoContext,
  providerRoutingGitHubClient,
  logger,
} from '@cat-factory/server'
import { buildGitLabEngineClient } from '@cat-factory/gitlab'
import type { AppConfig } from './config'
import type { Env } from './env'
import { selectWorkerVcsConnectDeps } from './vcsConnect'
import { buildAppRegistry, buildResolveRepoTarget } from './container'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { FetchGitHubProvisioningClient } from './github/FetchGitHubProvisioningClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from './repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from './repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from './repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from './repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from './repositories/D1CheckRunProjectionRepository'
import { D1UserRepoAccessRepository } from './repositories/D1UserRepoAccessRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'

// ---------------------------------------------------------------------------
// The Worker facade's GitHub/GitLab module-dependency selector, extracted from the
// `container.ts` composition root so that god-file stays within its size budget (the
// split mirrors the Node facade, whose analogue lives in `container-github-deps.ts`).
// The two shared building blocks it needs — `buildAppRegistry` + `buildResolveRepoTarget`
// — stay in `container.ts` (used by many other selectors) and are imported back here,
// the same one-directional pattern `container-assembly.ts` already uses.
// ---------------------------------------------------------------------------

/** The eight D1 projection repositories the `github` module reads/writes, built once. */
function buildProjectionRepositories(db: D1Database): Partial<CoreDependencies> {
  return {
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    branchProjectionRepository: new D1BranchProjectionRepository({ db }),
    pullRequestProjectionRepository: new D1PullRequestProjectionRepository({ db }),
    issueProjectionRepository: new D1IssueProjectionRepository({ db }),
    commitProjectionRepository: new D1CommitProjectionRepository({ db }),
    checkRunProjectionRepository: new D1CheckRunProjectionRepository({ db }),
    userRepoAccessRepository: new D1UserRepoAccessRepository({ db }),
  }
}

/**
 * Build the GitHub integration's concrete ports when an App is configured,
 * mirroring `selectWorkRunner`. Returns an empty object otherwise, so `createCore`
 * leaves the `github` module unassembled and the feature stays opt-in.
 */
export function selectGitHubDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
  repoFilesCache: GroupCacheHandle<CachedRepoRead>,
): Partial<CoreDependencies> {
  const githubInstallationRepository = new D1GitHubInstallationRepository({ db })
  // Per-workspace GitLab PAT connect (opt-in): a GitLab-backed client whose token source decrypts
  // each workspace's sealed PAT, plus the connect service that validates + seals a pasted PAT.
  // Mirrors the Node facade's `selectVcsConnectDeps` (per "keep the runtimes symmetric").
  const gitlabConnect = selectWorkerVcsConnectDeps(config, githubInstallationRepository, db, clock)
  const gitlabConnectClient = gitlabConnect?.client

  if (!config.github.enabled) {
    // GitLab-only deployment: the App-shaped provisioning wiring stays off (GitLab ingests via the
    // neutral `/vcs/:provider/webhooks` route), but the checkout-free RepoFiles seams — a registered
    // custom kind's pre/post-op hooks + the environments module's on-demand repo validation — must
    // still work, so wire them from the single-token GitLab engine client. When per-workspace connect
    // is enabled, ALSO wire the `github` module (browse/link/sync) with the per-workspace connect
    // client + the connect service, so a GitLab user connects and manages repos through the UI.
    if (config.gitlab.enabled && env.GITLAB_TOKEN) {
      const engineClient = buildGitLabEngineClient({
        token: env.GITLAB_TOKEN,
        apiBase: config.gitlab.apiBase,
        clock,
        logger,
      })
      return {
        resolveRunRepoContext: makeResolveRunRepoContext(
          engineClient,
          buildResolveRepoTarget(db),
          repoFilesCache,
        ),
        resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
          engineClient,
          githubInstallationRepository,
          new D1RepoProjectionRepository({ db }),
        ),
        ...(gitlabConnectClient
          ? {
              githubClient: gitlabConnectClient,
              githubInstallationRepository,
              ...buildProjectionRepositories(db),
              commitBackfillHorizonMs: config.retention.commitMs || undefined,
            }
          : {}),
        ...(gitlabConnect ? { vcsConnectionService: gitlabConnect.service } : {}),
      }
    }
    return {}
  }

  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })
  // Privileged App tier (ADR 0005): when configured, its client backs the
  // create-repo endpoint; `canCreateRepos` flags a connection whose installation
  // is owned by the privileged App. Absent → repo creation stays the manual flow.
  const repoProvisioningClient = config.github.privilegedApp
    ? new FetchGitHubProvisioningClient({ registry, apiBase: config.github.apiBase })
    : undefined
  // The client the `github` module reads through: when per-workspace GitLab connect is ALSO
  // enabled, route each installation-keyed call to the App or GitLab client by the connection's
  // stored provider; otherwise the App client serves the module directly. The RepoFiles seams +
  // the GitHub-issue/docs consumers keep the raw App `githubClient` (they must not gain the
  // GitLab fallback, per CLAUDE.md's VCS rule).
  const moduleClient: GitHubClient = gitlabConnectClient
    ? providerRoutingGitHubClient({
        installations: githubInstallationRepository,
        github: githubClient,
        gitlab: gitlabConnectClient,
      })
    : githubClient
  return {
    githubClient: moduleClient,
    ...(gitlabConnect ? { vcsConnectionService: gitlabConnect.service } : {}),
    // The engine binds a registered custom kind's pre/post-op hooks to a run's repo via
    // this checkout-free RepoFiles resolver (installation + repo + default branch),
    // composed from the same client + repo-target walk the container executor uses. The
    // `repoFiles` cache (slice 4) makes the post-op idempotency re-reads a read-through hit.
    resolveRunRepoContext: makeResolveRunRepoContext(
      githubClient,
      buildResolveRepoTarget(db),
      repoFilesCache,
    ),
    // Block-less repo resolver for the environments module's on-demand repo validation /
    // config bootstrap (operator names owner+repo).
    resolveRepoFilesForCoords: makeResolveRepoFilesForCoords(
      githubClient,
      githubInstallationRepository,
      new D1RepoProjectionRepository({ db }),
    ),
    githubInstallationRepository,
    ...buildProjectionRepositories(db),
    webhookVerifier: new WebCryptoWebhookVerifier(env.GITHUB_WEBHOOK_SECRET!),
    // Bound the initial backfill to the commit retention horizon (0 = full).
    commitBackfillHorizonMs: config.retention.commitMs || undefined,
    repoProvisioningClient,
    canCreateRepos: (installation) => registry.canCreateRepos(installation),
    // Advisory: does the install actually grant `workflows: write`? Read from the
    // owning App's installation-token permission set (cached), so the UI can warn
    // when agent pushes touching `.github/workflows/*` would be rejected.
    workflowsGranted: async (installation) => {
      const perms = await registry.installationPermissions(installation.installationId)
      return perms.workflows === 'write'
    },
  }
}
