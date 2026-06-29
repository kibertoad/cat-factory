import { describe, expect, it } from 'vitest'
import { redact, secretsToRedact } from '../src/redact.js'

// `redact` is the single credential scrubber: it applies the pattern rules (GitHub
// token / URL-userinfo shapes) AND scrubs a list of known secret values in one pass.
// `secretsToRedact` builds that value list from a leased subscription credential — for
// a Claude OAuth token / Anthropic-compatible API key the credential is the whole token
// string; for Codex it is a JSON auth.json blob whose individual token values must ALSO
// be scrubbed, since a CLI can echo one on its own.

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
    // Short values (< 12 chars) are not harvested — they'd over-redact normal output.
    expect(secrets).not.toContain('chatgpt')
  })
})

describe('redact (pattern rules)', () => {
  it('redacts userinfo and the embedded token from a clone URL', () => {
    expect(
      redact('fatal: clone https://x-access-token:ghs_SECRET123@github.com/o/r.git'),
    ).not.toContain('ghs_SECRET123')
  })

  it('redacts bare GitHub token shapes', () => {
    expect(redact('x-access-token:ghs_TOPSECRET failed')).not.toContain('ghs_TOPSECRET')
    expect(redact('token ghp_abcDEF123 leaked')).not.toContain('ghp_abcDEF123')
    expect(redact('token github_pat_abc123 leaked')).not.toContain('github_pat_abc123')
  })

  it('keeps surrounding context intact', () => {
    const token = 'ghs_aBcDeF0123456789'
    const redacted = redact(`remote: Repository not found. url=https://${token}@github.com/o/r`)
    expect(redacted).not.toContain(token)
    expect(redacted).toContain('Repository not found')
  })

  it('scrubs plaintext credential-named assignments a compose stand-up echoes', () => {
    // The high-signal docker-compose stand-up failure case: a dependency prints its own
    // env in the clear. These are neither a token shape nor a known value, so only this
    // rule catches them. Covers both `=` (shell/env) and `:` (yaml/logfmt) separators and
    // a prefixed/quoted value.
    expect(redact('db-1 | POSTGRES_PASSWORD=hunter2 FATAL')).not.toContain('hunter2')
    expect(redact('app-1 | DATABASE_PASSWORD: s3cr3t-value')).not.toContain('s3cr3t-value')
    expect(redact('env DB_ACCESS_KEY=AKIA1234567890 set')).not.toContain('AKIA1234567890')
    expect(redact('config api_key="abcdef123456"')).not.toContain('abcdef123456')
    // The non-secret context survives.
    const redacted = redact('db-1 | POSTGRES_PASSWORD=hunter2 FATAL: boom')
    expect(redacted).toContain('FATAL: boom')
  })

  it('does not clobber a git Author line (the key is not credential-named)', () => {
    const line = 'Author: Jane Doe <jane@example.com>'
    expect(redact(line)).toBe(line)
  })
})

describe('redact (known values)', () => {
  it('scrubs a Codex access token echoed on its own (not as the whole blob)', () => {
    const blob = JSON.stringify({ tokens: { access_token: 'super-secret-access-token' } })
    const stderr = 'Error: 401 from upstream with token super-secret-access-token expired'
    const redacted = redact(stderr, secretsToRedact(blob))
    expect(redacted).not.toContain('super-secret-access-token')
    expect(redacted).toContain('***')
  })

  it('leaves text untouched when no secret appears', () => {
    expect(redact('a clean line', ['some-secret-value'])).toBe('a clean line')
  })

  it('ignores trivially short secrets that would mangle output', () => {
    expect(redact('the cat sat', ['cat'])).toBe('the cat sat')
  })
})

describe('redact (both rules in one pass)', () => {
  it('scrubs a GitHub-shaped token AND a supplied subscription value together', () => {
    const subscription = 'sk-ant-oat01-the-leased-subscription-token'
    const text = `git: ghs_AbCd1234567890 failed; upstream rejected ${subscription}`
    const redacted = redact(text, [subscription])
    expect(redacted).not.toContain('ghs_AbCd1234567890')
    expect(redacted).not.toContain(subscription)
  })
})
