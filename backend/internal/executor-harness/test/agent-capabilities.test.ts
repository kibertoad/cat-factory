import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeAllowedToolPatterns,
  claudeMcpConfig,
  codexMcpConfigToml,
  mcpServerSecretValues,
  parseMcpServerSpecs,
  writeClaudeMcpConfig,
  type McpServerSpec,
} from '../src/agent-capabilities.js'
import { claudeRequestedTools } from '../src/claude-cli.js'

/** The built-ins a run with web research declares, which the allow-list has to carry with it. */
const BUILT_INS = claudeRequestedTools(true)

// The tool-server (MCP) config writers. Each CLI reads a different format, so these pin the two
// shapes plus the two rules that are easy to get subtly wrong: when an allow-list may be sent at
// all, and what Codex (stdio-only) does with an HTTP server.

const STDIO: McpServerSpec = {
  id: 'issues',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'issue-mcp'],
  env: { ISSUE_TOKEN: 'tok' },
}

const HTTP: McpServerSpec = {
  id: 'docs',
  transport: 'http',
  url: 'https://mcp.example.com/sse',
  headers: { Authorization: 'Bearer abc' },
}

describe('claudeMcpConfig', () => {
  it('renders both transports under the CLI’s mcpServers map', () => {
    expect(claudeMcpConfig([STDIO, HTTP])).toEqual({
      mcpServers: {
        issues: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'issue-mcp'],
          env: { ISSUE_TOKEN: 'tok' },
        },
        docs: {
          type: 'http',
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: 'Bearer abc' },
        },
      },
    })
  })
})

describe('claudeAllowedToolPatterns', () => {
  it('returns nothing when NO server restricts its tools', () => {
    // Nothing to narrow ⇒ the safest allow-list is the one we never send.
    expect(claudeAllowedToolPatterns([STDIO, HTTP], BUILT_INS)).toBeUndefined()
  })

  it('narrows only where asked, keeping unrestricted servers whole', () => {
    expect(
      claudeAllowedToolPatterns(
        [{ ...STDIO, allowedTools: ['search_issues', 'get_issue'] }, HTTP],
        BUILT_INS,
      ),
    ).toEqual(['mcp__issues__search_issues', 'mcp__issues__get_issue', 'mcp__docs', ...BUILT_INS])
  })

  it('always carries the CLI’s built-in tools alongside the MCP patterns', () => {
    // An allow-list is WHOLE-SESSION, not MCP-scoped: it does not confine itself to `mcp__*` just
    // because every entry we generate looks like one. Omitting the built-ins would hand the run a
    // narrowed MCP surface and no way to read, edit or build anything — the agent would be unable
    // to do the work, far from the registration that narrowed a tool.
    const patterns = claudeAllowedToolPatterns(
      [{ ...STDIO, allowedTools: ['search_issues'] }],
      BUILT_INS,
    )
    for (const builtIn of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
      expect(patterns).toContain(builtIn)
    }
  })

  it('carries exactly the run’s OWN declared set, so it can never re-grant what --tools withheld', () => {
    // The list is ADDITIVE, not a re-grant: a name in it UNLOCKS the tool. So a run declared
    // without the web tools must not get them back through the one entry an unrelated tool-server
    // registration happens to send.
    const withoutWeb = claudeRequestedTools(false)
    const patterns = claudeAllowedToolPatterns(
      [{ ...STDIO, allowedTools: ['search_issues'] }],
      withoutWeb,
    )
    expect(patterns).not.toContain('WebSearch')
    expect(patterns).not.toContain('WebFetch')
    expect(patterns).toContain('Grep')
  })
})

describe('parseMcpServerSpecs (transport boundary)', () => {
  const httpBody = (url: string) => [{ id: 'docs', transport: 'http', url }]

  it('accepts https anywhere and plain http only on loopback', () => {
    expect(parseMcpServerSpecs(httpBody('https://mcp.example.com/sse'))).toHaveLength(1)
    expect(parseMcpServerSpecs(httpBody('http://127.0.0.1:3000/mcp'))).toHaveLength(1)
    // A resolved credential rides an HTTP server as a request header, so cleartext off loopback is
    // refused HERE too — not only at registration, which a body arriving by another route skips.
    expect(parseMcpServerSpecs(httpBody('http://mcp.example.com/sse'))).toBeUndefined()
  })

  it('refuses a non-http(s) scheme the CLI would otherwise be pointed at', () => {
    expect(parseMcpServerSpecs(httpBody('file:///etc/passwd'))).toBeUndefined()
    expect(parseMcpServerSpecs(httpBody('ws://mcp.example.com/sse'))).toBeUndefined()
  })
})

