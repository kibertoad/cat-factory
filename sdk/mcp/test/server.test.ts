import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { createCatFactoryMcpServer } from '../src/server.ts'
import type { CatFactoryMcpOptions } from '../src/config.ts'

// Drives the facade the way a host does: a REAL MCP client over an in-memory transport, against a
// real `CatFactoryClient` whose `fetch` is stubbed. Nothing here mocks the protocol or the SDK, so
// a tool that lists but cannot be called — the failure mode a hand-written server hits most —
// fails a test rather than shipping.

interface Recorded {
  url: string
  method: string
  body: string | undefined
  headers: Record<string, string>
}

function stubFetch(reply: (request: Recorded) => Response): {
  fetch: typeof globalThis.fetch
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const impl = (async (url: unknown, init: unknown) => {
    const request = init as { method: string; body?: string; headers: Record<string, string> }
    const recorded = {
      url: String(url),
      method: request.method,
      body: request.body,
      headers: request.headers,
    }
    calls.push(recorded)
    return reply(recorded)
  }) as unknown as typeof globalThis.fetch
  return { fetch: impl, calls }
}

const OPTIONS: CatFactoryMcpOptions = {
  baseUrl: 'https://cat-factory.test',
  apiKey: 'cf_live_key.secret',
}

async function connect(
  options: CatFactoryMcpOptions,
  reply: (request: Recorded) => Response,
): Promise<{ client: Client; calls: Recorded[] }> {
  const { fetch, calls } = stubFetch(reply)
  const { server } = createCatFactoryMcpServer({ ...options, fetch })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-host', version: '0' })
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])
  return { client, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The text of a tool result (the facade only ever returns text content). */
function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content
  return content.map((part) => part.text).join('\n')
}

