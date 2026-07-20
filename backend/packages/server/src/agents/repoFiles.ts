import type {
  CachedRepoRead,
  DeployCloneTarget,
  GitHubClient,
  GitHubInstallationRepository,
  GitHubRepoRef,
  GroupCacheHandle,
  RepoFiles,
  RepoProjectionRepository,
  ResolveRepoFiles,
  ResolveRunRepoContext,
  RunRepoContext,
} from '@cat-factory/kernel'
import { repoFilesCacheGroup } from '@cat-factory/kernel'
import type {
  MintInstallationToken,
  RepoTarget,
  ResolveRepoTarget,
} from './ContainerAgentExecutor.js'

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

/**
 * A full 40-hex commit sha — an immutable ref, so its reads skip the head-sha probe. This is a
 * shape check: a branch literally named as 40 hex chars would be misclassified as immutable and
 * never revalidated. There is no cheap way to disambiguate a sha from an identically-shaped
 * branch (it needs a ref lookup), and the actual callers never collide — the engine's pre/post-op
 * refs are `cat-factory/<blockId>` branch names (always contain `/`) or genuine pinned shas — so
 * the mismatch is a bounded, accepted edge, not a live hazard.
 */
function isPinnedSha(gitRef: string): boolean {
  return /^[0-9a-f]{40}$/i.test(gitRef)
}

/**
 * Bind a {@link GitHubClient} to one installation + repo as a {@link RepoFiles}.
 *
 * When `cache` (the app's `repoFiles` cache, slice 4) is supplied, `getFile`/`listDirectory`
 * against a NAMED ref read through it — grouped per `(installation, owner, repo, ref)` so one
 * `commitFiles` (or a push webhook) drops exactly the branch it touched, and keyed per path
 * (`f:`/`d:` prefixes). Each entry remembers the branch head sha it reflects, so an entry
 * entering its refresh window re-validates with a single cheap `branchHeadSha` compare instead
 * of re-fetching every file; a sha-pinned read is immutable (no probe). The head sha a cold
 * batch stamps onto its entries is read ONCE per branch (memoised for this instance's lifetime,
 * cleared when we commit to that branch), so caching N files on a branch costs one extra head
 * read, not N. Reads with no `gitRef` (the repo default branch, whose name we don't know here)
 * bypass the cache. Absent `cache` ⇒ the original direct pass-through.
 */
