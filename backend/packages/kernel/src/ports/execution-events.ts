import type {
  Block,
  BootstrapJob,
  BrainstormSession,
  ConsensusSession,
  ClarityReview,
  DocInterviewSession,
  EnvConfigRepairJob,
  EnvironmentTestRun,
  ExecutionInstance,
  Initiative,
  KaizenGrading,
  LlmCallActivity,
  Notification,
  RequirementReview,
} from '../domain/types.js'

// Port for pushing state changes to connected clients in real time, instead of
// the browser polling for them. The execution engine calls this whenever it
// persists a transition, so a subscribed browser learns of progress live. Modelling
// it as a port keeps the engine free of any Cloudflare/WebSocket concern. Concrete
// implementations:
//   - NoopEventPublisher          — the default; does nothing (tests, no binding)
//   - DurableObjectEventPublisher — POSTs to the per-workspace WorkspaceEventsHub
// All methods are best-effort: a publish failure must never break a state transition.
// The persisted DB write remains the source of truth (a client reconciles any missed
// event by re-fetching the snapshot on (re)connect), so the push is purely an
// optimisation and implementations swallow their own errors.

export interface ExecutionEventPublisher {
  /** A run advanced: push the updated instance and its rolled-up block. */
  executionChanged(
    workspaceId: string,
    instance: ExecutionInstance,
    block?: Block | null,
  ): Promise<void>
  /**
   * A structural board change the per-instance event can't express (a module
   * materialised, a run cancelled) — a coarse signal that prompts a full refresh.
   * `blockId` (when known) identifies a block of the affected service so the change can
   * be fanned out to every workspace that mounts it (in-org sharing); omit it for a
   * genuinely board-wide signal, which then reaches the originating workspace only.
   * `originConnectionId` (when known) is the realtime connection that caused the change:
   * the transport skips delivering the echo back to it, so a client never refreshes off
   * its own move (which would snap an in-flight drag back to a stale position).
   */
  boardChanged(
    workspaceId: string,
    reason: string,
    blockId?: string | null,
    originConnectionId?: string | null,
  ): Promise<void>
  /**
   * A repo-bootstrap run advanced: push the updated job (with live `subtasks`)
   * and its provisional/linked service frame, so the board patches the
   * "bootstrapping…" card and its progress without a refetch. Optional so
   * publishers/tests that predate bootstrap progress need no change.
   */
  bootstrapChanged?(workspaceId: string, job: BootstrapJob, block?: Block | null): Promise<void>
  /**
   * An environment-provider config-repair run advanced: push the updated job (live
   * `subtasks`, terminal `ok`/`issues`/`failure`) so the infrastructure-providers window
   * patches its "repairing…" indicator and outcome without a refetch. There is no board
   * block. Optional so publishers/tests that predate it need no change.
   */
  envConfigRepairChanged?(workspaceId: string, job: EnvConfigRepairJob): Promise<void>
  /**
   * An ephemeral-environment self-test run advanced: push the updated run so the
   * service inspector's "Test environment creation" control patches its live stage +
   * final outcome without a refetch. There is no board block. Optional so
   * publishers/tests that predate it need no change.
   */
  envTestChanged?(workspaceId: string, run: EnvironmentTestRun): Promise<void>
  /**
   * A human-actionable notification was raised or resolved: push it so the board
   * surfaces/clears its badge and inbox entry live. Optional so publishers/tests
   * that predate notifications need no change.
   */
  notificationChanged?(workspaceId: string, notification: Notification): Promise<void>
  /**
   * One container-agent LLM call completed at the proxy: push its compact summary
   * (no prompt/response bodies) so an open "Model activity" view updates live,
   * independent of the durable driver (the proxy records calls even while the run's
   * poll loop is frozen). Optional so publishers/tests that predate it need no change;
   * a runtime with no real-time transport wired leaves it a no-op.
   */
  llmCallObserved?(workspaceId: string, activity: LlmCallActivity): Promise<void>
  /**
   * A block's requirements review changed status (the async incorporate + re-review cycle
   * started, produced new findings, converged, or hit its cap): push the updated review so
   * an open review window / inspector reflects the transition live. This is live state, not
   * a summons — the user is called back via a `notificationChanged` event when input is
   * needed. Optional; a runtime with no real-time transport wired leaves it a no-op.
   */
  requirementReviewChanged?(workspaceId: string, review: RequirementReview): Promise<void>
  /**
   * A consensus session advanced (a participant contributed, a round completed, the
   * synthesis landed, or it failed): push the updated transcript so an open Consensus
   * Session window reflects the multi-model process live. Optional; a runtime with no
   * real-time transport — or no consensus package wired — leaves it a no-op.
   */
  consensusSessionChanged?(workspaceId: string, session: ConsensusSession): Promise<void>
  /**
   * A block's clarity (bug-report triage) review changed status — the mirror of
   * {@link requirementReviewChanged} for the clarity loop: push the updated review so an
   * open review window / inspector reflects the transition live. Optional; a runtime with
   * no real-time transport wired leaves it a no-op.
   */
  clarityReviewChanged?(workspaceId: string, review: ClarityReview): Promise<void>
  /**
   * A block's brainstorm (structured-dialogue) session changed status — the mirror of
   * {@link requirementReviewChanged} for the brainstorm loop: push the updated session so an
   * open brainstorm window / inspector reflects the transition live. Optional; a runtime with
   * no real-time transport wired leaves it a no-op.
   */
  brainstormSessionChanged?(workspaceId: string, session: BrainstormSession): Promise<void>
  /**
   * A Kaizen grading was scheduled, started, completed or failed: push the updated
   * grading so an open run window reflects the scheduled→running→complete status live
   * and the Kaizen screen folds in new history. Optional; a runtime with no real-time
   * transport wired leaves it a no-op. Never surfaced on the board — run-details only.
   */
  kaizenGradingChanged?(workspaceId: string, grading: KaizenGrading): Promise<void>
  /**
   * An initiative changed (created, plan ingested, an item settled, status moved):
   * push the updated entity so an open tracker window / the board card reflects
   * the transition live. Optional; a runtime with no real-time transport wired
   * leaves it a no-op.
   */
  initiativeChanged?(workspaceId: string, initiative: Initiative): Promise<void>
  /**
   * A block's interactive document-interview session changed (the interviewer asked a fresh
   * batch, an answer landed, or it converged) — the mirror of {@link requirementReviewChanged}
   * for the doc-interview loop (WS5): push the updated session so an open interview window /
   * inspector reflects the transition live. This is live state, not a summons — the user is
   * called back via a `notificationChanged` event when input is needed. Optional; a runtime
   * with no real-time transport wired leaves it a no-op.
   */
  docInterviewChanged?(workspaceId: string, session: DocInterviewSession): Promise<void>
}

/**
 * The default publisher: it does nothing. With it wired, the engine behaves exactly
 * as before — no events are pushed (tests, and any deployment without the
 * WORKSPACE_EVENTS binding).
 */
export class NoopEventPublisher implements ExecutionEventPublisher {
  async executionChanged(): Promise<void> {}
  async boardChanged(): Promise<void> {}
  async bootstrapChanged(): Promise<void> {}
  async envConfigRepairChanged(): Promise<void> {}
  async envTestChanged(): Promise<void> {}
  async notificationChanged(): Promise<void> {}
  async llmCallObserved(): Promise<void> {}
  async requirementReviewChanged(): Promise<void> {}
  async consensusSessionChanged(): Promise<void> {}
  async clarityReviewChanged(): Promise<void> {}
  async brainstormSessionChanged(): Promise<void> {}
  async kaizenGradingChanged(): Promise<void> {}
  async initiativeChanged(): Promise<void> {}
  async docInterviewChanged(): Promise<void> {}
}
