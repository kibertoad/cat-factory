// Source-control provider helpers: the pre-scoped "create a personal access token" URLs the
// CLI opens in the browser, and the env-var name each provider's token is written under.
//
// These mirror `@cat-factory/local-server`'s `githubPatCreationUrl` / `gitlabPatCreationUrl`
// (backend/runtimes/local/src/github.ts) so the token the developer mints here carries exactly
// the scopes the local-mode agent containers need. They are duplicated rather than imported to
// keep the backend stack out of a scaffolder (the CLI's only runtime dep is @clack/prompts).

export type VcsProvider = 'github' | 'gitlab'

export const VCS_PROVIDERS: readonly VcsProvider[] = ['github', 'gitlab']

/**
 * The classic-token scopes local mode needs: agent containers clone/push branches and open PRs
 * (`repo`, which also covers reading the PR head's Actions check runs for the CI gate and
 * merging the PR), and the coder/ci-fixer may touch `.github/workflows/*` files (`workflow`).
 */
const GITHUB_PAT_SCOPES = ['repo', 'workflow'] as const

/** The GitLab scope a coding agent needs: `api` covers repo read/write + merge. */
const GITLAB_PAT_SCOPES = ['api'] as const

/**
 * A GitHub "new personal access token (classic)" URL with the local-mode scopes pre-selected.
 * Classic tokens (not fine-grained) are used because only the classic form accepts the `scopes`
 * query param for pre-selection.
 */
export function githubPatCreationUrl(): string {
  const params = new URLSearchParams({
    description: 'cat-factory local mode',
    scopes: GITHUB_PAT_SCOPES.join(','),
  })
  return `https://github.com/settings/tokens/new?${params.toString()}`
}

/**
 * A GitLab "new personal access token" URL with the `api` scope pre-selected, so a developer
 * without a GitLab PAT can click straight through to create one.
 */
export function gitlabPatCreationUrl(): string {
  const params = new URLSearchParams({
    name: 'cat-factory local mode',
    'scopes[]': GITLAB_PAT_SCOPES.join(','),
  })
  return `https://gitlab.com/-/user_settings/personal_access_tokens?${params.toString()}`
}

/** The pre-scoped token-creation URL for a provider. */
export function patCreationUrl(provider: VcsProvider): string {
  return provider === 'github' ? githubPatCreationUrl() : gitlabPatCreationUrl()
}

/** The `.env` variable name a provider's PAT is written under (read by the local-mode facade). */
export function patEnvVar(provider: VcsProvider): 'GITHUB_PAT' | 'GITLAB_PAT' {
  return provider === 'github' ? 'GITHUB_PAT' : 'GITLAB_PAT'
}

/** Human label for prompts/output. */
export function providerLabel(provider: VcsProvider): string {
  return provider === 'github' ? 'GitHub' : 'GitLab'
}
