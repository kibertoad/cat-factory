import type {
  BackendMisconfigured,
  InfrastructureCapabilities,
  LocalModeConfig,
} from '@cat-factory/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AuthUser } from '~/types/domain'
import { retryWhileBackendUnreachable } from '~/utils/backendReady'

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
    /**
     * Source-control providers a HOSTED facade (remote node) accepts a user-supplied PAT for.
     * Drives the login screen's "sign in with a PAT" option on non-local deployments. Empty on
     * the Worker (OAuth-only) and in local mode (which uses `localMode.patLogin` instead).
     */
    const patProviders = ref<('github' | 'gitlab')[]>([])
    /**
     * Test-only: the backend advertised that it runs with NO authentication (its
     * `TESTING_NO_AUTH` opt-in). When set, the SPA renders the board anonymously instead of
     * gating to the login screen — even on a remote facade. Only ever true under the e2e suite.
     */
    const testingNoAuth = ref(false)
    /**
     * Local-mode signals from the backend. Present only when running the local facade;
     * `githubPatSetupUrl` is set when local mode has no GitHub PAT configured (drives the
     * setup banner). Null on every other facade.
     */
    const localMode = ref<LocalModeConfig | null>(null)
    /**
     * The deployment's infrastructure execution backends (which agent-container runtime + test
     * environment options exist, and the deployment default active one). Drives the
     * Infrastructure window's backend selector. Null until the auth handshake resolves / on a
     * facade that doesn't report it.
     */
    const infrastructure = ref<InfrastructureCapabilities | null>(null)
    /**
     * Local mode only: the source-control provider the user last chose to sign in with
     * (its PAT lives server-side in env — this is just the non-secret choice). Persisted, so
     * on a later load we silently re-mint a session from that env PAT without showing the
     * login screen. Set on an explicit sign-in, cleared on logout / 401 (so logout actually
     * signs out — no auto re-login loop).
     */
    const autoLoginProvider = ref<'github' | 'gitlab' | null>(null)
    /** True once the initial auth handshake has settled. */
    const ready = ref(false)
    /**
     * Set when the backend answered its boot handshake but reported that it is MISCONFIGURED — it
     * failed to start normally because a mandatory env var / binding is missing, and is serving the
     * fallback backend that lists the problems (each carries only a name + meaning + remedy, never a
     * secret). Present ⇒ the SPA renders the dedicated misconfiguration screen instead of the
     * login/board. Null on a normally-booted backend.
     */
    const misconfigured = ref<BackendMisconfigured | null>(null)
    /**
     * Mothership mode: the last mothership sign-in failure (node unreachable / rejected session),
     * or null. Set when the post-OAuth connect exchange fails, so the login screen can tell the
     * user the click didn't take instead of silently returning them to the sign-in button.
     */
    const mothershipError = ref<string | null>(null)
    /**
     * True only once `getAuthConfig()` has resolved successfully. Distinguishes "the backend
     * told us auth is off" from "we never reached the backend" (the bootstrap catch path),
     * so an unreachable backend falls through to the board's own error UI instead of being
     * mistaken for an unauthenticated session and gated to the login screen.
     */
    const configLoaded = ref(false)
    /**
     * Whether this is the local-mode facade. Only the local facade reports `localMode`; the
     * remote node service and the Cloudflare Worker never do. Used to tell "a developer's
     * own machine (anonymous-but-dev-open is its own thing)" apart from "a remote deployment
     * that has no anonymous tier".
     */
    const isLocalFacade = computed(() => localMode.value !== null)

    /** May the app render? True when auth is off, or on with a known user. */
    const isAuthenticated = computed(() => !required.value || user.value !== null)

    /** Whether the backend reported itself misconfigured (drives the dedicated error screen). */
    const isMisconfigured = computed(() => misconfigured.value !== null)

    /**
     * Whether the SPA must show the login screen before the board.
     *
     * - Auth-enabled deployments gate on a user as before.
     * - Local mode ALSO gates (even though its API stays dev-open), because anonymous local
     *   use can't store per-user credentials — see the login flow.
     * - A REMOTE facade (node service / Worker) has NO anonymous tier: once the auth handshake
     *   has resolved and there's no user, gate — even when the backend reports auth "disabled"
     *   (a misconfigured/dev-open remote running without a provider). Previously this slipped
     *   through and dropped the user onto a board where every per-user action silently failed
     *   with no sign-in affordance; the login screen now surfaces that state (offering a
     *   provider, or explaining that none is configured).
     */
    const needsLogin = computed(() => {
      if (!configLoaded.value || user.value !== null) return false
      // A deployment that explicitly runs with no auth (the test opt-in) renders anonymously.
      if (testingNoAuth.value) return false
      if (isLocalFacade.value) return required.value || localMode.value?.enabled === true
      return true
    })

    /** Pull a token handed back in the post-login URL fragment (#token=…). */
    function consumeRedirectToken() {
      if (typeof window === 'undefined') return
      const match = /(?:^#|[#&])token=([^&]+)/.exec(window.location.hash)
      if (!match) return
      token.value = decodeURIComponent(match[1]!)
      // Strip the token from the URL so it isn't left in history or shared.
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }

    /**
     * Mothership mode: when the mothership OAuth redirect returns here (flagged
     * `?mothership_connect=1`), the URL fragment carries a MOTHERSHIP session — not a local one.
     * Hand it to our OWN node, which exchanges it for a cached machine token and returns a LOCAL
     * session for the same user. Returns true when it handled the redirect (so the caller skips
     * the normal `consumeRedirectToken`, which would wrongly store the mothership session locally).
     */
    async function maybeConnectMothership(): Promise<boolean> {
      if (typeof window === 'undefined') return false
      const params = new URLSearchParams(window.location.search)
      if (params.get('mothership_connect') !== '1') return false
      const match = /(?:^#|[#&])token=([^&]+)/.exec(window.location.hash)
      const session = match ? decodeURIComponent(match[1]!) : null
      // Clean the flag + fragment from the URL regardless of outcome, so it isn't left in history.
      params.delete('mothership_connect')
      const qs = params.toString()
      history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
      if (!session) return true
      try {
        const result = await api.connectMothership(session)
        applySession({ token: result.session, user: result.user })
        mothershipError.value = null
      } catch (err) {
        // Surface the failure so the login screen shows it, rather than silently dropping the
        // user back on the sign-in button as if the click did nothing. The captured session is
        // already stripped from the URL, so recovery is a fresh "Sign in via mothership".
        mothershipError.value =
          err instanceof Error ? err.message : 'Could not connect to the mothership'
      }
      return true
    }

    /**
     * Mothership mode: sign in through the hosted mothership. The mothership owns identity + the
     * allowlist, so we send the browser to ITS OAuth and return here flagged for the connect
     * exchange (`maybeConnectMothership`). No-op if the mothership URL isn't known.
     */
    function signInViaMothership() {
      if (typeof window === 'undefined') return
      const base = localMode.value?.mothershipUrl
      if (!base) return
      mothershipError.value = null
      const here = new URL(window.location.origin + window.location.pathname)
      here.searchParams.set('mothership_connect', '1')
      const redirect = new URLSearchParams({ redirect: here.toString() })
      window.location.href = `${base.replace(/\/$/, '')}/auth/login?${redirect}`
    }

    /** Resolve auth state: capture any redirect token, then check the backend. */
    async function bootstrap() {
      // A returning mothership-connect redirect is handled first (it carries a mothership session,
      // which must be exchanged — not stored as a local token by `consumeRedirectToken`).
      if (!(await maybeConnectMothership())) consumeRedirectToken()
      try {
        // Tolerate a cold-start race: when the SPA and backend boot together, this first call
        // can beat the backend's listener by a second or two. Retry a not-listening-yet socket
        // (the gate keeps showing its spinner) instead of degrading to the unreachable screen.
        const config = await retryWhileBackendUnreachable(() => api.getAuthConfig())
        required.value = config.enabled
        if (config.providers) providers.value = config.providers
        patProviders.value = config.patLogin?.providers ?? []
        testingNoAuth.value = config.testingNoAuth ?? false
        localMode.value = config.localMode ?? null
        infrastructure.value = config.infrastructure ?? null
        misconfigured.value = config.misconfigured ?? null
        configLoaded.value = true
        // A misconfigured backend serves only the fallback app; there's no session/board to
        // resolve, so settle here and let the SPA render the misconfiguration screen.
        if (misconfigured.value) {
          ready.value = true
          return
        }
      } catch {
        // Backend unreachable — let the board's own error UI handle it (configLoaded stays
        // false, so we never mistake this for an unauthenticated session and gate it).
        required.value = false
        ready.value = true
        return
      }

      // Resolve a stored session into a user whenever sign-in applies — auth-enabled
      // deployments, OR local mode (which mints real sessions via PAT/password even though
      // its API otherwise runs dev-open). Without this, a local session wouldn't survive a
      // reload.
      if ((required.value || localMode.value?.enabled === true) && token.value) {
        try {
          user.value = (await api.getMe()).user
        } catch {
          user.value = null
        }
        if (!user.value) token.value = null
      }

      // Local mode: if no live session resolved but the user previously signed in with a
      // configured env PAT, silently re-mint a session from it — so an expired/rotated token
      // never forces the login screen again. The token itself stays server-side; we only
      // remembered the provider choice. Guard on the provider STILL being configured (PAT could
      // have been removed) and clear the choice on failure so we fall back to the login screen
      // instead of looping.
      if (
        localMode.value?.enabled === true &&
        user.value === null &&
        autoLoginProvider.value &&
        localMode.value.patLogin?.configured.includes(autoLoginProvider.value)
      ) {
        try {
          await patLogin({ provider: autoLoginProvider.value })
        } catch {
          autoLoginProvider.value = null
        }
      }
      // An already-signed-in user who followed an invite link redeems it here (a
      // brand-new user redeems it server-side during signup/OAuth instead).
      if (user.value) await maybeAcceptInvite()
      ready.value = true
    }

    /** Redeem an `?invite=` token in the URL for the signed-in user, then clean the URL. */
    async function maybeAcceptInvite() {
      if (typeof window === 'undefined') return
      const params = new URLSearchParams(window.location.search)
      const inviteToken = params.get('invite')
      if (!inviteToken) return
      try {
        await api.acceptInvite(inviteToken)
      } catch {
        // Stale/already-accepted invite — ignore and let the app load normally.
      }
      params.delete('invite')
      const qs = params.toString()
      history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
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
      token,
      user,
      required,
      providers,
      patProviders,
      testingNoAuth,
      localMode,
      infrastructure,
      autoLoginProvider,
      ready,
      mothershipError,
      configLoaded,
      misconfigured,
      isLocalFacade,
      isAuthenticated,
      isMisconfigured,
      needsLogin,
      bootstrap,
      login,
      loginWithGoogle,
      signInViaMothership,
      signup,
      passwordLogin,
      patLogin,
      forgotPassword,
      resetPassword,
      logout,
      handleUnauthorized,
    }
  },
  { persist: { pick: ['token', 'autoLoginProvider'] } },
)
