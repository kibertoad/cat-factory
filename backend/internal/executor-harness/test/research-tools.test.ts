import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMcpMessage } from '../src/research/mcp-stdio.js'
import { parseResearchJob } from '../src/research/research-job.js'
import { researchTools } from '../src/research/research-tools-server.js'
import {
  applyAuth,
  credentialSecrets,
  isTargetOrigin,
  scrub,
  targetOrigins,
} from '../src/research/research-tools.logic.js'

const TARGETS = [
  { baseUrl: 'https://api.vendor.example/v2', surface: 'api' as const },
  { baseUrl: 'https://app.vendor.example', surface: 'ui' as const },
]

describe('research tool rules', () => {
  it('admits only the target origins, whatever the path', () => {
    const origins = targetOrigins(TARGETS)
    expect(isTargetOrigin('https://api.vendor.example/other/path', origins)).toBe(true)
    expect(isTargetOrigin('https://evil.example/api.vendor.example', origins)).toBe(false)
    expect(isTargetOrigin('http://api.vendor.example', origins)).toBe(false)
    expect(isTargetOrigin('not a url', origins)).toBe(false)
  })

  it('attaches a credential by scheme', () => {
    expect(applyAuth('https://x.example', {}, { scheme: 'bearer' }, 'tok').headers).toEqual({
      authorization: 'Bearer tok',
    })
    expect(
      applyAuth('https://x.example', {}, { scheme: 'basic' }, '{"username":"u","password":"p"}')
        .headers.authorization,
    ).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`)
    expect(
      applyAuth('https://x.example', {}, { scheme: 'header', name: 'x-key' }, 'k').headers,
    ).toEqual({
      'x-key': 'k',
    })
    expect(applyAuth('https://x.example/a', {}, { scheme: 'query', name: 'key' }, 'k').url).toBe(
      'https://x.example/a?key=k',
    )
  })

  it('scrubs known secrets and token shapes the run never knew', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl'
    const text = `secret=hunter22 jwt=${jwt} {"access_token":"abcdefgh12345"} Bearer abcdefghijklmnop`
    const out = scrub(text, ['hunter22'])
    expect(out).not.toContain('hunter22')
    expect(out).not.toContain(jwt)
    expect(out).not.toContain('abcdefgh12345')
    expect(out).not.toContain('abcdefghijklmnop')
  })

  it("collects a login's password and an OAuth client's secret for redaction", () => {
    expect(
      credentialSecrets([
        { key: 'L', kind: 'login', value: '{"username":"user","password":"pass-word"}' },
        {
          key: 'O',
          kind: 'oauth-client',
          value: '{"tokenUrl":"https://t.example","clientId":"id","clientSecret":"client-secret"}',
        },
      ]),
    ).toEqual(expect.arrayContaining(['pass-word', 'client-secret']))
  })
})

describe('the MCP stdio loop', () => {
  const server = {
    name: 'test',
    version: '1',
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    call: async (_name: string, args: Record<string, unknown>) => ({ text: String(args.text) }),
  }

  it('initializes, lists and calls tools, and stays silent on notifications', async () => {
    expect(
      await handleMcpMessage(server, {
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 'v' },
      }),
    ).toMatchObject({ result: { protocolVersion: 'v', capabilities: { tools: {} } } })
    expect(await handleMcpMessage(server, { id: 2, method: 'tools/list' })).toMatchObject({
      result: { tools: [{ name: 'echo' }] },
    })
    expect(
      await handleMcpMessage(server, {
        id: 3,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      }),
    ).toMatchObject({ result: { content: [{ type: 'text', text: 'hi' }] } })
    expect(await handleMcpMessage(server, { method: 'notifications/initialized' })).toBeNull()
    expect(
      await handleMcpMessage(server, { id: 4, method: 'tools/call', params: { name: 'nope' } }),
    ).toMatchObject({ error: { code: -32602 } })
  })
})

describe('the research tool server', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'research-tools-test-'))
  })
  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  function tools() {
    return researchTools({
      targets: TARGETS,
      credentials: [{ key: 'VENDOR_TOKEN', kind: 'api-token', value: 'sk-live-secret-123' }],
      evidenceDir: dir,
      credentialRequestFile: join(dir, 'request.json'),
    })
  }

  it('refuses a request to an origin that is not a target, sending nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await tools().call('http_request', {
      url: 'https://evil.example/collect',
      auth: { credentialKey: 'VENDOR_TOKEN', scheme: 'bearer' },
    })
    expect(result.isError).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('attaches the credential, scrubs it from the response and records the exchange', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{"echo":"sk-live-secret-123"}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const result = await tools().call('http_request', {
      url: 'https://api.vendor.example/v2/items',
      auth: { credentialKey: 'VENDOR_TOKEN', scheme: 'bearer' },
    })
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer sk-live-secret-123' },
    })
    expect(result.text).toContain('evidence ref: http-1')
    expect(result.text).not.toContain('sk-live-secret-123')
    const recorded = await readFile(join(dir, 'http-1.json'), 'utf8')
    expect(recorded).not.toContain('sk-live-secret-123')
    expect(JSON.parse(recorded).request.headers.authorization).toBeUndefined()
  })

  it('records a credential request for the run to wait on', async () => {
    await tools().call('request_credential', {
      credentialKey: 'VENDOR_OAUTH',
      reason: 'The partner API needs an OAuth client',
      observed: 'Created under Settings > API',
    })
    expect(JSON.parse(await readFile(join(dir, 'request.json'), 'utf8'))).toEqual({
      key: 'VENDOR_OAUTH',
      reason: 'The partner API needs an OAuth client',
      observed: 'Created under Settings > API',
    })
  })

  it('refuses to type a credential when no browser is available', async () => {
    const result = await tools().call('fill_secret', {
      credentialKey: 'VENDOR_TOKEN',
      field: 'value',
      label: 'API key',
    })
    expect(result.isError).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })
})

describe('parseResearchJob', () => {
  const body = {
    jobId: 'job_1',
    model: 'm',
    systemPrompt: 's',
    userPrompt: 'u',
    harness: 'claude-code',
    subscriptionToken: 't',
    research: {
      targets: [{ baseUrl: 'https://api.vendor.example', surface: 'api' }],
      credentials: [{ key: 'K', kind: 'api-token', value: 'v' }],
      browser: true,
    },
  }

  it('parses a research job with no repository', () => {
    expect(parseResearchJob(body).research).toEqual(body.research)
  })

  it('refuses a non-https target, an unknown credential kind and no targets', () => {
    const with_ = (research: unknown) => ({ ...body, research })
    expect(() =>
      parseResearchJob(
        with_({ ...body.research, targets: [{ baseUrl: 'http://x.example', surface: 'api' }] }),
      ),
    ).toThrow(/https/)
    expect(() =>
      parseResearchJob(
        with_({ ...body.research, credentials: [{ key: 'K', kind: 'magic', value: 'v' }] }),
      ),
    ).toThrow(/kind/)
    expect(() => parseResearchJob(with_({ ...body.research, targets: [] }))).toThrow(/empty/)
  })
})
