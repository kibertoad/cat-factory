import { describe, expect, it } from 'vitest'
import type { HarnessKind } from '../ports/model-provider.js'
import type { McpServerDefinition } from './agent-capabilities.js'
import {
  MCP_HARNESS_TRANSPORTS,
  MCP_SUPPORTED_HARNESSES,
  TOOL_SERVER_BUDGET,
  isValidMcpToolName,
  mcpHarnessServesTransport,
  mcpServableHarnesses,
  mcpServerSupportsHarness,
  toolServerDeclaredBytes,
} from './agent-capabilities.js'

// The pure rules deciding whether a declared tool server can run at all. They exist here, in
// kernel, because THREE layers must agree about the answer: the dispatch (which drops a server it
// cannot serve, with a stated reason), boot validation (which warns about a combination no run could
// ever serve), and the harness (which writes each CLI's config).

const HARNESSES: HarnessKind[] = ['pi', 'claude-code', 'codex']

function server(over: Partial<McpServerDefinition> = {}): McpServerDefinition {
  return {
    id: 'issues',
    transport: { kind: 'stdio', command: 'npx' },
    ...over,
  }
}

const httpServer = (over: Partial<McpServerDefinition> = {}): McpServerDefinition =>
  server({ transport: { kind: 'http', url: 'https://mcp.example.com/mcp' }, ...over })

describe('MCP_HARNESS_TRANSPORTS', () => {
  it('answers for EVERY harness, so a new one cannot silently mean "no tool servers"', () => {
    for (const harness of HARNESSES) {
      expect(MCP_HARNESS_TRANSPORTS[harness], harness).toBeDefined()
    }
  })

  it('states the two facts the whole slice turns on', () => {
    // Pi has no MCP client; Codex's is stdio-only. Everything else here derives from these.
    expect(MCP_HARNESS_TRANSPORTS.pi).toEqual([])
    expect(MCP_HARNESS_TRANSPORTS.codex).toEqual(['stdio'])
    expect(MCP_HARNESS_TRANSPORTS['claude-code']).toEqual(['stdio', 'http'])
  })

  it('derives MCP_SUPPORTED_HARNESSES, so the two cannot drift into disagreeing', () => {
    expect(MCP_SUPPORTED_HARNESSES).toEqual(['claude-code', 'codex'])
    for (const harness of HARNESSES) {
      expect(MCP_SUPPORTED_HARNESSES.includes(harness), harness).toBe(
        MCP_HARNESS_TRANSPORTS[harness].length > 0,
      )
    }
  })
})

describe('mcpHarnessServesTransport', () => {
  it('refuses http on codex — the defect this rule was added for', () => {
    // Before this, `servableOnThisRun` checked harness membership only: an http server was
    // advertised in a Codex run's prompt ("prefer them over guessing") and then skipped by the
    // harness's stdio-only TOML writer, so the agent planned around a tool it never had.
    expect(mcpHarnessServesTransport('codex', 'http')).toBe(false)
    expect(mcpHarnessServesTransport('codex', 'stdio')).toBe(true)
    expect(mcpHarnessServesTransport('claude-code', 'http')).toBe(true)
  })

  it('refuses everything on pi, which has no MCP client', () => {
    expect(mcpHarnessServesTransport('pi', 'stdio')).toBe(false)
    expect(mcpHarnessServesTransport('pi', 'http')).toBe(false)
  })
})

describe('mcpServerSupportsHarness', () => {
  it('defaults to every MCP-speaking harness and lets a definition NARROW it', () => {
    expect(mcpServerSupportsHarness(server(), 'claude-code')).toBe(true)
    expect(mcpServerSupportsHarness(server(), 'codex')).toBe(true)
    expect(mcpServerSupportsHarness(server({ harnesses: ['claude-code'] }), 'codex')).toBe(false)
  })

  it('cannot be WIDENED onto a harness with no MCP client', () => {
    // A registration cannot teach Pi an MCP client, so naming it is inert rather than enabling.
    expect(mcpServerSupportsHarness(server({ harnesses: ['pi'] }), 'pi')).toBe(false)
  })
})

