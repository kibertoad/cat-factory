import {
  getPublicMergeRecordContract,
  getPublicRunMergeRecordContract,
  listPublicMergeClassRollupsContract,
  tagPublicMergeReviewEffortContract,
  type MergeTrackRecord,
  type PublicMergeRecord,
} from '@cat-factory/contracts'
import type { MergeTrackRecordModule } from '@cat-factory/orchestration'
import { NotFoundError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { loadScopedRun } from './decisions/scope.js'
import { authorize, refuse } from './publicApiAuth.js'

// The public MERGE-EVIDENCE surface: the merge decision a run left behind, the workspace's
// per-change-class rollups, and the reviewer-effort tag a human leaves on a landed pull request
// (ADR 0046).
//
// The gap this closes is a split one, not a missing read. An integration could already start a
// run through `/api/v1` and merge its pull request through `POST /notifications/:id/act`; what it
// could not do was record how much review that merge actually took, nor read back what the
// workspace has accumulated per class. So the evidence the auto-merge policy is meant to
// eventually stand on was collectable only by people driving the app, and never by the harness
// driving the runs.
//
// Four rules shape this controller:
//
//  1. **Tagging is `write`, not `admin`.** `act` sits at the top of the ladder because it MERGES
//     a pull request for real; recording how much review an already-landed one needed performs
//     no external side-effect and can merge nothing. Gating the tag at `admin` too would mean an
//     integration whose whole job is recording evidence had to hold a key that also deletes
//     tasks and merges pull requests, which is the opposite of what the ladder is for.
//  2. **The run-scoped read carries the `/api/v1/runs/:runId/*` access semantic**, resolved
//     through `loadScopedRun` like every other route under that prefix, while the two
//     record-addressed routes re-apply the key's workspace to the row they load, the rule every
//     point read on this API follows. One prefix, one access model: the trap `debug-api.md`
//     records.
//  3. **A missing record is a 404, never an empty body.** A run whose pipeline had no `merger`
//     step made no merge decision, and that is a fact about the run; answering with a nulled-out
//     record would read as a decision nobody made.
//  4. **Refusals THROW**, so this surface answers with the one `handleError` envelope (which
//     carries `details.reason`, the request id and the error-code metric). The exception is the
//     AUTH gate, whose failure is shared DATA produced by `publicApiAuth`.

/** The merge track-record module, or a 503 naming what this deployment has not wired. */
function requireTrackRecords<E extends AppEnv>(c: Context<E>): MergeTrackRecordModule {
  return requireCapability(
    c.get('container').mergeTrackRecords,
    'Merge track records are not configured',
  )
}

/**
 * Project a stored record onto the public id vocabulary: `/api/v1` addresses a task as `taskId`
 * and a run as `runId`, so publishing the row's own `blockId`/`executionId` would hand a caller
 * two ids it can address nothing with, beside the ones it can. Nothing is dropped.
 */
function recordToWire(record: MergeTrackRecord): PublicMergeRecord {
  return {
    recordId: record.id,
    taskId: record.blockId,
    runId: record.executionId,
    changeClass: record.changeClass,
    changedFileCount: record.changedFileCount,
    complexity: record.complexity,
    risk: record.risk,
    impact: record.impact,
    mergePresetId: record.riskPolicyId,
    mergePresetName: record.riskPolicyName,
    decision: record.decision,
    reviewEffort: record.reviewEffort,
    prNumber: record.prNumber,
    prUrl: record.prUrl,
    repoId: record.repoId,
    provider: record.provider,
    createdAt: record.createdAt,
    resolvedAt: record.resolvedAt,
    taggedAt: record.taggedAt,
  }
}

export function publicMergeEvidenceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The workspace's per-class rollups, as ONE aggregate. Registered ahead of the point read
  // below so `rollups` is matched as itself rather than as a record id.
  buildHonoRoute(app, listPublicMergeClassRollupsContract, async (c) => {
    const gate = await authorize(c, listPublicMergeClassRollupsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const records = requireTrackRecords(c)
    return c.json({ rollups: await records.service.rollups(gate.auth.workspaceId) }, 200)
  })

  // The merge decision a RUN left behind: the entry point for a caller holding a run id, and
  // where it picks up the `recordId` the tag route takes.
  buildHonoRoute(app, getPublicRunMergeRecordContract, async (c) => {
    const gate = await authorize(c, getPublicRunMergeRecordContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { workspaceId } = gate.auth
    const runId = c.req.valid('param').runId
    const records = requireTrackRecords(c)
    // Resolve the run FIRST, so a run this key may not read answers "no such run" rather than
    // "no such record", the latter confirming the run exists to a caller that cannot see it.
    if (!(await loadScopedRun(c, workspaceId, runId))) {
      throw new NotFoundError('Run', runId, { reason: 'run_not_found' })
    }
    const record = await records.service.getForRun(workspaceId, runId)
    // A distinct reason from the one above: "there is no such run" is a caller's mistake to stop
    // repeating, where "this run made no merge decision" is a fact about a run it may well be
    // watching (its pipeline has no `merger`, or it never reached one). Prose alone leaves a
    // machine unable to tell those apart.
    if (!record) {
      throw new NotFoundError('MergeTrackRecord', runId, { reason: 'no_merge_record' })
    }
    return c.json(recordToWire(record), 200)
  })

  // One record by id, so a caller holding a `recordId` (off a `merge_tag_request` card, say) can
  // read what it is about to tag.
  buildHonoRoute(app, getPublicMergeRecordContract, async (c) => {
    const gate = await authorize(c, getPublicMergeRecordContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const recordId = c.req.valid('param').recordId
    const records = requireTrackRecords(c)
    const record = await records.service.get(gate.auth.workspaceId, recordId)
    if (!record) {
      throw new NotFoundError('MergeTrackRecord', recordId, { reason: 'merge_record_not_found' })
    }
    return c.json(recordToWire(record), 200)
  })

  // Tag (or clear) the reviewer effort. `service.tag` raises its own NotFound for an unknown or
  // foreign id, which the shared handler renders as the 404. A deliberate user action gets a
  // real refusal, where the merge path's own writes are best-effort and silent.
  buildHonoRoute(app, tagPublicMergeReviewEffortContract, async (c) => {
    const gate = await authorize(c, tagPublicMergeReviewEffortContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const records = requireTrackRecords(c)
    const tagged = await records.service.tag(
      gate.auth.workspaceId,
      c.req.valid('param').recordId,
      c.req.valid('json').reviewEffort,
    )
    return c.json(recordToWire(tagged), 200)
  })

  return app
}
