import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { bearerToken } from '../../auth/middleware.js'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  exceedsRequestSizeLimit,
  normalizeImageContentType,
} from './imageArtifacts.js'

/**
 * Cap on how many screenshots a single run may upload. A `tester-ui` run captures one shot per
 * distinct view, so a couple of dozen is generous; the ceiling stops a buggy or compromised
 * container from filling the blob store with unbounded uploads before retention sweeps it. The
 * count is read back from the store per ingest (cheap, indexed by execution).
 */
const MAX_SCREENSHOTS_PER_RUN = 100

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

  app.post(
    '/v1/artifacts/ingest',
    // Hard backstop on the buffered body: `bodyLimit` counts bytes as the stream is read, so a
    // body with NO Content-Length (chunked) or a spoofed header can't buffer past the ceiling
    // (the `exceedsRequestSizeLimit` precheck below is just the cheap early-out for honest clients).
    bodyLimit({
      maxSize: MAX_REQUEST_BYTES,
      onError: (c) =>
        c.json({ error: { code: 'too_large', message: 'Artifact exceeds size limit' } }, 413),
    }),
    async (c) => {
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
      const session = await sessions.verify(bearerToken(c))
      if (!session) {
        logger.warn(
          { scope: 'artifactIngest' },
          'artifact ingest: invalid or expired session token',
        )
        return c.json({ error: { code: 'unauthorized', message: 'Invalid or expired token' } }, 401)
      }

      // Refuse a grossly oversized body from Content-Length before it is buffered into memory; the
      // exact per-file ceiling is still enforced after parsing below.
      if (exceedsRequestSizeLimit(c.req.header('content-length'))) {
        return c.json({ error: { code: 'too_large', message: 'Artifact exceeds size limit' } }, 413)
      }

      // Per-run upload ceiling (fast-path): a runaway/compromised container can't fill the store
      // with unbounded screenshots scoped to its run. This pre-check rejects the steady-state case
      // cheaply via an indexed COUNT (no row materialise); concurrent ingests that race past it are
      // caught by the post-insert reconcile below, so the effective ceiling holds even without a
      // DB-level atomic counter.
      const existingCount = await store.countByExecution(session.workspaceId, session.executionId)
      if (existingCount >= MAX_SCREENSHOTS_PER_RUN) {
        logger.warn(
          { scope: 'artifactIngest', executionId: session.executionId, count: existingCount },
          'artifact ingest: per-run screenshot limit reached',
        )
        return c.json(
          { error: { code: 'too_many', message: 'Per-run screenshot limit reached' } },
          429,
        )
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
      // Screenshots are always PNGs. Tolerate a typeless upload (default to PNG), but REJECT a
      // recognised non-image type rather than silently storing it mislabelled — keeping this path's
      // content-type posture aligned with the workspace upload endpoint (both gate on the shared
      // image allow-list in imageArtifacts.ts).
      const declaredType = file.type?.trim()
      let contentType: string
      if (!declaredType) {
        contentType = 'image/png'
      } else {
        const normalized = normalizeImageContentType(declaredType)
        if (!normalized) {
          return c.json(
            {
              error: {
                code: 'unsupported_media',
                message: 'Only raster image screenshots are accepted',
              },
            },
            415,
          )
        }
        contentType = normalized
      }
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
      // Reconcile the cap against concurrent inserts: the pre-check is check-then-act, so a burst
      // of parallel ingests can each pass it before any row lands. We only need to run this
      // (which materialises the run's rows to find the overflow tail) when the insert COULD have
      // crossed the cap — i.e. the pre-check count was already at the edge. Steady-state uploads
      // far below the cap skip it entirely, so the common path is one COUNT + one insert.
      if (existingCount + 1 >= MAX_SCREENSHOTS_PER_RUN) {
        // listByExecution is oldest-first, so anything at index >= the cap is overflow; if THIS
        // record is in that tail, roll it back (delete its row + bytes) and reject. The oldest
        // `MAX_SCREENSHOTS_PER_RUN` always survive, so the store is bounded to exactly the cap per
        // run without dropping legitimate earlier shots.
        const after = await store.listByExecution(session.workspaceId, session.executionId)
        if (after.length > MAX_SCREENSHOTS_PER_RUN) {
          const overflow = new Set(after.slice(MAX_SCREENSHOTS_PER_RUN).map((r) => r.id))
          if (overflow.has(record.id)) {
            await store.delete(session.workspaceId, record.id)
            logger.warn(
              { scope: 'artifactIngest', executionId: session.executionId, count: after.length },
              'artifact ingest: per-run screenshot limit reached (post-insert reconcile)',
            )
            return c.json(
              { error: { code: 'too_many', message: 'Per-run screenshot limit reached' } },
              429,
            )
          }
        }
      }
      return c.json({ artifactId: record.id }, 201)
    },
  )

  return app
}
