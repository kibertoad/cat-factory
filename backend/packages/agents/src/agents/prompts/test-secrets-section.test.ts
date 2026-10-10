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
  it('is empty for a kind that is handed no credentials at all', () => {
    // Absent, not empty: every non-tester prompt stays byte-identical.
    expect(testSecretsSection(ctx())).toBe('')
  })

  it('advertises each secret by key + description but never the value', () => {
    const out = testSecretsSection(
      ctx({
        status: 'resolved',
        refs: [
          { key: 'STRIPE_API_KEY', description: 'Stripe test-mode secret key' },
          { key: 'SENDGRID_TOKEN', description: 'SendGrid sandbox token' },
        ],
      }),
    )
    expect(out).toContain('`STRIPE_API_KEY`: Stripe test-mode secret key')
    expect(out).toContain('`SENDGRID_TOKEN`: SendGrid sandbox token')
    // The section tells the agent these are environment variables, not prompt values.
    expect(out).toContain('Read each of these from the environment')
    // The brief carries only refs (key + description), so a value cannot leak here.
    expect(out).not.toContain('sk_')
  })

  it('renders a bare key when a secret has no description', () => {
    const out = testSecretsSection(
      ctx({ status: 'resolved', refs: [{ key: 'API_TOKEN', description: '' }] }),
    )
    expect(out).toContain('`API_TOKEN`')
    expect(out).not.toContain('API_TOKEN`:')
  })

  // The three states the tester used to receive as one absent section. Each sends a human to a
  // different place, and the collapse sent them to the wrong one. They are rendered by the code
  // the environment DRY RUN shares, which is what makes a dry run predictive of this prompt.
  describe('the three credential states, told apart', () => {
    it('says a service with none configured has none, rather than saying nothing', () => {
      const out = testSecretsSection(ctx({ status: 'resolved', refs: [] }))
      expect(out).toContain('no test credentials configured on the board')
      expect(out).toContain('name the credential that is needed')
    })

    it('blames the PLATFORM when its own sealed store would not open', () => {
      const out = testSecretsSection(ctx({ status: 'unreadable' }))
      expect(out).toContain('THE PLATFORM IS AT FAULT')
      // The whole point of keeping this state: without it the report tells an operator to
      // configure credentials that are already there.
      expect(out).toContain('Do NOT tell a human to configure credentials for this service')
    })

    it('names a deployment with no credential store as a DEPLOYMENT fact', () => {
      const out = testSecretsSection(ctx({ status: 'unwired' }))
      expect(out).toContain('NONE ARE POSSIBLE HERE')
      expect(out).toContain('rather than asking for this service to be reconfigured')
    })
  })
})
