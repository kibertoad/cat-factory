import type {
  AgentRunContext,
  DesignImageDelivery,
  DesignImageSet,
  HarnessKind,
  ModelRef,
} from '@cat-factory/kernel'
import { resolveDesignImageDelivery } from '@cat-factory/kernel'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  CONFLICT_RESOLVER_AGENT_KIND,
  MERGER_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
} from '@cat-factory/orchestration'
import { DOC_WRITER_KIND, READ_ONLY_AGENT_KINDS } from '@cat-factory/agents'
import type { McpServerJobSpec } from './toolServers.js'
import type { GeneratorSecretJobSpec } from './binaryGenerators.js'
import { aprioriReferenceBranches } from '@cat-factory/contracts'
import {
  renderMergerMultiRepoSection,
  renderMultiRepoWorkspaceSection,
  renderReferenceBranchesSection,
  renderReferenceReposSection,
} from './jobBody.js'
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

// The built-in implementer ("Coder") kind id now lives beside its REGISTRATION in
// `@cat-factory/agents` (`kinds/built-in-container.ts`), the same pattern the blueprints /
// spec-writer / inline-reviewer ids follow. Re-exported here so every existing importer of this
// module is unchanged.
export { IMPLEMENTER_AGENT_KIND } from '@cat-factory/agents'
import { IMPLEMENTER_AGENT_KIND } from '@cat-factory/agents'

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
 * What THIS dispatch can do with the task's design pictures, or `undefined` when it holds none.
 *
 * A DISPATCH fact for the same reason the tool servers are: it takes the resolved harness AND the
 * resolved model, neither of which the engine knows while it is building the context. Resolved even
 * when the answer is no, because the prompt has to STATE a withheld picture rather than leave the
 * agent reading the textual design description as everything the platform had.
 */
export function dispatchDesignImageDelivery(
  context: AgentRunContext,
  harness: HarnessKind,
  ref: Pick<ModelRef, 'acceptsImages'>,
): DesignImageDelivery | undefined {
  return context.designImages?.files.length ? resolveDesignImageDelivery(harness, ref) : undefined
}

/** One image manifest as the harness parses it: where to fetch, with what, and which files. */
interface ImageManifestBody {
  url: string
  token: string
  files: { artifactId: string; fileName: string; view: string }[]
  omitted?: string[]
}

/**
 * The two image manifests a job body may carry: the reference designs a CAPTURING kind compares
 * against, and the design pictures a BUILDING kind is shown.
 *
 * One builder, because both ride the same seam: only identities travel (a run's frames are
 * megabytes of PNG and a job body is JSON that crosses every transport and is persisted with the
 * dispatch), and the bytes come back through the container's own session token, so neither needs an
 * extra credential or a public URL. They stay two FIELDS with two directories because they are
 * opposite instructions: one names the views to CAPTURE, the other is the design to BUILD, and a
 * capturing kind reading the builder's short list would take it for the complete set of views.
 *
 * Each is gated on a set that says SOMETHING. The engine already answered "this kind wants none" by
 * resolving nothing at all, and a manifest of zero files would have the harness create an empty
 * directory, which reads to the agent as designs that gave nothing rather than as a task with none
 * linked. For the capture half `omitted` counts as something to say on its own, since a set the cap
 * emptied entirely still owes the agent the view names it is expected to capture; the design half
 * carries no `omitted`, because the BACKEND's prompt names those views and the container is only
 * ever asked to CORRECT that list.
 */
