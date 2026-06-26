import type { Block, ExecutionInstance } from './entities.js'
import type { BootstrapJob } from './bootstrap.js'
import type { Notification } from './notifications.js'
import type { LlmCallActivity } from './observability.js'
import type { RequirementReview } from './requirements.js'
import type { ConsensusSession } from './consensus.js'
import type { ClarityReview } from './clarity.js'
import type { BrainstormSession } from './brainstorm.js'
import type { KaizenGrading } from './kaizen.js'

// Real-time events pushed from the per-workspace events hub to subscribed
// browsers over WebSocket, replacing the old `tick` polling. The shape is shared
// by the worker (which publishes) and the frontend (which applies them to its
// stores), so the wire contract lives here in @cat-factory/contracts.

export type WorkspaceEvent =
  /**
   * A run advanced. Carries the updated instance and its server-rolled block, so
   * the client patches both caches without a refetch. `block` is null only if the
   * block vanished between the transition and the publish.
   */
  | { type: 'execution'; instance: ExecutionInstance; block: Block | null; at: number }
  /**
   * A structural board change the per-instance event can't express (a module
   * materialised, a run cancelled). The client responds with a full refresh.
   */
  | { type: 'board'; reason: string; at: number }
  /**
   * A repo-bootstrap run advanced. Carries the updated job (with live `subtasks`)
   * and its provisional/linked service frame, so the client patches the board
   * card and its progress without a refetch. `block` is null only if the frame
   * vanished between the transition and the publish.
   */
  | { type: 'bootstrap'; job: BootstrapJob; block: Block | null; at: number }
  /**
   * A human-actionable notification was raised or resolved (a PR needs review, a
   * pipeline finished and wants confirmation, CI fixing gave up). The client
   * upserts it into its notifications store and surfaces/clears the board badge.
   */
  | { type: 'notification'; notification: Notification; at: number }
  /**
   * One container-agent LLM call completed at the proxy. Carries a COMPACT per-call
   * summary (no prompt/response bodies) so an open "Model activity" panel updates
   * live and an evicted-but-alive durable driver is visibly distinct from a wedged
   * agent — the proxy records calls independently of the execution driver, so these
   * keep arriving even while the run's poll loop is frozen. The drill-down lazy-loads
   * the full bodies for an expanded row from the persisted metrics endpoint.
   */
  | { type: 'llmCall'; call: LlmCallActivity; at: number }
  /**
   * A block's requirements review changed status (the async incorporate +
   * re-review cycle started, produced new findings, converged, or hit its cap).
   * Carries the updated review so an open review window / inspector reflects the
   * transition live without a refetch. The user is summoned back only via a
   * `notification` event when input is needed; this event is for live state, not
   * a summons.
   */
  | { type: 'requirements'; review: RequirementReview; at: number }
  /**
   * A consensus session advanced (a participant contributed, a round completed,
   * the synthesis landed, or it failed). Carries the updated session transcript
   * so an open Consensus Session window reflects the multi-model process live
   * without a refetch.
   */
  | { type: 'consensus'; session: ConsensusSession; at: number }
  /**
   * A block's clarity (bug-report triage) review changed status — the clarity mirror of
   * the `requirements` event. Carries the updated review so an open review window /
   * inspector reflects the transition live without a refetch.
   */
  | { type: 'clarity'; review: ClarityReview; at: number }
  /**
   * A block's brainstorm (structured-dialogue) session changed status — the brainstorm mirror
   * of the `requirements` event. Carries the updated session so an open brainstorm window /
   * inspector reflects the transition live without a refetch.
   */
  | { type: 'brainstorm'; session: BrainstormSession; at: number }
  /**
   * A Kaizen grading was scheduled, started, completed or failed. Carries the updated
   * grading so an open run window reflects the scheduled→running→complete status live and
   * the Kaizen screen folds in new history. Never surfaced on the board — run-details only.
   */
  | { type: 'kaizen'; grading: KaizenGrading; at: number }
