import type { BlockRepository, EnvironmentRegistryRepository } from '@cat-factory/kernel'
import { ConflictError, NotFoundError, PREVIEW_HARNESS_JOB_ID } from '@cat-factory/kernel'
import type { FrontendBranch } from '@cat-factory/contracts'
import type { BuildPreviewJob, PreviewJobPlan } from '@cat-factory/orchestration'
import {
  boundServiceFrameIds,
  indexLiveServiceEnvUrls,
  resolveFrontendBindings,
} from '@cat-factory/orchestration'
import { buildFrontendInfraSpec } from '../agents/prompts.js'
import type {
  MintInstallationToken,
  RepoTarget,
  ResolveRepoOrigin,
  ResolveRepoTarget,
} from '../agents/ContainerAgentExecutor.js'
import type { ContainerSessionService } from '../containers/ContainerSessionService.js'

// Builds the harness `mode: 'preview'` job for a `frontend` frame — the server-layer half of
// slice 5c. It mirrors the slice of `ContainerAgentExecutor.buildJobBody` a preview needs
// (resolve the frame's repo + a GitHub token + a proxy session token, then the frontend infra
// spec) but runs NO agent, so it carries none of the model-routing / prompt machinery. The
// facade wires this next to where it builds the ContainerAgentExecutor (same seams); the
// runtime-neutral PreviewService drives the resulting plan through a PreviewTransport.

/** The git origin (clone URL + provider) for a preview's repo; defaults to github.com. */
const githubRepoOrigin: ResolveRepoOrigin = (repo) => ({
  cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
  provider: 'github',
})

export interface PreviewJobBuilderDependencies {
  blockRepository: BlockRepository
  /** Resolve which repo (and installation) the frame targets — same seam the executor uses. */
  resolveRepoTarget: ResolveRepoTarget
  /** Mint a short-lived GitHub installation token for cloning the frontend repo. */
  mintInstallationToken: MintInstallationToken
  /** Resolve the repo's clone URL + VCS provider (GitLab local mode injects its own). */
  resolveRepoOrigin?: ResolveRepoOrigin
  /**
   * Mints the harness proxy session token. A preview runs NO agent, but the harness's job
   * parser still requires `proxyBaseUrl` + `sessionToken` (it validates auth before dispatch),
   * so we mint a benign, model-agnostic session — it is never used for an LLM call.
   */
  sessionService: ContainerSessionService
  /** Public base URL of the facade's LLM proxy (echoed into the harness auth). */
  proxyBaseUrl: string
  /** GitHub REST base, when the deployment targets a non-default host. */
  githubApiBase?: string
  /**
   * Reads live ephemeral-env rows so a `service` binding resolves to its live URL (an
   * `EnvironmentRecord` already carries `frameId`/`url`/`status`/`createdAt`, so the raw registry
   * repo is enough — it is available before `createCore`, unlike the env module's service).
   */
  environmentRegistryRepository?: EnvironmentRegistryRepository
}

/**
 * Resolve the branch a preview is built from (the `frontendConfig.branch`):
 *   - `default` / absent → the repo's default branch (the baseline).
 *   - `{ kind: 'task', fromTaskBlockId }` → that task's PR branch when it has one, else the
 *     repo default (the branch may not exist on the remote yet — never point the clone at a ref
 *     that isn't there).
 */
async function resolveBranch(
  branch: FrontendBranch | undefined,
  repo: RepoTarget,
  workspaceId: string,
  blockRepository: BlockRepository,
): Promise<string> {
  if (!branch || branch.kind === 'default') return repo.baseBranch
  const task = await blockRepository.get(workspaceId, branch.fromTaskBlockId)
  return task?.pullRequest?.branch ?? repo.baseBranch
}

/**
 * Build the {@link BuildPreviewJob} seam for a facade. Throws a `NotFoundError` for an unknown
 * frame, a `ConflictError` for a non-`frontend` frame / one without a `frontendConfig`, or a
 * `ConflictError` when no repo is connected — all mapped to a clean 4xx by the controller.
 */
export function makePreviewJobBuilder(deps: PreviewJobBuilderDependencies): BuildPreviewJob {
  return async ({ workspaceId, frameId }): Promise<PreviewJobPlan> => {
    const frame = await deps.blockRepository.get(workspaceId, frameId)
    if (!frame) throw new NotFoundError('frame', frameId)
    if (frame.level !== 'frame' || frame.type !== 'frontend' || !frame.frontendConfig) {
      throw new ConflictError(
        'A browsable preview is only available for a frontend frame with a frontend config.',
      )
    }
    const config = frame.frontendConfig

    // Resolve each backend binding to a live service env URL (else WireMock) — the SAME
    // frame-keyed, single-read resolution the UI-test flow uses (no per-binding point read).
    const serviceFrameIds = boundServiceFrameIds(config)
    const handles =
      deps.environmentRegistryRepository && serviceFrameIds.size > 0
        ? await deps.environmentRegistryRepository.listByWorkspace(workspaceId)
        : []
    const bindings = resolveFrontendBindings(
      config,
      indexLiveServiceEnvUrls(handles, serviceFrameIds),
    )
    const infra = buildFrontendInfraSpec({ config, bindings })
    const servePort = infra.servePort as number

    const repo = await deps.resolveRepoTarget(workspaceId, frameId)
    if (!repo) {
      throw new ConflictError('No connected GitHub repository was found for this frontend frame.')
    }
    const ghToken = await deps.mintInstallationToken(repo.installationId)
    const origin = (deps.resolveRepoOrigin ?? githubRepoOrigin)(repo)
    const branch = await resolveBranch(config.branch, repo, workspaceId, deps.blockRepository)

    // A preview runs no agent, so the session is model-agnostic and never used for an LLM
    // call — it exists only to satisfy the harness's auth parser (proxyBaseUrl + sessionToken).
    const sessionToken = await deps.sessionService.mint({
      workspaceId,
      executionId: `preview-${frameId}`,
      agentKind: 'preview',
      provider: 'none',
      model: 'none',
    })

    const spec: Record<string, unknown> = {
      jobId: PREVIEW_HARNESS_JOB_ID,
      mode: 'preview',
      harness: 'pi',
      proxyBaseUrl: deps.proxyBaseUrl,
      sessionToken,
      ghToken,
      repo: {
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        cloneUrl: origin.cloneUrl,
        provider: origin.provider,
        ...(repo.serviceDirectory ? { serviceDirectory: repo.serviceDirectory } : {}),
      },
      branch,
      infra,
      ...(deps.githubApiBase ? { githubApiBase: deps.githubApiBase } : {}),
    }
    return { jobId: PREVIEW_HARNESS_JOB_ID, spec, servePort }
  }
}
