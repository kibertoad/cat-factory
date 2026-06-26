import { describe, expect, it } from 'vitest'
import { stripUrlCredentials } from './ContainerAgentExecutor.js'

// The agent-context observability snapshot promises "never a credential-bearing URL".
// Injected-doc URLs and a tester's ephemeral environmentUrl are operator-supplied, so the
// recorder defangs any embedded `user:pass@` userinfo before storing them.
describe('stripUrlCredentials', () => {
  it('strips user:pass userinfo from an http(s) URL', () => {
    expect(stripUrlCredentials('https://user:secret@host.example/path?q=1')).toBe(
      'https://host.example/path?q=1',
    )
  })

  it('strips a username-only userinfo', () => {
    expect(stripUrlCredentials('https://token@host.example/')).toBe('https://host.example/')
  })

  it('leaves a credential-free URL untouched', () => {
    const url = 'https://host.example/rfc.md#section'
    expect(stripUrlCredentials(url)).toBe(url)
  })

  it('passes non-URL strings and empties through unchanged', () => {
    expect(stripUrlCredentials('not a url')).toBe('not a url')
    expect(stripUrlCredentials('')).toBe('')
  })
})
