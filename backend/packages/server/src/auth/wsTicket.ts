import type { AuthConfig } from '../config/types.js'
import { HmacSigner, TOKEN_AUDIENCE } from './signing.js'

// The short-lived, single-workspace ticket that authorises ONE WebSocket event-stream
// handshake. A browser can't set `Authorization` on a WS handshake, so the SPA mints
// this over the authenticated REST channel (`POST .../events/ticket`) and passes it as
// `?ticket=`. It is audience-pinned (`ws`) and bound to one `workspaceId`, so it cannot
// be replayed as a session, against the LLM proxy, or for another workspace.
//
// The mint + verify live here (not inline in the controller) because both runtimes need
// them: the Cloudflare Worker verifies inside the shared `eventsController` GET handler,
// while the Node service verifies in its HTTP-server `upgrade` listener (the upgrade
// can't be expressed as a Hono `Response` there, so it bypasses the controller). One
// implementation keeps the two handshakes authorising identically.

/** Ticket lifetime: just long enough to open the socket. */
export const WS_TICKET_TTL_MS = 60 * 1000

export interface WsTicket {
  aud: typeof TOKEN_AUDIENCE.wsTicket
  workspaceId: string
  exp: number
}

/**
 * Mint a workspace-scoped WS ticket. Returns `''` when auth is disabled (dev) — the
 * handshake is then open and no ticket is needed.
 */
export async function mintWsTicket(auth: AuthConfig, workspaceId: string): Promise<string> {
  if (!auth.enabled) return ''
  const ticket: WsTicket = {
    aud: TOKEN_AUDIENCE.wsTicket,
    workspaceId,
    exp: Date.now() + WS_TICKET_TTL_MS,
  }
  return new HmacSigner(auth.sessionSecret).sign(ticket)
}

/**
 * The verdict of authorising a WS upgrade, modelled so each facade maps it to its own
 * transport's rejection (an HTTP status on the Worker's `Response`, a raw status line
 * on the Node socket).
 */
export type WsUpgradeAuth =
  | { ok: true }
  | { ok: false; status: 401 | 503; message: string }

/**
 * Authorise a WS event-stream upgrade for `workspaceId` from its `?ticket=`:
 *   - auth enabled  → require a valid, unexpired, workspace-matching ticket (else 401)
 *   - auth disabled but dev-open → allow (open handshake)
 *   - auth unconfigured in production → 503 (mirror `requireAuth`: fail closed)
 */
export async function authorizeWsUpgrade(
  auth: AuthConfig,
  ticket: string | undefined,
  workspaceId: string,
): Promise<WsUpgradeAuth> {
  if (auth.enabled) {
    const verified = await new HmacSigner(auth.sessionSecret).verify<WsTicket>(ticket, {
      aud: TOKEN_AUDIENCE.wsTicket,
    })
    if (!verified || verified.workspaceId !== workspaceId) {
      return { ok: false, status: 401, message: 'unauthorized' }
    }
    return { ok: true }
  }
  if (!auth.devOpen) {
    return { ok: false, status: 503, message: 'authentication is required but not configured' }
  }
  return { ok: true }
}
