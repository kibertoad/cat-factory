import {
  ValidationError,
  type BlockRepository,
  type GitHubInstallationRepository,
  type GitHubRepo,
  type GroupCacheHandle,
  type RepoProjectionRepository,
  type ServiceRepository,
} from '@cat-factory/kernel'
import type { RepoTarget, ResolveRepoTarget } from './ContainerAgentExecutor.js'

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
  /**
   * Read-through cache for the workspace's whole repo projection
   * (`AppCaches.repoProjection`, docs/initiatives/caching-layer.md slice 3), grouped
   * AND keyed by workspace id. The unbounded `repoProjectionRepository.list` re-list
   * this resolver runs on every dispatch and poll tick reads through it; the
   * projection's write paths (GitHub sync/webhook, repo link/monorepo-flag, bootstrap)
   * invalidate the workspace group after they commit. Absent (tests / the Worker's
   * pass-through profile) ⇒ every resolve lists live.
   */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
}

/** A repo the projection lists, plus the monorepo subdirectory a service pins in it (or null). */
interface ResolvedRepo {
  repo: GitHubRepo
  directory: string | null
}

/** The projection indexed for lookup by GitHub id (the service→repo link). */
interface RepoIndex {
  byGithubId: Map<number, GitHubRepo>
}

function indexRepos(repos: GitHubRepo[]): RepoIndex {
  return {
    byGithubId: new Map(repos.map((r) => [r.githubId, r])),
  }
}

/**
 * Walk up a block's ancestry to the enclosing service frame and resolve its repo via the
 * account-owned {@link Service} for that frame (`getByFrameBlock` → `repoGithubId`). This is
 * the SOLE linkage: the only mechanism that supports a MONOREPO (several frames each owning a
 * service pinned to a different subdirectory of the SAME repo), and the only one carrying the
 * per-service `directory`. Returns undefined when nothing in the chain is linked (the caller
 * decides whether that is fatal — a throw for the primary, a skip for an involved peer).
 * Shared verbatim by the singular {@link buildResolveRepoTarget} and plural
 * {@link buildResolveRepoTargets} so the security-sensitive walk can't drift.
 */
async function walkToRepo(
  deps: Pick<ResolveRepoTargetDependencies, 'blockRepository' | 'serviceRepository'>,
  workspaceId: string,
  blockId: string,
  index: RepoIndex,
): Promise<ResolvedRepo | undefined> {
  let cursor: string | null = blockId
  const seen = new Set<string>()
  while (cursor && !seen.has(cursor)) {
    const service = await deps.serviceRepository.getByFrameBlock(cursor)
    if (service?.repoGithubId != null) {
      const repo = index.byGithubId.get(service.repoGithubId)
      if (repo) return { repo, directory: service.directory ?? null }
    }
    seen.add(cursor)
    const block = await deps.blockRepository.get(workspaceId, cursor)
    cursor = block?.parentId ?? null
  }
  return undefined
}

/**
 * Turn a resolved repo into a {@link RepoTarget}. The subdirectory is fed to agents ONLY
 * when the repo is flagged a monorepo: a single-service repo's service may carry a
 * stale/irrelevant directory, but its agents must keep operating on the repo root.
 */
function toRepoTarget(installationId: number, resolved: ResolvedRepo): RepoTarget {
  const serviceDirectory =
    resolved.repo.isMonorepo && resolved.directory ? resolved.directory : undefined
  return {
    installationId,
    owner: resolved.repo.owner,
    name: resolved.repo.name,
    baseBranch: resolved.repo.defaultBranch ?? 'main',
    ...(serviceDirectory ? { serviceDirectory } : {}),
  }
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
  const { installationRepository, repoProjectionRepository, repoProjectionCache } = deps
  return async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    // The whole-projection re-list is the hot, unbounded read here — cache it per
    // workspace. The installation lookup above and the block ancestry walk below stay
    // live (both cheap / tree-depth-bounded), so a reparent or service repo-link
    // change needs no cache invalidation; only the projection's own writes do.
    const repos = repoProjectionCache
      ? await repoProjectionCache.get(workspaceId, workspaceId, () =>
          repoProjectionRepository.list(workspaceId),
        )
      : await repoProjectionRepository.list(workspaceId)
    if (repos.length === 0) return null
    const resolved = await walkToRepo(deps, workspaceId, blockId, indexRepos(repos))
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
    return toRepoTarget(installation.installationId, resolved)
  }
}

// ── Multi-repo resolution (service-connections phase 3) ──────────────────────────────

/**
 * A single repo checkout a multi-repo run creates. Deduped by repo, so a monorepo hosting
 * several involved services is ONE checkout carrying all of them.
 */
export interface RepoCheckout {
  target: RepoTarget
  /** The task's OWN service repo (the singular {@link ResolveRepoTarget} result). */
  primary: boolean
  /**
   * The involved service frames that live in THIS repo (their block id + the monorepo
   * subdirectory each pins). Empty for a primary with no co-located involved service; ≥1
   * for a peer; >1 when several involved services share one monorepo. Drives the multi-repo
   * prompt section and the peer-PR frame attribution.
   */
  involved: { frameId: string; serviceDirectory?: string }[]
}

/** The deduped checkout set for a run, primary first. */
export interface ResolvedRepoTargets {
  checkouts: RepoCheckout[]
}

