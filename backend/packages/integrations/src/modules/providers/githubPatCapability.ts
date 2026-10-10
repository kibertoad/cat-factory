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
//    unreachable, or refusing to answer for now because the token is rate limited, produces
//    `probe_failed`, which raises nothing, because the remedy a permissions banner advertises
//    (go mint a new token) is both wrong and expensive when the real cause is temporary.
//  - The fine-grained answer is a SAMPLE, and it says so. It reads the targeted repositories up
//    to a cap and reports which ones it read plus how many it did not, so a clean verdict is
//    never mistaken for a guarantee about a repository nobody looked at.
//  - A repository read establishes a NEGATIVE far more strongly than a positive, and the two
//    are not folded together. GitHub's repository payload reports the authenticated IDENTITY's
//    role, and a token's grants are a subset of its owner's, so `push: false` refutes the token
//    while `push: true` only fails to refute it. See {@link probeRepo}.

/** The public API. A deployment on GitHub Enterprise Server passes its own base. */
const PUBLIC_GITHUB_API_BASE = 'https://api.github.com'

/**
 * How many targeted repositories the fine-grained probe reads. Small on purpose: this runs on
 * board load, and the question it answers ("can this token push to the repositories we work
 * on") is settled by a handful of samples. The failure it catches is a token scoped to the
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
   * The GitHub repositories this workspace's runs would push to: the ones its mounted services
   * target, which is what makes a per-repository answer worth acting on. Empty yields an
   * all-`unknown` report rather than a clean one, though the caller normally resolves that
   * state to `not_applicable` before reaching here (no target ⇒ no run ⇒ no token to judge).
   */
  targetRepos: readonly GitHubPatProbeRepo[]
  /** The instance's browser-facing base, carried through for the re-mint link. */
  webUrl: string | null
}

export interface GitHubPatCapabilityDeps {
  apiBase?: string
  fetch?: typeof fetch
  logger?: Logger
  maxProbedRepos?: number
}

/**
 * What one repository probe established. Four outcomes rather than the obvious three, because
 * the two ways a read can fail to produce a positive are not the same fact:
 *
 *  - `refused`       — GitHub answered, and said the authenticated identity cannot push here.
 *  - `denied`        — GitHub answered 404. For a credential that just authenticated against a
 *    live API, that is "this token may not see this repository": GitHub 404s rather than 403s
 *    on a repository a credential is not granted, so existence is never leaked.
 *  - `permitted`     — the identity can push. NOT proof the token can (see {@link probeRepo}).
 *  - `indeterminate` — a transport failure, a 5xx, or a payload shape we cannot read. Says
 *    nothing about anything.
 */
type RepoProbeOutcome = 'permitted' | 'refused' | 'denied' | 'indeterminate'

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
 * Two things establish `missing`, and neither is a guess:
 *
 *  - A single `refused`. A board whose service targets a repository this identity cannot push
 *    to has a broken pipeline for that repository, whatever the others say.
 *  - EVERY probe coming back `denied`. One 404 among reachable repositories stays ambiguous
 *    between "not in this token's selection" and a projection row pointing at a repository
 *    that has since been renamed or deleted, and a stale row must not be reported as a broken
 *    credential. But `GET /user` has already succeeded by this point, so the token
 *    authenticates and GitHub is answering; a 404 on every repository the board's services
 *    target is the token's repository selection. The alternative reading is that every
 *    repository this board works on vanished at once, which is not a state a board arrives at
 *    without its owner knowing.
 *
 * Everything else is `unknown`, `permitted` included: it refutes nothing and proves nothing
 * (see {@link probeRepo}).
 */
function foldRepoProbes(outcomes: readonly RepoProbeOutcome[]): GitHubPatCapabilityStatus {
  if (outcomes.length === 0) return 'unknown'
  if (outcomes.includes('refused')) return 'missing'
  return outcomes.every((o) => o === 'denied') ? 'missing' : 'unknown'
}

