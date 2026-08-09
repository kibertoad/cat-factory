import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { createMisconfiguredApp } from '../src/config/misconfiguredApp.js'
import { authController } from '../src/modules/auth/AuthController.js'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { REQUEST_ID_HEADER } from '../src/http/requestLogging.js'
import {
  ConfigValidationError,
  ENV_HELP,
  MIN_ENCRYPTION_KEY_BYTES,
  configProblem,
  formatConfigProblems,
  isConfigValidationError,
  missingIoredisProblem,
  requireEncryptionKey,
  requireEnv,
  requireGitHubAppPrivateKey,
} from '../src/config/problems.js'

// The misconfiguration fallback backend: when a facade can't boot because a mandatory env var /
// binding is missing, it serves THIS instead of dying, so the SPA can render a dedicated error
// screen. These assertions pin the two guarantees that matter: the SPA's boot handshake keeps
// working (so it branches to the screen), and the payload never leaks a secret.
const PROBLEMS = [{ key: 'DATABASE_URL', ...ENV_HELP.DATABASE_URL }]

describe('ConfigValidationError', () => {
  it('carries the structured problems and a human-readable multi-line message', () => {
    const err = new ConfigValidationError(PROBLEMS)
    expect(isConfigValidationError(err)).toBe(true)
    expect(err.problems).toEqual(PROBLEMS)
    expect(err.message).toContain('DATABASE_URL')
    expect(err.message).toContain(ENV_HELP.DATABASE_URL.remedy)
  })

  it('isConfigValidationError rejects a plain Error', () => {
    expect(isConfigValidationError(new Error('nope'))).toBe(false)
  })

  it('formatConfigProblems summarises the count for multiple problems', () => {
    const msg = formatConfigProblems([
      { key: 'A', summary: 's', remedy: 'r' },
      { key: 'B', summary: 's', remedy: 'r' },
    ])
    expect(msg).toContain('2 mandatory configuration values')
  })

  it('formatConfigProblems appends a Docs line when a problem carries a docsUrl', () => {
    const withDoc = formatConfigProblems([
      { key: 'A', summary: 's', remedy: 'r', docsUrl: 'https://example.test/docs#a' },
    ])
    expect(withDoc).toContain('Docs: https://example.test/docs#a')
    // ...and omits the Docs line entirely when there is no link.
    expect(formatConfigProblems([{ key: 'B', summary: 's', remedy: 'r' }])).not.toContain('Docs:')
  })

  // Either destination is legitimate: an in-repo doc for a remedy that needs the code open, and
  // a catfactory.ai page for one whose instruction the website owns (a variable an operator sets
  // needs no checkout). What must never happen is a remedy with NO link, or one pointing at some
  // third place; `docs.spec.ts` then resolves each shape the way only it can be resolved.
  it('every ENV_HELP entry carries a documentation link, to a repo doc or to the site', () => {
    for (const [key, help] of Object.entries(ENV_HELP)) {
      expect(help.docsUrl, `${key} should link docs`).toMatch(
        /^https:\/\/(github\.com\/kibertoad\/cat-factory\/blob\/main\/|www\.catfactory\.ai\/)/,
      )
    }
  })
})

describe('missingIoredisProblem (A7)', () => {
  it('is a REDIS_URL ConfigValidationError naming the purpose, the fix, and the original cause', () => {
    const err = missingIoredisProblem(
      'cross-node WebSocket propagation',
      new Error('Cannot find module ioredis'),
    )
    expect(isConfigValidationError(err)).toBe(true)
    const problem = err.problems[0]!
    expect(problem.key).toBe('REDIS_URL')
    expect(problem.summary).toBe(ENV_HELP.REDIS_URL.summary)
    expect(problem.remedy).toContain('cross-node WebSocket propagation')
    expect(problem.remedy).toMatch(/pnpm add ioredis/)
    expect(problem.remedy).toMatch(/unset REDIS_URL/)
    expect(problem.remedy).toContain('Cannot find module ioredis')
    expect(problem.docsUrl).toBe(ENV_HELP.REDIS_URL.docsUrl)
  })

  it('stringifies a non-Error cause', () => {
    const problem = missingIoredisProblem('distributed cache invalidation', 'boom').problems[0]!
    expect(problem.remedy).toContain('distributed cache invalidation')
    expect(problem.remedy).toContain('boom')
  })
})

