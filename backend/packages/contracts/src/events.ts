import type { Block } from './entities.js'
import type { ExecutionInstance } from './execution.js'
import type { BootstrapJob } from './bootstrap.js'
import type { EnvConfigRepairJob } from './env-config-repair.js'
import type { EnvironmentTestRun } from './environment-test.js'
import type { InfraSetupArea, InfraSetupStatus } from './infra-setup.js'
import type { Notification } from './notifications.js'
import type { LlmCallActivity } from './observability.js'
import type { RequirementReview } from './requirements.js'
import type { ConsensusSession } from './consensus.js'
import type { ClarityReview } from './clarity.js'
import type { BrainstormSession } from './brainstorm.js'
import type { KaizenGrading } from './kaizen.js'
import type { Initiative } from './initiative.js'
import type { DocInterviewSession } from './doc-interview.js'

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
   * The board changed in a way the per-instance event can't express: a task spawned by an
   * initiative loop, a module materialised, a run cancelled, a service archived.
   *
   * `block` is present when the change is fully described by ONE block, and the client upserts it
   * exactly like an `execution` event's block. That is the common case on a busy board (every
   * initiative-spawned task, every dependency toggle, every field edit) and it costs one small
   * payload instead of a whole board snapshot.
   *
   * `block` is absent when the change is structural (a removal, a reparent, a cascade), or when
   * the subject is a SERVICE FRAME, whose position and size are per-board and so cannot be carried
   * correctly to the several boards a shared service's event reaches, or when it is a headless
   * internal anchor block no board may show at all. The client falls back to a debounced full
   * refresh, which is what every `board` event used to do.
   *
   * There is deliberately no block ID beside the payload. Which block a change was ABOUT is how
   * the backend resolved the set of workspaces to publish to, spent before this event exists; a
   * client has nothing to do with it that the payload does not already say, and an id riding along
   * for nobody reads to the next reader as something load-bearing.
   */
  | {
      type: 'board'
      reason: string
      block?: Block | null
      at: number
    }
  /**
   * A repo-bootstrap run advanced. Carries the updated job (with live `subtasks`) so the client
   * patches the "bootstrapping…" card's progress without a refetch. `block` is the run's service
   * FRAME and is therefore always withheld (see the `board` case): the frame's own transitions
   * arrive as coarse `board` events, so each board re-reads its own per-board geometry rather than
   * upserting coordinates the frame is not at anywhere.
   */
  | { type: 'bootstrap'; job: BootstrapJob; block: Block | null; at: number }
  /**
   * An environment-provider config-repair run advanced. Carries the updated job
   * (live `subtasks`, terminal `ok`/`issues`/`failure`) so the infrastructure-providers
   * window patches the "repairing…" indicator and its final outcome without a refetch.
   * There is no board block — this run is surfaced only on the infra window.
   */
  | { type: 'env-config-repair'; job: EnvConfigRepairJob; at: number }
  /**
   * An ephemeral-environment self-test run advanced (branch created, provisioning,
   * tearing down, deleting branch, or a terminal success/failure). Carries the
   * updated run so the service inspector's "Test environment creation" control shows
   * the live stage + final outcome without a refetch. There is no board block — this
   * run is surfaced only on the inspector that triggered it.
   */
  | { type: 'envTest'; run: EnvironmentTestRun; at: number }
  /**
   * One infrastructure area's reachability changed, so the client patches its `infraSetup`
   * projection in place and the setup banner appears or clears IMMEDIATELY.
   *
   * Without this the projection is only recomputed when a workspace snapshot (re)loads, which is
   * fine for the operator-decision states — nobody un-configures a runner pool behind your back —
   * but useless for `unreachable`: a cluster that dies mid-session would stay invisible until
   * somebody happened to reload the app, which in practice means the next day. A dead environment
   * provider silently fails every testing agent in the meantime, so it has to push.
   *
   * Published on TRANSITION only, never per probe: the watcher polls on a sweep cadence, so
   * re-announcing an ongoing outage every pass would turn this into a standing event storm on the
   * workspace bus.
   *
   * `detail` is the probe's own operator-facing reason (a refused connection reads very
   * differently from a rejected token) and is deliberately NOT persisted on the notification the
   * watcher raises: it varies between passes, and the card re-delivers whenever its content
   * changes, so carrying it there would re-toast the inbox for the whole outage. It therefore
   * rides the live transition only — which is exactly when someone is looking.
   */
  | {
      type: 'infraSetup'
      area: InfraSetupArea
      status: InfraSetupStatus
      detail?: string
      at: number
    }
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
  /**
   * An initiative changed (created, plan ingested, an item settled, status moved).
   * Carries the updated entity so an open tracker window / the board card reflects
   * the transition live without a refetch.
   */
  | { type: 'initiative'; initiative: Initiative; at: number }
  /**
   * A block's interactive document-interview session changed (WS5) — the doc-interview mirror of
   * the `requirements` event. Carries the updated session so an open interview window / inspector
   * reflects the transition (new questions, an answer, convergence) live without a refetch.
   */
  | { type: 'docInterview'; session: DocInterviewSession; at: number }
