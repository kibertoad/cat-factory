import type {
  GitHubPatCapabilities,
  GitHubPatCapabilityStatus,
  GitHubPatCheck,
  GitHubPatSource,
} from '@cat-factory/contracts'
import type { Logger } from '@cat-factory/kernel'
import { describeError, getErrorMessage } from '@cat-factory/kernel'
import { describeGitHubPatScope } from './githubPatScope.js'

// Whether the personal access token a workspace's runs authenticate with can actually push,
// open a pull request and edit a workflow file — asked when a board loads, so the answer
// arrives before a pipeline spends money reaching a 403 in a container.
//
// The classification itself is `githubPatScope.ts` (pure, header-only). This module is the part
// that needs the network: a CLASSIC token's scopes come back on `GET /user`, and a FINE-GRAINED
// token reports nothing anywhere, so the only way to learn what it reaches is to ask about a
// repository the board actually links.
//
// Two properties are load-bearing and easy to lose:
//
//  - A probe that cannot get an ANSWER is never a verdict about the token. GitHub being
//    unreachable produces `probe_failed`, which raises nothing, because the remedy a
//    permissions banner advertises (go mint a new token) is both wrong and expensive when the
//    real cause is a five-minute upstream blip.
//  - The fine-grained answer is a SAMPLE, and it says so. It reads the linked repositories up
//    to a cap and reports which ones it read plus how many it did not, so a clean verdict is
//    never mistaken for a guarantee about a repository nobody looked at.

/** The public API. A deployment on GitHub Enterprise Server passes its own base. */
const PUBLIC_GITHUB_API_BASE = 'https://api.github.com'

/**
 * How many linked repositories the fine-grained probe reads. Small on purpose: this runs on
 * board load, and the question it answers ("can this token push to the repositories we work
 * on") is settled by a handful of samples — the failure it catches is a token scoped to the
 * wrong account or to no repositories at all, not a per-repository access matrix. Whatever the
 * cap drops is COUNTED on the report rather than silently omitted.
 */
const DEFAULT_MAX_PROBED_REPOS = 5

/** How long a single GitHub call may take before the whole check degrades to `probe_failed`. */
const PROBE_TIMEOUT_MS = 8000

/** A repository the workspace's runs would push to. */
export interface GitHubPatProbeRepo {
  owner: string
  name: string
}

export interface GitHubPatCapabilityRequest {
  /** The token to judge. Read for its PREFIX and sent as a bearer; never logged or echoed. */
  token: string
  /** Which credential this is, so the report can name the remedy that fits it. */
  source: GitHubPatSource
  /**
   * The repositories this board links, most relevant first. Empty is a legitimate state (a
   * workspace that has linked nothing yet) and yields an all-`unknown` report rather than a
   * clean one: there is nothing to check the token against.
   */
  linkedRepos: readonly GitHubPatProbeRepo[]
  /** The instance's browser-facing base, carried through for the re-mint link. */
  webUrl: string | null
}

export interface GitHubPatCapabilityDeps {
  apiBase?: string
  fetch?: typeof fetch
  logger?: Logger
  maxProbedRepos?: number
}

/** What one repository probe established about the token. */
type RepoProbeOutcome = 'granted' | 'missing' | 'unreachable'

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'cat-factory',
  }
}

/**
 * The capability verdict a CLASSIC token's scopes support.
 *
 * `public_repo` without `repo` is deliberately `unknown` rather than `missing`: it grants push
 * to public repositories only, so whether it is enough depends on the visibility of the
 * repositories this board links — which the scope header does not know and this function is not
 * given. Calling it `missing` would nag a deployment working entirely in the open; calling it
 * `granted` would stay silent on the private repository it genuinely cannot touch.
 */
function classicCapabilities(scopes: readonly string[]): GitHubPatCapabilities {
  const has = (scope: string): boolean => scopes.includes(scope)
  const repoWrite: GitHubPatCapabilityStatus = has('repo')
    ? 'granted'
    : has('public_repo')
      ? 'unknown'
      : 'missing'
  return {
    push: repoWrite,
    // One scope answers both on a classic token: `repo` carries pushing a branch and opening
    // and merging the pull request alike. They are still reported separately because a
    // FINE-GRAINED token splits them (`contents` vs `pull_requests`), and a consumer keyed on
    // one combined field would have nowhere to put that difference.
    pullRequests: repoWrite,
    // Not implied by `repo`: GitHub rejects a push that touches `.github/workflows/*` without
    // it, which is why the pre-selected scope list carries both.
    workflows: has('workflow') ? 'granted' : 'missing',
  }
}

