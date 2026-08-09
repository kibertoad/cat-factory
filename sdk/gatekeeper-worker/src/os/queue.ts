// The approval queue, threaded onto the session's one `invoke` seam.
//
// This is the half of the published contract that runs in the opposite direction from our approval
// INBOX, and the two must not be confused. The inbox carries the PLATFORM's parked runs outward to
// the OS, so a person can answer them. The queue carries the OS's governance INWARD over every call
// an agent makes, so nothing is read or written without the workspace's kernel having authorized
// it. A Gatekeeper needs both, and having one is no reason to skip the other.
//
// The action lifecycle is genuinely asynchronous, and the shape follows from that:
//
//   1. A mutating call assigns the next action id and records the effect in memory, UNPERFORMED.
//   2. It submits the description and awaits a decision that does not come back from `submitAction`.
//   3. `applyAction(id)` performs the effect and resolves the awaiting call with its result;
//      `rejectAction(id)` rejects it.
//
// The pending set is in MEMORY, on purpose. The awaiting caller is a suspended RPC into this object,
// so the object cannot be evicted while an action is pending, and if the RPC dies there is nobody
// left to resolve: persisting the effect would only let a later `applyAction` perform a write whose
// result nothing reads and whose caller was told nothing. An action that outlives its session is a
// SIMULATING gatekeeper's problem, and simulation is deliberately not what this one does
// (`awaitDecision: true` says so on every action it submits).
//
// So an entry's LIFETIME IS ITS SESSION'S, and nothing else bounds it. A TTL would be the wrong
// bound twice over: the thing being waited on is a person deciding, which has no deadline worth
// guessing, and expiring an entry would settle an action the workspace can still legitimately
// apply. What DOES end is the session: when the workspace drops it, every action it submitted is
// refused and dropped together, so the ledger of a long-lived resource object holds pending work
// for live sessions only. Without that, an approval card nobody ever answered pinned its entry for
// the object's whole lifetime, and `#take`'s "the session that submitted it has ended" was a
// sentence nothing made true.

import type { GatekeeperBinding } from '@cat-factory/gatekeeper-bindings'
import type { SessionGovernance } from '../capability.js'
import { describeError, GatekeeperError } from '../errors.js'
import { describeAction, describeObservation, type CallSubject } from './descriptions.js'
import { describeHook, HOOK_TOPICS, type HookControllerProps } from './hooks.js'
import type { ApprovalQueue } from './protocol.js'

/** One submitted action waiting on the workspace's decision. */
interface PendingAction {
  /** The effect, not yet performed. Run exactly once, by `apply`. */
  perform: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  /** What the caller is waiting on, for a refusal that can name it. */
  label: string
  /** The session that submitted it, so ending that session settles exactly its own actions. */
  session: number
}

/**
 * One session's view of the ledger: what it may register, and the end of everything it registered.
 *
 * A handle rather than a second store, because the IDS are the object's (see {@link ActionLedger})
 * while the LIFETIME is the session's, and the two facts have to live in one map for a decision
 * naming an id to find the entry it settles.
 */
export interface LedgerSession {
  /** Register an effect, returning the id to submit it under and the promise the caller awaits. */
  register(
    label: string,
    perform: () => Promise<unknown>,
  ): { id: number; settled: Promise<unknown> }
  /**
   * Drop a registration whose submission never reached the queue.
   *
   * Without it a queue that throws would leave an entry the workspace can never decide, and the
   * caller would be told about the submission failure while the ledger silently grew.
   */
  abandon(id: number): void
  /** The session is over: refuse every action it left undecided and drop them. */
  end(): void
}

/**
 * The submitted-but-undecided actions of one resource object, and the decisions that settle them.
 *
 * Ids are sequential per object rather than per session, because the OS hands them back to the
 * OBJECT (`applyAction` is a method on the resource, not on the session): two sessions minting
 * overlapping ids would settle each other's actions.
 */
export class ActionLedger {
  #nextId = 1
  #nextSession = 1
  readonly #pending = new Map<number, PendingAction>()

  /** Open one session's handle. Ending it is what bounds the entries it registered. */
  openSession(): LedgerSession {
    const session = this.#nextSession++
    return {
      register: (label, perform) => this.#register(session, label, perform),
      abandon: (id) => this.#pending.delete(id),
      end: () => this.#endSession(session),
    }
  }

