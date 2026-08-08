import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { bearerToken } from '../../auth/middleware.js'
import { ContainerSessionService } from '../../containers/ContainerSessionService.js'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import {
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  blobResponseHeaders,
  exceedsRequestSizeLimit,
  normalizeImageContentType,
} from './imageArtifacts.js'
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { NotFoundError, UnavailableError, UnauthorizedError } from '@cat-factory/kernel'
import type { Context } from 'hono'
import type { ContainerSession } from '../../containers/ContainerSessionService.js'

/**
 * Cap on how many screenshots a single run may upload. A `tester-ui` run captures one shot per
 * distinct view, so a couple of dozen is generous; the ceiling stops a buggy or compromised
 * container from filling the blob store with unbounded uploads before retention sweeps it. The
 * count is read back from the store per ingest (cheap, indexed by execution).
 */
const MAX_SCREENSHOTS_PER_RUN = 100

/**
 * Resolve the stored content type for an uploaded screenshot. Screenshots are always PNGs, so a
 * typeless upload defaults to PNG; a declared type is gated through the shared image allow-list.
 * Returns the normalized content type, or `null` for a recognised non-image type (which the caller
 * rejects with 415 rather than storing mislabelled).
 */
function resolveScreenshotContentType(declaredType: string | undefined): string | null {
  const trimmed = declaredType?.trim()
  if (!trimmed) {
    return 'image/png'
  }
  return normalizeImageContentType(trimmed)
}

/**
 * Verify the container session token on a harness request and resolve the store its run may use.
 *
 * One helper for both directions of the seam (the tester's screenshot ingest and the reference
 * download beside it), so the two can never end up disagreeing about what authenticates a
 * container: the SAME short-lived, workspace- and execution-pinned token the agent already holds
 * for the LLM proxy, and a store resolved from the token's workspace rather than from anything the
 * request says.
 */
async function requireHarnessSession(
  c: Context<AppEnv>,
  scope: string,
): Promise<{ session: ContainerSession; store: BinaryArtifactStore }> {
  const container = c.get('container')
  const resolveStore = container.resolveBinaryArtifactStore
  if (!resolveStore) {
    throw new UnavailableError('Artifact storage not configured')
  }
  const secret = container.config.auth.sessionSecret
  if (!secret) {
    logger.error('harness artifacts: session secret not configured', { scope })
    throw new UnavailableError('Artifact ingest not configured')
  }
  const sessions = new ContainerSessionService({ secret })
  const session = await sessions.verify(bearerToken(c))
  if (!session) {
    logger.warn('harness artifacts: invalid or expired session token', { scope })
    throw new UnauthorizedError('Invalid or expired token')
  }
  // The store is the run's ACCOUNT's configured backend, resolved from the token's workspace
  // (never the request), so a container only ever reaches its own account's storage. Null means the
  // account configured no storage.
  const store = await resolveStore(session.workspaceId)
  if (!store) {
    throw new UnavailableError('Artifact storage not configured')
  }
  return { session, store }
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
      const { session, store } = await requireHarnessSession(c, 'artifactIngest')

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
        logger.warn('artifact ingest: per-run screenshot limit reached', {
          scope: 'artifactIngest',
          executionId: session.executionId,
          count: existingCount,
        })
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
      const contentType = resolveScreenshotContentType(file.type)
      if (!contentType) {
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
              'artifact ingest: per-run screenshot limit reached (post-insert reconcile)',
              { scope: 'artifactIngest', executionId: session.executionId, count: after.length },
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

  // Stream one REFERENCE design image back into a container: the other direction of the ingest
  // seam above, and what turns the manifest in a capturing job's body into the files under
  // `.cat-context/reference-screenshots/`. Same auth (the run's own container session token),
  // same store resolution (from the token's workspace, never the request).
  //
  // Two things bound what this can serve. It is scoped to the token's WORKSPACE, so a container
  // can never read another board's designs; and it serves only `kind:'reference'`, so this route
  // cannot become a way for one run to read another run's captured SCREENSHOTS, which is the
  // asymmetry that matters, since references are design material the run was handed on purpose
  // while a screenshot is another run's output. Anything outside that is a 404 rather than a 403:
  // a container has no business learning which artifact ids exist.
  app.get('/v1/artifacts/reference/:id', async (c) => {
    const { session, store } = await requireHarnessSession(c, 'artifactReference')
    const id = c.req.param('id')
    const got = await store.getBlobWithMetadata(session.workspaceId, id)
    // Same two REASONS the public blob route separates, for the same reason: "not yours (or not a
    // reference)" is something to stop asking for, where a metadata row that outlived its bytes is
    // a storage fault. The harness reports either as a reference it could not fetch.
    if (!got || got.record.kind !== 'reference') {
      throw new NotFoundError('Artifact', id, { reason: 'artifact_not_found' })
    }
    if (!got.bytes) {
      throw new NotFoundError('Artifact', id, { reason: 'artifact_blob_missing' })
    }
    // Same headers as the workspace-scoped serve path: the content type is clamped to the image
    // allow-list and `nosniff` is sent, so bytes stored before a tightening can never be served
    // as active content.
    return new Response(got.bytes as unknown as BodyInit, {
      status: 200,
      headers: blobResponseHeaders(got.record.contentType),
    })
  })

  return app
}
