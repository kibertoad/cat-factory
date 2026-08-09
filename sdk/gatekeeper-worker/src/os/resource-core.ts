// What a bound resource DOES, separated from the Durable Object it lives in.
//
// The split is not ceremony. A Durable Object can only be constructed by workerd from a real
// `DurableObjectState`, and the props-imbued class this Gatekeeper hands the workspace is opaque by
// design (the workspace instantiates it, through machinery that is its own). So a suite that could
// only reach this behaviour through the object would be reduced to asserting that a class was
// returned. Everything worth getting wrong lives here instead, where it is ordinary code with
// ordinary dependencies, and `resource.ts` is the shell that supplies `ctx.props` and holds one of
// these for the object's lifetime.
//
// Holding ONE per object is what the action ledger needs: the workspace settles an action by
// calling `applyAction` on the resource, so a core rebuilt per call would lose the pending action
// the decision is about.

import type { GatekeeperEnv } from '../env.js'
import { GatekeeperError } from '../errors.js'
import { Gatekeeper } from '../gatekeeper.js'
import type { CompiledTier, GatekeeperPolicy } from '../policy/compile.js'
import { actionKindOf } from './descriptions.js'
import type { ActionKind, ApprovalQueue, ResourceDescription, ResourceObject } from './protocol.js'
import { ActionLedger, queueGovernance } from './queue.js'
import { renderTierSessionTypes, SESSION_INTERFACE_NAME } from './session-types.js'

/**
 * What the account imbues a resource object with when it hands the class to the workspace.
 *
 * The account and NOTHING else. The URL the workspace matched is deliberately not here: under this
 * Gatekeeper's own model a resource IS the paired workspace, so every URL that matches the pattern
 * binds the same one and the matched URL decides nothing. Carrying it would be state whose only
 * effect is that the next reader has to work out it decides nothing, and it had already been
 * assigned the pattern rather than the match without anything noticing. A consumer that genuinely
 * needs the bound URL adds it back WITH the reader that wants it, which is also the change that
 * would say which of the two it meant.
 */
export interface ResourceProps {
  /** The account this resource is bound for. Every key minted through it is stamped with this. */
  accountId: string
}

/** One bound resource: the session it opens, its types, and the action lifecycle behind it. */
export class ResourceCore implements ResourceObject {
  readonly #env: GatekeeperEnv
  readonly #policy: GatekeeperPolicy
  readonly #props: ResourceProps
  readonly #ledger = new ActionLedger()

  constructor(env: GatekeeperEnv, policy: GatekeeperPolicy, props: ResourceProps) {
    this.#env = env
    this.#policy = policy
    this.#props = props
  }

  async describe(): Promise<ResourceDescription> {
    const tier = this.#tier()
    return {
      url: this.#gatekeeper().deployment,
      title: 'cat-factory workspace',
      snippet:
        `File work, start runs and answer what they park on, at policy tier '${tier.name}': ` +
        `${tier.description}`,
      suggestedBindingName: 'catFactory',
      tsType: SESSION_INTERFACE_NAME,
    }
  }

