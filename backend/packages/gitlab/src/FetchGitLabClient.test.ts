import { describe, expect, it } from 'vitest'
import type { VcsConnectionRef, VcsRepoRef } from '@cat-factory/kernel'
import { defaultVcsRegistry } from '@cat-factory/kernel'
import { FetchGitLabClient } from './FetchGitLabClient.js'
import { StaticGitLabTokenSource } from './tokenSource.js'
import { registerGitLab } from './index.js'
import { GitLabWebhookMapper, GitLabWebhookVerifier } from './webhook.js'

type FakeResponse = { status?: number; body?: unknown; headers?: Record<string, string> }

// A scripted fetch: matches each request by `METHOD path` (path = URL minus the api base) and
// returns the queued response. A route value may be a SINGLE response or an ARRAY of responses
// consumed one-per-call (the last entry repeats), so a poll loop that reads the same URL several
// times can script a state transition (e.g. rebase_in_progress true → false). Asserts the
// PRIVATE-TOKEN header is always sent.
function fakeFetch(routes: Record<string, FakeResponse | FakeResponse[]>): {
  fetchImpl: typeof fetch
  calls: { method: string; url: string; body?: unknown }[]
} {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const counters: Record<string, number> = {}
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = (init?.headers ?? {}) as Record<string, string>
    expect(headers['private-token']).toBe('tok')
    const path = u.replace('https://gitlab.com/api/v4', '')
    calls.push({
      method,
      url: path,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const key = `${method} ${path}`
    const route = routes[key]
    if (!route) throw new Error(`Unexpected request: ${key}`)
    let picked: FakeResponse
    if (Array.isArray(route)) {
      const i = counters[key] ?? 0
      counters[key] = i + 1
      picked = route[Math.min(i, route.length - 1)]!
    } else {
      picked = route
    }
    const status = picked.status ?? 200
    return new Response(picked.body === undefined ? null : JSON.stringify(picked.body), {
      status,
      headers: { 'content-type': 'application/json', ...picked.headers },
    })
  }) as unknown as typeof fetch

  return { fetchImpl, calls }
}

const connection: VcsConnectionRef = { provider: 'gitlab', connectionId: '42' }
const ref: VcsRepoRef = { repoId: '7', owner: 'group', repo: 'proj' }
const clock = { now: () => 1_000 }

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const { fetchImpl, calls } = fakeFetch(routes)
  const c = new FetchGitLabClient({
    tokenSource: new StaticGitLabTokenSource('tok'),
    clock,
    fetchImpl,
    // No real delay between rebase polls in tests.
    sleep: async () => {},
  })
  return { c, calls }
}

