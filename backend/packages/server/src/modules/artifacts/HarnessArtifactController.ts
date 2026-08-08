import { Hono } from 'hono'
import type { Context } from 'hono'
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
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { UnavailableError, UnauthorizedError } from '@cat-factory/kernel'
import { reclaimArtifactOverflow, reserveArtifactSlot } from './artifactSetCap.js'

/**
 * Cap on how many screenshots a single run may upload. A `tester-ui` run captures one shot per
 * distinct view, so a couple of dozen is generous; the ceiling stops a buggy or compromised
 * container from filling the blob store with unbounded uploads before retention sweeps it. The
 * count is read back from the store per ingest (cheap, indexed by execution).
 */
const MAX_SCREENSHOTS_PER_RUN = 100

/** One run's capture set, as {@link reserveArtifactSlot} / {@link reclaimArtifactOverflow} see it. */
function runCap(store: BinaryArtifactStore, workspaceId: string, executionId: string) {
  return {
    limit: MAX_SCREENSHOTS_PER_RUN,
    count: () => store.countByExecution(workspaceId, executionId),
    list: () => store.listByExecution(workspaceId, executionId),
    remove: (id: string) => store.delete(workspaceId, id),
  }
}

/** The one refusal both cap checks answer with, so the pre-check and the reconcile cannot differ. */
function refuseFullRun<E extends AppEnv>(c: Context<E>, executionId: string) {
  logger.warn('artifact ingest: per-run screenshot limit reached', {
    scope: 'artifactIngest',
    executionId,
    limit: MAX_SCREENSHOTS_PER_RUN,
  })
  return c.json({ error: { code: 'too_many', message: 'Per-run screenshot limit reached' } }, 429)
}

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
      const resolveStore = container.resolveBinaryArtifactStore
      if (!resolveStore) {
        throw new UnavailableError('Artifact storage not configured')
      }
      const secret = container.config.auth.sessionSecret
      if (!secret) {
        logger.error('artifact ingest: session secret not configured', { scope: 'artifactIngest' })
        throw new UnavailableError('Artifact ingest not configured')
      }
      const sessions = new ContainerSessionService({ secret })
      const session = await sessions.verify(bearerToken(c))
      if (!session) {
        logger.warn('artifact ingest: invalid or expired session token', {
          scope: 'artifactIngest',
        })
        throw new UnauthorizedError('Invalid or expired token')
      }

      // The store is the run's ACCOUNT's configured backend, resolved from the token's
      // workspace (never the request body) — so a container can only write to its own
      // account's storage. Null ⇒ the account configured no storage.
      const store = await resolveStore(session.workspaceId)
      if (!store) {
        throw new UnavailableError('Artifact storage not configured')
      }

      // Refuse a grossly oversized body from Content-Length before it is buffered into memory; the
      // exact per-file ceiling is still enforced after parsing below.
      if (exceedsRequestSizeLimit(c.req.header('content-length'))) {
        return c.json({ error: { code: 'too_large', message: 'Artifact exceeds size limit' } }, 413)
      }

      // Per-run upload ceiling (fast-path): a runaway/compromised container can't fill the store
      // with unbounded screenshots scoped to its run. The shared cap rejects the steady-state case
      // cheaply via an indexed COUNT (no row materialise); concurrent ingests that race past it are
      // caught by the post-insert reconcile below, so the effective ceiling holds even without a
      // DB-level atomic counter.
      const cap = runCap(store, session.workspaceId, session.executionId)
      const priorCount = await reserveArtifactSlot(cap)
      if (priorCount === null) {
        return refuseFullRun(c, session.executionId)
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
      // Check-then-act, so a burst of parallel ingests can each pass the pre-check before any row
      // lands; the reconcile rolls THIS record back when it is the one that overflowed, leaving the
      // oldest `MAX_SCREENSHOTS_PER_RUN` untouched.
      if (await reclaimArtifactOverflow(cap, priorCount, record.id)) {
        return refuseFullRun(c, session.executionId)
      }
      return c.json({ artifactId: record.id }, 201)
    },
  )

  return app
}
