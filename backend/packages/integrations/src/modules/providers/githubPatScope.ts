import type { ConnectionWarning } from '@cat-factory/contracts'

// What a stored GitHub personal access token can actually REACH, derived from the one probe the
// connect form already runs (`GET /user`).
//
// This exists because of a specific, stated gap in `backend/docs/security-model.md`: a member's
// PAT OUTRANKS the deployment credential on the run path, and the platform cannot narrow it —
// `repository_ids` scoping is an App-token mechanism with no PAT equivalent. So the only control
// left is the member knowing what they just handed over, and a classic `repo` token reaching
// every repository they can push to is precisely the case that was previously silent.
//
// Pure so the classification is unit-tested without a network round trip. The caller supplies the
// raw `x-oauth-scopes` response header (GitHub sends it for CLASSIC tokens only) and the token
// itself — read for its PREFIX alone, never logged or echoed.

/**
 * GitHub's own prefix for a fine-grained personal access token. A fine-grained token is
 * repository-scoped by construction (its owner picked the repositories at mint time), so an
 * absent scope header on one is expected rather than unreadable.
 */
const FINE_GRAINED_PREFIX = 'github_pat_'

/**
 * The classic scope that makes a token ACCOUNT-WIDE for our purposes: full read/write on every
 * repository its owner can reach, public and private. `public_repo` is deliberately not in this
 * set — it is still broad, but it cannot touch a private repository, which is the case the
 * security model is about.
 */
const ACCOUNT_WIDE_SCOPES = new Set(['repo'])

/**
 * Classic scopes the platform never needs, but which a token minted from GitHub's "select all"
 * habit routinely carries. Named individually rather than "anything we don't use" so a scope
 * GitHub adds later doesn't start generating a warning nobody wrote copy for.
 */
const BEYOND_NEED_SCOPES = new Set([
  'admin:org',
  'admin:public_key',
  'admin:repo_hook',
  'admin:org_hook',
  'admin:gpg_key',
  'delete_repo',
  'user',
  'write:packages',
  'delete:packages',
])

export interface GitHubPatScopeReport {
  /** How the token's reach was determined. */
  kind: 'classic' | 'fine_grained' | 'unknown'
  /** The classic scopes GitHub reported, in header order. Empty for the other kinds. */
  scopes: string[]
  /** Non-fatal findings about the token's breadth, for the connect form to render. */
  warnings: ConnectionWarning[]
}

/**
 * Classify a validated token's reach. `scopeHeader` is the raw `x-oauth-scopes` value (null when
 * GitHub sent none). Never throws — an unrecognisable header degrades to `unknown`, which is
 * REPORTED as its own warning rather than quietly passing as narrow.
 */
export function describeGitHubPatScope(
  token: string,
  scopeHeader: string | null,
): GitHubPatScopeReport {
  const scopes = (scopeHeader ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (scopes.length > 0) {
    const warnings: ConnectionWarning[] = []
    if (scopes.some((s) => ACCOUNT_WIDE_SCOPES.has(s))) {
      warnings.push({
        code: 'github_pat_classic_account_wide',
        message:
          `This classic token grants '${scopes.join(', ')}'. The 'repo' scope reaches every ` +
          `repository you can push to — including ones this workspace's GitHub App was never ` +
          `installed on — and runs you start will use it in preference to the App. Consider a ` +
          `fine-grained token limited to the repositories this deployment works on.`,
      })
    }
    const excess = scopes.filter((s) => BEYOND_NEED_SCOPES.has(s))
    if (excess.length > 0) {
      warnings.push({
        code: 'github_pat_scopes_beyond_need',
        message:
          `This token also grants '${excess.join(', ')}', which cat-factory never uses. ` +
          `Removing them costs nothing and narrows what a compromised run could reach.`,
      })
    }
    return { kind: 'classic', scopes, warnings }
  }

  // No scope header. A fine-grained token is the expected reason (GitHub sends none for those),
  // and it is repository-scoped by construction, so there is nothing to warn about.
  if (token.startsWith(FINE_GRAINED_PREFIX)) {
    return { kind: 'fine_grained', scopes: [], warnings: [] }
  }

  return {
    kind: 'unknown',
    scopes: [],
    warnings: [
      {
        code: 'github_pat_scope_unreadable',
        message:
          `GitHub accepted this token but reported no scopes for it, so its reach cannot be ` +
          `shown here. Check what it grants at https://github.com/settings/tokens — runs you ` +
          `start will authenticate with it in preference to the GitHub App.`,
      },
    ],
  }
}

/** A one-line, human-facing summary of the token's reach, for the test result's message. */
export function summarizeGitHubPatScope(report: GitHubPatScopeReport): string {
  switch (report.kind) {
    case 'classic':
      return `classic token, scopes: ${report.scopes.join(', ')}`
    case 'fine_grained':
      return 'fine-grained token (limited to the repositories you selected)'
    case 'unknown':
      return 'scopes not reported by GitHub'
  }
}
