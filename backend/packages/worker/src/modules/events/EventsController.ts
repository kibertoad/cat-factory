import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { HmacSigner, TOKEN_AUDIENCE } from '../../infrastructure/auth/signing'

/**
 * Real-time event stream: a WebSocket the SPA subscribes to for live
 * execution/board updates, replacing the old `tick` polling. The connection is
 * forwarded to the per-workspace WorkspaceEventsHub Durable Object, which holds
 * the socket (hibernatable) and broadcasts events the engine publishes.
 *
 * A browser can't set `Authorization` on a WebSocket handshake, so the handshake
 * authenticates from a `?ticket=` query param. The ticket is NOT the long-lived
 * session token (which would leak a full-API, multi-day credential into edge /
 * proxy / Referer logs); it is a short-lived, single-workspace ticket the SPA
 * mints over the authenticated REST channel via `POST .../events/ticket`. The
 * ticket is audience-pinned (`ws`) and bound to one `workspaceId`, so it cannot
 * be replayed as a session, against the LLM proxy, or for another workspace.
 *
 * The default-deny gate in app.ts bypasses only the exact GET upgrade; the
 * per-workspace authorization middleware enforces ownership on the POST mint.
 */

/** Ticket lifetime: just long enough to open the socket. */
const WS_TICKET_TTL_MS = 60 * 1000

interface WsTicket {
  aud: typeof TOKEN_AUDIENCE.wsTicket
  workspaceId: string
  exp: number
}

export function eventsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Mint a short-lived, workspace-scoped WS ticket. Reached over the authenticated
  // REST gate; the per-workspace authorization middleware (app.ts) has already
  // confirmed the caller owns :workspaceId before this runs.
  app.post('/workspaces/:workspaceId/events/ticket', async (c) => {
    const cfg = c.get('container').config.auth
    const workspaceId = param(c, 'workspaceId')
    // Auth disabled (dev): the handshake is open, so no ticket is needed.
    if (!cfg.enabled) return c.json({ ticket: '' })
    const ticket: WsTicket = {
      aud: TOKEN_AUDIENCE.wsTicket,
      workspaceId,
      exp: Date.now() + WS_TICKET_TTL_MS,
    }
    const signed = await new HmacSigner(cfg.sessionSecret).sign(ticket)
    return c.json({ ticket: signed, expiresInMs: WS_TICKET_TTL_MS })
  })

  app.get('/workspaces/:workspaceId/events', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }

    const cfg = c.get('container').config.auth
    const workspaceId = param(c, 'workspaceId')
    if (cfg.enabled) {
      const ticket = await new HmacSigner(cfg.sessionSecret).verify<WsTicket>(
        c.req.query('ticket'),
        { aud: TOKEN_AUDIENCE.wsTicket },
      )
      // Reject a missing/invalid ticket, or one minted for a different workspace.
      if (!ticket || ticket.workspaceId !== workspaceId) return c.text('unauthorized', 401)
    } else if (!cfg.devOpen) {
      // Mirror requireAuth: fail closed when auth is unconfigured in production.
      return c.text('authentication is required but not configured', 503)
    }

    const namespace = c.env.WORKSPACE_EVENTS
    if (!namespace) return c.text('real-time events are not enabled', 501)

    // Forward the original request so the 101 + live `webSocket` flows back out.
    const stub = namespace.get(namespace.idFromName(workspaceId))
    return stub.fetch(c.req.raw)
  })

  return app
}
