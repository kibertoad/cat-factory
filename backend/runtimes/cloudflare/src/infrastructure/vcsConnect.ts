import type { GitHubClient, Clock, GitHubInstallationRepository } from '@cat-factory/kernel'
import type { AppConfig } from '@cat-factory/server'
import { logger } from '@cat-factory/server'
import { buildGitLabConnectClient, GitLabIdentityResolver } from '@cat-factory/gitlab'
import { VcsPatConnectionService } from '@cat-factory/integrations'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'

/**
 * Wire the per-workspace GitLab PAT connect deps for the Worker: the GitLab-backed `GitHubClient`
 * (its token source decrypts each workspace's sealed PAT) the `github` module reads through for a
 * `gitlab` connection, plus the `VcsPatConnectionService` the connect controller drives. Enabled
 * only when GitLab is configured AND a sealing key is present. Mirrors the Node facade's
 * `selectVcsConnectDeps` (per "keep the runtimes symmetric"). Lifted out of `container.ts` to keep
 * that composition root within its file-size budget.
 */
export function selectWorkerVcsConnectDeps(
  config: AppConfig,
  installations: GitHubInstallationRepository,
  db: D1Database,
  clock: Clock,
): { client: GitHubClient; service: VcsPatConnectionService } | undefined {
  const gitlab = config.gitlab
  if (!gitlab?.enabled || !gitlab.encryptionKey) return undefined
  // One cipher seals (connect) and unseals (token source) under the same domain.
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
    workspaceRepository: new D1WorkspaceRepository({ db }),
    identityResolver: new GitLabIdentityResolver({ apiBase: gitlab.apiBase }),
    cipher,
    clock,
  })
  return { client, service }
}
