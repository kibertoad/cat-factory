import type { TaskSourceDescriptor } from '@cat-factory/kernel'

// GitHub-issues task-source pure logic, kept out of the worker so it is
// unit-testable without a live API: parsing an issue reference out of user input
// and round-tripping the `owner/repo#number` external id the provider stores. The
// fetch itself lives in the worker's GitHubIssuesProvider, which reuses the
// workspace's installed GitHub App (so this source needs no credentials of its
// own — unlike Jira). GitHub issue bodies are already Markdown, so there is no
// body-conversion step here.

/**
 * What the connect UI renders. GitHub issues piggyback on the workspace's
 * existing GitHub App installation, so there are NO credential fields — the
 * connect form is just a confirmation, and `normalizeConnection` accepts an empty
 * bag.
 */
export const GITHUB_ISSUES_DESCRIPTOR: TaskSourceDescriptor = {
  source: 'github',
  label: 'GitHub Issues',
  icon: 'i-lucide-github',
  credentialFields: [],
  refLabel: 'Issue URL or owner/repo#number',
  refPlaceholder: 'octo/repo#123  or  https://github.com/octo/repo/issues/123',
}

// A GitHub owner/repo segment: letters, digits, '.', '_' and '-'. Deliberately
// permissive but bounded so a stray path can't masquerade as a ref.
const SEG = '[A-Za-z0-9._-]+'

/**
 * Resolve a GitHub issue reference from raw user input into the canonical
 * `owner/repo#number` external id. Accepts:
 *   - a full issue URL: `https://github.com/octo/repo/issues/123`
 *   - the `octo/repo/issues/123` path form
 *   - the shorthand `octo/repo#123`
 * Returns null when nothing parses. The owner/repo are kept verbatim (GitHub repo
 * names are case-preserving); only surrounding whitespace is trimmed.
 */
export function parseGitHubIssueRef(input: string): string | null {
  const trimmed = input.trim()
  const url = trimmed.match(new RegExp(`github\\.com/(${SEG})/(${SEG})/issues/(\\d+)`))
  if (url) return `${url[1]}/${url[2]}#${url[3]}`
  const path = trimmed.match(new RegExp(`^(${SEG})/(${SEG})/issues/(\\d+)$`))
  if (path) return `${path[1]}/${path[2]}#${path[3]}`
  const short = trimmed.match(new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`))
  if (short) return `${short[1]}/${short[2]}#${short[3]}`
  return null
}

/** The parts of a GitHub issue external id (`owner/repo#number`). */
export interface GitHubIssueExternalId {
  owner: string
  repo: string
  number: number
}

/**
 * Split a stored `owner/repo#number` external id back into its parts. Returns
 * null if the id is malformed (defensive — ids are produced by
 * {@link parseGitHubIssueRef}, but a stale/hand-edited row should not throw).
 */
export function parseGitHubIssueExternalId(externalId: string): GitHubIssueExternalId | null {
  const m = externalId.match(new RegExp(`^(${SEG})/(${SEG})#(\\d+)$`))
  if (!m) return null
  return { owner: m[1]!, repo: m[2]!, number: Number(m[3]) }
}

/** The canonical web URL for an issue external id. */
export function githubIssueUrl(id: GitHubIssueExternalId): string {
  return `https://github.com/${id.owner}/${id.repo}/issues/${id.number}`
}
