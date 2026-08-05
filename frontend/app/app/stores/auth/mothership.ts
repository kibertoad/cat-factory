import type { Ref } from 'vue'
import { SSO_ERROR_FRAGMENT_KEY, parseSsoErrorReason } from '@cat-factory/contracts'
import type { LocalModeConfig } from '@cat-factory/contracts'
import type { AuthUser } from '~/types/domain'
import type { SsoLoginFailure } from '~/utils/sso'

/**
 * Shared reactive state + injected dependencies the auth-store redirect factory closes over.
 * Created once in the `auth` store setup and threaded into {@link createAuthRedirectActions} so
 * the split operations stay behaviourally identical to the original single-closure store — a
 * size-only extraction mirroring `stores/board/` and `stores/pipelines/`, not a new seam.
 */
export interface AuthRedirectContext {
  api: ReturnType<typeof useApi>
  token: Ref<string | null>
  localMode: Ref<LocalModeConfig | null>
  mothershipError: Ref<string | null>
  /** Why the last enterprise-SSO round-trip produced no session, when one was refused. */
  ssoError: Ref<SsoLoginFailure | null>
  /** Apply a freshly-minted token + user (the session factory's setter). */
  applySession: (result: { token: string; user: AuthUser }) => void
}

/**
 * The URL-fragment / redirect handling the boot handshake runs before it resolves a session:
 * capturing a token handed back by our OWN backend's OAuth round-trip, and — in mothership
 * mode — exchanging a returning MOTHERSHIP session for a local one.
 */
export function createAuthRedirectActions(ctx: AuthRedirectContext) {
  const { api, token, localMode, mothershipError, ssoError, applySession } = ctx

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
   * Pull the reason a REFUSED enterprise-SSO round-trip handed back (`#sso_error=<reason>`), the
   * sibling of the `#token=` a successful one sets.
   *
   * A fragment rather than a query for the same reason the token is: it never reaches a server log
   * or a `Referer`, and the reason names the deployment's own admission rules. Stripped from the
   * URL afterwards so a reload doesn't resurrect a stale failure.
   */
  function consumeSsoError() {
    if (typeof window === 'undefined') return
    const match = new RegExp(`(?:^#|[#&])${SSO_ERROR_FRAGMENT_KEY}=([^&]+)`).exec(
      window.location.hash,
    )
    if (!match) return
    // An unrecognised value came from a newer backend than this build: reported as `unknown`
    // rather than rendered raw, and never dropped — the user clicked a button and is owed an
    // answer about why they are back here.
    ssoError.value = parseSsoErrorReason(decodeURIComponent(match[1]!)) ?? 'unknown'
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
   * exchange ({@link maybeConnectMothership}). No-op if the mothership URL isn't known.
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

  return {
    consumeRedirectToken,
    consumeSsoError,
    maybeConnectMothership,
    signInViaMothership,
    maybeAcceptInvite,
  }
}
