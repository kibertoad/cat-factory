import { describe, expect, it } from 'vitest'
import { postSignInUrl } from './postSignIn'

// The regression this exists for: every sign-in path reloaded to `location.pathname`, so a flow
// whose subject rides the query string lost it the moment a person signed in. The MCP consent
// screen is the one that fails hardest, and signing in first is the ordinary way a first connect
// goes, so the loss is on the common path rather than an edge of it.

describe('postSignInUrl', () => {
  it('keeps the query string the destination needs', () => {
    expect(postSignInUrl({ pathname: '/mcp-authorize', search: '?request=sealed-value' })).toBe(
      '/mcp-authorize?request=sealed-value',
    )
  })

  it('drops the invite token, which the signup call already spent', () => {
    // Not a matter of tidiness: a consumed invite left in the address bar is a token in every
    // place a URL gets pasted, and it buys the reader nothing because it no longer works.
    expect(postSignInUrl({ pathname: '/', search: '?invite=tok_1' })).toBe('/')
    expect(postSignInUrl({ pathname: '/', search: '?invite=tok_1&ws=ws_9' })).toBe('/?ws=ws_9')
  })

  it('answers a bare path unchanged, and drops a fragment', () => {
    expect(postSignInUrl({ pathname: '/', search: '' })).toBe('/')
    // The fragment is absent by construction: it is never read here, so a stale one would only
    // scroll the freshly booted app to an anchor the previous screen owned.
    expect(postSignInUrl({ pathname: '/boards', search: '?a=1' })).toBe('/boards?a=1')
  })
})