describe('parseMcpServerSpecs (allowedTools boundary)', () => {
  const body = (allowedTools: unknown) => [
    { id: 'issues', transport: 'stdio', command: 'npx', allowedTools },
  ]

  it('drops an entry that packs several tools into one comma-joined string', () => {
    // The runner joins the whole list into ONE `--allowedTools` argument with commas, so this entry
    // would become two patterns of which the second matches no tool the CLI has. The backend
    // refuses it at registration; this is the boundary check for a body that arrived another way.
    expect(parseMcpServerSpecs(body(['search_issues,get_issue', 'list_issues']))?.[0]).toEqual({
      id: 'issues',
      transport: 'stdio',
      command: 'npx',
      allowedTools: ['list_issues'],
    })
  })

  it('drops whitespace and glob punctuation, keeping real tool names', () => {
    expect(
      parseMcpServerSpecs(body(['search issues', 'get_*', '', 'search_issues']))?.[0]?.allowedTools,
    ).toEqual(['search_issues'])
  })

  it('falls back to NO restriction when nothing in the list survives', () => {
    // Deliberately the same answer as an absent field (every tool the server exposes), because the
    // alternative is worse: `claudeAllowedToolPatterns` would then send a list whose only surviving
    // entries are the platform's built-in tool names, i.e. a run narrowed to no MCP tools at all.
    expect(parseMcpServerSpecs(body(['a,b', 'c d']))?.[0]?.allowedTools).toBeUndefined()
  })
})

describe('mcpServerSecretValues', () => {
  it('reads exactly the keys the backend marked secret, across both transports', () => {
    expect(
      mcpServerSecretValues([
        { ...STDIO, env: { ISSUE_TOKEN: 'tok-abcdef', NODE_ENV: 'production' } },
        { ...HTTP, headers: { Authorization: 'Bearer abc', 'X-Trace': 'on' } },
      ]),
    ).toEqual([])

    expect(
      mcpServerSecretValues([
        {
          ...STDIO,
          env: { ISSUE_TOKEN: 'tok-abcdef', NODE_ENV: 'production' },
          secretKeys: ['ISSUE_TOKEN'],
        },
        {
          ...HTTP,
          headers: { Authorization: 'Bearer abc', 'X-Trace': 'on' },
          secretKeys: ['Authorization'],
        },
      ]),
    ).toEqual(['tok-abcdef', 'Bearer abc'])
  })

  it('leaves declared configuration alone', () => {
    // Redacting the whole env/headers map would turn every later "production" in a log line into
    // `***`. The marked-key list is what keeps redaction precise.
    const values = mcpServerSecretValues([
      {
        ...STDIO,
        env: { ISSUE_TOKEN: 'tok-abcdef', NODE_ENV: 'production' },
        secretKeys: ['ISSUE_TOKEN'],
      },
    ])
    expect(values).not.toContain('production')
  })
})

describe('codexMcpConfigToml', () => {
  it('renders a stdio server as a [mcp_servers.<id>] table with escaped strings', () => {
    const toml = codexMcpConfigToml([{ ...STDIO, args: ['-y', 'a"b'] }])
    expect(toml).toContain('[mcp_servers.issues]')
    expect(toml).toContain('command = "npx"')
    expect(toml).toContain('args = ["-y", "a\\"b"]')
    expect(toml).toContain('env = { "ISSUE_TOKEN" = "tok" }')
  })

  it('skips an http server rather than emitting a config Codex cannot use', () => {
    // Codex's MCP client is stdio-only; a deployment that wires an HTTP server for it gets a
    // no-op instead of a malformed config that fails deep inside the CLI.
    expect(codexMcpConfigToml([HTTP])).toBe('')
  })
})

describe('writeClaudeMcpConfig', () => {
  it('writes an owner-only config into the given per-run dir and returns its path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-mcp-test-'))
    const path = await writeClaudeMcpConfig(dir, [STDIO])
    expect(path).toBe(join(dir, 'mcp-servers.json'))
    expect(JSON.parse(await readFile(path!, 'utf8'))).toEqual(claudeMcpConfig([STDIO]))
    // The file carries this job's resolved credentials, so it must not be world-readable.
    expect((await stat(path!)).mode & 0o077).toBe(0)
  })

  it('writes nothing when there are no servers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-mcp-test-'))
    expect(await writeClaudeMcpConfig(dir, [])).toBeUndefined()
  })
})
