import type { AgentRunContext, McpServerDefinition, ToolSecretResolver } from '@cat-factory/kernel'
import { AgentKindRegistry } from '@cat-factory/agents'
import { describe, expect, it } from 'vitest'
import { createEnvToolSecretResolver, resolveToolServers } from './toolServers.js'

// Tool servers (MCP) for one dispatch. The two channels a server splits into are the point of
// these: the PROMPT-FACING projection must never carry a credential (it is copied into the
// agent-context telemetry snapshot), while the job-body spec must carry exactly the credentials
// the server declared, in the channel its declaration named.

function context(agentKind = 'auditor'): AgentRunContext {
  return { agentKind, pipelineName: 'p' } as unknown as AgentRunContext
}

function registryWith(...servers: McpServerDefinition[]): AgentKindRegistry {
  const registry = new AgentKindRegistry()
  registry.register({
    kind: 'auditor',
    systemPrompt: 'audit',
    agent: { surface: 'container-explore' },
    toolServers: servers,
  })
  return registry
}

const STDIO: McpServerDefinition = {
  id: 'issues',
  label: 'Issue tracker',
  guidance: 'Look up an issue before guessing at its intent.',
  transport: { kind: 'stdio', command: 'npx', args: ['-y', 'issue-mcp'], env: { REGION: 'eu' } },
  allowedTools: ['search_issues'],
  secretKeys: [{ key: 'ISSUE_TOKEN' }],
}

const HTTP: McpServerDefinition = {
  id: 'docs',
  transport: { kind: 'http', url: 'https://mcp.example.com/sse' },
  secretKeys: [{ key: 'DOCS_TOKEN', header: 'Authorization', headerTemplate: 'Bearer {value}' }],
}

const resolver = (values: Record<string, string>): ToolSecretResolver => ({
  resolve: async ({ keys }) =>
    Object.fromEntries(keys.map((k) => [k.key, values[k.key]]).filter(([, v]) => v)) as Record<
      string,
      string
    >,
})

describe('resolveToolServers', () => {
  it('splits a wired server into a non-secret projection and a secret-bearing job spec', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok' }),
    })
    expect(result.toolServers).toEqual([
      {
        id: 'issues',
        label: 'Issue tracker',
        guidance: 'Look up an issue before guessing at its intent.',
        tools: ['search_issues'],
        transport: 'stdio',
      },
    ])
    // The projection is what lands in the prompt AND the telemetry snapshot: no credential in it.
    expect(JSON.stringify(result.toolServers)).not.toContain('tok')
    expect(result.mcpServers).toEqual([
      {
        id: 'issues',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'issue-mcp'],
        env: { REGION: 'eu', ISSUE_TOKEN: 'tok' },
        allowedTools: ['search_issues'],
        secretKeys: ['ISSUE_TOKEN'],
      },
    ])
  })

  it('renders an http server’s secret into its declared header template', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(HTTP),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'abc' }),
    })
    expect(result.mcpServers[0]?.headers).toEqual({ Authorization: 'Bearer abc' })
  })

  it('drops a server the harness cannot serve and says so, rather than silently omitting it', async () => {
    // Pi has no MCP client. An agent told the tool is missing plans around it; an agent told
    // nothing discovers the gap mid-run, after planning on a tool that was never there.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'pi',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok' }),
    })
    expect(result.toolServers).toEqual([])
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers).toEqual([
      { id: 'issues', label: 'Issue tracker', reason: 'harness_unsupported' },
    ])
  })

  it('drops tool servers on an AMBIENT codex run, which has no per-job config home', async () => {
    // The harness will not write servers into the developer's own ~/.codex (they would outlive the
    // run and race a concurrent job), so the drop is decided HERE — where it can be reported to
    // the agent — rather than silently inside the container.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'codex',
      ambientAuth: true,
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok' }),
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers[0]?.reason).toBe('harness_unsupported')
    // An ambient CLAUDE-CODE run still gets them: it writes a throwaway per-job config file.
    const claude = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'claude-code',
      ambientAuth: true,
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok' }),
    })
    expect(claude.mcpServers.map((s) => s.id)).toEqual(['issues'])
  })

  it('drops a server whose REQUIRED credential does not resolve', async () => {
    // Handing an agent a tool whose first call will 401 is worse than telling it the tool is
    // absent — `required` therefore defaults to true.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({}),
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers[0]?.reason).toBe('missing_secret')
  })

  it('keeps a server whose OPTIONAL credential is missing, simply without it', async () => {
    const optional: McpServerDefinition = {
      ...STDIO,
      secretKeys: [{ key: 'ISSUE_TOKEN', required: false }],
    }
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(optional),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({}),
    })
    expect(result.mcpServers).toHaveLength(1)
    expect(result.mcpServers[0]?.env).toEqual({ REGION: 'eu' })
  })

  it('drops a secret-declaring server when NO resolver is wired', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.unavailableToolServers[0]?.reason).toBe('missing_secret')
  })

  it('wires a credential-free server with no resolver at all', async () => {
    const free: McpServerDefinition = { id: 'fs', transport: { kind: 'stdio', command: 'fs-mcp' } }
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(free),
      harness: 'codex',
      workspaceId: 'ws1',
    })
    expect(result.mcpServers.map((s) => s.id)).toEqual(['fs'])
  })

  it('costs nothing for a kind that declares no tool servers', async () => {
    const result = await resolveToolServers({
      context: context('coder'),
      agentKindRegistry: new AgentKindRegistry(),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result).toEqual({ toolServers: [], unavailableToolServers: [], mcpServers: [] })
  })

  it('never throws when the credential resolver does', async () => {
    const broken: ToolSecretResolver = {
      resolve: async () => {
        throw new Error('vault unreachable')
      },
    }
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: broken,
    })
    expect(result.unavailableToolServers[0]?.reason).toBe('missing_secret')
  })
})

