import {
  type AgentRunResult,
  type Block,
  type BlockRepository,
  type Clock,
  type IssueWritebackProvider,
  type Logger,
  type ExecutionInstance,
  type PipelineStep,
  type TicketTrackerProvider,
  getErrorMessage,
  runBestEffort,
} from '@cat-factory/kernel'
import { commitInitiativeTracker } from '@cat-factory/agents'
import type { BugIntakeOutcome, BugIntakeService } from '@cat-factory/integrations'
import { ANALYSIS_AGENT_KIND } from './ci.logic.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunRepoOpsController } from './RunRepoOpsController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'
import type { InitiativeService } from '../initiative/InitiativeService.js'

/**
 * Collaborators + the one bound dispatcher call-back the {@link OneShotStepController} needs, so
 * a one-shot step still records its result against the SAME dispatcher state the inline code did.
 */
export interface OneShotStepControllerDeps {
  blockRepository: BlockRepository
  clock: Clock
  contextBuilder: AgentContextBuilder
  log: Logger
  repoOps: RunRepoOpsController
  runStateMachine: RunStateMachine
  stepGraph: StepGraph
  bugIntakeService?: BugIntakeService
  initiativeService?: InitiativeService
  issueWriteback?: IssueWritebackProvider
  ticketTrackerProvider?: TicketTrackerProvider
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
}

/**
 * The ONE-SHOT engine steps (CLAUDE.md's step taxonomy): the kinds the engine performs itself in
 * a single deterministic pass with no LLM, no container and no poll-or-escalate loop — `tracker`
 * files a ticket, `bug-intake` claims one and seeds the block from it, `initiative-committer`
 * persists an approved plan and mirrors it into the repo. (`deployer`, the fourth, already has
 * its own {@link DeployerStepController}.)
 *
 * Extracted from {@link RunDispatcher} as a cohesive collaborator taking a deps object of bound
 * dispatcher call-backs, so the dispatcher keeps the run state machine and this file keeps the
 * bespoke steps that ride it.
 */
export class OneShotStepController {
  constructor(private readonly deps: OneShotStepControllerDeps) {}

  /**
   * File a tracking issue/ticket for a `tracker` step from the preceding `analysis`
   * output. Non-LLM and best-effort: when no provider is wired or none is configured
   * for the workspace it simply notes the skip; a filing error is folded into the
   * step output rather than failing the run (the implementation still proceeds).
   */
  async runTracker(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<AgentRunResult> {
    if (!this.deps.ticketTrackerProvider) {
      return { output: 'No issue tracker configured; skipped ticket creation.' }
    }
    // The report to file is the closest preceding `analysis` output, falling back
    // to the block description when the pipeline has no analysis step.
    const analysis = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.agentKind === ANALYSIS_AGENT_KIND && s.output)
      .map((s) => s.output as string)
      .pop()
    const body = (analysis ?? block.description ?? '').trim() || 'Automated tech-debt remediation.'
    const frameId =
      (await this.deps.contextBuilder.resolveServiceFrameId(workspaceId, block.id)) ?? block.id
    try {
      const ticket = await this.deps.ticketTrackerProvider.createTicket({
        workspaceId,
        frameId,
        title: `Tech debt: ${block.title}`,
        body,
      })
      if (!ticket) {
        return { output: 'No issue tracker configured; skipped ticket creation.' }
      }
      return { output: `Filed tracking ticket ${ticket.externalId}: ${ticket.url}` }
    } catch (error) {
      return { output: `Could not file a tracking ticket: ${getErrorMessage(error)}` }
    }
  }

