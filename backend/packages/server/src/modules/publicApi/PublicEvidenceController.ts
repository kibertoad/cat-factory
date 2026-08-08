import {
  getPublicRunOutcomeContract,
  getPublicRunReportContract,
  listPublicRunArtifactsContract,
  type PublicArtifactScope,
  type PublicRunArtifact,
} from '@cat-factory/contracts'
import type { BinaryArtifactRecord, BinaryArtifactStore } from '@cat-factory/kernel'
import { NotFoundError, UnavailableError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { blobResponseHeaders } from '../artifacts/imageArtifacts.js'
import { requireScopedRun, runNotFound } from './decisions/scope.js'
import { authorize, authorizeOrThrow, refuse } from './publicApiAuth.js'

// The public run-EVIDENCE surface: a run's verification report, its outcome summary, the binary
// artifacts it captured, and those artifacts' bytes.
//
// All three were reachable only from a browser session, which made a consumer whose job is to
// JUDGE a run (a trial harness deciding whether to accept a change, an evaluation pipeline
// scoring a fleet) dependent on scraping the fenced JSON block out of a pull-request body, and
// left the captured screenshots unreachable entirely (the caveat
// `backend/docs/adr/0043-public-decision-surface.md` records against the visual-confirmation gate:
// "a caller approving a visual-confirmation gate off this projection is approving screenshots it
// has not seen").
//
// Six rules shape this controller:
//
//  1. **`read` scope, like the debug surface and for the same reason.** These are reads. Gating
//     them behind `admin`, which on this API also merges pull requests and deletes tasks,
//     would mean handing an auditing integration a destructive key to look at a screenshot.
//  2. **The run-scoped reads resolve through `requireScopedRun`, NOT the debug surface's wider
//     workspace rule**, even though a `read` key can already reach far more sensitive material
//     through `/api/v1/debug/*`. What decides it is not how much is exposed but that ONE prefix
//     may carry only ONE access semantic: `/api/v1/runs/:runId/*` already means "a run this key
//     could reach through `GET /jobs/:id` or `GET /tasks/:taskId/run`" (the decision routes), and
//     mounting a wider rule beside them would put two authorization models behind one path: the
//     trap `debug-api.md` records as the reason the debug reads are NOT under this prefix. The
//     set that costs is frame/module-anchored runs (a blueprint, a bug-intake sweep), which carry
//     no task and no pull request and so have no verification story to tell.
//  3. **The BYTES are addressed by their own id and scoped to the workspace**, which is the same
//     rule every point read on this API follows (`/api/v1/debug/llm-calls/:callId` re-applies the
//     key's workspace to the row it loads and nothing else). Nesting the blob under its run would
//     force a caller that already holds an id (handed to it by the list) to remember where it
//     came from, and would let a mismatched pair form a request that looks well-typed and 404s
//     for a reason the caller cannot see.
//  4. **Both reductions are the ENGINE's, composed not stored.** Each is built on read from the
//     run's persisted state: the report by the same code that writes the pull-request section, and
//     the outcome summary by the same pure reduction the SPA's outcome card renders. So no reader
//     of either can be told something the surface it was named after would deny. They cost the
//     reads composition costs; there is no snapshot to serve instead, and a stored one would go
//     stale the moment a gate settled.
//  5. **Bytes leave through a hand-mounted route.** An image response is not JSON, so the blob
//     endpoint cannot be a route contract; it is documented by hand in the OpenAPI generator and
//     hand-written in each SDK transport, the same treatment the two SSE endpoints get.
//  6. **This controller's own refusals THROW**, on the contract routes as much as the hand-mounted
//     one, so the surface answers with one envelope rather than two. A hand-built literal cannot
//     carry `details.reason` (the code a caller branches on), never reaches `handleError`, and so
//     never picks up the `requestId` an operator greps by nor sets the `errorCode` the request
//     metrics count. The one exception is the AUTH gate, which stays `refuse(c, gate.fail)`: that
//     failure is shared DATA produced by `publicApiAuth`, and CLAUDE.md names it as such.

/** Project a stored artifact row onto the wire, dropping the storage vocabulary. */
function artifactToWire(
  record: BinaryArtifactRecord,
  scope: PublicArtifactScope,
): PublicRunArtifact {
  return {
    artifactId: record.id,
    kind: record.kind,
    scope,
    view: record.view,
    contentType: record.contentType,
    byteSize: record.byteSize,
    hash: record.hash,
    createdAt: record.createdAt,
  }
}

/**
 * The workspace's binary-artifact store, or a 503 when this deployment resolves none for it.
 *
 * A total accessor that THROWS rather than a nullable read every route then re-refuses: it is the
 * capability-behind-a-capability shape `http/guards.ts` describes, one rung further in (the
 * resolver is wired by the facade; whether it yields a store is per-workspace account config). A
 * missing store is a 503 and never an empty list, because "this deployment stores no artifacts"
 * and "this run captured none" are different facts and only one of them is about the run.
 */
async function requireArtifactStore<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
): Promise<BinaryArtifactStore> {
  const resolve = c.get('container').resolveBinaryArtifactStore
  const store = resolve ? await resolve(workspaceId) : null
  if (!store) {
    throw new UnavailableError(
      'Binary-artifact storage is not configured',
      'binary_artifact_storage_unconfigured',
    )
  }
  return store
}