describe('mcpServableHarnesses', () => {
  it('intersects the declared allow-list with the harnesses that reach the transport', () => {
    expect(mcpServableHarnesses(server())).toEqual(['claude-code', 'codex'])
    // An http server is claude-code only, WITHOUT the definition having to say so.
    expect(mcpServableHarnesses(httpServer())).toEqual(['claude-code'])
    expect(mcpServableHarnesses(server({ harnesses: ['codex'] }))).toEqual(['codex'])
  })

  it('is EMPTY exactly for the combinations no run could ever serve', () => {
    // This is the boot-warning trigger: nothing is ever dropped for a reason here, because the
    // server simply never applies — so no prompt and no log line would ever mention it.
    expect(mcpServableHarnesses(httpServer({ harnesses: ['codex'] }))).toEqual([])
    expect(mcpServableHarnesses(server({ harnesses: ['pi'] }))).toEqual([])
    expect(mcpServableHarnesses(server({ harnesses: [] }))).toEqual([])
  })
})

// The measure boot validation warns on. It exists because the dispatch measures the RESOLVED spec,
// which nothing before a run can see, and "no measure at all" is what left the byte half of the
// budget with no declaration-time channel while the count half had one.
describe('toolServerDeclaredBytes', () => {
  it('counts the transport config, so a fat env block is visible before any run', () => {
    const lean = toolServerDeclaredBytes(server())
    const fat = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { BLOB: 'x'.repeat(5_000) } } }),
    )
    expect(lean).toBeLessThan(200)
    expect(fat).toBeGreaterThan(5_000)
  })

  it('is a FLOOR: it ignores what stays behind and what a dispatch only adds', () => {
    // `label` / `guidance` go to the prompt and `secretKeys` becomes resolved VALUES, which only
    // grow the body. Counting the first two would let boot warn about a payload no dispatch sends.
    const bare = toolServerDeclaredBytes(server())
    const decorated = toolServerDeclaredBytes(
      server({
        label: 'Issue tracker',
        guidance: 'Look up an issue before guessing at its intent.',
        secretKeys: [{ key: 'ISSUE_TOKEN' }],
      }),
    )
    expect(decorated).toBe(bare)
  })

  it('counts BYTES, not UTF-16 units, so a non-ASCII config value is not undercounted', () => {
    // Kernel compiles against neither DOM nor Node types, so this is a hand-counted UTF-8 length.
    // `string.length` would read a CJK env value as a third of its real size, which would break the
    // floor the boot warning depends on.
    const ascii = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { NOTE: 'aaa' } } }),
    )
    const cjk = toolServerDeclaredBytes(
      server({ transport: { kind: 'stdio', command: 'npx', env: { NOTE: '課題管理' } } }),
    )
    // Four 3-byte characters where the ASCII case had three 1-byte ones.
    expect(cjk - ascii).toBe(9)
  })

  it('measures an http server by its url and headers', () => {
    expect(toolServerDeclaredBytes(httpServer())).toBeGreaterThan(0)
    expect(
      toolServerDeclaredBytes(
        httpServer({ transport: { kind: 'http', url: 'https://mcp.example.com/mcp' } }),
      ),
    ).toBeLessThan(TOOL_SERVER_BUDGET.maxTotalBytes)
  })
})

describe('isValidMcpToolName', () => {
  it('refuses a comma, because the harness joins the allow-list with commas', () => {
    // One entry carrying a comma becomes two `--allowedTools` patterns, the second of which
    // matches no tool the CLI has — while the prompt goes on advertising the name verbatim.
    expect(isValidMcpToolName('search_issues,get_issue')).toBe(false)
    expect(isValidMcpToolName('search_issues')).toBe(true)
  })

  it('refuses whitespace and shell/glob punctuation', () => {
    for (const bad of ['search issues', ' search', 'search\n', 'search*', 'mcp__x__y!', '']) {
      expect(isValidMcpToolName(bad), bad).toBe(false)
    }
  })

  it('accepts the character set real MCP tool names use', () => {
    for (const good of ['search_issues', 'get-issue', 'issues.search', 'v2_search1']) {
      expect(isValidMcpToolName(good), good).toBe(true)
    }
  })
})