describe('FetchGitLabClient — neutral projections', () => {
  it('maps a project to the neutral repo projection', async () => {
    const { c } = client({
      'GET /projects/7': {
        body: {
          id: 7,
          path: 'proj',
          path_with_namespace: 'group/proj',
          default_branch: 'main',
          visibility: 'private',
        },
      },
    })
    const repo = await c.getRepo(connection, ref)
    expect(repo).toMatchObject({
      githubId: 7,
      installationId: 42,
      owner: 'group',
      name: 'proj',
      defaultBranch: 'main',
      private: true,
      syncedAt: 1_000,
    })
  })

  it('maps merge requests to neutral pull requests (open/merged/closed)', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests?state=all&order_by=updated_at&sort=desc&per_page=100': {
        body: [
          {
            id: 100,
            iid: 3,
            title: 'Add feature',
            state: 'opened',
            source_branch: 'feat',
            target_branch: 'main',
            sha: 'abc',
            author: { username: 'alice' },
            updated_at: '2024-01-01T00:00:00Z',
          },
          { id: 101, iid: 4, title: 'Done', state: 'merged', sha: 'def' },
        ],
      },
    })
    const { items } = await c.listPullRequests(connection, ref)
    expect(items[0]).toMatchObject({
      number: 3,
      githubId: 100,
      state: 'open',
      merged: false,
      headRef: 'feat',
      baseRef: 'main',
      headSha: 'abc',
      author: 'alice',
    })
    expect(items[1]).toMatchObject({ number: 4, state: 'closed', merged: true })
  })

  it('maps commit statuses to neutral check runs (success/failed/pending)', async () => {
    const { c } = client({
      'GET /projects/7/repository/commits/abc/statuses?per_page=100': {
        body: [
          { id: 1, sha: 'abc', name: 'build', status: 'success' },
          { id: 2, sha: 'abc', name: 'test', status: 'failed', target_url: 'http://ci/2' },
          { id: 3, sha: 'abc', name: 'deploy', status: 'running' },
        ],
      },
    })
    const { items } = await c.listCheckRuns(connection, ref, 'abc')
    expect(items[0]).toMatchObject({ name: 'build', status: 'completed', conclusion: 'success' })
    expect(items[1]).toMatchObject({
      name: 'test',
      status: 'completed',
      conclusion: 'failure',
      htmlUrl: 'http://ci/2',
    })
    expect(items[2]).toMatchObject({ name: 'deploy', status: 'in_progress', conclusion: null })
  })

  it('maps merge_status to the neutral mergeability triplet', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { merge_status: 'can_be_merged', sha: 'abc' },
      },
    })
    const m = await c.getPullRequestMergeability(connection, ref, 3)
    expect(m).toEqual({ mergeable: true, mergeableState: 'clean', headSha: 'abc' })
  })

  it('prefers detailed_merge_status and only maps a real conflict to dirty', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { detailed_merge_status: 'conflict', merge_status: 'cannot_be_merged', sha: 'x' },
      },
    })
    expect(await c.getPullRequestMergeability(connection, ref, 3)).toEqual({
      mergeable: false,
      mergeableState: 'dirty',
      headSha: 'x',
    })
  })

  it('does NOT report a non-conflict block (CI pending, legacy cannot_be_merged) as conflicted', async () => {
    const detailed = client({
      'GET /projects/7/merge_requests/3': {
        body: { detailed_merge_status: 'ci_still_running', sha: 'x' },
      },
    })
    // 'blocked' is neither 'dirty' (conflict) nor null/'unknown' (still computing), so the
    // conflicts gate classifies it as mergeable (nothing to resolve) instead of escalating.
    expect(await detailed.c.getPullRequestMergeability(connection, ref, 3)).toEqual({
      mergeable: false,
      mergeableState: 'blocked',
      headSha: 'x',
    })
    const legacy = client({
      'GET /projects/7/merge_requests/4': { body: { merge_status: 'cannot_be_merged', sha: 'y' } },
    })
    expect(await legacy.c.getPullRequestMergeability(connection, ref, 4)).toEqual({
      mergeable: false,
      mergeableState: 'blocked',
      headSha: 'y',
    })
  })

  it('commitFiles pins the parent via start_sha when baseSha is given', async () => {
    const { c, calls } = client({
      'GET /projects/7/repository/files/a.txt?ref=base1': { status: 404 },
      'POST /projects/7/repository/commits': { body: { id: 'newsha' } },
    })
    const res = await c.commitFiles(connection, ref, {
      branch: 'feat',
      message: 'm',
      files: [{ path: 'a.txt', content: 'hi' }],
      baseSha: 'base1',
    })
    expect(res).toEqual({ sha: 'newsha' })
    const commit = calls.find((x) => x.method === 'POST')!
    expect(commit.body).toMatchObject({ branch: 'feat', start_sha: 'base1' })
    expect((commit.body as { actions: { action: string }[] }).actions[0]!.action).toBe('create')
  })

  it('reports push access from the project access level', async () => {
    const { c } = client({
      'GET /projects/7': { body: { id: 7, permissions: { project_access: { access_level: 30 } } } },
    })
    expect(await c.canPush(connection, ref)).toBe(true)
  })

  it('opens a merge request via the MR endpoint', async () => {
    const { c, calls } = client({
      'POST /projects/7/merge_requests': {
        body: {
          id: 100,
          iid: 5,
          title: 'PR',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
        },
      },
    })
    const pr = await c.openPullRequest(connection, ref, { title: 'PR', head: 'feat', base: 'main' })
    expect(pr).toMatchObject({ number: 5, state: 'open' })
    expect(calls[0]!.body).toMatchObject({
      source_branch: 'feat',
      target_branch: 'main',
      title: 'PR',
    })
  })

  it('is idempotent: a 409 (MR already exists) resolves to the existing open MR', async () => {
    // GitLab rejects a duplicate MR for the same source/target branch with a 409; the client
    // must fall back to a lookup so a durable-driver replay of a committing post-op is safe.
    const { c, calls } = client({
      'POST /projects/7/merge_requests': {
        status: 409,
        body: { message: ['Another open merge request already exists for this source branch: !5'] },
      },
      'GET /projects/7/merge_requests?state=opened&source_branch=feat&target_branch=main&per_page=1':
        {
          body: [
            {
              id: 100,
              iid: 5,
              title: 'PR',
              state: 'opened',
              source_branch: 'feat',
              target_branch: 'main',
              web_url: 'https://gitlab.com/group/proj/-/merge_requests/5',
            },
          ],
        },
    })
    const pr = await c.openPullRequest(connection, ref, { title: 'PR', head: 'feat', base: 'main' })
    expect(pr).toMatchObject({ number: 5, state: 'open' })
    expect(pr.url).toBe('https://gitlab.com/group/proj/-/merge_requests/5')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[1]!.method).toBe('GET')
  })

  it('follows Link pagination', async () => {
    const { c } = client({
      'GET /projects?membership=true&per_page=100': {
        body: [{ id: 1, path: 'a', path_with_namespace: 'g/a' }],
        headers: {
          link: '<https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=2>; rel="next"',
        },
      },
      'GET /projects?membership=true&per_page=100&page=2': {
        body: [{ id: 2, path: 'b', path_with_namespace: 'g/b' }],
      },
    })
    const { items } = await c.listRepos(connection)
    expect(items.map((r) => r.githubId)).toEqual([1, 2])
  })

  it('mergeBranch is explicitly unsupported on GitLab', async () => {
    const { c } = client({})
    await expect(c.mergeBranch(connection, ref, { base: 'main', head: 'feat' })).rejects.toThrow(
      /not supported on GitLab/,
    )
  })
})