describe('requireEnv', () => {
  it('returns a set value, trimmed', () => {
    expect(requireEnv({ DATABASE_URL: '  postgres://x  ' }, 'DATABASE_URL')).toBe('postgres://x')
  })

  it('throws a ConfigValidationError with the known ENV_HELP meaning when missing', () => {
    try {
      requireEnv({}, 'DATABASE_URL')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      expect((err as ConfigValidationError).problems[0]).toEqual({
        key: 'DATABASE_URL',
        ...ENV_HELP.DATABASE_URL,
      })
    }
  })

  it('treats a blank value as missing', () => {
    expect(() => requireEnv({ X: '   ' }, 'X')).toThrow(ConfigValidationError)
  })
})

describe('requireEncryptionKey', () => {
  // A valid base64 key that decodes to a full AES-256 key (the minimum accepted).
  const validKey = Buffer.alloc(MIN_ENCRYPTION_KEY_BYTES).toString('base64')

  it('returns the trimmed key when it is valid base64 of at least 32 bytes', () => {
    expect(requireEncryptionKey(`  ${validKey}  `)).toBe(validKey)
  })

  it('throws the ENCRYPTION_KEY problem when missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      try {
        requireEncryptionKey(value)
        expect.unreachable('should have thrown')
      } catch (err) {
        expect(isConfigValidationError(err)).toBe(true)
        expect((err as ConfigValidationError).problems[0]).toEqual({
          key: 'ENCRYPTION_KEY',
          ...ENV_HELP.ENCRYPTION_KEY,
        })
      }
    }
  })

  it('throws a base64-naming problem for a non-base64 value', () => {
    try {
      requireEncryptionKey('%%%not-base64%%%')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('ENCRYPTION_KEY')
      expect(problem.remedy).toMatch(/valid base64/)
      expect(problem.docsUrl).toBe(ENV_HELP.ENCRYPTION_KEY.docsUrl)
    }
  })

  it('throws a length problem for a key that decodes to fewer than 32 bytes', () => {
    try {
      requireEncryptionKey(Buffer.alloc(16).toString('base64'))
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('ENCRYPTION_KEY')
      expect(problem.remedy).toMatch(/at least 32 bytes/)
    }
  })
})

