import type { AgentRunContext } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  CONFLICT_RESOLVER_AGENT_KIND,
  MERGER_AGENT_KIND,
  UI_TESTER_AGENT_KIND,
} from '@cat-factory/orchestration'
import { renderMergerMultiRepoSection, renderMultiRepoWorkspaceSection } from './jobBody.js'
import type { RepoCheckout } from './resolveRepoTarget.js'
import type {
  ContainerAgentExecutorDependencies,
  JobPackageRegistrySpec,
  RepoOrigin,
  RepoTarget,
  ResolveRepoOrigin,
} from './ContainerAgentExecutor.js'

/**
 * Job-body assembly helpers for {@link ContainerAgentExecutor}, extracted verbatim from
 * `ContainerAgentExecutor.ts` (pure code motion, no behaviour change) to keep that file under its
 * size budget: the `common` body assembly plus the auxiliary-repo resolution cluster (multi-repo
 * fan-out, conflict-resolver peer targeting, merger combined-diff siblings) and the small repo-spec
 * helpers they share. The private methods became free functions taking the executor's `deps` (and,
 * where needed, its `agentKindRegistry`) as explicit params.
 */

/**
 * The built-in implementer ("Coder") kind. The multi-repo coding fan-out
 * (service-connections phase 3) started ONLY on this kind: it is the step that makes the
 * cross-service change.
 */
export const IMPLEMENTER_AGENT_KIND = 'coder'

export const githubRepoOrigin: ResolveRepoOrigin = (repo) => ({
  cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
  provider: 'github',
})

export function buildRepoSpec(repo: RepoTarget, origin: RepoOrigin) {
  return {
    owner: repo.owner,
    name: repo.name,
    baseBranch: repo.baseBranch,
    cloneUrl: origin.cloneUrl,
    provider: origin.provider,
    ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
  }
}

/**
 * The PRE-REGISTRY built-in kinds that fan out across the task's connected repos as sibling
 * checkouts (service-connections phases 3–4). The `coder` opens the PRs; the `ci-fixer` resumes
 * those SAME work branches to fix red CI across every repo in one container (a cross-repo
 * contract break is exactly what a single-repo fixer can't fix). The conflict-resolver stays
 * SINGLE-repo (a git conflict is per-repo textual — handled by targeting the conflicted repo,
 * not fan-out).
 *
 * These two are not yet migrated to the agent-kind registry, so they can't declare
 * `fanOutMultiRepo` on a definition — hence this small allow-list. Registry-backed kinds (the
 * read-only `bug-investigator`, and any custom cross-service explore kind a deployment registers)
 * opt in via {@link AgentKindRegistry.fansOutMultiRepo} instead of being added here — so a new
 * fan-out kind is a registry flag, not another entry in this Set.
 */
export const MULTI_REPO_FANOUT_BUILTIN_KINDS: ReadonlySet<string> = new Set([
  IMPLEMENTER_AGENT_KIND,
  'ci-fixer',
])

/**
 * Assemble the fields EVERY harness job body carries (`common`), built once so the per-kind
 * bodies can't drift on which jobId/model/auth/repo/proxy fields they forward. Extracted from
 * `ContainerAgentExecutor.buildJobBody` to keep it under the complexity ceiling.
 */
