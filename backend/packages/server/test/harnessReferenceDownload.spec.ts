import type { BinaryArtifactRecord } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AppEnv, ServerContainer } from '../src/http/env.js'
import { handleError } from '../src/http/errorHandler.js'
import { harnessArtifactController } from '../src/modules/artifacts/HarnessArtifactController.js'
import { ContainerSessionService } from '../src/containers/ContainerSessionService.js'

// The reference-design DOWNLOAD a capturing container makes: the other direction of the harness
// ingest seam, and what turns the manifest in a job body into files under
// `.cat-context/reference-screenshots/`. What matters here is what it REFUSES: the token pins the
// workspace, and only a reference (never another run's captured screenshot) is servable through it.

const SECRET = 'test-session-secret-0123456789'

function record(over: Partial<BinaryArtifactRecord> = {}): BinaryArtifactRecord {
  return {
    id: 'art_1',
    workspaceId: 'ws_1',
    executionId: null,
    blockId: 'blk_1',
    kind: 'reference',
    view: 'Checkout',
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

function makeApp(
  opts: {
    rows?: Record<string, { record: BinaryArtifactRecord; bytes: Uint8Array | null }>
    /** The deployment configured no blob storage at all. */
    noStore?: boolean
  } = {},
) {
  const rows = opts.rows ?? {
    art_1: { record: record(), bytes: new Uint8Array([1, 2, 3]) },
  }
  const asked: { workspaceId: string; id: string }[] = []
  const store = {
    getBlobWithMetadata: async (workspaceId: string, id: string) => {
      asked.push({ workspaceId, id })
      const row = rows[id]
      // The real stores scope every read to the workspace; the fake refuses exactly where they do.
      return row && row.record.workspaceId === workspaceId ? row : null
    },
  }
  const container = {
    config: { auth: { sessionSecret: SECRET } },
    ...(opts.noStore ? {} : { resolveBinaryArtifactStore: async () => store }),
  } as unknown as ServerContainer
  const app = new Hono<AppEnv>()
  app.use('*', async (c, next) => {
    c.set('container', container)
    await next()
  })
  app.route('/', harnessArtifactController())
  app.onError(handleError)
  return { app, asked }
}

function mintToken(workspaceId = 'ws_1'): Promise<string> {
  return new ContainerSessionService({ secret: SECRET }).mint({
    workspaceId,
    executionId: 'ex_1',
    agentKind: 'tester-ui',
    provider: 'workers-ai',
    model: '@cf/test/model',
  })
}

function get(app: Hono<AppEnv>, id: string, token?: string) {
  return app.fetch(
    new Request(`http://x/v1/artifacts/reference/${id}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  )
}

describe('GET /v1/artifacts/reference/:id', () => {
  it('serves a reference image to the run that was handed it', async () => {
    const { app, asked } = makeApp()

    const res = await get(app, 'art_1', await mintToken())

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    // Same posture as the workspace-scoped serve path: bytes stored before a tightening can
    // never be sniffed into active content.
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    // The workspace comes from the verified token, never from the request.
    expect(asked).toEqual([{ workspaceId: 'ws_1', id: 'art_1' }])
  })

  it('refuses an unsigned or foreign-workspace token', async () => {
    const { app } = makeApp()

    expect((await get(app, 'art_1')).status).toBe(401)
    expect((await get(app, 'art_1', 'not-a-token')).status).toBe(401)
    // A valid token for another board reads nothing of this one's.
    expect((await get(app, 'art_1', await mintToken('ws_2'))).status).toBe(404)
  })

  it('will not serve another run’s captured SCREENSHOT through the reference route', async () => {
    const { app } = makeApp({
      rows: {
        art_1: {
          record: record({ kind: 'screenshot', executionId: 'ex_other' }),
          bytes: new Uint8Array([9]),
        },
      },
    })

    // A reference is material the run was handed on purpose; a screenshot is another run's
    // output. 404 rather than 403: a container has no business learning which ids exist.
    expect((await get(app, 'art_1', await mintToken())).status).toBe(404)
  })

  it('reports a row whose bytes are gone as a miss, not as an empty image', async () => {
    const { app } = makeApp({ rows: { art_1: { record: record(), bytes: null } } })

    // Served as a zero-byte file it would reach the agent as a design with nothing on the screen;
    // as a miss the harness states it and the agent still captures the view.
    expect((await get(app, 'art_1', await mintToken())).status).toBe(404)
  })

  it('answers 503 when the deployment stores no binary artifacts', async () => {
    const { app } = makeApp({ noStore: true })

    expect((await get(app, 'art_1', await mintToken())).status).toBe(503)
  })
})