function buildImageManifests(
  context: AgentRunContext,
  auth: Record<string, unknown>,
  designImages: DesignImageSet | undefined,
): { referenceScreenshots?: ImageManifestBody; designImages?: ImageManifestBody } {
  const { proxyBaseUrl, sessionToken } = auth
  if (typeof proxyBaseUrl !== 'string' || typeof sessionToken !== 'string') return {}
  const url = `${proxyBaseUrl}/artifacts/reference`
  const files = (set: { files: { artifactId: string; fileName: string; view: string }[] }) =>
    set.files.map((file) => ({
      artifactId: file.artifactId,
      fileName: file.fileName,
      view: file.view,
    }))
  const references = context.referenceScreenshots
  return {
    ...(references?.files.length || references?.omitted.length
      ? {
          referenceScreenshots: {
            url,
            token: sessionToken,
            files: files(references),
            // The views the engine's cap dropped, carried so the harness can state them beside the
            // ones that failed to transfer: from the agent's side both are a view it must capture
            // with no image to compare against.
            ...(references.omitted.length ? { omitted: references.omitted } : {}),
          },
        }
      : {}),
    ...(designImages?.files.length
      ? { designImages: { url, token: sessionToken, files: files(designImages) } }
      : {}),
  }
}

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
    skillsBody?: unknown[]
    mcpServers?: McpServerJobSpec[]
    generatorSecrets?: GeneratorSecretJobSpec[]
    guardLimits?: unknown
    designImages?: DesignImageSet
  },
  deps: ContainerAgentExecutorDependencies,
  agentKindRegistry: AgentKindRegistry,
): Record<string, unknown> {
  const { jobId, model, auth, ghToken, packageRegistries, repoSpec, contextFiles } = args
  const { skillsBody, mcpServers, generatorSecrets, guardLimits } = args
  // A browser-driven kind uploads its captured screenshots back to the backend from inside the
  // container. It reuses the SAME container session token it already carries for the LLM
  // proxy (auth.sessionToken), POSTing to the harness ingest route that shares the proxy
  // base URL — so no extra credential and no extra public-URL dependency. Keyed off the kind's
  // DECLARED `ui` image (only a browser image captures anything); every other kind never sees
  // an upload seam.
  //
  // Read off the executor's NORMALIZED registry (passed in), never `deps.agentKindRegistry`,
  // which is optional and undefined whenever the facade leaves the default registry implicit. The
  // image the transport dispatches to is chosen from the normalized one, so reading the optional
  // dep here would route a `tester-ui` job to the browser image with no upload seam and lose
  // every screenshot it captured — silently, since a missing seam is not an error anywhere.
  const artifactUpload =
    agentKindRegistry.agentStep(context.agentKind)?.image === 'ui' &&
    typeof auth.proxyBaseUrl === 'string' &&
    typeof auth.sessionToken === 'string'
      ? { url: `${auth.proxyBaseUrl}/artifacts/ingest`, token: auth.sessionToken }
      : undefined
  // The other direction of the same seam: the images the engine resolved for this task, as
  // manifests the harness downloads before the agent's first turn.
  const { referenceScreenshots, designImages } = buildImageManifests(
    context,
    auth,
    args.designImages,
  )
  return {
    jobId,
    // The run's correlation ids, carried purely so the container's own log lines can be joined
    // to the backend's. The harness binds them onto its per-job child logger beside `jobId` and
    // reads them for nothing else — before this, the two halves of a run shared no id at all and
    // were stitched only by the `${executionId}-${agentKind}` naming convention. Riding the job
    // body means every transport (Cloudflare container, local container, runner pool) carries
    // them with no transport-specific wiring, exactly like `validationChecks`.
    ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
    ...(context.executionId ? { executionId: context.executionId } : {}),
    model,
    ...auth,
    ghToken,
    ...(packageRegistries.length ? { packageRegistries } : {}),
    repo: repoSpec,
    // DEPENDENCY PREPOPULATION: the install the harness runs against the checkout before the
    // agent's first turn. On the BASE body deliberately — unlike `validationChecks`, which is a
    // pre-PR gate and rides only a PR-opening coding dispatch, this applies to every dispatch
    // that gets a checkout (explore kinds and in-place fixers included): an agent asked to read
    // or review a tree needs its dependencies present as much as one asked to change it.
    // Wrapped in an envelope rather than sent as a bare string: the harness parses it as
    // `{ command }` alongside the other phase specs, and a phase that later needs a second knob
    // (a working directory, a budget) must not require a wire-shape change on a published image.
    ...(context.dependencyInstall
      ? { dependencyInstall: { command: context.dependencyInstall } }
      : {}),
    ...(deps.githubApiBase ? { githubApiBase: deps.githubApiBase } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    // The resolved skills always travel as this dedicated top-level field (never context
    // files). The claude-code harness installs each into CLAUDE_CONFIG_DIR/skills/<name>/
    // natively; Pi/codex materialise the same field's resources under `.cat-context/skill/<name>/`
    // and receive the instructions folded into the prompt (skillSection) instead.
    ...(skillsBody?.length ? { skills: skillsBody } : {}),
    // Tool servers (MCP) the running kind declared, with their transports and any resolved
    // credentials. Also a dedicated top-level field the agent-context snapshot allow-list omits —
    // the prompt-facing (non-secret) projection rides `context.toolServers` instead.
    ...(mcpServers?.length ? { mcpServers } : {}),
    // The resolved credentials of this step's generative binary integrations, as `{ key, value }`
    // env pairs the harness injects into the agent's own process — the same channel and the same
    // secrecy contract as the tester's `testSecrets`, and likewise omitted by the agent-context
    // snapshot's allow-list. On the BASE body (not a per-kind one) because the kind that carries
    // the `binary-output` trait is a deployment's own, and gating this on a built-in kind list is
    // exactly the coupling the trait exists to avoid.
    ...(generatorSecrets?.length ? { generatorSecrets } : {}),
    ...(artifactUpload ? { artifactUpload } : {}),
    ...(referenceScreenshots ? { referenceScreenshots } : {}),
    ...(designImages ? { designImages } : {}),
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
 * (not just its own service subdir), so the returned `repoSpecOverride` replaces `common.repo`.
 * Extracted from `ContainerAgentExecutor.resolveAuxiliaryRepos` to keep it under the complexity
 * ceiling.
 *
 * Returns the repo SPEC to override `common.repo` with rather than a rebuilt `common`, and the
 * resolved `repoTargets` beside it: the job's token is minted AFTER this resolution and narrowed
 * to exactly those repos ({@link jobTokenRepoIds}), so `common` does not exist yet when this runs.
 */
export async function resolveMultiRepoFanout(
  context: AgentRunContext,
  args: {
    workspaceId: string
    blockId: string
    repo: RepoTarget
  },
  deps: ContainerAgentExecutorDependencies,
  agentKindRegistry: AgentKindRegistry,
): Promise<{
  peerRepos?: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
  multiRepoSection?: string
  repoSpecOverride?: Record<string, unknown>
  repoTargets: RepoTarget[]
}> {
  const { workspaceId, blockId, repo } = args
  let peerRepos:
    | { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
    | undefined
  let multiRepoSection: string | undefined
  let repoSpecOverride: Record<string, unknown> | undefined
  const repoTargets: RepoTarget[] = []
  const involvedServices = context.involvedServices ?? []
  // Every fan-out kind — the built-in implementer and CI-fixer included — declares
  // `fanOutMultiRepo` on its own registration, so there is no allow-list beside this lookup.
  const fansOutMultiRepo = agentKindRegistry.fansOutMultiRepo(context.agentKind)
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
        repoTargets.push(...peerCheckouts.map((c: RepoCheckout) => c.target))
      }
      multiRepoSection = renderMultiRepoWorkspaceSection(checkouts, involvedServices)
      // Work at the repo ROOT: drop the primary's own-service subdir scoping so the agent
      // can edit every involved subtree in the (mono)repo. The layout section names which
      // subdirectory each service lives in.
      if (primaryCheckout) {
        const { serviceDirectory: _drop, ...rootTarget } = primaryCheckout.target
        repoSpecOverride = buildRepoSpec(rootTarget, origin(rootTarget))
      }
    }
  }
  return {
    ...(peerRepos ? { peerRepos } : {}),
    ...(multiRepoSection ? { multiRepoSection } : {}),
    ...(repoSpecOverride ? { repoSpecOverride } : {}),
    repoTargets,
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
  },
  deps: ContainerAgentExecutorDependencies,
): Promise<{ repoForKind: RepoTarget; repoSpecOverride: Record<string, unknown> } | undefined> {
  const { workspaceId, blockId, repo } = args
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
    repoSpecOverride: buildRepoSpec(peer.target, origin(peer.target)),
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
    workBranch: string
  },
  deps: ContainerAgentExecutorDependencies,
): Promise<
  | {
      peerRepos: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
      multiRepoSection: string
      repoTargets: RepoTarget[]
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
    repoTargets: legs.map((l) => l.target),
  }
}

