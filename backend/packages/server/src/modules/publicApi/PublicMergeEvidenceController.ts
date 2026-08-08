import {
  getPublicMergeRecordContract,
  getPublicRunMergeRecordContract,
  listPublicMergeClassRollupsContract,
  MERGE_RECORD_NOT_FOUND_REASON,
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
import { requireScopedRun } from './decisions/scope.js'
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
//     through `requireScopedRun` like every other route under that prefix, while the two
//     record-addressed routes re-apply the key's workspace to the row they load, the rule every
//     point read on this API follows. One prefix, one access model: the trap `debug-api.md`
//     records.
//
//     The two therefore DIVERGE on a record whose run row is gone (a re-run, a cancel), and that
//     divergence is the feature rather than a hole in it. A track record deliberately carries no
//     foreign key to its execution: it is the evidence a merge decision LEFT BEHIND, and the
//     rollups aggregate exactly those rows, so a record that stopped being readable the moment its
//     run was re-run would erase the history the surface exists to serve. Nothing widens: both
//     doors re-apply the key's workspace, and the rollups already publish every record in it at
//     `read`. What the run-scoped read narrows is which RUN a key may address, not which record
//     exists. A record id is derivable (`mtr_<executionId>`), so treating that read as a second
//     confidentiality boundary would be a fiction anyway; the workspace is the boundary, once.
//  3. **A missing record is a 404, never an empty body.** A run whose pipeline had no `merger`
//     step made no merge decision, and that is a fact about the run; answering with a nulled-out
//     record would read as a decision nobody made.
//  4. **Refusals THROW**, so this surface answers with the one `handleError` envelope (which
//     carries `details.reason`, the request id and the error-code metric). The exception is the
//     AUTH gate, whose failure is shared DATA produced by `publicApiAuth`. Each refusal is built
//     by ONE named factory below, so no two routes answer the same condition with different words
//     and the reason a caller branches on is decided once per condition rather than per route.

/** The merge track-record module, or a 503 naming what this deployment has not wired. */
function requireTrackRecords<E extends AppEnv>(c: Context<E>): MergeTrackRecordModule {
  return requireCapability(
    c.get('container').mergeTrackRecords,
    'Merge track records are not configured',
  )
}

/**
 * The 404 the RUN-scoped read answers for a run it CAN see that left no merge decision behind.
 *
 * It names the run as the run it is, not as a record id: record ids are minted inside the merge
 * path and a caller holding only a run id has never seen one, so rendering `MergeTrackRecord
 * '<runId>' not found` would tell it an id it never supplied is missing. Only `details.reason`
 * is machine-readable, but the prose is what a person reads out of a log.
 */
const noMergeRecord = (runId: string) =>
  new NotFoundError('Merge record for run', runId, { reason: 'no_merge_record' })

/**
 * The 404 the RECORD-addressed read answers, sharing its reason with the one
 * `MergeTrackRecordService.tag` raises for the same condition on the same id. Two routes, one
 * fact: the id names no record this workspace holds.
 */
const mergeRecordNotFound = (recordId: string) =>
  new NotFoundError('MergeTrackRecord', recordId, { reason: MERGE_RECORD_NOT_FOUND_REASON })

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
    // The same refusal the sibling evidence reads answer, from the same factory.
    await requireScopedRun(c, workspaceId, runId)
    const record = await records.service.getForRun(workspaceId, runId)
    // A distinct reason from the one above: "there is no such run" is a caller's mistake to stop
    // repeating, where "this run made no merge decision" is a fact about a run it may well be
    // watching (its pipeline has no `merger`, or it never reached one). Prose alone leaves a
    // machine unable to tell those apart.
    if (!record) throw noMergeRecord(runId)
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
    if (!record) throw mergeRecordNotFound(recordId)
    return c.json(recordToWire(record), 200)
  })

  // Tag (or clear) the reviewer effort. `service.tag` raises the NotFound for an unknown or
  // foreign id, carrying the SAME `merge_record_not_found` reason the read above answers, so the
  // two routes addressing one id agree about what a missing one is. Refusing inside the service
  // rather than pre-checking here keeps the write a single round-trip and leaves no window
  // between a check and the patch. A deliberate user action gets a real refusal, where the merge
  // path's own writes are best-effort and silent.
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
