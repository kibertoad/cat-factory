import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import { dispatchEnvironmentUrls, prBody, testerInfraSpec } from '../src/agents/prompts.js'

// Characterisation tests pinning what the container dispatch layer still renders itself: the
// tester infra-spec branches and the pull-request body. The per-KIND prompts moved beside their
// registrations in `@cat-factory/agents`, and their tests moved with them
// (`agents/prompts/built-in-container.test.ts`).

const context = (over: Record<string, unknown> = {}): AgentRunContext =>
  ({
    agentKind: 'tester-api',
    pipelineName: 'Ship',
    block: { id: 'b1', title: 'Add login', type: 'task' },
    decisions: [],
    priorOutputs: [],
    ...over,
  }) as unknown as AgentRunContext

describe('testerInfraSpec', () => {
  it('runs ephemeral for a `docker-compose` service (Deployer-provisioned, no in-container bring-up)', () => {
    // Compose is now stood up by the single Deployer step through a workspace handler, exactly like
    // kubernetes/custom — so the Tester targets the provisioned env, never a local `composePath`.
    const spec = testerInfraSpec(
      context({
        service: { provisioning: { type: 'docker-compose', composePath: 'docker-compose.yml' } },
        environment: { url: 'https://compose.env' },
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'ephemeral', environmentUrl: 'https://compose.env' })
  })

  it('flags no-infra for an `infraless` service (or none declared)', () => {
    const spec = testerInfraSpec(
      context({ service: { provisioning: { type: 'infraless' } } } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'local', noInfraDependencies: true })
  })

  it('stands a `library` frame`s declared compose path up locally (reviving the in-container path)', () => {
    // A library is never deployed: a declared compose file is repo-local TEST infra brought up on
    // localhost (the harness `standUpInfra` DinD path), NOT an ephemeral environment.
    const spec = testerInfraSpec(
      context({
        service: {
          type: 'library',
          provisioning: { type: 'docker-compose', composePath: 'packages/db/docker-compose.yml' },
        },
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'local', composePath: 'packages/db/docker-compose.yml' })
  })

  it('runs a `library` frame with no declared compose path as a self-managed local suite', () => {
    // No compose path → nothing is stood up here; the agent self-manages deps via the repo`s
    // `pretest:ci`/`test:ci` lifecycle scripts (narrated in the tester prompt).
    const spec = testerInfraSpec(
      context({ service: { type: 'library' } } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'local', noInfraDependencies: true })
  })

  it('never provisions an ephemeral env for a `library` frame, even with an env URL present', () => {
    // The frame capability profile wins over a stray env URL: a library never targets an ephemeral env.
    const spec = testerInfraSpec(
      context({
        service: { type: 'library' },
        environment: { url: 'https://stray.env' },
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'local', noInfraDependencies: true })
  })

  it('carries the provisioned environment URL for a `kubernetes`/`custom` service', () => {
    const spec = testerInfraSpec(
      context({
        service: { provisioning: { type: 'kubernetes' } },
        environment: { url: 'https://env.example' },
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'ephemeral', environmentUrl: 'https://env.example' })
  })

  it('runs ephemeral against a provisioned env URL even when no provisioning is declared (a deployer step provisioned it)', () => {
    const spec = testerInfraSpec(
      context({ environment: { url: 'https://env-1.example' } } as Record<string, unknown>),
    )
    expect(spec).toEqual({ environment: 'ephemeral', environmentUrl: 'https://env-1.example' })
  })

  it('maps involved peers with a live env into `peerEnvironments` keyed by title', () => {
    const spec = testerInfraSpec(
      context({
        service: { provisioning: { type: 'kubernetes' } },
        environment: { url: 'https://env.example' },
        involvedServices: [
          { frameId: 'f_email', title: 'Email', envUrl: 'https://email.env' },
          // A peer with no live env this run contributes nothing.
          { frameId: 'f_db', title: 'DB' },
        ],
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({
      environment: 'ephemeral',
      environmentUrl: 'https://env.example',
      peerEnvironments: { Email: 'https://email.env' },
    })
  })

  it('disambiguates two involved peers that share a title instead of dropping one', () => {
    const spec = testerInfraSpec(
      context({
        environment: { url: 'https://env.example' },
        involvedServices: [
          { frameId: 'f_a', title: 'Email', envUrl: 'https://a.env' },
          { frameId: 'f_b', title: 'Email', envUrl: 'https://b.env' },
        ],
      } as Record<string, unknown>),
    )
    // Both URLs survive — the collision is disambiguated with the frame id, not silently overwritten.
    expect(spec.peerEnvironments).toEqual({
      Email: 'https://a.env',
      'Email (f_b)': 'https://b.env',
    })
  })

  it('builds the frontend infra spec when the frame is a frontend (service under test + mocks)', () => {
    const spec = testerInfraSpec(
      context({
        frontend: {
          config: {
            packageManager: 'pnpm',
            buildScript: 'build',
            outputDir: 'dist',
            serveMode: 'static',
            mockMappingsPath: 'mocks/',
            backendBindings: [],
          },
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
            { envVar: 'PUB_OTHER_URL' },
          ],
        },
      } as Record<string, unknown>),
    )
    expect(spec).toEqual({
      kind: 'frontend',
      packageManager: 'pnpm',
      buildScript: 'build',
      outputDir: 'dist',
      serveMode: 'static',
      // Defaulted server port (NOT 8080 — the harness's own job server owns that).
      servePort: 4173,
      env: {
        // The live service under test keeps its real ephemeral URL...
        PUB_API_URL: 'https://api.ephemeral.example',
        // ...every other upstream is pointed at the in-container WireMock.
        PUB_OTHER_URL: 'http://localhost:8089',
      },
      wiremockMappingsPath: 'mocks/',
      wiremockPort: 8089,
    })
  })

  it('drops a binding whose env var is a reserved name (would clobber the build toolchain)', () => {
    const spec = testerInfraSpec(
      context({
        frontend: {
          config: { backendBindings: [] },
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
            // A reserved name must never be injected — the harness re-filters it, but the
            // backend drops it here too so it never leaves as an env var.
            { envVar: 'PATH', serviceUrl: 'https://evil.example' },
            { envVar: 'NODE_OPTIONS' },
          ],
        },
      } as Record<string, unknown>),
    )
    expect(spec).toMatchObject({
      kind: 'frontend',
      env: { PUB_API_URL: 'https://api.ephemeral.example' },
    })
    expect((spec.env as Record<string, string>).PATH).toBeUndefined()
    expect((spec.env as Record<string, string>).NODE_OPTIONS).toBeUndefined()
  })

  it('drops a binding whose env var is in a reserved FAMILY (npm_config_* / GIT_*)', () => {
    const spec = testerInfraSpec(
      context({
        frontend: {
          config: { backendBindings: [] },
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
            // These reconfigure the package manager / git DURING the build → never injected.
            { envVar: 'npm_config_registry', serviceUrl: 'https://evil.example' },
            { envVar: 'GIT_SSH_COMMAND', serviceUrl: 'https://evil.example' },
            { envVar: 'NODE_EXTRA_CA_CERTS', serviceUrl: 'https://evil.example' },
          ],
        },
      } as Record<string, unknown>),
    )
    expect(spec.env).toEqual({ PUB_API_URL: 'https://api.ephemeral.example' })
  })

  it('drops a reserved FAMILY binding case-insensitively (npm honours NPM_CONFIG_* in any case)', () => {
    const spec = testerInfraSpec(
      context({
        frontend: {
          config: { backendBindings: [] },
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
            // npm reads its config env with a case-insensitive `/^npm_config_/i`, so the
            // upper/mixed-cased forms must be dropped too (a case-sensitive filter would leak them).
            { envVar: 'NPM_CONFIG_REGISTRY', serviceUrl: 'https://evil.example' },
            { envVar: 'Git_Ssh_Command', serviceUrl: 'https://evil.example' },
          ],
        },
      } as Record<string, unknown>),
    )
    expect(spec.env).toEqual({ PUB_API_URL: 'https://api.ephemeral.example' })
  })

  it('falls back to the default serve port when the configured port collides with a reserved one', () => {
    for (const reserved of [8080, 8089]) {
      const spec = testerInfraSpec(
        context({
          frontend: {
            config: { servePort: reserved, backendBindings: [] },
            bindings: [],
          },
        } as Record<string, unknown>),
      )
      // 8080 is the harness job server, 8089 is WireMock — neither is usable, so fall back to 4173.
      expect(spec).toMatchObject({ kind: 'frontend', servePort: 4173, wiremockPort: 8089 })
    }
  })

  it('takes the frontend branch even when a provisioned env URL is also present', () => {
    const spec = testerInfraSpec(
      context({
        environment: { url: 'https://env.example' },
        frontend: { config: { backendBindings: [] }, bindings: [] },
      } as Record<string, unknown>),
    )
    expect(spec).toMatchObject({ kind: 'frontend', servePort: 4173, wiremockPort: 8089 })
  })
})

describe('dispatchEnvironmentUrls', () => {
  /** Every string in a rendered infra spec that parses as an absolute http(s) URL. */
  const urlsIn = (value: unknown): string[] => {
    if (typeof value === 'string') {
      return /^https?:\/\//.test(value) ? [value] : []
    }
    if (Array.isArray(value)) return value.flatMap(urlsIn)
    if (value && typeof value === 'object') return Object.values(value).flatMap(urlsIn)
    return []
  }

  // The one context that exercises all three legs at once: the frame's own provisioned
  // environment, a live peer for a cross-service test, and a frontend binding resolved to the
  // service under test.
  const everyLeg = () =>
    context({
      service: { provisioning: { type: 'kubernetes' } },
      environment: { url: 'https://env.example' },
      involvedServices: [
        { frameId: 'f_email', title: 'Email', envUrl: 'https://email.env' },
        { frameId: 'f_db', title: 'DB' },
      ],
    } as Record<string, unknown>)

  it('lists the run own environment and every live peer', () => {
    expect(dispatchEnvironmentUrls(everyLeg()).sort()).toEqual([
      'https://email.env',
      'https://env.example',
    ])
  })

  it('lists a frontend binding resolved to a real service, and never the in-container mock', () => {
    // The WireMock URL the harness substitutes for an unresolved binding is served INSIDE the
    // container and is reached exactly as written. Declaring it as an environment would invite a
    // transport to re-point `localhost`, breaking what the job is there to drive.
    const urls = dispatchEnvironmentUrls(
      context({
        frontend: {
          config: { backendBindings: [] },
          bindings: [
            { envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' },
            { envVar: 'PUB_OTHER_URL' },
            // Dropped for a reserved name, so the job never receives it.
            { envVar: 'PATH', serviceUrl: 'https://never-injected.example' },
          ],
        },
      } as Record<string, unknown>),
    )
    expect(urls).toEqual(['https://api.ephemeral.example'])
  })

  it('accounts for EVERY URL the rendered infra spec carries', () => {
    // The relation that would have caught the bug this exists because of. A transport acting on
    // these URLs cannot read them back out of the job body (an untyped bag, three levels deep,
    // under a wire shape the harness owns) — the first cut tried and read a field the engine has
    // never emitted, so the bridge could not fire in production. Declaring them separately is only
    // safe while the declaration stays a SUPERSET of what the spec renders, and that is what this
    // asserts: derived from the spec itself rather than pinned to a list, so a fourth leg added to
    // the spec fails here instead of going silently unbridged.
    for (const ctx of [
      everyLeg(),
      context({
        frontend: {
          config: { backendBindings: [] },
          bindings: [{ envVar: 'PUB_API_URL', serviceUrl: 'https://api.ephemeral.example' }],
        },
      } as Record<string, unknown>),
    ]) {
      const declared = new Set(dispatchEnvironmentUrls(ctx))
      const rendered = urlsIn(testerInfraSpec(ctx)).filter(
        // The harness's own in-container mock is not an environment; see the case above.
        (url) => !url.startsWith('http://localhost:'),
      )
      expect(rendered.length).toBeGreaterThan(0)
      for (const url of rendered) expect(declared, url).toContain(url)
    }
  })
})

describe('prBody', () => {
  it('renders the block title/type, description and pipeline name', () => {
    const body = prBody(
      context({ block: { id: 'b1', title: 'Add login', type: 'task', description: 'do it' } }),
    )
    expect(body).toContain('**Add login** (task)')
    expect(body).toContain('do it')
    expect(body).toContain('`Ship` pipeline')
    // The fallback marks itself as dispatch-time text so a reviewer knows no agent briefing exists.
    expect(body).toContain('the agent did not write')
    // No fork decision ran ⇒ no approach section.
    expect(body).not.toContain('Chosen implementation approach')
  })

  it('briefs the reviewer on the human-chosen implementation approach when the fork phase ran', () => {
    const body = prBody(
      context({
        block: { id: 'b1', title: 'Add login', type: 'task', description: 'do it' },
        implementationChoice: {
          source: 'proposed',
          title: 'Session cookie',
          approach: 'Store the session server-side; the cookie carries only the id.',
          note: 'Keep the cookie HttpOnly.',
          alternativesConsidered: ['Stateless JWT', 'OAuth-only'],
        },
      } as Record<string, unknown>),
    )
    expect(body).toContain('## Chosen implementation approach')
    expect(body).toContain('**Session cookie**')
    expect(body).toContain('Store the session server-side')
    expect(body).toContain('Alternatives considered and rejected: Stateless JWT; OAuth-only.')
    expect(body).toContain('Keep the cookie HttpOnly.')
  })

  // Every hole in this body carries text the platform did not write — a human's description and
  // note, and the fork PROPOSER MODEL's own titles. It lands on a host-parsed surface that the
  // merger step then merges for real, so an auto-link trigger must never reach it live.
  it('defuses host auto-link triggers in every untrusted hole', () => {
    const body = prBody(
      context({
        block: {
          id: 'b1',
          title: 'Fix login for @alice',
          type: 'task',
          description: 'Closes https://github.com/acme/app/issues/42 — see #17.',
        },
        implementationChoice: {
          source: 'custom',
          title: 'Approach for #99',
          approach: 'Ping @bob when the cookie rotates.',
          note: 'Blocks !31.',
          alternativesConsidered: ['Reuse @acme/session'],
        },
      } as Record<string, unknown>),
    )
    expect(body).not.toMatch(/@alice|@bob|@acme/)
    expect(body).not.toMatch(/#17|#42|#99/)
    expect(body).not.toMatch(/!31/)
    expect(body).not.toMatch(/\bCloses https/)
    // Defused, not deleted — the reader still sees what was written.
    expect(body).toContain('&#64;alice')
  })
})
