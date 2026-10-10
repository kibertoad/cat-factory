import { ref } from 'vue'
import { beforeEach, describe, expect, it } from 'vitest'
import { createAuthRedirectActions } from './mothership'
import type { SsoLoginFailure } from '~/utils/sso'

// The other half of the SSO refusal contract: the backend lands the browser here with a
// machine-readable reason in the fragment, and this is what turns it into state the login screen
// renders. Worth pinning because the failure mode is silent — a reason the SPA drops leaves the
// user back on the same sign-in button with no explanation for the click that just failed.

/** Point `window.location` + `history` at a URL the consumer can read and rewrite. */
function setUrl(path: string): void {
  history.replaceState(null, '', path)
}

function actions() {
  const ssoError = ref<SsoLoginFailure | null>(null)
  const factory = createAuthRedirectActions({
    api: {} as never,
    token: ref<string | null>(null),
    localMode: ref(null),
    mothershipError: ref<string | null>(null),
    ssoError,
    applySession: () => {},
  })
  return { ...factory, ssoError }
}

describe('consumeSsoError', () => {
  beforeEach(() => setUrl('/'))

  it('reads a known reason off the fragment', () => {
    setUrl('/#sso_error=group_required')
    const a = actions()
    a.consumeSsoError()
    expect(a.ssoError.value).toBe('group_required')
  })

  it('strips the fragment so a reload does not resurrect a stale failure', () => {
    setUrl('/board?ws=ws_1#sso_error=state_invalid')
    actions().consumeSsoError()
    expect(window.location.hash).toBe('')
    // The rest of the URL is left alone.
    expect(window.location.pathname + window.location.search).toBe('/board?ws=ws_1')
  })

  it('reports an unrecognised reason as `unknown` rather than dropping it', () => {
    // A reason from a NEWER backend than this build. Rendering the raw wire token to a user is
    // wrong; showing nothing after a failed sign-in is worse.
    setUrl('/#sso_error=reason_from_the_future')
    const a = actions()
    a.consumeSsoError()
    expect(a.ssoError.value).toBe('unknown')
  })

  it('leaves the state untouched when the fragment carries no SSO error', () => {
    setUrl('/#token=abc')
    const a = actions()
    a.consumeSsoError()
    expect(a.ssoError.value).toBeNull()
    // The session token is another consumer's to read, so the fragment must survive.
    expect(window.location.hash).toBe('#token=abc')
  })
})
