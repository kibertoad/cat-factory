import type {
  BinaryCandidate,
  BinaryCandidateStepState,
  BlockRepository,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  KeepBinaryCandidatesInput,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  ConflictError,
  MAX_BINARY_CANDIDATES,
  parseBinaryCandidateDeclaration,
  ValidationError,
} from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

// ---------------------------------------------------------------------------
// The human-facing half of a binary-output step's CANDIDATE COMPARISON
// (docs/initiatives/binary-output-foundational-storage.md): record what the first pass staged,
// park for a person to compare the candidates side by side, and resolve their choice by re-running
// the SAME step with the kept candidates (and the alternate ids they assigned) folded into its
// brief.
//
// Shaped exactly like {@link ForkDecisionController}, because it is the same machine one subject
// over: a park BETWEEN two dispatches of one step, all state on `PipelineStep.binaryCandidates`
// with no side table, resolved through the standard durable decision-wait. What it deliberately
// does NOT copy is the chat: a fork choice is an argument about code that a person may need to
// interrogate, while a candidate choice is four pictures and an opinion, and a grounded chat about
// images the model cannot see again would be an expensive way to produce confident guesses.
// ---------------------------------------------------------------------------

/** What the candidate controller needs beyond the shared run state-machine spine. */
export interface BinaryCandidateControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  /** The async instance/block spine (park/advance/persist/emit/progress). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/reset a step). */
  stepGraph: StepGraph
  idGenerator: IdGenerator
  clock: Clock
  /** Optional inbox channel; when unwired the specific card is skipped and the generic
   *  waiting-notification the park itself raises still names the run. */
  notificationService?: NotificationService
}

export class BinaryCandidateController {
  constructor(private readonly deps: BinaryCandidateControllerDeps) {}

  /**
   * Record the first pass's staged candidates onto the step and decide the flow. Runs as the
   * completion interceptor's body, so it must return one of three things and each is a different
   * fact about the run:
   *
   * - **≥2 candidates** ⇒ park. This is what the comparison is for.
   * - **exactly 1** ⇒ keep it automatically and re-arm the step for the delivering pass. Nobody
   *   is asked to choose between one thing, and discarding a real generation because it had no
   *   rival would be the worse outcome. The choice records `automatic: true` so no surface can
   *   present it as reviewed (the fork decision's `single_path`, one subject over).
   * - **none** ⇒ record `no_choice` with the reason and FALL THROUGH (`null`) to the ordinary
   *   completion, so the run advances. A comparison that wedged a run because a model forgot a
   *   fenced block would be a worse failure than the one it exists to prevent, and the reason
   *   (`undeclared` / `parse_failed` / `no_candidates`) is on the step for a human to read.
   *
   * The state is recorded on EVERY path including the last, which is the point: a step that
   * settles with nothing rendered would otherwise be indistinguishable from a step that never
   * compared.
   */
  async recordCandidates(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    output: string | undefined,
  ): Promise<AdvanceResult | null> {
    const declaration = parseBinaryCandidateDeclaration(output)
    const candidates: BinaryCandidate[] = declaration.candidates.map((candidate) => ({
      id: this.deps.idGenerator.next('cand'),
      ...candidate,
    }))
    const multiSelect = step.stepOptions?.binaryOutput?.comparison?.multiSelect === true
    const bookkeeping = {
      candidates,
      multiSelect,
      invalidEntries: declaration.invalidEntries,
      omitted: declaration.omitted,
      unusablePreviews: declaration.unusablePreviews,
    }

    if (candidates.length === 0) {
      step.binaryCandidates = {
        ...bookkeeping,
        status: 'no_choice',
        noChoiceReason: declaration.parseFailed
          ? 'parse_failed'
          : declaration.undeclared
            ? 'undeclared'
            : 'no_candidates',
      }
      // Deliberately NOT persisted here: returning null hands the step to the ordinary completion
      // path, which persists and emits the whole instance. Writing it twice would emit a run
      // whose step is finished by one field and still running by another.
      return null
    }

    if (candidates.length === 1) {
      step.binaryCandidates = {
        ...bookkeeping,
        status: 'chosen',
        choice: {
          kept: [{ candidateId: candidates[0]!.id }],
          discarded: [],
          automatic: true,
          at: this.deps.clock.now(),
        },
      }
      // Re-arm the SAME step so the driver re-enters and dispatches the delivering pass.
      this.deps.stepGraph.resetStepForRerun(step)
      this.deps.stepGraph.startStep(step)
      await this.deps.stateMachine.persistAndEmit(workspaceId, instance)
      return { kind: 'continue' }
    }

    step.binaryCandidates = { ...bookkeeping, status: 'awaiting_choice' }
    await this.raiseCandidatesPending(workspaceId, instance, candidates.length)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Resolve the human's choice: validate the kept ids against a FRESH snapshot, record what
   * survives and under which alternate ids, re-arm the step for the delivering pass and wake the
   * driver.
   *
   * The validation is against the snapshot rather than against whatever the client sent, for the
   * ordinary reason (two people, one park) and one specific to this surface: `storeAs` is the id
   * an artifact lands under, so a duplicate would deliver two files to one address and report both
   * as stored. That is refused here rather than left to the agent, which has no way to tell a
   * deliberate overwrite from a collision.
   */
  async keep(
    workspaceId: string,
    executionId: string,
    input: KeepBinaryCandidatesInput,
  ): Promise<BinaryCandidateStepState> {
    let approvalId = ''
    let state: BinaryCandidateStepState | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const step = inst.steps.find(
          (s) =>
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending' &&
            s.binaryCandidates?.status === 'awaiting_choice',
        )
        if (!step?.approval || !step.binaryCandidates) {
          throw new ConflictError('The run is no longer awaiting a generated-candidate choice')
        }
        const candidates = step.binaryCandidates
        assertKeepable(input, candidates)
        // Captured BEFORE `resetStepForRerun` clears `step.approval`.
        approvalId = step.approval.id
        const kept = new Set(input.keep.map((entry) => entry.candidateId))
        step.binaryCandidates = {
          ...candidates,
          status: 'chosen',
          choice: {
            kept: input.keep.map((entry) => ({
              candidateId: entry.candidateId,
              ...(entry.storeAs ? { storeAs: entry.storeAs } : {}),
            })),
            // Recorded explicitly rather than derived at read time: the delivering pass is what
            // clears the staged files, and it needs the list even after a later reader would
            // have to reconstruct it by subtraction from a candidate list nothing guarantees
            // survives a future reset.
            discarded: candidates.candidates
              .map((candidate) => candidate.id)
              .filter((id) => !kept.has(id)),
            ...(input.note ? { note: input.note } : {}),
            at: this.deps.clock.now(),
          },
        }
        // Re-arm the SAME step so the driver re-enters and dispatches the delivering pass
        // (`binaryCandidates` survives `resetStepForRerun`, like `forkDecision`).
        this.deps.stepGraph.resetStepForRerun(step)
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
        state = step.binaryCandidates
      },
    )
    await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    return state!
  }

  /** The active candidate state for a run's GET, or null when no step carries one. */
  async getActive(
    workspaceId: string,
    executionId: string,
  ): Promise<BinaryCandidateStepState | null> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) return null
    const current = instance.steps[instance.currentStep]
    if (current?.binaryCandidates) return current.binaryCandidates
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const candidates = instance.steps[i]!.binaryCandidates
      if (candidates) return candidates
    }
    return null
  }

  /** Raise the "compare the generated candidates" inbox card when the run parks. */
  private async raiseCandidatesPending(
    workspaceId: string,
    instance: ExecutionInstance,
    count: number,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    // `decision_required` rather than a type of its own, and the reasoning is the iteration-cap
    // card's: the park already raises a generic waiting notification whose reveal opens the
    // parked step, which routes to this window by itself, so a dedicated type would buy an icon
    // and cost a member of a closed vocabulary that four wire surfaces and every locale mirror.
    // What is worth having is the SPECIFIC wording, and the park's own card is non-clobbering, so
    // raising this first is what makes the inbox say which decision is waiting.
    await this.deps.notificationService.raise(workspaceId, {
      type: 'decision_required',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" has ${count} generated candidates to compare`,
      body:
        'A generating step produced several candidates rather than committing to one. Open the ' +
        'task to compare them and keep the one (or ones) you want: the step delivers what you ' +
        'keep.',
      payload: { pipelineName: instance.pipelineName },
    })
  }
}

