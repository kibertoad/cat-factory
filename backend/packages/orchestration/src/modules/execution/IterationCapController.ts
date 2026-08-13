import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  IterationCapChoice,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, ConflictError, NotFoundError } from '@cat-factory/kernel'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/**
 * What the iteration-cap resolution needs. `cancelRun` and `inferBlockTechnical` arrive as bound
 * call-backs: the first belongs to the run-lifecycle surface and the second is shared with the
 * gate-window wiring, so neither is this controller's to own.
 */
export interface IterationCapDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  runStateMachine: RunStateMachine
  stepGraph: StepGraph
  workRunner: WorkRunner
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  cancelRun: (workspaceId: string, blockId: string) => Promise<unknown>
  inferBlockTechnical: (
    workspaceId: string,
    block: Block,
    producer: PipelineStep,
    companionStep: PipelineStep,
  ) => Promise<void>
}

/**
 * The three-way ITERATION-CAP resolution a run parks for when an automatic rework loop has spent
 * its budget: grant one more round, proceed on what the producer has, or stop and reset the task.
 *
 * One controller because the choice is uniform across gates while only the extra-round and proceed
 * handlers differ: `dispatchIterationCap` owns the shared shape (and the `stop-reset` branch, which
 * is identical everywhere), the requirements gate supplies its handlers through
 * `ReviewGateController`, and the companion gate's are `resolveCompanionExceeded` below. Splitting
 * them would put the one branch nobody parameterises in two places.
 *
 * `ExecutionService` keeps thin delegates, so no HTTP call site and no gate-window wiring changed.
 */
export class IterationCapController {
  constructor(private readonly deps: IterationCapDeps) {}

  /**
   * Route an iteration-cap resolution to its gate-specific handlers. `stop-reset` is
   * uniform across gates: cancel the run and return the block to phase zero (editable),
   * keeping whatever reference artifact each gate persists (the requirements doc on its
   * own table; a companion's producer output on its branch). Shared by the requirements
   * gate (`requirementsReview.resolveExceeded`, via {@link ReviewGateController}) and the
   * companion gate ({@link resolveCompanionExceeded}) so the three-way choice lives in one place.
   */
  async dispatchIterationCap(
    workspaceId: string,
    blockId: string,
    choice: IterationCapChoice,
    handlers: { extraRound: () => Promise<unknown>; proceed: () => Promise<unknown> },
  ): Promise<void> {
    if (choice === 'extra-round') {
      await handlers.extraRound()
    } else if (choice === 'proceed') {
      await handlers.proceed()
    } else {
      // stop-reset: tear down the run + reset the block to phase zero (editable).
      await this.deps.cancelRun(workspaceId, blockId)
    }
  }

