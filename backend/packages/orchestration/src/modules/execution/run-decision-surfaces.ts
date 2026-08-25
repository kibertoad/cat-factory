import type { RunDispatcher } from './RunDispatcher.js'
import type {
  BinaryCandidateStepState,
  ChallengePrReviewFindingInput,
  ChooseForkInput,
  FollowUpResolution,
  FollowUpsStepState,
  ForkChatRequestInput,
  ForkDecisionStepState,
  KeepBinaryCandidatesInput,
  PrReviewStepState,
  ResolvePrReviewInput,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// The engine's passthrough surface for a run's DEDICATED PARK WINDOWS.
//
// Four surfaces park a step on a human and are answered by their own verbs rather than the
// generic approve/request-changes/reject: the Follow-up companion, the implementation-fork
// decision, the PR deep-review, and the generated-candidate comparison. `RunDispatcher` owns each
// one's controller, and `ExecutionService` used to carry one thin delegate per verb: sixteen of
// them, a tenth of the engine service, growing by two every time a park surface is added.
//
// They are ONE concern (`dedicatedParkSurface`'s own family, minus the judge, whose delegates go
// through `JudgeStepController` rather than the dispatcher and keep their own shape), so they
// live here and `ExecutionService` exposes them as `executionService.decisions`. The dispatcher
// is reached through a THUNK rather than a value, because these are assembled inside the engine
// service's constructor, before its own `runDispatcher` field is set.
// ---------------------------------------------------------------------------

/** The verbs the dedicated park windows are answered with. */
export interface RunDecisionSurfaces {
  getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null>
  fileFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState>
  queueFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState>
  answerFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
    answer: string,
    resolution?: FollowUpResolution,
  ): Promise<FollowUpsStepState>
  dismissFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState>
  getBinaryCandidates(
    workspaceId: string,
    executionId: string,
  ): Promise<BinaryCandidateStepState | null>
  keepBinaryCandidates(
    workspaceId: string,
    executionId: string,
    input: KeepBinaryCandidatesInput,
  ): Promise<BinaryCandidateStepState>
  getForkDecision(workspaceId: string, executionId: string): Promise<ForkDecisionStepState | null>
  chooseFork(
    workspaceId: string,
    executionId: string,
    input: ChooseForkInput,
  ): Promise<ForkDecisionStepState>
  forkChat(
    workspaceId: string,
    executionId: string,
    input: ForkChatRequestInput,
  ): Promise<ForkDecisionStepState>
  getPrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState | null>
  resolvePrReview(
    workspaceId: string,
    executionId: string,
    input: ResolvePrReviewInput,
  ): Promise<PrReviewStepState>
  resumePrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState>
  dismissPrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
  ): Promise<PrReviewStepState>
  challengePrReviewFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
    input: ChallengePrReviewFindingInput,
  ): Promise<PrReviewStepState>
}

/** Bind the park-window verbs to the dispatcher that owns their controllers. */
export function runDecisionSurfaces(dispatcher: () => RunDispatcher): RunDecisionSurfaces {
  return {
    /** @see RunDispatcher.getFollowUps */
    getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
      return dispatcher().getFollowUps(workspaceId, executionId)
    },

    /** @see RunDispatcher.getBinaryCandidates */
    getBinaryCandidates(
      workspaceId: string,
      executionId: string,
    ): Promise<BinaryCandidateStepState | null> {
      return dispatcher().getBinaryCandidates(workspaceId, executionId)
    },

    /** @see RunDispatcher.keepBinaryCandidates */
    keepBinaryCandidates(
      workspaceId: string,
      executionId: string,
      input: KeepBinaryCandidatesInput,
    ): Promise<BinaryCandidateStepState> {
      return dispatcher().keepBinaryCandidates(workspaceId, executionId, input)
    },

    /** @see RunDispatcher.getForkDecision */
    getForkDecision(
      workspaceId: string,
      executionId: string,
    ): Promise<ForkDecisionStepState | null> {
      return dispatcher().getForkDecision(workspaceId, executionId)
    },

    /** @see RunDispatcher.chooseFork */
    chooseFork(
      workspaceId: string,
      executionId: string,
      input: ChooseForkInput,
    ): Promise<ForkDecisionStepState> {
      return dispatcher().chooseFork(workspaceId, executionId, input)
    },

    /** @see RunDispatcher.forkChat */
    forkChat(
      workspaceId: string,
      executionId: string,
      input: ForkChatRequestInput,
    ): Promise<ForkDecisionStepState> {
      return dispatcher().forkChat(workspaceId, executionId, input)
    },

    /** @see RunDispatcher.getPrReview */
    getPrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState | null> {
      return dispatcher().getPrReview(workspaceId, executionId)
    },

    /** @see RunDispatcher.resolvePrReview */
    resolvePrReview(
      workspaceId: string,
      executionId: string,
      input: ResolvePrReviewInput,
    ): Promise<PrReviewStepState> {
      return dispatcher().resolvePrReview(workspaceId, executionId, input)
    },

    /** @see RunDispatcher.resumePrReview */
    resumePrReview(workspaceId: string, executionId: string): Promise<PrReviewStepState> {
      return dispatcher().resumePrReview(workspaceId, executionId)
    },

    /** @see RunDispatcher.dismissPrReviewFinding */
    dismissPrReviewFinding(
      workspaceId: string,
      executionId: string,
      findingId: string,
    ): Promise<PrReviewStepState> {
      return dispatcher().dismissPrReviewFinding(workspaceId, executionId, findingId)
    },

    /** @see RunDispatcher.challengePrReviewFinding */
    challengePrReviewFinding(
      workspaceId: string,
      executionId: string,
      findingId: string,
      input: ChallengePrReviewFindingInput,
    ): Promise<PrReviewStepState> {
      return dispatcher().challengePrReviewFinding(workspaceId, executionId, findingId, input)
    },

    /** @see RunDispatcher.fileFollowUp */
    fileFollowUp(
      workspaceId: string,
      executionId: string,
      itemId: string,
    ): Promise<FollowUpsStepState> {
      return dispatcher().fileFollowUp(workspaceId, executionId, itemId)
    },

    /** @see RunDispatcher.queueFollowUp */
    queueFollowUp(
      workspaceId: string,
      executionId: string,
      itemId: string,
    ): Promise<FollowUpsStepState> {
      return dispatcher().queueFollowUp(workspaceId, executionId, itemId)
    },

    /** @see RunDispatcher.answerFollowUp */
    answerFollowUp(
      workspaceId: string,
      executionId: string,
      itemId: string,
      answer: string,
      resolution?: FollowUpResolution,
    ): Promise<FollowUpsStepState> {
      return dispatcher().answerFollowUp(workspaceId, executionId, itemId, answer, resolution)
    },

    /** @see RunDispatcher.dismissFollowUp */
    dismissFollowUp(
      workspaceId: string,
      executionId: string,
      itemId: string,
    ): Promise<FollowUpsStepState> {
      return dispatcher().dismissFollowUp(workspaceId, executionId, itemId)
    },
  }
}
