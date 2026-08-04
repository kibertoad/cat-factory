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

  it('strips userinfo across scheme shapes, keeping the scheme itself intact', () => {
    // The scheme is matched in a lookbehind and never consumed, so it must survive the
    // replacement byte-for-byte, whatever it is.
    const cases: [string, string][] = [
      ['postgres://admin:hunter2@db.internal:5432/app', 'postgres://admin:[REDACTED]@'],
      ['git+ssh://user:tok0@host/x.git', 'git+ssh://user:[REDACTED]@'],
      ['x+custom-scheme.v1://u:p@h/', 'x+custom-scheme.v1://u:[REDACTED]@'],
      ['HTTPS://User:Pass@Host/', 'HTTPS://User:[REDACTED]@'],
    ]
    for (const [input, expected] of cases) {
      expect(redactSecrets(input), input).toContain(expected)
    }
    // Userinfo with no scheme in front of it is left alone: `user:pass@host` in prose is
    // not a URL, and the `:`-separated-value rules cover the credential-shaped cases.
    expect(redactSecrets('no scheme user:pass@host')).toBe('no scheme user:pass@host')
  })

  it('costs the same on credential-free text of any shape', () => {
    // The scrub runs over every captured prompt and every injected context file, so its cost
    // must depend on the SIZE of a body and not its shape. A rule whose bounded run can be
    // retried at every offset (the URL-userinfo scheme prefix, before it moved into a
    // lookbehind) is still linear, so only a comparison catches it: it cost ~15x more on
    // base64 than on prose, ~130ms per 512KB, which is why one large context file dominated
    // the cost of recording a whole agent-context snapshot.
    const size = 2 * 1024 * 1024
    const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size)
    // Base64 is the shape that bit: a long unbroken run of scheme-legal characters, and an
    // ordinary thing to find in a lockfile, an inlined asset, or a data URI.
    const base64 = fill('aGVsbG8gd29ybGQgdGhpcyBpcyBiYXNlNjQgcGF5bG9hZA')
    const prose = fill('the quick brown fox jumps over the lazy dog ')
    // Best-of-N: a scheduler stall inflates a single sample, and this suite shares a machine
    // with the rest of the monorepo's tests. Both bodies are measured the same way in the
    // same process, so contention that survives the minimum hits both sides of the ratio.
    // `Date.now` rather than `performance`: kernel compiles against the ES2022 lib alone, and
    // a millisecond's granularity is noise against samples an order of magnitude larger.
    const fastest = (body: string): number => {
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < 3; i++) {
        const started = Date.now()
        redactSecrets(body)
        best = Math.min(best, Date.now() - started)
      }
      return best
    }
    const baseline = fastest(prose)
    const ratio = fastest(base64) / baseline
    // Parity is ~1x once no rule re-walks a bounded run per offset; the regression this pins
    // is an order of magnitude away, so 4x separates them without riding on absolute timings.
    expect(ratio, `base64 took ${ratio.toFixed(1)}x prose (${baseline.toFixed(1)}ms)`).toBeLessThan(
      4,
    )
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
