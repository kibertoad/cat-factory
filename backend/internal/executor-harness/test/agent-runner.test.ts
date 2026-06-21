import { describe, expect, it } from 'vitest'
import { redactAll, secretsToRedact } from '../src/agent-runner.js'

// The subscription runners scrub credentials from any stderr/output they surface in
// errors. For a Claude OAuth token / Anthropic-compatible API key the credential is
// the whole token string; for Codex it is a JSON auth.json blob whose individual
// token values must ALSO be scrubbed, since a CLI can echo one on its own.

describe('secretsToRedact', () => {
  it('returns the raw token for a non-JSON credential (Claude / API key)', () => {
    const token = 'sk-ant-oat01-abcdef-secret-value'
    expect(secretsToRedact(token)).toEqual([token])
  })

  it('harvests nested string values from a Codex auth.json blob', () => {
    const blob = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        access_token: 'access-token-aaaaaaaaaaaa',
        refresh_token: 'refresh-token-bbbbbbbbbbbb',
      },
      account_id: 'acct-cccccccccccc',
    })
    const secrets = secretsToRedact(blob)
    expect(secrets).toContain(blob)
    expect(secrets).toContain('access-token-aaaaaaaaaaaa')
    expect(secrets).toContain('refresh-token-bbbbbbbbbbbb')
    expect(secrets).toContain('acct-cccccccccccc')
    // Short values (< 6 chars) are not harvested — they'd over-redact normal output.
    expect(secrets).not.toContain('chatgpt')
  })
})

describe('redactAll', () => {
  it('scrubs a Codex access token echoed on its own (not as the whole blob)', () => {
    const blob = JSON.stringify({ tokens: { access_token: 'super-secret-access-token' } })
    const stderr = 'Error: 401 from upstream with token super-secret-access-token expired'
    const redacted = redactAll(stderr, secretsToRedact(blob))
    expect(redacted).not.toContain('super-secret-access-token')
    expect(redacted).toContain('***')
  })

  it('leaves text untouched when no secret appears', () => {
    expect(redactAll('a clean line', ['some-secret-value'])).toBe('a clean line')
  })

  it('ignores trivially short secrets that would mangle output', () => {
    expect(redactAll('the cat sat', ['cat'])).toBe('the cat sat')
  })
})
