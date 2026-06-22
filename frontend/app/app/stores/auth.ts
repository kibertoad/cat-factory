import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AuthUser } from '~/types/domain'

/**
 * "Login with GitHub" session state. The backend mints a signed session token
 * and hands it back via a URL fragment after the OAuth round-trip; we persist
 * just that token and replay it as a bearer header on every API call (see
 * `useApi`). Auth is opt-in on the backend, so `required` gates whether the UI
 * shows a login screen at all — when the backend has auth disabled the app runs
 * exactly as before.
 */
export const useAuthStore = defineStore(
  'auth',
  () => {
    const api = useApi()
    const apiBase = useRuntimeConfig().public.apiBase

    /** Signed session token (persisted), or null when signed out. */
    const token = ref<string | null>(null)
    /** The signed-in user, resolved from the token on boot. */
    const user = ref<AuthUser | null>(null)
    /** Whether the backend requires authentication. */
    const required = ref(false)
    /** Which login providers the backend offers (drives the login UI). */
    const providers = ref({ github: false, password: false, google: false })
    /** True once the initial auth handshake has settled. */
    const ready = ref(false)

    /** May the app render? True when auth is off, or on with a known user. */
    const isAuthenticated = computed(() => !required.value || user.value !== null)

    /** Pull a token handed back in the post-login URL fragment (#token=…). */
    function consumeRedirectToken() {
      if (typeof window === 'undefined') return
      const match = /(?:^#|[#&])token=([^&]+)/.exec(window.location.hash)
      if (!match) return
      token.value = decodeURIComponent(match[1]!)
      // Strip the token from the URL so it isn't left in history or shared.
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }

    /** Resolve auth state: capture any redirect token, then check the backend. */
    async function bootstrap() {
      consumeRedirectToken()
      try {
        const config = await api.getAuthConfig()
        required.value = config.enabled
        if (config.providers) providers.value = config.providers
      } catch {
        // Backend unreachable — let the board's own error UI handle it.
        required.value = false
        ready.value = true
        return
      }

      if (required.value && token.value) {
        try {
          user.value = (await api.getMe()).user
        } catch {
          user.value = null
        }
        if (!user.value) token.value = null
      }
      ready.value = true
    }

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

    /** Apply a freshly-minted token + user (from password signup/login). */
    function applySession(result: { token: string; user: AuthUser }) {
      token.value = result.token
      user.value = result.user
    }

    /** Register a new email/password user (optionally redeeming an invite). */
    async function signup(body: {
      email: string
      password: string
      name?: string
      invite?: string
    }) {
      applySession(await api.signup(body))
    }

    /** Sign in with email/password. */
    async function passwordLogin(body: { email: string; password: string }) {
      applySession(await api.passwordLogin(body))
    }

    /** Drop the local session (sessions are stateless server-side). */
    function logout() {
      api.logout().catch(() => {})
      token.value = null
      user.value = null
    }

    /** Called by the API client when a request comes back 401. */
    function handleUnauthorized() {
      token.value = null
      user.value = null
    }

    return {
      token,
      user,
      required,
      providers,
      ready,
      isAuthenticated,
      bootstrap,
      login,
      loginWithGoogle,
      signup,
      passwordLogin,
      logout,
      handleUnauthorized,
    }
  },
  { persist: { pick: ['token'] } },
)
