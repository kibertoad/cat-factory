import type { AuthUser } from '~/types/domain'
import type { ApiContext } from './context'

/** Auth/session endpoints + the events-WebSocket ticket mint. */
export function authApi({ http, ws }: ApiContext) {
  return {
    // ---- auth -------------------------------------------------------------
    getAuthConfig: () =>
      http<{
        enabled: boolean
        providers?: { github: boolean; password: boolean; google: boolean }
        /** Local-mode signals; present only when the backend is the local facade. */
        localMode?: { enabled: boolean; githubPatSetupUrl?: string }
      }>('/auth/config'),

    getMe: () => http<{ user: AuthUser | null; enabled: boolean }>('/auth/me'),

    signup: (body: { email: string; password: string; name?: string; invite?: string }) =>
      http<{ token: string; user: AuthUser }>('/auth/signup', { method: 'POST', body }),

    passwordLogin: (body: { email: string; password: string }) =>
      http<{ token: string; user: AuthUser }>('/auth/password-login', { method: 'POST', body }),

    // Request a reset link. Always succeeds (204) regardless of whether the email is
    // registered, so the response can't be used to enumerate accounts.
    forgotPassword: (body: { email: string }) =>
      http('/auth/forgot-password', { method: 'POST', body }),

    // Redeem a reset token + set a new password (throws 400 on an invalid/expired token).
    resetPassword: (body: { token: string; password: string }) =>
      http('/auth/reset-password', { method: 'POST', body }),

    peekInvite: (token: string) =>
      http<{ valid: boolean; email?: string; accountName?: string | null }>(
        `/auth/invitations/${encodeURIComponent(token)}`,
      ),

    acceptInvite: (token: string) =>
      http<{ accountId: string }>(`/auth/invitations/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
      }),

    logout: () => http('/auth/logout', { method: 'POST' }),

    // Mint a short-lived, workspace-scoped ticket for the events WebSocket. A
    // browser can't set Authorization on a WS handshake, so the socket auths from
    // this `?ticket=` instead of the long-lived session token. Empty string when
    // auth is disabled (dev) — the handshake is open in that case.
    mintEventsTicket: (workspaceId: string) =>
      http<{ ticket: string; expiresInMs?: number }>(`${ws(workspaceId)}/events/ticket`, {
        method: 'POST',
      }),
  }
}
