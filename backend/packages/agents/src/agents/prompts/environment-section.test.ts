import type { AgentRunContext } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { environmentSection } from './standard.js'

function ctx(environment?: AgentRunContext['environment']): AgentRunContext {
  return {
    agentKind: 'tester-api',
    pipelineName: 'Build & test',
    stepIndex: 3,
    isFinalStep: false,
    block: { title: 'Add /grass CRUD', type: 'task', description: 'REST CRUD for grass.' },
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
})
