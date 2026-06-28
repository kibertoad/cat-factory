// ---------------------------------------------------------------------------
// Provider-neutral VCS identity vocabulary.
//
// The platform was originally hard-wired to GitHub: every port keyed on a numeric
// `installationId` (the GitHub-App installation), entity ids were GitHub numeric ids,
// and the persisted tables were `github_*`. To support other systems (GitLab first)
// the GitHub-specific identity is replaced by these neutral refs, and a concrete
// provider (github / gitlab) is selected through the {@link VcsProvider} discriminator
// on the connection — see `vcs-registry.ts`.
//
// GitHub maps onto this with `connectionId = String(installationId)`; the GitHub
// adapter parses it back internally, so no GitHub concept leaks through the neutral
// port surface. GitLab's `connectionId` is the id of a stored connection row that
// holds a group/OAuth/PAT token.
// ---------------------------------------------------------------------------

/** The VCS systems the platform can talk to. Extend as adapters are added. */
export type VcsProvider = 'github' | 'gitlab'

/** Every supported provider, in a stable order (UI pickers, validation, tests). */
export const VCS_PROVIDERS: readonly VcsProvider[] = ['github', 'gitlab'] as const

/** Type guard: is `value` one of the known {@link VcsProvider}s? */
export function isVcsProvider(value: unknown): value is VcsProvider {
  return typeof value === 'string' && (VCS_PROVIDERS as readonly string[]).includes(value)
}

/**
 * Which credentials/connection a VCS call should use. Replaces the bare
 * `installationId: number` that every GitHub port method used to take.
 *
 *  - `provider`     — selects the concrete adapter via the VCS registry.
 *  - `connectionId` — the provider's stored connection identity, as a string
 *                     (GitHub: the installation id stringified; GitLab: the
 *                     `vcs_connections` row id holding the token).
 */
export interface VcsConnectionRef {
  provider: VcsProvider
  connectionId: string
}

/**
 * A repository, addressed provider-neutrally.
 *
 *  - `repoId` — the provider's canonical repo identity, as a string (GitHub numeric
 *               id stringified; GitLab project id or full path). DB id columns are
 *               TEXT so both shapes round-trip.
 *  - `owner` / `repo` — the human-readable namespace + name (GitHub `owner/repo`;
 *               GitLab group + project), used for clone URLs and display.
 */
export interface VcsRepoRef {
  repoId: string
  owner: string
  repo: string
}

/**
 * Build a {@link VcsConnectionRef} for GitHub from a numeric installation id. Centralises
 * the `installationId → connectionId` mapping so the GitHub adapter is the only place that
 * knows the connection id is a stringified installation id.
 */
export function githubConnectionRef(installationId: number): VcsConnectionRef {
  return { provider: 'github', connectionId: String(installationId) }
}

/**
 * Recover a numeric GitHub installation id from a {@link VcsConnectionRef}. GitHub-adapter
 * internal helper — throws if handed a non-GitHub connection (a wiring bug) or an
 * unparseable id.
 */
export function githubInstallationId(connection: VcsConnectionRef): number {
  if (connection.provider !== 'github') {
    throw new Error(`Expected a github connection, got "${connection.provider}".`)
  }
  const id = Number(connection.connectionId)
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid github installation id "${connection.connectionId}".`)
  }
  return id
}
