import type {
  AgentRunContext,
  AgentRunResult,
  AgentStepSpec,
  Block,
  BlockRepository,
  ExecutionInstance,
  IssueWritebackProvider,
  PipelineStep,
  RepoFiles,
  RepoOp,
  ResolveRunRepoContext,
  RunRepoContext,
} from '@cat-factory/kernel'
import { type PullRequestRef, resolveAprioriWorkingBranch } from '@cat-factory/contracts'
import { blueprintPostOp, runRepoOps, specPostOp } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import { BLUEPRINTS_AGENT_KIND, MERGER_AGENT_KIND, SPEC_WRITER_AGENT_KIND } from './ci.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'

/**
 * Whether a run delivers a committing kind's artifact through a PULL REQUEST rather than a
 * direct commit — true when the pipeline carries a `merger` step to merge that PR. Threaded to
 * the pre/post-op {@link RepoOpContext} so a delivering kind (e.g. `spike`) follows the chosen
 * pipeline's shape (PR tail ⇒ open a PR; no tail ⇒ commit direct) with no separate per-task flag
 * to drift. Mirrors {@link RunStateMachine.finalizeBlock}'s `hasMerger` distinction.
 */
function runOpensPr(instance: ExecutionInstance): boolean {
  return instance.steps.some((s) => s.agentKind === MERGER_AGENT_KIND)
}

/** Collaborators the {@link RunRepoOpsController} needs. */
export interface RunRepoOpsControllerDeps {
  blockRepository: BlockRepository
  contextBuilder: AgentContextBuilder
  agentKindRegistry: AgentKindRegistry
  resolveRunRepoContext?: ResolveRunRepoContext
  issueWriteback?: IssueWritebackProvider
}

/**
 * Runs a registered / built-in agent kind's deterministic backend repo hooks (`preOps` /
 * `postOps`) over a checkout-free {@link RepoFiles}, resolving the concrete branch each hook
 * reads or writes so it operates on the SAME branch the container agent does. Extracted from
 * {@link RunDispatcher} as a cohesive collaborator (the branch-resolution + hook-execution
 * seam); the dispatcher delegates its pre/post-op call sites here.
 */
export class RunRepoOpsController {
  private readonly blockRepository: BlockRepository
  private readonly contextBuilder: AgentContextBuilder
  private readonly agentKindRegistry: AgentKindRegistry
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  private readonly issueWriteback?: IssueWritebackProvider

  constructor(deps: RunRepoOpsControllerDeps) {
    this.blockRepository = deps.blockRepository
    this.contextBuilder = deps.contextBuilder
    this.agentKindRegistry = deps.agentKindRegistry
    this.resolveRunRepoContext = deps.resolveRunRepoContext
    this.issueWriteback = deps.issueWriteback
  }

  /**
   * Resolve the concrete branch a registered kind's pre/post-op reads or writes, from
   * its declared clone target — mirroring the container executor's mapping so a backend
   * op and the container agent operate on the SAME branch:
   *   - `base` → the repo default branch (the ONLY way a committing op targets `main`).
   *   - `pr`   → the block's PR branch (the coder's branch); when no PR is open, the
   *              per-block work branch (created from base if missing) — NOT base, so a
   *              committing post-op can't silently land on the default branch.
   *   - `work` (default) → the per-block work branch, ENSURED to exist exactly as
   *              {@link ContainerAgentExecutor}'s `ensureWorkBranch` does. The old code
   *              returned base here whenever no PR was open yet, diverging from the
   *              container agent (which clones `cat-factory/<blockId>`) and letting a
   *              post-op commit onto the default branch.
   * The work-branch name (`cat-factory/<blockId>`) is the same convention
   * {@link ContainerAgentExecutor} uses.
   */
  private async resolveRepoOpBranch(
    step: AgentStepSpec | undefined,
    block: Block,
    runRepo: RunRepoContext,
  ): Promise<string> {
    const { repo, baseBranch } = runRepo
    const prBranch = block.pullRequest?.branch
    // An apriori WORKING branch overrides the deterministic work branch: the backend op must
    // read/write the SAME branch the container agent builds inside. It is probe-only (a
    // missing branch fails loudly, never a silent create — the mirror of the executor).
    const aprioriWork = this.aprioriWorkBranch(block, baseBranch)
    const workBranch = aprioriWork ?? `cat-factory/${block.id}`
    switch (step?.clone?.branch) {
      case 'base':
        return baseBranch
      case 'pr':
      // `pr-or-work` reads/writes the PR branch when one exists (amend in place), else the work
      // branch — the same resolution as `pr`, so it shares this arm.
      case 'pr-or-work':
        return prBranch ?? (await this.ensureWorkBranch(repo, workBranch, baseBranch, aprioriWork))
      default:
        // 'work' (or unspecified): the work branch the container agent operates on. A PR
        // is normally opened on that branch, but even before one exists we ensure it so
        // the backend op and the container agent share the same branch.
        return prBranch && prBranch !== workBranch
          ? prBranch
          : await this.ensureWorkBranch(repo, workBranch, baseBranch, aprioriWork)
    }
  }

