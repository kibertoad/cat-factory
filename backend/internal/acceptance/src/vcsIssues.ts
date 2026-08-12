// The one thing in this suite that is NOT the platform: filing an issue as an outside reporter,
// and reading back what the platform did to it.
//
// Every other call the suite makes goes through the published SDK, because the platform is what is
// under test. This file is the opposite by design. Spec 04's premise is that somebody who has never
// heard of cat-factory opens an issue on a repository, and the platform picks it up, delivers it and
// closes it. If the platform filed that issue itself the test would be circular: an issue it created
// through a credential it holds, closed through the same credential, proves the credential works.
//
// So the reporter is a SEPARATE credential (`ACCEPTANCE_VCS_TOKEN`) talking to the provider's own
// REST API, and the assertions at the end read the issue the same way: from the provider, not from
// the platform's projection of it. There is no `/api/v1` operation for either half, and there should
// not be: filing an issue is not something this product does for you.
//
// **Provider-keyed, and a provider it cannot serve answers NULL rather than being served wrongly.**
// The table is the seam CLAUDE.md's "never re-hardcode GitHub" asks for; `gitlab` is null for the
// same reason `configureEnv.ts`'s `REPO_CREATION_URL` is, and it is worth stating because it is not
// laziness: GitLab's API lives on the INSTANCE, and no `/api/v1` read publishes which instance a
// workspace's connection talks to. The only base this code could invent is `gitlab.com`, which for a
// self-hosted deployment is a stranger's server to file an issue on. What is missing is one
// configured URL, not a client, and the prerequisite says so.

import { describeConnectionFailure } from '@cat-factory/kernel'
import type { PrReportRunProvider } from '@cat-factory/sdk'
import type { AcceptanceConfig } from './config.ts'
import { describeThrown } from './operatorText.ts'

/** One repository, as both the provider's API and `GET /api/v1/repos` name it. */
export type IssueTarget = { owner: string; repo: string }

/** Rows per page for the one list read here: the provider's maximum. */
const ISSUES_PER_PAGE = 100

/** Pages `listOpen` walks before it REFUSES, rather than silently answering the part it read. */
const MAX_ISSUE_PAGES = 50

/** An issue that now exists on the provider. */
export type FiledIssue = {
  number: number
  /** The canonical web URL, which is also the `ticket.ref` grammar `/api/v1` accepts. */
  url: string
}

/** What the provider says about one issue right now. */
export type IssueState = {
  /** The provider's own state word (`open`/`closed`), reported rather than normalised away. */
  state: string
  closed: boolean
  url: string
  /** Every comment body on the issue, oldest first. */
  comments: readonly string[]
}

/**
 * Whether the reporter credential can do the one thing spec 04 needs of it.
 *
 * Four verdicts rather than a boolean, because they have four different fixes and a provider
 * answers three of them with statuses a caller must not blur: a token this provider does not know
 * (401), a repository the token cannot see OR that does not exist (404, which the provider
 * deliberately answers identically for both), a repository whose Issues feature is switched off,
 * and an unreadable probe, which is never evidence of any of the other three.
 */
export type IssueCredentialVerdict =
  | { status: 'ready' }
  | { status: 'unauthenticated' }
  | { status: 'unreachable' }
  | { status: 'issues-disabled' }
  | {
      status: 'unreadable'
      /** What happened, read from the whole cause chain rather than the outermost link. */
      detail: string
      /**
       * What to do about it, when the cause is one kernel recognises: relayed rather than
       * paraphrased, for the reason `probeFailure.ts` relays the same sentences. Absent for an
       * unrecognised failure, because a guessed remedy sends the reader somewhere wrong.
       */
      hint?: string
    }

/** One open issue, as a purge needs to judge whether it is this suite's to close. */
export type OpenIssueSummary = {
  number: number
  title: string
  url: string
  /** The account that filed it, or null when the provider reports none (a deleted user). */
  authorLogin: string | null
}

/** The reporter's calls against one provider. */
export type IssueApi = {
  /** Can this credential file an issue on that repository? Creates nothing. */
  probe(target: IssueTarget): Promise<IssueCredentialVerdict>
  file(target: IssueTarget, issue: { title: string; body: string }): Promise<FiledIssue>
  /** Null when the issue is gone (deleted, or transferred away), which a resume must re-file. */
  read(target: IssueTarget, number: number): Promise<IssueState | null>
  /**
   * Every OPEN issue on the repository, for the purge that discovers what a lost ledger no longer
   * names (`issuePurge.ts`). Issues only: see the GitHub implementation for why that needs saying.
   */
  listOpen(target: IssueTarget): Promise<readonly OpenIssueSummary[]>
  /** Close one. Idempotent at the provider, and reversible by a person, unlike a delete. */
  close(target: IssueTarget, number: number): Promise<void>
  /**
   * The login this credential acts as, which is half the test for whether an issue is this suite's.
   *
   * A property of the CREDENTIAL rather than of a repository, so it is asked once. Null where the
   * provider answers no login rather than throwing, which keeps "nobody to attribute" distinct from
   * "the call failed": the caller must not read the first as evidence about authorship.
   */
  viewer(): Promise<string | null>
}

