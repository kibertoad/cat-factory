import { Hono } from 'hono'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import { MAX_UPLOAD_BYTES, normalizeImageContentType } from './imageArtifacts.js'

/** Pull the bearer token from the Authorization header. */
function bearer(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : null
}

/**
 * The in-container screenshot ingest endpoint for the UI tester (`tester-ui`). It lives on
 * the harness path (mounted at `/`, reachable at `${proxyBaseUrl}/artifacts/ingest`) and is
 * authed by the SAME short-lived container session token the agent already carries for the
 * LLM proxy — NOT a workspace session — so a container can upload its captured screenshots
 * without holding any user credential. The token pins the workspace + execution, so a
 * container can only write artifacts scoped to its own run. Screenshots are stored with
 * `kind:'screenshot'`; the gate reads them back by the artifact ids the agent reports.
 */
export function harnessArtifactController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post('/v1/artifacts/ingest', async (c) => {
    const container = c.get('container')
    const store = container.binaryArtifactStore
    if (!store) {
      return c.json(
        { error: { code: 'unavailable', message: 'Artifact storage not configured' } },
        503,
      )
    }
    const secret = container.config.auth.sessionSecret
    if (!secret) {
      logger.error({ scope: 'artifactIngest' }, 'artifact ingest: session secret not configured')
      return c.json(
        { error: { code: 'unavailable', message: 'Artifact ingest not configured' } },
        503,
      )
    }
    const sessions = new ContainerSessionService({ secret })
    const session = await sessions.verify(bearer(c.req.header('authorization')))
    if (!session) {
      logger.warn({ scope: 'artifactIngest' }, 'artifact ingest: invalid or expired session token')
      return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired token' } }, 401)
    }

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
    const contentType = normalizeImageContentType(file.type) ?? 'image/png'
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength > MAX_UPLOAD_BYTES) {
      return c.json({ error: { code: 'too_large', message: 'Artifact exceeds size limit' } }, 413)
    }
    const view = form.get('view')
    // Workspace + execution come from the verified token (never the request body), so a
    // container can only attach to its own run. Screenshots are run-scoped (no blockId).
    const record = await store.store({
      meta: {
        workspaceId: session.workspaceId,
        executionId: session.executionId,
        blockId: null,
        kind: 'screenshot',
        view: typeof view === 'string' && view ? view : null,
        contentType,
      },
      blob: bytes,
    })
    return c.json({ artifactId: record.id }, 201)
  })

  return app
}
