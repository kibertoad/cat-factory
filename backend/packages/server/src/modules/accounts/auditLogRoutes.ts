import { listAuditEventsContract, revokeMemberSessionsContract } from '@cat-factory/contracts'
import type { AuditEventWire } from '@cat-factory/contracts'
import type { AuditEventView, UserRecord } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import type { Context, Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// ---------------------------------------------------------------------------
// The account audit log's READ surface, plus the admin-forced session revocation that writes to
// it. The two live together because they are one operator's job: seeing what happened in the
// account, and stopping somebody's access when it should not have.
//
// Registered from `accountController` rather than mounted separately, so the paths stay under the
// account prefix and keep their place in the app's route order. In its own module purely for the
// per-function size budget — `accountController` is already near its ceiling.
//
// Admin-gated for READ as well as write, and the gate lives in the SERVICE (`requireAdmin` /
// `revokeMemberSessions`), not here: the log names who did what to whom, which is exactly the
// roster metadata a non-admin member has no business enumerating, and a service-layer refusal is
// the one every caller of that service inherits.
// ---------------------------------------------------------------------------

export function registerAuditLogRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, listAuditEventsContract, async (c) => {
    const user = requireUser(c, 'Sign in to read the audit log')
    const container = c.get('container')
    // A facade with no audit store refuses with a 503 naming the capability. It must NOT answer
    // with an empty page: "nothing has happened in this account" and "this deployment records
    // nothing" are opposite facts, and the first is the assurance the log exists to give.
    const auditLog = requireCapability(
      container.auditLogReader,
      'The audit log is not configured on this deployment',
    )
    const { accountId } = c.req.valid('param')
    await container.accountService.requireAdmin(accountId, user.id)
    const query = c.req.valid('query')
    // The read PROPAGATES a store failure (the reader port says so): an admin shown an empty page
    // because the store was unreachable has been told the reverse of the truth.
    const page = await auditLog.listByAccount(accountId, {
      cursor: query.cursor ?? null,
      limit: query.limit,
    })
    return c.json(
      { events: await withDisplayNames(c, page.events), nextCursor: page.nextCursor },
      200,
    )
  })

  // Admin-forced offboarding. Everything that decides anything — the admin gate, the
  // account-membership check on the TARGET, the revocation and its audit row — lives in
  // `AccountService.revokeMemberSessions`, per the rule that an audited action is recorded where
  // the actor and the outcome are both known.
  buildHonoRoute(app, revokeMemberSessionsContract, async (c) => {
    const actor = requireUser(c, 'Sign in to manage account members')
    const { accountId, userId } = c.req.valid('param')
    await c.get('container').accountService.revokeMemberSessions(accountId, actor.id, userId)
    return c.body(null, 204)
  })
}

/**
 * Resolve the display name of every person a page of events mentions, in ONE query.
 *
 * An audit row stores ids, deliberately: names change, and the row must go on meaning what it
 * meant when it was written. But an admin reading `usr_01j…` learns nothing, so the ids are
 * resolved at RENDER time against the current roster — the same trade the member panel makes.
 *
 * One `listByIds` over the whole page, never a lookup per row: a 50-event page would otherwise be
 * up to 100 point reads, the N+1 the repository rules ban outright.
 *
 * A name that does not resolve stays null rather than becoming a placeholder. The viewer renders
 * the raw id in that case, which is the honest answer for the case an audit log most needs to
 * survive: the person is gone, and their having been here is precisely what the row records.
 */
async function withDisplayNames<E extends AppEnv>(
  c: Context<E>,
  events: AuditEventView[],
): Promise<AuditEventWire[]> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.actor.kind === 'user') ids.add(event.actor.userId)
    // `targetType` widens to a RETIRED value on read, so this compares against the current member
    // rather than assuming the stored string is one. A retired target type resolves no name, which
    // is correct: nothing here knows what its `targetId` referenced.
    if (event.targetType === 'user') ids.add(event.targetId)
  }
  // Annotated rather than inferred: the ternary's two arms are `never[]` and `UserRecord[]`, and
  // `.map` over that union loses its parameter type.
  const users: UserRecord[] =
    ids.size === 0 ? [] : await c.get('container').userService.listByIds([...ids])
  // Name first, email as the fallback: a GitHub-only user may carry no display name, and an email
  // still tells an admin who they are reading about. Both absent ⇒ null, and the id is rendered.
  const byId = new Map(users.map((u) => [u.id, u.name ?? u.email]))
  // Projected FIELD BY FIELD rather than spread. The stored view carries `accountId` (which the
  // request path already names, so repeating it is noise) and an OPTIONAL `workspaceId`, while the
  // wire shape commits to a nullable one — a spread would hand `undefined` to a client that was
  // promised `null`, which is the difference between "no board" and "the server forgot to say".
  return events.map((event) => ({
    id: event.id,
    at: event.at,
    workspaceId: event.workspaceId ?? null,
    actor: event.actor,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    details: event.details,
    actorName: (event.actor.kind === 'user' ? byId.get(event.actor.userId) : null) ?? null,
    targetName: (event.targetType === 'user' ? byId.get(event.targetId) : null) ?? null,
  }))
}