/** What one provider client needs: the credential, where the API lives, and how to call it. */
export type IssueApiOptions = {
  token: string
  /** REST base, e.g. `https://api.github.com`, or `https://<host>/api/v3` on Enterprise Server. */
  apiBaseUrl: string
  /** Injected so `test/vcsIssues.test.ts` can drive every branch with no network. */
  fetchImpl?: typeof fetch
}

/**
 * The repository the reporter files on, and the ONE place that decides which one it is.
 *
 * The BACKEND repository, because that is the service spec 04's issue is about and the one whose
 * frame the task is filed under. Shared with the `issue-credential` prerequisite so the gate probes
 * the repository the spec will actually use: probing the other one would pass a pass that then
 * cannot file.
 */
export function issueTarget(config: AcceptanceConfig): IssueTarget {
  return { owner: config.repoOwner, repo: config.repos.backend }
}

/**
 * The client for a provider, or null when this suite cannot address that provider's API.
 *
 * A `Record` over the provider union `/api/v1` reports, so a third provider fails to COMPILE here
 * rather than silently inheriting GitHub's client and filing an issue against the wrong host.
 */
export const ISSUE_APIS: Record<
  PrReportRunProvider,
  ((options: IssueApiOptions) => IssueApi) | null
> = {
  github: createGitHubIssueApi,
  gitlab: null,
}

/**
 * Which TASK SOURCE a provider's issues arrive as, for the `ticket.source` a filing names.
 *
 * A `Record` rather than the literal `'github'` at the one call site, for the reason the table above
 * is one: the two vocabularies happen to spell these the same today, and a filing that hard-coded
 * the GitHub source would keep compiling on the day a GitLab client lands and would then import a
 * GitLab issue as a GitHub one.
 */
export const ISSUE_SOURCE_BY_PROVIDER: Record<PrReportRunProvider, 'github' | 'gitlab'> = {
  github: 'github',
  gitlab: 'gitlab',
}

/** Why a null entry above is null, in the words the prerequisite and `configure` both print. */
export const UNSUPPORTED_PROVIDER_REASON: Record<PrReportRunProvider, readonly string[]> = {
  github: [],
  gitlab: [
    'A GitLab issue lives on the INSTANCE, and no /api/v1 read publishes which instance this ' +
      "workspace's connection talks to, so the suite has no base URL to file against.",
    'What is missing is one configured URL rather than a client: the reporter half of spec 04 is ' +
      'four REST calls. Adding ACCEPTANCE_VCS_API_BASE support for GitLab, plus the client, is the ' +
      'change that unblocks it.',
    'Until then, run the pass against a GitHub-connected workspace.',
  ],
}

/**
 * The GitHub reporter: the four calls, and nothing else.
 *
 * `Bearer` rather than `token`, and the API version header pinned, because both are what GitHub's
 * current REST documentation asks of a caller and a fine-grained token rejects the older scheme.
 */
