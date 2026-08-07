import type { VcsProvider } from './vcs-types.js'

// ---------------------------------------------------------------------------
// Which WEB host a VCS connection's repositories, pull/merge requests and issues live on.
//
// Every provider the platform talks to is configured by its REST base (`GITHUB_API_BASE` /
// `GITLAB_API_BASE`), because that is what the clients call. The SPA needs the sibling fact:
// the browser-facing host, so a repo row can be rendered as a link. Nothing carried it, which
// is why `stores/github.ts` built `https://github.com/{owner}/{name}` by hand and a GitLab
// deployment got links to whatever lives at that path on gitlab.com.
//
// The web host is DERIVED from the API base rather than configured separately: a second
// variable would be a second thing to get wrong, and every deployment that has one has the
// other. The derivation is a suffix rule per provider, and a base that does not match it
// yields `null` — the honest answer for a base behind a path we cannot invert. A null host is
// rendered as a WITHHELD link, never as a guess at the provider's public instance: a
// namespace/project path that resolves on the public host is very likely somebody else's.
// ---------------------------------------------------------------------------

/** Per-provider web base URLs a deployment resolved, keyed by provider; absent ⇒ not nameable. */
export type VcsWebUrls = Readonly<Partial<Record<VcsProvider, string>>>

/**
 * The REST-base path suffix each provider's web base is the prefix of. Stripping it (rather than
 * discarding the whole path) is what makes a relative-URL install resolve to its own root: a
 * GitLab served from `https://host/gitlab` answers its API at `https://host/gitlab/api/v4`.
 *
 * A `Record` so a provider joining the union has to state its rule instead of inheriting one.
 */
const API_PATH_SUFFIXES: Record<VcsProvider, readonly string[]> = {
  // `/api/v3` is GitHub Enterprise Server's REST base; github.com's is the alias below.
  github: ['/api/v3'],
  gitlab: ['/api/v4'],
}

/**
 * The one API host per provider that is NOT a path under its web host, mapped to the host it
 * serves: github.com's REST API lives on `api.github.com`, while GitHub Enterprise Server and
 * every GitLab instance serve theirs under the web host.
 */
const API_HOST_ALIASES: Record<VcsProvider, Readonly<Record<string, string>>> = {
  github: { 'api.github.com': 'github.com' },
  gitlab: {},
}

/** `https://host/some/path/` → `['https:', 'host', '/some/path']`, or null if not absolute http(s). */
function splitHttpUrl(value: string): { scheme: string; host: string; path: string } | null {
  const match = /^(https?:)\/\/([^/?#]+)([^?#]*)/.exec(value.trim())
  if (!match) return null
  return { scheme: match[1]!, host: match[2]!, path: match[3]!.replace(/\/+$/, '') }
}

/**
 * The browser-facing base URL of the instance a provider's API base addresses, or `null` when
 * the base does not match the provider's known shape (an operator's proxy path, a bare host with
 * no recognised suffix, anything that is not an absolute http(s) URL). Callers render a null
 * host by dropping the affordance that needed it.
 *
 * Examples: `https://api.github.com` → `https://github.com`; `https://ghe.acme.dev/api/v3` →
 * `https://ghe.acme.dev`; `https://gitlab.com/api/v4` → `https://gitlab.com`;
 * `https://acme.dev/gitlab/api/v4` → `https://acme.dev/gitlab`.
 */
export function vcsWebBaseUrl(provider: VcsProvider, apiBase: string): string | null {
  const parts = splitHttpUrl(apiBase)
  if (!parts) return null
  const { scheme, host, path } = parts

  const aliased = API_HOST_ALIASES[provider][host.toLowerCase()]
  if (aliased && path === '') return `${scheme}//${aliased}`

  const suffix = API_PATH_SUFFIXES[provider].find((s) => path.endsWith(s))
  if (suffix === undefined) return null
  return `${scheme}//${host}${path.slice(0, -suffix.length)}`
}
