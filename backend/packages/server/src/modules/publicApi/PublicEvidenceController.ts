import {
  getPublicRunReportContract,
  listPublicRunArtifactsContract,
  type PublicRunArtifact,
} from '@cat-factory/contracts'
import type { BinaryArtifactRecord, BinaryArtifactStore } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { blobResponseHeaders } from '../artifacts/imageArtifacts.js'
import { loadScopedRun } from './decisions/scope.js'
import { authorize, authorizeOrThrow, refuse } from './publicApiAuth.js'

// The public run-EVIDENCE surface: a run's verification report, the binary artifacts it
// captured, and those artifacts' bytes.
//
// All three were reachable only from a browser session, which made a consumer whose job is to
// JUDGE a run — a trial harness deciding whether to accept a change, an evaluation pipeline
// scoring a fleet — dependent on scraping the fenced JSON block out of a pull-request body, and
// left the captured screenshots unreachable entirely (the caveat `docs/initiatives/
// public-api-additions.md` records against its visual-confirmation slice: "a caller approving a
// visual-confirmation gate off this projection is approving screenshots it has not seen").
//
// Five rules shape this controller:
//
//  1. **`read` scope, like the debug surface and for the same reason.** These are reads. Gating
//     them behind `admin` — which on this API also merges pull requests and deletes tasks —
//     would mean handing an auditing integration a destructive key to look at a screenshot.
//  2. **The run-scoped reads resolve through `loadScopedRun`, NOT the debug surface's wider
//     workspace rule**, even though a `read` key can already reach far more sensitive material
//     through `/api/v1/debug/*`. What decides it is not how much is exposed but that ONE prefix
//     may carry only ONE access semantic: `/api/v1/runs/:runId/*` already means "a run this key
//     could reach through `GET /jobs/:id` or `GET /tasks/:taskId/run`" (the decision routes), and
//     mounting a wider rule beside them would put two authorization models behind one path — the
//     trap `debug-api.md` records as the reason the debug reads are NOT under this prefix. The
//     set that costs is frame/module-anchored runs (a blueprint, a bug-intake sweep), which carry
//     no task and no pull request and so have no verification story to tell.
//  3. **The BYTES are addressed by their own id and scoped to the workspace**, which is the same
//     rule every point read on this API follows (`/api/v1/debug/llm-calls/:callId` re-applies the
//     key's workspace to the row it loads and nothing else). Nesting the blob under its run would
//     force a caller that already holds an id — handed to it by the list — to remember where it
//     came from, and would let a mismatched pair form a request that looks well-typed and 404s
//     for a reason the caller cannot see.
//  4. **The report is the ENGINE's, composed not stored.** It is built on read from the run's
//     persisted state by the same code that writes the pull-request section, so the two can
//     never disagree. It costs the reads that composition costs; there is no snapshot to serve
//     instead, and a stored one would go stale the moment a gate settled.
//  5. **Bytes leave through a hand-mounted route.** An image response is not JSON, so the blob
//     endpoint cannot be a route contract; it is documented by hand in the OpenAPI generator and
//     hand-written in each SDK transport, the same treatment the two SSE endpoints get.

/** Project a stored artifact row onto the wire, dropping the storage vocabulary. */
function artifactToWire(record: BinaryArtifactRecord): PublicRunArtifact {
  return {
    artifactId: record.id,
    kind: record.kind,
    view: record.view,
    contentType: record.contentType,
    byteSize: record.byteSize,
    hash: record.hash,
    createdAt: record.createdAt,
  }
}

/**
 * Resolve the workspace's binary-artifact store, or `null` when the account configured no blob
 * backend. Null is a 503 and never an empty list: "this deployment stores no artifacts" and
 * "this run captured none" are different facts, and only one of them is about the run.
 */
async function artifactStore<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<BinaryArtifactStore | null> {
  const resolve = c.get('container').resolveBinaryArtifactStore
  return resolve ? await resolve(workspaceId) : null
}

const unavailable = <E extends AppEnv>(c: Context<E>, message: string) =>
  c.json({ error: { code: 'unavailable', message } }, 503)

const notFound = <E extends AppEnv>(c: Context<E>, what: string) =>
  c.json({ error: { code: 'not_found', message: `No such ${what}` } }, 404)

export function publicEvidenceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's verification report — the same bundle the pull request carries, for the runs that
  // have a pull request AND the ones that never opened one.
  buildHonoRoute(app, getPublicRunReportContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    if (!(await loadScopedRun(c, workspaceId, runId))) return notFound(c, 'run')
    const report = await c
      .get('container')
      .executionService.composeVerificationReport(workspaceId, runId)
    // One 404 for "no such run this key may read" and for "the run's task is gone", because from
    // outside they are the same thing: there is nothing to report on under that id.
    return report ? c.json(report, 200) : notFound(c, 'run')
  })

  // The run's captured artifacts (metadata). Unpaged: the capture path caps how many one run may
  // store, so the response size is computable before the request.
  buildHonoRoute(app, listPublicRunArtifactsContract, async (c) => {
    const gate = await authorize(c, 'read')
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    const store = await artifactStore(c, workspaceId)
    if (!store) return unavailable(c, 'Binary-artifact storage is not configured')
    // Resolve the run before listing, so a mistyped (or out-of-scope) id answers "no such run"
    // rather than an empty list a caller would read as "this run captured nothing".
    if (!(await loadScopedRun(c, workspaceId, runId))) return notFound(c, 'run')
    return c.json(
      { artifacts: (await store.listByExecution(workspaceId, runId)).map(artifactToWire) },
      200,
    )
  })

  // One artifact's BYTES. Hand-mounted rather than a route contract (the response is an image),
  // so the refusals here are thrown `DomainError`s / hand-built envelopes rather than a
  // contract-typed body — see `authorizeOrThrow`.
  //
  app.get('/api/v1/artifacts/:artifactId/blob', async (c) => {
    const auth = await authorizeOrThrow(c, 'read')
    const store = await artifactStore(c, auth.workspaceId)
    if (!store) return unavailable(c, 'Binary-artifact storage is not configured')
    const got = await store.getBlobWithMetadata(auth.workspaceId, param(c, 'artifactId'))
    if (!got) return notFound(c, 'artifact')
    // A row whose bytes are gone from the backend is its own 404 and not an empty 200: a
    // zero-byte image would read as a screenshot of nothing.
    if (!got.bytes) return notFound(c, 'artifact blob')
    // Uint8Array is a valid BodyInit on both runtimes (workerd + Node/undici); the cast satisfies
    // the narrower ambient BodyInit type this package compiles against. The headers clamp the
    // type to the image allow-list and send `nosniff`, exactly as the session-authed blob route
    // does — the bytes are attacker-influenced (an agent captured them) whichever door they
    // leave by.
    return new Response(got.bytes as unknown as BodyInit, {
      status: 200,
      headers: blobResponseHeaders(got.record.contentType),
    })
  })

  return app
}
