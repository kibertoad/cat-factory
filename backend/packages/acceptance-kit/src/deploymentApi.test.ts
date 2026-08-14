import { describe, expect, it } from 'vitest'
import { DeploymentAnswerError, DeploymentApi } from './deploymentApi.js'

// What is pinned here is the SHAPE the root reads throw, because `probeFailure.ts` branches on the
// type: an answered failure that arrives as a plain `Error` is reported as "no HTTP status came
// back … suspect the check itself" one line under a detail quoting the status, which is the
// misdiagnosis that whole module exists to remove. So every case below asserts the class and its
// status, not just the message.

/** A deployment that answers one canned response, over the injected fetch (no network). */
function answering(response: Response): DeploymentApi {
  return new DeploymentApi({
    baseUrl: 'http://127.0.0.1:3000',
    fetchImpl: async () => response,
  })
}

describe('DeploymentApi', () => {
  it('reads the health verdict a healthy deployment answers', async () => {
    const api = answering(Response.json({ status: 'ok' }))
    await expect(api.health()).resolves.toEqual({ status: 'ok' })
  })

  it('relays the problem list a misconfigured deployment publishes about itself', async () => {
    const api = answering(
      Response.json({ misconfigured: { problems: [{ key: 'ENCRYPTION_KEY' }] } }),
    )
    expect(await api.configProblems()).toEqual([{ key: 'ENCRYPTION_KEY' }])
  })

  it('answers an empty problem list rather than throwing when the field is absent', async () => {
    expect(await answering(Response.json({})).configProblems()).toEqual([])
  })

  it('throws a typed answer carrying the STATUS for a non-2xx, not a flattened message', async () => {
    // The status is the whole point of the class. Flattened into a string it was unreachable, so the
    // remedy could not say which layer answered, and the reader was sent to suspect the suite.
    const api = answering(new Response('<!DOCTYPE html><h1>404</h1>', { status: 404 }))
    const error = await api.health().catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(DeploymentAnswerError)
    expect(error).toMatchObject({ status: 404, answer: 'refused', method: 'GET' })
    expect((error as DeploymentAnswerError).message).toContain('<!DOCTYPE html>')
  })

  it('reports a 2xx body that is not JSON as an answer, never as a SyntaxError escaping', async () => {
    // The SPA serves a /health of its own and an HTML page for everything else, so this is the
    // base-URL mixup. Escaping as a bare `SyntaxError` it named neither the origin nor the body.
    const api = answering(new Response('<!DOCTYPE html><title>SPA</title>', { status: 200 }))
    const error = await api.health().catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(DeploymentAnswerError)
    expect(error).toMatchObject({ status: 200, answer: 'unparseable' })
    expect((error as DeploymentAnswerError).message).toContain('<title>SPA</title>')
    // The parse failure stays as the cause, so the chain still names what was wrong with the body.
    expect((error as DeploymentAnswerError).cause).toBeInstanceOf(SyntaxError)
  })

  it('keeps the thrown transport failure as the cause, which is what stays classifiable', async () => {
    // `probeFailure.ts` classifies DEEPEST-FIRST, so a wrapper that dropped the cause would turn a
    // diagnosable ECONNREFUSED into `unknown` and cost the remedy the wrapper exists to reach.
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3000'), {
      code: 'ECONNREFUSED',
    })
    const api = new DeploymentApi({
      baseUrl: 'http://127.0.0.1:3000',
      fetchImpl: () => Promise.reject(new TypeError('fetch failed', { cause: refused })),
    })
    const error = await api.health().catch((thrown: unknown) => thrown)
    expect(error).not.toBeInstanceOf(DeploymentAnswerError)
    expect((error as Error).message).toBe('GET http://127.0.0.1:3000/health could not be reached')
    expect((error as Error).cause).toBeInstanceOf(TypeError)
  })

  it('says what it dropped from an overlong body, rather than slicing it silently', async () => {
    // A silent slice reads as the whole of what the deployment answered, so a reader concludes the
    // rest was never there. Same rule as kernel's capped cause chain.
    const api = answering(new Response('x'.repeat(2_500), { status: 502 }))
    const error = (await api.health().catch((thrown: unknown) => thrown)) as Error
    expect(error.message).toContain('[…500 more characters of the body]')
  })

  it('names the absence when the body itself cannot be read, keeping the status', async () => {
    // A truncated or reset response fails at the body read, and the useful link is one `.cause`
    // down. `<body unreadable: >` would state less than naming the absence, which is what the one
    // shared `describeThrown` fallback is for.
    const reset = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('socket hang up'))
        },
      }),
      { status: 500 },
    )
    const error = (await answering(reset)
      .health()
      .catch((thrown: unknown) => thrown)) as DeploymentAnswerError
    expect(error.status).toBe(500)
    expect(error.message).toContain('failed with 500: <body unreadable:')
    expect(error.message).toContain('socket hang up')
  })
})
