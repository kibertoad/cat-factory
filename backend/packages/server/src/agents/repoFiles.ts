import type {
  GitHubClient,
  GitHubRepoRef,
  RepoFiles,
  ResolveRepoFiles,
  ResolveRunRepoContext,
} from '@cat-factory/kernel'
import type { ResolveRepoTarget } from './ContainerAgentExecutor.js'

// `runRepoOps` lives in @cat-factory/agents (so the orchestration engine can drive the
// hooks without importing this HTTP layer); re-exported here for the existing callers.
export { runRepoOps } from '@cat-factory/agents'

// The server-side implementation of the `RepoFiles` kernel port: a per-run,
// checkout-free facade that delegates to the wired `GitHubClient`'s Git Data + contents
// API. Because it is pure HTTP (no filesystem, no `git`), it works identically on the
// Cloudflare Worker and Node — the runtime-symmetric mechanism an agent's pre/post-op
// uses to read a targeted subset of the repo and commit rendered artifact files without
// cloning. Each instance is bound to ONE installation + repo, so a repo-op names only
// paths/branches.

/** Bind a {@link GitHubClient} to one installation + repo as a {@link RepoFiles}. */
export function makeRepoFiles(
  client: GitHubClient,
  installationId: number,
  ref: GitHubRepoRef,
): RepoFiles {
  return {
    getFile: (path, gitRef) => client.getFileContent(installationId, ref, path, gitRef),
    listDirectory: (path, gitRef) => client.listDirectory(installationId, ref, path, gitRef),
    // Exact single-ref lookup — correct even on repos with more branches than one
    // `listBranches` page. Null ⇒ the branch does not exist yet (create-vs-commit).
    headSha: (branch) => client.branchHeadSha(installationId, ref, branch),
    createBranch: (branch, fromSha) => client.createBranch(installationId, ref, branch, fromSha),
    commitFiles: (input) => client.commitFiles(installationId, ref, input),
    openPullRequest: (input) => client.openPullRequest(installationId, ref, input),
  }
}

/** A {@link ResolveRepoFiles} backed by a single wired {@link GitHubClient}. */
export function makeResolveRepoFiles(client: GitHubClient): ResolveRepoFiles {
  return (installationId, ref) => makeRepoFiles(client, installationId, ref)
}

/**
 * Compose a {@link ResolveRunRepoContext} for the engine from the wired
 * {@link GitHubClient} + the same {@link ResolveRepoTarget} the container executor uses
 * to find a block's repo. The engine calls the result to bind a registered kind's
 * pre/post-ops to the run's repo (installation + repo + default branch) — checkout-free,
 * so it works identically on the Worker and Node. Returns null when the block resolves to
 * no repo (GitHub not connected); a throw from the target resolver (a block under no
 * linked service) propagates so the misconfiguration surfaces rather than guessing a repo.
 */
export function makeResolveRunRepoContext(
  client: GitHubClient,
  resolveRepoTarget: ResolveRepoTarget,
): ResolveRunRepoContext {
  return async (workspaceId, blockId) => {
    const target = await resolveRepoTarget(workspaceId, blockId)
    if (!target) return null
    return {
      repo: makeRepoFiles(client, target.installationId, {
        owner: target.owner,
        repo: target.name,
      }),
      baseBranch: target.baseBranch,
    }
  }
}