/**
 * Whether this request may resolve the park, refusing every way it could not.
 *
 * Each refusal is a distinct fault a caller can fix, and each would otherwise land somewhere far
 * from its cause: an unknown id would silently keep nothing, a second kept candidate on a
 * single-select step would deliver an artifact count nobody configured, and duplicate `storeAs`
 * ids would put two files at one address and report both as delivered.
 */
function assertKeepable(input: KeepBinaryCandidatesInput, state: BinaryCandidateStepState): void {
  const known = new Set(state.candidates.map((candidate) => candidate.id))
  const seen = new Set<string>()
  for (const entry of input.keep) {
    if (!known.has(entry.candidateId)) {
      throw new ValidationError(`Unknown candidate '${entry.candidateId}'`)
    }
    if (seen.has(entry.candidateId)) {
      throw new ValidationError(`Candidate '${entry.candidateId}' was kept twice`)
    }
    seen.add(entry.candidateId)
  }
  if (input.keep.length > 1 && !state.multiSelect) {
    throw new ValidationError(
      'This step keeps one candidate. Enable multi-select on the step to keep more than one.',
    )
  }
  // Above the parse cap nothing could have been kept anyway, but the bound is restated on the
  // WRITE path because it is the one a client controls: a request naming more entries than the
  // step could ever hold is a client bug, and the id check above would already have refused it
  // one id at a time with a message about the wrong thing.
  if (input.keep.length > MAX_BINARY_CANDIDATES) {
    throw new ValidationError(`At most ${MAX_BINARY_CANDIDATES} candidates may be kept`)
  }
  const aliases = input.keep.flatMap((entry) => (entry.storeAs ? [entry.storeAs] : []))
  if (new Set(aliases).size !== aliases.length) {
    throw new ValidationError(
      'Each kept candidate needs a DISTINCT id to be stored under: two artifacts at one location is one artifact.',
    )
  }
  // More than one survivor with no alternate id is the same collision spelled differently: the
  // step's ordinary naming is one name, so two candidates claiming it would overwrite each other.
  if (input.keep.length > 1 && aliases.length < input.keep.length) {
    throw new ValidationError(
      'Keeping more than one candidate requires an id for each of them, or they would all be stored under the same name.',
    )
  }
}
