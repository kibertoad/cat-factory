import type { McpServerDefinition } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import { defaultGateRegistry } from '@cat-factory/kernel'
import type { GateRegistry } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { collectRegistrationProblems } from './validation/validateRegistrations.js'

// Boot validation of the OAUTH half of a tool-server declaration. Its own file rather than another
// block in `extension-registries.test.ts`, which is at its max-lines ratchet: each rule here names
// a failure that is otherwise invisible until a run or a button press, and the header collision in
// particular is the one a deployment reads as "the platform ignored my credential".

let registry: AgentKindRegistry
let gates: GateRegistry
beforeEach(() => {
  registry = new AgentKindRegistry()
  gates = defaultGateRegistry()
})

describe('agent-capability validation: tool-server OAuth', () => {
  const withOAuth = (server: McpServerDefinition) => {
    registry.register({
      kind: 'auditor',
      systemPrompt: 'audit',
      agent: { surface: 'container-explore' },
      toolServers: [server],
    })
    return collectRegistrationProblems({
      registries: { agentKindRegistry: registry, gateRegistry: gates },
    })
  }

  it('rejects oauth on a stdio server, which has no request to authorise', () => {
    const problems = withOAuth({
      id: 'issues',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', 'issue-mcp'] },
      oauth: { grant: 'authorization_code', clientId: 'cid' },
    })
    expect(problems.find((p) => p.code === 'oauth_requires_http_transport')?.severity).toBe('error')
  })

  it('rejects a cleartext oauth endpoint off loopback', () => {
    const problems = withOAuth({
      id: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
      oauth: {
        grant: 'authorization_code',
        clientId: 'cid',
        authorizationUrl: 'http://auth.example.com/authorize',
        tokenUrl: 'https://auth.example.com/token',
      },
    })
    expect(problems.find((p) => p.code === 'insecure_oauth_endpoint')?.message).toContain(
      'authorizationUrl',
    )
  })

  it('rejects a client secret looked up by a platform configuration variable', () => {
    const problems = withOAuth({
      id: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
      oauth: { grant: 'authorization_code', clientId: 'cid', clientSecretKey: 'ENCRYPTION_KEY' },
    })
    expect(problems.find((p) => p.code === 'reserved_credential_key')?.severity).toBe('error')
  })

  it('warns when a static credential names the header the access token rides', () => {
    // Both land in one header map and the granted token wins, so the static credential reaches
    // the server as nothing at all.
    const problems = withOAuth({
      id: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
      oauth: { grant: 'authorization_code', clientId: 'cid' },
      secretKeys: [{ key: 'DOCS_TOKEN', header: 'authorization' }],
    })
    expect(problems.find((p) => p.code === 'oauth_header_collision')?.severity).toBe('warn')
  })

  it('accepts a sound oauth declaration, discovery included', () => {
    const problems = withOAuth({
      id: 'docs',
      transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
      oauth: { grant: 'client_credentials', clientId: 'cid', clientSecretKey: 'MCP_DOCS_SECRET' },
    })
    expect(problems).toEqual([])
  })
})
