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

import type { GatekeeperBinding } from '@cat-factory/gatekeeper-bindings'
import type { SessionGovernance } from '../capability.js'
import { GatekeeperError } from '../errors.js'
import { describeAction, describeObservation, type CallSubject } from './descriptions.js'
import type { ApprovalQueue } from './protocol.js'

/** One submitted action waiting on the workspace's decision. */
interface PendingAction {
  /** The effect, not yet performed. Run exactly once, by `apply`. */
  perform: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  /** What the caller is waiting on, for a refusal that can name it. */
  label: string
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
  readonly #pending = new Map<number, PendingAction>()

  /** Register an effect, returning the id to submit it under and the promise the caller awaits. */
  register(
    label: string,
    perform: () => Promise<unknown>,
  ): { id: number; settled: Promise<unknown> } {
    const id = this.#nextId++
    const settled = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { perform, resolve, reject, label })
    })
    return { id, settled }
  }

  /**
   * Drop a registration whose submission never reached the queue.
   *
   * Without it a queue that throws would leave an entry the workspace can never decide, and the
   * caller would be told about the submission failure while the ledger silently grew.
   */
  abandon(id: number): void {
    this.#pending.delete(id)
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

  /** How many actions are still waiting. Used by the resource's own description. */
  get pendingCount(): number {
    return this.#pending.size
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
 * The governance one session applies, over the queue the workspace handed it at `startSession`.
 *
 * Every method here is a thin translation: what to describe comes from the operation table
 * (`descriptions.ts`), what to do about the answer is the contract's, and the effect itself stays
 * the machinery's. That is what keeps this a facade rather than a second implementation.
 */
export function queueGovernance(deps: {
  queue: ApprovalQueue
  ledger: ActionLedger
  subject: CallSubject
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
  }
}
