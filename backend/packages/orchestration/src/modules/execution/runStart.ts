import type { Block, ExecutionInstance } from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'

// The two funnels every path that brings a run to life passes through, in order: CLAIM the block's
// live-run slot, then — once the caller has committed whatever block state its flavour of start
// owns — HAND OFF the run to the durable runner, the SPA and the outbound lifecycle sink.
//
// They live together, and outside `ExecutionService`, because the thing worth protecting is the
// ORDER between them and the split of responsibilities across it: `start`, `retry` and
// `restartFrom` differ only in the block patch they write in the middle. Everything else about
// beginning a run is here, so a fourth start path is a matter of calling both rather than
// re-deriving the sequence — and re-deriving it is exactly how an outbound call ends up between a
// claim and the local write it belongs to.
//
// Deps arrive as bound callbacks so this module depends on no concrete repository or service.

export interface RunStartDeps {
  /** `ExecutionRepository.insertLive` — the atomic one-live-run-per-block claim. */
  insertLive: (
    workspaceId: string,
    instance: ExecutionInstance,
    options: { replaceId?: string },
  ) => Promise<boolean>
  /** Hand the run to the durable runner (`WorkRunner.startRun`). */
  startRun: (workspaceId: string, executionId: string) => Promise<void>
  /** Push the run to the SPA (`RunStateMachine.emitInstance`). */
  emitInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  /** Announce `run.started` outward (`RunStateMachine.publishRunStarted`). */
  publishRunStarted: (
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null | undefined,
  ) => Promise<void>
}

/**
 * Insert a freshly-built run, enforcing the one-live-run-per-block invariant at the DB in a single
 * atomic write (see `ExecutionRepository.insertLive`). Callers must NOT `deleteByBlock` first:
 * `insertLive` itself clears the block's terminal rows (and `replaceId`, the specific prior run a
 * `retry`/`restart` is knowingly superseding) in the SAME transaction as the insert.
 *
 * A `false` return means a genuinely-concurrent start (double click, recurring-vs-manual,
 * notification-vs-human retry) already created the block's live run — so we REFUSE this duplicate
 * rather than materialise a second driver + container on the same branch. The winning run is
 * untouched (the losing transaction only deletes terminal rows / its own `replaceId`, never the
 * winner). Surfaces as a 409 the SPA shows as a toast.
 *
 * Nothing else belongs in here. This is the run's atomic claim, and an external call placed
 * between it and the caller's block write is a fault that can strand a live run on a block never
 * marked `in_progress` and never handed to a driver — see {@link handOffLiveRun}.
 */
export async function claimLiveRunOrConflict(
  deps: RunStartDeps,
  workspaceId: string,
  instance: ExecutionInstance,
  replaceId?: string,
): Promise<void> {
  const inserted = await deps.insertLive(workspaceId, instance, { replaceId })
  if (!inserted) {
    // No machine `reason`: this is a rare double-start edge, not a distinct client-handled
    // conflict, so the human message drives the SPA's generic 409 toast (no new
    // ConflictReason + exhaustive-Record/i18n cascade for a transient race).
    throw new ConflictError('A run is already active for this block.')
  }
}

/**
 * The ONE hand-off every start path ends with, once the run is claimed and the block committed:
 * give the run to the durable runner, push it to the SPA, then announce `run.started` outward.
 *
 * The order is the point. The outbound announcement is LAST because it is the only step that
 * leaves the deployment — the platform's rule is to commit local state first and run the external
 * call behind it, so a slow or black-holing receiver costs the announcement and never the run.
 *
 * `run.started` is still exactly once per run: {@link claimLiveRunOrConflict} is what mints a live
 * run, so a concurrent double-start has already lost by the time we get here. A start path added
 * later inherits the announcement because skipping this funnel would also skip `startRun` — a run
 * that never progresses, not an event that silently never fires. `retry`/`restartFrom` each mint a
 * FRESH run id, so they announce genuinely new runs; otherwise a receiver would see `run.failed`
 * for one id and later `run.completed` for another it never learned about.
 *
 * The block is threaded through because every caller already holds it — re-reading it here would
 * be an extra round trip per run start (a NETWORK one on a mothership deployment).
 */
export async function handOffLiveRun(
  deps: RunStartDeps,
  workspaceId: string,
  instance: ExecutionInstance,
  block: Block | null | undefined,
): Promise<void> {
  // Hand the run off to the durable runner so it progresses server-side without a browser open.
  // With the no-op runner (tests) this does nothing and the run is advanced directly via
  // advanceInstance.
  await deps.startRun(workspaceId, instance.id)
  await deps.emitInstance(workspaceId, instance)
  await deps.publishRunStarted(workspaceId, instance, block)
}
