import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { environmentDispatchRefusal } from './environmentDispatch.logic.js'

function ctx(over: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Standard build',
    stepIndex: 4,
    isFinalStep: false,
    block: { title: 'Stand up the glossary API', type: 'task', description: '' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    service: { provisioning: { type: 'custom' } },
    ...over,
  } as AgentRunContext
}

describe('environmentDispatchRefusal', () => {
  it('lets a reachable environment through', () => {
    expect(
      environmentDispatchRefusal(
        ctx({
          environment: {
            url: 'https://pr-8.example.test',
            status: 'ready',
            access: null,
            expiresAt: null,
          },
        }),
      ),
    ).toBeNull()
  })

  it('refuses a step whose environment is still provisioning, naming the state', () => {
    const refusal = environmentDispatchRefusal(
      ctx({
        environment: { url: null, status: 'provisioning', access: null, expiresAt: null },
      }),
    )

    expect(refusal).toMatchObject({
      kind: 'job_failed',
      failureKind: 'environment',
      reason: 'environment_not_ready',
    })
    expect(refusal?.kind === 'job_failed' && refusal.detail).toContain('provisioning')
  })

  it('separates "never provisioned" from "not ready", because the fixes differ', () => {
    const refusal = environmentDispatchRefusal(ctx())

    expect(refusal).toMatchObject({ kind: 'job_failed', reason: 'environment_missing' })
    expect(refusal?.kind === 'job_failed' && refusal.detail).toContain('deployer')
  })

  it('leaves every step that is not in ephemeral mode alone', () => {
    // A coder on the same service, a library frame, and a compose service with nothing provisioned
    // all stand their own infra up (or need none); refusing them would break runs that are fine.
    expect(environmentDispatchRefusal(ctx({ agentKind: 'coder' }))).toBeNull()
    expect(
      environmentDispatchRefusal(
        ctx({ service: { type: 'library', provisioning: { type: 'custom' } } }),
      ),
    ).toBeNull()
    expect(
      environmentDispatchRefusal(ctx({ service: { provisioning: { type: 'docker-compose' } } })),
    ).toBeNull()
  })
})