/**
 * Ask GitHub what the token reaches on one repository.
 *
 * `permissions.push` on the repository payload reports the authenticated IDENTITY's role, not
 * the grants of the credential presenting it, and that asymmetry is why this returns four
 * outcomes rather than a boolean. A token's reach is a SUBSET of its owner's: a fine-grained
 * token holding `contents: read` on a repository its owner maintains still sees `push: true`
 * there, and so would a classic token minted with nothing ticked. So `false` REFUTES the token
 * (the owner cannot push, therefore neither can anything acting as them) while `true` merely
 * fails to refute it, and reporting the latter as `granted` would have been the module
 * silencing the exact gap it exists to find.
 *
 * A 404 is the one positive statement about the CREDENTIAL available here: GitHub answers 404
 * rather than 403 for a repository a credential may not see, so as not to leak its existence.
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
    if (res.status === 404) return 'denied'
    if (!res.ok) return 'indeterminate'
    const body = (await res.json()) as { permissions?: { push?: boolean } }
    const push = body.permissions?.push
    // An absent permissions block is not a denial — it is an older/enterprise payload shape we
    // cannot read. Indeterminate, rather than inventing a refusal GitHub never made.
    return push === true ? 'permitted' : push === false ? 'refused' : 'indeterminate'
  } catch (error) {
    logger?.warn('GitHub repository permission probe failed; treating it as unreadable', {
      repo: `${repo.owner}/${repo.name}`,
      ...describeError(error),
    })
    return 'indeterminate'
  }
}

/**
 * Whether a 401/403/429 is GitHub throttling this token rather than rejecting it.
 *
 * GitHub answers 403 for a spent primary rate limit and for a tripped secondary one, the same
 * status it uses for a token an org policy blocks. Read as a rejection, a throttled board load
 * raises the loudest banner the product has and tells the reader to mint a replacement, which
 * is both the wrong remedy and an expensive one. The three signals below are GitHub's own
 * documented markers, and every one of them means "ask again later".
 */
function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true
  if (res.headers.get('x-ratelimit-remaining') === '0') return true
  return res.headers.get('retry-after') !== null
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
  // A throttled token is a temporary upstream condition, not a verdict — checked FIRST because
  // GitHub spells it with the same 403 it uses to reject a credential outright.
  if (isRateLimited(res)) {
    return {
      state: 'probe_failed',
      message: `GitHub rate-limited this token (HTTP ${res.status}); the check will run again on the next board load`,
    }
  }
  // 401/403 is now the token itself: revoked, expired, or blocked by an org policy. Anything
  // else non-2xx is GitHub having a bad day, which says nothing about the credential.
  if (res.status === 401 || res.status === 403) {
    return { state: 'token_rejected', status: res.status, source: request.source }
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
        capabilities: classicCapabilities(scope.scopes),
        // A classic token's scopes answer for every repository at once, so nothing was sampled
        // and there is no unread remainder to declare.
        probedRepos: [],
        deniedRepos: [],
        unprobedRepoCount: 0,
        webUrl: request.webUrl,
      },
    }
  }

  // Fine-grained (and the `unknown` kind, which is equally unreadable from headers): the only
  // available evidence is what the token can do to a repository we know a run would target.
  const toProbe = request.targetRepos.slice(0, maxRepos)
  const outcomes = await Promise.all(
    toProbe.map((repo) => probeRepo(repo, request.token, apiBase, fetchImpl, deps.logger)),
  )
  const name = (repo: GitHubPatProbeRepo): string => `${repo.owner}/${repo.name}`
  return {
    state: 'checked',
    report: {
      source: request.source,
      kind: scope.kind,
      capabilities: {
        push: foldRepoProbes(outcomes),
        // No GitHub endpoint reports a fine-grained token's `pull_requests` or `workflows`
        // permission, and neither is inferable from `contents` (a token can hold one without
        // the other). Stated as unknown rather than assumed either way.
        pullRequests: 'unknown',
        workflows: 'unknown',
      },
      probedRepos: toProbe.map(name),
      deniedRepos: toProbe.filter((_, i) => outcomes[i] === 'denied').map(name),
      unprobedRepoCount: Math.max(0, request.targetRepos.length - toProbe.length),
      webUrl: request.webUrl,
    },
  }
}
