// ---------------------------------------------------------------------------
// The VCS HOST REST surface: opening a pull request / merge request, finding the one that is
// already open, and refreshing its title + description.
//
// Split out of `git.ts`, which is otherwise entirely the git CLI. The seam is real rather than
// arithmetic: nothing here shells out to git, nothing in `git.ts` speaks HTTP, and the two
// halves fail in completely different ways (a rejected credential and a 403 from an App
// permission want different remedies). `test/git-pr.test.ts` already covered exactly this
// surface before it had a file of its own.
//
// Provider-agnostic by construction: GitHub and GitLab each get their own request shapes behind
// one `openPullRequest` entry point, and every capability added to one is added to the other.
// ---------------------------------------------------------------------------

import type { PrSpec } from './job.js'
import { HarnessFailure } from './failure.js'
import { preserveManagedSection } from './pr-description.js'
import { redactSecrets } from './redact.js'

/**
 * Classify a PR/MR-open REST failure by its HTTP status into an actionable remedy, else
 * undefined (an unmapped status keeps just the raw `Failed to open … (HTTP n)` line). Like
 * {@link describeGitFailure} this only APPENDS a cause + fix — the raw status line is
 * load-bearing detail and stays. `provider` tailors the scope/permission wording (GitHub App
 * Pull-requests permission / `repo` PAT scope vs GitLab `api` scope) and the noun (pull
 * request vs merge request). Pure, so it is unit-tested per status.
 */
export function describePrOpenFailure(
  status: number,
  provider: 'github' | 'gitlab',
): string | undefined {
  const noun = provider === 'gitlab' ? 'merge request' : 'pull request'
  if (status === 401) {
    return (
      `The credential was rejected while opening the ${noun}. The GitHub App installation token ` +
      '(or, in local mode, the GITHUB_PAT) is most likely expired, rotated, or revoked — reconnect ' +
      'the GitHub App for the workspace (or regenerate the PAT), then retry.'
    )
  }
  if (status === 403) {
    const scope =
      provider === 'gitlab'
        ? 'the GitLab token needs the `api` scope and Developer+ access to the project'
        : 'the GitHub App needs the "Pull requests: write" permission (or the PAT the `repo` scope) and write access to the repository'
    return `The credential lacks permission to open a ${noun}: ${scope}. Grant it, then retry.`
  }
  if (status === 404) {
    return (
      `The repository could not be found while opening the ${noun} — it may have been deleted, ` +
      'renamed, or made private, or the credential can no longer see it. Confirm the repo and the ' +
      "credential's access to it, then retry."
    )
  }
  if (status === 422 || status === 400) {
    return (
      `GitHub/GitLab rejected the ${noun} as invalid. Usually the head or base branch does not ` +
      'exist, the two branches are identical (nothing to compare), or the base branch is protected ' +
      'against direct PRs. Check the branch names and that the head has commits ahead of the base, ' +
      'then retry.'
    )
  }
  return undefined
}
export interface OpenPullRequestOptions {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  pr: PrSpec
  apiBase?: string
  /**
   * The repo's clone URL. Used (when {@link provider} is absent) to detect the provider and,
   * for GitLab, to derive the REST base + project path from its host — so the harness opens a
   * GitLab **merge request** rather than POSTing to GitHub's pulls API. Absent ⇒ GitHub.
   */
  cloneUrl?: string
  /**
   * The VCS provider, when the dispatcher knows it (the server derives it from the configured
   * source-control backend and sets `repo.provider`). AUTHORITATIVE — it overrides host
   * inference — so a self-managed GitLab on an arbitrarily-named host (e.g. `git.acme.com`,
   * which {@link inferVcsProvider} can't recognise) still opens a merge request instead of
   * being misrouted to GitHub's API. Absent ⇒ inferred from {@link cloneUrl}'s host.
   */
  provider?: 'github' | 'gitlab'
  /**
   * When the PR/MR for {@link head} ALREADY exists (a resumed run pushing onto a branch whose PR
   * is open), replace its title and description with {@link pr} instead of leaving them alone.
   *
   * Set ONLY when {@link pr} carries the agent's own reviewer briefing. A resumed run is exactly
   * the case that matters — eviction + re-dispatch, a ralph iteration, a retry — and without this
   * the agent writes a briefing the platform reads, scrubs, caps and then silently drops. It must
   * stay opt-in, though: refreshing from the GENERIC dispatch-time fallback would overwrite a
   * description a human (or an earlier, better-informed run) had already written.
   *
   * The engine's managed verification-report region is carried across the rewrite by
   * {@link preserveManagedSection}, and the update is best-effort — a failed refresh keeps the
   * run's real outcome, which is the pushed work.
   */
  refreshExisting?: boolean
  signal?: AbortSignal
}

