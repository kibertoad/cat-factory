import { Hono } from 'hono'
import { WS_TICKET_TTL_MS, authorizeWsUpgrade, mintWsTicket } from '../../auth/wsTicket.js'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/**
 * Real-time event stream: a WebSocket the SPA subscribes to for live
 * execution/board updates. The connection is handed to the facade's
 * {@link RealtimeGateway} (on the Worker: the per-workspace WorkspaceEventsHub
 * Durable Object; on Node: a WebSocket hub), which holds the socket and broadcasts
 * events the engine publishes.
 *
 * A browser can't set `Authorization` on a WebSocket handshake, so the handshake
 * authenticates from a `?ticket=` query param. The ticket is NOT the long-lived
 * session token (which would leak a full-API, multi-day credential into edge /
 * proxy / Referer logs); it is a short-lived, single-workspace ticket the SPA
 * mints over the authenticated REST channel via `POST .../events/ticket`. The
 * ticket is audience-pinned (`ws`) and bound to one `workspaceId`, so it cannot
 * be replayed as a session, against the LLM proxy, or for another workspace.
 *
 * The default-deny gate (in the facade's app) bypasses only the exact GET upgrade;
 * the per-workspace authorization middleware enforces ownership on the POST mint.
 *
 * The ticket mint/verify primitives live in {@link ../../auth/wsTicket.js} so the Node
 * facade (which handles the upgrade in its HTTP-server `upgrade` listener, not through
 * this controller) authorises identically.
 */

export function eventsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Mint a short-lived, workspace-scoped WS ticket. Reached over the authenticated
  // REST gate; the per-workspace authorization middleware has already confirmed the
  // caller owns :workspaceId before this runs.
  app.post('/workspaces/:workspaceId/events/ticket', async (c) => {
    const cfg = c.get('container').config.auth
    const workspaceId = param(c, 'workspaceId')
    const ticket = await mintWsTicket(cfg, workspaceId)
    // Auth disabled (dev) yields an empty ticket: the handshake is open, none needed.
    return c.json(ticket ? { ticket, expiresInMs: WS_TICKET_TTL_MS } : { ticket: '' })
  })

  app.get('/workspaces/:workspaceId/events', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }

    const cfg = c.get('container').config.auth
    const workspaceId = param(c, 'workspaceId')
    const auth = await authorizeWsUpgrade(cfg, c.req.query('ticket'), workspaceId)
    if (!auth.ok) return c.text(auth.message, auth.status)

    // The actual upgrade is the runtime differentiator (Durable Object on the
    // Worker, a WebSocket hub on Node) — delegate to the realtime gateway.
    const upgraded = await c.get('container').gateways.realtime.upgrade(workspaceId, c.req.raw)
    if (!upgraded) return c.text('real-time events are not enabled', 501)
    return upgraded
  })

  return app
}
