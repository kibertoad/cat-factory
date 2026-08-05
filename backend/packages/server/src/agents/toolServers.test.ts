import type {
  AgentRunContext,
  McpOAuthTokenResult,
  McpOAuthTokenSource,
  McpServerDefinition,
  ToolSecretResolver,
} from '@cat-factory/kernel'
import { TOOL_SERVER_BUDGET } from '@cat-factory/kernel'
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

// Which TRANSPORTS the running harness can reach, which is a different question from which
// harnesses the definition allows — and the one the dispatch used not to ask.
describe('transport support', () => {
  it('drops an http server on a CODEX run, whose MCP client is stdio-only', async () => {
    // The defect this closes: harness membership passed (Codex speaks MCP and the definition named
    // no allow-list), so the server was advertised in the prompt under "prefer them over guessing"
    // — and then skipped by the harness's stdio-only TOML writer. The agent planned around a tool
    // that was never wired, with nothing anywhere saying so.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(HTTP),
      harness: 'codex',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'abc' }),
    })
    expect(result.toolServers).toEqual([])
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers).toEqual([
      { id: 'docs', label: 'docs', reason: 'transport_unsupported' },
    ])
  })

  it('keeps the same http server on a claude-code run', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(HTTP),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'abc' }),
    })
    expect(result.mcpServers.map((s) => s.id)).toEqual(['docs'])
  })

  it('keeps a stdio server on codex, and reports each declared server on its own terms', async () => {
    // A mixed declaration is the realistic case, and it must not be all-or-nothing: the stdio
    // server is wired and the http one is stated, in one dispatch.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(STDIO, HTTP),
      harness: 'codex',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ISSUE_TOKEN: 'tok', DOCS_TOKEN: 'abc' }),
    })
    expect(result.mcpServers.map((s) => s.id)).toEqual(['issues'])
    expect(result.unavailableToolServers.map((s) => s.reason)).toEqual(['transport_unsupported'])
  })

  it('reports `harness_unsupported`, not a transport reason, when the harness speaks no MCP', async () => {
    // The two need different fixes (a `harnesses` list vs the choice of runtime), so a Pi run must
    // not be described as a transport problem.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(HTTP),
      harness: 'pi',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'abc' }),
    })
    expect(result.unavailableToolServers[0]?.reason).toBe('harness_unsupported')
  })
})

// `allowedTools` decides two things that must not disagree: what the prompt advertises and what the
// CLI is actually narrowed to. Registration refuses a bad entry, so these are the same
// belt-and-braces the reserved-key and envName floors get at this layer.
describe('allowedTools at the dispatch boundary', () => {
  const withTools = (allowedTools: string[]): McpServerDefinition => ({
    id: 'issues',
    transport: { kind: 'stdio', command: 'npx' },
    allowedTools,
  })

  it('drops an entry that is not a single tool name from BOTH channels at once', async () => {
    // The harness drops the comma-packed entry at the job boundary, so leaving it here would put a
    // tool name in the prompt that the allow-list never granted: the exact failure the whole
    // unavailability vocabulary exists to prevent.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(withTools(['search_issues,get_issue', 'list_issues'])),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.toolServers[0]?.tools).toEqual(['list_issues'])
    expect(result.mcpServers[0]?.allowedTools).toEqual(['list_issues'])
  })

  it('falls back to NO restriction when nothing in the list survives, as the harness does', async () => {
    // Same answer as an absent field (every tool the server exposes). The alternative sends a list
    // whose only entries are the CLI's own built-in tools, i.e. a run narrowed to no MCP tools.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(withTools(['a,b', 'search issues'])),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.toolServers[0]?.tools).toBeUndefined()
    expect(result.mcpServers[0]?.allowedTools).toBeUndefined()
  })
})