// ---------------------------------------------------------------------------
// READ-ONLY reference inputs: the repos and branches a task attaches as prior art the agent may
// READ but never write. Moved here from `ContainerAgentExecutor` with the rest of the auxiliary-
// checkout cluster (pure code motion) — the two are the same concern the multi-repo fan-out and
// merger-sibling resolution already live here for, and the executor stays a dispatch/poll
// orchestrator within its size budget.
// ---------------------------------------------------------------------------

/**
 * The kinds that consume a task's read-only `referenceRepos` — cloned as READ-ONLY sibling
 * checkouts the agent may read (to reuse existing solutions) but never write to. Deliberately
 * a SEPARATE gate from a kind's `fanOutMultiRepo` declaration: reference repos are not involved
 * services (never writable, no branch/PR, don't need to be board services), so they must not be
 * folded into the fan-out path. Only the document writer reads them today.
 */
const REFERENCE_REPO_KINDS: ReadonlySet<string> = new Set([DOC_WRITER_KIND])

/**
 * The read-only bug-triage kind excluded from the reference-branch consumers below: it clones the
 * REPORTED PR/commit as its subject, so an unrelated prior-art reference branch is noise for it.
 */
const BUG_INVESTIGATOR_AGENT_KIND = 'bug-investigator'

/**
 * The kinds that consume a task's read-only apriori REFERENCE branches (the apriori-branches
 * reference mode) — the branches are fetched into the primary checkout's `origin/<b>` refs so the
 * agent can inspect a spike/prototype/prior-art branch it must never commit to. The consumers are
 * the kinds that read/plan/author against the primary repo — the implementer (`coder`), the
 * spec-writer, the doc-writer, and the read-only design/analysis kinds (`architect` / `analysis`).
 * Deliberately EXCLUDES the PR-cloning fix/assess kinds (ci-fixer / conflict-resolver / tester /
 * merger): they already carry the work in the PR branch they clone, so a reference branch is noise
 * — and folding it in would spend prompt tokens and a fetch on a branch they will not use.
 *
 * The design/analysis members are DERIVED from the authoritative {@link READ_ONLY_AGENT_KINDS}
 * (minus `bug-investigator`) rather than re-listed as literals, so a newly-registered read-only
 * design kind is picked up here automatically without a second hard-coded list to keep in step.
 */
