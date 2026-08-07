import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { defaultPromptFragmentRegistry } from '@cat-factory/kernel'
import { TOKEN_AUDIENCE, signerFor } from '../src/auth/signing.js'
import type { AppEnv } from '../src/http/env.js'
import { promptFragmentsInternalController } from '../src/modules/promptFragments/PromptFragmentsInternalController.js'
import { HttpPromptFragmentSource } from '../src/persistence/promptFragments.js'

/**
 * The mothership-mode standards-pool read, end to end: the real client driving the real controller
 * over an in-process transport, the sibling of `binaryGenerators.spec.ts` and asserting the same
 * two properties, because they carry the feature here too.
 *
 * The pool is the tier every other tier merges ONTO, so a read that fails quietly is the worst
 * outcome available: the run folds no org standard, the work is judged against nothing, and the
 * reviewer's adherence report reads exactly like a deployment that never wrote a standard down.
 * Every route to "this node does not know the standards" therefore ends at a throw, and the
 * fixtures below walk each of them.
 */

const SECRET = 'test-session-secret'

const FRAGMENT = {
  id: 'org.api-guidelines',
  version: '1.0.0',
  title: 'Org API guidelines',
  category: 'Org',
  summary: 'How this org shapes APIs.',
  body: 'Plural nouns for collections.',
}

/** The mothership: the real controller over a container carrying a real, populated registry. */
function mothership(fragments = [FRAGMENT], defaults: Record<string, string[]> = {}) {
  const registry = defaultPromptFragmentRegistry()
  registry.registerAll(fragments)
  for (const [taskType, ids] of Object.entries(defaults)) {
    registry.registerTaskTypeDefaults(taskType as never, ids)
  }
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', {
      promptFragmentRegistry: registry,
      config: { auth: { sessionSecret: SECRET } },
    } as unknown as AppEnv['Variables']['container'])
    await next()
  })
  app.route('/', promptFragmentsInternalController())
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
  return new HttpPromptFragmentSource({
    baseUrl: 'https://mothership.test',
    token: resolved,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
      app.request(String(input), init)) as unknown as typeof fetch,
  })
}

/** A source over a fixed 200 payload, for the replies no real controller would produce. */
function sourceOver(payload: unknown, onRead?: () => void) {
  return new HttpPromptFragmentSource({
    baseUrl: 'https://mothership.test',
    token: 'tok',
    fetchImpl: (() => {
      onRead?.()
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    }) as unknown as typeof fetch,
  })
}

describe('mothership-mode prompt-fragment pool', () => {
  it('serves both projections of one registration', async () => {
    const source = await node(mothership([FRAGMENT], { document: ['org.api-guidelines'] }))
    await expect(source.all()).resolves.toEqual([FRAGMENT])
    await expect(source.defaultFragmentIdsFor('document')).resolves.toEqual(['org.api-guidelines'])
  })

  it('answers a task type with no registered default set as empty', async () => {
    // The ABSENCE of a registration, which the controller deliberately omits from the wire rather
    // than sending as `[]`. Both read as "seed nothing extra", and only one of them is a fact.
    const source = await node(mothership())
    await expect(source.defaultFragmentIdsFor('feature')).resolves.toEqual([])
  })

  it('reports a deployment that registers NONE as empty, which is the stock product', async () => {
    const source = await node(mothership([]))
    await expect(source.all()).resolves.toEqual([])
  })

  it('re-reads, so a redeployed mothership reaches a node that never restarted', async () => {
    // The regression this pins: the source shipped with a PROCESS-lifetime memo, so an operator
    // who added an org standard and redeployed reached every running node only by restarting it.
    let reads = 0
    const source = sourceOver({ fragments: [FRAGMENT], taskTypeDefaults: {} }, () => (reads += 1))
    await source.all()
    await source.all()
    expect(reads).toBe(2)
  })

  it('refuses the route without a machine token', async () => {
    expect((await mothership().request('/internal/prompt-fragments')).status).toBe(403)
  })

  it('refuses a token of the wrong audience (a user session can never be replayed here)', async () => {
    const session = await signerFor(SECRET).sign({
      aud: TOKEN_AUDIENCE.session,
      userId: 'usr_1',
      exp: Date.now() + 60_000,
    })
    const res = await mothership().request('/internal/prompt-fragments', {
      headers: { authorization: `Bearer ${session}` },
    })
    expect(res.status).toBe(403)
  })

  it('THROWS rather than reporting an empty pool when the read is refused', async () => {
    const source = await node(mothership(), 'not-a-token')
    await expect(source.all()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'prompt_fragments_unreachable' },
    })
  })

  it('THROWS when the mothership does not serve the route at all (an older build)', async () => {
    const source = await node(new Hono<AppEnv>())
    await expect(source.all()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'prompt_fragments_unreachable', status: 404 },
    })
  })

  it('THROWS on a well-formed 200 whose payload it cannot read', async () => {
    for (const payload of [
      {},
      { fragments: 'nope', taskTypeDefaults: {} },
      { fragments: [] },
      { fragments: [], taskTypeDefaults: [] },
    ]) {
      await expect(sourceOver(payload).all()).rejects.toMatchObject({
        code: 'unavailable',
        details: { reason: 'prompt_fragments_unreachable' },
      })
    }
  })

  it('THROWS on a defaults map whose VALUES are not id arrays', async () => {
    // The container being an object is not enough. A bare string is spread into the id set a new
    // task is seeded with, so `"node.style"` seeds ten single-character ids that fold nothing: the
    // unknown pool this class refuses to answer quietly, arriving as garbage instead of an error.
    for (const taskTypeDefaults of [{ document: 'node.style' }, { document: [1] }]) {
      await expect(sourceOver({ fragments: [], taskTypeDefaults }).all()).rejects.toMatchObject({
        code: 'unavailable',
        details: { reason: 'prompt_fragments_unreachable', field: 'taskTypeDefaults' },
      })
    }
  })

  it('THROWS on a transport failure, with the cause scrubbed onto the details', async () => {
    const source = new HttpPromptFragmentSource({
      baseUrl: 'https://mothership.test',
      token: 'tok',
      fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    await expect(source.all()).rejects.toMatchObject({
      code: 'unavailable',
      details: { reason: 'prompt_fragments_unreachable', err: 'ECONNREFUSED' },
    })
  })
})