/**
 * Everything a run's evidence list should show: the artifacts the RUN captured, plus the ones
 * attached to its TASK, each carrying which anchor it came from.
 *
 * The list used to be `listByExecution` alone, which is where the run's screenshots live, while a
 * reference design is anchored on the BLOCK, deliberately, because it outlives any single run of
 * the task. So a caller enumerating a run's artifacts to compare a screenshot against the design it
 * was judged against saw the screenshot and not the design, and concluded the run captured
 * evidence against nothing. Both halves were individually fetchable through
 * `GET /api/v1/artifacts/:artifactId/blob` the whole time: only the LIST was half the truth, which
 * is the degrade-loudly rule inverted (absent rendering as empty) on the one surface whose job is
 * to say what a run proved.
 *
 * Two reads rather than one, because the two sets have different anchors ON PURPOSE and no single
 * query spans them. Issued together: neither depends on the other, and this is a read a judging
 * consumer makes per run.
 *
 * A row that satisfies BOTH (a screenshot the run captured against its own task, which carries the
 * block id too) is emitted ONCE, as `run`: the run is the more specific anchor, and a duplicated
 * row would make every count taken off this list overstate the evidence. Ordering follows the two
 * reads (the run's own rows first, each store returning oldest-first), so a caller that renders
 * the list in order sees the run's capture before the standing material it was judged against.
 */
async function listRunArtifacts(
  store: BinaryArtifactStore,
  workspaceId: string,
  runId: string,
  blockId: string,
): Promise<PublicRunArtifact[]> {
  const [captured, onTask] = await Promise.all([
    store.listByExecution(workspaceId, runId),
    store.listByBlock(workspaceId, blockId),
  ])
  const seen = new Set(captured.map((record) => record.id))
  return [
    ...captured.map((record) => artifactToWire(record, 'run')),
    ...onTask
      .filter((record) => !seen.has(record.id))
      .map((record) => artifactToWire(record, 'task')),
  ]
}

export function publicEvidenceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The run's verification report: the same bundle the pull request carries, for the runs that
  // have a pull request AND the ones that never opened one.
  buildHonoRoute(app, getPublicRunReportContract, async (c) => {
    const gate = await authorize(c, getPublicRunReportContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    await requireScopedRun(c, workspaceId, runId)
    const report = await c
      .get('container')
      .executionService.composeVerificationReport(workspaceId, runId)
    // One 404 for "no such run this key may read" and for "the run's task is gone", because from
    // outside they are the same thing: there is nothing to report on under that id.
    if (!report) throw runNotFound(runId)
    return c.json(report, 200)
  })

  // The run's OUTCOME summary: the same reduction the app's outcome card renders, for a consumer
  // reporting what shipped to a person rather than auditing it. Composed from the same run
  // evidence as the report above, through the same loader and the same coverage rules.
  buildHonoRoute(app, getPublicRunOutcomeContract, async (c) => {
    const gate = await authorize(c, getPublicRunOutcomeContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    await requireScopedRun(c, workspaceId, runId)
    const outcome = await c.get('container').executionService.composeRunOutcome(workspaceId, runId)
    // Same 404 as the report's, for the same reason: from outside, "no such run this key may
    // read" and "the run's task is gone" are one fact: there is nothing to summarise under
    // that id.
    if (!outcome) throw runNotFound(runId)
    return c.json(outcome, 200)
  })

  // The run's artifacts (metadata): what it CAPTURED, plus what its task carries. Unpaged: the
  // capture path caps how many one run may store, so the response size is computable up front.
  buildHonoRoute(app, listPublicRunArtifactsContract, async (c) => {
    const gate = await authorize(c, listPublicRunArtifactsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    const store = await requireArtifactStore(c, workspaceId)
    // Resolve the run before listing, so a mistyped (or out-of-scope) id answers "no such run"
    // rather than an empty list a caller would read as "this run captured nothing".
    const scoped = await requireScopedRun(c, workspaceId, runId)
    return c.json(
      { artifacts: await listRunArtifacts(store, workspaceId, runId, scoped.blockId) },
      200,
    )
  })

  // One artifact's BYTES. Hand-mounted rather than a route contract (the response is an image),
  // so its refusals cannot be contract-typed bodies at all, which is why `authorizeOrThrow` is
  // the gate here where the two routes above return theirs. Everything else refuses by THROWING
  // on all three, so one surface never answers with two envelope shapes.
  app.get('/api/v1/artifacts/:artifactId/blob', async (c) => {
    const auth = await authorizeOrThrow(c, 'read')
    const store = await requireArtifactStore(c, auth.workspaceId)
    const artifactId = param(c, 'artifactId')
    const got = await store.getBlobWithMetadata(auth.workspaceId, artifactId)
    if (!got) throw new NotFoundError('Artifact', artifactId, { reason: 'artifact_not_found' })
    // A row whose bytes are gone from the backend is its own 404 and not an empty 200: a
    // zero-byte image would read as a screenshot of nothing. Its own REASON, too: "the id is not
    // yours" is a caller's mistake to stop repeating, where a metadata row that outlived its
    // bytes is a storage fault worth reporting, and prose alone leaves a machine unable to tell.
    if (!got.bytes) {
      throw new NotFoundError('Artifact', artifactId, { reason: 'artifact_blob_missing' })
    }
    // Uint8Array is a valid BodyInit on both runtimes (workerd + Node/undici); the cast satisfies
    // the narrower ambient BodyInit type this package compiles against. The headers clamp the
    // type to the image allow-list and send `nosniff`, exactly as the session-authed blob route
    // does. The bytes are attacker-influenced (an agent captured them) whichever door they
    // leave by.
    return new Response(got.bytes as unknown as BodyInit, {
      status: 200,
      headers: blobResponseHeaders(got.record.contentType),
    })
  })

  return app
}
