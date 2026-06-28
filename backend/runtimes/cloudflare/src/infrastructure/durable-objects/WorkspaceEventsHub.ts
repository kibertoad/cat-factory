import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'

/**
 * Per-workspace pub/sub hub. Addressed by `idFromName(workspaceId)`, so every
 * subscriber and every publish for a workspace converge on one instance.
 *
 * Uses the WebSocket Hibernation API (`ctx.acceptWebSocket` + the
 * `webSocketMessage`/`webSocketClose`/`webSocketError` methods + `getWebSockets`):
 * accepted sockets survive the DO being evicted from memory, so an idle workspace
 * costs nothing. The handlers must be METHODS (not `addEventListener` closures)
 * precisely because hibernation reconstructs the instance to deliver an event.
 */
export class WorkspaceEventsHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Answer client "ping" frames with "pong" at the edge, without waking the DO —
    // so heartbeats keep the connection alive without billing or breaking hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Internal broadcast: fan a pre-serialised JSON event out to every socket. When the
    // publish names an origin connection (`X-Origin-Cid`), skip the socket that carried that
    // `?cid=` — the connection that caused the change already has the authoritative REST
    // result, so echoing it back would only make it refresh off (and fight) its own move.
    if (request.method === 'POST' && url.pathname === '/publish') {
      const body = await request.text()
      const originCid = request.headers.get('X-Origin-Cid')
      for (const ws of this.ctx.getWebSockets()) {
        if (originCid && ws.deserializeAttachment() === originCid) continue
        try {
          ws.send(body)
        } catch {
          // Socket is mid-close; the close handler reaps it. Ignore.
        }
      }
      return new Response(null, { status: 204 })
    }

    // WebSocket upgrade: accept the server end into the hibernatable set and hand
    // the client end back as a 101 so it flows out through the Worker.
    if (request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      // NOT server.accept() — that pins the DO in memory and disables hibernation.
      this.ctx.acceptWebSocket(server)
      // Remember this connection's id (survives hibernation via the attachment) so a later
      // /publish can skip echoing a board mutation back to the connection that caused it.
      const cid = url.searchParams.get('cid')
      if (cid) server.serializeAttachment(cid)
      return new Response(null, { status: 101, webSocket: client })
    }

    return new Response('expected a websocket upgrade or POST /publish', { status: 400 })
  }

  // ---- Hibernation handlers (must be class methods) ------------------------

  override async webSocketMessage(): Promise<void> {
    // Subscribers are receive-only; ignore inbound frames (ping/pong is auto-handled).
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(): Promise<void> {
    // The socket is dropped from getWebSockets() automatically; nothing to do.
  }
}
