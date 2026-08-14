import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from '../../http/env.js'
import { logger } from '../../observability/logger.js'
import type { BinaryArtifactStore } from '@cat-factory/kernel'
import { NotFoundError } from '@cat-factory/kernel'
import { reclaimArtifactOverflow, reserveArtifactSlot } from './artifactSetCap.js'
import { requireHarnessSession } from './harnessSession.js'
import {
  MAX_ASSET_BYTES,
  MAX_ASSET_REQUEST_BYTES,
  MAX_ASSETS_PER_RUN,
  normalizeAssetContentType,
} from './assetArtifacts.js'

// ---------------------------------------------------------------------------
// The in-container ASSET endpoints: where a binary-output step's deliverables land when the step
// stores through the platform's own asset storage (`platform-assets`, the `builtin` foundational
// service kernel registers), and where it reclaims the ones a person discarded. Reachable under
// `${proxyBaseUrl}/assets/ingest`, authed by the SAME container session token the LLM proxy and
// the screenshot ingest already use.
//
// Its own route rather than a `kind` field on the screenshot ingest, because every policy on it
// differs: what content types are accepted (a generated asset is not always an image), how large
// one file may be, how many one run may store, and, the one that matters most, what happens to
// the row afterwards. A screenshot is run debris the retention sweep reclaims; an asset is the
// thing the run was started to produce and is exempt from it (see `RETAINED_BINARY_ARTIFACT_KINDS`).
// One route with a mode flag would have made the retention decision a request parameter.
//
// TWO operations, because the exemption is what makes the second one load-bearing. A candidate
// pass stages several files per subject and a person keeps one; the discarded ones are ordinary
// stored assets, so no clock ever reclaims them. Without a delete the shipped Media preset would
// accumulate every rejected render for the life of the workspace, and the second-phase brief's
// instruction to "remove the staged files where the storage service allows it" would resolve, on
// the one storage service every deployment has, to "it does not".
//
// The RESPONSE shape is the contract's, and it is what the agent copies into its declaration
// block: `location` is the artifact id, which is the only handle anyone has on the bytes
// afterwards, and it is what the SPA resolves back into a preview and a download.
//
// Each operation is mounted under BOTH the bare path and its trailing-slash spelling. Hono routes
// strictly, and the contract the agent reads is an OpenAPI document whose server URL is the whole
// endpoint (`ARTIFACT_UPLOAD_URL` is per-run and per-transport, so it cannot be a `servers` entry
// this package writes down). An OpenAPI operation cannot be pathless, so the document declares
// `POST /`, and a client that composes base + path emits the trailing slash. Serving one spelling
// and publishing the other is a 404 the agent can do nothing about.
// ---------------------------------------------------------------------------

/** The ingest path and the spelling a base-plus-`/` composition produces. See the header. */
const INGEST_PATHS = ['/v1/assets/ingest', '/v1/assets/ingest/']

/** The reclaim path, under the ingest one so both compose off the same published base URL. */
const RECLAIM_PATHS = ['/v1/assets/ingest/:location', '/v1/assets/ingest/:location/']

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

/** The one 413, so the pre-buffer backstop and the post-parse check cannot word it differently. */
function refuseTooLarge<E extends AppEnv>(c: Context<E>) {
  return c.json({ error: { code: 'too_large', message: 'Asset exceeds size limit' } }, 413)
}

/**
 * `POST /v1/assets/ingest` stores one generated asset and answers with its location.
 * `DELETE /v1/assets/ingest/:location` reclaims one this run stored.
 *
 * Note what the run's cap counts: EVERY artifact the run holds, screenshots included, not the
 * assets alone. A per-kind count would need a second indexed read and the ceiling exists to bound
 * one container's total writes, which is a question about the run rather than about a kind.
 */
export function harnessAssetController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.on(
    'POST',
    INGEST_PATHS,
    // Hard backstop on the buffered body: `bodyLimit` counts bytes as the stream is read, so a
    // chunked body or a spoofed `Content-Length` cannot buffer past the ceiling.
    bodyLimit({ maxSize: MAX_ASSET_REQUEST_BYTES, onError: (c) => refuseTooLarge(c) }),
    async (c) => {
      const { session, store } = await requireHarnessSession(c, 'assetIngest')

      const declaredLength = Number(c.req.header('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ASSET_REQUEST_BYTES) {
        return refuseTooLarge(c)
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
      // The part's own size, BEFORE `arrayBuffer()`. The read is a second full copy of the bytes
      // (the parser already holds one), so checking after it would double the peak of exactly the
      // upload being refused, on a facade whose isolate has a fixed memory ceiling. `MAX_ASSET_BYTES`
      // says why the number is what it is.
      if (file.size > MAX_ASSET_BYTES) return refuseTooLarge(c)
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
      // The authoritative check, kept beside the pre-check: `file.size` is what the parser
      // reported and this is what it actually handed over.
      if (bytes.byteLength > MAX_ASSET_BYTES) return refuseTooLarge(c)
      const name = form.get('name')
      const record = await store.store({
        meta: {
          workspaceId: session.workspaceId,
          executionId: session.executionId,
          blockId: null,
          kind: 'asset',
          // The agent's own label for what this depicts, reused as the artifact's `view`: the
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

  /**
   * Reclaim one asset THIS RUN stored.
   *
   * Deleting something already gone SUCCEEDS. The agent is handed a list of staged locations and
   * told to clear them up, and that instruction is replayed: a second pass over the same list, or
   * a retried request whose first attempt landed, must not fail on a file that is already
   * reclaimed. An absent row is therefore 204, which is also the honest answer, since a row that
   * never existed and a row this run deleted a moment ago are the same state.
   *
   * A row that DOES exist and is not this run's `asset` is refused instead, loudly. The token is
   * workspace- AND execution-pinned, so a container cannot reach a sibling run's deliverables,
   * and a run's screenshots are evidence the visual-confirmation gate reads back rather than the
   * agent's to drop. Answering 204 there would tell the agent it cleaned up something it did not,
   * which is the one outcome worse than a refusal it can report. The distinction is visible only
   * to a caller already authenticated for this workspace, and only over ids in it.
   */
  app.on('DELETE', RECLAIM_PATHS, async (c) => {
    const { session, store } = await requireHarnessSession(c, 'assetReclaim')
    const id = c.req.param('location') ?? ''
    const record = await store.getMetadata(session.workspaceId, id)
    if (!record) return c.body(null, 204)
    if (record.executionId !== session.executionId || record.kind !== 'asset') {
      logger.warn('asset reclaim: refused a location this run does not own', {
        scope: 'assetReclaim',
        executionId: session.executionId,
        artifactId: id,
        kind: record.kind,
      })
      throw new NotFoundError('Asset', id, { reason: 'asset_not_found' })
    }
    await store.delete(session.workspaceId, id)
    return c.body(null, 204)
  })

  return app
}
