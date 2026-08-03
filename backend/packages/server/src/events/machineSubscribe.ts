import type { AuthConfig } from '../config/types.js'
import { type MachinePayload, TOKEN_AUDIENCE, signerFor } from '../auth/signing.js'

// Mothership-mode real-time INBOUND subscribe (docs/initiatives/mothership-mode.md, PR 2).
//
// The OUTBOUND leg (`POST /internal/events/publish`) carries a laptop's engine events UP to the
// mothership. This is the mirror: a mothership-mode node opens a long-lived subscription to the
// mothership's per-workspace stream so org activity raised ELSEWHERE — by a hosted teammate, or by
// a peer laptop relaying upstream — reaches the laptop's own SPA. Without it a mothership-mode
// board is write-only in real time: the laptop pushes but never hears.
//
// The mothership SERVE side is deliberately not a new fan-out. It is the SAME per-workspace
// realtime transport the browser stream already uses (`gateways.realtime.upgrade` — the
// `WorkspaceEventsHub` Durable Object on Cloudflare, the `NodeRealtimeHub` on Node), reached over
// a machine-authed route. So a subscribed node is, to the mothership, just another socket in the
// workspace's room: no per-runtime subscriber registry to invent, and a relayed event fans to
// laptops and browsers through one code path.
//
// This module is the AUTHORIZATION half, and it lives here (not inline in the controller) for
// exactly the reason `wsTicket.ts` does: both runtimes need it, and they reach the handshake
// differently. Cloudflare authorises inside the shared `eventsRelayController` GET handler; Node
// authorises in its HTTP-server `upgrade` listener, because `@hono/node-server` cannot upgrade
// from a Hono `Response` and the request therefore never reaches the controller. One
// implementation keeps the two handshakes authorising identically.

/**
 * The path the mothership serves the machine subscribe handshake on. Shared so the controller,
 * the Node upgrade listener's matcher, and the local client's URL builder cannot drift.
 * `:workspaceId` is a single path segment; the node's stable `?cid=` rides the query string
 * (matching the browser stream's `?cid=`, which is what the fan-out's echo suppression keys off).
 */
export const MACHINE_EVENTS_SUBSCRIBE_PATH = '/internal/events/subscribe'

/** Matches `/internal/events/subscribe/<workspaceId>`, capturing the (still-encoded) id. */
export const MACHINE_EVENTS_SUBSCRIBE_PATTERN = /^\/internal\/events\/subscribe\/([^/]+)$/

/**
 * The verdict of authorising a machine subscribe handshake, modelled like {@link WsUpgradeAuth}
 * so each facade maps it onto its own transport's rejection (an HTTP `Response` on the Worker, a
 * raw status line written to the socket on Node).
 */
export type MachineSubscribeAuth =
  | { ok: true; payload: MachinePayload }
  | { ok: false; status: 403 | 404 | 503; message: string }

/** Resolves a workspace to its owning account — the mothership's own `workspaceRepository`. */
export type AccountOfWorkspace = (
  workspaceId: string,
) => Promise<string | null | undefined> | string | null | undefined

/**
 * Authorise a machine subscribe handshake for `workspaceId`.
 *
 * The order is load-bearing and mirrors the other `/internal/*` surfaces:
 *
 *  1. **Machine-token audience pin FIRST**, before any capability probe, so a token-less caller
 *     cannot distinguish a mothership from a facade that isn't one (403 either way).
 *  2. **Capability probe** — a facade with no account store to scope against can't serve this
 *     safely, so it reports 503 (only ever reachable WITH a valid token, by step 1).
 *  3. **Account-scope binding** — resolve the workspace to its owning account and refuse
 *     anything outside the token's scope as **404**, the auth gate's existence-non-leak policy.
 *     An unknown workspace and an out-of-scope one are indistinguishable.
 *
 * Note what this deliberately does NOT check: a role. A machine token scopes whole ACCOUNTS, not
 * a role within them (the same rule that keeps admin-gated mutations off the persistence RPC).
 * That is sound here because the subscription is READ-ONLY and workspace-scoped — it delivers the
 * same frames any member of the account already receives over the browser stream, and the
 * transport ignores anything a subscriber sends.
 */
export async function authorizeMachineSubscribe(opts: {
  auth: AuthConfig
  /** The bearer token as presented (already stripped of the `Bearer ` prefix, or raw header). */
  token: string | undefined
  workspaceId: string
  /** The mothership's workspace → account resolver; absent ⇒ this facade is not a mothership. */
  accountOf: AccountOfWorkspace | undefined
  /**
   * The machine-node roster's revocation read (SEC-5), threaded from the facade's
   * `machineNodeRepository`; absent ⇒ no roster is wired and no revocation check runs.
   * This handshake cannot go through the shared HTTP gate (it rides a WS upgrade, not a
   * Hono context), so it takes the same check as an input instead.
   */
  isRevoked?: (nodeId: string) => Promise<boolean>
}): Promise<MachineSubscribeAuth> {
  const secret = opts.auth.sessionSecret
  const payload = secret
    ? await signerFor(secret).verify<MachinePayload>(stripBearer(opts.token), {
        aud: TOKEN_AUDIENCE.machine,
      })
    : null
  if (!payload) return { ok: false, status: 403, message: 'invalid machine token' }
  // Same 403 as an invalid token: the caller holds the token, so there is no oracle to
  // protect, and reconnecting (which mints a fresh node) is the remedy for both.
  if (opts.isRevoked && (await opts.isRevoked(payload.nodeId))) {
    return { ok: false, status: 403, message: 'invalid machine token' }
  }

  if (!opts.accountOf) {
    return { ok: false, status: 503, message: 'event subscription is not enabled' }
  }

  // A resolver failure is treated exactly like "unknown workspace": fail closed, and never let
  // the caller tell a lookup error from an out-of-scope board.
  const accountId = await Promise.resolve(opts.accountOf(opts.workspaceId)).catch(() => undefined)
  if (!accountId || !payload.scope.accountIds.includes(accountId)) {
    return { ok: false, status: 404, message: 'workspace not found' }
  }
  return { ok: true, payload }
}

/** Accepts either a raw token or a full `Authorization: Bearer …` header value. */
export function stripBearer(value: string | undefined): string | undefined {
  return value?.replace(/^Bearer\s+/i, '')
}