// The per-dispatch budget. A kind accretes tool servers through `assignToolServers` calls in several
// packages, none of them individually wrong, and the job body is one HTTP payload.
describe('the tool-server budget', () => {
  const many = (count: number): McpServerDefinition[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `srv${i}`,
      transport: { kind: 'stdio' as const, command: 'npx', args: [`server-${i}`] },
    }))

  it('wires up to the cap and STATES the rest rather than dropping them silently', async () => {
    const servers = many(TOOL_SERVER_BUDGET.maxServers + 3)
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(...servers),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.mcpServers).toHaveLength(TOOL_SERVER_BUDGET.maxServers)
    // Declaration order, so the cap is a plain prefix: the kind's own servers come before anything
    // a deployment assigned onto it.
    expect(result.mcpServers.map((s) => s.id)).toEqual(
      servers.slice(0, TOOL_SERVER_BUDGET.maxServers).map((s) => s.id),
    )
    expect(result.unavailableToolServers).toEqual(
      servers.slice(TOOL_SERVER_BUDGET.maxServers).map((s) => ({
        id: s.id,
        label: s.id,
        reason: 'over_budget',
      })),
    )
    // The prompt-facing projection stays in step with what the job body carries: an agent told
    // about a server the body omits is exactly the failure this whole area exists to prevent.
    expect(result.toolServers.map((s) => s.id)).toEqual(result.mcpServers.map((s) => s.id))
  })

  it('does not resolve credentials for a server the COUNT cap has already lost', async () => {
    // The resolver is a port a facade may back with a per-workspace store or a remote read, so a
    // round trip (and a materialised secret) for a server this dispatch cannot wire is pure waste.
    // The count is decidable before resolution; only the byte cap needs the resolved spec.
    const asked: string[] = []
    const recording: ToolSecretResolver = {
      resolve: async ({ subject, keys }) => {
        asked.push(subject.id)
        return Object.fromEntries(keys.map((k) => [k.key, 'tok']))
      },
    }
    const servers = many(TOOL_SERVER_BUDGET.maxServers + 3).map((s) => ({
      ...s,
      secretKeys: [{ key: `${s.id.toUpperCase()}_TOKEN` }],
    }))
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(...servers),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: recording,
    })
    expect(asked).toEqual(servers.slice(0, TOOL_SERVER_BUDGET.maxServers).map((s) => s.id))
    expect(result.unavailableToolServers.map((s) => s.reason)).toEqual([
      'over_budget',
      'over_budget',
      'over_budget',
    ])
  })

  it('caps on BYTES too, so a few fat declarations cannot bloat the body', async () => {
    const fat = (i: number): McpServerDefinition => ({
      id: `fat${i}`,
      transport: { kind: 'stdio', command: 'npx', env: { BLOB: 'x'.repeat(12_000) } },
    })
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(fat(0), fat(1), fat(2), fat(3)),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.mcpServers.length).toBeLessThan(4)
    expect(result.unavailableToolServers.every((s) => s.reason === 'over_budget')).toBe(true)
    const bytes = new TextEncoder().encode(JSON.stringify(result.mcpServers)).length
    expect(bytes).toBeLessThanOrEqual(TOOL_SERVER_BUDGET.maxTotalBytes)
  })

  it('leaves a normal declaration untouched', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(...many(TOOL_SERVER_BUDGET.maxServers)),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.unavailableToolServers).toEqual([])
  })
})

// The platform's own configuration variables are not resolvable as a capability credential. A
// definition names BOTH the key it wants and the endpoint it ships it to, so without this a
// registered server could hand a third party the deployment's master sealing key — and in
// mothership mode that definition is authored by the mothership while the environment read is a
// developer's laptop.
describe('reserved platform credential keys', () => {
  const reservedServer = (key: string, required?: boolean): McpServerDefinition => ({
    id: 'issues',
    transport: { kind: 'stdio', command: 'issue-mcp' },
    secretKeys: [{ key, ...(required === undefined ? {} : { required }) }],
  })

  it('refuses a reserved key under its OWN reason, never `missing_secret`', async () => {
    // The two need opposite fixes: a missing secret is a variable to SET, a reserved one is a
    // declaration to CHANGE — and setting it is precisely what must not help.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(reservedServer('ENCRYPTION_KEY')),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ENCRYPTION_KEY: 'master-key' }),
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers[0]?.reason).toBe('reserved_secret')
  })

  it('never even ASKS the resolver for a reserved key', async () => {
    // The floor lives at the call site rather than inside the env-backed default, so it holds for
    // a deployment's own per-workspace resolver too — which is the one that could genuinely have
    // a value under that name.
    const asked: string[] = []
    await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(reservedServer('HARNESS_SHARED_SECRET')),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: {
        resolve: async ({ keys }) => {
          asked.push(...keys.map((k) => k.key))
          return {}
        },
      },
    })
    expect(asked).toEqual([])
  })

  it('matches case-insensitively, because `process.env` does on Windows', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(reservedServer('encryption_key')),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ encryption_key: 'master-key' }),
    })
    expect(result.unavailableToolServers[0]?.reason).toBe('reserved_secret')
  })

  it('covers a whole platform PREFIX family, not just the names spelled out', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(reservedServer('GITHUB_APP_PRIVATE_KEY')),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ GITHUB_APP_PRIVATE_KEY: 'pem' }),
    })
    expect(result.unavailableToolServers[0]?.reason).toBe('reserved_secret')
  })

  it('costs an OPTIONAL reserved key only that key, exactly as a missing one does', async () => {
    // The disposition follows the DECLARATION, so this rule adds no second way for a server to
    // disappear — only a new reason for the way that already existed.
    const definition: McpServerDefinition = {
      ...reservedServer('LOG_LEVEL', false),
      secretKeys: [{ key: 'LOG_LEVEL', required: false }, { key: 'ISSUE_TOKEN' }],
    }
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(definition),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ LOG_LEVEL: 'debug', ISSUE_TOKEN: 'tok' }),
    })
    expect(result.mcpServers).toHaveLength(1)
    expect(result.mcpServers[0]?.env).toEqual({ ISSUE_TOKEN: 'tok' })
  })
})

