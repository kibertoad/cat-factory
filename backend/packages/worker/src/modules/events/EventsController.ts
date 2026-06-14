import { Hono } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { HmacSigner, type SessionPayload } from '../../infrastructure/auth/signing'

/**
 * Real-time event stream: a WebSocket the SPA subscribes to for live
 * execution/board updates, replacing the old `tick` polling. The connection is
 * forwarded to the per-workspace WorkspaceEventsHub Durable Object, which holds
 * the socket (hibernatable) and broadcasts events the engine publishes.
 *
 * A browser can't set `Authorization` on a WebSocket handshake, so this route
 * authenticates from the `?token=` query param — verified with the same HMAC
 * signer and `devOpen`/fail-closed rules as the header-based gate (see
 * requireAuth). The default-deny gate in app.ts bypasses only this exact upgrade
 * shape; the check below is what actually protects it.
 */
export function eventsController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/workspaces/:workspaceId/events', async (c) => {
    if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
      return c.text('expected a websocket upgrade', 426)
    }

    const cfg = c.get('container').config.auth
    if (cfg.enabled) {
      const user = await new HmacSigner(cfg.sessionSecret).verify<SessionPayload>(
        c.req.query('token'),
      )
      if (!user) return c.text('unauthorized', 401)
    } else if (!cfg.devOpen) {
      // Mirror requireAuth: fail closed when auth is unconfigured in production.
      return c.text('authentication is required but not configured', 503)
    }

    const namespace = c.env.WORKSPACE_EVENTS
    if (!namespace) return c.text('real-time events are not enabled', 501)

    // Forward the original request so the 101 + live `webSocket` flows back out.
    const stub = namespace.get(namespace.idFromName(param(c, 'workspaceId')))
    return stub.fetch(c.req.raw)
  })

  return app
}
