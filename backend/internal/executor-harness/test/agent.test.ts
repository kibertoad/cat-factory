import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentJob } from '../src/job.js'
import { buildInfraNotes, buildPreviewOutcome } from '../src/agent.js'
import { installCommand } from '../src/frontend-infra.js'

// The generic, manifest-driven agent kind's body validator. The handler itself
// (handleAgent) spawns Pi + git, so it is covered by the acceptance suite; here we
// lock the parse/validation surface like the other parse*Job tests.

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

describe('parseAgentJob', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('parses the optional repo.provider discriminator', () => {
    // The GitLab host must be allow-listed or the clone-URL host check rejects it first.
    vi.stubEnv('GITHUB_ALLOWED_HOSTS', 'gitlab.com')
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      repo: { ...base.repo, provider: 'gitlab', cloneUrl: 'https://gitlab.com/acme/widgets.git' },
    })
    expect(job.repo.provider).toBe('gitlab')
  })

  it('leaves repo.provider undefined when absent (host inference applies downstream)', () => {
    const job = parseAgentJob({ ...base, mode: 'coding' })
    expect(job.repo.provider).toBeUndefined()
  })

  it('rejects an unknown repo.provider', () => {
    expect(() =>
      parseAgentJob({ ...base, mode: 'coding', repo: { ...base.repo, provider: 'bitbucket' } }),
    ).toThrow(/repo\.provider/)
  })

  it('accepts a structured explore job', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', shapeHint: '{"x":number}', repair: true },
    })
    expect(job.mode).toBe('explore')
    expect(job.output).toEqual({ kind: 'structured', shapeHint: '{"x":number}', repair: true })
    expect(job.branch).toBe('main')
  })

  it('carries an explicit repair:false through (so the handler skips the repair call)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', repair: false },
    })
    // The handler keys off `output.repair === false`; dropping it would silently re-enable
    // the one-shot repair call for a kind that opted out.
    expect(job.output).toEqual({ kind: 'structured', repair: false })
  })

  it('carries failOnUnusableFinal through (document producers fail loudly on a cut-off reply)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured', shapeHint: '{"service":string}', failOnUnusableFinal: true },
    })
    // The handler gates on `output.failOnUnusableFinal` BEFORE the structured repair, so a
    // truncated final answer fails the run instead of being laundered into a half-baked doc.
    expect(job.output).toEqual({
      kind: 'structured',
      shapeHint: '{"service":string}',
      failOnUnusableFinal: true,
    })
  })

  it('carries the explore-mode infra stand-up spec through (the tester)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured' },
      infra: { environment: 'local', composePath: 'docker-compose.yml' },
    })
    expect(job.infra).toEqual({ environment: 'local', composePath: 'docker-compose.yml' })
  })

  it('drops an infra spec with no recognised environment', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: { composePath: 'docker-compose.yml' },
    })
    expect(job.infra).toBeUndefined()
  })

  it('carries the frontend UI-test infra spec through (the self-contained tester-ui flow)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      output: { kind: 'structured' },
      infra: {
        kind: 'frontend',
        packageManager: 'pnpm',
        buildScript: 'build',
        outputDir: 'dist',
        serveMode: 'static',
        servePort: 4173,
        envInjection: 'build',
        env: {
          PUB_API_URL: 'https://api.ephemeral.example',
          PUB_OTHER_URL: 'http://localhost:8089',
        },
        wiremockMappingsPath: 'mocks/',
        wiremockPort: 8089,
      },
    })
    expect(job.infra).toEqual({
      kind: 'frontend',
      packageManager: 'pnpm',
      buildScript: 'build',
      outputDir: 'dist',
      serveMode: 'static',
      servePort: 4173,
      envInjection: 'build',
      env: { PUB_API_URL: 'https://api.ephemeral.example', PUB_OTHER_URL: 'http://localhost:8089' },
      wiremockMappingsPath: 'mocks/',
      wiremockPort: 8089,
    })
  })

  it('drops non-string env entries and unrecognised knobs from a frontend infra spec', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: {
        kind: 'frontend',
        packageManager: 'bun', // unrecognised → dropped
        serveMode: 'weird', // unrecognised → dropped
        // PATH is reserved (would clobber the build's toolchain env) → dropped.
        env: { GOOD: 'https://ok', BAD: 42, ALSO_BAD: null, PATH: 'https://evil' },
        servePort: -3, // not a positive int → dropped
      },
    })
    expect(job.infra).toEqual({ kind: 'frontend', env: { GOOD: 'https://ok' } })
  })

  it('drops reserved env NAMES and reserved FAMILIES from a frontend infra spec', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: {
        kind: 'frontend',
        env: {
          PUB_API_URL: 'https://ok', // kept
          NODE_EXTRA_CA_CERTS: '/evil.pem', // reserved name → dropped
          BASH_ENV: '/evil.sh', // reserved name → dropped
          npm_config_registry: 'https://evil', // reserved family (npm_config_*) → dropped
          GIT_SSH_COMMAND: 'ssh -oProxyCommand=evil', // reserved family (GIT_*) → dropped
        },
      },
    })
    expect(job.infra).toEqual({ kind: 'frontend', env: { PUB_API_URL: 'https://ok' } })
  })

  it('drops reserved env FAMILIES case-insensitively (npm reads npm_config_* regardless of case)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: {
        kind: 'frontend',
        env: {
          PUB_API_URL: 'https://ok', // kept
          NPM_CONFIG_REGISTRY: 'https://evil', // upper-cased npm_config_* → npm honours it → dropped
          Npm_Config_Cafile: '/evil.pem', // mixed case → still dropped
          Git_Ssh_Command: 'ssh -oProxyCommand=evil', // mixed-case git family → dropped
        },
      },
    })
    expect(job.infra).toEqual({ kind: 'frontend', env: { PUB_API_URL: 'https://ok' } })
  })

  it('drops an out-of-range frontend servePort / wiremockPort (can never bind)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'explore',
      infra: { kind: 'frontend', servePort: 70000, wiremockPort: 0 },
    })
    // Both are outside 1..65535, so they fall back to the harness defaults (absent here).
    expect(job.infra).toEqual({ kind: 'frontend' })
  })

  it('accepts a coding job with a fresh branch + PR', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      newBranch: 'cat-factory/blk_1',
      pushBranch: 'cat-factory/blk_1',
      commitMessage: 'Implement the thing',
      pr: { title: 'Implement', body: 'body' },
    })
    expect(job.mode).toBe('coding')
    expect(job.newBranch).toBe('cat-factory/blk_1')
    expect(job.pr).toEqual({ title: 'Implement', body: 'body' })
  })

  it('treats a non-structured output as prose (no output spec) and defaults flags', () => {
    const job = parseAgentJob({ ...base, mode: 'coding' })
    expect(job.output).toBeUndefined()
    expect(job.noChangesIsError).toBeUndefined() // default behaviour = error
    expect(job.full).toBeUndefined()
  })

  it('carries the non-fatal no-op + full-history flags through', () => {
    const job = parseAgentJob({ ...base, mode: 'coding', noChangesIsError: false, full: true })
    expect(job.noChangesIsError).toBe(false)
    expect(job.full).toBe(true)
  })

  it('carries per-knob progress-guard overrides through, clamping each knob', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      guardLimits: {
        maxConsecutiveErrors: 20, // valid → kept
        maxConsecutiveWebCalls: 40.7, // floored to 40
        maxToolCallsWithoutEdit: -5, // invalid → dropped (keeps env/default)
      },
    })
    expect(job.guardLimits).toEqual({ maxConsecutiveErrors: 20, maxConsecutiveWebCalls: 40 })
  })

  it('drops a guardLimits object with no usable knobs', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      guardLimits: { maxConsecutiveErrors: 'nope', maxConsecutiveWebCalls: 0 },
    })
    expect(job.guardLimits).toBeUndefined()
  })

  it('carries the conflict-resolver merge base through (coding mode)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      branch: 'cat-factory/blk_1',
      full: true,
      mergeBase: 'main',
      noChangesIsError: false,
    })
    // The handler keys off `mergeBase` to run the conflict-resolution flow (merge the base
    // in, resolve, complete the merge commit + push) instead of the ordinary coding flow.
    expect(job.mergeBase).toBe('main')
  })

  it('drops an empty mergeBase', () => {
    const job = parseAgentJob({ ...base, mode: 'coding', mergeBase: '' })
    expect(job.mergeBase).toBeUndefined()
  })

  it('carries the bootstrap spec through (clone + adapt a reference)', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      bootstrap: {
        target: {
          owner: 'acme',
          name: 'new-svc',
          cloneUrl: 'https://github.com/acme/new-svc.git',
          defaultBranch: 'main',
        },
      },
    })
    // The handler keys off `bootstrap` to force-push a fresh history to the target repo.
    expect(job.bootstrap).toEqual({
      target: {
        owner: 'acme',
        name: 'new-svc',
        cloneUrl: 'https://github.com/acme/new-svc.git',
        defaultBranch: 'main',
      },
    })
  })

  it('carries the from-scratch bootstrap flag through', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      bootstrap: {
        target: {
          owner: 'acme',
          name: 'new-svc',
          cloneUrl: 'https://github.com/acme/new-svc.git',
          defaultBranch: 'main',
        },
        fromScratch: true,
      },
    })
    expect(job.bootstrap?.fromScratch).toBe(true)
  })

  it('rejects a bootstrap target clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'coding',
        bootstrap: {
          target: {
            owner: 'acme',
            name: 'new-svc',
            cloneUrl: 'https://evil.example/acme/new-svc.git',
            defaultBranch: 'main',
          },
        },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing / invalid mode', () => {
    expect(() => parseAgentJob({ ...base })).toThrow(/mode/)
    expect(() => parseAgentJob({ ...base, mode: 'nonsense' })).toThrow(/mode/)
  })

  it('rejects a clone URL pointing at a non-GitHub host', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'explore',
        repo: { ...base.repo, cloneUrl: 'https://evil.example/acme/widgets.git' },
      }),
    ).toThrow(/not an allowed GitHub host/)
  })

  it('rejects a missing branch', () => {
    const { branch: _branch, ...rest } = base
    expect(() => parseAgentJob({ ...rest, mode: 'explore' })).toThrow(/branch/)
  })

  it('omits a monorepo serviceDirectory when absent (whole-repo run)', () => {
    expect(parseAgentJob({ ...base, mode: 'explore' }).repo.serviceDirectory).toBeUndefined()
  })

  it('normalises a monorepo serviceDirectory to a clean relative path', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'coding',
      repo: { ...base.repo, serviceDirectory: '/packages/api/' },
    })
    expect(job.repo.serviceDirectory).toBe('packages/api')
  })

  it('rejects a serviceDirectory that escapes the checkout', () => {
    expect(() =>
      parseAgentJob({
        ...base,
        mode: 'coding',
        repo: { ...base.repo, serviceDirectory: '../secrets' },
      }),
    ).toThrow(/serviceDirectory/)
  })
})

