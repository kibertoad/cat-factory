import type {
  BlockRepository,
  GitHubInstallationRepository,
  RepoProjectionRepository,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from './ContainerAgentExecutor.js'

// The (narrow) ports the repo-target resolution reads. Typed as `Pick`s so a facade
// that only ever reads the projection (e.g. the Node service, which has no GitHub
// sync writer yet) can supply a minimal `list`-only adapter rather than the whole
// `RepoProjectionRepository`.
export interface ResolveRepoTargetDependencies {
  installationRepository: Pick<GitHubInstallationRepository, 'getByWorkspace'>
  repoProjectionRepository: Pick<RepoProjectionRepository, 'list'>
  blockRepository: Pick<BlockRepository, 'get'>
}

/**
 * Resolve the repo linked to a running block's enclosing service, shared verbatim by
 * both runtime facades (Worker D1 + Node Drizzle/Postgres). Repos are linked at the
 * service-frame level (see `linkBlock`), but execution runs at the task/module level,
 * so we walk up the block's ancestry to find the frame's repo.
 *
 * There is deliberately NO "first repo" fallback: a workspace can have many repos, and
 * guessing silently pushes work into the wrong one (this is how a simple-service task
 * ended up force-pushing to butter-spread). If nothing in the chain is linked we throw
 * so the misconfiguration surfaces instead of corrupting another repo. Returns null
 * (rather than throwing) only when GitHub isn't connected at all — no installation, or
 * no repos projected yet — so an unconfigured workspace degrades cleanly.
 *
 * Single-sourcing this here keeps the security-sensitive ancestry walk from drifting
 * between the two stores (the per-facade conformance suites can't catch a divergence
 * because each wires its own resolver).
 */
export function buildResolveRepoTarget(deps: ResolveRepoTargetDependencies): ResolveRepoTarget {
  const { installationRepository, repoProjectionRepository, blockRepository } = deps
  return async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await repoProjectionRepository.list(workspaceId)
    if (repos.length === 0) return null
    const linkedIds = new Set(repos.map((r) => r.blockId).filter((id): id is string => !!id))

    let linkedBlockId: string | undefined
    let cursor: string | null = blockId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (linkedIds.has(cursor)) {
        linkedBlockId = cursor
        break
      }
      seen.add(cursor)
      const block = await blockRepository.get(workspaceId, cursor)
      cursor = block?.parentId ?? null
    }

    const repo = repos.find((r) => r.blockId === linkedBlockId)
    if (!repo) {
      throw new Error(
        `Block '${blockId}' is not under a service linked to a GitHub repository ` +
          `(workspace '${workspaceId}'). Link the service frame to its repo so execution ` +
          `targets the right repository instead of guessing one.`,
      )
    }
    return {
      installationId: installation.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.defaultBranch ?? 'main',
    }
  }
}
