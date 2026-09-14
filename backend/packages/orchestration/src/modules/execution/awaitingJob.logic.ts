import type { PipelineStep } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import { inFlightDelegation } from './step-fold.logic.js'

// ---------------------------------------------------------------------------
// The ONE producer of an `awaiting_job` park.
//
// A park used to be a three-field object literal written at sixteen sites, which was fine while
// every async job was a container job polled on one deployment-wide cadence. A DELEGATED step
// breaks that: an external run of an hour is ordinary where a harness job of an hour is a stall,
// so the cadence belongs to the executor and travels with the park.
//
// Going through one function is what makes that structural rather than remembered. A new dispatch
// site gets the cadence by construction, and the derivation reads the STEP, which is the only
// thing both durable drivers have, in another process, after a replay.
// ---------------------------------------------------------------------------

/**
 * Report that this step has an asynchronous job in flight, with the poll cadence the driver should
 * use for it.
 *
 * `jobId` is a parameter rather than read off the step because two callers legitimately hold it
 * somewhere else: a just-returned handle (which the step also carries by then) and a re-attach that
 * captured it before the step was mutated.
 */
export function awaitingJob(step: PipelineStep, stepIndex: number, jobId: string): AdvanceResult {
  const poll = delegatedPollPolicy(step)
  return { kind: 'awaiting_job', jobId, stepIndex, ...(poll ? { poll } : {}) }
}

/**
 * The cadence for the job currently in flight on this step, or undefined for the ordinary case
 * (a container job, which every deployment polls on its own configured cadence).
 *
 * Gated on the in-flight job actually BEING the delegated one, through the shared
 * {@link inFlightDelegation}. A step whose own work was delegated can still dispatch a container
 * job afterwards (a helper round, a re-run under an overriding kind), and the delegation record
 * outlives that by design (its attempt log is the evidence for the re-run). Reading the cadence off
 * a record without checking would poll a container job on an external system's schedule: at best
 * minutes of dead air per step, at worst a three-hour budget spent on a container the transport
 * gave up on in ten minutes.
 */
export function delegatedPollPolicy(
  step: PipelineStep,
): { intervalMs: number; maxPolls: number } | undefined {
  const record = inFlightDelegation(step)
  if (!record) return undefined
  if (record.status !== 'starting' && record.status !== 'running') return undefined
  const { intervalMs, maxDurationMs } = record.poll
  // At least one poll, always: an executor whose declared window is shorter than one interval is
  // refused at registration, but a mothership node validates nothing it resolves, and a budget of
  // zero would fail the step as un-settled before the platform ever asked how it was going.
  return { intervalMs, maxPolls: Math.max(1, Math.ceil(maxDurationMs / intervalMs)) }
}