/**
 * The VCS host a clone URL points at. The harness is otherwise provider-agnostic (its git
 * auth is a host-neutral GIT_ASKPASS credential), but the "open the PR/MR" REST call is not:
 * GitHub and GitLab have different endpoints, so infer which to call from the host. GitHub is
 * the default; a host of `gitlab.com` or one in the `gitlab.*` / `*.gitlab.*` family (covering
 * self-managed instances named that way) is treated as GitLab.
 */
export function inferVcsProvider(cloneUrl: string): 'github' | 'gitlab' {
  let host = ''
  try {
    host = new URL(cloneUrl).host.toLowerCase()
  } catch {
    return 'github'
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.') || host.includes('.gitlab.')) {
    return 'gitlab'
  }
  return 'github'
}

/** The GitLab REST v4 base for a clone URL's host, e.g. `https://gitlab.com/api/v4`. */
export function gitlabApiBaseFromCloneUrl(cloneUrl: string): string {
  const u = new URL(cloneUrl)
  return `${u.protocol}//${u.host}/api/v4`
}

/**
 * The URL-encoded GitLab project path from a clone URL — the full namespace path (so subgroups
 * survive), with the trailing `.git` stripped, e.g.
 * `https://gitlab.com/group/sub/proj.git` → `group%2Fsub%2Fproj`.
 */
export function gitlabProjectPath(cloneUrl: string): string {
  const path = new URL(cloneUrl).pathname.replace(/^\/+/, '').replace(/\.git$/, '')
  return encodeURIComponent(path)
}

/** The abort reason as an Error (the watchdog aborts with one), or a generic fallback. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

/** Whether a thrown fetch error is an AbortError (caller-initiated, never retried). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/**
 * Parse a `Retry-After` header into ms, bounded so it can't stall the job. Accepts BOTH
 * forms the spec allows: integer delay-seconds (`120`) and an HTTP-date (`Wed, 21 Oct 2026
 * 07:28:00 GMT`); the latter is turned into a delay from now. A past/zero/unparseable value
 * yields undefined so the caller falls back to exponential backoff.
 */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) {
    return secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  const ms = at - Date.now()
  return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined
}

/** Sleep `ms`, rejecting immediately (with the abort reason) if `signal` aborts meanwhile. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal))
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal as AbortSignal))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const MAX_RETRY_AFTER_MS = 8_000
const RETRY_BASE_MS = 500
const RETRY_MAX_DELAY_MS = 4_000

/**
 * Run a single HTTP request with bounded retry for TRANSIENT failures, so a momentary
 * upstream blip (a 5xx, a 429 rate-limit, or a dropped connection) no longer fails an
 * otherwise-complete run on its very last step (opening the PR/MR). Up to 3 attempts
 * (2 retries) with exponential backoff + jitter (honoring a `Retry-After` on a 429),
 * every wait abort-aware so the inactivity/max-duration watchdog still cancels promptly.
 *
 * ONLY transient failures retry: a `>=500`/`429` response, or a network-level fetch
 * rejection. A 4xx (incl. the 422/409 "already exists" the callers treat as success) is
 * returned to the caller unretried, and a caller abort is rethrown at once. The response
 * body is never read here, so the caller's existing status handling is unchanged.
 */
async function withApiRetry(
  fn: () => Promise<Response>,
  opts: { signal?: AbortSignal; attempts?: number } = {},
): Promise<Response> {
  const maxAttempts = opts.attempts ?? 3
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.signal)
    let res: Response | undefined
    try {
      res = await fn()
    } catch (err) {
      // A caller/watchdog abort is terminal; a network error is transient → retry.
      if (isAbortError(err) || opts.signal?.aborted) throw err
      lastError = err
    }
    if (res) {
      const transient = res.status >= 500 || res.status === 429
      if (!transient || attempt >= maxAttempts) return res
      const after = retryAfterMs(res)
      // Discard the unread body before retrying so the connection can be reused.
      await res.body?.cancel().catch(() => {})
      await abortableDelay(after ?? backoffMs(attempt), opts.signal)
      continue
    }
    if (attempt >= maxAttempts) break
    await abortableDelay(backoffMs(attempt), opts.signal)
  }
  // Exhausted on a network-level rejection (no HTTP response): an upstream API failure.
  const message =
    lastError instanceof Error ? lastError.message : 'API request failed after retries'
  throw new HarnessFailure('api', redactSecrets(message))
}

/** Exponential backoff (base 500ms, capped 4s) with up to 25% positive jitter. */
function backoffMs(attempt: number): number {
  const base = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_MS * 2 ** (attempt - 1))
  return base + Math.floor(base * 0.25 * Math.random())
}

