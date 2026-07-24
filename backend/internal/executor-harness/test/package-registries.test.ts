import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentJob, parsePackageRegistries } from '../src/job.js'
import {
  configurePackageRegistries,
  npmrcCredentials,
  npmrcPath,
  renderNpmrc,
} from '../src/package-registries.js'
import { redactSecrets } from '../src/redact.js'
import { FS_HAS_POSIX_MODES, stubTempHome, tempDir } from './helpers.js'

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

  it('emits no env override on the container path (npm finds ~/.npmrc via HOME)', async () => {
    await stubTempHome()
    expect(await configurePackageRegistries([npmjsEntry])).toEqual({})
    expect(await configurePackageRegistries(undefined)).toEqual({})
  })
})

// The `isolatedDir` scope: an `ambientAuth` job runs in the SHARED native host process on the
// DEVELOPER's home, so `~/.npmrc` is their real file and concurrent jobs would race on it.
describe('configurePackageRegistries (isolated per-job scope)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('writes the job npmrc under the per-job dir and points npm at it', async () => {
    await stubTempHome()
    const isolatedDir = await tempDir('jobenv-')
    const env = await configurePackageRegistries([npmjsEntry], { isolatedDir })

    const path = join(isolatedDir, '.npmrc')
    expect(env).toEqual({ npm_config_userconfig: path })
    expect(await readFile(path, 'utf8')).toContain(
      '//registry.npmjs.org/:_authToken=npm_token_abcdef',
    )
    if (FS_HAS_POSIX_MODES) {
      expect(((await stat(path)).mode & 0o777).toString(8)).toBe('600')
    }
    // The developer's own npmrc is never written.
    await expect(readFile(npmrcPath(), 'utf8')).rejects.toThrow()
  })

  it("NEVER deletes the developer's own ~/.npmrc for a job with no entries", async () => {
    // The container path clears a stale ~/.npmrc so a pooled container can't leak a prior job's
    // token. Doing that in the shared native process destroyed the developer's real npm config —
    // on EVERY native run, since most jobs carry no registry entries at all.
    await stubTempHome()
    const isolatedDir = await tempDir('jobenv-')
    await writeFile(npmrcPath(), '//registry.corp.example/:_authToken=personal\n', { mode: 0o600 })

    // No entries ⇒ no override at all, so their own npmrc stays in effect for the run.
    expect(await configurePackageRegistries(undefined, { isolatedDir })).toEqual({})
    expect(await readFile(npmrcPath(), 'utf8')).toContain('personal')
  })

  it("seeds the job npmrc from the developer's, appending the job's entries so they win", async () => {
    // Their unrelated settings (a corporate registry, a proxy) must keep working for the run;
    // npm resolves the LAST occurrence of a key, so the appended job lines take precedence.
    await stubTempHome()
    const isolatedDir = await tempDir('jobenv-')
    await writeFile(npmrcPath(), '@acme:registry=https://registry.corp.example/\nproxy=http://p/')

    await configurePackageRegistries([npmjsEntry], { isolatedDir })
    const content = await readFile(join(isolatedDir, '.npmrc'), 'utf8')

    expect(content).toContain('proxy=http://p/')
    expect(content.indexOf('@acme:registry=https://registry.corp.example/')).toBeLessThan(
      content.indexOf('@acme:registry=https://registry.npmjs.org/'),
    )
    // A seed file with no trailing newline must not run into the first job line.
    expect(content).not.toContain('proxy=http://p/@acme')
  })

  it("registers the developer's seeded credentials for redaction too", async () => {
    // Their token is only in play at all because we seed their file. It reaches the same npm
    // output the job's token does, so it has to be scrubbed on the same terms.
    await stubTempHome()
    const isolatedDir = await tempDir('jobenv-')
    await writeFile(npmrcPath(), '//registry.corp.example/:_authToken=dev_personal_token_xyz\n')

    await configurePackageRegistries([npmjsEntry], { isolatedDir })

    expect(redactSecrets('npm ERR! 401 using dev_personal_token_xyz')).not.toContain(
      'dev_personal_token_xyz',
    )
  })

  it("does not leak one job's token into a concurrent job's npmrc", async () => {
    await stubTempHome()
    const [dirA, dirB] = await Promise.all([tempDir('jobenv-a-'), tempDir('jobenv-b-')])
    const [envA, envB] = await Promise.all([
      configurePackageRegistries([{ ...npmjsEntry, token: 'token_from_job_a' }], {
        isolatedDir: dirA,
      }),
      configurePackageRegistries([{ ...npmjsEntry, token: 'token_from_job_b' }], {
        isolatedDir: dirB,
      }),
    ])

    const [a, b] = await Promise.all([
      readFile(envA.npm_config_userconfig!, 'utf8'),
      readFile(envB.npm_config_userconfig!, 'utf8'),
    ])
    expect(a).toContain('token_from_job_a')
    expect(a).not.toContain('token_from_job_b')
    expect(b).toContain('token_from_job_b')
    expect(b).not.toContain('token_from_job_a')
  })
})

describe('npmrcCredentials', () => {
  it('finds the credential values npm accepts, on any host line', () => {
    expect(
      npmrcCredentials(
        [
          '@acme:registry=https://registry.corp.example/',
          '//registry.corp.example/:_authToken=tok_a',
          '//other.example/:_auth=basic_b',
          '//other.example/:_password=pw_c',
          'proxy=http://p/',
        ].join('\n'),
      ),
    ).toEqual(['tok_a', 'basic_b', 'pw_c'])
  })

  it('skips an env reference, which npm expands at read time', () => {
    // `${NPM_TOKEN}` is not itself a secret; registering the literal would scrub the placeholder
    // wherever it appeared and hide nothing real.
    expect(npmrcCredentials('//registry.npmjs.org/:_authToken=${NPM_TOKEN}')).toEqual([])
  })

  it('strips surrounding quotes and whitespace', () => {
    expect(npmrcCredentials('//h/:_authToken = "quoted_tok" ')).toEqual(['quoted_tok'])
  })

  it('is empty for content with no credentials', () => {
    expect(npmrcCredentials('')).toEqual([])
    expect(npmrcCredentials('registry=https://registry.npmjs.org/\n')).toEqual([])
  })
})