describe('createEnvToolSecretResolver', () => {
  it('reads declared keys off the deployment environment and ignores anything else', async () => {
    const resolve = createEnvToolSecretResolver({ ISSUE_TOKEN: 'tok', OTHER: 'x', EMPTY: '' })
    expect(
      await resolve.resolve({
        workspaceId: 'ws1',
        subject: { kind: 'tool-server', id: 'issues' },
        keys: [{ key: 'ISSUE_TOKEN' }, { key: 'EMPTY' }, { key: 'ABSENT' }],
      }),
    ).toEqual({ ISSUE_TOKEN: 'tok' })
  })

  it('confines a deployment to an explicit key allow-list when one is set', async () => {
    // A tool-server definition names BOTH the credential it wants and the endpoint it talks to, so
    // on the Worker — where `env` is not ambient — the default resolver widens what a registration
    // can reach. `allowKeys` is how a deployment running agent packages it did not write closes
    // that back down.
    const resolve = createEnvToolSecretResolver(
      { MCP_ISSUE_TOKEN: 'tok', ENCRYPTION_KEY: 'master-key' },
      { allowKeys: ['MCP_ISSUE_TOKEN'] },
    )
    expect(
      await resolve.resolve({
        workspaceId: 'ws1',
        subject: { kind: 'tool-server', id: 'issues' },
        keys: [{ key: 'MCP_ISSUE_TOKEN' }, { key: 'ENCRYPTION_KEY' }],
      }),
    ).toEqual({ MCP_ISSUE_TOKEN: 'tok' })
  })
})

describe('job-spec secret marking', () => {
  // The harness registers exactly the marked values for redaction. Marking the whole env/headers
  // map instead would scrub ordinary config strings out of every log line the container writes.
  it('names only the keys whose values came from the resolver', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO, HTTP),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok', DOCS_TOKEN: 'dtok' }),
    })
    const [stdio, http] = result.mcpServers
    // `REGION` is declared transport config, not a credential — it must not be marked.
    expect(stdio?.env).toEqual({ REGION: 'eu', ISSUE_TOKEN: 'tok' })
    expect(stdio?.secretKeys).toEqual(['ISSUE_TOKEN'])
    // For an HTTP server the marked key is the HEADER name, which is where the value landed.
    expect(http?.headers).toEqual({ Authorization: 'Bearer dtok' })
    expect(http?.secretKeys).toEqual(['Authorization'])
  })

  it('marks nothing when a server declared no credentials', async () => {
    const bare: McpServerDefinition = {
      id: 'local',
      transport: { kind: 'stdio', command: 'npx', env: { REGION: 'eu' } },
    }
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(bare),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.mcpServers[0]?.secretKeys).toBeUndefined()
  })
})
