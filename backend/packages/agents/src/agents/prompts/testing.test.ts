import type { AgentRunContext } from '@cat-factory/kernel'
import { frameProfile } from '@cat-factory/contracts'
import { describe, expect, it } from 'vitest'
import { testerEnvironmentSection } from './testing.js'

function ctx(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'task', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...over,
  } as AgentRunContext
}

describe('frameProfile', () => {
  it('makes a library non-deployable, non-live-testable, UI-less, suite-postured', () => {
    expect(frameProfile('library')).toEqual({
      deployable: false,
      liveTestable: false,
      hasUi: false,
      testPosture: 'suite',
    })
  })

  it('keeps a frontend deployable + live-testable with a UI and exploratory posture', () => {
    expect(frameProfile('frontend')).toEqual({
      deployable: true,
      liveTestable: true,
      hasUi: true,
      testPosture: 'exploratory',
    })
  })

  it('defaults service (and any other block type / undefined) to the deployable service profile', () => {
    const serviceProfile = {
      deployable: true,
      liveTestable: true,
      hasUi: false,
      testPosture: 'exploratory' as const,
    }
    expect(frameProfile('service')).toEqual(serviceProfile)
    expect(frameProfile('api')).toEqual(serviceProfile)
    expect(frameProfile(undefined)).toEqual(serviceProfile)
  })
})

describe('testerEnvironmentSection — library posture', () => {
  it('runs a `library` frame as a suite (no deployment / running system), regardless of provisioning', () => {
    const out = testerEnvironmentSection(ctx({ service: { type: 'library' } }))
    expect(out).toContain('Run mode: library test suite')
    expect(out).toContain('public API surface')
    expect(out).toContain('add the missing unit/integration tests')
    // Never the service-shaped run modes.
    expect(out).not.toContain('ephemeral environment')
  })

  it('picks suite posture even when a library declares a compose path (repo-local test infra, not an env)', () => {
    const out = testerEnvironmentSection(
      ctx({
        service: {
          type: 'library',
          provisioning: { type: 'docker-compose', composePath: 'docker-compose.yml' },
        },
      }),
    )
    expect(out).toContain('Run mode: library test suite')
    expect(out).toContain('lifecycle scripts')
  })

  it('keeps the exploratory run modes for a deployable service frame', () => {
    const ephemeral = testerEnvironmentSection(
      ctx({
        service: { type: 'service', provisioning: { type: 'kubernetes' } },
        environment: { url: 'https://env.example', status: 'ready', access: null, expiresAt: null },
      }),
    )
    expect(ephemeral).toContain('Run mode: ephemeral environment')

    const infraless = testerEnvironmentSection(
      ctx({ service: { type: 'service', provisioning: { type: 'infraless' } } }),
    )
    expect(infraless).toContain('Run mode: no infra dependencies')
  })

  it('is empty for a non-tester kind', () => {
    expect(
      testerEnvironmentSection(ctx({ agentKind: 'coder', service: { type: 'library' } })),
    ).toBe('')
  })
})
