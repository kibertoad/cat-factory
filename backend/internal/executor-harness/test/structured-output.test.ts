import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type ProxyAccess,
  type StructuredOutputSpec,
  diagnosticsSuffix,
  looksTokenDoubled,
  resolveStructuredOutput,
} from '../src/structured-output.js'

// A tiny structured output for the tests: a JSON object with `ok: true`.
interface Doc {
  ok: true
  v: number
}
const spec: StructuredOutputSpec<Doc> = {
  label: 'test',
  shapeHint: 'Expected {"ok": true, "v": number}.',
  // Throws on invalid JSON (like extractJsonObject), returns null on wrong shape.
  parse: (text) => {
    const o = JSON.parse(text) as Record<string, unknown>
    return o.ok === true && typeof o.v === 'number' ? ({ ok: true, v: o.v } as Doc) : null
  },
}
const access: ProxyAccess = {
  proxyBaseUrl: 'https://proxy.test/v1',
  sessionToken: 'sess-xyz',
  model: 'some-model',
  jobId: 'job_1',
}

/**
 * Build a token-doubled string the way the streaming corruption does — each MODEL
 * token (which carries whitespace/punctuation context) emitted twice in a row, e.g.
 * `{\n` `{\n` `   "` `   "` … — reproducing the real `serviceservice` / `{\n{\n` shape.
 */
function doubleTokens(tokens: string[]): string {
  return tokens.flatMap((t) => [t, t]).join('')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('looksTokenDoubled', () => {
  it('flags token-doubled output near ratio 1', () => {
    // Model-token granularity (whitespace/punctuation bundled in), as the real
    // corruption arrives: '{\n' '{\n' '   "' '   "' 'service' 'service' …
    const doubled = doubleTokens([
      '{\n',
      '   "',
      'service',
      '": "',
      'observability',
      '-service',
      '",\n',
      '   "',
      'summary',
      '": "',
      'Unified requirements',
      ' document',
      '"\n',
      '}',
    ])
    const r = looksTokenDoubled(doubled)
    expect(r.doubled).toBe(true)
    expect(r.ratio).toBeGreaterThan(0.8)
  })

  it('does not flag normal JSON', () => {
    const clean = JSON.stringify(
      { service: 'observability', summary: 'A service for tracing.', groups: [], rules: [] },
      null,
      2,
    )
    const r = looksTokenDoubled(clean)
    expect(r.doubled).toBe(false)
    expect(r.ratio).toBeLessThan(0.5)
  })

  it('ignores very short strings', () => {
    expect(looksTokenDoubled('{{}}').doubled).toBe(false)
  })
})

describe('resolveStructuredOutput', () => {
  it('returns the primary value without a repair call when it parses', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await resolveStructuredOutput(spec, '{"ok":true,"v":1}', access)

    expect(res.value).toEqual({ ok: true, v: 1 })
    expect(res.diagnostics.parsedOn).toBe('primary')
    expect(res.diagnostics.repairAttempted).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('makes a structured repair call when the primary is unparseable and recovers', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ choices: [{ message: { content: '{"ok":true,"v":2}' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await resolveStructuredOutput(spec, 'this is not json at all', access)

    expect(res.value).toEqual({ ok: true, v: 2 })
    expect(res.diagnostics).toMatchObject({
      parsedOn: 'repair',
      repairAttempted: true,
      repairSucceeded: true,
    })

    // The repair call hits the proxy's chat-completions route with json_object + a bearer token.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://proxy.test/v1/chat/completions')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sess-xyz' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.stream).toBe(false)
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages.at(-1).content).toContain('this is not json at all')
  })

  it('falls back to a prompt-only repair when the upstream rejects response_format (4xx)', async () => {
    const fetchMock = vi
      .fn()
      // First call (with response_format) is rejected by the upstream.
      .mockResolvedValueOnce(new Response('unsupported response_format', { status: 400 }))
      // Retry without response_format succeeds.
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: '{"ok":true,"v":7}' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await resolveStructuredOutput(spec, 'not json', access)

    expect(res.value).toEqual({ ok: true, v: 7 })
    expect(res.diagnostics).toMatchObject({ parsedOn: 'repair', repairSucceeded: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First body asks for json_object; the fallback drops it.
    expect(
      JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).response_format,
    ).toEqual({
      type: 'json_object',
    })
    expect(
      JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).response_format,
    ).toBeUndefined()
  })

  it('reports unrecoverable when the repair output still does not parse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'still broken' } }] })),
    )

    const res = await resolveStructuredOutput(spec, '<garbage>', access)

    expect(res.value).toBeNull()
    expect(res.diagnostics).toMatchObject({
      parsedOn: 'none',
      repairAttempted: true,
      repairSucceeded: false,
      repairError: 'repair output still did not parse',
    })
  })

  it('captures a transport error from the repair call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream boom', { status: 502 })),
    )

    const res = await resolveStructuredOutput(spec, '<garbage>', access)

    expect(res.value).toBeNull()
    expect(res.diagnostics.parsedOn).toBe('none')
    expect(res.diagnostics.repairError).toContain('HTTP 502')
  })

  it('repairs via the claude-code subscription endpoint when there is no proxy', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ content: [{ type: 'text', text: '{"ok":true,"v":9}' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    // No proxy; an Anthropic-compatible vendor (GLM/Kimi/DeepSeek) with a leased token.
    const subAccess: ProxyAccess = {
      model: 'glm-5.2',
      jobId: 'job_sub',
      harness: 'claude-code',
      subscriptionToken: 'glm-key-secret',
      subscriptionBaseUrl: 'https://api.z.ai/api/anthropic',
    }
    const res = await resolveStructuredOutput(spec, 'not json', subAccess)

    expect(res.value).toEqual({ ok: true, v: 9 })
    expect(res.diagnostics).toMatchObject({ parsedOn: 'repair', repairSucceeded: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.z.ai/api/anthropic/v1/messages')
    // API-token vendors authenticate with x-api-key, not a bearer session token.
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'glm-key-secret' })
  })

  it('does not attempt repair for the codex harness (no proxy, no JSON API)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const codexAccess: ProxyAccess = {
      model: 'gpt-5.5-codex',
      jobId: 'job_codex',
      harness: 'codex',
      subscriptionToken: '{"auth_mode":"chatgpt"}',
    }
    const res = await resolveStructuredOutput(spec, 'not json', codexAccess)

    expect(res.value).toBeNull()
    expect(res.diagnostics).toMatchObject({ parsedOn: 'none', repairAttempted: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('diagnosticsSuffix', () => {
  it('summarises a doubled, unrecovered failure', () => {
    const s = diagnosticsSuffix({
      parsedOn: 'none',
      primaryChars: 4142,
      looksDoubled: true,
      repairAttempted: true,
      repairSucceeded: false,
    })
    expect(s).toContain('token-doubled')
    expect(s).toContain('structured repair did not help')
  })

  it('is empty when the primary parsed cleanly', () => {
    expect(
      diagnosticsSuffix({
        parsedOn: 'primary',
        primaryChars: 100,
        looksDoubled: false,
        repairAttempted: false,
        repairSucceeded: false,
      }),
    ).toBe('')
  })
})

/** Build a JSON `Response` the way `fetch` would for an OK completion. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
