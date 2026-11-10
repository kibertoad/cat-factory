import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleMcpMessage } from '../src/project/mcp-protocol.js'
import { parseProjectJob } from '../src/project/project-job.js'
import { forwardMcpLine } from '../src/project/access-tools-proxy.js'
import { accessTools, startAccessToolsHost } from '../src/project/access-tools-server.js'
import {
  applyAuth,
  credentialSecrets,
  isTargetOrigin,
  scrub,
  targetOrigins,
} from '../src/project/access-tools.logic.js'

const TARGETS = [
  { baseUrl: 'https://api.vendor.example/v2', surface: 'api' as const },
  { baseUrl: 'https://app.vendor.example', surface: 'ui' as const },
]

describe('access tool rules', () => {
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

describe('the MCP protocol', () => {
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

describe('the access tool server', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function tools() {
    return accessTools({
      targets: TARGETS,
      credentials: [
        { key: 'VENDOR_TOKEN', kind: 'api-token', value: 'sk-live-secret-123' },
        { key: 'VENDOR_LOGIN', kind: 'login', value: '{"username":"me","password":"pass-word"}' },
      ],
    })
  }

  it('refuses a request to an origin that is not a target, sending nothing', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await tools().definition.call('http_request', {
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
    const access = tools()
    const result = await access.definition.call('http_request', {
      url: 'https://api.vendor.example/v2/items',
      auth: { credentialKey: 'VENDOR_TOKEN', scheme: 'bearer' },
    })
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: 'Bearer sk-live-secret-123' },
    })
    expect(result.text).toContain('evidence ref: http-1')
    expect(result.text).not.toContain('sk-live-secret-123')
    const { httpExchanges } = access.recorded()
    expect(httpExchanges.map((e) => e.ref)).toEqual(['http-1'])
    expect(JSON.stringify(httpExchanges)).not.toContain('sk-live-secret-123')
    expect(httpExchanges[0]?.exchange.request.headers.authorization).toBeUndefined()
  })

  it('hands a redirect back instead of following it with the credential attached', async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const result = await tools().definition.call('http_request', {
      url: 'https://api.vendor.example/v2/items',
      auth: { credentialKey: 'VENDOR_TOKEN', scheme: 'header', name: 'x-api-key' },
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' })
    expect(result.text).toContain('HTTP 302')
    expect(result.text).toContain('location: https://evil.example/steal')
  })

  it('shows a session cookie by name only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('ok', {
            status: 200,
            headers: { 'set-cookie': 'session=abc123opaque; Path=/; HttpOnly' },
          }),
      ),
    )
    const result = await tools().definition.call('http_request', {
      url: 'https://app.vendor.example/login',
    })
    expect(result.text).toContain('set-cookie: session=***; Path=/; HttpOnly')
    expect(result.text).not.toContain('abc123opaque')
  })

  it('records a credential request for the run to wait on', async () => {
    const access = tools()
    await access.definition.call('request_credential', {
      credentialKey: 'VENDOR_OAUTH',
      reason: 'The partner API needs an OAuth client',
      observed: 'Created under Settings > API',
    })
    expect(access.recorded().needsCredential).toEqual({
      key: 'VENDOR_OAUTH',
      reason: 'The partner API needs an OAuth client',
      observed: 'Created under Settings > API',
    })
  })

  it('refuses to type a credential when no browser is available', async () => {
    const result = await tools().definition.call('fill_secret', {
      credentialKey: 'VENDOR_TOKEN',
      field: 'value',
      label: 'API key',
    })
    expect(result).toEqual({ text: 'No browser is available to this run.', isError: true })
  })

  it("never types a login's stored document as a field value", async () => {
    const result = await tools().definition.call('fill_secret', {
      credentialKey: 'VENDOR_LOGIN',
      field: 'value',
      label: 'Password',
    })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('"username" or "password"')
  })
})

describe('the access tool host and its stdio bridge', () => {
  const definition = {
    name: 'test',
    version: '1',
    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
    call: async (_name: string, args: Record<string, unknown>) => ({ text: String(args.text) }),
  }

  it('serves the tools over loopback to a bridge holding the token, and to nothing else', async () => {
    const host = await startAccessToolsHost(definition)
    try {
      const call = JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'echo', arguments: { text: 'hi' } },
      })
      const reply = await forwardMcpLine(host, call)
      expect(JSON.parse(reply!)).toMatchObject({ id: 7, result: { content: [{ text: 'hi' }] } })
      expect(
        await forwardMcpLine(host, JSON.stringify({ method: 'notifications/initialized' })),
      ).toBeNull()

      const refused = await forwardMcpLine({ url: host.url, token: 'wrong' }, call)
      expect(JSON.parse(refused!)).toMatchObject({ id: 7, error: { code: -32603 } })
    } finally {
      await host.close()
    }
  })
})

describe('parseProjectJob', () => {
  const body = {
    jobId: 'job_1',
    model: 'm',
    systemPrompt: 's',
    userPrompt: 'u',
    harness: 'claude-code',
    subscriptionToken: 't',
    access: {
      targets: [{ baseUrl: 'https://api.vendor.example', surface: 'api' }],
      credentials: [{ key: 'K', kind: 'api-token', value: 'v' }],
      browser: true,
    },
  }

  it('parses a project job with no repository', () => {
    expect(parseProjectJob(body).access).toEqual(body.access)
  })

  it('accepts no targets, since a project kind need not reach any', () => {
    expect(parseProjectJob({ ...body, access: { targets: [], credentials: [] } }).access).toEqual({
      targets: [],
      credentials: [],
      browser: false,
    })
  })

  it('refuses a non-https target and an unknown credential kind', () => {
    const with_ = (access: unknown) => ({ ...body, access })
    expect(() =>
      parseProjectJob(
        with_({ ...body.access, targets: [{ baseUrl: 'http://x.example', surface: 'api' }] }),
      ),
    ).toThrow(/https/)
    expect(() =>
      parseProjectJob(
        with_({ ...body.access, credentials: [{ key: 'K', kind: 'magic', value: 'v' }] }),
      ),
    ).toThrow(/kind/)
  })
})
