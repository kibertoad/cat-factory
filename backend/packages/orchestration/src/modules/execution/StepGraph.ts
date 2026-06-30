import type { Clock, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { companionTargets } from '@cat-factory/agents'

/**
 * The pure, synchronous step/cursor mutators of the execution engine — the dependency-free
 * inner layer of the run state-machine spine. Every method operates on a passed
 * {@link PipelineStep} / {@link ExecutionInstance} and mutates it in place; the only
 * collaborator is the {@link Clock} the timing stamps come from. Lifted verbatim out of
 * `ExecutionService` so the engine AND every gate controller share ONE definition of "what
 * does it mean to start / finish / park / reset a step" instead of each receiving the
 * mutators as a loose callback bag.
 *
 * Deliberately holds NO repositories, event publisher or runner — those async,
 * instance-persisting concerns live in {@link RunStateMachine}, which composes this. Keeping
 * the pure mutators separate is what lets a controller depend on the timing rules without
 * pulling in the whole persistence/emission surface.
 */
export class StepGraph {
  constructor(private readonly clock: Clock) {}

  /** Transition a step into `working`, stamping its start time once, and resume its clock. */
  startStep(step: PipelineStep): void {
    step.state = 'working'
    if (step.startedAt == null) step.startedAt = this.clock.now()
    // (Re)entering `working` means the step is no longer parked on a human: resume
    // its duration clock (see {@link pauseStepForInput}).
    step.pausedAt = null
  }

  /**
   * Transition a step into `done`, stamping its finish time once. Set-once so the
   * approval-gate flow (which re-asserts `done` after a human approves, long after
   * the agent actually finished) keeps the agent's true completion time, and so a
   * replay doesn't move it. With {@link startStep}'s `startedAt` this yields the
   * step's execution duration. A step finished directly out of a parked approval
   * stopped *working* when it parked, so its duration is billed to the pause instant
   * ({@link pauseStepForInput}), not the (later) moment the human decided.
   */
  finishStep(step: PipelineStep): void {
    step.state = 'done'
    if (step.finishedAt == null) step.finishedAt = step.pausedAt ?? this.clock.now()
    step.pausedAt = null
  }

  /**
   * Park a step on a human decision and freeze its duration clock. Records when the
   * step stopped working (`pausedAt`) so elapsed time no longer accrues while it waits
   * for input — the symmetric counterpart of the terminal freeze on `finishedAt`.
   * Set-once (a Workflows replay re-parking keeps the original instant); cleared when
   * the step resumes ({@link startStep}) or finishes ({@link finishStep}).
   */
  pauseStepForInput(step: PipelineStep): void {
    step.state = 'waiting_decision'
    if (step.pausedAt == null) step.pausedAt = this.clock.now()
  }

  /**
   * Reset a step so the durable driver re-runs it from scratch: clear its live container
   * job handle (so it dispatches FRESH work rather than re-attaching to a stale/evicted
   * job), timings, approval, subtasks and prior output.
   */
  resetStepForRerun(step: PipelineStep): void {
    step.state = 'pending'
    step.startedAt = null
    step.finishedAt = null
    step.pausedAt = null
    step.jobId = undefined
    step.approval = null
    step.subtasks = undefined
    step.progress = 0
    step.output = undefined
    // Drop the prior run's structured output too, so a re-run that produces no `custom`
    // doesn't leave stale JSON for the `generic-structured` result view to render.
    step.custom = undefined
    step.rework = undefined
  }

  /**
   * Loop a producer step back for rework and re-run every step from it up to and
   * including the companion at `companionIndex`: each one is reset (crucially clearing
   * stale container job handles so an intermediate container step re-dispatches fresh
   * work instead of re-attaching to its evicted job), the producer is handed the
   * `rework` feedback + started, and the instance cursor is moved back to the producer.
   * Shared by the automatic companion loop and the human "request changes" path.
   */
  rerunProducerThrough(
    instance: ExecutionInstance,
    producerIndex: number,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ): void {
    for (let i = producerIndex; i <= companionIndex; i++) {
      this.resetStepForRerun(instance.steps[i]!)
    }
    const producer = instance.steps[producerIndex]!
    producer.rework = rework
    this.startStep(producer)
    instance.currentStep = producerIndex
  }

  /**
   * The index of the nearest preceding step a companion grades (one of its target
   * producer kinds), or -1 when none precedes it. The single producer-search used by the
   * automatic companion loop, the human "request changes" redirect, and the iteration-cap
   * extra-round resolution.
   */
  companionProducerIndex(instance: ExecutionInstance, companionIndex: number): number {
    const targets = companionTargets(instance.steps[companionIndex]!.agentKind)
    for (let i = companionIndex - 1; i >= 0; i--) {
      if (targets.includes(instance.steps[i]!.agentKind)) return i
    }
    return -1
  }

  /**
   * Loop a companion's producer back for one more automatic rework cycle: charge one
   * attempt against the budget, then re-run the producer (and any intermediate steps) up
   * to and including the companion so it re-grades. Shared by the automatic
   * below-threshold loop and the human-granted extra round, so both consume the budget
   * identically.
   */
  loopCompanionProducer(
    instance: ExecutionInstance,
    companionIndex: number,
    rework: NonNullable<PipelineStep['rework']>,
  ): void {
    const companionStep = instance.steps[companionIndex]
    if (!companionStep) {
      throw new Error(`loopCompanionProducer: no step at index ${companionIndex}`)
    }
    if (!companionStep.companion) {
      throw new Error(
        `loopCompanionProducer: step '${companionStep.agentKind}' has no companion budget to charge`,
      )
    }
    const producerIndex = this.companionProducerIndex(instance, companionIndex)
    // `companionProducerIndex` returns -1 when nothing precedes the companion; rerunning
    // from -1 would index `steps[-1]` and crash deep in a reset. Surface the real cause.
    if (producerIndex < 0) {
      throw new Error(
        `loopCompanionProducer: companion '${companionStep.agentKind}' has no preceding producer to rework`,
      )
    }
    companionStep.companion.attempts += 1
    this.rerunProducerThrough(instance, producerIndex, companionIndex, rework)
    if (instance.status === 'blocked') instance.status = 'running'
  }
}
