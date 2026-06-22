import type {
  Block,
  BootstrapJob,
  ExecutionInstance,
  LlmCallActivity,
  Notification,
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
   */
  boardChanged(workspaceId: string, reason: string, blockId?: string | null): Promise<void>
  /**
   * A repo-bootstrap run advanced: push the updated job (with live `subtasks`)
   * and its provisional/linked service frame, so the board patches the
   * "bootstrapping…" card and its progress without a refetch. Optional so
   * publishers/tests that predate bootstrap progress need no change.
   */
  bootstrapChanged?(workspaceId: string, job: BootstrapJob, block?: Block | null): Promise<void>
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
   * a runtime with no real-time transport (Node today) leaves it a no-op.
   */
  llmCallObserved?(workspaceId: string, activity: LlmCallActivity): Promise<void>
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
  async notificationChanged(): Promise<void> {}
  async llmCallObserved(): Promise<void> {}
}
