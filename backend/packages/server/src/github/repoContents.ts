import { VcsBlobTooLargeError } from '@cat-factory/kernel'
import type {
  GitHubRepoRef,
  RepoContentEntry,
  RepoEntry,
  RepoFileContent,
  RepoTreeListing,
} from '@cat-factory/kernel'
import {
  GITHUB_CONTENTS_MAX_BYTES,
  decodeRepoFileBase64,
  githubApiStatus,
  isGitHubBlobTooLarge,
} from './githubHttpHelpers.js'

// The repository-CONTENTS reads (`/contents`, `/git/trees`), extracted out of `FetchGitHubClient`
// along the same seam as `reviewPosting.ts` and `branchProtection.ts`: the client is at its size
// budget, and these four are one cohesive concern that talks to GitHub only through the injected
// request executor, so they stay independently testable and the client keeps four thin delegates.
//
// What makes them a concern rather than four unrelated methods is the classification they share, and
// it is the whole substance of the module. This endpoint answers facts that its STATUS cannot tell
// apart, and each pair costs something different when confused:
//
//   - **A 404 is an ANSWER here**, not a failure: an empty repository has no default branch, so the
//     contents endpoint 404s for the root, and an absent path 404s the same way. Every read below
//     degrades to "nothing there" and lets anything else through.
//   - **An over-limit blob is not a rejected credential**, though GitHub reports it as the same
//     `403`. Named as itself, or a caller is told to replace a token that works perfectly.
//   - **Bytes that are not UTF-8 are not text**, though a non-fatal decode answers a string either
//     way. Reported, so a byte-exact reader can refuse rather than compare mojibake.

/** The narrow slice of `FetchGitHubClient.request` these reads need. */
export type ContentsRequest = (
  path: string,
  opts: { installationId: number },
) => Promise<{ json: unknown }>

/** The repo root's entries, or `[]` for a repository with no commits yet. */
export async function readRootEntries(
  request: ContentsRequest,
  installationId: number,
  ref: GitHubRepoRef,
): Promise<RepoEntry[]> {
  let json: unknown
  try {
    ;({ json } = await request(`/repos/${ref.owner}/${ref.repo}/contents/`, { installationId }))
  } catch (err) {
    // An empty repository has no default branch, so the contents endpoint 404s. That's the signal we
    // want — treat it as "no entries", not an error.
    if (githubApiStatus(err) === 404) return []
    throw err
  }
  const entries = Array.isArray(json)
    ? (json as Array<{ path?: string; name?: string; type?: string }>)
    : []
  return entries.map((e) => ({ path: e.path ?? e.name ?? '', type: e.type ?? 'file' }))
}

/** One directory's entries on `gitRef`, or `[]` for a missing path (mirrors {@link readRootEntries}). */
export async function readDirectory(
  request: ContentsRequest,
  installationId: number,
  ref: GitHubRepoRef,
  path: string,
  gitRef?: string,
): Promise<RepoContentEntry[]> {
  const clean = path.replace(/^\/+|\/+$/g, '')
  const query = gitRef ? `?ref=${encodeURIComponent(gitRef)}` : ''
  let json: unknown
  try {
    ;({ json } = await request(`/repos/${ref.owner}/${ref.repo}/contents/${clean}${query}`, {
      installationId,
    }))
  } catch (err) {
    if (githubApiStatus(err) === 404) return []
    throw err
  }
  // A directory returns an array; a single file returns an object — coerce both.
  const arr = Array.isArray(json) ? json : [json]
  return (
    arr as Array<{ path?: string; name?: string; type?: string; sha?: string; size?: number }>
  ).map((e) => ({
    path: e.path ?? e.name ?? '',
    name: e.name ?? (e.path ?? '').split('/').pop() ?? '',
    type: e.type ?? 'file',
    sha: e.sha ?? '',
    ...(typeof e.size === 'number' ? { size: e.size } : {}),
  }))
}

/**
 * The WHOLE tree in one recursive git-trees read, so file search never walks the contents API
 * directory by directory. `HEAD` resolves to the repository's default branch.
 *
 * The endpoint's own `truncated` flag rides back on the listing rather than being dropped here.
 * GitHub cuts the response off past its entry/size ceiling, and a caller building a MANIFEST out
 * of the result (the bug-fishing survey partitioning a codebase into territories) would otherwise
 * state a partial tree as the whole codebase: every path the cut removed would read as a file
 * that does not exist, which is exactly the "absent and zero render the same" failure a coverage
 * record exists to prevent.
 */
