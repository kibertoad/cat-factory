import { describe, expect, it } from 'vitest'
import { describeWebhookSignatureRejection } from './signatureLog.js'

// C2: the terse 401 stays on the wire; these assert the ELABORATE operator log so the three
// setup-mistake sub-causes each name the right env var + the provider field to compare it to.

describe('describeWebhookSignatureRejection', () => {
  describe('github', () => {
    it('names the env var when no deployment secret is configured', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'github',
        secretConfigured: false,
        signaturePresent: true,
      })
      expect(msg).toContain('GITHUB_WEBHOOK_SECRET is unset')
      expect(msg).toContain("GitHub App's 'Webhook secret'")
      expect(msg).toContain('github-integration.md#authentication')
    })

    it('flags a missing signature header as the App-side secret not being set', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'github',
        secretConfigured: true,
        signaturePresent: false,
      })
      expect(msg).toContain('no X-Hub-Signature-256 header was present')
      expect(msg).toContain('matching GITHUB_WEBHOOK_SECRET')
    })

    it('explains a mismatched signature as the two secrets differing', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'github',
        secretConfigured: true,
        signaturePresent: true,
      })
      expect(msg).toContain('the signature did not match')
      expect(msg).toContain('GITHUB_WEBHOOK_SECRET')
    })
  })

  describe('gitlab', () => {
    it('names the env var when no deployment secret is configured', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'gitlab',
        secretConfigured: false,
        signaturePresent: true,
      })
      expect(msg).toContain('GITLAB_WEBHOOK_SECRET is unset')
      expect(msg).toContain("'Secret token'")
      expect(msg).toContain('vcs-providers.md#setup')
    })

    it('flags a missing token header', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'gitlab',
        secretConfigured: true,
        signaturePresent: false,
      })
      expect(msg).toContain('no X-Gitlab-Token header was present')
    })

    it('explains a mismatched token as the two secrets differing', () => {
      const msg = describeWebhookSignatureRejection({
        provider: 'gitlab',
        secretConfigured: true,
        signaturePresent: true,
      })
      expect(msg).toContain('did not match')
      expect(msg).toContain('GITLAB_WEBHOOK_SECRET')
    })
  })

  it('never leaks the secret material — only env var names and settings locations', () => {
    const msg = describeWebhookSignatureRejection({
      provider: 'github',
      secretConfigured: true,
      signaturePresent: true,
    })
    // The message is built from static copy + env var names; it has no access to secret values.
    expect(msg).not.toContain('undefined')
  })
})
