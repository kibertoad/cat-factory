import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { reclaimArtifactOverflow, reserveArtifactSlot } from './artifactSetCap.js'
import { requireHarnessSession } from './harnessSession.js'
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_REQUEST_BYTES,
  MAX_ASSETS_PER_RUN,
  normalizeAssetContentType,
} from './assetArtifacts.js'

// ---------------------------------------------------------------------------
// The in-container ASSET ingest endpoint: where a binary-output step's deliverables land when the
// step stores through the platform's own asset storage (`platform-assets`, the `builtin`
// foundational service kernel registers). Reachable at `${proxyBaseUrl}/assets/ingest`, authed by
// the SAME container session token the LLM proxy and the screenshot ingest already use.
//
// Its own route rather than a `kind` field on the screenshot ingest, because every policy on it
// differs: what content types are accepted (a generated asset is not always an image), how large
// one file may be, how many one run may store, and — the one that matters most — what happens to
// the row afterwards. A screenshot is run debris the retention sweep reclaims; an asset is the
// thing the run was started to produce and is exempt from it (see `RETAINED_BINARY_ARTIFACT_KINDS`).
// One route with a mode flag would have made the retention decision a request parameter.
//
// The RESPONSE shape is the contract's, and it is what the agent copies into its declaration
// block: `location` is the artifact id, which is the only handle anyone has on the bytes
// afterwards, and it is what the SPA resolves back into a preview and a download.
// ---------------------------------------------------------------------------

/** One run's asset set, as {@link reserveArtifactSlot} / {@link reclaimArtifactOverflow} see it. */
function assetCap(store: BinaryArtifactStore, workspaceId: string, executionId: string) {
  return {
    limit: MAX_ASSETS_PER_RUN,
    count: () => store.countByExecution(workspaceId, executionId),
    list: () => store.listByExecution(workspaceId, executionId),
    remove: (id: string) => store.delete(workspaceId, id),
  }
}

/** The one refusal both cap checks answer with, so the pre-check and the reconcile cannot differ. */
function refuseFullRun<E extends AppEnv>(c: Context<E>, executionId: string) {
  logger.warn('asset ingest: per-run asset limit reached', {
    scope: 'assetIngest',
    executionId,
    limit: MAX_ASSETS_PER_RUN,
  })
  return c.json({ error: { code: 'too_many', message: 'Per-run asset limit reached' } }, 429)
}

/**
 * `POST /v1/assets/ingest` — store one generated asset and answer with its location.
 *
 * Note what the run's cap counts: EVERY artifact the run holds, screenshots included, not the
 * assets alone. A per-kind count would need a second indexed read and the ceiling exists to bound
 * one container's total writes, which is a question about the run rather than about a kind.
 */
export function harnessAssetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.post(
    '/v1/assets/ingest',
    // Hard backstop on the buffered body: `bodyLimit` counts bytes as the stream is read, so a
    // chunked body or a spoofed `Content-Length` cannot buffer past the ceiling.
    bodyLimit({
      maxSize: MAX_ASSET_REQUEST_BYTES,
      onError: (c) =>
        c.json({ error: { code: 'too_large', message: 'Asset exceeds size limit' } }, 413),
    }),
    async (c) => {
      const { session, store } = await requireHarnessSession(c, 'assetIngest')

      const declaredLength = Number(c.req.header('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_REQUEST_BYTES) {
        return c.json({ error: { code: 'too_large', message: 'Asset exceeds size limit' } }, 413)
      }

      // Check-then-act, reconciled after the insert: a burst of parallel ingests can each pass
      // the pre-check before any row lands, and the reconcile rolls back the one that overflowed.
      const cap = assetCap(store, session.workspaceId, session.executionId)
      const priorCount = await reserveArtifactSlot(cap)
      if (priorCount === null) return refuseFullRun(c, session.executionId)

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
      // No default for a typeless upload, unlike the screenshot path: an asset could be anything,
      // and a guessed type is a mislabelled row somebody later downloads by.
      const contentType = normalizeAssetContentType(file.type)
      if (!contentType) {
        return c.json(
          {
            error: {
              code: 'unsupported_media',
              message:
                'Declare the asset’s media type on the file part. Images, audio, video, 3D ' +
                'models, PDFs and zipped bundles are accepted; SVG and markup are not.',
            },
          },
          415,
        )
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        return c.json({ error: { code: 'too_large', message: 'Asset exceeds size limit' } }, 413)
      }
      const name = form.get('name')
      const record = await store.store({
        meta: {
          workspaceId: session.workspaceId,
          executionId: session.executionId,
          blockId: null,
          kind: 'asset',
          // The agent's own label for what this depicts, reused as the artifact's `view` — the
          // column already means "which thing is this one of" for a screenshot, and inventing a
          // second one would leave two half-filled labels on one table.
          view: typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null,
          contentType,
        },
        blob: bytes,
      })
      if (await reclaimArtifactOverflow(cap, priorCount, record.id)) {
        return refuseFullRun(c, session.executionId)
      }
      return c.json(
        { location: record.id, contentType: record.contentType, byteSize: record.byteSize },
        201,
      )
    },
  )

  return app
}
