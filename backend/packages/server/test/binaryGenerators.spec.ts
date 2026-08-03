import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { type BinaryGeneratorDefinition, defaultBinaryGeneratorRegistry } from '@cat-factory/kernel'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import type { AppEnv } from '../src/http/env.js'
import { binaryGeneratorsController } from '../src/modules/binaryGenerators/BinaryGeneratorsController.js'
import { HttpBinaryGeneratorSource } from '../src/persistence/binaryGenerators.js'

/**
 * The mothership-mode generative-integration read, end to end: the real client driving the real
 * controller over an in-process transport, so the round trip is exercised exactly as it will be
 * over HTTP with no network.
 *
 * Two properties carry the feature, and both are asserted here rather than left to the types: the
 * set is gated by the machine token like every other `/internal/*` surface, and a FAILED read
 * never degrades to an empty set. The second matters more here than it does for the estate — an
 * empty set is not a quiet omission but an ADMISSION refusal, so softening an outage would refuse
 * a correctly configured step with `unknown_generator` and send its operator to edit a step that
 * has nothing wrong with it.
 */

const SECRET = 'test-session-secret'

const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Inference', version: '1' },
  paths: { '/inferences': { post: { operationId: 'createInference' } } },
})

const DEFINITION: BinaryGeneratorDefinition = {
  id: 'retro-diffusion',
  name: 'Retro Diffusion',
  summary: 'Pixel-art image generation.',
  description: 'Generates pixel-art sprites and tilesets from a prompt.',
  modalities: ['image'],
  mediaTypes: ['image/png'],
  endpoint: 'https://api.retrodiffusion.test',
  credential: { key: 'RD_TOKEN', usage: 'X-RD-Token: <value>' },
  contracts: [{ contractId: 'api', format: 'openapi', title: 'Inference API', body: OPENAPI }],
}

/** The mothership: the real controller over a container carrying a real, populated registry. */
function mothership(definitions: BinaryGeneratorDefinition[] = [DEFINITION]) {
  const registry = defaultBinaryGeneratorRegistry()
  registry.registerAll(definitions)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      binaryGeneratorRegistry: registry,
      config: { auth: { sessionSecret: SECRET } },
    } as unknown as AppEnv['Variables']['container'])
    await next()
  })
  app.route('/', binaryGeneratorsController())
  return app
}

async function machineToken() {
  return signerFor(SECRET).sign({
    aud: TOKEN_AUDIENCE.machine,
    nodeId: 'node_1',
    userId: 'usr_1',
    scope: { accountIds: ['acc_1'] },
    exp: Date.now() + 60_000,
  })
}

/** The node: the real remote source, transported straight into the app above. */
async function node(app: Hono<AppEnv>, token?: string) {
  const resolved = token ?? (await machineToken())
  return new HttpBinaryGeneratorSource({
    baseUrl: 'https://mothership.test',
    token: resolved,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as unknown as typeof fetch,
  })
}