/**
 * Fold the per-repository outcomes into one push verdict.
 *
 * A single definitive refusal wins: a board that links a repository this token cannot push to
 * has a broken pipeline for that repository, whatever the others say. Absent one, only an
 * ALL-clear counts as `granted` — a mix of successes and unreachable repositories is `unknown`,
 * because a 404 from GitHub means "this token cannot see it" and "it no longer exists" alike,
 * and a stale projection row must not be reported to a user as a broken credential.
 */
function foldRepoProbes(outcomes: readonly RepoProbeOutcome[]): GitHubPatCapabilityStatus {
  if (outcomes.length === 0) return 'unknown'
  if (outcomes.includes('missing')) return 'missing'
  return outcomes.every((o) => o === 'granted') ? 'granted' : 'unknown'
}

/**
 * Ask GitHub whether the token may push to one repository. `permissions.push` on the repository
 * payload is the user-role answer, which is exactly the authoritative one for a PAT (the same
 * field `FetchGitHubClient.canPush` prefers).
 */
async function probeRepo(
  repo: GitHubPatProbeRepo,
  token: string,
  apiBase: string,
  fetchImpl: typeof fetch,
  logger: Logger | undefined,
): Promise<RepoProbeOutcome> {
  try {
    const res = await fetchImpl(
      `${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
      { headers: headers(token), signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    )
    if (!res.ok) return 'unreachable'
    const body = (await res.json()) as { permissions?: { push?: boolean } }
    const push = body.permissions?.push
    // An absent permissions block is not a denial — it is an older/enterprise payload shape we
    // cannot read. Treated as unreachable so it lands on `unknown` rather than inventing a
    // refusal GitHub never made.
    return push === true ? 'granted' : push === false ? 'missing' : 'unreachable'
  } catch (error) {
    logger?.warn('GitHub repository permission probe failed; treating it as unreadable', {
      repo: `${repo.owner}/${repo.name}`,
      ...describeError(error),
    })
    return 'unreachable'
  }
}

/**
 * Judge `request.token`. Never throws: every failure is one of the {@link GitHubPatCheck}
 * states, because this runs on a board load and an exception here would turn a warning surface
 * into a broken page.
 */
export async function probeGitHubPatCapability(
  request: GitHubPatCapabilityRequest,
  deps: GitHubPatCapabilityDeps = {},
): Promise<GitHubPatCheck> {
  const apiBase = deps.apiBase ?? PUBLIC_GITHUB_API_BASE
  const fetchImpl = deps.fetch ?? fetch
  const maxRepos = deps.maxProbedRepos ?? DEFAULT_MAX_PROBED_REPOS

  let res: Response
  try {
    res = await fetchImpl(`${apiBase}/user`, {
      headers: headers(request.token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    return { state: 'probe_failed', message: getErrorMessage(error) }
  }
  // 401/403 is the token itself: revoked, expired, or blocked by an org policy. Anything else
  // non-2xx is GitHub having a bad day, which says nothing about the credential.
  if (res.status === 401 || res.status === 403) {
    return { state: 'token_rejected', status: res.status }
  }
  if (!res.ok) {
    return { state: 'probe_failed', message: `GitHub answered HTTP ${res.status}` }
  }

  const scope = describeGitHubPatScope(request.token, res.headers.get('x-oauth-scopes'))
  if (scope.kind === 'classic') {
    return {
      state: 'checked',
      report: {
        source: request.source,
        kind: scope.kind,
        scopes: scope.scopes,
        capabilities: classicCapabilities(scope.scopes),
        // A classic token's scopes answer for every repository at once, so nothing was sampled
        // and there is no unread remainder to declare.
        probedRepos: [],
        unprobedRepoCount: 0,
        webUrl: request.webUrl,
      },
    }
  }

  // Fine-grained (and the `unknown` kind, which is equally unreadable from headers): the only
  // available evidence is what the token can do to a repository we know the board uses.
  const toProbe = request.linkedRepos.slice(0, maxRepos)
  const outcomes = await Promise.all(
    toProbe.map((repo) => probeRepo(repo, request.token, apiBase, fetchImpl, deps.logger)),
  )
  return {
    state: 'checked',
    report: {
      source: request.source,
      kind: scope.kind,
      scopes: [],
      capabilities: {
        push: foldRepoProbes(outcomes),
        // No GitHub endpoint reports a fine-grained token's `pull_requests` or `workflows`
        // permission, and neither is inferable from `contents` (a token can hold one without
        // the other). Stated as unknown rather than assumed either way.
        pullRequests: 'unknown',
        workflows: 'unknown',
      },
      probedRepos: toProbe.map((r) => `${r.owner}/${r.name}`),
      unprobedRepoCount: Math.max(0, request.linkedRepos.length - toProbe.length),
      webUrl: request.webUrl,
    },
  }
}