  /**
   * Perform an approved action and hand its result to the waiting caller.
   *
   * The entry is removed BEFORE the effect runs, so a redelivered `applyAction` cannot perform it
   * twice: at-least-once delivery is the normal state of a decision arriving over a network, and
   * the second copy must be a refusal rather than a second write.
   *
   * A failing effect rejects the caller AND throws on to the workspace, which the contract asks
   * for: the person who approved it is the one who gets to retry or discard.
   */
  async apply(id: number): Promise<void> {
    const action = this.#take(id, 'apply')
    try {
      action.resolve(await action.perform())
    } catch (error) {
      action.reject(error)
      throw error
    }
  }

  /** Reject an action: the awaiting call throws, and nothing is performed. */
  reject(id: number): void {
    const action = this.#take(id, 'reject')
    action.reject(
      new GatekeeperError(
        'action_rejected',
        `The workspace rejected this action (${action.label}), so it was not performed.`,
      ),
    )
  }

  /**
   * How many actions are still waiting, across every live session on this object.
   *
   * Here so the ledger's one growth path is observable: an entry is added by a session and removed
   * by a decision, an abandoned submission, or that session ending, and a count that does not
   * return to zero once the sessions are gone is the leak this exists to fail a test on.
   */
  get pendingCount(): number {
    return this.#pending.size
  }

  #register(
    session: number,
    label: string,
    perform: () => Promise<unknown>,
  ): { id: number; settled: Promise<unknown> } {
    const id = this.#nextId++
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { perform, resolve, reject, label, session })
    })
    return { id, settled }
  }

  /**
   * End one session: every action it submitted and nobody decided is refused, and nothing is
   * performed.
   *
   * The awaiting caller is told, rather than left on a promise that can no longer settle: the
   * session it called through is gone, so no `applyAction` can ever reach its effect again.
   */
  #endSession(session: number): void {
    // Deleting the entry the iterator is standing on is defined behaviour for a Map, so this
    // walks the live one rather than a snapshot of it.
    for (const [id, action] of this.#pending) {
      if (action.session !== session) continue
      this.#pending.delete(id)
      action.reject(
        new GatekeeperError(
          'session_ended',
          `The session that submitted this action (${action.label}) ended before the workspace ` +
            'decided it, so it was not performed.',
        ),
      )
    }
  }

  #take(id: number, verb: string): PendingAction {
    const action = this.#pending.get(id)
    if (action === undefined) {
      throw new GatekeeperError(
        'unknown_action',
        `No action ${id} is pending on this resource, so there is nothing to ${verb}. It was ` +
          'already decided, or the session that submitted it has ended.',
      )
    }
    this.#pending.delete(id)
    return action
  }
}

/**
 * Take a reference to the workspace's queue that outlives the call it arrived on.
 *
 * Workers RPC disposes every stub a call received as a PARAMETER the moment that call returns, and
 * `startSession` returns immediately with a session that goes on using the queue for the rest of
 * its life. Without this the first governed read or write would authorize against a stub the
 * runtime had already torn down, and the failure would reach the caller as a broken connection
 * rather than as anything naming the queue. `dup()` is what the RPC contract offers for exactly
 * this case.
 *
 * The check is not defensiveness about a malformed argument: `ResourceCore` is also driven
 * IN-PROCESS, by this package's own suite and by anything embedding it, and there the queue is an
 * ordinary object that was never a stub and has nothing to duplicate.
 *
 * Paired with {@link releaseQueue} and kept beside it, because a duplicate taken here and released
 * anywhere else is a leak that nothing about either half would show on its own.
 */
export function holdQueue(queue: ApprovalQueue): ApprovalQueue {
  const stub = queue as Partial<{ dup: () => ApprovalQueue }>
  return typeof stub.dup === 'function' ? stub.dup() : queue
}

/**
 * Release this session's hold on the workspace's queue.
 *
 * The other half of {@link holdQueue}: a duplicate nobody disposes holds the workspace's end of
 * the connection open for the resource object's whole lifetime. The optional call is the
 * in-process case again, where nothing was duplicated and there is nothing to give back.
 */
function releaseQueue(queue: ApprovalQueue): void {
  ;(queue as Partial<Disposable>)[Symbol.dispose]?.()
}

/**
 * The governance one session applies, over the queue the workspace handed it at `startSession`.
 *
 * Every method here is a thin translation: what to describe comes from the operation table
 * (`descriptions.ts`), what to do about the answer is the contract's, and the effect itself stays
 * the machinery's. That is what keeps this a facade rather than a second implementation.
 */
