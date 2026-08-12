// The provider side of the repository purge: the REST calls `repoPurge.ts` plans against.
//
// Split from `repoPurge.ts` so the JUDGEMENTS (what to keep, what to tag, what order to write in)
// stay drivable with no network, which is the half worth testing. This file is plumbing, and the one
// thing in it that is a decision rather than a call is stated where it happens: the new tree is built
// WITHOUT `base_tree`, because a tree built on a base is a PATCH of it and there is no way to spell
// "remove everything else" in one. Listing only the kept entries is how the emptying is expressed.
//
// **Provider-keyed for the reason `vcsIssues.ts` is.** GitLab is null rather than served by GitHub's
// client: its API lives on the instance, and nothing in `/api/v1` publishes which instance a
// workspace talks to, so the only base this code could invent is `gitlab.com`.

import type { PrReportRunProvider } from '@cat-factory/sdk'
import type {
  KeepOnlyCommit,
  PurgeTarget,
  RepoBranch,
  RepoContentApi,
  RepoHead,
  RepoPullRequest,
} from './repoPurge.ts'

export type RepoContentApiOptions = {
  token: string
  /** REST base, e.g. `https://api.github.com`. */
  apiBaseUrl: string
  /** Injected so the unit tests can drive every branch with no network. */
  fetchImpl?: typeof fetch
}

/**
 * The client for a provider, or null where this suite cannot address that provider's API.
 *
 * A `Record` over the provider union, so a third provider fails to COMPILE rather than silently
 * inheriting GitHub's client and force-pushing against the wrong host.
 */
export const REPO_CONTENT_APIS: Record<
  PrReportRunProvider,
  ((options: RepoContentApiOptions) => RepoContentApi) | null
> = {
  github: createGitHubRepoContentApi,
  gitlab: null,
}

type TreeEntry = { path?: string; mode?: string; type?: string; sha?: string }

