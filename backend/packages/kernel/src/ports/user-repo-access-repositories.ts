// Persistence port for the per-USER "repos my personal access token can reach"
// projection. It is the fail-closed cache that lets the board decide, WITHOUT a live
// GitHub call on the hot snapshot path, whether a member may view a service frame backed
// by a repo linked via someone's personal PAT (`GitHubRepo.linkedVia === 'user_pat'`).
//
// Populated whenever a user's PAT repo set is enumerated (they connect/refresh a PAT, or
// browse the "add existing repo" picker), and augmented for the single repo a user links.
// A member with no row for a personal repo is treated as having no access (fail closed),
// which self-heals the moment they connect their PAT. Keyed by `(userId, repoGithubId)`;
// repos reachable through the workspace's shared GitHub App are NOT tracked here (they are
// visible to every member, so they never need a per-user grant).
//
// Both runtimes (Cloudflare D1 + Node/local Postgres) implement this so behaviour is
// identical everywhere.

/** One repo a user's PAT can reach, at rest. */
export interface UserRepoAccessRecord {
  /** Internal user id (`usr_*`) whose PAT can reach the repo. */
  userId: string
  /** GitHub numeric repo id the grant is for. */
  repoGithubId: number
  owner: string
  name: string
  defaultBranch: string | null
  private: boolean
  /** When this grant was last confirmed by a PAT enumeration (epoch ms). */
  syncedAt: number
}

export interface UserRepoAccessRepository {
  /**
   * Replace the user's ENTIRE accessible set with `repos` — the write for a full
   * `/user/repos` enumeration (PAT connect/refresh or browse-all): a repo the PAT can no
   * longer reach is dropped, so revoked access stops granting visibility. Empty input
   * clears the user's set.
   */
  replaceForUser(userId: string, repos: UserRepoAccessRecord[]): Promise<void>
  /**
   * Upsert the given grants WITHOUT removing the user's other rows — the write for linking a
   * single personal repo (the linker provably has access, but we haven't re-enumerated their
   * whole set). Empty input is a no-op.
   */
  recordAccessible(userId: string, repos: UserRepoAccessRecord[]): Promise<void>
  /**
   * Of the given candidate repo ids, those the user's PAT can reach — a single (chunked) `IN`
   * query backing the snapshot redaction check for many personal frames at once (never a
   * per-frame point read). Empty input → empty result.
   */
  listAccessibleRepoIds(userId: string, repoGithubIds: number[]): Promise<number[]>
  /** Every repo the user's PAT can reach (for the picker merge / diagnostics). */
  listByUser(userId: string): Promise<UserRepoAccessRecord[]>
  /** Drop all of a user's grants (e.g. when they remove their stored PAT). */
  removeForUser(userId: string): Promise<void>
}
