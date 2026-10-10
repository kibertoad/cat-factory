import type { Context } from 'hono'
import type { WorkspaceRole } from '@cat-factory/contracts'
import type { GateActor } from '@cat-factory/kernel'
import { UNATTRIBUTED_GATE_ACTOR } from '@cat-factory/kernel'
import type { AppEnv, ServerContainer } from './env.js'
import { loadWorkspaceAccess } from './workspaceAccess.js'

/**
 * The admission facts a run start CONSUMES off the request, in one place.
 *
 * Sibling of `params.ts`'s `param()` and the `guards.ts` accessors: a one-line total accessor in
 * place of a nullable read every start route would otherwise restate. That restating is what this
 * exists to stop — the role-scoped merge policy shipped wired into `ExecutionController` alone,
 * so the bug-hunt adopt route (a member-tier start, through a different module) minted runs that
 * pinned no role and therefore escaped both the role narrowing and the sandbox.
 */

/**
 * The workspace ROLE the request's caller holds, as the auth gate already resolved it.
 *
 * READ, never re-derived: `mountAuthGate` calls the single `loadWorkspaceAccess` on every
 * `/workspaces/:ws/*` request and publishes the result, and workspace-rbac keeps membership
 * resolution in exactly one place (ADR 0025). A controller that resolved it again would be a
 * second answer to a question with one authority.
 *
 * `null` is a REAL state and the honest reading of dev-open: with auth disabled the gate resolves
 * no access object, so there is no tier to scope by and the run stays on its preset's BASE merge
 * policy rather than being scoped to a guess. See `ExecutionInstance.initiatedByRole` for why
 * absent is deliberately not treated as the lowest tier.
 */
export function runInitiatorRole<E extends AppEnv>(c: Context<E>): WorkspaceRole | null {
  return c.get('workspaceAccess')?.role ?? null
}

/**
 * {@link runInitiatorRole}'s twin for a KEY-authenticated start: the role held by the user a
 * public-API key is BOUND to (`PublicApiKeyRecord.actsAsUserId`), or `null` when it is bound to
 * nobody.
 *
 * A separate function because the two read different places for the same fact. An SPA request
 * arrives behind `mountAuthGate`, which has already resolved the caller's access and published it;
 * `/api/v1` has no such gate, because a key is admitted by SCOPE rather than by membership, so the
 * one identity a key can name has to be resolved here. It goes through the same single authority
 * either way (`loadWorkspaceAccess`, ADR 0025) and so reads THROUGH its cache rather than
 * re-deriving membership.
 *
 * Resolving it is what keeps a bound key's run under the SAME policy that person gets in the app.
 * A start that pins an initiator but no role is not a run with a lenient policy, it is a run with
 * no policy: `dryRunForcedForRole` sees no role to sandbox, and both role-scoped merge narrowings
 * pass through unnarrowed, so the key would land what its own holder could not land from the
 * board. That gap has shipped once already, on the bug-hunt adopt route, which is why the accessor
 * exists at all.
 *
 * `null` covers two states on purpose: an unbound key (there is no person, as before) and a bound
 * user whose access no longer resolves (they were removed from the roster since minting). Both are
 * honestly "no tier to scope this run by" rather than a lowest tier, exactly as
 * {@link runInitiatorRole} treats dev-open. The key itself stays authorized by its scope; only the
 * role-shaped narrowing has nothing to say.
 */
export async function keyInitiatorRole(
  container: ServerContainer,
  workspaceId: string,
  userId: string | null,
): Promise<WorkspaceRole | null> {
  if (!userId) return null
  const access = await loadWorkspaceAccess(container, workspaceId, userId)
  return access?.allowed ? access.role : null
}

/**
 * The identity RESOLVING a parked gate, for the approver policy a pipeline step may configure
 * (`stepOptions.gateConfig.approvers`) and the quorum it may demand.
 *
 * A total accessor for the same reason {@link runInitiatorRole} is: the engine requires an actor
 * on every gate resolution, so a route that read it as a nullable would restate the same
 * "who is this, and what if nobody" branch, and the one that got it wrong would resolve a gate
 * naming its approvers as though it named nobody.
 *
 * Under dev-open there is no signed-in user and no resolved role, and this returns the
 * `unattributed` actor rather than inventing one. That is a REAL state with a real consequence:
 * a gate that names approvers refuses it, and a quorum above one can never be reached, because
 * counting distinct approvals needs identities the deployment does not have.
 */
export function gateActor<E extends AppEnv>(c: Context<E>): GateActor {
  const user = c.get('user')
  if (!user) {
    return { id: UNATTRIBUTED_GATE_ACTOR, kind: 'unattributed', role: runInitiatorRole(c) }
  }
  return {
    id: user.id,
    kind: 'user',
    role: runInitiatorRole(c),
    label: user.name ?? user.login,
  }
}
