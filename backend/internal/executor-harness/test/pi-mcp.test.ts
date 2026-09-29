import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type McpServerSpec, piMcpConfig } from '../src/agent-capabilities.js'
import { writePiMcpConfig } from '../src/pi-mcp.js'
import { redactSecrets } from '../src/redact.js'

// Pi's tool-server config. Three properties carry it, each pinned here: no value reaches the file
// literally (Pi runs a value starting with `!` as a shell command), a narrowed server is ENFORCED
// through exposure rather than merely stated, and a pass with nothing to wire removes the previous
// job's file from the reused home.

const STDIO: McpServerSpec = {
  id: 'issues',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'issue-mcp'],
  env: { ISSUE_TOKEN: '!rm -rf ~', REGION: 'eu' },
  secretKeys: ['ISSUE_TOKEN'],
}

const HTTP: McpServerSpec = {
  id: 'docs',
  transport: 'http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer abc' },
  allowedTools: ['search_docs', 'get_page'],
  secretKeys: ['Authorization'],
}

describe('piMcpConfig', () => {
  it('names every env and header value by placeholder and resolves each from the child env', () => {
    const { document, env } = piMcpConfig([STDIO, HTTP])
    const stdio = document.mcpServers.issues as { env: Record<string, string> }
    const http = document.mcpServers.docs as { headers: Record<string, string> }

    // Every value, the plain configuration too: a literal is what Pi would read as `!command`.
    for (const value of [...Object.values(stdio.env), ...Object.values(http.headers)]) {
      expect(value).toMatch(/^\$\{CAT_FACTORY_MCP_\d+_\d+\}$/)
    }
    const resolve = (placeholder: string) => env[placeholder.slice(2, -1)]
    expect(resolve(stdio.env.ISSUE_TOKEN!)).toBe('!rm -rf ~')
    expect(resolve(stdio.env.REGION!)).toBe('eu')
    expect(resolve(http.headers.Authorization!)).toBe('Bearer abc')
    // One variable per value, so two servers can never share (and clobber) a name.
    expect(Object.keys(env)).toHaveLength(3)
    expect(JSON.stringify(document)).not.toContain('Bearer abc')
  })

  it('keeps command and args literal, since Pi interpolates neither', () => {
    const { document } = piMcpConfig([STDIO])
    expect(document.mcpServers.issues).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'issue-mcp'],
    })
  })

  it('declares an unnarrowed server directly and ENFORCES a narrowed one through exposure', () => {
    const { document } = piMcpConfig([STDIO, HTTP])
    expect(document.mcpServers.issues).toMatchObject({ exposure: 'direct' })
    expect(document.mcpServers.issues).not.toHaveProperty('toolExposure')
    expect(document.mcpServers.docs).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      exposure: 'hidden',
      toolExposure: { search_docs: 'direct', get_page: 'direct' },
    })
  })

  it('keeps codemode off, because nothing is exposed through it', () => {
    expect(piMcpConfig([STDIO]).document.autoEnableCodemode).toBe(false)
  })
})

describe('writePiMcpConfig', () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'cf-pi-mcp-'))
    // `os.homedir()` reads HOME on POSIX and USERPROFILE on Windows.
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const configPath = () => join(home, '.pi', 'agent', 'mcp.json')

  it('writes an owner-only mcp.json into Pi config dir and returns the placeholder env', async () => {
    const env = await writePiMcpConfig([STDIO])
    const written = JSON.parse(await readFile(configPath(), 'utf8'))
    expect(written).toEqual(piMcpConfig([STDIO]).document)
    expect(Object.values(env)).toEqual(['!rm -rf ~', 'eu'])
    expect((await stat(configPath())).mode & 0o077).toBe(0)
  })

  it('registers the marked credential values for redaction, and only those', async () => {
    await writePiMcpConfig([STDIO])
    expect(redactSecrets('token=!rm -rf ~')).not.toContain('!rm -rf ~')
    expect(redactSecrets('region=eu')).toContain('eu')
  })

  it("removes a previous job's file when this pass wires nothing", async () => {
    // A warm-pool container reuses the home, so a file left behind would start the previous
    // job's servers with every placeholder resolving to nothing.
    await mkdir(join(home, '.pi', 'agent'), { recursive: true })
    await writeFile(configPath(), '{"mcpServers":{"stale":{"command":"x"}}}')
    expect(await writePiMcpConfig(undefined)).toEqual({})
    await expect(stat(configPath())).rejects.toThrow()
    // And a pass with nothing to remove is not an error either.
    expect(await writePiMcpConfig([])).toEqual({})
  })
})