export async function readTree(
  request: ContentsRequest,
  installationId: number,
  ref: GitHubRepoRef,
  gitRef?: string,
): Promise<RepoTreeListing> {
  const treeRef = encodeURIComponent(gitRef && gitRef !== 'HEAD' ? gitRef : 'HEAD')
  let json: unknown
  try {
    ;({ json } = await request(`/repos/${ref.owner}/${ref.repo}/git/trees/${treeRef}?recursive=1`, {
      installationId,
    }))
  } catch (err) {
    // Empty repo / unknown ref → no entries (mirrors readDirectory).
    if (githubApiStatus(err) === 404) return { entries: [], truncated: false }
    throw err
  }
  const body = json as {
    tree?: Array<{ path?: string; type?: string; sha?: string; size?: number }>
    truncated?: boolean
  }
  const tree = Array.isArray(body.tree) ? body.tree : []
  // GitHub git-tree `type` is `blob` | `tree` | `commit` (submodule); normalise to the neutral
  // file/dir vocabulary and drop submodules (they have no browsable content here).
  const entries = tree
    .filter((e) => e.type === 'blob' || e.type === 'tree')
    .map((e) => ({
      path: e.path ?? '',
      name: (e.path ?? '').split('/').pop() ?? '',
      type: e.type === 'tree' ? 'dir' : 'file',
      sha: e.sha ?? '',
      ...(typeof e.size === 'number' ? { size: e.size } : {}),
    }))
  return { entries, truncated: body.truncated === true }
}

/**
 * One file's content and blob sha on `gitRef`, or null when the path is absent.
 *
 * The two refusals this endpoint states badly are translated HERE, because this is the only layer
 * that knows the contents API's own ceiling:
 *
 *   - An over-limit blob arrives EITHER as a `403` whose body says `too_large`, or as a `200` with
 *     an empty body and `encoding: 'none'`. Left bare, the first reaches a consumer as the same fact
 *     as a revoked token (the public file read turned it into a `503` telling an operator to re-mint
 *     a credential that worked), and the second as a file that is genuinely empty.
 *   - A file whose bytes are not UTF-8 rides back with `lossy: true` rather than pretending the
 *     replacement characters are its content.
 */
export async function readFileContent(
  request: ContentsRequest,
  installationId: number,
  ref: GitHubRepoRef,
  path: string,
  gitRef?: string,
): Promise<RepoFileContent | null> {
  const clean = path.replace(/^\/+/, '')
  const query = gitRef ? `?ref=${encodeURIComponent(gitRef)}` : ''
  let json: unknown
  try {
    ;({ json } = await request(`/repos/${ref.owner}/${ref.repo}/contents/${clean}${query}`, {
      installationId,
    }))
  } catch (err) {
    if (githubApiStatus(err) === 404) return null
    if (isGitHubBlobTooLarge(err))
      throw new VcsBlobTooLargeError('github', GITHUB_CONTENTS_MAX_BYTES)
    throw err
  }
  const file = json as { type?: string; content?: string; encoding?: string; sha?: string }
  if (file.type !== 'file' || typeof file.content !== 'string') return null
  if (file.encoding === 'none') throw new VcsBlobTooLargeError('github', GITHUB_CONTENTS_MAX_BYTES)
  const { content, lossy } =
    file.encoding === 'base64'
      ? decodeRepoFileBase64(file.content)
      : { content: file.content, lossy: false }
  return { content, sha: file.sha ?? '', ...(lossy ? { lossy: true } : {}) }
}

/**
 * The sha of the most recent commit that touched `path` on `gitRef`, or null when there is none.
 *
 * Here beside the other contents reads rather than on the client, for the reason that file's
 * header states: it is at its size budget, and a read that talks only to the commits endpoint has
 * nothing client-specific in it.
 */
export async function readLatestCommitSha(
  request: ContentsRequest,
  installationId: number,
  ref: GitHubRepoRef,
  path: string,
  gitRef?: string,
): Promise<string | null> {
  const clean = path.replace(/^\/+|\/+$/g, '')
  const params = new URLSearchParams({ per_page: '1' })
  if (clean) params.set('path', clean)
  // The commits list endpoint does not accept `HEAD`; omitting `sha` defaults to the repo's
  // default branch, which is exactly what a `HEAD`/absent gitRef means here.
  if (gitRef && gitRef !== 'HEAD') params.set('sha', gitRef)
  let json: unknown
  try {
    ;({ json } = await request(`/repos/${ref.owner}/${ref.repo}/commits?${params.toString()}`, {
      installationId,
    }))
  } catch (err) {
    // Empty repo / missing path / unknown ref → no commit to pin against.
    if (githubApiStatus(err) === 404) return null
    throw err
  }
  const commits = Array.isArray(json) ? (json as Array<{ sha?: string }>) : []
  return commits[0]?.sha ?? null
}
