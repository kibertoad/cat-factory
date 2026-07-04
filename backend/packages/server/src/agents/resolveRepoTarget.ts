import {
  ValidationError,
  type BlockRepository,
  type GitHubInstallationRepository,
  type RepoProjectionRepository,
  type ServiceRepository,
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
  /**
   * Resolves the {@link Service} owning a frame block — the SOLE repo↔frame linkage: it
   * yields which repo a frame targets AND (for a monorepo) the subdirectory the service
   * pins. Every facade wires it whenever GitHub is configured.
   */
  serviceRepository: Pick<ServiceRepository, 'getByFrameBlock'>
}

/**
 * Resolve the repo linked to a running block's enclosing service, shared verbatim by
 * both runtime facades (Worker D1 + Node Drizzle/Postgres). Repos are linked at the
 * service-frame level (via the account-owned {@link ServiceRepository}), but execution
 * runs at the task/module level, so we walk up the block's ancestry to find the frame's repo.
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
  const { installationRepository, repoProjectionRepository, blockRepository, serviceRepository } =
    deps
  return async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await repoProjectionRepository.list(workspaceId)
    if (repos.length === 0) return null
    const reposByGithubId = new Map(repos.map((r) => [r.githubId, r]))

    // Walk up the block's ancestry to the enclosing service frame, then resolve its repo via
    // the account-owned `Service` for that frame (`getByFrameBlock` → `repoGithubId`). This is
    // the SOLE linkage: it is the only mechanism that supports a MONOREPO (several frames each
    // owning a service pinned to a different subdirectory of the SAME repo) and the only one
    // carrying the per-service `directory`. There is deliberately NO "first repo" fallback: a
    // workspace can have many repos, and guessing silently pushes work into the wrong one. If
    // nothing in the chain is linked we throw so the misconfiguration surfaces instead of
    // corrupting another repo.
    let resolved: { repo: (typeof repos)[number]; directory: string | null } | undefined
    let cursor: string | null = blockId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      const service = await serviceRepository.getByFrameBlock(cursor)
      if (service?.repoGithubId != null) {
        const repo = reposByGithubId.get(service.repoGithubId)
        if (repo) {
          resolved = { repo, directory: service.directory ?? null }
          break
        }
      }
      seen.add(cursor)
      const block = await blockRepository.get(workspaceId, cursor)
      cursor = block?.parentId ?? null
    }

    if (!resolved) {
      // A typed domain error (not a bare Error) so callers can tell this DELIBERATE
      // "block isn't under a repo-linked service" outcome apart from an unexpected
      // repo/DB failure — the task-search controller maps it to a clean 4xx, while an
      // unexpected failure still propagates as a 500 instead of masquerading as one.
      throw new ValidationError(
        `Block '${blockId}' is not under a service linked to a GitHub repository ` +
          `(workspace '${workspaceId}'). Link the service frame to its repo so execution ` +
          `targets the right repository instead of guessing one.`,
      )
    }
    const { repo, directory } = resolved
    // The subdirectory is fed to agents ONLY when the repo is flagged a monorepo: a
    // single-service repo's service may carry a stale/irrelevant directory, but its
    // agents must keep operating on the repo root (the historical behaviour).
    const serviceDirectory = repo.isMonorepo && directory ? directory : undefined
    return {
      installationId: installation.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.defaultBranch ?? 'main',
      ...(serviceDirectory ? { serviceDirectory } : {}),
    }
  }
}