/**
 * Open a PR (GitHub) or merge request (GitLab) for the pushed branch; returns its web URL.
 * The provider is chosen from the EXPLICIT `opts.provider` when the dispatcher set it,
 * falling back to host inference from the clone URL only when it didn't — so a self-managed
 * GitLab whose host isn't named `gitlab.*` still opens an MR instead of being misrouted to
 * GitHub's API. The GitHub path is unchanged.
 */
export async function openPullRequest(opts: OpenPullRequestOptions): Promise<string | null> {
  const provider = opts.provider ?? (opts.cloneUrl ? inferVcsProvider(opts.cloneUrl) : 'github')
  if (provider === 'gitlab') {
    if (!opts.cloneUrl) {
      throw new Error('Cannot open a GitLab merge request without the repo clone URL')
    }
    return openGitLabMergeRequest({ ...opts, cloneUrl: opts.cloneUrl })
  }
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const path = `${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  const res = await withApiRetry(
    () =>
      fetch(`${apiBase}/repos/${path}/pulls`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.ghToken}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'cat-factory-executor',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: opts.pr.title,
          head: opts.head,
          base: opts.base,
          body: opts.pr.body,
        }),
        // Bound on the watchdog so a hung GitHub call can't stall the job.
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    { signal: opts.signal },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // A resumed run pushes to a branch that already has an open PR; GitHub answers
    // 422 "A pull request already exists". That's success for us — return the
    // existing PR's url rather than failing the resumed run.
    if (res.status === 422 && /pull request already exists/i.test(detail)) {
      const existing = await findOpenPullRequest(opts)
      if (existing) {
        if (opts.refreshExisting) await refreshPullRequest(opts, existing)
        return existing.url
      }
    }
    // The head branch has nothing ahead of base ("No commits between <base> and <head>").
    // That is not an API failure — there is simply nothing to open a PR for (e.g. a resumed
    // branch whose earlier PR was merged with a merge commit, leaving the branch reachable
    // from base). Signal it with null so the caller records a clean no-op instead of failing
    // the run with GitHub's opaque 422.
    if (res.status === 422 && /no commits between/i.test(detail)) return null
    const remedy = describePrOpenFailure(res.status, 'github')
    const base = redactSecrets(`Failed to open PR (HTTP ${res.status}): ${detail.slice(0, 300)}`)
    throw new HarnessFailure('api', remedy ? `${base}\n${remedy}` : base)
  }
  const body = (await res.json()) as { html_url?: string }
  if (!body.html_url) throw new HarnessFailure('api', 'GitHub did not return a PR url')
  return body.html_url
}

/** GitLab API headers for the PAT (the `PRIVATE-TOKEN` auth GitLab uses). */
function gitlabHeaders(token: string): Record<string, string> {
  return {
    'private-token': token,
    accept: 'application/json',
    'user-agent': 'cat-factory-executor',
    'content-type': 'application/json',
  }
}

/**
 * Open a GitLab merge request (the analogue of {@link openPullRequest} for GitLab). The REST
 * base + project path are derived from the clone URL's host, so it works for gitlab.com and a
 * self-managed instance alike. `head`→`source_branch`, `base`→`target_branch`. On a duplicate
 * (a resumed run whose branch already has an open MR — GitLab answers 409) the existing MR's
 * web URL is returned instead of failing the run, mirroring the GitHub 422 handling.
 */
async function openGitLabMergeRequest(
  opts: OpenPullRequestOptions & { cloneUrl: string },
): Promise<string> {
  const apiBase = gitlabApiBaseFromCloneUrl(opts.cloneUrl)
  const project = gitlabProjectPath(opts.cloneUrl)
  const res = await withApiRetry(
    () =>
      fetch(`${apiBase}/projects/${project}/merge_requests`, {
        method: 'POST',
        headers: gitlabHeaders(opts.ghToken),
        body: JSON.stringify({
          source_branch: opts.head,
          target_branch: opts.base,
          title: opts.pr.title,
          description: opts.pr.body,
        }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }),
    { signal: opts.signal },
  )
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // GitLab returns 409 (sometimes 400) when an open MR already exists for this source
    // branch; that is success for a resumed run — return the existing MR's url.
    if (
      (res.status === 409 || res.status === 400) &&
      /already exists|open merge request/i.test(detail)
    ) {
      const existing = await findOpenMergeRequest(apiBase, project, opts)
      if (existing) {
        if (opts.refreshExisting) await refreshMergeRequest(apiBase, project, opts, existing)
        return existing.url
      }
    }
    const remedy = describePrOpenFailure(res.status, 'gitlab')
    const base = redactSecrets(
      `Failed to open merge request (HTTP ${res.status}): ${detail.slice(0, 300)}`,
    )
    throw new HarnessFailure('api', remedy ? `${base}\n${remedy}` : base)
  }
  const body = (await res.json()) as { web_url?: string }
  if (!body.web_url) throw new HarnessFailure('api', 'GitLab did not return a merge request url')
  return body.web_url
}

/**
 * Rewrite an already-open MR's title and description — the GitLab half of
 * {@link refreshPullRequest}, so a resumed run's agent briefing reaches both hosts alike.
 * Best-effort for the same reason.
 */
async function refreshMergeRequest(
  apiBase: string,
  project: string,
  opts: OpenPullRequestOptions,
  existing: ExistingPullRequest,
): Promise<void> {
  if (existing.number === undefined) return
  await fetch(`${apiBase}/projects/${project}/merge_requests/${existing.number}`, {
    method: 'PUT',
    headers: gitlabHeaders(opts.ghToken),
    body: JSON.stringify({
      title: opts.pr.title,
      description: preserveManagedSection(existing.body, opts.pr.body),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).catch(() => undefined)
}

/** Find the open GitLab MR for `opts.head`→`opts.base`, or undefined when there is none. */
async function findOpenMergeRequest(
  apiBase: string,
  project: string,
  opts: { head: string; base: string; ghToken: string; signal?: AbortSignal },
): Promise<ExistingPullRequest | undefined> {
  // Filter by BOTH branches: a source branch can have open MRs to several targets, so the
  // source alone could match an MR against a different base than the one we just tried to open.
  const query = new URLSearchParams({
    source_branch: opts.head,
    target_branch: opts.base,
    state: 'opened',
  })
  const res = await fetch(`${apiBase}/projects/${project}/merge_requests?${query}`, {
    headers: gitlabHeaders(opts.ghToken),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) return undefined
  const list = (await res.json().catch(() => [])) as Array<{
    web_url?: string
    iid?: number
    description?: string | null
  }>
  const found = Array.isArray(list) ? list[0] : undefined
  if (!found?.web_url) return undefined
  return {
    url: found.web_url,
    // `iid` (project-scoped) is what the update endpoint addresses, not the global `id`.
    ...(typeof found.iid === 'number' ? { number: found.iid } : {}),
    body: found.description ?? undefined,
  }
}

/**
 * An already-open PR: enough to return it as the run's PR and, when the host told us its
 * number, to rewrite its description.
 *
 * `number` is OPTIONAL on purpose. Returning the existing PR's url is what keeps a resumed run
 * from failing, and that must not become contingent on a second field parsing: a response we
 * can read a url but not a number out of degrades to "found it, can't refresh it", never to a
 * failed run.
 */
interface ExistingPullRequest {
  url: string
  number?: number
  body: string | undefined
}

/**
 * Rewrite an already-open PR's title and description from `opts.pr` (a resumed run whose agent
 * wrote a fresh reviewer briefing — see {@link OpenPullRequestOptions.refreshExisting}).
 *
 * Best-effort by construction: the work is already pushed and the PR already exists, so a failed
 * refresh must degrade to the stale description rather than fail the run.
 */
async function refreshPullRequest(
  opts: OpenPullRequestOptions,
  existing: ExistingPullRequest,
): Promise<void> {
  if (existing.number === undefined) return
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  const path = `${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  await fetch(`${apiBase}/repos/${path}/pulls/${existing.number}`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${opts.ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory-executor',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      title: opts.pr.title,
      body: preserveManagedSection(existing.body, opts.pr.body),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }).catch(() => undefined)
}

/** Find the open PR for `opts.head` on `opts.base`, or undefined when there is none. */
async function findOpenPullRequest(opts: {
  owner: string
  name: string
  ghToken: string
  head: string
  base: string
  apiBase?: string
  signal?: AbortSignal
}): Promise<ExistingPullRequest | undefined> {
  const apiBase = opts.apiBase ?? 'https://api.github.com'
  // Encode the ref-derived query params: a branch/owner containing `&` or `#` would
  // otherwise split the query string or inject an unintended parameter.
  const query = new URLSearchParams({
    head: `${opts.owner}:${opts.head}`,
    base: opts.base,
    state: 'open',
  })
  const path = `${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.name)}`
  const res = await fetch(`${apiBase}/repos/${path}/pulls?${query}`, {
    headers: {
      authorization: `Bearer ${opts.ghToken}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'cat-factory-executor',
      'x-github-api-version': '2022-11-28',
    },
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  if (!res.ok) return undefined
  const list = (await res.json().catch(() => [])) as Array<{
    html_url?: string
    number?: number
    body?: string | null
  }>
  const found = Array.isArray(list) ? list[0] : undefined
  if (!found?.html_url) return undefined
  return {
    url: found.html_url,
    ...(typeof found.number === 'number' ? { number: found.number } : {}),
    body: found.body ?? undefined,
  }
}
