import type {
  GitHubInstallationRepository,
  RepoProjectionRepository,
  ServiceRepository,
} from '@cat-factory/kernel'

// Linking a service frame to a repository is THREE writes across three stores that together
// express ONE fact, and `resolveRepoTarget` reads all three: the workspace's VCS installation, the
// repo projection row, and the frame's own service→repo link. Nothing in conformance can produce
// them the way production does (a real GitHub connection, which is off here), so the harness seeds
// them — and every facade needs the same three, over its own repositories.
//
// Hence one function taking the PORTS rather than a copy per facade harness: the writes are
// runtime-neutral (the same shapes on D1 and Drizzle), only the repositories differ, and three
// copies of a three-store invariant is three places for it to drift. Same shape as
// `defineVcsProviderSuite`, which already takes a facade's installation + projection repositories.

/** The stores one frame→repo link is written across. Narrowed to the methods it uses. */
export interface FrameRepoLinkRepositories {
  installations: Pick<GitHubInstallationRepository, 'upsert'>
  projection: Pick<RepoProjectionRepository, 'upsertMany'>
  services: Pick<ServiceRepository, 'getByFrameBlock' | 'update'>
}

export interface FrameRepoLink {
  workspaceId: string
  frameBlockId: string
  installationId: number
  githubId: number
  owner: string
  name: string
}

/**
 * Seed the three rows that make `resolveRepoTarget(workspaceId, blockId)` resolve for `frameBlockId`
 * and everything under it.
 *
 * Patches the service the frame ALREADY has (every top-level frame registers one at creation)
 * rather than inserting a second, because `getByFrameBlock` is an unordered single-row read and two
 * rows for one frame would resolve nondeterministically. It also throws rather than inserting when
 * the frame owns no service: silently creating one would make this pass on a facade that stopped
 * registering services at all, which is the very wiring a conformance seam exists to hold.
 */
export async function seedFrameRepoLink(
  repos: FrameRepoLinkRepositories,
  link: FrameRepoLink,
): Promise<void> {
  const { workspaceId, frameBlockId, installationId, githubId, owner, name } = link
  await repos.installations.upsert({
    installationId,
    workspaceId,
    accountId: null,
    accountLogin: owner,
    targetType: 'Organization',
    appId: null,
    provider: 'github',
    cachedToken: null,
    tokenExpiresAt: null,
    accessToken: null,
    createdAt: 1,
    deletedAt: null,
  })
  await repos.projection.upsertMany(workspaceId, [
    {
      githubId,
      installationId,
      owner,
      name,
      defaultBranch: 'main',
      private: false,
      linkedVia: 'app',
      syncedAt: 1,
    },
  ])
  const service = await repos.services.getByFrameBlock(frameBlockId)
  if (!service) throw new Error(`No service owns frame '${frameBlockId}'`)
  await repos.services.update(service.id, { installationId, repoGithubId: githubId })
}
