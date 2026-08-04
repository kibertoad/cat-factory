import { ConflictError, createRecordingLogger } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from './env.js'
import { handleError } from './errorHandler.js'
import { REQUEST_ID_HEADER, mountRequestLogging, resolveRequestId } from './requestLogging.js'

function buildApp(): { app: Hono<AppEnv>; logger: ReturnType<typeof createRecordingLogger> } {
  const logger = createRecordingLogger()
  const app = new Hono<AppEnv>()
  mountRequestLogging(app, logger)
  app.get('/health', (c) => c.json({ status: 'ok' }))
  app.get('/workspaces/ws1/blocks', (c) => c.json({ ok: true }))
  app.get('/boom', () => {
    throw new Error('kaboom at https://api.example.test?token=sk-secret')
  })
  app.get('/conflict', () => {
    throw new ConflictError('the task limit is reached', 'task_limit_reached')
  })
  app.onError(handleError)
  return { app, logger }
}

describe('resolveRequestId', () => {
  it('adopts a safe client-supplied id', () => {
    expect(resolveRequestId('abc-123_XY=')).toBe('abc-123_XY=')
  })

  it('mints a fresh id for an absent, oversized or unsafe one', () => {
    expect(resolveRequestId(undefined)).toMatch(/^[\w-]+$/)
    expect(resolveRequestId('a'.repeat(256))).not.toBe('a'.repeat(256))
    // A header is attacker-controlled and this value lands in every log line for the request,
    // so anything that could break a log parser (or forge a second line) is refused.
    expect(resolveRequestId('has space')).not.toBe('has space')
    expect(resolveRequestId('{"level":30}')).not.toBe('{"level":30}')
  })
})

describe('mountRequestLogging', () => {
  it('mints an id, echoes it on the response, and logs one completion line', async () => {
    const { app, logger } = buildApp()
    const res = await app.request('/workspaces/ws1/blocks')
    const id = res.headers.get(REQUEST_ID_HEADER)

    expect(res.status).toBe(200)
    expect(id).toBeTruthy()
    const lines = logger.lines.filter((l) => l.msg === 'request completed')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('info')
    expect(lines[0]?.fields).toMatchObject({
      requestId: id,
      method: 'GET',
      path: '/workspaces/ws1/blocks',
      status: 200,
    })
    expect(lines[0]?.fields?.durationMs).toBeTypeOf('number')
  })

  it('propagates a client-supplied id instead of minting a second one', async () => {
    const { app, logger } = buildApp()
    const res = await app.request('/workspaces/ws1/blocks', {
      headers: { [REQUEST_ID_HEADER]: 'upstream-42' },
    })
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe('upstream-42')
    expect(logger.lines[0]?.fields?.requestId).toBe('upstream-42')
  })

  it('adopts an inbound traceparent so the request’s lines join the caller’s trace', async () => {
    const { app, logger } = buildApp()
    await app.request('/workspaces/ws1/blocks', {
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    })
    // Bound once for the whole request, so anything logging inside it correlates for free.
    expect(logger.lines[0]?.fields).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    })
  })

  it('ignores a malformed traceparent rather than refusing the request', async () => {
    const { app, logger } = buildApp()
    // A bad correlation header is not a reason to fail real work, and the value is echoed into
    // every exported line — so it is dropped, not sanitised into something almost-valid.
    const res = await app.request('/workspaces/ws1/blocks', {
      headers: { traceparent: 'nonsense' },
    })
    expect(res.status).toBe(200)
    expect(logger.lines[0]?.fields).not.toHaveProperty('traceId')
    expect(logger.lines[0]?.fields).not.toHaveProperty('spanId')
  })

  it('logs only the pathname, never the query string', async () => {
    const { app, logger } = buildApp()
    await app.request('/workspaces/ws1/blocks?ticket=super-secret')
    expect(JSON.stringify(logger.lines)).not.toContain('super-secret')
    expect(logger.lines[0]?.fields?.path).toBe('/workspaces/ws1/blocks')
  })

  it('keeps a healthy liveness probe out of the info stream', async () => {
    const { app, logger } = buildApp()
    await app.request('/health')
    expect(logger.lines.map((l) => l.level)).toEqual(['debug'])
  })

  it('logs a rejected request at warn, naming the mapped error code', async () => {
    const { app, logger } = buildApp()
    const res = await app.request('/conflict')
    expect(res.status).toBe(409)
    const line = logger.lines.find((l) => l.msg === 'request rejected')
    expect(line?.level).toBe('warn')
    expect(line?.fields).toMatchObject({ status: 409, errorCode: 'conflict' })
  })

  it('carries the request id into the error envelope so a user can quote it', async () => {
    const { app } = buildApp()
    const res = await app.request('/conflict')
    const body = (await res.json()) as {
      error: { code: string; requestId: string; details: object }
    }
    expect(body.error.requestId).toBe(res.headers.get(REQUEST_ID_HEADER))
    // The envelope is otherwise unchanged — the id is additive.
    expect(body.error.code).toBe('conflict')
    expect(body.error.details).toEqual({ reason: 'task_limit_reached' })
  })

  it('reports an unexpected fault through the request-scoped logger, scrubbed', async () => {
    const { app, logger } = buildApp()
    const res = await app.request('/boom')
    expect(res.status).toBe(500)
    const fault = logger.lines.find((l) => l.msg === 'unhandled request error')
    // The bound correlation fields ride the child logger, so the 500's own line joins to the
    // envelope the caller received without the emit site re-spreading them.
    expect(fault?.fields?.requestId).toBe(res.headers.get(REQUEST_ID_HEADER))
    expect(fault?.fields?.path).toBe('/boom')
    // The WHOLE line, not just `err`. A stack's first line is `Error: <message>` verbatim, so
    // asserting only on the scrubbed field would pass while `stack` republished the secret
    // right beside it.
    expect(JSON.stringify(fault)).not.toContain('sk-secret')
    // Redaction must not gut the stack — what identifies the fault still survives.
    expect(fault?.fields?.stack).toContain('kaboom')
    expect(logger.lines.find((l) => l.msg === 'request failed')?.level).toBe('error')
  })

  it('leaves a WebSocket upgrade response untouched', async () => {
    const logger = createRecordingLogger()
    const app = new Hono<AppEnv>()
    mountRequestLogging(app, logger)
    // A real 101 can't be built through the Response constructor, and on Cloudflare the runtime
    // hands back an object carrying a `webSocket` property that `new Response(body, res)` would
    // silently drop. Stand in for it with a response whose status reads 101 and assert we return
    // the SAME instance — i.e. that nothing rebuilt it.
    const upgrade = new Response(null, { status: 200 })
    Object.defineProperty(upgrade, 'status', { value: 101 })
    app.get('/workspaces/ws1/events', () => upgrade)

    const res = await app.request('/workspaces/ws1/events')
    expect(res).toBe(upgrade)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeNull()
    expect(logger.lines[0]?.fields?.status).toBe(101)
  })
})