describe('installCommand (frontend stand-up)', () => {
  it('derives the install command from the package manager (default pnpm)', () => {
    expect(installCommand({ kind: 'frontend' })).toEqual(['pnpm', 'install'])
    expect(installCommand({ kind: 'frontend', packageManager: 'yarn' })).toEqual([
      'yarn',
      'install',
    ])
  })

  it('splits an explicit install command, which overrides the package manager', () => {
    expect(
      installCommand({
        kind: 'frontend',
        packageManager: 'npm',
        install: 'pnpm i --frozen-lockfile',
      }),
    ).toEqual(['pnpm', 'i', '--frozen-lockfile'])
  })
})

describe('buildInfraNotes (agent prompt folding)', () => {
  it('is empty when the stand-up reported neither a problem nor a serve URL', () => {
    expect(buildInfraNotes({})).toEqual([])
  })

  it('flags a stand-up problem as a concern', () => {
    const [note] = buildInfraNotes({ note: 'compose exited 1' })
    expect(note).toContain('compose exited 1')
    expect(note).toContain('flag any dependency-related gaps as concerns')
  })

  it('points the UI tester at the serve URL and pre-empts a CORS mis-report', () => {
    const notes = buildInfraNotes({ serveUrl: 'http://localhost:4173' })
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('http://localhost:4173')
    expect(notes[0]).toContain('CORS')
    expect(notes[0]).toContain('not an app defect')
  })

  it('orders a problem note before the serve-URL note when both are present', () => {
    const notes = buildInfraNotes({
      note: 'WireMock never came up',
      serveUrl: 'http://localhost:4173',
    })
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('WireMock never came up')
    expect(notes[1]).toContain('Drive your UI tests against http://localhost:4173')
  })
})

