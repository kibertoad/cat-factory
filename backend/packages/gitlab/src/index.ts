import type { Clock, GitHubClient, VcsProviderRegistry } from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { GitLabProvisioningClient } from './provisioning.js'
import { StaticGitLabTokenSource } from './tokenSource.js'
import { asGitHubClient } from './vcsBackedGitHubClient.js'
import { GitLabWebhookMapper, GitLabWebhookVerifier } from './webhook.js'
import type { GitLabTokenSource } from './tokenSource.js'

// ---------------------------------------------------------------------------
// The GitLab VCS provider, authored entirely through the public VCS-registry seam
// (`VcsProviderRegistry`) — depending only on @cat-factory/kernel + @cat-factory/contracts,
// never on the engine or a runtime facade. A deployment that wants GitLab support calls
// `registerGitLab(registry, ...)` once at startup against the registry the facade owns; any
// caller holding a `gitlab` VcsConnectionRef then resolves this bundle via `registry.resolve(ref)`.
// ---------------------------------------------------------------------------

export { FetchGitLabClient, GitLabApiError } from './FetchGitLabClient.js'
export {
  GitLabIdentityResolver,
  type GitLabIdentityResolverOptions,
} from './GitLabIdentityResolver.js'
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
export { asGitHubClient, type VcsBackedGitHubClientOptions } from './vcsBackedGitHubClient.js'

export interface RegisterGitLabOptions {
  tokenSource: GitLabTokenSource
  clock: Clock
  /** The shared webhook secret compared against the `X-Gitlab-Token` header. */
  webhookSecret?: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Optional sink warned when a listing is truncated at the page cap. */
  logger?: { warn: (message: string) => void }
}

/**
 * Register the GitLab provider bundle (client + webhook verifier/mapper + provisioning) on the
 * app-owned VCS registry the facade threads through its container. Call once at startup.
 * Idempotent — a later call replaces the earlier registration.
 */
export function registerGitLab(
  registry: VcsProviderRegistry,
  options: RegisterGitLabOptions,
): void {
  const { tokenSource, clock, webhookSecret, fetchImpl, logger } = options
  registry.register({
    provider: 'gitlab',
    client: new FetchGitLabClient({ tokenSource, clock, fetchImpl, logger }),
    webhookMapper: new GitLabWebhookMapper(clock),
    webhookVerifier: webhookSecret ? new GitLabWebhookVerifier(webhookSecret) : undefined,
    provisioning: new GitLabProvisioningClient({ tokenSource, fetchImpl }),
  })
}

export interface BuildGitLabEngineClientOptions {
  /** The single deployment PAT (`GITLAB_TOKEN`). */
  token: string
  /** REST v4 base, e.g. `https://gitlab.com/api/v4` or a self-managed instance. */
  apiBase: string
  clock: Clock
  fetchImpl?: typeof fetch
}

/**
 * Build a GitLab-backed {@link GitHubClient} for the engine's gate / merge / RepoFiles paths:
 * a {@link FetchGitLabClient} bridged onto the legacy `GitHubClient` port via {@link
 * asGitHubClient}. This is the SINGLE source of the "engine VCS client over GitLab" wiring,
 * shared by every facade (Worker / Node, and local through Node) so a GitLab-only deployment
 * gates on real CI and merges for real exactly as a GitHub-App one does — and the facades
 * cannot drift in HOW they build it. The GitHub App client wins when both are configured.
 */
export function buildGitLabEngineClient(options: BuildGitLabEngineClientOptions): GitHubClient {
  return asGitHubClient({
    vcs: new FetchGitLabClient({
      tokenSource: new StaticGitLabTokenSource(options.token, options.apiBase),
      clock: options.clock,
      fetchImpl: options.fetchImpl,
    }),
    provider: 'gitlab',
  })
}
