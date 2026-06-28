import { registerVcsProvider, type Clock } from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { GitLabProvisioningClient } from './provisioning.js'
import { GitLabWebhookMapper, GitLabWebhookVerifier } from './webhook.js'
import type { GitLabTokenSource } from './tokenSource.js'

// ---------------------------------------------------------------------------
// The GitLab VCS provider, authored entirely through the public VCS-registry seam
// (`registerVcsProvider`) — depending only on @cat-factory/kernel + @cat-factory/contracts,
// never on the engine or a runtime facade. A deployment that wants GitLab support calls
// `registerGitLab(...)` once at startup; any caller holding a `gitlab` VcsConnectionRef then
// resolves this bundle via `resolveVcsProvider(ref)`.
// ---------------------------------------------------------------------------

export { FetchGitLabClient, GitLabApiError } from './FetchGitLabClient.js'
export type { FetchGitLabClientDependencies } from './FetchGitLabClient.js'
export { GitLabProvisioningClient } from './provisioning.js'
export type { GitLabProvisioningDependencies } from './provisioning.js'
export { GitLabWebhookMapper, GitLabWebhookVerifier } from './webhook.js'
export {
  type GitLabTokenSource,
  StaticGitLabTokenSource,
  GITLAB_PUBLIC_API_BASE,
} from './tokenSource.js'
export * as gitlabProjection from './projection.js'

export interface RegisterGitLabOptions {
  tokenSource: GitLabTokenSource
  clock: Clock
  /** The shared webhook secret compared against the `X-Gitlab-Token` header. */
  webhookSecret?: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Register the GitLab provider bundle (client + webhook verifier/mapper + provisioning)
 * in the process-wide VCS registry. Call once at startup. Idempotent — a later call
 * replaces the earlier registration.
 */
export function registerGitLab(options: RegisterGitLabOptions): void {
  const { tokenSource, clock, webhookSecret, fetchImpl } = options
  registerVcsProvider({
    provider: 'gitlab',
    client: new FetchGitLabClient({ tokenSource, clock, fetchImpl }),
    webhookMapper: new GitLabWebhookMapper(),
    webhookVerifier: webhookSecret ? new GitLabWebhookVerifier(webhookSecret) : undefined,
    provisioning: new GitLabProvisioningClient({ tokenSource, fetchImpl }),
  })
}