export function makeRepoFiles(
  client: GitHubClient,
  installationId: number,
  ref: GitHubRepoRef,
  cache?: GroupCacheHandle<CachedRepoRead>,
): RepoFiles {
  const headSha = (branch: string) => client.branchHeadSha(installationId, ref, branch)
  // The direct pass-through facade. When a cache is supplied we override only the three methods
  // it actually changes (getFile/listDirectory/commitFiles) and inherit the rest from here, so
  // the shared bindings can't drift between the cached and uncached paths.
  const base: RepoFiles = {
    getFile: (path, gitRef) => client.getFileContent(installationId, ref, path, gitRef),
    listDirectory: (path, gitRef) => client.listDirectory(installationId, ref, path, gitRef),
    // Exact single-ref lookup — correct even on repos with more branches than one
    // `listBranches` page. Null ⇒ the branch does not exist yet (create-vs-commit).
    headSha,
    createBranch: (branch, fromSha) => client.createBranch(installationId, ref, branch, fromSha),
    deleteBranch: (branch) => client.deleteBranch(installationId, ref, branch),
    commitFiles: (input) => client.commitFiles(installationId, ref, input),
    openPullRequest: (input) => client.openPullRequest(installationId, ref, input),
    // The PR-deep-review resolutions: present only when the wired client can read a PR head /
    // post a batched inline review (the deep-review "fix" / "post" resolutions probe for them).
    ...(client.getPullRequestHeadRef
      ? {
          pullRequestHeadRef: (number: number) =>
            client.getPullRequestHeadRef!(installationId, ref, number),
        }
      : {}),
    // The deep-review drift check reads the PR head sha at review-start + at post time; present
    // only when the wired client can read it (else the check is skipped).
    ...(client.getPullRequestHeadSha
      ? {
          pullRequestHeadSha: (number: number) =>
            client.getPullRequestHeadSha!(installationId, ref, number),
        }
      : {}),
    ...(client.createReview
      ? {
          createReview: (number: number, input) =>
            client.createReview!(installationId, ref, number, input),
        }
      : {}),
    // The pr-reviewer preOp reads the PR's changed files + patches to inject the diff up front;
    // present only when the wired client can enumerate a PR's files (else the preOp passes through).
    ...(client.listChangedFiles
      ? {
          listChangedFiles: (number: number) =>
            client.listChangedFiles!(installationId, ref, number),
        }
      : {}),
  }
  if (!cache) return base

  // Dedupe an in-flight `branchHeadSha` read per branch. A REJECTED read is ALWAYS evicted so
  // one transient head-read blip never sticks for the instance's lifetime; `retainResolved`
  // then keeps a successful read for the whole batch (the cold-load memo — N files on a branch
  // share one head read) or drops it on settle (the probe memo — each refresh sweep must read
  // the CURRENT head afresh, but concurrent probes for the same branch still coalesce to ONE
  // request instead of one-per-cached-entry).
  const dedupeHead = (
    store: Map<string, Promise<string | null>>,
    branch: string,
    retainResolved: boolean,
  ): Promise<string | null> => {
    let pending = store.get(branch)
    if (!pending) {
      pending = headSha(branch)
      store.set(branch, pending)
      const evict = () => {
        if (store.get(branch) === pending) store.delete(branch)
      }
      void pending.then(retainResolved ? undefined : evict, evict)
    }
    return pending
  }
  const loadHeadMemo = new Map<string, Promise<string | null>>()
  const probeHeadMemo = new Map<string, Promise<string | null>>()
  const group = (gitRef: string) => repoFilesCacheGroup(installationId, ref.owner, ref.repo, gitRef)
  // The refresh-window probe: a pinned sha is immutable (always current); a branch entry is
  // current only while the branch head still matches the sha it was read at. A head-read blip
  // during the probe reports "stale" (reload) rather than throwing out of the caching layer.
  const probeFor = (gitRef: string): ((cached: CachedRepoRead) => Promise<boolean>) =>
    isPinnedSha(gitRef)
      ? () => Promise.resolve(true)
      : async (cached) => {
          try {
            return (await dedupeHead(probeHeadMemo, gitRef, false)) === cached.headSha
          } catch {
            return false
          }
        }
  // The head sha stamped onto a cold entry, for the probe to compare against. A pinned ref is
  // immutable (null ⇒ never probed). A transient head-read failure degrades to an UNSTAMPED
  // entry (null ⇒ the probe always reloads) rather than failing the content read — the uncached
  // path never read the head at all, so a head blip must not make a cached read less robust.
  const headForLoad = async (gitRef: string): Promise<string | null> => {
    if (isPinnedSha(gitRef)) return null
    try {
      return await dedupeHead(loadHeadMemo, gitRef, true)
    } catch {
      return null
    }
  }

  return {
    ...base,
    getFile: async (path, gitRef) => {
      if (!gitRef) return client.getFileContent(installationId, ref, path, gitRef)
      const cached = await cache.get(
        `f:${path}`,
        group(gitRef),
        async () => ({
          kind: 'file' as const,
          headSha: await headForLoad(gitRef),
          content: await client.getFileContent(installationId, ref, path, gitRef),
        }),
        probeFor(gitRef),
      )
      return cached.kind === 'file' ? cached.content : null
    },
    listDirectory: async (path, gitRef) => {
      if (!gitRef) return client.listDirectory(installationId, ref, path, gitRef)
      const cached = await cache.get(
        `d:${path}`,
        group(gitRef),
        async () => ({
          kind: 'dir' as const,
          headSha: await headForLoad(gitRef),
          entries: await client.listDirectory(installationId, ref, path, gitRef),
        }),
        probeFor(gitRef),
      )
      return cached.kind === 'dir' ? cached.entries : []
    },
    commitFiles: async (input) => {
      const result = await client.commitFiles(installationId, ref, input)
      // The branch moved: drop its cached reads (this replica's, and — when a notification
      // pair is wired — every peer's) and forget its memoised head so a later read re-stamps.
      loadHeadMemo.delete(input.branch)
      await cache.invalidateGroup(group(input.branch))
      return result
    },
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
 * linked service) propagates so the misconfiguration surfaces — failing the run loudly —
 * rather than guessing a repo, exactly as it does for a container kind at dispatch.
 *
 * `cache` (the app's `repoFiles` cache, slice 4) is threaded into the bound {@link RepoFiles}
 * so a registered kind's pre/post-op idempotency re-reads hit the read-through cache; absent
 * (tests / the pass-through profile) ⇒ direct reads, unchanged.
 */
export function makeResolveRunRepoContext(
  client: GitHubClient,
  resolveRepoTarget: ResolveRepoTarget,
  cache?: GroupCacheHandle<CachedRepoRead>,
): ResolveRunRepoContext {
  return async (workspaceId, blockId) => {
    const target = await resolveRepoTarget(workspaceId, blockId)
    if (!target) return null
    return {
      repo: makeRepoFiles(
        client,
        target.installationId,
        { owner: target.owner, repo: target.name },
        cache,
      ),
      baseBranch: target.baseBranch,
    }
  }
}

/**
 * Compose a {@link DeployCloneTarget} resolver for the async, container-backed Kubernetes
 * deploy path (slice 9's `resolveDeployCloneTarget` provisioning seam) from the wired
 * {@link GitHubClient} repo-target walk + a {@link MintInstallationToken}. The provisioning
 * service calls it BEFORE dispatch to hand the deploy container concrete clone coords (HTTPS
 * URL + ref + a short-lived install token) — VCS-specific, server-layer work the stateless
 * provider can't do itself. Returns null when the block resolves to no repo (GitHub not
 * connected / unlinked service), so a render-needing config then fails loudly. `webBaseUrl`
 * is the git web origin (`https://github.com` by default; a GHE/GitLab host otherwise),
 * mirroring the bootstrapper's clone-URL derivation.
 */
export function makeResolveDeployCloneTarget(
  resolveRepoTarget: ResolveRepoTarget,
  mintInstallationToken: MintInstallationToken,
  options?: {
    /** Git web origin for the default clone URL (`https://github.com` unless overridden). */
    webBaseUrl?: string
    /**
     * Override how the clone URL is built from the resolved {@link RepoTarget} — e.g. the local
     * GitLab facade emits its configured GitLab host instead of `github.com`. Wins over
     * `webBaseUrl`. Structurally the executor's `resolveRepoOrigin().cloneUrl`.
     */
    resolveCloneUrl?: (target: RepoTarget) => string
  },
): (workspaceId: string, blockId: string, ref?: string) => Promise<DeployCloneTarget | null> {
  const webBase = (options?.webBaseUrl ?? 'https://github.com').replace(/\/+$/, '')
  return async (workspaceId, blockId, ref) => {
    const target = await resolveRepoTarget(workspaceId, blockId)
    if (!target) return null
    const token = await mintInstallationToken(target.installationId)
    const cloneUrl = options?.resolveCloneUrl
      ? options.resolveCloneUrl(target)
      : `${webBase}/${target.owner}/${target.name}.git`
    return {
      cloneUrl,
      ref: ref ?? target.baseBranch,
      ...(token ? { token } : {}),
    }
  }
}

/**
 * Resolve a checkout-free {@link RunRepoContext} from explicit repo COORDINATES (owner +
 * repo), with no block context — the block-less sibling of {@link makeResolveRunRepoContext}
 * the environments module uses to validate/bootstrap a provider's config file in a repo the
 * operator names. Matches the workspace's projected repos by owner+name; returns null when
 * GitHub isn't connected (no installation / no repos) or the named repo isn't projected, so
 * the caller degrades cleanly to "no VCS connection".
 *
 * VCS-neutrality note: bound over the wired {@link GitHubClient} today; the provider never
 * sees it — it only gets a `readRepoFile`. When GitLab lands, resolve a `VcsClient` via the
 * VCS registry here instead; the provider code is unchanged.
 */
export function makeResolveRepoFilesForCoords(
  client: GitHubClient,
  installationRepository: Pick<GitHubInstallationRepository, 'getByWorkspace'>,
  repoProjectionRepository: Pick<RepoProjectionRepository, 'list'>,
): (
  workspaceId: string,
  coords: { owner: string; repo: string; provider?: 'github' | 'gitlab' },
) => Promise<RunRepoContext | null> {
  return async (workspaceId, { owner, repo, provider }) => {
    // Only GitHub is resolvable today. A caller that explicitly asks for another VCS
    // (e.g. `gitlab`) must NOT be silently bound to the GitHub installation/projection —
    // that could read the wrong repo or report a misleading match. Bail cleanly until a
    // VcsClient is resolved here per `provider`.
    if (provider && provider !== 'github') return null
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await repoProjectionRepository.list(workspaceId)
    const match = repos.find((r) => r.owner === owner && r.name === repo)
    if (!match) return null
    return {
      repo: makeRepoFiles(client, installation.installationId, { owner, repo }),
      baseBranch: match.defaultBranch ?? 'main',
    }
  }
}
