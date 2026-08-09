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
import { Gatekeeper } from '../gatekeeper.js'
import type { CompiledTier, GatekeeperPolicy } from '../policy/compile.js'
import { actionKindOf } from './descriptions.js'
import { loopbackExport } from './exports.js'
import type { ActionKind, ApprovalQueue, ResourceDescription, ResourceObject } from './protocol.js'
import { ActionLedger, queueGovernance } from './queue.js'
import { assertObserverMaySee, identifyObserver } from './sharing.js'
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

/**
 * What a resource needs beyond its own environment: the Worker's exports.
 *
 * A hook's controller is one of this Worker's own named exports, resolved as
 * `ctx.exports.CatFactoryHookController` against the DEPLOYMENT's entry module, and the shell is
 * the only place that bag exists. It is a dependency rather than a lookup so this core stays
 * drivable in process, where the suite supplies its own.
 */
export interface ResourceDependencies {
  /** The Worker's own exports, as the object model reaches them. */
  exports: unknown
}

/** One bound resource: the session it opens, its types, and the action lifecycle behind it. */
export class ResourceCore implements ResourceObject {
  readonly #env: GatekeeperEnv
  readonly #policy: GatekeeperPolicy
  readonly #props: ResourceProps
  readonly #deps: ResourceDependencies
  readonly #ledger = new ActionLedger()

  constructor(
    env: GatekeeperEnv,
    policy: GatekeeperPolicy,
    props: ResourceProps,
    deps: ResourceDependencies,
  ) {
    this.#env = env
    this.#policy = policy
    this.#props = props
    this.#deps = deps
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
        // Resolved per bind rather than once per session: the refusal for a deployment missing
        // the export belongs to the call that needed it, and a session that binds no hook is one
        // this Gatekeeper has no reason to refuse at all.
        controllerFor: (props) =>
          loopbackExport<unknown>(this.#deps.exports, 'hookController', props),
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
   * Share this resource's observations onward, if the observer could have read them all directly.
   *
   * The contract's requirement, answered rather than declined: the observer names an account this
   * deployment minted, its policy resolves that account's tier, and the share is admitted only
   * when that tier reaches everything the tier THIS resource is bound at reaches. `sharing.ts`
   * holds the tests and why each is the one the contract asks for, including why the account has
   * to be recognised before its tier means anything.
   *
   * Nothing is recorded about an admitted observer, and that is a property of the rule rather than
   * an omission: every accepted observer can read everything this resource could ever have
   * observed, so there is never an observation to exclude from them afterwards.
   */
  async addObserver(id: string, user: unknown): Promise<void> {
    const gatekeeper = this.#gatekeeper()
    const observerAccount = await identifyObserver(user, {
      recognize: (accountId) => gatekeeper.recognizesAccount(accountId),
    })
    assertObserverMaySee({
      observerId: id,
      observerAccount,
      owner: this.#tier(),
      observer: gatekeeper.tierForAccount(observerAccount),
    })
  }

  /** Idempotent by contract: nothing is recorded about an observer, so nothing is forgotten. */
  async removeObserver(_id: string): Promise<void> {}

  #gatekeeper(): Gatekeeper {
    return Gatekeeper.create(this.#env, this.#policy)
  }

  #tier(): CompiledTier {
    return this.#gatekeeper().tierForAccount(this.#props.accountId)
  }
}