  /**
   * The session's own types, rendered for the tier this account holds.
   *
   * Tier-specific rather than a copy of the vendor's, because this is the one the contract points a
   * caller at: `ResourceDescription.tsType` must name an export of THIS method's output, and a
   * session carries exactly its granted operations.
   */
  async getTypeScriptTypes(): Promise<string> {
    return renderTierSessionTypes(this.#tier())
  }

  /**
   * Open a governed session.
   *
   * The queue is not optional and not a decoration: every operation the returned object carries
   * funnels through the one `invoke` closure, which submits actions to this queue and authorizes
   * observations against it. The tier policy underneath is the FLOOR, so an operation the policy
   * never granted is absent from the object rather than something the queue has to refuse.
   *
   * The queue passed here is OWNED by the session that comes back: it is released, along with
   * every action that session left undecided, when the session is disposed. A caller reaching this
   * over RPC therefore hands in a reference of its own rather than the parameter it received (see
   * `resource.ts`), because the parameter's lifetime ends when this call returns and the session's
   * does not.
   */
  async startSession(approvalQueue: ApprovalQueue): Promise<unknown> {
    const gatekeeper = this.#gatekeeper()
    const accountId = this.#props.accountId
    return gatekeeper.capabilityForAccount(
      accountId,
      queueGovernance({
        queue: approvalQueue,
        ledger: this.#ledger.openSession(),
        subject: {
          accountId,
          tier: gatekeeper.tierForAccount(accountId).name,
          deployment: gatekeeper.deployment,
        },
      }),
    )
  }

  /**
   * How many submitted actions this object is still holding, across every live session.
   *
   * Exposed for the same reason the ledger counts them: the ONE unbounded thing about a long-lived
   * resource object is this set, and a count that does not fall back to zero when the sessions are
   * gone is the leak rather than a slow day.
   */
  get pendingActionCount(): number {
    return this.#ledger.pendingCount
  }

  /**
   * The action kinds this Gatekeeper may auto-apply, if the user opted into the kind.
   *
   * Derived from the same table and the same consequence reading `describeAction` stamps onto each
   * submission, so a pre-approval UI listing kinds before any action exists and the `autoApprovable`
   * flag on an action that has been submitted cannot disagree.
   *
   * TODAY THIS IS EMPTY, and that is the honest answer rather than a gap. The public surface
   * annotates a consequence only where the stakes are real money or a merged pull request, so every
   * other mutation is unannotated, and the table's documented reading of an unannotated mutation is
   * that it is destructive. Offering those for unattended auto-approval would mean inverting that
   * default here, which is precisely the misreading `resolveConsequence` exists to stop. If the
   * surface ever states that a write is safe, it appears here with no further decision.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return this.#tier()
      .granted.filter((binding) => !binding.readOnly)
      .filter((binding) => (binding.consequence?.destructive ?? true) === false)
      .map(actionKindOf)
  }

  /** The workspace approved an action: perform it, and hand the result to the waiting call. */
  async applyAction(action: number): Promise<void> {
    await this.#ledger.apply(action)
  }

  /** The workspace rejected an action: the waiting call throws and nothing is performed. */
  async rejectAction(action: number): Promise<void> {
    this.#ledger.reject(action)
  }

  /**
   * Reverting is not something this Gatekeeper can do, which every action it submits already states
   * (`implementsRevert: false`).
   *
   * It answers rather than throwing because the caller is the workspace UI on behalf of a person who
   * wants their change undone: a message naming what they have to do themselves is the useful
   * answer, where an exception would surface as a failed revert they might retry.
   */
  async revertAction(_action: number): Promise<{ message: string; canRetry: false }> {
    return {
      message:
        'This Gatekeeper cannot revert a cat-factory operation. A started run is stopped from the ' +
        'board or with `tasks_stop`; a merged pull request is reverted in the repository, not here.',
      canRetry: false,
    }
  }

  /**
   * Sharing this resource's observations onward is REFUSED, which blocks the share.
   *
   * The contract asks the gatekeeper to verify that the new viewer could directly read everything
   * historically observed through it. This Gatekeeper cannot answer that: it keeps no observation
   * log, and the plausible rule (the observer's own tier reaches every operation that produced the
   * observed data) needs a tier for a viewer this deployment's policy has never named. A share
   * blocked loudly beats an observation leaked quietly, so the refusal stands until there is a rule
   * worth writing down.
   */
  async addObserver(id: string, _user: unknown): Promise<void> {
    throw new GatekeeperError(
      'sharing_refused',
      `This Gatekeeper cannot verify that '${id}' may see everything already read through this ` +
        'resource, so it refuses the share. Give them their own connected account instead: their ' +
        "tier is then resolved from this deployment's own policy.",
    )
  }

  /** Idempotent by contract: nothing was ever added, so there is nothing to forget. */
  async removeObserver(_id: string): Promise<void> {}

  #gatekeeper(): Gatekeeper {
    return Gatekeeper.create(this.#env, this.#policy)
  }

  #tier(): CompiledTier {
    return this.#gatekeeper().tierForAccount(this.#props.accountId)
  }
}
