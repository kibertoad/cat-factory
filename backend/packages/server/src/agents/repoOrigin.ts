import { vcsWebBaseUrl } from '@cat-factory/kernel'
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
 * The clone origin for the provider a deployment's ENGINE actually reaches.
 *
 * The rule mirrors `engineVcsClient` (`githubClient ?? gitlabEngineClient`) deliberately: the
 * client that opens the merge request and the URL the container clones have to name the same
 * host, and a GitHub App wins wherever both are configured. A deployment serving GitHub-App and
 * per-workspace-GitLab workspaces side by side therefore still clones GitHub for every run,
 * which is the same boundary the engine's own per-workspace routing sits behind: this seam takes
 * no workspace, so it could not answer per workspace even if it wanted to.
 *
 * A GitLab base the web derivation cannot invert THROWS at dispatch rather than falling back.
 * The fallback is `github.com`, so a quiet one sends the container to a real page belonging to
 * somebody else and reports whatever it checks out there as the run's repository; the throw
 * names the variable an operator has to fix. Same disposition as the SPA's link builders, one
 * step further because a checkout cannot be withheld.
 */
export function deploymentRepoOrigin(config: RepoOriginConfig): ResolveRepoOrigin {
  if (config.github.enabled || !config.gitlab.enabled) return githubRepoOrigin
  const webBase = vcsWebBaseUrl('gitlab', config.gitlab.apiBase)
  return (repo): RepoOrigin => {
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
 */
export function harnessGitLabHost(gitlab: RepoOriginConfig['gitlab']): string | undefined {
  if (!gitlab.enabled) return undefined
  const webBase = vcsWebBaseUrl('gitlab', gitlab.apiBase)
  return webBase ? new URL(webBase).host : undefined
}