describe('requireGitHubAppPrivateKey', () => {
  // A well-formed PKCS#8 PEM only needs the boundary lines and a base64-decodable body for the
  // config-load shape check (`crypto.subtle.importKey` does the real key validation later).
  const validPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from('pkcs8-body').toString(
    'base64',
  )}\n-----END PRIVATE KEY-----`

  it('returns the trimmed PEM for a well-formed PKCS#8 key', () => {
    expect(requireGitHubAppPrivateKey(`  ${validPem}\n`)).toBe(validPem)
  })

  it('flags the PKCS#1 key GitHub issues, naming the openssl conversion', () => {
    const pkcs1 = '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----'
    try {
      requireGitHubAppPrivateKey(pkcs1)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(isConfigValidationError(err)).toBe(true)
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('GITHUB_APP_PRIVATE_KEY')
      expect(problem.remedy).toMatch(/PKCS#1/)
      expect(problem.remedy).toMatch(/openssl pkcs8 -topk8/)
      expect(problem.docsUrl).toBe(ENV_HELP.GITHUB_APP_PRIVATE_KEY.docsUrl)
    }
  })

  it('flags a value with no PKCS#8 boundary lines', () => {
    try {
      requireGitHubAppPrivateKey('just some text')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as ConfigValidationError).problems[0]!.remedy).toMatch(/BEGIN PRIVATE KEY/)
    }
  })

  it('flags a PKCS#8 header whose body is not valid base64', () => {
    const bad = '-----BEGIN PRIVATE KEY-----\n%%% not base64 %%%\n-----END PRIVATE KEY-----'
    try {
      requireGitHubAppPrivateKey(bad)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as ConfigValidationError).problems[0]!.remedy).toMatch(/not valid base64/)
    }
  })

  it('treats a missing/blank value as the missing-var problem', () => {
    for (const value of [undefined, '', '   ']) {
      expect(() => requireGitHubAppPrivateKey(value)).toThrow(ConfigValidationError)
    }
  })

  it('names the specific var for the privileged App key', () => {
    try {
      requireGitHubAppPrivateKey('nope', 'GITHUB_PRIVILEGED_APP_PRIVATE_KEY')
      expect.unreachable('should have thrown')
    } catch (err) {
      const problem = (err as ConfigValidationError).problems[0]!
      expect(problem.key).toBe('GITHUB_PRIVILEGED_APP_PRIVATE_KEY')
      expect(problem.remedy).toMatch(/GITHUB_PRIVILEGED_APP_PRIVATE_KEY/)
    }
  })
})

describe('createMisconfiguredApp', () => {
  const app = createMisconfiguredApp(PROBLEMS)

  it('serves the problem list on /auth/config as an auth-disabled config', async () => {
    const res = await app.request('http://x/auth/config', {
      headers: { origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
    // Reflects the caller's origin so the SPA can read it cross-origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
    const body = (await res.json()) as {
      enabled: boolean
      misconfigured: { problems: typeof PROBLEMS }
    }
    expect(body.enabled).toBe(false)
    expect(body.misconfigured.problems).toEqual(PROBLEMS)
  })

  it('reports the SAME provider keys the real /auth/config does, all off', async () => {
    // The fallback response is hand-built with `Response.json`, so it has no contract-typed route
    // layer to hold it to the live shape. The typed constant catches a MISSING key; what it cannot
    // catch is the two endpoints disagreeing, and the SPA gates each login control on one of these
    // booleans — a key absent here reads as `undefined` and renders whatever that coerces to.
    // Derived from the real controller's own answer rather than a hand-listed set, so a provider
    // added later needs no edit in this test.
    const live = new Hono<AppEnv>()
    live.use('*', async (c, next) => {
      c.set('container', {
        // An unconfigured deployment: every provider flag off, so the live route reports the same
        // all-false shape the fallback hand-builds.
        config: { auth: { enabled: false, githubEnabled: false, passwordEnabled: false } },
      } as unknown as ServerContainer)
      await next()
    })
    live.route('/auth', authController())
    const liveBody = (await (await live.request('http://x/auth/config')).json()) as {
      providers: Record<string, unknown>
    }
    const fallbackBody = (await (await app.request('http://x/auth/config')).json()) as {
      providers: Record<string, unknown>
    }
    expect(Object.keys(fallbackBody.providers).sort()).toEqual(
      Object.keys(liveBody.providers).sort(),
    )
    expect(Object.values(fallbackBody.providers)).toEqual(
      Object.values(fallbackBody.providers).map(() => false),
    )
  })

  it('reports misconfigured on /health but stays 200 (no crash-loop)', async () => {
    const res = await app.request('http://x/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'misconfigured' })
  })

  it('503s every other route with the structured problem list', async () => {
    const res = await app.request('http://x/workspaces')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; problems: typeof PROBLEMS } }
    expect(body.error.code).toBe('backend_misconfigured')
    expect(body.error.problems).toEqual(PROBLEMS)
  })

  it('correlates its responses like the real facades do', async () => {
    // The Worker serves the fallback from INSIDE `createApp`, so it inherits the request
    // middleware; Node/local swap in THIS whole app instead. Without the mount here, the one
    // deployment shape an operator is actively debugging would be the only one serving requests
    // with no id — and the SPA could not read it back without the expose-header.
    const res = await app.request('http://x/workspaces', {
      headers: { origin: 'http://localhost:3000', 'X-Request-Id': 'upstream-7' },
    })
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('upstream-7')
    expect(res.headers.get('access-control-expose-headers')).toContain(REQUEST_ID_HEADER)
  })

  it('a problem exposes ONLY the non-secret key/summary/remedy/docsUrl fields (never a secret value)', () => {
    // The structural guarantee: a ConfigProblem is a fixed, non-secret shape (the optional docsUrl is
    // a public documentation link, not a secret). Even if a loader tried to attach a raw value, the
    // type + this shape would keep it out of the wire payload.
    const problem = configProblem(PROBLEMS[0]!).problems[0]!
    expect(Object.keys(problem).sort()).toEqual(['docsUrl', 'key', 'remedy', 'summary'])
  })
})