function createGitHubIssueApi(options: IssueApiOptions): IssueApi {
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const fetchImpl = options.fetchImpl ?? fetch
    return fetchImpl(`${options.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    })
  }

  const issuesPath = (target: IssueTarget) => `/repos/${target.owner}/${target.repo}/issues`

  return {
    async probe(target) {
      let response: Response
      try {
        response = await call(`/repos/${target.owner}/${target.repo}`)
      } catch (error) {
        // A transport failure says nothing about the credential OR the repository, and reporting it
        // as either would send someone to re-mint a token because their proxy was down.
        //
        // Described HERE rather than left to escape, and that placement is the point: this is the
        // one prerequisite whose calls leave the deployment, so the gate's own probe context (the
        // backend) cannot name this address. Through kernel, for the reason `probeFailure.ts` uses
        // it: `error.message` on this is undici's contentless `fetch failed`, identical for a DNS
        // typo, a refused connection, an untrusted certificate and an Enterprise Server that is down.
        const { detail, hint } = describeConnectionFailure(error, {
          subject: "the provider's REST API",
          target: options.apiBaseUrl,
        })
        return { status: 'unreadable', detail, ...(hint ? { hint } : {}) }
      }
      if (response.status === 401) return { status: 'unauthenticated' }
      if (response.status === 404) return { status: 'unreachable' }
      if (!response.ok) {
        return { status: 'unreadable', detail: `HTTP ${response.status} reading the repository` }
      }
      let body: { has_issues?: boolean }
      try {
        body = (await response.json()) as { has_issues?: boolean }
      } catch (error) {
        // A 2xx whose body is not JSON is not evidence about the credential either, and it used to
        // sit OUTSIDE the try above and escape the check: the gate then described a failure at the
        // provider against the DEPLOYMENT's address, curl command included. An intercepting proxy or
        // a captive portal answering in the API's place is the usual cause.
        return {
          status: 'unreadable',
          // The address is not repeated: the verdict that renders this already opens with it, as it
          // does for its `HTTP <status> reading the repository` sibling above.
          detail:
            `HTTP ${response.status} with a body that is not the JSON this API documents: ` +
            describeThrown(error),
          hint:
            'Something other than the provider API answered: an intercepting proxy, a captive ' +
            'portal, or ACCEPTANCE_VCS_API_BASE naming a web UI rather than a REST base.',
        }
      }
      // A repository with Issues switched off accepts no issue at all, and the refusal that arrives
      // at file time (a 410) reads like a permission problem. It is knowable here for free.
      return body.has_issues === false ? { status: 'issues-disabled' } : { status: 'ready' }
    },

    async file(target, issue) {
      const response = await call(issuesPath(target), {
        method: 'POST',
        body: JSON.stringify({ title: issue.title, body: issue.body }),
      })
      if (!response.ok) throw await failure(response, `filing an issue on ${slug(target)}`)
      const body = (await response.json()) as { number?: number; html_url?: string }
      if (typeof body.number !== 'number' || typeof body.html_url !== 'string') {
        throw new Error(
          `GitHub accepted the issue on ${slug(target)} but answered no number and URL, so ` +
            `nothing can be linked to it. Body: ${JSON.stringify(body).slice(0, 300)}`,
        )
      }
      return { number: body.number, url: body.html_url }
    },

    async read(target, number) {
      const response = await call(`${issuesPath(target)}/${number}`)
      // Gone rather than unreadable: a resumed pass has to tell "somebody deleted my issue" (re-file)
      // from "the provider is broken" (propagate), and only the first is a 404.
      if (response.status === 404) return null
      if (!response.ok) throw await failure(response, `reading ${slug(target)}#${number}`)
      const body = (await response.json()) as { state?: string; html_url?: string }
      const comments = await call(`${issuesPath(target)}/${number}/comments?per_page=100`)
      if (!comments.ok)
        throw await failure(comments, `reading comments on ${slug(target)}#${number}`)
      const rows = (await comments.json()) as { body?: string }[]
      return {
        state: body.state ?? '(none)',
        closed: body.state === 'closed',
        url: body.html_url ?? '',
        comments: rows.map((row) => row.body ?? ''),
      }
    },

    async listOpen(target) {
      // `GET /issues` returns PULL REQUESTS as well: on GitHub every pull request IS an issue, and
      // the only thing separating them in this payload is the presence of a `pull_request` key. Left
      // unfiltered, a purge would "close" the run's own pull requests as if they were reporter
      // issues, which is both wrong and the kind of wrong that reads as success.
      //
      // Paged to the END, and the page-fill test is over the RAW rows rather than the filtered ones:
      // a repository whose open pull requests fill the first page would otherwise look like the last
      // page of issues, and the reporter's issue on page two would never be seen. A purge that
      // reports nothing to close is indistinguishable from one that never looked.
      const rows: {
        number?: number
        title?: string
        html_url?: string
        user?: { login?: string } | null
        pull_request?: unknown
      }[] = []
      for (let page = 1; page <= MAX_ISSUE_PAGES; page += 1) {
        const response = await call(
          `${issuesPath(target)}?state=open&per_page=${ISSUES_PER_PAGE}&page=${page}`,
        )
        if (!response.ok) {
          throw await failure(response, `listing open issues on ${slug(target)} (page ${page})`)
        }
        const batch = (await response.json()) as typeof rows
        rows.push(...batch)
        if (batch.length < ISSUES_PER_PAGE) break
        if (page === MAX_ISSUE_PAGES) {
          throw new Error(
            `${slug(target)} has more than ${MAX_ISSUE_PAGES * ISSUES_PER_PAGE} open issues and ` +
              `pull requests, which is past anything this suite creates. Refusing rather than ` +
              `acting on the part that was read.`,
          )
        }
      }
      return rows
        .filter((row) => row.pull_request === undefined && typeof row.number === 'number')
        .map((row) => ({
          number: row.number as number,
          title: row.title ?? '',
          url: row.html_url ?? '',
          authorLogin: row.user?.login ?? null,
        }))
    },

    async close(target, number) {
      const response = await call(`${issuesPath(target)}/${number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      })
      if (!response.ok) throw await failure(response, `closing ${slug(target)}#${number}`)
    },

    async viewer() {
      const response = await call('/user')
      if (!response.ok) throw await failure(response, 'reading the account this token acts as')
      const body = (await response.json()) as { login?: string }
      return typeof body.login === 'string' && body.login.length > 0 ? body.login : null
    },
  }
}

export function slug(target: IssueTarget): string {
  return `${target.owner}/${target.repo}`
}

/**
 * The error for a provider response nobody expected, carrying the body.
 *
 * The body is what separates the causes that matter (a repository with Issues disabled, a token
 * missing the Issues permission, a secondary rate limit) and GitHub states each of them in it.
 * Capped, because an error page is not a diagnosis.
 */
async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '(unreadable body)')
  return new Error(`The provider answered HTTP ${response.status} ${what}: ${body.slice(0, 500)}`)
}
