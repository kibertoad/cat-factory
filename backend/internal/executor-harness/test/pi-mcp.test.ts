import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type McpServerSpec, piLiteralValue, piMcpConfig } from '../src/agent-capabilities.js'
import { createPiAgentDir, type PiAgentDir } from '../src/pi-agent-dir.js'
import { writePiMcpConfig } from '../src/pi-mcp.js'
import { redactSecrets } from '../src/redact.js'

// Pi's tool-server config. Three properties carry it, each pinned here: no value reaches Pi as a
// command or a variable reference (Pi runs a value starting with `!` and interpolates `$NAME`), a
// narrowed server is ENFORCED through exposure rather than merely stated, and the file lands in
// the pass's own config directory, owner-only.

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
  headers: { Authorization: 'Bearer a$b${HOME}' },
  allowedTools: ['search_docs', 'get_page'],
  secretKeys: ['Authorization'],
}

/**
 * Pi's resolution of a config value, restated from its documented rules (`docs/mcp.md` and
 * `resolve-config-value`): a leading `!` is a command, `$$` / `$!` are literal `$` / `!`, and any
 * other `$NAME` / `${NAME}` is an environment reference. Returns undefined for a command or a
 * reference, since the point of the escaping is that neither can occur.
 */
function piResolve(value: string): string | undefined {
  if (value.startsWith('!')) return undefined
  let out = ''
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '$') {
      out += value[i]
      continue
    }
    const next = value[i + 1]
    if (next === '$' || next === '!') {
      out += next
      i++
      continue
    }
    if (next !== undefined && /[A-Za-z_{]/.test(next)) return undefined
    out += '$'
  }
  return out
}

describe('piLiteralValue', () => {
  it.each(['!rm -rf ~', 'a$b${HOME}', '$!x', '!$X', 'plain', '', '$', 'ends with $'])(
    'round-trips %j through Pi as the same literal string',
    (value) => {
      expect(piResolve(piLiteralValue(value))).toBe(value)
    },
  )
})

describe('piMcpConfig', () => {
  it('writes every env and header value as a literal Pi cannot run or interpolate', () => {
    const document = piMcpConfig([STDIO, HTTP])
    const stdio = document.mcpServers.issues as { env: Record<string, string> }
    const http = document.mcpServers.docs as { headers: Record<string, string> }
    expect(stdio.env).toEqual({ ISSUE_TOKEN: '$!rm -rf ~', REGION: 'eu' })
    expect(http.headers).toEqual({ Authorization: 'Bearer a$$b$${HOME}' })
    for (const value of [...Object.values(stdio.env), ...Object.values(http.headers)]) {
      expect(piResolve(value)).toBeDefined()
    }
  })

  it('keeps command and args literal, since Pi interpolates neither', () => {
    expect(piMcpConfig([STDIO]).mcpServers.issues).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'issue-mcp'],
    })
  })

  it('declares an unnarrowed server directly and ENFORCES a narrowed one through exposure', () => {
    const { mcpServers } = piMcpConfig([STDIO, HTTP])
    expect(mcpServers.issues).toMatchObject({ exposure: 'direct' })
    expect(mcpServers.issues).not.toHaveProperty('toolExposure')
    expect(mcpServers.docs).toMatchObject({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      exposure: 'hidden',
      toolExposure: { search_docs: 'direct', get_page: 'direct' },
    })
  })

  it('keeps codemode off, because nothing is exposed through it', () => {
    expect(piMcpConfig([STDIO]).autoEnableCodemode).toBe(false)
  })
})

describe('writePiMcpConfig', () => {
  let dir: PiAgentDir

  beforeEach(async () => {
    dir = await createPiAgentDir()
  })

  afterEach(async () => {
    await dir.dispose()
  })

  const configPath = () => join(dir.path, 'mcp.json')

  it("writes an owner-only mcp.json into the pass's own Pi config dir", async () => {
    await writePiMcpConfig(dir.path, [STDIO])
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual(piMcpConfig([STDIO]))
    expect((await stat(configPath())).mode & 0o077).toBe(0)
  })

  it('registers the marked credential values for redaction, and only those', async () => {
    await writePiMcpConfig(dir.path, [STDIO])
    expect(redactSecrets('token=!rm -rf ~')).not.toContain('!rm -rf ~')
    expect(redactSecrets('region=eu')).toContain('eu')
  })

  it('writes nothing when the pass wires no server', async () => {
    await writePiMcpConfig(dir.path, undefined)
    await writePiMcpConfig(dir.path, [])
    await expect(stat(configPath())).rejects.toThrow()
  })
})
