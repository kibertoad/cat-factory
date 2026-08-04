import { Hono } from 'hono'
import { verifyMachineRequest } from '../../auth/machineGate.js'
import type { RelayedRealtimeEvent } from '../../events/machineEvents.js'
import {
  MACHINE_SUBSCRIBE_ERROR_CODE,
  authorizeMachineSubscribe,
} from '../../events/machineSubscribe.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Upper bound on a relayed `payload` frame (characters). A serialized `WorkspaceEvent` is small
 * (ids + a reason + a compact instance snapshot); 1 MiB is a generous ceiling that still brakes a
 * compromised node from forwarding an unbounded blob into the mothership's fan-out. The frame is
 * delivered to browsers verbatim, so this is the one size backstop on a new machine-facing surface.
 */
const MAX_RELAYED_PAYLOAD_CHARS = 1_000_000

/**
 * The mothership-mode real-time machine API — BOTH directions:
 * `POST /internal/events/publish` (upstream) and
 * `GET /internal/events/subscribe/:workspaceId` (inbound).
 *
 * A mothership-mode local node runs the engine locally but delegates org/durable state to the
 * mothership. Its engine events must ALSO reach the mothership's real-time fan-out, so a hosted
 * teammate watching the same shared board sees the local node's activity live. The laptop POSTs each
 * event here; the mothership injects it into its OWN realtime delivery (`container.machineEventRelay`,
 * attached by each facade — the Node hub / propagator, or the per-workspace Durable Object on
 * Cloudflare).
 *
 * Security mirrors the persistence RPC (see {@link persistenceController}): gated NOT by the user
 * session `authGate` (its `/internal` prefix is bypassed) but by a `machine`-audience token minted by
 * the mothership for a whitelisted node, and account-scoped — the event's `workspaceId` is resolved
 * to its owning account and a workspace outside the token's scope is refused as 404 (the auth gate's
 * existence-non-leak policy). Auth is checked FIRST, before any availability/seam probe, like the
 * GitHub delegation controller, so the endpoint is not probeable without a token.
 *
 * Mounted on BOTH facades so either a Node or a Cloudflare deployment can be a mothership. A facade
 * not acting as a mothership (no `machineEventRelay` / no `repositories` to resolve scope) serves a
 * 503. See docs/initiatives/mothership-mode.md.
 */
