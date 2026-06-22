// Ensure a per-task WORK BRANCH exists on the remote before any agent in a pipeline
// touches the repo. Every container agent for a task operates on one shared branch
// (`cat-factory/<blockId>`): the writers (spec-writer, coder, …) commit to it and the
// read-only design agents (architect, analysis) clone it so they read what the earlier
// writers already committed (e.g. the spec-writer's in-repo `spec/`).
//
// Two intents share this one helper:
//   - WRITERS create the branch up front (a purely mechanical step — every writer
//     eventually needs the branch — so we do it programmatically rather than relying on
//     whichever agent writes first).
//   - READ-ONLY agents only PROBE for it: they never write, so when the branch does not
//     yet exist there is nothing on it to read and they must fall back to base. Probing
//     (rather than creating) keeps a code-less pipeline from littering the repo with an
//     empty `cat-factory/<blockId>` ref that no PR ever uses.
//
// Implemented as plain GitHub REST calls using the installation token the facade already
// mints. It deliberately does NOT go through the `GitHubClient` port: the port exposes no
// single-ref read (only paged `listBranches`, which can't reliably surface an arbitrary
// ref), whereas `GET /git/ref/heads/<branch>` resolves a ref in one call. It probes the
// work branch FIRST, so an already-present branch is reported ready in a single call
// regardless of whether the base ref can be resolved, and `create` never issues a
// redundant write. Idempotent: a create that races another and answers 422 "already
// exists" is treated as success — we never reset or move an existing branch. Best-effort:
// every failure path returns `false` (so callers fall back) but logs a warning first, so
// a silent degradation back to the base branch is observable in telemetry rather than
// invisible.

import { logger } from '../observability/logger.js'

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
  /**
   * Whether to CREATE the work branch from base when it does not yet exist. Writers pass
   * `true` (they need the branch); read-only agents pass `false` to PROBE only — they
   * never write, so a missing branch means "nothing to read, use base", and creating it
   * would only orphan an empty ref. Defaults to `true`.
   */
  create?: boolean
}

const GITHUB_HEADERS = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'cat-factory-server',
  'x-github-api-version': '2022-11-28',
})

/**
 * Encode a branch name for use in a `/git/ref/heads/<branch>` path. A branch can contain
 * slashes (`feature/x`), which are real path separators in the ref API, so encode each
 * segment individually rather than the whole name (which would turn `/` into `%2F` and
 * break the lookup).
 */
function encodeBranchPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * Ensure `branch` is present on the remote. Writers (`create !== false`) create it from
 * `baseBranch`'s tip when absent; read-only callers (`create: false`) only report whether
 * it already exists. Returns whether the work branch is present afterwards.
 */
export async function ensureWorkBranchViaRest(input: EnsureWorkBranchInput): Promise<boolean> {
  const apiBase = (input.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  const repoPath = `${apiBase}/repos/${input.owner}/${input.name}`
  const create = input.create !== false
  try {
    // Probe the work branch first: if it already exists (an earlier step/run created it),
    // it is ready in a single call — independent of whether the base ref resolves.
    const probeRes = await fetch(`${repoPath}/git/ref/heads/${encodeBranchPath(input.branch)}`, {
      headers: GITHUB_HEADERS(input.token),
    })
    if (probeRes.ok) return true
    if (probeRes.status !== 404) {
      logger.warn(
        { branch: input.branch, status: probeRes.status },
        'ensureWorkBranch: unexpected status probing work branch',
      )
    }

    // Not present. Read-only callers stop here (a missing branch ⇒ use base); only writers
    // create it.
    if (!create) return false

    // Resolve the base branch tip the work branch should fork from.
    const baseRes = await fetch(`${repoPath}/git/ref/heads/${encodeBranchPath(input.baseBranch)}`, {
      headers: GITHUB_HEADERS(input.token),
    })
    if (!baseRes.ok) {
      logger.warn(
        { baseBranch: input.baseBranch, status: baseRes.status },
        'ensureWorkBranch: could not resolve base branch tip',
      )
      return false
    }
    const baseJson = (await baseRes.json().catch(() => null)) as {
      object?: { sha?: string }
    } | null
    const sha = baseJson?.object?.sha
    if (!sha) {
      logger.warn({ baseBranch: input.baseBranch }, 'ensureWorkBranch: base ref had no sha')
      return false
    }

    const createRes = await fetch(`${repoPath}/git/refs`, {
      method: 'POST',
      headers: { ...GITHUB_HEADERS(input.token), 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha }),
    })
    // 201 created, or 422 "Reference already exists" (a race) — both mean it is present.
    if (createRes.ok || createRes.status === 422) return true
    logger.warn(
      { branch: input.branch, status: createRes.status },
      'ensureWorkBranch: failed to create work branch',
    )
    return false
  } catch (err) {
    logger.warn({ branch: input.branch, err }, 'ensureWorkBranch: request failed')
    return false
  }
}
