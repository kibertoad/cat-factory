import type {
  Block,
  BootstrapJob,
  EnvConfigRepairJob,
  EnvironmentTestRun,
  ExecutionInstance,
  InfraSetupArea,
  InfraSetupStatus,
  Initiative,
  KaizenGrading,
  LlmCallActivity,
  Notification,
  WorkspaceEvent,
} from '~/types/domain'
import type { BrainstormSession } from '~/types/brainstorm'
import type { ClarityReview } from '~/types/clarity'
import type { ConsensusSession } from '~/types/consensus'
import type { DocInterviewSession } from '~/types/doc-interview'
import type { RequirementReview } from '~/types/requirements'

/**
 * Everything {@link applyWorkspaceEvent} needs to route one pushed event into the stores, as bound
 * callbacks rather than the stores themselves: it makes the routing (above all the `board` branch's
 * targeted-vs-coarse decision) unit-testable without a Pinia instance or a live socket.
 *
 * Each callback names the DOMAIN type it takes, not the event field it happens to be fed from
 * today. `upsertBlock` is the reason that matters: three branches (`execution`, `board`,
 * `bootstrap`) share it, so typing it off any one of their payloads would silently retype the
 * other two the next time that event's shape moved.
 */
export interface WorkspaceEventTargets {
  upsertExecution: (instance: ExecutionInstance) => void
  upsertBlock: (block: Block) => void
  upsertBootstrap: (job: BootstrapJob) => void
  upsertEnvConfigRepair: (job: EnvConfigRepairJob) => void
  upsertEnvironmentTest: (run: EnvironmentTestRun) => void
  patchInfraSetup: (area: InfraSetupArea, status: InfraSetupStatus, detail?: string) => void
  upsertNotification: (n: Notification) => void
  appendLlmCall: (call: LlmCallActivity) => void
  upsertRequirements: (r: RequirementReview) => void
  upsertConsensus: (s: ConsensusSession) => void
  upsertClarity: (r: ClarityReview) => void
  upsertBrainstorm: (s: BrainstormSession) => void
  upsertKaizen: (g: KaizenGrading) => void
  upsertInitiative: (i: Initiative) => void
  upsertDocInterview: (s: DocInterviewSession) => void
  /** Debounced full `workspace.refresh()`: the fallback for a change no payload can state. */
  refreshBoard: () => void
}

/**
 * Route one pushed workspace event into the stores.
 *
 * The `board` branch is the one with a decision in it. A `board` event used to mean "re-fetch the
 * whole snapshot", which on an active board is a REPLACE-style rehydrate of ~20 stores every ~300ms
 * debounce window, for changes as small as one spawned task. The backend now carries the changed
 * block whenever the change is fully described by it (see the `board` case in
 * `@cat-factory/contracts`' `WorkspaceEvent`), so those patch in place exactly like an `execution`
 * event's block does, through the same `upsert` whose monotonic stamp keeps a later stale refresh
 * from clobbering them.
 *
 * A `board` event with NO block keeps the old behaviour, and that is not a fallback to tidy away:
 * a removal, a reparent, a blueprint reconcile and every service-frame change genuinely need the
 * refresh, because their new shape is not one block's contents.
 */