  /**
   * Run a `bug-intake` step — the recurring bug-triage pipeline's inbound dual of `tracker`
   * (design §3). Pull ONE matching open issue from the schedule's configured tracker board,
   * claim it (import + replace-link onto the reused block, mark it in-progress + comment), and
   * seed the block's title/description from it so every downstream step works THAT bug. When
   * nothing matches — or no task source is wired — the run completes SUCCESSFULLY with every
   * remaining step skipped (there is nothing to investigate / reproduce / fix), no notification.
   * Best-effort throughout: the intake helper never throws (a tracker outage resolves to a
   * no-op), and the pickup writeback is fire-and-forget.
   */
  async runBugIntake(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const outcome: BugIntakeOutcome = this.deps.bugIntakeService
      ? await this.deps.bugIntakeService.pickForBlock(workspaceId, block.id)
      : { picked: null, summary: 'Issue intake is not configured on this deployment.' }

    if (!outcome.picked) {
      return this.completeRunSkippingRemaining(workspaceId, instance, step, outcome.summary)
    }

    const pickup = outcome.picked
    // Seed the reused recurring block from the picked issue so each fire works a different bug
    // through the same block (the same block-seeding `createTaskFromIssue` does, applied in place).
    // Clear the previous fire's peer PRs too — this fire works a DIFFERENT bug, so a prior bug's
    // connected-repo PRs must not linger on the block. (The own-service `pullRequest` is overwritten
    // by this run's coder step before any step reads it; it is a non-nullable `BlockPatch` field, so
    // it cannot be cleared here anyway.)
    await this.deps.blockRepository.update(workspaceId, block.id, {
      title: pickup.seedTitle,
      description: pickup.seedDescription,
      peerPullRequests: [],
    })
    // Best-effort: claim the issue where it was filed (in-progress mark + "taken by cat-factory"
    // comment). Fire-and-forget — a tracker hiccup must never fail the run, mirroring the PR
    // open/merge writeback hooks; and unlike them this is NOT gated on the writeback settings.
    const writeback = this.deps.issueWriteback
    if (writeback) {
      await runBestEffort(
        this.deps.log,
        'writeback.onIssuePickedUp',
        () =>
          writeback.onIssuePickedUp(
            workspaceId,
            block.id,
            pickup.inProgressLabel ? { inProgressLabel: pickup.inProgressLabel } : {},
          ),
        { workspaceId, executionId: instance.id, blockId: block.id },
      )
    }
    return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
      output: pickup.summary,
    })
  }

  /**
   * Complete the run successfully after a `bug-intake` step found no issue to work: record the
   * intake step's own no-match output (it SUCCEEDED — it made the decision), then mark every
   * REMAINING step `skipped` and finalize the reused block `done`, with NO notification (the
   * outcome is visible in the schedule's run history).
   *
   * The block is finalized `done` DIRECTLY here rather than through `RunStateMachine.finalizeBlock`:
   * for a mergerless task block (every bug-triage pipeline) finalizeBlock's terminal branch treats
   * the run as "work complete but unmerged" — it flips the block `pr_ready` and raises a
   * `pipeline_complete` "confirm + merge the PR" notification. This fire did NO work and opened NO
   * PR, so that card would be spurious (and its payload would reference a STALE PR carried over from
   * a prior fire). Setting the terminal status inline keeps the no-op silent, as documented.
   */
  private async completeRunSkippingRemaining(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    summary: string,
  ): Promise<AdvanceResult> {
    step.output = summary
    step.progress = 1
    step.subtasks = undefined
    this.deps.stepGraph.finishStep(step)
    for (let i = instance.currentStep + 1; i < instance.steps.length; i++) {
      const remaining = instance.steps[i]
      if (!remaining) continue
      remaining.skipped = true
      remaining.output = ''
      remaining.progress = 1
      remaining.subtasks = undefined
      this.deps.stepGraph.finishStep(remaining)
    }
    instance.currentStep = instance.steps.length - 1
    instance.status = 'done'
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (block && block.status !== 'done') {
      await this.deps.blockRepository.update(workspaceId, instance.blockId, {
        status: 'done',
        progress: 1,
      })
    }
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
    await this.deps.runStateMachine.stopRunContainer(workspaceId, instance)
    return { kind: 'done' }
  }

  /**
   * Persist an APPROVED initiative plan for an `initiative-committer` step: flip the
   * entity to `executing` and mirror the tracker into the repo's default branch
   * (`docs/initiatives/<slug>/`) via the checkout-free {@link RepoFiles}. Deterministic,
   * no LLM. REPLAY-SAFE: the tracker commit hash-short-circuits (an unchanged entity
   * commits nothing) and `markExecuting` is content-idempotent, so a durable-driver
   * replay re-enters harmlessly. The repo mirror is skipped gracefully when GitHub
   * isn't wired (the DB entity stays the source of truth); a missing entity or an
   * empty plan is a REAL failure — completing the run would strand the initiative in
   * `planning` behind a green run.
   */
  async runInitiativeCommitter(
    workspaceId: string,
    block: Block,
  ): Promise<{ kind: 'ok'; result: AgentRunResult } | { kind: 'failed'; error: string }> {
    if (!this.deps.initiativeService) {
      return { kind: 'failed', error: 'Initiative module is not wired on this deployment.' }
    }
    const initiative = await this.deps.initiativeService.getByBlock(workspaceId, block.id)
    if (!initiative) {
      return { kind: 'failed', error: 'No initiative entity found for this block.' }
    }
    if ((initiative.items ?? []).length === 0) {
      return {
        kind: 'failed',
        error: 'No approved plan to commit — the planner produced no usable items.',
      }
    }

    // Resolve the run repo BEFORE flipping status. `resolveRunRepo` returns null only when
    // GitHub is entirely unwired (skip the mirror gracefully — the DB entity stays the source
    // of truth), but it THROWS for a GitHub-connected workspace whose frame isn't linked to a
    // repo (`resolveRepoTarget` fails loudly rather than guessing one). Doing it first means
    // such a misconfiguration aborts the committer with the entity still truthfully
    // `awaiting_approval` — instead of flipping to `executing` and THEN throwing, which would
    // fail the run while leaving a committed status whose plan never got mirrored (a lie).
    const runRepo = await this.deps.repoOps.resolveRunRepo(workspaceId, block.id)

    // Now flip to `executing` and render the tracker from the flipped entity — the committed
    // mirror (and its content hash) must record the REAL `executing` status. Committing the
    // pre-flip entity would bake a stale `awaiting_approval` status into
    // `initiative.json`/`tracker.md` that nothing re-commits in this slice, AND would break
    // replay-safety: a durable-driver replay re-reads the now-`executing` entity, whose hash
    // no longer matches the committed `version.json`, so the no-change short-circuit would miss
    // and re-commit. `markExecuting` is a committed CAS write that still runs before the git
    // side effect, so a CAS conflict aborts before any commit lands (no orphaned tracker commit).
    const executing =
      (await this.deps.initiativeService.markExecuting(workspaceId, block.id, null)) ?? initiative

    let doc: { version: number; hash: string } | null = null
    let mirror = 'Repo tracker mirror skipped (GitHub not connected).'
    if (runRepo) {
      doc = await commitInitiativeTracker(
        runRepo.repo,
        runRepo.baseBranch,
        executing,
        new Date(this.deps.clock.now()),
      )
      mirror = doc
        ? `Committed docs/initiatives/${executing.slug}/ (v${doc.version}) to ${runRepo.baseBranch}.`
        : `Tracker already up to date in docs/initiatives/${executing.slug}/.`
      // Stamp the committed version/hash back onto the entity (content-unchanged tick ⇒
      // no commit ⇒ nothing to stamp, so a replay skips this second write too).
      if (doc) await this.deps.initiativeService.markExecuting(workspaceId, block.id, doc)
    }

    const phases = (executing.phases ?? []).length
    const items = (executing.items ?? []).length
    return {
      kind: 'ok',
      result: {
        output:
          `Initiative plan approved: ${phases} phase${phases === 1 ? '' : 's'}, ` +
          `${items} item${items === 1 ? '' : 's'}. ${mirror}`,
      },
    }
  }
}
