import type { VcsProvider } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The REPO-TARGETING vocabulary: how a run's repository is identified, reached and
// authenticated against. A declaration block with no behaviour, extracted out of
// `ContainerAgentExecutor.ts` (which was crowding its size budget) and re-exported
// from there, so every existing importer keeps resolving these from the executor.
//
// They belong together: each answers one part of "which repo does this run target,
// where does it live, and what may we do to it".
// ---------------------------------------------------------------------------

// The GitHub repo a run should be implemented against, resolved from the
// workspace's installation + connected repos (see each facade's container.ts).
export interface RepoTarget {
  installationId: number
  /**
   * The repo's provider-neutral id (`VcsRepoRef.repoId`) — the stable key a webhook delivery
   * names a repository by, so anything correlating a run with an inbound provider event keys
   * off THIS rather than re-deriving `owner/name`. Required: the only producer resolves it
   * from the projection row it already read, and a missing id silently breaks that correlation.
   */
  repoId: string
  /** Which VCS provider hosts it; absent on rows written before the column existed ⇒ `github`. */
  provider?: VcsProvider
  owner: string
  name: string
  baseBranch: string
  /**
   * For a service in a monorepo, the subdirectory (relative to the repo root) the
   * service lives in, e.g. `packages/api`. Present only when the resolved repo is
   * flagged a monorepo AND the service pins a directory; the harness then runs the
   * agent within that subtree and tells it so. Absent ⇒ whole-repo behaviour.
   */
  serviceDirectory?: string
}

export type ResolveRepoTarget = (workspaceId: string, blockId: string) => Promise<RepoTarget | null>

/**
 * Mint a GitHub token for repo work. The optional run context lets a facade prefer
 * the run initiator's personal access token over the App/env default (see
 * `ResolveUserGitHubToken`). Optional ⇒ callers that don't know the run (the
 * bootstrapper, tests) call `mint(installationId)` unchanged.
 *
 * `workspaceId` rides alongside `initiatedBy` because whether the initiator's own token may
 * be used is a per-WORKSPACE policy (`allowInitiatorPat`), and an installation id can serve
 * several workspaces — so it is supplied here rather than derived, where deriving it would
 * mean guessing which workspace's policy governs the run.
 *
 * `repoIds` is the dispatch's TOKEN SCOPE: the repos this one job may reach, in the neutral
 * `VcsRepoRef.repoId` vocabulary (see {@link jobTokenRepoIds}). A facade minting a GitHub App
 * token narrows it with `repository_ids`; a facade whose credential is a PAT (local mode, a
 * GitLab connection, the run initiator's own token) cannot narrow anything and ignores it,
 * which is why this is a HINT on the ctx rather than a required argument. Absent ⇒ the caller
 * does not know the run's repo set (the bootstrapper, the env-config repairer, tests) and the
 * mint stays installation-wide.
 */
export type MintInstallationToken = (
  installationId: number,
  ctx?: {
    executionId: string
    workspaceId: string
    initiatedBy?: string
    repoIds?: string[]
  },
) => Promise<string>

/**
 * The repos ONE dispatch's job token must reach: the primary checkout plus every auxiliary leg
 * the job body carries (multi-repo fan-out peers, the conflict-resolver's targeted peer, the
 * merger's combined-diff siblings, read-only reference repos). Deduped, in the neutral
 * `VcsRepoRef.repoId` vocabulary, so a facade can narrow the mint to exactly this set instead of
 * handing the container an installation-wide credential (`backend/docs/security-model.md`,
 * Layer 3).
 *
 * Legs on a DIFFERENT installation are dropped rather than added: one job carries one token,
 * minted for `primary.installationId`, so a leg outside that installation is unreachable with or
 * without scoping — including it would only make GitHub reject the mint and turn a pre-existing
 * (documented) limitation into a failed dispatch.
 *
 * The PRIMARY is always first and always present: a scope that omitted it would mint a token
 * that cannot clone the repo the run is about, which is a broken dispatch rather than a narrow
 * one. That is also why this returns the ids rather than a boolean "should we scope" — the
 * decision of what an id MEANS belongs to whichever facade mints, not here.
 */
export function jobTokenRepoIds(primary: RepoTarget, auxiliary: readonly RepoTarget[]): string[] {
  const ids = new Set<string>([primary.repoId])
  for (const leg of auxiliary) {
    if (leg.installationId !== primary.installationId) continue
    ids.add(leg.repoId)
  }
  return [...ids]
}

/**
 * One private package-registry entry as it rides the harness job body: the decrypted
 * token plus the registry host (derived backend-side from the fixed vendor set — the
 * harness hard-allowlists the hosts it will send a token to). Ecosystem-discriminated
 * so later ecosystems (pip/maven/cargo) are additive. Deliberately a dedicated
 * top-level body field, NEVER a context file: the agent-context snapshot copies
 * `contextFiles` content verbatim, while unknown top-level fields are omitted by its
 * allow-list projection.
 */
export interface JobPackageRegistrySpec {
  ecosystem: 'npm'
  host: string
  scopes: string[]
  token: string
}

/**
 * Ensure the per-task work branch exists on the remote, so every agent in the pipeline
 * operates on the SAME branch. Returns whether the branch is present afterwards; a
 * `false`/absent result makes read-only agents fall back to the base branch (writers
 * create-or-resume the branch in their harness regardless). `options.create` is `true`
 * for writers (create from base when absent) and `false` for read-only agents (probe
 * only — never create, since a missing branch means there is nothing yet to read).
 */
export type EnsureWorkBranch = (
  repo: RepoTarget,
  branch: string,
  options: { create: boolean },
) => Promise<boolean>

/** The git origin a run's repo is reached at: the clone URL plus the VCS provider. */
export interface RepoOrigin {
  cloneUrl: string
  provider: 'github' | 'gitlab'
}

/**
 * Resolve the clone URL + VCS provider for a run's repo. The repo projection carries NO host
 * (it stores only `owner`/`name`), so the origin is a deployment-level fact supplied here.
 * Defaults to GitHub (`https://github.com/<owner>/<name>.git`); a GitLab deployment (local
 * mode) injects a builder that emits the configured GitLab host + `gitlab`, so the harness
 * clones the right host AND opens a merge request instead of a pull request. Without this the
 * clone URL would always point at github.com, so a GitLab repo could never be cloned.
 */
export type ResolveRepoOrigin = (repo: RepoTarget) => RepoOrigin
