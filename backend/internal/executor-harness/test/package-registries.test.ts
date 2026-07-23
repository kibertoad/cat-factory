import { readFile, stat, writeFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentJob, parsePackageRegistries } from '../src/job.js'
import { configurePackageRegistries, npmrcPath, renderNpmrc } from '../src/package-registries.js'
import { redactSecrets } from '../src/redact.js'
import { FS_HAS_POSIX_MODES, stubTempHome } from './helpers.js'

// Private-registry auth: the job-body validator (host allowlist = anti-exfiltration),
// the ~/.npmrc rendering, the per-job write/clear lifecycle on a reused container, and
// the token registration into the shared redaction.

const base = {
  jobId: 'job_123',
  systemPrompt: 'You are an agent.',
  userPrompt: 'Do the thing.',
  model: 'qwen3-max',
  proxyBaseUrl: 'https://w/v1',
  sessionToken: 'sess',
  ghToken: 'ght',
  repo: {
    owner: 'acme',
    name: 'widgets',
    baseBranch: 'main',
    cloneUrl: 'https://github.com/acme/widgets.git',
  },
  branch: 'main',
}

const npmjsEntry = {
  ecosystem: 'npm' as const,
  host: 'registry.npmjs.org',
  scopes: ['@acme'],
  token: 'npm_token_abcdef',
}

describe('parsePackageRegistries', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts allowlisted npm entries on the job body', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      packageRegistries: [
        npmjsEntry,
        {
          ecosystem: 'npm',
          host: 'npm.pkg.github.com',
          scopes: ['@acme-internal', '@acme-tools'],
          token: 'ghp_registry_token',
        },
      ],
    })
    expect(job.packageRegistries).toHaveLength(2)
    expect(job.packageRegistries?.[0]?.host).toBe('registry.npmjs.org')
    expect(job.packageRegistries?.[1]?.scopes).toEqual(['@acme-internal', '@acme-tools'])
  })

  it('rejects a non-allowlisted registry host (token exfiltration)', () => {
    expect(() => parsePackageRegistries([{ ...npmjsEntry, host: 'evil.example.com' }])).toThrow(
      /not an allowed npm registry host/,
    )
  })

  it('honours the NPM_ALLOWED_REGISTRY_HOSTS env extension', () => {
    expect(() =>
      parsePackageRegistries([{ ...npmjsEntry, host: 'registry.corp.example' }]),
    ).toThrow(/not an allowed npm registry host/)
    vi.stubEnv('NPM_ALLOWED_REGISTRY_HOSTS', 'registry.corp.example')
    const entries = parsePackageRegistries([{ ...npmjsEntry, host: 'Registry.Corp.Example' }])
    expect(entries[0]?.host).toBe('registry.corp.example')
  })

  it('drops entries of an unknown ecosystem (future pip/maven stay additive)', () => {
    const entries = parsePackageRegistries([
      { ecosystem: 'pip', host: 'pypi.example', scopes: ['x'], token: 't' },
      npmjsEntry,
    ])
    expect(entries).toEqual([npmjsEntry])
  })

  it('rejects a malformed scope and an empty token', () => {
    expect(() => parsePackageRegistries([{ ...npmjsEntry, scopes: ['not-a-scope!'] }])).toThrow(
      /must look like @org/,
    )
    expect(() => parsePackageRegistries([{ ...npmjsEntry, scopes: [] }])).toThrow(/non-empty array/)
    expect(() => parsePackageRegistries([{ ...npmjsEntry, token: '' }])).toThrow(/token/)
  })

  it('rejects a token with a newline / control char (npmrc line injection)', () => {
    // A newline in the token would render a second, forged registry/_authToken line
    // into ~/.npmrc — reject it at the parse boundary.
    expect(() =>
      parsePackageRegistries([{ ...npmjsEntry, token: 'good\n//evil.example/:_authToken=stolen' }]),
    ).toThrow(/spaces or control characters/)
    expect(() => parsePackageRegistries([{ ...npmjsEntry, token: 'has a space' }])).toThrow(
      /spaces or control characters/,
    )
  })
})

describe('renderNpmrc', () => {
  it('routes each scope to its registry and emits one credential line per host', () => {
    expect(
      renderNpmrc([
        npmjsEntry,
        {
          ecosystem: 'npm',
          host: 'npm.pkg.github.com',
          scopes: ['@acme-internal', '@acme-tools'],
          token: 'ghp_registry_token',
        },
      ]),
    ).toBe(
      [
        '@acme:registry=https://registry.npmjs.org/',
        '@acme-internal:registry=https://npm.pkg.github.com/',
        '@acme-tools:registry=https://npm.pkg.github.com/',
        '//registry.npmjs.org/:_authToken=npm_token_abcdef',
        '//npm.pkg.github.com/:_authToken=ghp_registry_token',
        '',
      ].join('\n'),
    )
  })
})

describe('configurePackageRegistries', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes ~/.npmrc with 0600 and clears it for a job with no entries', async () => {
    await stubTempHome()
    await configurePackageRegistries([npmjsEntry])
    const path = npmrcPath()
    expect(await readFile(path, 'utf8')).toContain(
      '//registry.npmjs.org/:_authToken=npm_token_abcdef',
    )
    if (FS_HAS_POSIX_MODES) {
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    }

    // The next job on this (reused) container carries no entries: the stale token
    // file must not leak into it.
    await configurePackageRegistries(undefined)
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('overwrites a pre-existing npmrc and tightens its mode', async () => {
    await stubTempHome()
    await writeFile(npmrcPath(), 'stale=1\n', { mode: 0o644 })
    await configurePackageRegistries([npmjsEntry])
    const content = await readFile(npmrcPath(), 'utf8')
    expect(content).not.toContain('stale=1')
    if (FS_HAS_POSIX_MODES) {
      expect(((await stat(npmrcPath())).mode & 0o777).toString(8)).toBe('600')
    }
  })

  it('registers the tokens with the shared redaction', async () => {
    await stubTempHome()
    await configurePackageRegistries([{ ...npmjsEntry, token: 'super_secret_registry_token' }])
    // A bare token echoed in npm error output (no KEY= shape) is scrubbed too.
    expect(redactSecrets('npm ERR! auth failed for super_secret_registry_token')).not.toContain(
      'super_secret_registry_token',
    )
  })
})