describe('mothership-mode generative binary integrations', () => {
  it('serves the engine projection — identity, content types and manifests, never a body', async () => {
    const source = await node(mothership())
    const views = await source.views()
    expect(views).toHaveLength(1)
    expect(views[0]!.id).toBe('retro-diffusion')
    expect(views[0]!.modalities).toEqual(['image'])
    expect(views[0]!.mediaTypes).toEqual(['image/png'])
    expect(views[0]!.contracts[0]!.operations).toContain('POST /inferences')
    expect(views[0]!.contracts[0]).not.toHaveProperty('body')
  })

  it('carries the credential KEY NAME, which is what a node resolves a value for', async () => {
    // The one field here that the workspace snapshot deliberately withholds from a viewer. The
    // node needs it (it resolves the key against its own environment onto the job body); nothing
    // secret crosses, because a declaration is a name and never a value.
    const source = await node(mothership())
    const views = await source.views()
    expect(views[0]!.credential).toEqual({ key: 'RD_TOKEN', usage: 'X-RD-Token: <value>' })
  })

  it('serves the FULL documents on the lazy read, batched over the selection', async () => {
    const source = await node(mothership())
    const documents = await source.documentsFor(['retro-diffusion'])
    expect(documents.get('retro-diffusion')).toHaveLength(1)
    expect(documents.get('retro-diffusion')![0]!.body).toBe(OPENAPI)
  })

  it('answers an unknown id with an empty list, exactly as the in-process source does', async () => {
    const source = await node(mothership())
    const documents = await source.documentsFor(['retro-diffusion', 'never-registered'])
    expect(documents.get('never-registered')).toEqual([])
    expect(documents.get('retro-diffusion')).toHaveLength(1)
  })

  it('reads nothing at all for an empty selection', async () => {
    let calls = 0
    const source = new HttpBinaryGeneratorSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() => {
        calls += 1
        return Promise.reject(new Error('should not be called'))
      }) as unknown as typeof fetch,
    })
    await expect(source.documentsFor([])).resolves.toEqual(new Map())
    expect(calls).toBe(0)
  })

  it('reports a deployment that registers NONE as empty — that is the stock product', async () => {
    const source = await node(mothership([]))
    await expect(source.views()).resolves.toEqual([])
  })

  it('refuses both routes without a machine token', async () => {
    const app = mothership()
    expect((await app.request('/internal/binary-generators')).status).toBe(403)
    expect(
      (await app.request('/internal/binary-generators/contracts', { method: 'POST' })).status,
    ).toBe(403)
  })

  it('refuses a token of the wrong audience (a user session can never be replayed here)', async () => {
    const app = mothership()
    const session = await signerFor(SECRET).sign({
      aud: TOKEN_AUDIENCE.session,
      userId: 'usr_1',
      exp: Date.now() + 60_000,
    })
    const res = await app.request('/internal/binary-generators', {
      headers: { authorization: `Bearer ${session}` },
    })
    expect(res.status).toBe(403)
  })

  it('THROWS rather than reporting an empty set when the read is refused', async () => {
    const source = await node(mothership(), 'not-a-token')
    await expect(source.views()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable' },
    })
  })

  it('THROWS when the mothership does not serve the route at all (an older build)', async () => {
    // A mothership one release BEHIND the node answers 404 — the version floor this seam creates,
    // and the shape most likely to be read as "registers none".
    const source = await node(new Hono<AppEnv>())
    await expect(source.views()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable', status: 404 },
    })
  })

  it('THROWS on a well-formed 200 whose payload it cannot read', async () => {
    for (const payload of [{}, { generators: 'nope' }, { generators: { id: 'x' } }]) {
      const source = new HttpBinaryGeneratorSource({
        baseUrl: 'https://mothership.test',
        token: 'tok',
        fetchImpl: (() =>
          Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )) as unknown as typeof fetch,
      })
      await expect(source.views()).rejects.toMatchObject({
        code: 'unavailable',
        details: { reason: 'binary_generators_unreachable', field: 'generators' },
      })
    }
  })

  it('THROWS on a well-formed list whose ELEMENTS it cannot resolve a selection against', async () => {
    // The envelope being an array is not enough. A view with no `id` cannot be matched against a
    // step's `generatorIds`, and one with no `modalities` cannot be checked for content-type
    // coverage — so a reply carrying either is a reply whose registered set is unknown, which is
    // the one thing this class must never answer quietly. The realistic source is a version
    // skew, not a hostile peer.
    for (const generators of [[{ modalities: ['image'] }], [{ id: 'retro' }], [null], ['retro']]) {
      const source = new HttpBinaryGeneratorSource({
        baseUrl: 'https://mothership.test',
        token: 'tok',
        fetchImpl: (() =>
          Promise.resolve(
            new Response(JSON.stringify({ generators }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          )) as unknown as typeof fetch,
      })
      await expect(source.views()).rejects.toMatchObject({
        code: 'unavailable',
        details: { reason: 'binary_generators_unreachable', field: 'generators' },
      })
    }
  })

  it('THROWS on a documents map whose VALUES are not arrays', async () => {
    // Otherwise this escapes as a `TypeError` from the brief renderer's `.map()` — an unreadable
    // reply surfacing as a generic crash instead of the one error every route to "we do not know
    // what is registered" is supposed to end at, logged by the caller under the wrong cause.
    const source = new HttpBinaryGeneratorSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ documents: { 'retro-diffusion': 'nope' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof fetch,
    })
    await expect(source.documentsFor(['retro-diffusion'])).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable', field: 'documents' },
    })
  })

  it('THROWS on a contracts reply whose `documents` is not an object map', async () => {
    const source = new HttpBinaryGeneratorSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      // An ARRAY is the shape most likely to slip through a `typeof === 'object'` check, and
      // `Object.entries` would turn it into a map keyed by numeric index.
      fetchImpl: (() =>
        Promise.resolve(
          new Response(JSON.stringify({ documents: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        )) as unknown as typeof fetch,
    })
    await expect(source.documentsFor(['retro-diffusion'])).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable', field: 'documents' },
    })
  })

  it('THROWS on a transport failure, with the cause scrubbed onto the details', async () => {
    const source = new HttpBinaryGeneratorSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    await expect(source.views()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'binary_generators_unreachable', err: 'ECONNREFUSED' },
    })
  })
})
