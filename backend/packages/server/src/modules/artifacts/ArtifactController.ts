import { Hono } from 'hono'
import type { Context } from 'hono'
import type { BinaryArtifactKind, BinaryArtifactStore } from '@cat-factory/kernel'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import {
  MAX_UPLOAD_BYTES,
  blobResponseHeaders,
  normalizeImageContentType,
} from './imageArtifacts.js'

/** Resolve the binary-artifact store or send a 503, returning null when unconfigured. */
function requireStore<E extends AppEnv>(c: Context<E>): BinaryArtifactStore | null {
  return c.get('container').binaryArtifactStore ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Binary-artifact storage is not configured' } },
    503,
  )

const ALLOWED_KINDS: BinaryArtifactKind[] = ['screenshot', 'reference']

/**
 * Workspace-scoped binary-artifact API backing the visual-confirmation gate: upload a
 * reference design image, stream a stored blob, and list a run's artifacts (metadata).
 * Mounted under `/workspaces/:workspaceId`. The blob bytes never expose the storage
 * backend — they're streamed through this authenticated endpoint. The in-container
 * screenshot ingest (container-token authed) is a separate route on the harness path.
 */
export function artifactController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Upload a reference design image (multipart: `file` + `kind`/`view`/`blockId`/`executionId`).
  app.post('/artifacts', async (c) => {
    const store = requireStore(c)
    if (!store) return unavailable(c)
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: { code: 'invalid_body', message: 'Expected multipart form' } }, 400)
    }
    const file = form.get('file')
    if (!(file instanceof File)) {
      return c.json({ error: { code: 'invalid_body', message: 'Missing `file`' } }, 400)
    }
    const kind = String(form.get('kind') ?? 'reference') as BinaryArtifactKind
    if (!ALLOWED_KINDS.includes(kind)) {
      return c.json({ error: { code: 'invalid_kind', message: 'Unknown artifact kind' } }, 400)
    }
    // Reject anything that isn't an allowed raster image. An attacker-controlled content
    // type (HTML, SVG) served back inline same-origin from the blob endpoint would be a
    // stored-XSS vector, so the type is pinned to the allow-list at the write boundary.
    const contentType = normalizeImageContentType(file.type)
    if (!contentType) {
      return c.json(
        {
          error: {
            code: 'unsupported_media',
            message: 'Only PNG/JPEG/WebP/GIF images are accepted',
          },
        },
        415,
      )
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: { code: 'too_large', message: 'Artifact exceeds size limit' } }, 413)
    }
    const view = form.get('view')
    const blockId = form.get('blockId')
    const executionId = form.get('executionId')
    const record = await store.store({
      meta: {
        workspaceId: param(c, 'workspaceId'),
        executionId: typeof executionId === 'string' && executionId ? executionId : null,
        blockId: typeof blockId === 'string' && blockId ? blockId : null,
        kind,
        view: typeof view === 'string' && view ? view : null,
        contentType,
      },
      blob: bytes,
    })
    return c.json({ artifact: record }, 201)
  })

  // Stream a stored blob's bytes (the metadata names its content type).
  app.get('/artifacts/:id/blob', async (c) => {
    const store = requireStore(c)
    if (!store) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    const id = param(c, 'id')
    const meta = await store.getMetadata(workspaceId, id)
    if (!meta) return c.json({ error: { code: 'not_found', message: 'Artifact not found' } }, 404)
    const bytes = await store.getBlob(workspaceId, id)
    if (!bytes) return c.json({ error: { code: 'not_found', message: 'Artifact bytes gone' } }, 404)
    // Uint8Array is a valid BodyInit on both runtimes (workerd + Node/undici); the cast
    // satisfies the narrower ambient BodyInit type this package compiles against. Headers
    // clamp the type to the image allow-list + send `nosniff` so the bytes can never be
    // sniffed/served as active content (defence-in-depth with the upload-time allow-list).
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: blobResponseHeaders(meta.contentType),
    })
  })

  // List a run's artifacts (metadata only; the gate pairs screenshots vs references by view).
  app.get('/executions/:executionId/artifacts', async (c) => {
    const store = requireStore(c)
    if (!store) return unavailable(c)
    const artifacts = await store.listByExecution(param(c, 'workspaceId'), param(c, 'executionId'))
    return c.json({ artifacts }, 200)
  })

  // List a block's artifacts (e.g. its uploaded reference design images, which carry no
  // executionId because they're attached before any run).
  app.get('/blocks/:blockId/artifacts', async (c) => {
    const store = requireStore(c)
    if (!store) return unavailable(c)
    const artifacts = await store.listByBlock(param(c, 'workspaceId'), param(c, 'blockId'))
    return c.json({ artifacts }, 200)
  })

  return app
}
