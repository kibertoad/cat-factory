// ---------------------------------------------------------------------------
// Human remedies for VCS (GitHub / GitLab) HTTP failures.
//
// Every `fetch`-based VCS client used to throw the same bare status dump for any non-2xx
// response — `GitHub GET <url> → 401: <body>` — which named the symptom but not the cause or
// the fix, so a rejected token, an exhausted rate limit, and a missing scope all read the
// same. This module is the SINGLE place that turns a `{ provider, status }` into an actionable
// message: it preserves that raw first line (callers and detectors still surface it as detail,
// and it stays greppable) and appends a cause + remedy sentence that names the UI location
// first, the env/PAT alternative second, and links the relevant docs.
//
// Error IDENTITY still rides the structured `status` field on `GitHubApiError` / `GitLabApiError`
// (that is what consumers branch on) — this only enriches the human `message`, so elaborating it
// never changes classification. Both clients live in different packages (`@cat-factory/server` and
// `@cat-factory/gitlab`) but share `@cat-factory/kernel`, so keeping the copy here keeps the two
// providers' remedies from drifting and lets the mapping be unit-tested in one place.
// ---------------------------------------------------------------------------

import type { VcsProvider } from './vcs-types.js'

// In-repo docs are linked as stable GitHub blob URLs on `main`. Kernel sits BELOW the server
// layer, so it cannot import `@cat-factory/server`'s `config/docs.ts`; per the doc-URL convention
// a package outside the server layer keeps its own equivalent — this is that equivalent.
const REPO_DOC_BLOB_BASE = 'https://github.com/kibertoad/cat-factory/blob/main'

/** In-repo docs the VCS remedies deep-link to. */
export const VCS_DOC_URLS = {
  /** GitHub connect / repo linking. */
  githubIntegration: `${REPO_DOC_BLOB_BASE}/backend/docs/github-integration.md`,
  /** GitHub App auth + operations. */
  githubOperations: `${REPO_DOC_BLOB_BASE}/backend/docs/github-operations.md`,
  /** Provider-neutral VCS layer (GitHub + GitLab). */
  vcsProviders: `${REPO_DOC_BLOB_BASE}/backend/docs/vcs-providers.md`,
} as const

/** GitHub settings pages a remedy points at (the host is fixed for github.com). */
export const GITHUB_SETTINGS_URLS = {
  installations: 'https://github.com/settings/installations',
} as const

/** The inputs a VCS client has on hand when a request fails, used to pick the remedy. */
export interface VcsHttpErrorContext {
  provider: VcsProvider
  /** The HTTP status of the failed response. */
  status: number
  /** The request method, for the raw detail line. */
  method: string
  /** The request URL, for the raw detail line. */
  url: string
  /** The response body (already truncated by the caller), for the raw detail line. */
  body?: string
  /** True when rate-limit headers say the quota is exhausted (GitHub) or the status is 429. */
  rateLimited?: boolean
  /** Epoch-ms the rate limit resets, when the response exposed it. */
  resetAt?: number | null
}

/** Human label for a provider, matching the raw message prefix the clients used to emit. */
function providerLabel(provider: VcsProvider): string {
  return provider === 'github' ? 'GitHub' : 'GitLab'
}

function githubRemedy(ctx: VcsHttpErrorContext): string | undefined {
  const { status, rateLimited, resetAt } = ctx
  const docs = VCS_DOC_URLS
  if (status === 401) {
    return `Cause: the GitHub token was rejected — it was revoked or has expired, or the App's private key was rotated. Fix: reconnect the GitHub App for this workspace (Settings → GitHub); in local mode, mint a fresh GITHUB_PAT. Manage installations at ${GITHUB_SETTINGS_URLS.installations}. See ${docs.githubOperations}.`
  }
  if ((status === 403 && rateLimited) || status === 429) {
    const resetNote =
      typeof resetAt === 'number' ? ` The limit resets at ${new Date(resetAt).toISOString()}.` : ''
    return `Cause: the GitHub API rate limit was exceeded.${resetNote} Fix: wait for the reset before retrying — a GitHub App installation has a much higher limit than a personal access token. See ${docs.githubOperations}.`
  }
  if (status === 403) {
    return `Cause: the GitHub token lacks a required permission or scope for this call. Fix: grant the missing permission (e.g. contents, pull requests, or checks) on the App and re-accept the installation at ${GITHUB_SETTINGS_URLS.installations}, or re-mint the PAT with the needed scopes. See ${docs.githubOperations}.`
  }
  if (status === 404) {
    return `Cause: the repository or installation is not visible to this token — the App may not be installed on it, or it was renamed or deleted. Fix: confirm the App is installed on the target repo and this workspace points at the right installation, then reconnect GitHub if it is stale. See ${docs.githubIntegration}.`
  }
  if (status >= 500) {
    return `Cause: GitHub returned a server error — this is usually transient. Fix: retry shortly. See ${docs.githubOperations}.`
  }
  return undefined
}

function gitlabRemedy(ctx: VcsHttpErrorContext): string | undefined {
  const { status } = ctx
  const docs = VCS_DOC_URLS
  if (status === 401) {
    return `Cause: the GitLab access token was rejected — it was revoked or has expired. Fix: update the token on the GitLab connection (Settings → Integrations); create a new one under your GitLab host → Preferences → Access Tokens with the \`api\` scope. See ${docs.vcsProviders}.`
  }
  if (status === 429) {
    return `Cause: the GitLab API rate limit was exceeded. Fix: wait before retrying. See ${docs.vcsProviders}.`
  }
  if (status === 403) {
    return `Cause: the GitLab token lacks the required scope or role for this call. Fix: it needs the \`api\` scope and at least the Developer or Maintainer role on the project. See ${docs.vcsProviders}.`
  }
  if (status === 404) {
    return `Cause: the GitLab project is not visible to this token — confirm the project path/id and that the token's user is a member of it. See ${docs.vcsProviders}.`
  }
  if (status >= 500) {
    return `Cause: GitLab returned a server error — this is usually transient. Fix: retry shortly. See ${docs.vcsProviders}.`
  }
  return undefined
}

/**
 * Build the message for a failed VCS HTTP request: the raw `<Provider> <method> <url> → <status>:
 * <body>` line (unchanged, so downstream detail surfaces and greps still work) followed, when the
 * status maps to a known cause, by a cause + remedy sentence with a doc link.
 */
export function describeVcsApiError(ctx: VcsHttpErrorContext): string {
  const rawLine = `${providerLabel(ctx.provider)} ${ctx.method} ${ctx.url} → ${ctx.status}${
    ctx.body ? `: ${ctx.body}` : ''
  }`
  const remedy = ctx.provider === 'github' ? githubRemedy(ctx) : gitlabRemedy(ctx)
  return remedy ? `${rawLine}\n${remedy}` : rawLine
}