// A credential has two names, and only the LOOKUP one is a boundary. Splitting them is what lets
// a server keep the variable name its own client reads even when a platform prefix family covers
// it, without widening what may be read off the deployment's environment.
describe('the injection name (`envName`)', () => {
  const gitHubMcp = (secret: { key: string; envName?: string }): McpServerDefinition => ({
    id: 'github',
    transport: { kind: 'stdio', command: 'github-mcp' },
    secretKeys: [secret],
  })

  it('injects under `envName` while looking the value up under `key`', async () => {
    // The case this exists for: the GitHub MCP server's client reads
    // `GITHUB_PERSONAL_ACCESS_TOKEN`, which the `GITHUB_` family reserves even though the platform
    // reads no such variable. Renaming it is not open to the deployment, because the server's own
    // SDK reads its documented name.
    const asked: string[] = []
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(
        gitHubMcp({ key: 'ACME_GITHUB_TOKEN', envName: 'GITHUB_PERSONAL_ACCESS_TOKEN' }),
      ),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: {
        resolve: async ({ keys }) => {
          asked.push(...keys.map((k) => k.key))
          return { ACME_GITHUB_TOKEN: 'ghp_x' }
        },
      },
    })
    expect(asked).toEqual(['ACME_GITHUB_TOKEN'])
    expect(result.mcpServers[0]?.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' })
    // The redaction list follows what was actually folded in, so it names the injected variable.
    expect(result.mcpServers[0]?.secretKeys).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN'])
  })

  it('still refuses a reserved LOOKUP key, whatever it would be injected as', async () => {
    // The escape hatch must not become a way around the floor: the floor is about what may be READ
    // off the deployment's environment, which is the lookup key alone.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(gitHubMcp({ key: 'ENCRYPTION_KEY', envName: 'ACME_TOKEN' })),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ENCRYPTION_KEY: 'master-key' }),
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers[0]?.reason).toBe('reserved_secret')
  })

  it('drops a TOOLCHAIN injection name rather than reconfiguring the server’s process', async () => {
    // Registration refuses this; reaching dispatch means a definition this process never
    // boot-validated, which is the mothership case.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(gitHubMcp({ key: 'ACME_TOKEN', envName: 'PATH' })),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ACME_TOKEN: 'tok' }),
    })
    expect(result.mcpServers[0]?.env).toBeUndefined()
  })

  it('falls back to the key when no injection name is declared', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(gitHubMcp({ key: 'ACME_TOKEN' })),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ ACME_TOKEN: 'tok' }),
    })
    expect(result.mcpServers[0]?.env).toEqual({ ACME_TOKEN: 'tok' })
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

// ---------------------------------------------------------------------------
// OAuth. What matters here is the DISPOSITIONS: a granted token has to land in the job body and
// nowhere near the prompt, and each way of not getting one has to reach the agent as its own
// reason, because "no credential", "nobody connected" and "the connection stopped working" send an
// operator to three different places.
// ---------------------------------------------------------------------------

const OAUTH_SERVER: McpServerDefinition = {
  id: 'linear',
  transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
  oauth: { grant: 'authorization_code', clientId: 'cid' },
}

const tokenSource = (result: McpOAuthTokenResult): McpOAuthTokenSource => ({
  accessToken: async () => result,
})

