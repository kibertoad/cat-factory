import type { Clock, IdGenerator, TaskSourceProvider } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  createTaskConnectionStore,
  GitHubIssuesProvider,
  GitLabIssuesProvider,
  gitlabWebBaseFromApiBase,
  JiraProvider,
  LinearTaskProvider,
} from '@cat-factory/integrations'
import type { AppConfig } from './config'
import type { Env } from './env'
import { buildAppRegistry } from './container'
import { selectWorkerVcsConnectDeps } from './vcsConnect'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
import { D1TaskSourceSettingsRepository } from './repositories/D1TaskSourceSettingsRepository'
import { D1TrackerCommentIngestRepository } from './repositories/D1TrackerCommentIngestRepository'

// ---------------------------------------------------------------------------
// The Worker facade's task-source selector, extracted from the `container.ts`
// composition root so that god-file stays within its size budget — the same split
// `github-deps.ts` and `vcsConnect.ts` already made, and the same one-directional
// import back to `container.ts` for the shared `buildAppRegistry` building block.
// ---------------------------------------------------------------------------

/**
 * Build the task-source integration's concrete ports. Mirrors `selectDocumentsDeps`
 * but with no planner — issues are linked for context, not expanded into board
 * structure. Always on (config load fails loudly without the encryption key), so this
 * is wired on every deployment.
 */
export function selectTasksDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  // Jira and Linear are always registered (their credentials are per-workspace, entered in the UI).
  const providers: TaskSourceProvider[] = [new JiraProvider(), new LinearTaskProvider()]
  const installations = new D1GitHubInstallationRepository({ db })
  // GitHub Issues reuse the workspace's installed GitHub App, so this provider is
  // wired whenever the GitHub integration is configured — it has no credentials of
  // its own and resolves the installation per issue. Whether a workspace OFFERS it
  // is the per-workspace toggle (task_source_settings), not a deployment env gate.
  if (config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubIssuesProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations,
      }),
    )
  }
  // GitLab Issues are the same credentialless shape over the per-workspace GitLab connect
  // client, so they wire whenever that connect flow is configured — the same condition the
  // `github` module's GitLab leg uses. Fed the GitLab client DIRECTLY (never the
  // provider-routing one): this source answers GitLab questions only. Mirrors the Node
  // facade's `selectNodeTasksDeps` (per "keep the runtimes symmetric").
  const gitlabConnect = selectWorkerVcsConnectDeps(config, installations, db, clock)
  if (gitlabConnect) {
    providers.push(
      new GitLabIssuesProvider({
        gitlabClient: gitlabConnect.client,
        installations,
        webBaseUrl: gitlabWebBaseFromApiBase(config.gitlab?.apiBase),
      }),
    )
  }
  const taskConnectionRepository = new D1TaskConnectionRepository({ db })
  return {
    taskSourceProviders: providers,
    taskConnectionRepository,
    taskConnectionStore: createTaskConnectionStore({
      taskConnectionRepository,
      // The config gate guarantees the key is present when enabled; source credentials are sealed
      // at rest under a tasks-scoped HKDF info. No delegate: a Cloudflare deployment holds its own
      // key (it is the mothership others delegate TO).
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskSourceSettingsRepository: new D1TaskSourceSettingsRepository({ db }),
    taskRepository: new D1TaskRepository({ db }),
    // Idempotency markers for INBOUND tracker comments. Wired alongside the task module rather
    // than the writeback, because it guards the INGEST half (a redelivered comment applying its
    // answers twice), which exists only when the task projection does.
    trackerCommentIngestRepository: new D1TrackerCommentIngestRepository({ db }),
  }
}