  /**
   * The task's apriori WORKING branch (an existing branch it names as the run's starting
   * point), or undefined when none is set. Rejects the degenerate case where it equals the
   * repo base — the run would have nothing to diff / no PR to open — via the same shared
   * `resolveAprioriWorkingBranch` guard the executor uses, so the two rejections can't drift.
   */
  private aprioriWorkBranch(block: Block, baseBranch: string): string | undefined {
    return resolveAprioriWorkingBranch(block.aprioriBranches, baseBranch)
  }

  /**
   * Ensure the per-block work branch `cat-factory/<blockId>` exists — creating it from the
   * repo default branch's head when absent — and return it. The checkout-free analogue of
   * {@link ContainerAgentExecutor}'s `ensureWorkBranch`, so a backend pre/post-op writes
   * the SAME branch the container agent does instead of the default branch. Falls back to
   * the base branch only when the repo has no default-branch head to fork from (an empty
   * repo), so the caller always gets a real branch.
   *
   * `apriori` (the resolved apriori working branch name, when this run has one) flips the
   * behaviour to PROBE-ONLY: an apriori branch must pre-exist, so a missing one throws
   * loudly rather than being silently created off base (the mirror of the executor's rule).
   */
  private async ensureWorkBranch(
    repo: RepoFiles,
    workBranch: string,
    baseBranch: string,
    apriori?: string,
  ): Promise<string> {
    if (await repo.headSha(workBranch)) return workBranch
    if (apriori) {
      throw new Error(
        `Apriori working branch '${workBranch}' does not exist on the target repo; ` +
          `push it before starting the run (the platform never creates an apriori branch).`,
      )
    }
    const baseSha = await repo.headSha(baseBranch)
    if (!baseSha) return baseBranch
    await repo.createBranch(workBranch, baseSha)
    return workBranch
  }

  /**
   * Run a registered kind's PRE-op hooks before its agent step dispatches: deterministic
   * backend work (read a baseline artifact into the prompt, etc.) over a checkout-free
   * {@link RepoFiles}. No-op for built-in / unregistered kinds, when the kind declares no
   * pre-ops, or when GitHub isn't wired (no `resolveRunRepoContext`) — so the engine runs
   * unchanged without the feature. A throwing op propagates to fail the step.
   */
  async runRegisteredPreOps(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    step: PipelineStep,
    context: AgentRunContext,
  ): Promise<void> {
    const ops = this.agentKindRegistry.preOps(step.agentKind)
    if (ops.length === 0) return
    const runRepo = await this.resolveRunRepo(workspaceId, block.id)
    if (!runRepo) return
    const branch = await this.resolveRepoOpBranch(
      this.agentKindRegistry.agentStep(step.agentKind),
      block,
      runRepo,
    )
    await runRepoOps(ops, { repo: runRepo.repo, context, branch, opensPr: runOpensPr(instance) })
  }

  /**
   * Resolve a block's run-repo context for its pre/post-op hooks. Returns null only when
   * the resolver is UNWIRED (tests / GitHub not connected) so a deployment without the
   * feature simply skips the hooks. When the resolver IS wired, its result — including a
   * THROW from `resolveRepoTarget` for a block that isn't under a linked service — is
   * propagated as-is: a registered kind with repo hooks run on a misconfigured block fails
   * the run loudly rather than silently committing nothing (or guessing a repo), the same
   * way a container custom kind fails at dispatch.
   */
  async resolveRunRepo(workspaceId: string, blockId: string): Promise<RunRepoContext | null> {
    if (!this.resolveRunRepoContext) return null
    return this.resolveRunRepoContext(workspaceId, blockId)
  }

