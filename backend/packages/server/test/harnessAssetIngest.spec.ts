import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { harnessAssetController } from '../src/modules/artifacts/HarnessAssetController.js'
import { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The platform's own asset endpoints, driven the way the CONTRACT drives them.
//
// Two properties this file exists for, neither visible from the controller alone:
//
//  - The agent reaches these routes by composing an OpenAPI document's path onto a base URL that
//    is the WHOLE endpoint, because the endpoint is per-run and arrives as an environment
//    variable. `POST /` therefore composes to a trailing slash. Serving one spelling and
//    publishing the other is a 404 nothing in the container can work around, and no test that
//    calls the route directly would ever produce it.
//  - The discard route is what keeps the run's own storage bounded, since an `asset` row is
//    exempt from the retention sweep. It has to be idempotent (the brief hands the agent a LIST
//    to clear up, replayed across passes) and it has to refuse anything this run did not store.

const SECRET = 'test-session-secret-0123456789'

function record(over: Partial<BinaryArtifactRecord> = {}): BinaryArtifactRecord {
  return {
    id: 'art_1',
    workspaceId: 'ws_1',
    executionId: 'ex_1',
    blockId: null,
    kind: 'asset',
    view: 'Goblin',
    contentType: 'image/png',
    byteSize: 3,
    hash: 'h',
    storage: 'memory',
    storageKey: 'ws_1/art_1',
    document: null,
    createdAt: 1,
    ...over,
  }
}

function makeApp(rows: Record<string, BinaryArtifactRecord> = {}) {
  const stored: BinaryArtifactRecord[] = []
  const deleted: string[] = []
  const store = {
    countByExecution: async () => Object.keys(rows).length,
    listByExecution: async () => Object.values(rows),
    getMetadata: async (workspaceId: string, id: string) => {
      // The real stores scope every read to the workspace; the fake refuses exactly where they do.
      const row = rows[id]
      return row && row.workspaceId === workspaceId ? row : null
    },
    store: async (input: { meta: Record<string, unknown>; blob: Uint8Array }) => {
      const created = record({
        id: `art_${stored.length + 2}`,
        ...(input.meta as Partial<BinaryArtifactRecord>),
        byteSize: input.blob.byteLength,
      })
      stored.push(created)
      return created
    },
    delete: async (_workspaceId: string, id: string) => {
      deleted.push(id)
      delete rows[id]
    },
  }
  const container = {
    config: { auth: { sessionSecret: SECRET } },
    resolveBinaryArtifactStore: async () => store,
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', harnessAssetController())
  app.onError(handleError)
  return { app, stored, deleted }
}

function mintToken(executionId = 'ex_1'): Promise<string> {
  return new ContainerSessionService({ secret: SECRET }).mint({
    workspaceId: 'ws_1',
    executionId,
    agentKind: 'media-generator',
    provider: 'workers-ai',
    model: '@cf/test/model',
  })
}

async function post(app: Hono<AppEnv>, path: string) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array([1, 2, 3])], 'goblin.png', { type: 'image/png' }))
  form.append('name', 'Goblin')
  return app.fetch(
    new Request(`http://x${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await mintToken()}` },
      body: form,
    }),
  )
}

async function discard(app: Hono<AppEnv>, id: string, executionId = 'ex_1') {
  return app.fetch(
    new Request(`http://x/v1/assets/ingest/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await mintToken(executionId)}` },
    }),
  )
}

describe('storing an asset', () => {
  it('serves both the bare path and the one the published contract composes to', async () => {
    // `ARTIFACT_UPLOAD_URL` is the whole endpoint and an OpenAPI operation cannot be pathless, so
    // the document declares `POST /` and a conforming client emits base + `/`. Hono routes
    // strictly: the trailing-slash spelling is a 404 unless it is mounted too.
    for (const path of ['/v1/assets/ingest', '/v1/assets/ingest/']) {
      const { app, stored } = makeApp()
      const res = await post(app, path)
      expect(res.status, path).toBe(201)
      expect(await res.json(), path).toMatchObject({ contentType: 'image/png', byteSize: 3 })
      expect(
        stored.map((row) => row.kind),
        path,
      ).toEqual(['asset'])
    }
  })
})

describe('discarding an asset', () => {
  it('reclaims one this run stored', async () => {
    const { app, deleted } = makeApp({ art_1: record() })
    expect((await discard(app, 'art_1')).status).toBe(204)
    expect(deleted).toEqual(['art_1'])
  })

  it('succeeds on one that is already gone', async () => {
    // The agent is handed a LIST of staged locations and told to clear them up, and that
    // instruction is replayed: a second pass over the same list, or a retry whose first attempt
    // landed, must not fail on a file that is already reclaimed.
    const { app, deleted } = makeApp()
    expect((await discard(app, 'art_1')).status).toBe(204)
    expect(deleted).toEqual([])
  })

  it('refuses another run’s asset, and a screenshot of its own', async () => {
    // The token pins the execution, and a run's screenshots are evidence the visual-confirmation
    // gate reads back rather than the agent's to drop. Answering 204 to either would tell the
    // agent it cleaned up something it did not.
    const { app, deleted } = makeApp({
      art_sibling: record({ id: 'art_sibling', executionId: 'ex_2' }),
      art_shot: record({ id: 'art_shot', kind: 'screenshot' }),
    })
    expect((await discard(app, 'art_sibling')).status).toBe(404)
    expect((await discard(app, 'art_shot')).status).toBe(404)
    expect(deleted).toEqual([])
  })

  it('refuses an unauthenticated caller', async () => {
    const { app, deleted } = makeApp({ art_1: record() })
    const res = await app.fetch(
      new Request('http://x/v1/assets/ingest/art_1', { method: 'DELETE' }),
    )
    expect(res.status).toBe(401)
    expect(deleted).toEqual([])
  })
})
