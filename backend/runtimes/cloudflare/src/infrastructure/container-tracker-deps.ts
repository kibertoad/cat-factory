import type { D1Database } from '@cloudflare/workers-types'
import type { Clock, IdGenerator, TaskSourceProvider } from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  createTaskConnectionStore,
  IssueWritebackService,
  TicketTrackerService,
} from '@cat-factory/integrations'
import {
  FetchGitHubClient,
  logger,
  type AppConfig,
  WebCryptoSecretCipher,
} from '@cat-factory/server'
import type { Env } from './env.js'
import { buildAppRegistry, buildResolveRepoTarget } from './container.js'
import { D1PipelineScheduleRepository } from './repositories/D1PipelineScheduleRepository.js'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository.js'
import { D1ReviewQuestionPostRepository } from './repositories/D1ReviewQuestionPostRepository.js'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository.js'
import { D1TaskRepository } from './repositories/D1TaskRepository.js'
import { D1TrackerSettingsRepository } from './repositories/D1TrackerSettingsRepository.js'

// The recurring-pipeline + issue-tracker slice of the Worker composition root, lifted out of
// `container.ts` for the per-file line budget in the same shape as the Node facade's
// `container-github-deps.ts`. It is one cohesive concern: the tech-debt pipeline's ticket
// FILING and the task-linked-issue WRITEBACK share every credential seam (the App-authenticated
// GitHub client, the workspace's stored Jira/Linear connections), so they are wired together or
// not at all. Behaviour-neutral relative to the inline version.

/**
 * Wire the recurring-pipeline + issue-tracker ports. The schedule + tracker-setting
 * repositories are always available (the feature is workspace-scoped CRUD); the
 * `ticketTrackerProvider` files the tech-debt pipeline's issue and degrades
 * gracefully — it files GitHub issues only when the App is configured (so it can
 * resolve the service's repo + mint a token) and Jira only when the tasks
 * integration's encryption key is set (so it can read the workspace's stored Jira
 * credentials). With neither, the `tracker` step passes through.
 */
export function selectRecurringDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
  taskSourceProviders: readonly TaskSourceProvider[],
): Partial<CoreDependencies> {
  const trackerDeps: ConstructorParameters<typeof TicketTrackerService>[0] = {
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    // workerd exposes a global fetch; the Jira create call uses it.
    fetchImpl: fetch,
  }
  // Writeback (comment-on-PR-open + close-on-merge of a task's linked issue) carries no vendor
  // code of its own any more: each task source declares a `writeback` adapter, so this hands over
  // the SAME provider array `selectTasksDeps` registers, BY REFERENCE. A source is therefore
  // registered once and is then both readable and writeable, which is what stops a shipped source
  // (GitLab Issues) or a deployment's own from having intake and no way to answer it.
  const writebackDeps: ConstructorParameters<typeof IssueWritebackService>[0] = {
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    taskRepository: new D1TaskRepository({ db }),
    taskSourceProviders,
    // Idempotency markers for the headless clarification loop's question echo — without them
    // the writeback passes through, since a replaying driver would otherwise re-post.
    reviewQuestionPostRepository: new D1ReviewQuestionPostRepository({ db }),
    clock,
    // Every hook here is fire-and-forget; without a logger a permanently broken tracker
    // connection produces no symptom but comments that never appear.
    logger,
  }
  // GitHub issues: file through the App-authenticated client against the service's
  // linked repo (resolved from the github_repos projection). Only when the App is configured.
  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const registry = buildAppRegistry(env, config, db, clock)
    const githubClient = new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
    const resolveRepoTarget = buildResolveRepoTarget(db)
    trackerDeps.fileGitHubIssue = async (request) => {
      const repo = await resolveRepoTarget(request.workspaceId, request.frameId)
      if (!repo) return null
      const issue = await githubClient.createIssue(
        repo.installationId,
        { owner: repo.owner, repo: repo.name },
        { title: request.title, body: request.body },
      )
      return { externalId: `${repo.owner}/${repo.name}#${issue.number}`, url: issue.url }
    }
  }
  // Jira: read the workspace's stored connection credentials (when the tasks
  // integration's encryption key is configured).
  if (config.tasks.encryptionKey) {
    const taskConnectionStore = createTaskConnectionStore({
      taskConnectionRepository: new D1TaskConnectionRepository({ db }),
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey,
        info: 'cat-factory:tasks',
      }),
    })
    const resolveJiraConnection = async (workspaceId: string) => {
      const connection = await taskConnectionStore.getByWorkspace(workspaceId, 'jira')
      const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
      if (!baseUrl || !accountEmail || !apiToken) return null
      return { baseUrl, accountEmail, apiToken }
    }
    trackerDeps.resolveJiraConnection = resolveJiraConnection
    const resolveLinearConnection = async (workspaceId: string) => {
      const connection = await taskConnectionStore.getByWorkspace(workspaceId, 'linear')
      const { apiKey, token } = connection?.credentials ?? {}
      return apiKey || token ? { apiKey, token } : null
    }
    trackerDeps.resolveLinearConnection = resolveLinearConnection
    // The store the writeback adapters authenticate through, and the one fact the parked-review
    // question comment needs before it tells a reporter to answer on the ticket: whether an
    // inbound webhook secret was ever minted for that connection. Without it the reply path fails
    // closed, so the copy offers the API route alone. Mirrored in the Node facade's
    // `buildNodeIssueWriteback`.
    writebackDeps.taskConnectionStore = taskConnectionStore
  }
  return {
    pipelineScheduleRepository: new D1PipelineScheduleRepository({ db }),
    trackerSettingsRepository: new D1TrackerSettingsRepository({ db }),
    ticketTrackerProvider: new TicketTrackerService(trackerDeps),
    issueWritebackProvider: new IssueWritebackService(writebackDeps),
  }
}