const REFERENCE_BRANCH_KINDS: ReadonlySet<string> = new Set([
  IMPLEMENTER_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  DOC_WRITER_KIND,
  ...[...READ_ONLY_AGENT_KINDS].filter((k) => k !== BUG_INVESTIGATOR_AGENT_KIND),
])

/**
 * Read-only reference repos (document-authoring tasks): the doc-writer clones each attached repo
 * as a READ-ONLY sibling checkout it may read but never writes to. The spec carries NO branch/PR
 * fields, so it is structurally unpushable; the harness clones it at its own default branch and
 * skips it in the push phase. Auth reuses the run's already-resolved `ghToken` (the run
 * initiator's own token when they have one, per `mintInstallationToken`), so no extra token mint.
 * A reference repo may be outside the workspace projection, so its clone identity comes straight
 * from the persisted attachment. Provider-neutral: the clone URL + provider come from
 * `resolveRepoOrigin` (the same deployment-level seam the primary rides), so a GitLab deployment
 * clones from GitLab. Extracted from {@link resolveAuxiliaryRepos} to keep it under the ceiling.
 */
export function resolveReferenceRepos(
  context: AgentRunContext,
  repo: RepoTarget,
  deps: ContainerAgentExecutorDependencies,
): {
  referenceRepos?: { repo: Record<string, unknown> }[]
  referenceReposSection?: string
  repoTargets: RepoTarget[]
} {
  const attachedReferenceRepos = context.referenceRepos ?? []
  if (attachedReferenceRepos.length === 0 || !REFERENCE_REPO_KINDS.has(context.agentKind)) {
    return { repoTargets: [] }
  }
  const origin = deps.resolveRepoOrigin ?? githubRepoOrigin
  // Dedup against the primary and each other by the harness's sibling-checkout key
  // (`owner/name`, case-insensitive — it maps to the `owner__name` clone directory): two legs
  // claiming the same directory would make the second `git clone` fail into a non-empty dir.
  // A reference pointing at the doc task's OWN repo is therefore dropped (it is already the
  // primary checkout), and duplicate attachments collapse to one.
  const siblingKey = (owner: string, name: string) => `${owner}/${name}`.toLowerCase()
  const seen = new Set<string>([siblingKey(repo.owner, repo.name)])
  const targets: RepoTarget[] = []
  for (const r of attachedReferenceRepos) {
    const key = siblingKey(r.owner, r.name)
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({
      installationId: r.connectionId ?? repo.installationId,
      // A reference repo already carries the id it was attached by; the neutral
      // `VcsRepoRef.repoId` vocabulary is the stringified form.
      repoId: String(r.repoId),
      owner: r.owner,
      name: r.name,
      baseBranch: r.defaultBranch,
    })
  }
  if (targets.length === 0) {
    return { repoTargets: [] }
  }
  return {
    referenceRepos: targets.map((t) => ({ repo: buildRepoSpec(t, origin(t)) })),
    referenceReposSection: renderReferenceReposSection(repo, targets),
    repoTargets: targets,
  }
}

