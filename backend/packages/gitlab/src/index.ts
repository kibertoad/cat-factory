import type {
  Clock,
  GitHubClient,
  GitHubInstallationRepository,
  Logger,
  SecretCipher,
  VcsProviderRegistry,
} from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { GitLabProvisioningClient } from './provisioning.js'
import { StaticGitLabTokenSource, StoredGitLabTokenSource } from './tokenSource.js'
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
  StoredGitLabTokenSource,
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
  /** {@link BuildGitLabEngineClientOptions.logger} — required for the same reason. */
  logger: Logger
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
  /**
   * The single deployment PAT (`GITLAB_TOKEN`), or a getter for it. A getter is what a facade
   * whose credential can change while the server runs passes (local mode's browser-installed
   * token); it answering undefined makes every call refuse with that named cause.
   */
  token: string | (() => string | undefined)
  /** REST v4 base, e.g. `https://gitlab.com/api/v4` or a self-managed instance. */
  apiBase: string
  clock: Clock
  fetchImpl?: typeof fetch
  /**
   * REQUIRED, unlike the client's own optional dep: every facade builds its GitLab engine client
   * here, so this is the one place that can force each of them to wire a real sink. It was optional
   * once, and the result was that no composition root passed one — leaving the engine's own reads
   * (the changed-file list a review slices, the merge track record's classifier) able to truncate
   * at the page cap with nothing emitted anywhere, which is the silent cap the "no silent caps"
   * rule exists to prevent. A facade that forgets must now fail to typecheck.
   */
  logger: Logger
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
      logger: options.logger,
    }),
    provider: 'gitlab',
  })
}

export interface BuildGitLabConnectClientOptions {
  /** Reads the per-workspace `github_installations` row carrying the sealed PAT. */
  installations: GitHubInstallationRepository
  /** Decrypts the sealed PAT at call time. */
  cipher: SecretCipher
  /** REST v4 base for the deployment's GitLab instance. */
  apiBase: string
  clock: Clock
  fetchImpl?: typeof fetch
  /** {@link BuildGitLabEngineClientOptions.logger} — required for the same reason. */
  logger: Logger
}

/**
 * Build a GitLab-backed {@link GitHubClient} for the hosted per-workspace PAT connect flow: a
 * {@link FetchGitLabClient} whose token source ({@link StoredGitLabTokenSource}) resolves and
 * decrypts each connection's sealed PAT, bridged onto the `GitHubClient` port via
 * {@link asGitHubClient}. This is the client the `github` module's sync / installation services
 * read through for a workspace connected via GitLab — routed to per workspace by the
 * provider-routing client when a GitHub App is also configured. Shared by every hosted facade
 * so they cannot drift in HOW they build it.
 */
export function buildGitLabConnectClient(options: BuildGitLabConnectClientOptions): GitHubClient {
  return asGitHubClient({
    vcs: new FetchGitLabClient({
      tokenSource: new StoredGitLabTokenSource({
        installations: options.installations,
        cipher: options.cipher,
        apiBase: options.apiBase,
      }),
      clock: options.clock,
      fetchImpl: options.fetchImpl,
      logger: options.logger,
    }),
    provider: 'gitlab',
  })
}
