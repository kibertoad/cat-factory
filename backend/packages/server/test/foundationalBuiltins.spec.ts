import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  type FoundationalServiceDefinition,
  defaultFoundationalServiceRegistry,
} from '@cat-factory/kernel'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import type { AppEnv } from '../src/http/env.js'
import { foundationalBuiltinsController } from '../src/modules/foundationalServices/FoundationalBuiltinsController.js'
import { HttpFoundationalBuiltinSource } from '../src/persistence/foundationalBuiltins.js'

/**
 * The mothership-mode `builtin`-tier read, end to end: the real client driving the real
 * controller over an in-process transport, so the round trip is exercised exactly as it will be
 * over HTTP with no network.
 *
 * Two properties carry the feature, and both are asserted here rather than left to the types:
 * the tier is gated by the machine token like every other `/internal/*` surface, and a FAILED
 * read never degrades to an empty tier — an empty catalog silently produces a design that
 * reinvents a service the org already runs, which is the failure ADR 0031 exists to prevent.
 */

const SECRET = 'test-session-secret'

const OPENAPI = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Files', version: '1' },
  paths: { '/files/{fileId}': { get: { operationId: 'getFile' } } },
})

const DEFINITION: FoundationalServiceDefinition = {
  id: 'file-storage',
  name: 'File Storage',
  summary: 'Stores and serves binary blobs.',
  description: 'The org-wide blob store. Use it instead of building an upload endpoint.',
  capabilities: ['asset-storage'],
  contracts: [{ contractId: 'http', format: 'openapi', title: 'HTTP API', body: OPENAPI }],
}

/** The mothership: the real controller over a container carrying a real, populated registry. */
function mothership(definitions: FoundationalServiceDefinition[] = [DEFINITION]) {
  const registry = defaultFoundationalServiceRegistry()
  registry.registerAll(definitions)
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      foundationalServiceRegistry: registry,
      config: { auth: { sessionSecret: SECRET } },
    } as unknown as AppEnv['Variables']['container'])
    await next()
  })
  app.route('/', foundationalBuiltinsController())
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
  return new HttpFoundationalBuiltinSource({
    baseUrl: 'https://mothership.test',
    token: resolved,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as unknown as typeof fetch,
  })
}

describe('mothership-mode foundational `builtin` tier', () => {
  it('serves the catalog projection — identity and manifests, never a document body', async () => {
    const source = await node(mothership())
    const entries = await source.entries()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.id).toBe('file-storage')
    expect(entries[0]!.capabilities).toEqual(['asset-storage'])
    // The split that keeps a design prompt from scaling with the size of the org's specs: the
    // manifest names the operations the contract declares and carries no body.
    expect(entries[0]!.contracts[0]!.operations).toContain('GET /files/{fileId}')
    expect(entries[0]!.contracts[0]).not.toHaveProperty('body')
    // …and the manifest still carries the SIZE, which is what makes a body's absence legible
    // rather than indistinguishable from a contract that has none.
    expect(entries[0]!.contracts[0]!.size).toBe(OPENAPI.length)
  })

  it('serves the FULL documents on the lazy read, batched over the declared set', async () => {
    const source = await node(mothership())
    // ONE read for the whole declared set: the tier can be remote, so a per-id read in the
    // caller's loop would be an N+1 over the wire.
    const documents = await source.documentsFor(['file-storage'])
    expect(documents.get('file-storage')).toHaveLength(1)
    expect(documents.get('file-storage')![0]!.body).toBe(OPENAPI)
  })

  it('answers an unknown service id with an empty list, exactly as the in-process source does', async () => {
    const source = await node(mothership())
    const documents = await source.documentsFor(['file-storage', 'never-registered'])
    expect(documents.get('never-registered')).toEqual([])
    // …and the known id in the same batch is unaffected.
    expect(documents.get('file-storage')).toHaveLength(1)
  })

  it('reads nothing at all for an empty declared set', async () => {
    let calls = 0
    const source = new HttpFoundationalBuiltinSource({
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

  it('reports an EMPTY estate as empty — a deployment that registers none is not an error', async () => {
    const source = await node(mothership([]))
    await expect(source.entries()).resolves.toEqual([])
  })

  it('refuses both routes without a machine token', async () => {
    const app = mothership()
    expect((await app.request('/internal/foundational-services')).status).toBe(403)
    expect(
      (await app.request('/internal/foundational-services/contracts', { method: 'POST' })).status,
    ).toBe(403)
  })

  it('refuses a token of the wrong audience (a user session can never be replayed here)', async () => {
    const app = mothership()
    const session = await signerFor(SECRET).sign({
      aud: TOKEN_AUDIENCE.session,
      userId: 'usr_1',
      exp: Date.now() + 60_000,
    })
    const res = await app.request('/internal/foundational-services', {
      headers: { authorization: `Bearer ${session}` },
    })
    expect(res.status).toBe(403)
  })

  it('THROWS rather than reporting an empty tier when the read is refused', async () => {
    // The node presents no valid token (the 403 above, seen from the client's side). Reading it
    // as "this deployment registers no shared services" would hand an Architect a catalog that
    // silently omits the org's entire estate.
    const source = await node(mothership(), 'not-a-token')
    await expect(source.entries()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'foundational_builtins_unreachable' },
    })
  })

  it('THROWS when the mothership does not serve the route at all (an older build)', async () => {
    // A mothership one release BEHIND the node answers 404. That is the shape most likely to be
    // read as an empty estate, and the one that must not be.
    const source = await node(new Hono<AppEnv>())
    await expect(source.entries()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'foundational_builtins_unreachable', status: 404 },
    })
  })

  it('THROWS on a transport failure, with the cause scrubbed onto the details', async () => {
    const source = new HttpFoundationalBuiltinSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    await expect(source.documentsFor(['file-storage'])).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'foundational_builtins_unreachable', err: 'ECONNREFUSED' },
    })
  })
})