export function applyWorkspaceEvent(event: WorkspaceEvent, to: WorkspaceEventTargets): void {
  switch (event.type) {
    case 'execution':
      // Full instance drives the step-level UI; agentRuns derives its coarse
      // failure/retry summary from the same store, so no extra call is needed.
      to.upsertExecution(event.instance)
      if (event.block) to.upsertBlock(event.block)
      return
    case 'board':
      // Targeted when the change fits in one block, coarse otherwise. Both shapes reach every
      // board that mounts the affected service; only the cost differs.
      if (event.block) to.upsertBlock(event.block)
      else to.refreshBoard()
      return
    case 'bootstrap':
      // Patch the run's live status/subtasks and its provisional/linked frame so
      // the "bootstrapping…" card updates in place (then flips to a ready service
      // or a failed badge) without a full refresh.
      to.upsertBootstrap(event.job)
      if (event.block) to.upsertBlock(event.block)
      return
    case 'env-config-repair':
      // A provider config-repair run advanced: patch its live status/subtasks/outcome so the
      // infrastructure-providers window's "repairing…" indicator updates in place (then flips to
      // ok / residual issues / a failure) without a refetch. No board block.
      to.upsertEnvConfigRepair(event.job)
      return
    case 'envTest':
      // An ephemeral-environment self-test advanced a stage: patch the run so the service
      // inspector's "Test environment creation" control shows the live stage + final outcome in
      // place without a refetch. No board block.
      to.upsertEnvironmentTest(event.run)
      return
    case 'infraSetup':
      // The reachability watcher found a configured infrastructure area dead (or answering again):
      // patch that one area so the setup banner appears/clears immediately. A full refresh would
      // pay the whole snapshot aggregate for a one-field delta, and the projection the snapshot
      // recomputes already folds the same recorded state.
      to.patchInfraSetup(event.area, event.status, event.detail)
      return
    case 'notification':
      // A PR needs a merge decision, a pipeline finished, or CI gave up: patch the
      // inbox + per-block badge in place (resolved ones drop out of the inbox).
      to.upsertNotification(event.notification)
      return
    case 'llmCall':
      // A container agent just made a model call: fold the compact summary into the observability
      // store so an open "Model activity" panel updates live (and keeps updating even when the
      // durable driver is evicted, since the proxy emits these independently of the poll loop).
      to.appendLlmCall(event.call)
      return
    case 'requirements':
      // The async incorporate + re-review cycle changed a review's status: patch the cache so an
      // open review window / inspector reflects it live ("incorporating…" → the next cycle /
      // converged). The summons back, when needed, arrives as a `notification`.
      to.upsertRequirements(event.review)
      return
    case 'consensus':
      // A consensus session advanced (a round landed, the synthesis completed, or it failed):
      // patch the cache so an open Consensus Session window renders the multi-model process live,
      // round by round.
      to.upsertConsensus(event.session)
      return
    case 'clarity':
      // The clarity mirror of `requirements`.
      to.upsertClarity(event.review)
      return
    case 'brainstorm':
      // The async incorporate + re-run cycle changed a brainstorm session's status: patch the
      // cache so an open brainstorm window / inspector reflects it live.
      to.upsertBrainstorm(event.session)
      return
    case 'kaizen':
      // A post-run Kaizen grading was scheduled, started or completed: fold it into the run cache
      // (so an open run window shows scheduled→running→complete live) and the Kaizen screen
      // history. Never surfaced on the board.
      to.upsertKaizen(event.grading)
      return
    case 'initiative':
      // An initiative changed (created, plan ingested, an item settled): patch the cache so an
      // open tracker window / the board card reflects the transition live.
      to.upsertInitiative(event.initiative)
      return
    case 'docInterview':
      // The interactive document interview advanced (a fresh batch of questions, an answer, or
      // convergence): patch the cache so an open interview window reflects it live.
      to.upsertDocInterview(event.session)
      return
    default:
      return dropUnknownEvent(event)
  }
}

/**
 * The exhaustiveness guard for the routing above.
 *
 * The COMPILE-TIME half is the point: `never` fails the build the moment `WorkspaceEvent` gains a
 * member with no case, so a new pushed event cannot ship as a branch that silently does nothing.
 * The spec's per-type table cannot do that job: a member absent from a hand-written list is just
 * absent, and the suite stays green.
 *
 * At RUNTIME this deliberately drops the event. A backend one release ahead of the SPA legitimately
 * pushes types this build has never heard of, and the connection carries every other event for the
 * whole workspace: throwing would trade one unknown payload for the entire live session.
 */
function dropUnknownEvent(event: never): void {
  void event
}