/**
 * Read-only apriori REFERENCE branches (the apriori-branches reference mode): existing branches
 * of the PRIMARY repo the task names as prior-art the agent may READ but never write. Unlike the
 * reference REPOS above, these are not sibling checkouts — they ride the primary clone as
 * `origin/<b>` refs the harness fetches before the agent runs (see the harness
 * `fetchReferenceBranches`). Only the consumer kinds (coder / spec-writer / doc-writer /
 * architect / analysis) receive them. Each is PROBED at dispatch (create:false) and a missing
 * branch is DROPPED — asymmetric with a missing WORKING branch (which fails loudly): a reference
 * is garnish, so a stale/typo'd one is silently omitted rather than failing the run. When probing
 * isn't wired (tests / no GitHub) every named branch is forwarded and the harness fetch is
 * best-effort. A run that already carries a PR still reads reference branches (they are context,
 * independent of the work branch). Extracted from {@link resolveAuxiliaryRepos} for the ceiling.
 */
export async function resolveReferenceBranches(
  context: AgentRunContext,
  args: { repo: RepoTarget; workBranch: string; multiRepo: boolean },
  deps: ContainerAgentExecutorDependencies,
): Promise<{ referenceBranches?: string[]; referenceBranchesSection?: string }> {
  const { repo, workBranch, multiRepo } = args
  if (!REFERENCE_BRANCH_KINDS.has(context.agentKind)) {
    return {}
  }
  const named = aprioriReferenceBranches(context.aprioriBranches)
  // Drop any that collide with the resolved work branch (a reference and the working branch are
  // disjoint by the write boundary, but never fetch/announce the branch the agent builds on).
  const candidates = named.filter((b) => b !== workBranch)
  let present: string[]
  if (deps.ensureWorkBranch) {
    const probe = deps.ensureWorkBranch
    const existence = await Promise.all(candidates.map((b) => probe(repo, b, { create: false })))
    present = candidates.filter((_b, i) => existence[i])
  } else {
    present = candidates
  }
  if (present.length === 0) {
    return {}
  }
  return {
    referenceBranches: present,
    referenceBranchesSection: renderReferenceBranchesSection(present, { multiRepo }),
  }
}

/**
 * The auxiliary checkouts a dispatch carries beside its primary repo, resolved together: the
 * multi-repo fan-out, the conflict-resolver's peer targeting, the merger's combined-diff siblings,
 * and the read-only reference repos/branches. Moved here from `ContainerAgentExecutor` (which was
 * at its size budget) to sit with the resolvers it composes.
 *
 * It resolves REPOS, never `common`: it returns the repo spec that should override `common.repo`
 * plus the `repoTargets` every leg landed on, and the caller applies both once the job token is
 * minted. That ordering is the point: the token is narrowed to exactly these repos
 * ({@link jobTokenRepoIds}), so it cannot be minted until the legs are known, and `common` (which
 * carries the token) cannot be built until then either.
 */