export type ResolveRepoTargets = (
  workspaceId: string,
  primaryBlockId: string,
  involvedFrameIds: string[],
  /**
   * The task's OWN-service {@link RepoTarget}, when the caller already resolved it via the
   * singular {@link ResolveRepoTarget} (the container executor does, to mint the push token).
   * Passing it lets this resolver SKIP re-reading the installation and re-walking the primary
   * block's ancestry — it reuses this as the primary checkout and only resolves the peers on
   * top. Omit it and the primary is resolved from scratch (the ancestry walk), as before.
   */
  primaryTarget?: RepoTarget,
) => Promise<ResolvedRepoTargets>

export interface ResolveRepoTargetsDependencies extends ResolveRepoTargetDependencies {
  /**
   * The batched form of {@link ResolveRepoTargetDependencies.serviceRepository} — resolving
   * N involved frames' repos in ONE query rather than a point-read per frame. Required (the
   * `Service` is the SOLE repo↔frame linkage), so an involved frame with no linked service
   * simply resolves no repo and is skipped for coding.
   */
  serviceRepository: Pick<ServiceRepository, 'getByFrameBlock' | 'listByFrameBlocks'>
}

/**
 * Resolve every repo a multi-repo run touches: the task's OWN service (PRIMARY, via the same
 * ancestry walk as {@link buildResolveRepoTarget}) plus one checkout per involved service
 * frame — DEDUPED by repo. Two involved services in the same monorepo collapse into one
 * checkout with BOTH subdirectories noted (the caller clones once and the agent edits both
 * subtrees); an involved service sharing the primary's repo is folded into the primary
 * checkout (no separate peer clone / PR — its changes ride the own-service PR).
 *
 * The invariant reads (installation + the whole projection) are hoisted ONCE and every
 * involved frame's service is resolved in a single {@link ServiceRepository.listByFrameBlocks}
 * batch (no point-read per frame). An involved frame with no linked repo is silently skipped
 * for coding — it can still have provisioned an environment (the phase-2 asymmetry). The
 * primary must resolve or we throw, exactly like the singular resolver.
 */
export function buildResolveRepoTargets(deps: ResolveRepoTargetsDependencies): ResolveRepoTargets {
  const { installationRepository, repoProjectionRepository, serviceRepository } = deps
  return async (workspaceId, primaryBlockId, involvedFrameIds, primaryTarget) => {
    // The installation id: reuse the pre-resolved primary target's when provided (skips a second
    // installation read), else read it here.
    let installationId: number
    if (primaryTarget) {
      installationId = primaryTarget.installationId
    } else {
      const installation = await installationRepository.getByWorkspace(workspaceId)
      if (!installation) {
        throw new ValidationError(
          `Workspace '${workspaceId}' has no GitHub installation, so a multi-repo run cannot ` +
            `resolve its repositories.`,
        )
      }
      installationId = installation.installationId
    }
    const repos = await repoProjectionRepository.list(workspaceId)
    const index = indexRepos(repos)

    // The primary checkout: reuse the caller's already-resolved target when given (no ancestry
    // walk), else walk the primary block's ancestry from scratch.
    let primaryCheckout: RepoCheckout
    if (primaryTarget) {
      primaryCheckout = { target: primaryTarget, primary: true, involved: [] }
    } else {
      const primary = repos.length
        ? await walkToRepo(deps, workspaceId, primaryBlockId, index)
        : undefined
      if (!primary) {
        throw new ValidationError(
          `Block '${primaryBlockId}' is not under a service linked to a GitHub repository ` +
            `(workspace '${workspaceId}'). Link the service frame to its repo so execution ` +
            `targets the right repository instead of guessing one.`,
        )
      }
      primaryCheckout = {
        target: toRepoTarget(installationId, primary),
        primary: true,
        involved: [],
      }
    }
    const checkouts: RepoCheckout[] = [primaryCheckout]
    const key = (t: Pick<RepoTarget, 'owner' | 'name'>): string => `${t.owner}/${t.name}`
    const byKey = new Map<string, RepoCheckout>([[key(primaryCheckout.target), primaryCheckout]])

    // Resolve every involved frame's service in one batch (frames ARE service frame blocks,
    // so no ancestry walk is needed — the frame's own service names its repo + directory).
    const uniqueFrameIds = [...new Set(involvedFrameIds)]
    const services = await serviceRepository.listByFrameBlocks(uniqueFrameIds)
    const serviceByFrame = new Map(services.map((s) => [s.frameBlockId, s]))

    for (const frameId of uniqueFrameIds) {
      const service = serviceByFrame.get(frameId)
      const resolved: ResolvedRepo | undefined =
        service?.repoGithubId != null && index.byGithubId.has(service.repoGithubId)
          ? {
              repo: index.byGithubId.get(service.repoGithubId)!,
              directory: service.directory ?? null,
            }
          : undefined
      // An involved frame with no linked repo is skipped for coding (deliberate asymmetry:
      // it may still have provisioned an environment in phase 2).
      if (!resolved) continue
      const target = toRepoTarget(installationId, resolved)
      const entry = byKey.get(key(target))
      const involvedEntry = {
        frameId,
        ...(target.serviceDirectory ? { serviceDirectory: target.serviceDirectory } : {}),
      }
      if (entry) {
        // Same repo as the primary or an earlier peer (a shared monorepo) → one checkout,
        // note this service's subdirectory alongside the others.
        entry.involved.push(involvedEntry)
      } else {
        const checkout: RepoCheckout = { target, primary: false, involved: [involvedEntry] }
        checkouts.push(checkout)
        byKey.set(key(target), checkout)
      }
    }

    return { checkouts }
  }
}
