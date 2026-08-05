import type { Ref } from 'vue'
import type { AuthUser } from '~/types/domain'

/**
 * Shared reactive state + injected dependencies the auth-store sign-in factory closes over.
 * Created once in the `auth` store setup and threaded into {@link createAuthSessionActions} so
 * the split operations stay behaviourally identical to the original single-closure store — a
 * size-only extraction mirroring `stores/board/` and `stores/pipelines/`, not a new seam.
 */
export interface AuthSessionContext {
  api: ReturnType<typeof useApi>
  /** The backend's base URL, for the browser-navigating OAuth entry points. */
  apiBase: string
  token: Ref<string | null>
  user: Ref<AuthUser | null>
  autoLoginProvider: Ref<'github' | 'gitlab' | null>
}

/**
 * The sign-in / sign-out operations: the browser-navigating OAuth entry points, the
 * email-password + PAT credential flows, and the session teardown paths (explicit logout vs the
 * API client's 401 handler, which differ in whether they forget the remembered PAT provider).
 */
export function createAuthSessionActions(ctx: AuthSessionContext) {
  const { api, apiBase, token, user, autoLoginProvider } = ctx

  /** Build a post-login redirect back to the current page, with an optional invite. */
  function redirectTarget(invite?: string): string {
    const here = window.location.origin + window.location.pathname
    const params = new URLSearchParams({ redirect: here })
    if (invite) params.set('invite', invite)
    return params.toString()
  }

  /** Send the browser to the backend's GitHub login, returning here after. */
  function login(invite?: string) {
    if (typeof window === 'undefined') return
    window.location.href = `${apiBase}/auth/login?${redirectTarget(invite)}`
  }

  /** Send the browser to the backend's Google login, returning here after. */
  function loginWithGoogle(invite?: string) {
    if (typeof window === 'undefined') return
    window.location.href = `${apiBase}/auth/google/login?${redirectTarget(invite)}`
  }

  /**
   * Send the browser to the deployment's OWN identity provider (enterprise SSO), returning here
   * after. One entry point whichever IdP is configured: the backend resolves the provider from its
   * discovery document, so there is nothing per-vendor for the SPA to know.
   */
  function loginWithSso(invite?: string) {
    if (typeof window === 'undefined') return
    window.location.href = `${apiBase}/auth/sso/login?${redirectTarget(invite)}`
  }

  /** Apply a freshly-minted token + user (from password signup/login). */
  function applySession(result: { token: string; user: AuthUser }) {
    token.value = result.token
    user.value = result.user
  }

  /** Register a new email/password user (optionally redeeming an invite). */
  async function signup(body: { email: string; password: string; name?: string; invite?: string }) {
    applySession(await api.signup(body))
  }

  /** Sign in with email/password. */
  async function passwordLogin(body: { email: string; password: string }) {
    applySession(await api.passwordLogin(body))
  }

  /**
   * Local mode: sign in as the account a source-control PAT belongs to. `token` omitted
   * uses the server-configured PAT (one-click); otherwise a pasted token. Resolves to the
   * SAME canonical user as GitHub OAuth would (keyed on the provider's numeric id).
   */
  async function patLogin(body: { provider: 'github' | 'gitlab'; token?: string }) {
    applySession(await api.patLogin(body))
    // Remember the choice so a later load re-mints the session from the env PAT silently.
    autoLoginProvider.value = body.provider
  }

  /** Request a password-reset link by email (always resolves; never reveals existence). */
  async function forgotPassword(email: string) {
    await api.forgotPassword({ email })
  }

  /** Redeem a reset token and set a new password. Throws on an invalid/expired token. */
  async function resetPassword(token: string, password: string) {
    await api.resetPassword({ token, password })
  }

  /** Drop the local session (sessions are stateless server-side). */
  function logout() {
    api.logout().catch(() => {})
    token.value = null
    user.value = null
    // Forget the remembered provider so logout sticks (otherwise bootstrap would
    // immediately re-mint a session from the env PAT).
    autoLoginProvider.value = null
  }

  /**
   * Called by the API client when a request comes back 401. Drops the dead session but KEEPS
   * the remembered provider (unlike logout): a 401 from an expired/rotated token or a
   * transient blip should let the next load silently re-mint from the env PAT, not force the
   * login screen. The guarded re-mint in `bootstrap` clears the choice itself if it genuinely
   * fails (PAT removed/revoked), so there's no re-login loop.
   */
  function handleUnauthorized() {
    token.value = null
    user.value = null
  }

  return {
    applySession,
    login,
    loginWithGoogle,
    loginWithSso,
    signup,
    passwordLogin,
    patLogin,
    forgotPassword,
    resetPassword,
    logout,
    handleUnauthorized,
  }
}