describe('the MCP facade end to end', () => {
  let calls: Recorded[]
  let client: Client

  beforeEach(() => {
    calls = []
  })

  it('lists tools with their schemas and the read-only annotation', async () => {
    ;({ client } = await connect(OPTIONS, () => json({})))
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(36)
    const start = tools.find((tool) => tool.name === 'tasks_start')!
    expect(start.annotations?.readOnlyHint).toBe(false)
    expect(tools.find((tool) => tool.name === 'tasks_get')!.annotations?.readOnlyHint).toBe(true)
    // The streaming endpoints are absent BY NAME, which is what the omission list documents.
    expect(tools.map((tool) => tool.name)).not.toContain('tasks_stream')
  })

  it('states the two hints the HTTP method cannot, on the tools that spend', async () => {
    ;({ client } = await connect(OPTIONS, () => json({})))
    const { tools } = await client.listTools()
    const start = tools.find((tool) => tool.name === 'tasks_start')!
    expect(start.annotations?.destructiveHint).toBe(true)
    // Not idempotent: a second call starts a second real agent run against a real repository.
    expect(start.annotations?.idempotentHint).toBe(false)
    const remove = tools.find((tool) => tool.name === 'tasks_delete')!
    // The pair `readOnlyHint` alone cannot express, and the reason both hints exist: deleting twice
    // leaves the board in the same state, and the first call is still irreversible.
    expect(remove.annotations?.destructiveHint).toBe(true)
    expect(remove.annotations?.idempotentHint).toBe(true)
    // A cheap write says NOTHING rather than claiming to be safe: the protocol's default for an
    // unset hint is the cautious one, and lowering a host's caution on a guess is worse than silence.
    const update = tools.find((tool) => tool.name === 'tasks_update')!
    expect(update.annotations?.destructiveHint).toBeUndefined()
    expect(update.annotations?.idempotentHint).toBeUndefined()
  })

  it('declares the shape of a result and returns it as structured content', async () => {
    ;({ client } = await connect(OPTIONS, () =>
      json({ taskId: 'blk_1', title: 'Add a health check', status: 'planned' }),
    ))
    const { tools } = await client.listTools()
    const get = tools.find((tool) => tool.name === 'tasks_get')!
    expect(get.outputSchema?.type).toBe('object')
    // Rendered permissively on purpose: `/api/v1` is additive forever, and a caller's own MCP client
    // VALIDATES against this schema, so a `required` list or an `enum` would be a way for an older
    // copy of this package to reject a newer deployment's honest answer.
    const schema = get.outputSchema as { required?: unknown; properties: Record<string, unknown> }
    expect(schema.required).toBeUndefined()
    expect((schema.properties.status as { enum?: unknown }).enum).toBeUndefined()

    // The client below validates the structured content against that schema and throws if it is
    // absent, so this call passing at all is the assertion that the two agree.
    const result = (await client.callTool({
      name: 'tasks_get',
      arguments: { taskId: 'blk_1' },
    })) as {
      structuredContent?: Record<string, unknown>
    }
    expect(result.structuredContent).toEqual({
      taskId: 'blk_1',
      title: 'Add a health check',
      status: 'planned',
    })
    // Both halves: the text block is what a host with no structured-content support shows a model.
    expect(JSON.parse(textOf(result)).taskId).toBe('blk_1')
  })

  it('spends no context on indentation', async () => {
    ;({ client } = await connect(OPTIONS, () => json({ taskId: 'blk_1', status: 'planned' })))
    const result = await client.callTool({ name: 'tasks_get', arguments: { taskId: 'blk_1' } })
    // Two-space indentation reads better to a human than to a model and costs roughly a third of
    // every result in whitespace, which on this surface is a third of an agent-context snapshot.
    expect(textOf(result)).toBe('{"taskId":"blk_1","status":"planned"}')
  })

  it('calls the deployment through the SDK and returns the response as JSON text', async () => {
    ;({ client, calls } = await connect(OPTIONS, () =>
      json({ taskId: 'blk_1', title: 'Add a health check', status: 'planned' }),
    ))
    const result = await client.callTool({
      name: 'tasks_create',
      arguments: { serviceId: 'svc_1', body: { title: 'Add a health check' } },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.url).toBe('https://cat-factory.test/api/v1/services/svc_1/tasks')
    expect(JSON.parse(calls[0]!.body!)).toEqual({ title: 'Add a health check' })
    // The key rides the SDK's own auth header — this facade never assembles a request itself.
    expect(calls[0]!.headers.authorization).toBe('Bearer cf_live_key.secret')
    // ...and identifies itself, so an operator reading an audit trail can tell a model's call
    // from an integration's.
    expect(calls[0]!.headers['user-agent']).toContain('cat-factory-mcp/')
    expect(JSON.parse(textOf(result)).taskId).toBe('blk_1')
    expect((result as { isError?: boolean }).isError).toBeFalsy()
  })

  it("forwards only declared query parameters, never a model's stray argument", async () => {
    ;({ client, calls } = await connect(OPTIONS, () => json({ runs: [], nextCursor: null })))
    await client.callTool({
      name: 'debug_list_runs',
      arguments: { limit: 5, nonsense: 'x' },
    })
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('limit')).toBe('5')
    // A forwarded typo would reach the deployment, be ignored, and leave the caller believing a
    // filter applied. Picking by name is what makes that impossible.
    expect(url.searchParams.has('nonsense')).toBe(false)
  })

  it("returns a refusal as tool content, carrying the deployment's own vocabulary", async () => {
    ;({ client } = await connect(OPTIONS, () =>
      json(
        {
          error: {
            code: 'validation',
            message: 'title is required',
            details: { reason: 'invalid_body' },
            issues: [{ path: 'title', message: 'Expected a non-empty string' }],
          },
        },
        422,
      ),
    ))
    const result = await client.callTool({
      name: 'tasks_create',
      arguments: { serviceId: 'svc_1', body: {} },
    })

    // `isError`, NOT a thrown protocol error: the host shows this to the model, and a 422 naming
    // the field is the most actionable thing the facade ever returns.
    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('HTTP 422')
    expect(text).toContain('validation')
    expect(text).toContain('title: Expected a non-empty string')
    expect(text).toContain('invalid_body')
  })

  it('says so when an endpoint returns no content', async () => {
    ;({ client } = await connect(OPTIONS, () => new Response(null, { status: 204 })))
    const result = await client.callTool({ name: 'tasks_delete', arguments: { taskId: 'blk_1' } })
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    // Not an empty string, which a model reads as a failure.
    expect(textOf(result)).toContain('returns no content')
  })

  it('refuses an over-cap response instead of rendering half of it', async () => {
    const big = {
      calls: Array.from({ length: 500 }, (_, i) => ({ id: `call_${i}`, prompt: 'x'.repeat(200) })),
    }
    ;({ client } = await connect({ ...OPTIONS, maxResultChars: 2_000 }, () => json(big)))
    const result = await client.callTool({
      name: 'debug_list_llm_calls',
      arguments: { runId: 'exec_1' },
    })
    // A refusal, not a prefix. Half an object cannot satisfy the output schema it was cut out of,
    // and the old truncation note itself told the model that what followed was not valid JSON and to
    // narrow instead of reading on, which is the whole cap spent to deliver that instruction.
    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('2000-character limit')
    // How much there was, and what to do about it, from either side of the connection.
    expect(text).toMatch(/returned \d{5,} characters/)
    expect(text).toContain('`limit`')
    expect(text).toContain('CAT_FACTORY_MCP_MAX_RESULT_CHARS')
  })

  it('withholds one tool without losing its group, and says so to the model', async () => {
    ;({ client } = await connect({ ...OPTIONS, excludeTools: ['notifications_act'] }, () =>
      json({}),
    ))
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain('notifications_act')
    expect(names).toContain('notifications_list')
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('withheld these individual tools')
    expect(instructions).toContain('notifications_act')
    // ...and the confirm-first section no longer names a tool this server does not serve, because it
    // is DERIVED from what was exposed rather than restated in prose beside it.
    const confirm = instructions
      .split('\n\n')
      .find((section) => section.startsWith('Confirm with the user'))!
    expect(confirm).toContain('tasks_start')
    expect(confirm).not.toContain('notifications_act')
  })

  it('refuses a tool it does not serve without breaking the protocol', async () => {
    ;({ client } = await connect({ ...OPTIONS, groups: ['tasks'] }, () => json({})))
    const { tools } = await client.listTools()
    expect(tools.every((tool) => tool.name.startsWith('tasks_'))).toBe(true)
    const result = await client.callTool({ name: 'debug_list_runs', arguments: {} })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('no such tool')
  })

  it('exposes only the non-mutating tools in read-only mode', async () => {
    ;({ client } = await connect({ ...OPTIONS, readOnly: true }, () => json({})))
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true)
    expect(tools.map((tool) => tool.name)).not.toContain('tasks_start')
  })

  it('tells the model what this server is and what it cannot do', async () => {
    ;({ client } = await connect({ ...OPTIONS, groups: ['tasks'], readOnly: true }, () => json({})))
    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('cat-factory')
    // A filtered group and a read-only start are facts about THIS server, not about the
    // deployment; a model told otherwise reports the platform as lacking the capability.
    expect(instructions).toContain('READ-ONLY')
    expect(instructions).toContain('debug')
    // ...and the two streaming endpoints are named as omissions with their alternative.
    expect(instructions).toContain('/events')
  })

  it('tells the model how to watch a run, since it cannot stream one', async () => {
    ;({ client } = await connect(OPTIONS, () => json({})))
    const instructions = client.getInstructions() ?? ''
    // The absent operations are the platform's live channels, so "how do I watch this" is the
    // question this surface most needs answered in prose. Without it a model either invents a
    // streaming tool, polls in a tight loop, or reports one non-terminal reading as the outcome.
    expect(instructions).toContain('`tasks_get_run`')
    expect(instructions).toContain('15-30 seconds')
    expect(instructions).toContain('terminal')
  })
})