export function queueGovernance(deps: {
  queue: ApprovalQueue
  ledger: LedgerSession
  subject: CallSubject
  /**
   * Build the controller for one hook, which is this Worker's own `CatFactoryHookController`
   * export imbued with the registration's identity.
   *
   * Supplied by the caller rather than built here because only the resource object can reach
   * `ctx.exports`, and a session that could not build one is a session on a door with no hooks.
   */
  controllerFor: (props: HookControllerProps) => unknown
}): SessionGovernance {
  return {
    async observe(binding: GatekeeperBinding, args: Record<string, unknown>): Promise<void> {
      await deps.queue.authorizeObservation(describeObservation(binding, args, deps.subject))
    },

    async observeLocal(title: string, detail: string): Promise<void> {
      await deps.queue.authorizeObservation({
        title: `${title} (${deps.subject.deployment})`,
        description:
          `${detail}\n\nServed from this Gatekeeper's own record of what the paired deployment ` +
          `at ${deps.subject.deployment} delivered, for account \`${deps.subject.accountId}\` at ` +
          `policy tier \`${deps.subject.tier}\`.`,
      })
    },

    async act<T>(
      binding: GatekeeperBinding,
      args: Record<string, unknown>,
      perform: () => Promise<T>,
    ): Promise<T> {
      const { id, settled } = deps.ledger.register(
        binding.summary,
        perform as () => Promise<unknown>,
      )
      try {
        await deps.queue.submitAction(id, describeAction(binding, args, deps.subject))
      } catch (error) {
        // The submission failed, so no decision will ever arrive for this id. Dropping the
        // registration is what stops the caller waiting on a promise nothing can settle.
        deps.ledger.abandon(id)
        throw error
      }
      return (await settled) as T
    },

    /**
     * Hand the workspace a controller and the callback, and keep NEITHER.
     *
     * Everything about the registration rides the controller's props, so this call leaves no
     * state behind: the workspace may take days to approve the hook, or never approve it, and a
     * row written here would be a registration for something nobody enabled. What comes back is
     * nothing at all, because there is nothing to report yet; `hooks_bound()` answers once the
     * workspace has enabled it.
     */
    async subscribe(topic, callback): Promise<void> {
      // Reachable only in process, and kept for exactly that: an embedding suite hands over a
      // plain object, where a missing method is a mistake worth naming. It CANNOT catch a
      // workspace whose queue predates hooks, because a stub answers every property (the same
      // fact `callBack` turns on), so `typeof` reads `function` for a method the far side does not
      // implement. That case arrives below, as a failure from the far side.
      if (typeof deps.queue.bindHook !== 'function') {
        throw new GatekeeperError(
          'hooks_unavailable',
          'The approval queue this session was opened with offers no bindHook(), so this ' +
            'workspace cannot hold a callback for us. Read `approvals_list()` and ' +
            '`runs_watched()` instead: they carry exactly what a hook would push.',
        )
      }
      const props: HookControllerProps = {
        hookId: `hook_${crypto.randomUUID().replaceAll('-', '')}`,
        topic,
        accountId: deps.subject.accountId,
        tier: deps.subject.tier,
        deployment: deps.subject.deployment,
      }
      try {
        await deps.queue.bindHook(
          deps.controllerFor(props),
          callback,
          describeHook(topic, deps.subject),
        )
      } catch (error) {
        // A workspace whose queue has no `bindHook` and a person who declined the registration
        // both surface here, and this Gatekeeper cannot tell them apart: the contract offers no
        // way to ask whether hooks are servable, and the two failures cross the wire the same way.
        // So the cause is reported VERBATIM rather than sorted into a guess, because it is the one
        // thing that distinguishes them and the two need opposite fixes.
        throw new GatekeeperError(
          'hook_bind_refused',
          `This workspace did not take the ${HOOK_TOPICS[topic].sessionMethod}() binding ` +
            `(${describeError(error)}). Either its approval queue serves no hooks, or the ` +
            'registration was declined. `approvals_list()` and `runs_watched()` answer exactly ' +
            'what the hook would have pushed, and go on doing so.',
        )
      }
    },

    close(): void {
      // Order matters: the actions are refused while the queue is still ours to hold, so an
      // awaiting caller is told the session ended rather than left on a promise whose only route
      // to a decision has already been released.
      deps.ledger.end()
      releaseQueue(deps.queue)
    },
  }
}
