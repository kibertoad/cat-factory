import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { testSecretsSection } from './standard.js'

function ctx(testSecrets?: AgentRunContext['testSecrets']): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(testSecrets ? { testSecrets } : {}),
  }
}

describe('testSecretsSection', () => {
  it('is empty when the run carries no test secrets', () => {
    expect(testSecretsSection(ctx())).toBe('')
    expect(testSecretsSection(ctx([]))).toBe('')
  })

  it('advertises each secret by key + description but never the value', () => {
    const out = testSecretsSection(
      ctx([
        { key: 'STRIPE_API_KEY', description: 'Stripe test-mode secret key' },
        { key: 'SENDGRID_TOKEN', description: 'SendGrid sandbox token' },
      ]),
    )
    // The keys + descriptions are advertised so the agent knows what env vars exist.
    expect(out).toContain('`STRIPE_API_KEY` — Stripe test-mode secret key')
    expect(out).toContain('`SENDGRID_TOKEN` — SendGrid sandbox token')
    // The section tells the agent these are environment variables, not prompt values.
    expect(out).toContain('environment variables')
    // The context type carries only refs (key + description), so a value can't leak here.
    expect(out).not.toContain('sk_')
  })

  it('omits the em-dash suffix when a secret has no description', () => {
    const out = testSecretsSection(ctx([{ key: 'API_TOKEN', description: '' }]))
    expect(out).toContain('`API_TOKEN`')
    expect(out).not.toContain('API_TOKEN` —')
  })
})
