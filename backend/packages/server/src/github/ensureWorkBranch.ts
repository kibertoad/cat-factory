// Ensure a per-task WORK BRANCH exists on the remote before any agent in a pipeline
// touches the repo. Every container agent for a task operates on one shared branch
// (`cat-factory/<blockId>`): the writers (spec-writer, coder, …) commit to it and the
// read-only design agents (architect, analysis) clone it so they read what the earlier
// writers already committed (e.g. the spec-writer's in-repo `spec/`). Creating the
// branch up front is a purely MECHANICAL step — every task eventually needs the branch —
// so we do it programmatically rather than relying on whichever agent writes first.
//
// Implemented as two GitHub REST calls (resolve the base tip, create the ref) using the
// installation token the facade already mints. It deliberately does NOT go through the
// `GitHubClient` port: the port exposes no single-ref read (only paged `listBranches`,
// which can't reliably surface an arbitrary base branch), whereas `GET /git/ref/heads`
// resolves the tip in one call. Idempotent: a branch that already exists (an earlier
// step or run created it) answers 422 and is treated as success — we never reset or
// move an existing branch. Best-effort: any failure returns `false` so the caller can
// fall back (read-only agents to the base branch; writers create-or-resume themselves).

export interface EnsureWorkBranchInput {
  /** GitHub REST base, e.g. `https://api.github.com` (GitHub Enterprise overrides it). */
  apiBase?: string
  /** A short-lived installation token authorised for the repo. */
  token: string
  owner: string
  name: string
  /** The branch the work branch forks from (the repo's base). */
  baseBranch: string
  /** The work branch to ensure, e.g. `cat-factory/<blockId>`. */
  branch: string
}

const GITHUB_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'cat-factory-server',
  'x-github-api-version': '2022-11-28',
})

/**
 * Create `branch` from `baseBranch`'s tip if it does not already exist. Returns whether
 * the work branch is present on the remote afterwards (created now, or already there).
 */
export async function ensureWorkBranchViaRest(input: EnsureWorkBranchInput): Promise<boolean> {
  const apiBase = (input.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const repoPath = `${apiBase}/repos/${input.owner}/${input.name}`
  try {
    // Resolve the base branch tip the work branch should fork from.
    const baseRes = await fetch(
      `${repoPath}/git/ref/heads/${encodeURIComponent(input.baseBranch)}`,
      { headers: GITHUB_HEADERS(input.token) },
    )
    if (!baseRes.ok) return false
    const baseJson = (await baseRes.json().catch(() => null)) as {
      object?: { sha?: string }
    } | null
    const sha = baseJson?.object?.sha
    if (!sha) return false

    const createRes = await fetch(`${repoPath}/git/refs`, {
      method: 'POST',
      headers: { ...GITHUB_HEADERS(input.token), 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha }),
    })
    // 201 created, or 422 "Reference already exists" — both mean the branch is present.
    return createRes.ok || createRes.status === 422
  } catch {
    return false
  }
}