describe('buildPreviewOutcome (preview stand-up boundary)', () => {
  it('succeeds when the app is served, carrying the serve URL', () => {
    const outcome = buildPreviewOutcome({ serveUrl: 'http://localhost:4173' })
    expect(outcome).toEqual({ ok: true, url: 'http://localhost:4173' })
  })

  it('surfaces a WireMock-down note as a soft warning on an otherwise-up preview', () => {
    const outcome = buildPreviewOutcome({
      serveUrl: 'http://localhost:4173',
      note: 'WireMock never came up',
    })
    expect(outcome).toEqual({
      ok: true,
      url: 'http://localhost:4173',
      note: 'WireMock never came up',
    })
  })

  it('fails hard when the served app is unreachable, folding the note into the reason', () => {
    const outcome = buildPreviewOutcome({ note: 'build exited 1' })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('build exited 1')
  })

  it('fails with a generic reason when there is no serve URL and no note', () => {
    const outcome = buildPreviewOutcome({})
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain('never reachable')
  })
})

describe('parseAgentJob (preview mode)', () => {
  it('accepts a preview job carrying the frontend infra spec', () => {
    const job = parseAgentJob({
      ...base,
      mode: 'preview',
      infra: { kind: 'frontend', servePort: 4173 },
    })
    expect(job.mode).toBe('preview')
    expect(job.infra?.kind).toBe('frontend')
  })

  it('rejects a job with an unknown mode', () => {
    expect(() => parseAgentJob({ ...base, mode: 'serve' })).toThrow(/mode/)
  })
})
