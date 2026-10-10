import type {
  BackendMisconfigured,
  InfrastructureCapabilities,
  LocalModeConfig,
  SsoConfigView,
} from '@cat-factory/contracts'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { AuthUser } from '~/types/domain'
import { retryWhileBackendUnreachable } from '~/utils/backendReady'
import { createAuthSessionActions } from '~/stores/auth/session'
import { createAuthRedirectActions } from '~/stores/auth/mothership'
import type { SsoLoginFailure } from '~/utils/sso'

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
    const providers = ref({ github: false, password: false, google: false, sso: false })
    /**
     * Presentation for the deployment's OWN identity provider (enterprise SSO) — its
     * operator-supplied label and protocol. Null unless `providers.sso` is set. The label names
     * the operator's IdP, so it is the one piece of login copy the SPA renders verbatim rather
     * than through the catalog.
     */
    const sso = ref<SsoConfigView | null>(null)
    /**
     * Why the last enterprise-SSO sign-in produced no session, when one was refused. Captured
     * from the `#sso_error=` fragment on boot so the login screen can name the rule that refused
     * instead of returning the user to an unchanged sign-in button.
     */
    const ssoError = ref<SsoLoginFailure | null>(null)
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

    // The sign-in / sign-out operations and the redirect-fragment handling, split into cohesive
    // factories sharing the state above (a size-only extraction mirroring `stores/board/` —
    // behaviour is identical to the former in-closure functions). The redirect factory applies a
    // mothership-exchanged session through the session factory's setter.
    const { applySession, ...session } = createAuthSessionActions({
      api,
      apiBase,
      token,
      user,
      autoLoginProvider,
    })
    const {
      consumeRedirectToken,
      consumeSsoError,
      maybeConnectMothership,
      signInViaMothership,
      maybeAcceptInvite,
    } = createAuthRedirectActions({
      api,
      token,
      localMode,
      mothershipError,
      ssoError,
      applySession,
    })

    /** Resolve auth state: capture any redirect token, then check the backend. */
    async function bootstrap() {
      // A returning mothership-connect redirect is handled first (it carries a mothership session,
      // which must be exchanged — not stored as a local token by `consumeRedirectToken`).
      if (!(await maybeConnectMothership())) consumeRedirectToken()
      // A refused SSO round-trip returns a reason instead of a token, and it must be read BEFORE
      // the config call: the login screen renders from the same settled state either way.
      consumeSsoError()
      try {
        // Tolerate a cold-start race: when the SPA and backend boot together, this first call
        // can beat the backend's listener by a second or two. Retry a not-listening-yet socket
        // (the gate keeps showing its spinner) instead of degrading to the unreachable screen.
        const config = await retryWhileBackendUnreachable(() => api.getAuthConfig())
        required.value = config.enabled
        if (config.providers) providers.value = config.providers
        sso.value = config.sso ?? null
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
          await session.patLogin({ provider: autoLoginProvider.value })
        } catch {
          autoLoginProvider.value = null
        }
      }
      // An already-signed-in user who followed an invite link redeems it here (a
      // brand-new user redeems it server-side during signup/OAuth instead).
      if (user.value) await maybeAcceptInvite()
      ready.value = true
    }

    return {
      token,
      user,
      required,
      providers,
      sso,
      ssoError,
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
      signInViaMothership,
      ...session,
    }
  },
  { persist: { pick: ['token', 'autoLoginProvider'] } },
)