export function buildCommonBody(
  context: AgentRunContext,
  args: {
    jobId: string
    model: string
    auth: Record<string, unknown>
    ghToken: unknown
    packageRegistries: JobPackageRegistrySpec[]
    repoSpec: Record<string, unknown>
    contextFiles: { path: string; title: string; url: string; content: string }[]
    skillBody?: unknown
    guardLimits?: unknown
  },
  deps: ContainerAgentExecutorDependencies,
): Record<string, unknown> {
  const { jobId, model, auth, ghToken, packageRegistries, repoSpec, contextFiles } = args
  const { skillBody, guardLimits } = args
  // The UI tester uploads its captured screenshots back to the backend from inside the
  // container. It reuses the SAME container session token it already carries for the LLM
  // proxy (auth.sessionToken), POSTing to the harness ingest route that shares the proxy
  // base URL — so no extra credential and no extra public-URL dependency. Only the
  // `tester-ui` kind gets it; every other kind never sees an upload seam.
  const artifactUpload =
    context.agentKind === UI_TESTER_AGENT_KIND &&
    typeof auth.proxyBaseUrl === 'string' &&
    typeof auth.sessionToken === 'string'
      ? { url: `${auth.proxyBaseUrl}/artifacts/ingest`, token: auth.sessionToken }
      : undefined
  return {
    jobId,
    model,
    ...auth,
    ghToken,
    ...(packageRegistries.length ? { packageRegistries } : {}),
    repo: repoSpec,
    ...(deps.githubApiBase ? { githubApiBase: deps.githubApiBase } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    // The resolved skill always travels as this dedicated top-level field (never a context
    // file). The claude-code harness materialises it into ~/.claude/skills/<name>/ natively;
    // Pi/codex materialise the same field's resources under `.cat-context/skill/` and receive
    // the instructions folded into the prompt (skillSection) instead.
    ...(skillBody ? { skill: skillBody } : {}),
    ...(artifactUpload ? { artifactUpload } : {}),
    ...(guardLimits ? { guardLimits } : {}),
  }
}

/**
 * Multi-repo coding (service-connections phases 3–4): when the implementer OR the ci-fixer runs
 * on a task with connected involved services, resolve every involved repo and fan the work out —
 * peer repos as sibling checkouts plus a prompt section naming the layout. The coder opens one PR
 * per changed repo; the ci-fixer resumes those same work branches to fix red CI across all of them
 * (jobBody drops the peer `pr` on the fixer path). A service co-located in the primary's own repo
 * (same monorepo) has no separate checkout; it rides the own-service PR and is named in the section
 * so the agent edits its subtree. Any involved service present ⇒ the agent works at the repo ROOT
 * (not just its own service subdir), so `commonForKind` swaps `repo`. Extracted from
 * `ContainerAgentExecutor.resolveAuxiliaryRepos` to keep it under the complexity ceiling;
 * `commonForKind` defaults to the passed `common` when nothing fans out.
 */
export async function resolveMultiRepoFanout(
  context: AgentRunContext,
  args: {
    workspaceId: string
    blockId: string
    repo: RepoTarget
    common: Record<string, unknown>
  },
  deps: ContainerAgentExecutorDependencies,
  agentKindRegistry: AgentKindRegistry,
): Promise<{
  peerRepos?: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
  multiRepoSection?: string
  commonForKind: Record<string, unknown>
}> {
  const { workspaceId, blockId, repo, common } = args
  let peerRepos:
    | { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
    | undefined
  let multiRepoSection: string | undefined
  let commonForKind = common
  const involvedServices = context.involvedServices ?? []
  const fansOutMultiRepo =
    MULTI_REPO_FANOUT_BUILTIN_KINDS.has(context.agentKind) ||
    agentKindRegistry.fansOutMultiRepo(context.agentKind)
  if (fansOutMultiRepo && involvedServices.length > 0 && deps.resolveRepoTargets) {
    // Reuse the primary repo already resolved above so the plural resolver skips re-reading the
    // installation and re-walking the primary block's ancestry — it only needs to resolve +
    // dedupe the involved peers on top of it.
    const { checkouts } = await deps.resolveRepoTargets(
      workspaceId,
      blockId,
      involvedServices.map((s) => s.frameId),
      repo,
    )
    const primaryCheckout = checkouts.find((c) => c.primary)
    const peerCheckouts = checkouts.filter((c) => !c.primary)
    // Multi-service iff there is a distinct peer repo OR an involved service co-located in
    // the primary's monorepo (both need the root-cwd + the prompt section).
    const coLocated = primaryCheckout?.involved ?? []
    if (peerCheckouts.length > 0 || coLocated.length > 0) {
      const origin = deps.resolveRepoOrigin ?? githubRepoOrigin
      if (peerCheckouts.length > 0) {
        peerRepos = peerCheckouts.map((c: RepoCheckout) => ({
          repo: buildRepoSpec(c.target, origin(c.target)),
          ...(c.involved[0]?.frameId ? { frameId: c.involved[0].frameId } : {}),
        }))
      }
      multiRepoSection = renderMultiRepoWorkspaceSection(checkouts, involvedServices)
      // Work at the repo ROOT: drop the primary's own-service subdir scoping so the agent
      // can edit every involved subtree in the (mono)repo. The layout section names which
      // subdirectory each service lives in.
      if (primaryCheckout) {
        const { serviceDirectory: _drop, ...rootTarget } = primaryCheckout.target
        commonForKind = {
          ...common,
          repo: buildRepoSpec(rootTarget, origin(rootTarget)),
        }
      }
    }
  }
  return {
    ...(peerRepos ? { peerRepos } : {}),
    ...(multiRepoSection ? { multiRepoSection } : {}),
    commonForKind,
  }
}

/**
 * Conflict-resolver PEER targeting (service-connections phase 4 follow-up): when the conflicts
 * gate detected the conflict on a connected involved service's repo, it hands the resolver
 * `context.conflictTarget`. Point the (single-repo) resolver at that PEER repo — resolve its
 * target and swap `repo`/`common.repo` — instead of the task's own service. The resolver clones
 * the peer's PR (work) branch and merges the peer's base in (jobBody pins the branch to the shared
 * work branch and reads `mergeBase` off this swapped target). An own-repo conflict carries no
 * `frameId`, so this returns `undefined` and the resolver targets the own service. Extracted from
 * `ContainerAgentExecutor.resolveAuxiliaryRepos` to keep it under the complexity ceiling.
 */
export async function resolveConflictResolverPeer(
  context: AgentRunContext,
  args: {
    workspaceId: string
    blockId: string
    repo: RepoTarget
    common: Record<string, unknown>
  },
  deps: ContainerAgentExecutorDependencies,
): Promise<{ repoForKind: RepoTarget; commonForKind: Record<string, unknown> } | undefined> {
  const { workspaceId, blockId, repo, common } = args
  const conflictFrameId =
    context.agentKind === CONFLICT_RESOLVER_AGENT_KIND ? context.conflictTarget?.frameId : undefined
  if (!conflictFrameId || !deps.resolveRepoTargets) return undefined
  const { checkouts } = await deps.resolveRepoTargets(workspaceId, blockId, [conflictFrameId], repo)
  const peer = checkouts.find(
    (c) => !c.primary && c.involved.some((i) => i.frameId === conflictFrameId),
  )
  // Fail fast if the tagged peer can't be resolved (e.g. a stale/missing repo projection row):
  // falling through would silently point the resolver at the OWN repo, which has no conflict, so
  // every re-probe would re-dispatch until the whole attempt budget is spent on the wrong repo
  // and the run gives up misattributing the failure. A loud dispatch error surfaces the
  // inconsistency immediately instead.
  if (!peer) {
    throw new Error(
      `Conflict-resolver could not resolve the conflicted peer repo (frame '${conflictFrameId}') ` +
        `for block '${blockId}' — its repo projection may be missing or unlinked.`,
    )
  }
  const origin = deps.resolveRepoOrigin ?? githubRepoOrigin
  return {
    repoForKind: peer.target,
    commonForKind: { ...common, repo: buildRepoSpec(peer.target, origin(peer.target)) },
  }
}

/**
 * Merger combined-diff (service-connections phase 4 follow-up): a multi-repo task opened one PR
 * per changed repo. The merger scores the COMBINED change by cloning EVERY PR's repo as a
 * read-only sibling at its PR branch (the read-only explore fan-out) and diffing each vs its base.
 * Driven by the PRs that actually exist (`block.peerPullRequests`), not the involved-services set
 * — a peer with no change opened no PR, so there is nothing to score there. The own-service PR
 * rides the primary checkout (the merger clones `pr` full); the peers are added here with their
 * own PR branch to check out, plus a section naming the sibling diff commands. Returns `undefined`
 * (leaving the fan-out result to stand) when it doesn't fire. Extracted from
 * `ContainerAgentExecutor.resolveAuxiliaryRepos` to keep it under the complexity ceiling.
 */
export async function resolveMergerCombinedDiff(
  context: AgentRunContext,
  args: {
    workspaceId: string
    blockId: string
    repo: RepoTarget
    common: Record<string, unknown>
    workBranch: string
  },
  deps: ContainerAgentExecutorDependencies,
): Promise<
  | {
      peerRepos: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
      multiRepoSection: string
    }
  | undefined
> {
  const { workspaceId, blockId, repo, workBranch } = args
  const peerPrs = context.block.peerPullRequests ?? []
  if (context.agentKind !== MERGER_AGENT_KIND || peerPrs.length === 0 || !deps.resolveRepoTargets) {
    return undefined
  }
  const frameIds = peerPrs.map((p) => p.frameId).filter((f): f is string => !!f)
  if (frameIds.length === 0) return undefined
  const { checkouts } = await deps.resolveRepoTargets(workspaceId, blockId, frameIds, repo)
  const origin = deps.resolveRepoOrigin ?? githubRepoOrigin
  const legs: {
    spec: Record<string, unknown>
    frameId: string
    cloneBranch: string
    target: RepoTarget
  }[] = []
  for (const pr of peerPrs) {
    if (!pr.frameId) continue
    const checkout = checkouts.find(
      (c) => !c.primary && c.involved.some((i) => i.frameId === pr.frameId),
    )
    if (!checkout) continue
    legs.push({
      spec: buildRepoSpec(checkout.target, origin(checkout.target)),
      frameId: pr.frameId,
      cloneBranch: pr.ref.branch ?? workBranch,
      target: checkout.target,
    })
  }
  if (legs.length === 0) return undefined
  return {
    peerRepos: legs.map((l) => ({
      repo: l.spec,
      frameId: l.frameId,
      cloneBranch: l.cloneBranch,
    })),
    // The own service rides the primary checkout at its PR head (clone `pr`, or base when the
    // own service had no change); list it first so the section names its diff command too.
    multiRepoSection: renderMergerMultiRepoSection([
      { owner: repo.owner, name: repo.name, baseBranch: repo.baseBranch },
      ...legs.map((l) => ({
        owner: l.target.owner,
        name: l.target.name,
        baseBranch: l.target.baseBranch,
      })),
    ]),
  }
}