export async function resolveAuxiliaryRepos(
  context: AgentRunContext,
  args: {
    workspaceId: string
    blockId: string
    repo: RepoTarget
    workBranch: string
  },
  deps: ContainerAgentExecutorDependencies,
  agentKindRegistry: AgentKindRegistry,
): Promise<{
  peerRepos?: { repo: Record<string, unknown>; frameId?: string; cloneBranch?: string }[]
  multiRepoSection?: string
  repoSpecOverride?: Record<string, unknown>
  repoForKind: RepoTarget
  referenceRepos?: { repo: Record<string, unknown> }[]
  referenceReposSection?: string
  referenceBranches?: string[]
  referenceBranchesSection?: string
  /** Every repo the job's legs touch, for the token scope. Excludes the primary (the caller has it). */
  repoTargets: RepoTarget[]
}> {
  const { workspaceId, blockId, repo, workBranch } = args
  // Multi-repo fan-out (coder / ci-fixer over connected involved services): peer sibling
  // checkouts + the layout section + the root-cwd repo-spec swap. See {@link resolveMultiRepoFanout}.
  const fanout = await resolveMultiRepoFanout(
    context,
    { workspaceId, blockId, repo },
    deps,
    agentKindRegistry,
  )
  let peerRepos = fanout.peerRepos
  let multiRepoSection = fanout.multiRepoSection
  let repoSpecOverride = fanout.repoSpecOverride
  const repoTargets = [...fanout.repoTargets]
  // The repo target the per-kind body builds against: the task's own service by default, but
  // swapped to a PEER repo when the conflicts gate targets the conflict-resolver at a connected
  // service (see {@link resolveConflictResolverPeer}). No-op (undefined) for an own-repo conflict.
  let repoForKind = repo
  const conflict = await resolveConflictResolverPeer(context, { workspaceId, blockId, repo }, deps)
  if (conflict) {
    repoForKind = conflict.repoForKind
    repoSpecOverride = conflict.repoSpecOverride
    repoTargets.push(conflict.repoForKind)
  }

  // Merger combined-diff: clone every peer PR's repo as a read-only sibling at its PR branch and
  // name the sibling diff commands. Overrides the fan-out peers/section when it fires (undefined
  // otherwise, leaving the fan-out result to stand). See {@link resolveMergerCombinedDiff}.
  const merger = await resolveMergerCombinedDiff(
    context,
    { workspaceId, blockId, repo, workBranch },
    deps,
  )
  if (merger) {
    peerRepos = merger.peerRepos
    multiRepoSection = merger.multiRepoSection
    // Additive, not a replacement: the fan-out's peers stopped riding the BODY, but the token was
    // already going to be scoped to whatever this dispatch resolved, and a leg dropped from the
    // scope is a clone the harness cannot make.
    repoTargets.push(...merger.repoTargets)
  }

  // Read-only reference repos + apriori reference branches: both independent of the fan-out above.
  // The branch flag reflects whether the job is already multi-repo (a fan-out section OR a
  // reference-repo section is present).
  const references = resolveReferenceRepos(context, repo, deps)
  repoTargets.push(...references.repoTargets)
  const { referenceBranches, referenceBranchesSection } = await resolveReferenceBranches(
    context,
    { repo, workBranch, multiRepo: Boolean(multiRepoSection || references.referenceReposSection) },
    deps,
  )

  return {
    ...(peerRepos ? { peerRepos } : {}),
    ...(multiRepoSection ? { multiRepoSection } : {}),
    ...(repoSpecOverride ? { repoSpecOverride } : {}),
    repoForKind,
    ...(references.referenceRepos ? { referenceRepos: references.referenceRepos } : {}),
    ...(references.referenceReposSection
      ? { referenceReposSection: references.referenceReposSection }
      : {}),
    ...(referenceBranches ? { referenceBranches } : {}),
    ...(referenceBranchesSection ? { referenceBranchesSection } : {}),
    repoTargets,
  }
}
