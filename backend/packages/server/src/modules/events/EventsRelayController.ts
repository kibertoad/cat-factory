import { Hono } from 'hono'
import { type MachinePayload, TOKEN_AUDIENCE, signerFor } from '../../auth/signing.js'
import type { RelayedRealtimeEvent } from '../../events/machineEvents.js'
import type { AppEnv } from '../../http/env.js'

/**
 * The mothership-mode real-time UPSTREAM machine API: `POST /internal/events/publish`.
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
    const secret = container.config.auth.sessionSecret
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    const payload = secret
      ? await signerFor(secret).verify<MachinePayload>(token, { aud: TOKEN_AUDIENCE.machine })
      : null
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
        { ok: false, error: { code: 'validation', message: 'workspaceId and payload are required' } },
        422,
      )
    }

    // Account-scope binding: resolve the event's workspace to its owning account and reject anything
    // outside the token's scope as 404 (no existence leak), matching the persistence RPC. A workspace
    // the mothership doesn't know (or that belongs to another account) is indistinguishable from a
    // typo — both 404.
    const accountId = (await (
      workspaceRepository.accountOf(body.workspaceId) as Promise<string | null | undefined>
    ).catch(() => undefined)) as string | null | undefined
    if (!accountId || !payload.scope.accountIds.includes(accountId)) {
      return c.json({ ok: false, error: { code: 'not_found', message: 'workspace not found' } }, 404)
    }

    // Deliver into the mothership's realtime fan-out. Best-effort by contract (the relay swallows its
    // own errors), so a delivery hiccup still acks — the persisted row is the source of truth.
    await relay.ingest({
      workspaceId: body.workspaceId,
      payload: body.payload,
      originConnectionId: typeof body.originConnectionId === 'string' ? body.originConnectionId : null,
    })
    return c.json({ ok: true })
  })

  return app
}