  /**
   * Resolve a companion step parked at its automatic-rework cap (`companion.exceeded`):
   * grant one more round, proceed accepting the producer's current output, or stop the
   * task and reset it to phase zero. The companion mirror of the requirements
   * iteration-cap resolution (`requirementsReview.resolveExceeded`), sharing the iteration-cap dispatch + the
   * gate-resume plumbing. Idempotent — an already-resolved gate returns the instance
   * unchanged. Scoped by execution + approval id (the execution controller surface),
   * since a companion gate is not block-addressed like the requirements window.
   */
  async resolveCompanionExceeded(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    choice: IterationCapChoice,
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    // Optimistic-concurrency human-action write (race-audit 2.2 controller-half): both non-cancel
    // branches persist under `mutateInstance` (load fresh → re-find the gate → mutate → CAS), so a
    // concurrent driver poll — or a `stopRun`/`cancel` racing this resolve — can't be clobbered by a
    // blind full-row upsert, and a cancelled run is never resurrected. The pure in-memory mutation
    // runs inside the CAS; the non-idempotent side effects (block writes, `technical` inference,
    // driver signal, emit) run once after, on the winning snapshot — the same pure/side-effect split
    // `approveStep` and the review gate-resume use. The validation snapshot below gives a fast
    // 404/409 (and the idempotent already-resolved early return).
    const snapshot = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const snapStep = snapshot.steps.find((s) => s.approval?.id === approvalId)
    if (!snapStep || !snapStep.approval) throw new NotFoundError('Approval', approvalId)
    if (!snapStep.companion?.exceeded) {
      throw new ConflictError(`Approval '${approvalId}' is not a companion iteration-cap gate`)
    }
    if (snapStep.approval.status === 'approved') return snapshot

    // The state the caller sees: the winning post-mutation snapshot for extra-round/proceed, or
    // the pre-cancel snapshot for stop-reset (the run row is deleted, so there's nothing to re-read).
    let result = snapshot
    await this.dispatchIterationCap(workspaceId, snapshot.blockId, choice, {
      // Grant one more automatic rework: raise the budget by one, clear the cap flag, then loop
      // the producer back through the companion to re-grade (`loopCompanionProducer` re-arms the
      // run `running`). The last verdict's feedback drives the rework.
      extraRound: async () => {
        let signalId: string | undefined
        const persisted = await this.deps.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          (inst) => {
            const i = inst.steps.findIndex((s) => s.approval?.id === approvalId)
            const s = inst.steps[i]
            if (!s?.companion || !s.approval) throw new NotFoundError('Approval', approvalId)
            // Another writer already resolved this gate: no-op (idempotent) and skip the signal.
            if (s.approval.status === 'approved') {
              signalId = undefined
              return
            }
            s.companion.maxAttempts += 1
            s.companion.exceeded = undefined
            // Cleared with it: `stalled` describes the round that PARKED, and a person has just
            // said to try again. Left set it would outlive the standstill it recorded and claim
            // the loop was abandoned on a run that went on to converge. It is recomputed from the
            // next cycle's own evidence, so re-arming costs nothing if the standstill persists.
            s.companion.stalled = undefined
            const producer = inst.steps[this.deps.stepGraph.companionProducerIndex(inst, i)]
            // Capture the approval id BEFORE `loopCompanionProducer`: it resets the companion
            // step for re-run (`resetStepForRerun`), which NULLS `s.approval`, so reading
            // `s.approval.id` after would throw. The signal targets the gate's original approval.
            signalId = s.approval.id
            this.deps.stepGraph.loopCompanionProducer(inst, i, {
              previousProposal: producer?.output ?? '',
              feedback: s.companion.verdicts.at(-1)?.feedback ?? '',
              // A human GRANTED the round, but the feedback the producer must answer is the
              // companion's last verdict, so that is who it is answering.
              requestedBy: 'reviewer',
            })
          },
        )
        result = persisted
        if (!signalId) return
        await this.deps.runStateMachine.updateBlockProgress(workspaceId, persisted, 'in_progress')
        await this.deps.workRunner.signalDecision(
          workspaceId,
          persisted.id,
          signalId,
          'extra-round',
        )
        await this.deps.runStateMachine.emitInstance(workspaceId, persisted)
      },
      // Proceed: accept the producer's current output and advance past the gate.
      proceed: async () => {
        let stepIndex = -1
        const persisted = await this.deps.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          (inst) => {
            stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)
            const s = inst.steps[stepIndex]
            if (!s?.companion || !s.approval) throw new NotFoundError('Approval', approvalId)
            if (s.approval.status === 'approved') {
              stepIndex = -1
              return
            }
            s.companion.exceeded = undefined
            s.approval.status = 'approved'
            this.deps.runStateMachine.advanceRunPastGate(inst, stepIndex)
          },
        )
        result = persisted
        if (stepIndex === -1) return
        // The spec-companion never reached its automatic PASS branch, but both signals are
        // persisted (the producer's `noBusinessSpecs` + this step's `technicalCorroborated`),
        // so infer the block's `technical` label here too — best-effort, human-authority
        // preserved — before settling the advance.
        const step = persisted.steps[stepIndex]!
        if (step.agentKind === 'spec-companion') {
          const producer =
            persisted.steps[this.deps.stepGraph.companionProducerIndex(persisted, stepIndex)]
          const block = await this.deps.blockRepository.get(workspaceId, persisted.blockId)
          if (producer && block)
            await this.deps.inferBlockTechnical(workspaceId, block, producer, step)
        }
        await this.deps.runStateMachine.settleAdvancedGate(workspaceId, persisted, stepIndex)
      },
    })
    return result
  }
}
