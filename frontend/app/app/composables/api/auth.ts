import {
  acceptInvitationContract,
  authConfigContract,
  logoutContract,
  meContract,
  passwordLoginContract,
  peekInvitationContract,
  signupContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** Auth/session endpoints + the events-WebSocket ticket mint. */
export function authApi({ http, send, ws }: ApiContext) {
  return {
    // ---- auth -------------------------------------------------------------
    // The `/auth/*` JSON endpoints are mounted under the `/auth` prefix; their
    // contract paths are relative to it.
    getAuthConfig: () => send(authConfigContract, { pathPrefix: '/auth' }),

    getMe: () => send(meContract, { pathPrefix: '/auth' }),

    signup: (body: { email: string; password: string; name?: string; invite?: string }) =>
      send(signupContract, { pathPrefix: '/auth', body }),

    passwordLogin: (body: { email: string; password: string }) =>
      send(passwordLoginContract, { pathPrefix: '/auth', body }),

    peekInvite: (token: string) =>
      send(peekInvitationContract, { pathPrefix: '/auth', pathParams: { token } }),

    acceptInvite: (token: string) =>
      send(acceptInvitationContract, { pathPrefix: '/auth', pathParams: { token } }),

    logout: () => send(logoutContract, { pathPrefix: '/auth' }),

    // Mint a short-lived, workspace-scoped ticket for the events WebSocket. A
    // browser can't set Authorization on a WS handshake, so the socket auths from
    // this `?ticket=` instead of the long-lived session token. Empty string when
    // auth is disabled (dev) — the handshake is open in that case.
    // No route contract exists for this endpoint, so it stays on the raw `http` client.
    mintEventsTicket: (workspaceId: string) =>
      http<{ ticket: string; expiresInMs?: number }>(`${ws(workspaceId)}/events/ticket`, {
        method: 'POST',
      }),
  }
}