describe('FetchGitLabClient — reviews, rebase and tree reads', () => {
  it('reads the PR base ref and requested reviewers from the MR detail', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { target_branch: 'release', reviewers: [{ username: 'bob' }, { username: 'cara' }] },
      },
    })
    expect(await c.getPullRequestBaseRef(connection, ref, 3)).toBe('release')
    expect(await c.listRequestedReviewers(connection, ref, 3)).toEqual(['bob', 'cara'])
  })

  it('reads the MR head ref and head sha, preferring diff_refs over the stale top-level sha', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { source_branch: 'feat/x', sha: 'stale', diff_refs: { head_sha: 'fresh' } },
      },
    })
    expect(await c.getPullRequestHeadRef(connection, ref, 3)).toBe('feat/x')
    expect(await c.getPullRequestHeadSha(connection, ref, 3)).toBe('fresh')
  })

  it('degrades every single-MR accessor to null on a 404 but propagates other failures', async () => {
    const missing = client({ 'GET /projects/7/merge_requests/3': { status: 404 } })
    expect(await missing.c.getPullRequestBaseRef(connection, ref, 3)).toBeNull()
    expect(await missing.c.getPullRequestHeadRef(connection, ref, 3)).toBeNull()
    expect(await missing.c.getPullRequestHeadSha(connection, ref, 3)).toBeNull()

    // A 500 is "could not be read", NOT "does not exist" — it must stay distinguishable.
    const broken = client({ 'GET /projects/7/merge_requests/3': { status: 500 } })
    await expect(broken.c.getPullRequestHeadSha(connection, ref, 3)).rejects.toThrow()
  })

  it('maps MR diffs to neutral changed files, counting lines off the hunk', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3/diffs?per_page=100': {
        body: [
          {
            old_path: 'src/a.ts',
            new_path: 'src/a.ts',
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx\n+added one\n+added two\n-removed one\n',
          },
          { old_path: 'src/new.ts', new_path: 'src/new.ts', new_file: true, diff: '+one\n' },
          { old_path: 'old.ts', new_path: 'moved.ts', renamed_file: true, diff: '' },
          { old_path: 'gone.ts', new_path: 'gone.ts', deleted_file: true, diff: '-x\n' },
          // A file GitLab truncated: no hunk to count, so zeros and a null patch — the same
          // shape GitHub reports for a binary/oversized file.
          { old_path: 'big.bin', new_path: 'big.bin', too_large: true },
        ],
      },
    })
    expect(await c.listChangedFiles(connection, ref, 3)).toEqual([
      {
        path: 'src/a.ts',
        previousPath: null,
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch:
          '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n ctx\n+added one\n+added two\n-removed one\n',
      },
      {
        path: 'src/new.ts',
        previousPath: null,
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '+one\n',
      },
      {
        path: 'moved.ts',
        previousPath: 'old.ts',
        status: 'renamed',
        additions: 0,
        deletions: 0,
        patch: null,
      },
      {
        path: 'gone.ts',
        previousPath: null,
        status: 'removed',
        additions: 0,
        deletions: 1,
        patch: '-x\n',
      },
      {
        path: 'big.bin',
        previousPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        patch: null,
      },
    ])
  })

  it('posts a review as per-comment diff discussions plus a summary note', async () => {
    const { c, calls } = client({
      'GET /projects/7/merge_requests/3': {
        body: { diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' } },
      },
      'POST /projects/7/merge_requests/3/discussions': { body: { id: 'd' } },
      'POST /projects/7/merge_requests/3/notes': { body: { id: 1 } },
    })
    const result = await c.createReview(connection, ref, 3, {
      event: 'COMMENT',
      body: 'Summary',
      comments: [
        { path: 'src/a.ts', line: 12, body: 'fix this' },
        { path: 'src/b.ts', line: 4, side: 'LEFT', body: 'removed line' },
      ],
    })
    expect(result).toEqual({
      comments: [{ posted: true }, { posted: true }],
      bodyPosted: true,
      bodyError: undefined,
    })
    const discussions = calls.filter((call) => call.url.endsWith('/discussions'))
    expect(discussions).toHaveLength(2)
    // A RIGHT-side (default) finding anchors on `new_line`; a LEFT-side one on `old_line`.
    expect(discussions[0]?.body).toMatchObject({
      body: 'fix this',
      position: {
        position_type: 'text',
        base_sha: 'b1',
        start_sha: 's1',
        head_sha: 'h1',
        new_path: 'src/a.ts',
        old_path: 'src/a.ts',
        new_line: '12',
      },
    })
    const leftSide = discussions[1]?.body as { position: Record<string, unknown> } | undefined
    expect(leftSide).toMatchObject({ position: { old_line: '4' } })
    expect(leftSide?.position.new_line).toBeUndefined()
  })

  it('reports a partial post rather than throwing when one comment cannot anchor', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': {
        body: { diff_refs: { base_sha: 'b1', head_sha: 'h1' } },
      },
      // First discussion lands, second is rejected (line outside the diff).
      'POST /projects/7/merge_requests/3/discussions': [{ body: { id: 'd' } }, { status: 400 }],
      'POST /projects/7/merge_requests/3/notes': { body: { id: 1 } },
    })
    const result = await c.createReview(connection, ref, 3, {
      event: 'COMMENT',
      body: 'Summary',
      comments: [
        { path: 'a.ts', line: 1, body: 'ok' },
        { path: 'b.ts', line: 999, body: 'out of diff' },
      ],
    })
    expect(result.comments[0]).toEqual({ posted: true })
    expect(result.comments[1]?.posted).toBe(false)
    expect(result.comments[1]?.error).toBeTruthy()
    // The summary still lands, so the un-anchored finding is not silently lost.
    expect(result.bodyPosted).toBe(true)
  })

  it('reports every comment failed when the MR has no diff refs to anchor against', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3': { body: { diff_refs: null } },
    })
    const result = await c.createReview(connection, ref, 3, {
      event: 'COMMENT',
      body: 'Summary',
      comments: [{ path: 'a.ts', line: 1, body: 'x' }],
    })
    expect(result.comments).toEqual([
      { posted: false, error: expect.stringContaining('diff refs') },
    ])
    expect(result.bodyPosted).toBe(false)
    expect(result.bodyError).toContain('diff refs')
  })

  it('maps GitLab approvals to APPROVED reviews + the required count', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3/approvals': {
        body: { approved_by: [{ user: { username: 'dee' } }, { user: { username: 'eli' } }] },
      },
      'GET /projects/7/approvals': { body: { approvals_before_merge: 2 } },
    })
    expect(await c.listPullRequestReviews(connection, ref, 3)).toEqual([
      { author: 'dee', state: 'APPROVED', body: '', submittedAt: 0, commitId: null },
      { author: 'eli', state: 'APPROVED', body: '', submittedAt: 0, commitId: null },
    ])
    expect(await c.getRequiredApprovingReviewCount(connection, ref, 'main')).toBe(2)
  })

  it('defaults the required approval count to 1 when project approvals are unreadable', async () => {
    const { c } = client({ 'GET /projects/7/approvals': { status: 403 } })
    expect(await c.getRequiredApprovingReviewCount(connection, ref, 'main')).toBe(1)
  })

  it('maps resolvable discussions to review threads (MR iid carried in the thread id)', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3/discussions?per_page=100': {
        body: [
          // A plain conversation discussion (not resolvable) is NOT a review thread.
          { id: 'chat', notes: [{ id: 1, body: 'hi', author: { username: 'x' } }] },
          {
            id: 'd1',
            notes: [
              {
                id: 2,
                body: 'please fix',
                resolvable: true,
                resolved: false,
                author: { username: 'rev' },
                created_at: '2024-01-01T00:00:00Z',
                position: { new_path: 'src/a.ts', new_line: 12 },
              },
            ],
          },
        ],
      },
    })
    const threads = await c.listReviewThreads(connection, ref, 3)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({
      id: '3:d1',
      isResolved: false,
      path: 'src/a.ts',
      line: 12,
      comments: [
        { author: 'rev', body: 'please fix', createdAt: Date.parse('2024-01-01T00:00:00Z') },
      ],
    })
  })

  it('resolves and replies to a thread against the MR + discussion the thread id encodes', async () => {
    const { c, calls } = client({
      'PUT /projects/7/merge_requests/3/discussions/d1?resolved=true': { status: 200 },
      'POST /projects/7/merge_requests/3/discussions/d1/notes?body=ok': { status: 201 },
    })
    await c.resolveReviewThread(connection, ref, '3:d1')
    await c.replyToReviewThread(connection, ref, '3:d1', 'ok')
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      'PUT /projects/7/merge_requests/3/discussions/d1?resolved=true',
      'POST /projects/7/merge_requests/3/discussions/d1/notes?body=ok',
    ])
  })

  it('lists only standalone conversation comments (drops system + threaded notes)', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3/notes?sort=asc&order_by=created_at&per_page=100': {
        body: [
          { id: 1, body: 'hello', author: { username: 'p' }, created_at: '2024-01-01T00:00:00Z' },
          { id: 2, body: 'assigned', system: true, author: { username: 'p' } },
          { id: 3, body: 'diff note', type: 'DiffNote', author: { username: 'p' } },
        ],
      },
    })
    const comments = await c.listIssueComments(connection, ref, 3)
    expect(comments).toEqual([
      { id: '1', author: 'p', body: 'hello', createdAt: Date.parse('2024-01-01T00:00:00Z') },
    ])
  })

  it('rebasePullRequest polls until the async rebase finishes, then reports merged once the branch advanced', async () => {
    const { c, calls } = client({
      // The before-read (head sha BEFORE the rebase).
      'GET /projects/7/merge_requests/3': { body: { diff_refs: { head_sha: 'old' } } },
      'PUT /projects/7/merge_requests/3/rebase': { status: 202, body: {} },
      // The first poll catches the job still running; the second sees it done with an advanced head.
      'GET /projects/7/merge_requests/3?include_rebase_in_progress=true': [
        { body: { rebase_in_progress: true } },
        { body: { rebase_in_progress: false, diff_refs: { head_sha: 'new' }, merge_error: null } },
      ],
    })
    expect(await c.rebasePullRequest(connection, ref, 3)).toBe('merged')
    // It actually waited for the in-progress poll before concluding (two status reads).
    const polls = calls.filter((x) =>
      x.url.startsWith('/projects/7/merge_requests/3?include_rebase_in_progress=true'),
    )
    expect(polls).toHaveLength(2)
  })

  it('rebasePullRequest reports conflict when the branch did not advance and merge_error is set', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/4': { body: { diff_refs: { head_sha: 'old' } } },
      'PUT /projects/7/merge_requests/4/rebase': { status: 202, body: {} },
      'GET /projects/7/merge_requests/4?include_rebase_in_progress=true': {
        body: {
          rebase_in_progress: false,
          diff_refs: { head_sha: 'old' },
          merge_error: 'conflict',
        },
      },
    })
    expect(await c.rebasePullRequest(connection, ref, 4)).toBe('conflict')
  })

  it('rebasePullRequest ignores a STALE merge_error once the branch actually advanced', async () => {
    // merge_error is a persisted MR field shared with merge attempts; a leftover value must not
    // be read as a fresh rebase conflict when the rebase plainly advanced the branch.
    const { c } = client({
      'GET /projects/7/merge_requests/5': { body: { diff_refs: { head_sha: 'old' } } },
      'PUT /projects/7/merge_requests/5/rebase': { status: 202, body: {} },
      'GET /projects/7/merge_requests/5?include_rebase_in_progress=true': {
        body: {
          rebase_in_progress: false,
          diff_refs: { head_sha: 'new' },
          merge_error: 'stale error from a prior merge attempt',
        },
      },
    })
    expect(await c.rebasePullRequest(connection, ref, 5)).toBe('merged')
  })

  it('rebasePullRequest treats an already-up-to-date branch (no advance, no error) as merged', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/6': { body: { diff_refs: { head_sha: 'same' } } },
      'PUT /projects/7/merge_requests/6/rebase': { status: 202, body: {} },
      'GET /projects/7/merge_requests/6?include_rebase_in_progress=true': {
        body: { rebase_in_progress: false, diff_refs: { head_sha: 'same' }, merge_error: null },
      },
    })
    expect(await c.rebasePullRequest(connection, ref, 6)).toBe('merged')
  })

  it('prefers the MR-level approvals_required over the project default when the MR number is known', async () => {
    const { c } = client({
      // MR-level effective requirement (accounts for the rule on this MR's target branch).
      'GET /projects/7/merge_requests/3/approvals': { body: { approvals_required: 2 } },
    })
    expect(await c.getRequiredApprovingReviewCount(connection, ref, 'main', 3)).toBe(2)
  })

  it('falls back to the project approvals_before_merge when the MR-level count is unreadable', async () => {
    const { c } = client({
      'GET /projects/7/merge_requests/3/approvals': { status: 404 },
      'GET /projects/7/approvals': { body: { approvals_before_merge: 1 } },
    })
    expect(await c.getRequiredApprovingReviewCount(connection, ref, 'main', 3)).toBe(1)
  })

  it('listTree reads the whole tree recursively, normalises tree/blob to dir/file, drops submodules', async () => {
    const { c, calls } = client({
      'GET /projects/7/repository/tree?per_page=100&recursive=true&ref=main': {
        body: [
          { path: 'README.md', name: 'README.md', type: 'blob', id: 'a' },
          { path: 'docs', name: 'docs', type: 'tree', id: 'b' },
          { path: 'docs/architecture.md', name: 'architecture.md', type: 'blob', id: 'c' },
          // A git submodule — GitLab reports these as `commit`; they have no browsable
          // content here, so (like FetchGitHubClient) they must be dropped.
          { path: 'vendor/lib', name: 'lib', type: 'commit', id: 'd' },
        ],
      },
    })
    const entries = await c.listTree(connection, ref, 'main')
    expect(calls[0]!.url).toBe('/projects/7/repository/tree?per_page=100&recursive=true&ref=main')
    expect(entries).toEqual([
      { path: 'README.md', name: 'README.md', type: 'file', sha: 'a' },
      { path: 'docs', name: 'docs', type: 'dir', sha: 'b' },
      { path: 'docs/architecture.md', name: 'architecture.md', type: 'file', sha: 'c' },
    ])
  })

  it('listTree returns [] for an unknown ref / empty repo (404)', async () => {
    const { c } = client({
      'GET /projects/7/repository/tree?per_page=100&recursive=true&ref=nope': { status: 404 },
    })
    expect(await c.listTree(connection, ref, 'nope')).toEqual([])
  })
})

