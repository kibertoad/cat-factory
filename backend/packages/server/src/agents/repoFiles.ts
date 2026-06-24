import type {
  GitHubClient,
  GitHubRepoRef,
  RepoFiles,
  RepoOp,
  RepoOpContext,
  ResolveRepoFiles,
} from '@cat-factory/kernel'

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
    headSha: async (branch) => {
      // GitHub has no single-branch sha endpoint in the client port; find it in the
      // (paged) branch list. Absent ⇒ the branch does not exist yet (create-vs-commit).
      const page = await client.listBranches(installationId, ref)
      return page.items.find((b) => b.name === branch)?.headSha ?? null
    },
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
 * Run an agent's pre/post-op hooks in order over a shared {@link RepoOpContext}. Each
 * op is deterministic backend work (read a baseline artifact, render + commit files);
 * a throw aborts the remaining ops and propagates so the engine fails the step.
 */
export async function runRepoOps(ops: readonly RepoOp[], ctx: RepoOpContext): Promise<void> {
  for (const op of ops) await op(ctx)
}
