import { type VcsProvider, vcsWebBaseUrl } from '@cat-factory/kernel'
import type { GitLabConfig } from '../config/types.js'
import type { RepoOrigin, ResolveRepoOrigin } from './repoTargeting.js'
import { githubRepoOrigin } from './containerAgentBody.js'

// ---------------------------------------------------------------------------
// Which host a deployment's agent containers clone from, and which host the harness may send a
// clone credential to.
//
// The repo projection stores `owner`/`name` and no host, so the clone URL is a deployment-level
// fact supplied through the `ResolveRepoOrigin` seam. Local mode has always supplied one; the
// Node and Cloudflare facades supplied NONE, so every dispatch fell through to
// `githubRepoOrigin` and a GitLab-only hosted deployment handed its containers a
// `https://github.com/<group>/<project>.git` clone URL plus `provider: 'github'`. Its gates and
// merges ran on GitLab (those read through `engineVcsClient`), so the gap surfaced as a run that
// could not check out on a deployment whose source control was otherwise working.
//
// Both halves are derived from `GITLAB_API_BASE` through the SAME `vcsWebBaseUrl` inversion the
// SPA's links use, so the host a facade dispatches to and the host it allow-lists cannot drift
// from each other or from what a user is shown.
// ---------------------------------------------------------------------------

/** The slice of {@link import('../config/types.js').AppConfig} the clone origin is derived from. */
export interface RepoOriginConfig {
  github: { readonly enabled: boolean }
  gitlab: Pick<GitLabConfig, 'enabled' | 'apiBase'>
}

/**
 * Which provider a deployment's ENGINE reaches, and therefore the one every run-path seam that
 * takes no workspace has to answer for.
 *
 * The rule mirrors `engineVcsClient` (`githubClient ?? gitlabEngineClient`) deliberately: the
 * client that opens the merge request, the URL the container clones and the client the
 * checkout-free `RepoFiles` seams read through all have to name the same host, and a GitHub App
 * wins wherever both are configured. A deployment serving GitHub-App and per-workspace-GitLab
 * workspaces side by side therefore runs its engine on GitHub for every workspace, which is the
 * boundary the deferred per-workspace routing slice sits behind: none of these seams takes a
 * workspace, so none could answer per workspace even if it wanted to.
 *
 * Stated ONCE here because three call sites share it, and a facade that derived it locally could
 * bind a client for one provider beside a clone URL for the other.
 */
export function engineVcsProvider(config: RepoOriginConfig): VcsProvider {
  return config.github.enabled || !config.gitlab.enabled ? 'github' : 'gitlab'
}

/**
 * The clone origin for the provider a deployment's ENGINE actually reaches
 * ({@link engineVcsProvider}).
 *
 * Two configurations THROW at dispatch rather than falling back, for one reason: the fallback is
 * `github.com`, so a quiet one sends the container to a real page belonging to somebody else and
 * reports whatever it checks out there as the run's repository. A checkout cannot be withheld the
 * way the SPA withholds a link, so the disposition goes one step further and names what an
 * operator has to fix.
 *
 * - **A GitLab base the web derivation cannot invert.** The message names the variable.
 * - **A repo the engine's provider cannot reach.** `RepoTarget.provider` records where the repo
 *   actually lives, so on a mixed deployment a row explicitly marked `gitlab` would otherwise be
 *   handed a `github.com` URL for a same-named project that is not it. The dispatch credential is
 *   wrong there too (the mint is the App registry's, with no per-provider routing), so there is no
 *   correct URL to build for such a row on this path: it is the per-workspace routing slice, and
 *   until that lands the honest answer is a refusal naming the repository. A row with NO provider
 *   predates the column and reads as the deployment's own, so it never trips this.
 */
export function deploymentRepoOrigin(config: RepoOriginConfig): ResolveRepoOrigin {
  const provider = engineVcsProvider(config)
  const webBase = provider === 'gitlab' ? vcsWebBaseUrl('gitlab', config.gitlab.apiBase) : undefined
  return (repo): RepoOrigin => {
    if (repo.provider && repo.provider !== provider) {
      throw new Error(
        `'${repo.owner}/${repo.name}' is a ${repo.provider} repository, but this deployment's ` +
          `engine reaches ${provider}, so there is no clone URL or credential for it. Runs ` +
          `against ${repo.provider} repositories need a deployment whose engine is configured ` +
          `for ${repo.provider}.`,
      )
    }
    if (provider === 'github') return githubRepoOrigin(repo)
    if (!webBase) {
      throw new Error(
        `GITLAB_API_BASE ('${config.gitlab.apiBase}') names no web host, so the clone URL for ` +
          `'${repo.owner}/${repo.name}' cannot be built. Set it to the instance's REST base, ` +
          `e.g. https://gitlab.example.com/api/v4.`,
      )
    }
    return { cloneUrl: `${webBase}/${repo.owner}/${repo.name}.git`, provider: 'gitlab' }
  }
}

/**
 * The extra host the executor harness must be willing to send a clone/push credential to, or
 * undefined when this deployment reaches no GitLab instance.
 *
 * Keyed on the GitLab connection ALONE rather than on which provider wins the engine, because
 * the allow-list is additive defence-in-depth over a body-supplied URL, not a routing decision:
 * naming the instance a deployment is already configured for widens nothing it does not already
 * reach, while omitting it on a mixed deployment would refuse the one host its GitLab workspaces
 * legitimately clone. The harness keeps `github.com` regardless (`allowedGithubHosts`).
 *
 * A facade that wires {@link deploymentRepoOrigin} without this produces a run that fails at
 * checkout with a security refusal instead of a configuration message, which is why they are
 * stated together here rather than a host being spelled out at each wiring site.
 *
 * The value is a HOSTNAME, port excluded, because that is what the harness compares it against
 * (`assertAllowedHost` matches `new URL(cloneUrl).hostname`). An instance served on a non-default
 * port is the case that makes the difference visible: allow-listing `gitlab.internal:8080` never
 * matches the `gitlab.internal` the harness looks up, so every clone is refused with no port
 * anywhere in the message. On the Worker the value is derived rather than operator-set, so there
 * would be nothing to correct it with.
 *
 * A facade that reaches the SAME instance on a second port therefore allow-lists it once, which is
 * correct: the allow-list bounds where a credential may be SENT, and a port is not a trust
 * boundary (anything that can answer on one port of a host can answer on another).
 */
export function harnessGitLabHost(gitlab: RepoOriginConfig['gitlab']): string | undefined {
  if (!gitlab.enabled) return undefined
  const webBase = vcsWebBaseUrl('gitlab', gitlab.apiBase)
  return webBase ? new URL(webBase).hostname : undefined
}