export function eventsRelayController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/internal/events/publish', async (c) => {
    const container = c.get('container')

    // Auth first (before the seam probe) — a token-less caller can't tell a mothership from a
    // non-mothership facade.
    const payload = await verifyMachineRequest(c)
    if (!payload) {
      return c.json(
        { ok: false, error: { code: 'forbidden', message: 'invalid machine token' } },
        403,
      )
    }

    const relay = container.machineEventRelay
    // The account-scope resolution reuses the mothership's own repository registry (attached
    // alongside the relay on every mothership), exactly like the persistence RPC's scope check.
    const workspaceRepository = container.repositories?.workspaceRepository
    if (!relay || !workspaceRepository?.accountOf) {
      return c.json(
        { ok: false, error: { code: 'internal', message: 'event relay not enabled' } },
        503,
      )
    }

    let body: RelayedRealtimeEvent
    try {
      body = (await c.req.json()) as RelayedRealtimeEvent
    } catch {
      return c.json(
        { ok: false, error: { code: 'validation', message: 'invalid request body' } },
        422,
      )
    }
    if (!body || typeof body.workspaceId !== 'string' || typeof body.payload !== 'string') {
      return c.json(
        {
          ok: false,
          error: { code: 'validation', message: 'workspaceId and payload are required' },
        },
        422,
      )
    }
    // Size backstop: the payload is forwarded to browsers verbatim (never re-parsed), so cap it so a
    // compromised node token can't inject an unbounded frame into the mothership's fan-out.
    if (body.payload.length > MAX_RELAYED_PAYLOAD_CHARS) {
      return c.json({ ok: false, error: { code: 'validation', message: 'payload too large' } }, 413)
    }

    // Account-scope binding: resolve the event's workspace to its owning account and reject anything
    // outside the token's scope as 404 (no existence leak), matching the persistence RPC. A workspace
    // the mothership doesn't know (or that belongs to another account) is indistinguishable from a
    // typo — both 404.
    const accountId = (await (
      workspaceRepository.accountOf(body.workspaceId) as Promise<string | null | undefined>
    ).catch(() => undefined)) as string | null | undefined
    if (!accountId || !payload.scope.accountIds.includes(accountId)) {
      return c.json(
        { ok: false, error: { code: 'not_found', message: 'workspace not found' } },
        404,
      )
    }

    // Deliver into the mothership's realtime fan-out. Best-effort by contract — the current relays
    // swallow their own errors, and the controller wraps the call too so a future relay that throws
    // can't turn a best-effort publish into a 500: a delivery hiccup still acks (the persisted row is
    // the source of truth, and the mothership's clients reconcile on reconnect).
    try {
      await relay.ingest({
        workspaceId: body.workspaceId,
        payload: body.payload,
        originConnectionId:
          typeof body.originConnectionId === 'string' ? body.originConnectionId : null,
      })
    } catch {
      // Swallowed by contract (see above).
    }
    return c.json({ ok: true })
  })

  // The INBOUND leg: the node subscribes to a workspace's stream so org activity raised on the
  // mothership (a hosted teammate, or a peer laptop relaying upstream) reaches the laptop's SPA.
  //
  // It is deliberately NOT a new fan-out. The upgrade is handed to the SAME per-workspace realtime
  // transport the browser stream uses (`gateways.realtime.upgrade` — the `WorkspaceEventsHub`
  // Durable Object on Cloudflare), so a subscribed node is just another socket in the workspace's
  // room and every event reaches laptops and browsers through one code path. The node's stable
  // `?cid=` rides through to that transport, which is what lets the mothership skip echoing the
  // node's OWN relayed events back to it (the outbound leg stamps the same id as
  // `originConnectionId`).
  //
  // Auth is the shared `authorizeMachineSubscribe` (token pin → capability → account scope), the
  // same helper the Node facade calls from its HTTP-server `upgrade` listener — Node can't upgrade
  // from a Hono `Response`, so this handler is unreachable there, exactly like the browser stream's
  // GET in `eventsController`.
  app.get(`/internal/events/subscribe/:workspaceId`, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')

    // The scope resolution reuses the mothership's own repository registry (attached alongside the
    // relay on every mothership), exactly like the publish handler above. The registry is
    // reflective (`Record<string, Record<string, fn>>`), so narrow the one method we call.
    const workspaceRepository = container.repositories?.workspaceRepository
    const machineNodes = container.machineNodeRepository
    const auth = await authorizeMachineSubscribe({
      auth: container.config.auth,
      token: c.req.header('authorization'),
      workspaceId,
      accountOf: workspaceRepository?.accountOf
        ? (id) => workspaceRepository.accountOf!(id) as Promise<string | null | undefined>
        : undefined,
      isRevoked: machineNodes ? (nodeId) => machineNodes.isRevoked(nodeId) : undefined,
    })
    if (!auth.ok) {
      // Each verdict status keeps its own code: a node retries an `unavailable` (the roster was
      // unreadable, so revocation could not be checked) and reconnects for a fresh id on a
      // `forbidden`. Collapsing them onto one code would tell it to do the wrong thing.
      const code = MACHINE_SUBSCRIBE_ERROR_CODE[auth.status]
      return c.json({ ok: false, error: { code, message: auth.message } }, auth.status)
    }

    // Checked AFTER auth so the handshake shape isn't probeable without a token.
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }

    const upgraded = await container.gateways.realtime.upgrade(workspaceId, c.req.raw)
    if (!upgraded) return c.text('real-time events are not enabled', 501)
    return upgraded
  })

  return app
}
