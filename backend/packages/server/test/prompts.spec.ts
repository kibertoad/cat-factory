import { describe, expect, it } from 'vitest'
import type { AgentRunContext } from '@cat-factory/kernel'
import type { RepoTarget } from '../src/agents/ContainerAgentExecutor.js'
import {
  blueprintUserPrompt,
  mergerUserPrompt,
  onCallUserPrompt,
  prBody,
  specWriterUserPrompt,
  TEST_REPORT_SHAPE_HINT,
  testerInfraSpec,
  UI_TEST_REPORT_SHAPE_HINT,
} from '../src/agents/prompts.js'

// Characterisation tests pinning the per-kind prompt material that was extracted verbatim
// from ContainerAgentExecutor.ts into prompts.ts. They lock in the deterministic prompt
// shapes + the infra-spec branches so the move is provably behaviour-preserving.

const repo: RepoTarget = {
  installationId: 1,
  owner: 'acme',
  name: 'widgets',
  baseBranch: 'main',
}

const context = (over: Record<string, unknown> = {}): AgentRunContext =>
  ({
    agentKind: 'on-call',
    pipelineName: 'Ship',
    block: { id: 'b1', title: 'Add login', type: 'task' },
    decisions: [],
    priorOutputs: [],
    ...over,
  }) as unknown as AgentRunContext

describe('blueprintUserPrompt', () => {
  it('instructs an update-or-create that returns the complete tree as JSON only', () => {
    const p = blueprintUserPrompt()
    expect(p).toContain('canonical service → modules blueprint')
    expect(p).toContain('blueprints/blueprint.json')
    expect(p).toContain('ONLY the JSON object')
  })
})

describe('specWriterUserPrompt', () => {
  it('embeds the block header + description and the default self-determine guidance', () => {
    const p = specWriterUserPrompt(
      context({
        block: { id: 'b9', title: 'Refactor auth', type: 'task', description: 'Tidy it' },
      }),
    )
    expect(p).toContain('### Refactor auth (block b9)')
    expect(p).toContain('Tidy it')
    expect(p).toContain('If this task is purely TECHNICAL')
  })

  it('withdraws the no-specs escape hatch for an explicit BUSINESS task', () => {
    const p = specWriterUserPrompt(
      context({ block: { id: 'b1', title: 'T', type: 'task', technical: false } }),
    )
    expect(p).toContain('explicitly flagged BUSINESS')
    expect(p).not.toContain('If this task is purely TECHNICAL')
  })

  it('tells an explicit TECHNICAL task the empty outcome is expected', () => {
    const p = specWriterUserPrompt(
      context({ block: { id: 'b1', title: 'T', type: 'task', technical: true } }),
    )
    expect(p).toContain('explicitly flagged TECHNICAL')
    expect(p).toContain('{"noBusinessSpecs": true}')
  })
})

describe('mergerUserPrompt', () => {
  it('names the PR + branches so the agent diffs against the right base', () => {
    const p = mergerUserPrompt(
      context({
        block: {
          id: 'b1',
          title: 'T',
          type: 'task',
          pullRequest: { number: 42, branch: 'feat/x', url: 'u' },
        },
      }),
      repo,
    )
    expect(p).toContain('(PR #42)')
    expect(p).toContain('`feat/x`')
    expect(p).toContain('git diff origin/main...HEAD')
  })

  it('falls back to the base branch when there is no PR', () => {
    const p = mergerUserPrompt(context({ block: { id: 'b1', title: 'T', type: 'task' } }), repo)
    expect(p).toContain('`main`')
    expect(p).not.toContain('(PR #')
  })
})

describe('onCallUserPrompt', () => {
  it('tells the agent how to locate the merged commit by PR number', () => {
    const p = onCallUserPrompt(
      context({
        block: {
          id: 'b1',
          title: 'T',
          type: 'task',
          pullRequest: { number: 7, branch: 'feat/y', url: 'u' },
        },
      }),
      repo,
    )
    expect(p).toContain('#7')
    expect(p).toContain('git log --oneline -n 50')
    expect(p).toContain('base branch `main`')
  })
})

describe('testerInfraSpec', () => {
  it('carries the docker-compose path for a `docker-compose` service', () => {
    const spec = testerInfraSpec(
      context({
        service: { provisioning: { type: 'docker-compose', composePath: 'docker-compose.yml' } },
      } as Record<string, unknown>),
    )
    expect(spec).toMatchObject({
      environment: 'local',
      noInfraDependencies: false,
      composePath: 'docker-compose.yml',
    })
  })

  it('flags no-infra for an `infraless` service (or none declared)', () => {
    const spec = testerInfraSpec(
      context({ service: { provisioning: { type: 'infraless' } } } as Record<string, unknown>),
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

describe('prBody', () => {
  it('renders the block title/type, description and pipeline name', () => {
    const body = prBody(
      context({ block: { id: 'b1', title: 'Add login', type: 'task', description: 'do it' } }),
    )
    expect(body).toContain('**Add login** (task)')
    expect(body).toContain('do it')
    expect(body).toContain('Pipeline: Ship')
  })
})

describe('UI_TEST_REPORT_SHAPE_HINT', () => {
  it('extends the base tester report with a screenshots array', () => {
    expect(UI_TEST_REPORT_SHAPE_HINT).toContain('"screenshots"')
    // Derived from the base hint, so it preserves its leading shape.
    expect(UI_TEST_REPORT_SHAPE_HINT.startsWith(TEST_REPORT_SHAPE_HINT.replace(/\}\.$/, ''))).toBe(
      true,
    )
  })
})
