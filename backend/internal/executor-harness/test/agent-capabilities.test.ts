import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeAllowedToolPatterns,
  claudeMcpConfig,
  codexMcpConfigToml,
  writeClaudeMcpConfig,
  type McpServerSpec,
} from '../src/agent-capabilities.js'

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
    // Sending `--allowedTools` at all switches the CLI into allow-list mode for EVERY tool, which
    // would strip the agent of its built-in file/bash tools and leave it unable to do the work.
    expect(claudeAllowedToolPatterns([STDIO, HTTP])).toBeUndefined()
  })

  it('narrows only where asked, keeping unrestricted servers whole', () => {
    expect(
      claudeAllowedToolPatterns([{ ...STDIO, allowedTools: ['search_issues', 'get_issue'] }, HTTP]),
    ).toEqual(['mcp__issues__search_issues', 'mcp__issues__get_issue', 'mcp__docs'])
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