function createGitHubRepoContentApi(options: RepoContentApiOptions): RepoContentApi {
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

  const repoPath = (target: PurgeTarget) => `/repos/${target.owner}/${target.repo}`

  const json = async <T>(path: string, what: string): Promise<T> => {
    const response = await call(path)
    if (!response.ok) throw await failure(response, what)
    return (await response.json()) as T
  }

  /** The root tree entries of one commit, with the metadata a rebuild needs. */
  const rootTree = async (target: PurgeTarget, commitSha: string): Promise<TreeEntry[]> => {
    const commit = await json<{ tree?: { sha?: string } }>(
      `${repoPath(target)}/git/commits/${commitSha}`,
      `reading commit ${commitSha} on ${slug(target)}`,
    )
    const treeSha = commit.tree?.sha
    if (typeof treeSha !== 'string') {
      throw new Error(
        `GitHub answered no tree for commit ${commitSha} on ${slug(target)}, so nothing here can ` +
          `tell what the repository holds.`,
      )
    }
    // Non-recursive: the purge decides at ROOT level, and a directory entry carries its whole
    // subtree by sha, so a recursive listing would be a much larger read for the same answer.
    const tree = await json<{ tree?: TreeEntry[] }>(
      `${repoPath(target)}/git/trees/${treeSha}`,
      `reading the tree of ${commitSha} on ${slug(target)}`,
    )
    return tree.tree ?? []
  }

  return {
    async head(target) {
      const repo = await json<{ default_branch?: string }>(
        repoPath(target),
        `reading ${slug(target)}`,
      )
      const branch = repo.default_branch
      if (typeof branch !== 'string' || branch.length === 0) return null
      const response = await call(`${repoPath(target)}/git/ref/heads/${encodeURIComponent(branch)}`)
      // 404 here is a repository with a default branch NAME and no commits under it, which is what
      // an empty repository looks like: nothing to empty rather than a failure.
      if (response.status === 404) return null
      if (!response.ok) throw await failure(response, `reading ${branch} on ${slug(target)}`)
      const ref = (await response.json()) as { object?: { sha?: string } }
      const commitSha = ref.object?.sha
      if (typeof commitSha !== 'string') return null
      return { branch, commitSha } satisfies RepoHead
    },

    async rootEntries(target, commitSha) {
      const entries = await rootTree(target, commitSha)
      return entries.flatMap((entry) => (typeof entry.path === 'string' ? [entry.path] : []))
    },

    async branches(target) {
      const rows = await json<{ name?: string; commit?: { sha?: string } }[]>(
        `${repoPath(target)}/branches?per_page=100`,
        `listing branches on ${slug(target)}`,
      )
      return rows.flatMap((row): RepoBranch[] =>
        typeof row.name === 'string' && typeof row.commit?.sha === 'string'
          ? [{ name: row.name, commitSha: row.commit.sha }]
          : [],
      )
    },

    async openPullRequests(target) {
      const rows = await json<{ number?: number; title?: string; head?: { ref?: string } }[]>(
        `${repoPath(target)}/pulls?state=open&per_page=100`,
        `listing pull requests on ${slug(target)}`,
      )
      return rows.flatMap((row): RepoPullRequest[] =>
        typeof row.number === 'number'
          ? [{ number: row.number, title: row.title ?? '', headBranch: row.head?.ref ?? '' }]
          : [],
      )
    },

    async createTag(target, tag, commitSha) {
      const response = await call(`${repoPath(target)}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commitSha }),
      })
      // 422 is "already exists", which for a backup tag at the same sha is the state we wanted. The
      // tag name carries a per-run stamp, so this is a re-run of the same purge rather than a
      // collision with somebody else's tag.
      if (response.status === 422) return
      if (!response.ok) throw await failure(response, `tagging ${commitSha} as '${tag}'`)
    },

    async commitKeepingOnly(target, commit: KeepOnlyCommit) {
      const entries = await rootTree(target, commit.parentSha)
      const kept = entries.filter(
        (entry) => typeof entry.path === 'string' && commit.keepPaths.includes(entry.path),
      )
      // Without `base_tree`. A tree POSTed WITH one is a patch applied over it, and a patch cannot
      // say "and nothing else": the removals would need an explicit null-sha entry per path, which
      // is both more calls and a list that goes stale between the read and the write. Listing the
      // kept entries builds the tree the purge means, in one call, whatever else was there.
      const tree = await call(`${repoPath(target)}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
          tree: kept.map((entry) => ({
            path: entry.path,
            mode: entry.mode ?? '100644',
            type: entry.type ?? 'blob',
            sha: entry.sha,
          })),
        }),
      })
      if (!tree.ok) throw await failure(tree, `building the emptied tree for ${slug(target)}`)
      const treeSha = ((await tree.json()) as { sha?: string }).sha
      if (typeof treeSha !== 'string') {
        throw new Error(`GitHub accepted the tree for ${slug(target)} but answered no sha.`)
      }

      const created = await call(`${repoPath(target)}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
          message: commit.message,
          tree: treeSha,
          // The previous tip, which is what makes this revertible: nothing becomes unreachable.
          parents: [commit.parentSha],
        }),
      })
      if (!created.ok)
        throw await failure(created, `committing the emptied tree on ${slug(target)}`)
      const sha = ((await created.json()) as { sha?: string }).sha
      if (typeof sha !== 'string') {
        throw new Error(`GitHub accepted the commit on ${slug(target)} but answered no sha.`)
      }
      return sha
    },

    async updateBranch(target, branch, commitSha) {
      const response = await call(
        `${repoPath(target)}/git/refs/heads/${encodeURIComponent(branch)}`,
        {
          method: 'PATCH',
          // `force: false` is the safety property spelled out rather than left to the default: the
          // new commit descends from the tip, so a fast-forward is all this ever needs, and a
          // provider that would have to rewrite the branch to satisfy this call REFUSES instead.
          body: JSON.stringify({ sha: commitSha, force: false }),
        },
      )
      if (!response.ok) throw await failure(response, `moving ${branch} on ${slug(target)}`)
    },

    async closePullRequest(target, number) {
      const response = await call(`${repoPath(target)}/pulls/${number}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      })
      if (!response.ok) throw await failure(response, `closing pull request #${number}`)
    },

    async deleteBranch(target, branch) {
      const response = await call(
        `${repoPath(target)}/git/refs/heads/${encodeURIComponent(branch)}`,
        { method: 'DELETE' },
      )
      // Already gone is the state the purge wanted.
      if (response.status === 404 || response.status === 422) return
      if (!response.ok) throw await failure(response, `deleting branch '${branch}'`)
    },
  }
}

function slug(target: PurgeTarget): string {
  return `${target.owner}/${target.repo}`
}

/** The error for a provider response nobody expected, carrying the body that names the cause. */
async function failure(response: Response, what: string): Promise<Error> {
  const body = await response.text().catch(() => '(unreadable body)')
  return new Error(`The provider answered HTTP ${response.status} ${what}: ${body.slice(0, 500)}`)
}
