import type { VcsProvider } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure helpers for shared-stack AUTODETECTION — turning the form's clone URL into the
// `{ owner, repo, provider }` coords the workspace's VCS connection resolves a checkout-free
// RepoFiles reader from. The compose scan itself lives in the environments module
// (`detectSharedStack`); this file is only the URL → coords step so it can be unit-tested in
// isolation. Provider-neutral (the platform talks to github + gitlab).
// ---------------------------------------------------------------------------

export interface ParsedCloneUrl {
  /** Repo owner / group path (a GitLab nested group keeps its slashes). */
  owner: string
  /** Repo / project name (the last path segment, `.git` stripped). */
  repo: string
  /**
   * The VCS provider, when confidently derivable from the host (`github.com` ⇒ github; a
   * `gitlab.*` / `gitlab.com` host ⇒ gitlab). Absent for any other host — the workspace's own
   * VCS connection then decides, which is the right default for self-hosted enterprise hosts
   * (a wrong guess would be worse than none).
   */
  provider?: VcsProvider
}

/** Derive the VCS provider from a host, or undefined when it isn't a well-known public host. */
function providerForHost(host: string): VcsProvider | undefined {
  if (host === 'github.com' || host.endsWith('.github.com')) return 'github'
  if (host === 'gitlab.com' || host.split('.').includes('gitlab')) return 'gitlab'
  return undefined
}

/**
 * Parse a git clone URL into `{ owner, repo, provider? }`. Accepts both HTTPS
 * (`https://github.com/acme/acme-shared-services.git`) and scp-like SSH
 * (`git@github.com:acme/acme-shared-services.git`) forms, with or without the trailing `.git`.
 * A GitLab nested-group path (`group/subgroup/project`) keeps the group path as `owner` and the
 * last segment as `repo`. Returns null when no `<owner>/<repo>` can be recovered.
 */
export function parseVcsCloneUrl(cloneUrl: string): ParsedCloneUrl | null {
  const trimmed = cloneUrl.trim()
  if (!trimmed) return null

  let host: string
  let rawPath: string
  try {
    const url = new URL(trimmed)
    // `hostname` (not `host`) — the latter carries the `:port`, which would defeat the exact
    // `github.com` / `gitlab.com` provider match for a ported clone URL (`https://github.com:443/…`).
    host = url.hostname.toLowerCase()
    rawPath = url.pathname
  } catch {
    // scp-like SSH: `user@host:owner/repo.git` (no scheme, a `:` separating host from path).
    const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(trimmed)
    if (!scp) return null
    host = scp[1]!.toLowerCase()
    rawPath = scp[2]!
  }

  let path = rawPath.replace(/^\/+/, '').replace(/\/+$/, '')
  if (path.toLowerCase().endsWith('.git')) path = path.slice(0, -'.git'.length)
  const segments = path.split('/').filter(Boolean)
  if (segments.length < 2) return null

  const repo = segments[segments.length - 1]!
  const owner = segments.slice(0, -1).join('/')
  if (!owner || !repo) return null

  const provider = providerForHost(host)
  return { owner, repo, ...(provider ? { provider } : {}) }
}