describe('GitLab webhook', () => {
  it('verifies the X-Gitlab-Token header constant-time', async () => {
    const verifier = new GitLabWebhookVerifier('s3cret')
    expect(await verifier.verify(new ArrayBuffer(0), 's3cret')).toBe(true)
    expect(await verifier.verify(new ArrayBuffer(0), 'wrong')).toBe(false)
    expect(await verifier.verify(new ArrayBuffer(0), null)).toBe(false)
  })

  it('maps a Merge Request Hook to a neutral pull-request event', () => {
    const mapper = new GitLabWebhookMapper(clock)
    const event = mapper.map(connection, {
      eventName: 'Merge Request Hook',
      payload: {
        project: { id: 7, path_with_namespace: 'group/proj' },
        object_attributes: {
          id: 100,
          iid: 3,
          title: 'X',
          state: 'opened',
          source_branch: 'feat',
          target_branch: 'main',
          last_commit: { id: 'abc' },
        },
        user: { username: 'alice' },
      },
    })
    expect(event).toMatchObject({
      kind: 'pull-request',
      connection,
      repo: { repoId: '7', owner: 'group', repo: 'proj' },
      pullRequest: { number: 3, state: 'open', headSha: 'abc', author: 'alice' },
    })
  })

  it('maps a Pipeline Hook to a neutral ci-status event', () => {
    const mapper = new GitLabWebhookMapper(clock)
    const event = mapper.map(connection, {
      eventName: 'Pipeline Hook',
      payload: {
        project: { id: 7, path_with_namespace: 'group/proj' },
        object_attributes: { id: 9, sha: 'abc', status: 'failed' },
      },
    })
    expect(event).toMatchObject({
      kind: 'ci-status',
      checkRun: { status: 'completed', conclusion: 'failure', headSha: 'abc' },
    })
  })
})

describe('registerGitLab', () => {
  it('registers a resolvable gitlab provider bundle', () => {
    const registry = defaultVcsRegistry()
    registerGitLab(registry, {
      tokenSource: new StaticGitLabTokenSource('tok'),
      clock,
      webhookSecret: 's',
    })
    const bundle = registry.resolve(connection)
    expect(bundle.provider).toBe('gitlab')
    expect(bundle.client).toBeInstanceOf(FetchGitLabClient)
    expect(bundle.webhookMapper).toBeInstanceOf(GitLabWebhookMapper)
    expect(bundle.webhookVerifier).toBeInstanceOf(GitLabWebhookVerifier)
    expect(bundle.provisioning).toBeDefined()
  })
})