  /**
   * Run a registered kind's POST-op hooks after its agent step's result is recorded:
   * deterministic backend work that consumes the agent's structured output (coerce its
   * JSON, render artifact files, commit them via {@link RepoFiles}) — the
   * blueprint/spec rendering that used to live in the harness. Same gating + symmetry as
   * {@link runRegisteredPreOps}; the agent's {@link AgentRunResult} is threaded through.
   */
  async runRegisteredPostOps(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<void> {
    const registered = this.agentKindRegistry.postOps(step.agentKind)
    const builtIn = this.builtInPostOps(step.agentKind)
    if (registered.length === 0 && builtIn.length === 0) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    const runRepo = await this.resolveRunRepo(workspaceId, block.id)
    if (!runRepo) return
    const context = await this.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    const opensPr = runOpensPr(instance)
    // Registered (custom) kinds resolve their branch from their declared clone target.
    if (registered.length > 0) {
      const branch = await this.resolveRepoOpBranch(
        this.agentKindRegistry.agentStep(step.agentKind),
        block,
        runRepo,
      )
      const opResult = await runRepoOps(registered, {
        repo: runRepo.repo,
        context,
        branch,
        opensPr,
        result,
      })
      // A delivering kind (e.g. `spike` in PR mode) opened a PR for the findings; record it on
      // the block so the downstream conflicts/CI/human-review/merge tail acts on it — the SAME
      // linkage a container-coding step's `result.pullRequest` produces (see recordStepResult).
      if (opResult.pullRequest) {
        await this.recordPostOpPullRequest(workspaceId, block.id, opResult.pullRequest)
      }
    }
    // Built-in (migrated) kinds resolve their branch to MATCH their container dispatch
    // exactly (see {@link builtInRepoOpBranch}), which differs from the generic clone
    // resolution for the no-PR case — so the post-op commits where the agent read.
    if (builtIn.length > 0) {
      const branch = await this.builtInRepoOpBranch(step.agentKind, block, runRepo)
      await runRepoOps(builtIn, { repo: runRepo.repo, context, branch, opensPr, result })
    }
  }

  /**
   * Record a pull request a registered post-op opened onto the block, mirroring the
   * container-coding path in {@link recordStepResult}: set `block.pullRequest`, and (when newly
   * opened) fire the best-effort tracker-issue writeback. Idempotent — re-recording the same PR
   * (a durable-driver replay) writes the same ref and skips the non-idempotent writeback.
   */
  private async recordPostOpPullRequest(
    workspaceId: string,
    blockId: string,
    pullRequest: PullRequestRef,
  ): Promise<void> {
    const priorBlock = await this.blockRepository.get(workspaceId, blockId)
    if (priorBlock?.pullRequest?.url === pullRequest.url) return
    await this.blockRepository.update(workspaceId, blockId, { pullRequest })
    if (this.issueWriteback && priorBlock) {
      await this.issueWriteback
        .onPullRequestOpened(workspaceId, priorBlock, pullRequest)
        .catch(() => {})
    }
  }

  /**
   * The BUILT-IN (non-registry) post-ops for a migrated built-in kind, keyed by agent
   * kind — the deterministic render + commit lifted out of the executor-harness. Kept
   * OUT of the agent-kind registry on purpose: registering the built-ins would leak them
   * into `customAgentKinds` / the SPA palette. Empty for every other kind.
   */
  private builtInPostOps(agentKind: string): RepoOp[] {
    return RunRepoOpsController.BUILT_IN_POST_OPS[agentKind] ?? []
  }

  /**
   * The built-in (NON-registry) post-ops keyed by kind. A small map rather than an
   * `if`-chain so each migrated built-in is one entry as the strangler converts more
   * kinds; deliberately NOT the agent-kind registry (that would leak the built-ins into
   * `customAgentKinds` / the SPA palette).
   */
  private static readonly BUILT_IN_POST_OPS: Record<string, RepoOp[]> = {
    [BLUEPRINTS_AGENT_KIND]: [blueprintPostOp],
    [SPEC_WRITER_AGENT_KIND]: [specPostOp],
  }

  /**
   * The branch a built-in kind's post-op reads/commits, resolved to MATCH the kind's
   * container dispatch (so the post-op commits onto exactly the branch the explore agent
   * cloned).
   *  - blueprints clones the PR branch when one is open, else the repo's default branch —
   *    so the initial bootstrap map lands directly on the default branch, mirroring
   *    {@link ContainerAgentExecutor}'s `pr`-clone resolution (`prBranch ?? baseBranch`).
   *    Deliberately NOT {@link resolveRepoOpBranch}, whose `pr` case ensures a work branch
   *    for the no-PR case — correct for a committing CUSTOM kind, wrong for the blueprint.
   *  - spec-writer commits onto the per-block WORK branch (`cat-factory/<blockId>`), created
   *    from base when absent. It is a WRITER (not read-only), so its container dispatch
   *    always ensures + clones that work branch ({@link ContainerAgentExecutor}'s
   *    `workBranchReady ? workBranch : …` resolves to the work branch). We mirror that
   *    DETERMINISTICALLY here — NOT via {@link resolveRepoOpBranch}'s `work` case, whose
   *    PR-preferring branch would commit onto a divergent PR branch (read one tree, write
   *    another) if a PR were ever open on a branch other than `cat-factory/<blockId>`.
   */
  private async builtInRepoOpBranch(
    agentKind: string,
    block: Block,
    runRepo: RunRepoContext,
  ): Promise<string> {
    if (agentKind === SPEC_WRITER_AGENT_KIND) {
      // The spec-writer commits onto the run's WORK branch — the apriori working branch when
      // the task names one (probe-only, must pre-exist), else the deterministic per-block
      // branch. Miss this swap and the spec lands on a phantom `cat-factory/<blockId>` while
      // the agent explored the apriori branch.
      const aprioriWork = this.aprioriWorkBranch(block, runRepo.baseBranch)
      const workBranch = aprioriWork ?? `cat-factory/${block.id}`
      return this.ensureWorkBranch(runRepo.repo, workBranch, runRepo.baseBranch, aprioriWork)
    }
    return block.pullRequest?.branch ?? runRepo.baseBranch
  }
}
