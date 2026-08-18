import type { Clock, GitHubClient, IdGenerator, ProviderRegistry } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  wireCiStatusProvider,
  wireDocQualityProvider,
  wireMergeabilityProvider,
  wirePullRequestReviewProvider,
} from '@cat-factory/gates'
import { buildGitLabEngineClient } from '@cat-factory/gitlab'
import {
  deploymentRepoOrigin,
  GitHubDocQualityProvider,
  GitHubPrReportPublisher,
  GitHubPullRequestReviewProvider,
  logger,
  PatPreferringAppRegistry,
} from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import type { AppConfig } from './config'
import type { Env } from './env'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { GitHubBranchUpdater } from './github/GitHubBranchUpdater'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import {
  buildAppRegistry,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  buildResolveRunInitiatorToken,
} from './container-vcs-identity'

// ---------------------------------------------------------------------------
// The engine's VCS-backed halves of the merge lifecycle: the client every gate / merge / review
// path reads through, and the providers and publishers built over it. Lifted out of
// `container.ts` (which was crowding its size budget) as one cohesive collaborator, the Worker's
// counterpart to the Node facade's `container-github-deps.ts`.
//
// They belong together because they answer one question: what this deployment's source control
// lets the engine do. Without a client, every one of them is absent and the gates pass through,
// which is the graceful degradation a deployment with no VCS configured runs on.
// ---------------------------------------------------------------------------

/**
 * The GitHubClient the engine's gate / merge / RepoFiles paths read through: the GitHub App
 * (preferring the run initiator's per-user PAT when stored), else a GitLab-backed single-token
 * client (bridged onto the GitHubClient port). Undefined when neither is configured, and the
 * gates then pass through. Shared by the merge-lifecycle and RepoFiles wiring so they resolve the
 * SAME provider, and so the GitLab fallback cannot drift from the App path.
 */
export function selectEngineVcsClient(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): GitHubClient | undefined {
  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const baseRegistry = buildAppRegistry(env, config, db, clock)
    // Prefer the run initiator's per-user PAT (when stored AND the workspace permits it) over
    // the App token for the CI gate + merge reads; the engine sets the run's credential scope
    // in ambient context around those boundaries (runWithInitiator). Falls back to the App
    // token otherwise.
    const resolveRunInitiatorToken = buildResolveRunInitiatorToken(env, db, clock)
    const registry = resolveRunInitiatorToken
      ? new PatPreferringAppRegistry(baseRegistry, resolveRunInitiatorToken)
      : baseRegistry
    return new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
  }
  if (config.gitlab.enabled && env.GITLAB_TOKEN) {
    return buildGitLabEngineClient({
      token: env.GITLAB_TOKEN,
      apiBase: config.gitlab.apiBase,
      clock,
      logger,
    })
  }
  return undefined
}

/** What {@link wireEngineVcsDeps} needs from the composition root. */
export interface EngineVcsDepsInput {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  idGenerator: IdGenerator
  providerRegistry: ProviderRegistry
}

/**
 * Wire everything the engine's VCS client backs: the `ci` / `conflicts` / review / doc-quality
 * gate providers onto the gate suite, and the branch updater, pull-request merger and PR
 * verification-report publisher onto the engine's dependencies. No client (neither the App nor a
 * GitLab token configured) means none of them is wired, the gates pass through, and `done` is a
 * board-only flip.
 *
 * Returns the dependency slice the caller merges, and mutates `providerRegistry` for the gate
 * handles, which are deployment-global rather than per-run.
 */
export function wireEngineVcsDeps(input: EngineVcsDepsInput): Partial<CoreDependencies> {
  const { env, config, db, clock, idGenerator, providerRegistry } = input
  const githubClient = selectEngineVcsClient(env, config, db, clock, idGenerator)
  if (!githubClient) return {}

  const resolveRepoTarget = buildResolveRepoTarget(db)
  const blockRepository = new D1BlockRepository({ db })
  // The `ci` / `conflicts` gates live in `@cat-factory/gates`; wire their providers into the gate
  // suite (deployment-global handles) instead of onto the engine's CoreDependencies.
  wireCiStatusProvider(
    providerRegistry,
    new GitHubCiStatusProvider({ githubClient, resolveRepoTarget, blockRepository }),
  )
  wireMergeabilityProvider(
    providerRegistry,
    new GitHubMergeabilityProvider({ githubClient, resolveRepoTarget, blockRepository }),
  )
  wirePullRequestReviewProvider(
    providerRegistry,
    new GitHubPullRequestReviewProvider({ githubClient, resolveRepoTarget, blockRepository }),
  )
  wireDocQualityProvider(
    providerRegistry,
    new GitHubDocQualityProvider({
      githubClient,
      resolveRepoTarget,
      blockRepository,
      // The gate resolves a workspace-linked template (WS1) for the block's kind, so it checks
      // against the SAME sections the doc-writer followed. Cheap query wrapper over the same D1.
      documentRepository: new D1DocumentRepository({ db }),
    }),
  )
  return {
    branchUpdater: new GitHubBranchUpdater({ githubClient, resolveRepoTarget, blockRepository }),
    pullRequestMerger: new GitHubPullRequestMerger({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    }),
    // Keeps the engine-maintained verification report current on every pull request the run
    // opened: the own-service one plus each peer repo's on a cross-service task. Reads through the
    // same engine VCS client, so a GitLab-only deployment gets it too (runtime symmetry with the
    // Node facade's `githubGateDeps`), and resolves its targets through the SAME deployment origin
    // the dispatch clones from. Without that the report would name `provider: 'github'` for every
    // repo on a GitLab deployment and route itself to the wrong host, which is exactly the
    // mis-routing the publisher's own contract warns about.
    prVerificationReportPublisher: new GitHubPrReportPublisher({
      githubClient,
      resolveRepoTarget,
      resolveRepoTargets: buildResolveRepoTargets(db),
      blockRepository,
      resolveRepoOrigin: deploymentRepoOrigin(config),
      logger,
    }),
  }
}
