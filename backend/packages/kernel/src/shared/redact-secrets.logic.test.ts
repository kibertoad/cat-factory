import { describe, expect, it } from 'vitest'
import { isSecretShapedFilename, redactSecrets, redactSecretsDeep } from './redact-secrets.logic.js'

describe('redactSecrets', () => {
  it('passes null/empty through unchanged', () => {
    expect(redactSecrets(null)).toBeNull()
    expect(redactSecrets('')).toBe('')
  })

  it('leaves ordinary prose untouched', () => {
    const text = 'The coder should implement the endpoint and open a PR.'
    expect(redactSecrets(text)).toBe(text)
  })

  it('drops a Bearer token, keeping the field name for diagnostics', () => {
    const out = redactSecrets('Authorization: Bearer sk-abcdefghijklmnop1234')
    expect(out).not.toContain('sk-abcdefghijklmnop1234')
    expect(out?.toLowerCase()).toContain('authorization')
    expect(out).toContain('[REDACTED]')
  })

  it('drops header echoes (authorization / x-api-key)', () => {
    expect(redactSecrets('x-api-key: super-secret-value')).not.toContain('super-secret-value')
    expect(redactSecrets('authorization=abc123def456')).toContain('[REDACTED]')
  })

  it('strips userinfo from a URL but keeps the host', () => {
    const out = redactSecrets('clone https://user:ghp_0123456789abcdef@github.com/acme/repo.git')
    expect(out).not.toContain('ghp_0123456789abcdef')
    expect(out).toContain('github.com/acme/repo.git')
    expect(out).toContain('user:[REDACTED]@')
  })

  it('drops secret-ish query/JSON params keeping the field name', () => {
    const out = redactSecrets('{"token":"abcd1234efgh","note":"keep me"}')
    expect(out).not.toContain('abcd1234efgh')
    expect(out).toContain('"token"')
    expect(out).toContain('keep me')
  })

  it('drops standalone token shapes regardless of context', () => {
    const cases = [
      'sk-ABCDEFGHIJKLMNOP1234',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'github_pat_ABCDEFGHIJKLMNOPQRSTUV_0123456789',
      'xoxb-1234567890-abcdefghij',
      'AKIAIOSFODNN7EXAMPLE',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dozjgNryP4J3jVmNHl0w5N',
    ]
    for (const secret of cases) {
      const out = redactSecrets(`token is ${secret} here`)
      expect(out, secret).not.toContain(secret)
      expect(out, secret).toContain('[REDACTED]')
    }
  })

  it('drops a PEM-armored private key block regardless of the surrounding text', () => {
    const key = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gt',
      'ZWQyNTUxOQAAACDsecretkeymaterialthatmustneverbestoredAAAAAA==',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n')
    const out = redactSecrets(`here is my key:\n${key}\nplease use it`)
    expect(out).not.toContain('secretkeymaterialthatmustneverbestored')
    expect(out).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    expect(out).toContain('[REDACTED]')
    // Surrounding prose is preserved.
    expect(out).toContain('here is my key:')
    expect(out).toContain('please use it')
  })

  it('leaves a public certificate block untouched (only private keys are dropped)', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIBkTCB+w==\n-----END CERTIFICATE-----'
    expect(redactSecrets(cert)).toBe(cert)
  })
})

describe('isSecretShapedFilename', () => {
  it('is false for nullish/empty and ordinary docs', () => {
    expect(isSecretShapedFilename(null)).toBe(false)
    expect(isSecretShapedFilename(undefined)).toBe(false)
    expect(isSecretShapedFilename('')).toBe(false)
    expect(isSecretShapedFilename('README.md')).toBe(false)
    expect(isSecretShapedFilename('src/config.ts')).toBe(false)
    // A file merely named "environment.md" is prose, not a dotenv file.
    expect(isSecretShapedFilename('docs/environment.md')).toBe(false)
  })

  it('matches dotenv files and their variants', () => {
    expect(isSecretShapedFilename('.env')).toBe(true)
    expect(isSecretShapedFilename('.env.local')).toBe(true)
    expect(isSecretShapedFilename('backend/.env.production')).toBe(true)
  })

  it('matches private-key / keystore suffixes', () => {
    for (const path of [
      'server.pem',
      'tls/private.key',
      'store.p12',
      'cert.pfx',
      'app.keystore',
      'release.jks',
      'key.asc',
      'deploy.ppk',
      'auth.p8',
      'signing.pkcs8',
    ]) {
      expect(isSecretShapedFilename(path), path).toBe(true)
    }
  })

  it('matches SSH keys and credential dotfiles by basename', () => {
    for (const path of [
      '.ssh/id_rsa',
      '.ssh/id_ed25519',
      'home/user/credentials',
      '.npmrc',
      '.netrc',
      '.pgpass',
      '.htpasswd',
      '.git-credentials',
      '.dockercfg',
    ]) {
      expect(isSecretShapedFilename(path), path).toBe(true)
    }
  })

  it('matches on the basename only, ignoring directory segments', () => {
    // A directory called `.env` does not make a nested markdown file secret-shaped.
    expect(isSecretShapedFilename('.env/notes.md')).toBe(false)
    // Backslash separators (a Windows-shaped path) are handled too.
    expect(isSecretShapedFilename('conf\\secret.pem')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isSecretShapedFilename('SERVER.PEM')).toBe(true)
    expect(isSecretShapedFilename('.ENV.PROD')).toBe(true)
  })
})

describe('redactSecretsDeep', () => {
  it('returns non-object leaves and nullish values unchanged', () => {
    expect(redactSecretsDeep(null)).toBeNull()
    expect(redactSecretsDeep(undefined)).toBeUndefined()
    expect(redactSecretsDeep(42)).toBe(42)
    expect(redactSecretsDeep(true)).toBe(true)
    expect(redactSecretsDeep('plain prose')).toBe('plain prose')
  })

  it('scrubs a bare string leaf', () => {
    const out = redactSecretsDeep('token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 now')
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(out).toContain('[REDACTED]')
  })

  it('scrubs every string reachable inside a nested object/array, keeping structure', () => {
    const input = {
      decisions: 'approved; use x-api-key: super-secret-value for the call',
      count: 3,
      enabled: false,
      repo: { owner: 'acme', name: 'widgets' },
      revision: { feedback: 'clone https://user:s3cr3ttoken0000@github.com/acme/repo.git' },
      notes: ['keep me', 'sk-ABCDEFGHIJKLMNOP1234567890'],
    }
    const out = redactSecretsDeep(input)
    expect(out.decisions).not.toContain('super-secret-value')
    expect(out.revision.feedback).not.toContain('s3cr3ttoken0000')
    expect(out.revision.feedback).toContain('github.com/acme/repo.git')
    expect(out.notes[1]).not.toContain('sk-ABCDEFGHIJKLMNOP1234567890')
    expect(out.notes[0]).toBe('keep me')
    // Non-string leaves and non-secret identifiers pass through untouched.
    expect(out.count).toBe(3)
    expect(out.enabled).toBe(false)
    expect(out.repo).toEqual({ owner: 'acme', name: 'widgets' })
  })
})
