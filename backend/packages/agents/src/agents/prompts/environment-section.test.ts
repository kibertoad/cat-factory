import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { environmentSection } from './standard.js'

function ctx(environment?: AgentRunContext['environment']): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'api', description: 'REST CRUD for grass.' },
    priorOutputs: [],
    decisions: [],
    resolvedDecision: null,
    ...(environment ? { environment } : {}),
  }
}

describe('environmentSection', () => {
  it('is empty when no environment is attached', () => {
    expect(environmentSection(ctx())).toBe('')
  })

  it('renders standardized coordinates (url + host/port/scheme) derived from the URL', () => {
    const out = environmentSection(
      ctx({ url: 'https://pr-123.example.com', status: 'ready', access: null, expiresAt: null }),
    )
    expect(out).toContain('- URL: https://pr-123.example.com')
    expect(out).toContain('Host: pr-123.example.com')
    expect(out).toContain('Port: 443')
    expect(out).toContain('Scheme: https')
    expect(out).toContain('- Status: ready')
  })

  it('uses the explicit port when the URL carries one', () => {
    const out = environmentSection(
      ctx({ url: 'http://10.0.0.5:8080', status: 'ready', access: null, expiresAt: null }),
    )
    expect(out).toContain('Host: 10.0.0.5')
    expect(out).toContain('Port: 8080')
    expect(out).toContain('Scheme: http')
  })

  it('renders a bearer token in full so the Tester can actually authenticate', () => {
    const out = environmentSection(
      ctx({
        url: 'https://env.example.com',
        status: 'ready',
        access: { scheme: 'bearer', token: 'tok_abc123' },
        expiresAt: null,
      }),
    )
    expect(out).toContain('Bearer token `tok_abc123`')
  })

  it('renders HTTP basic username + password in full', () => {
    const out = environmentSection(
      ctx({
        url: 'https://env.example.com',
        status: 'ready',
        access: { scheme: 'basic', username: 'tester', password: 's3cret' },
        expiresAt: null,
      }),
    )
    expect(out).toContain('username `tester`')
    expect(out).toContain('password `s3cret`')
  })

  it('renders a custom header name + value', () => {
    const out = environmentSection(
      ctx({
        url: 'https://env.example.com',
        status: 'ready',
        access: { scheme: 'custom_header', headerName: 'X-Api-Key', headerValue: 'key_xyz' },
        expiresAt: null,
      }),
    )
    expect(out).toContain('X-Api-Key: key_xyz')
  })

  it('omits the auth line for the none scheme', () => {
    const out = environmentSection(
      ctx({
        url: 'https://env.example.com',
        status: 'ready',
        access: { scheme: 'none' },
        expiresAt: null,
      }),
    )
    expect(out).not.toContain('Auth:')
  })

  describe('reachability', () => {
    const withNote = (reachability?: NonNullable<AgentRunContext['environment']>['reachability']) =>
      environmentSection(
        ctx({
          url: 'https://env.example.com',
          status: 'ready',
          access: null,
          expiresAt: null,
          ...(reachability ? { reachability } : {}),
        }),
      )

    it('says NOTHING for the ordinary case, where the environment name carried', () => {
      // A line on every prompt is a line nobody reads on the one prompt where it matters. The same
      // silence covers a deployment with no prober, whose note is withheld upstream: an unverified
      // -reachability warning on every prompt is what "always present" degrades to.
      expect(withNote()).not.toContain('Reachability')
      expect(withNote({ state: 'reached' })).not.toContain('Reachability')
    })

    it('names the address that carried, and tells the agent what to do with it', () => {
      const out = withNote({ state: 'reached', address: '10.4.19.22' })
      expect(out).toContain('reached this environment at 10.4.19.22')
      expect(out).toContain('keep the Host header')
    })

    it('says the platform could not tell, with the probe detail, for an INCONCLUSIVE proof', () => {
      // The sentence that turns "the environment is down" from the salient conclusion into a
      // hypothesis the agent has evidence against.
      const out = withNote({ state: 'inconclusive', reason: 'probe_failed', detail: 'ECONNRESET' })
      expect(out).toContain('could not establish anything either way')
      expect(out).toContain('probe_failed: ECONNRESET')
      expect(out).toContain('unexplained')
    })

    it('states the layer for an environment the platform could not reach', () => {
      expect(withNote({ state: 'not_reached', reason: 'name_unresolved' })).toContain(
        'could NOT reach this environment (name_unresolved)',
      )
    })
  })
})