describe('resolveToolServers with OAuth', () => {
  it('folds a granted token into the job body and never into the projection', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(OAUTH_SERVER),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolServerOAuth: tokenSource({
        status: 'ok',
        header: 'Authorization',
        value: 'Bearer live-token',
      }),
    })
    expect(result.mcpServers).toEqual([
      {
        id: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/mcp',
        headers: { Authorization: 'Bearer live-token' },
        secretKeys: ['Authorization'],
      },
    ])
    expect(result.unavailableToolServers).toEqual([])
    // The projection is copied verbatim into the agent-context telemetry snapshot.
    expect(JSON.stringify(result.toolServers)).not.toContain('live-token')
  })

  it('states an ungranted server as oauth_not_connected rather than dispatching it bare', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(OAUTH_SERVER),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolServerOAuth: tokenSource({ status: 'not_connected' }),
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers).toEqual([
      { id: 'linear', label: 'linear', reason: 'oauth_not_connected' },
    ])
  })

  it('keeps a failed token exchange apart from an absent grant', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(OAUTH_SERVER),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolServerOAuth: tokenSource({ status: 'token_failed', error: 'invalid_grant' }),
    })
    expect(result.unavailableToolServers).toEqual([
      { id: 'linear', label: 'linear', reason: 'oauth_token_failed' },
    ])
  })

  it('states the server when no grant store is wired, rather than sending an unauthenticated request', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(OAUTH_SERVER),
      harness: 'claude-code',
      workspaceId: 'ws1',
    })
    expect(result.mcpServers).toEqual([])
    expect(result.unavailableToolServers).toEqual([
      { id: 'linear', label: 'linear', reason: 'oauth_not_connected' },
    ])
  })

  it('lets the granted token win the header a static credential also names', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith({
        ...OAUTH_SERVER,
        secretKeys: [{ key: 'LEGACY_TOKEN', header: 'Authorization' }],
      }),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ LEGACY_TOKEN: 'stale' }),
      resolveToolServerOAuth: tokenSource({
        status: 'ok',
        header: 'Authorization',
        value: 'Bearer live-token',
      }),
    })
    expect(result.mcpServers[0]?.headers).toEqual({ Authorization: 'Bearer live-token' })
  })

  it('does not consult the token source for a server that declares no OAuth', async () => {
    let asked = false
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(HTTP),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'abc' }),
      resolveToolServerOAuth: {
        accessToken: async () => {
          asked = true
          return { status: 'not_connected' }
        },
      },
    })
    expect(asked).toBe(false)
    expect(result.mcpServers).toHaveLength(1)
  })
})

describe('the OAuth header and a static credential naming it', () => {
  // Boot validation WARNS about this collision and says the granted token wins. A plain object
  // spread would only make that true when the two spellings match byte for byte, so a declaration
  // pairing lowercase `authorization` with the default `Authorization` would ship BOTH headers and
  // the stated resolution would silently not have happened.
  const collidingCase: McpServerDefinition = {
    id: 'linear',
    transport: { kind: 'http', url: 'https://mcp.linear.app/mcp' },
    oauth: { grant: 'authorization_code', clientId: 'cid' },
    secretKeys: [{ key: 'LINEAR_TOKEN', header: 'authorization' }],
  }

  it('lets the granted token win over a static credential spelled in another case', async () => {
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith(collidingCase),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ LINEAR_TOKEN: 'static-token' }),
      resolveToolServerOAuth: tokenSource({
        status: 'ok',
        header: 'Authorization',
        value: 'Bearer live-token',
      }),
    })

    const headers = result.mcpServers[0]?.headers ?? {}
    expect(Object.keys(headers)).toEqual(['Authorization'])
    expect(headers).toEqual({ Authorization: 'Bearer live-token' })
    expect(JSON.stringify(headers)).not.toContain('static-token')
  })

  it('lets a resolved credential win over the declaration’s own header in another case', async () => {
    // The same rule one layer down: `transport.headers` is the declaration's static half, and a
    // credential resolved for the same header must replace it rather than travel beside it.
    const result = await resolveToolServers({
      context: context(),
      agentKindRegistry: registryWith({
        id: 'docs',
        transport: {
          kind: 'http',
          url: 'https://docs.example.com/mcp',
          headers: { 'X-Api-Key': 'placeholder' },
        },
        secretKeys: [{ key: 'DOCS_TOKEN', header: 'x-api-key' }],
      }),
      harness: 'claude-code',
      workspaceId: 'ws1',
      resolveToolSecrets: resolver({ DOCS_TOKEN: 'resolved' }),
    })

    expect(result.mcpServers[0]?.headers).toEqual({ 'x-api-key': 'resolved' })
  })
})
