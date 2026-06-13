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
        required.value = (await api.getAuthConfig()).enabled
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

    /** Send the browser to the backend's GitHub login, returning here after. */
    function login() {
      if (typeof window === 'undefined') return
      const here = window.location.origin + window.location.pathname
      window.location.href = `${apiBase}/auth/login?redirect=${encodeURIComponent(here)}`
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
      ready,
      isAuthenticated,
      bootstrap,
      login,
      logout,
      handleUnauthorized,
    }
  },
  { persist: { pick: ['token'] } },
)
