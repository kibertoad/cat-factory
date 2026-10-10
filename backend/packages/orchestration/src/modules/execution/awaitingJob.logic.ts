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
 * The cadence for the job currently in flight on this step, or undefined when the park carries
 * none: a container job, and a delegation whose record holds no declared cadence. Both then poll
 * on the DEPLOYMENT's own configured job cadence, which is the honest answer where the executor's
 * declaration is out of reach and a far better one than a number nobody chose.
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
  const poll = record.poll
  // A DEGENERATE window answers "no cadence" rather than deriving one from it. The registry
  // refuses a non-positive declaration, but a mothership node validates nothing it resolves and a
  // record can predate a claim, and the arithmetic here is unforgiving in exactly the direction
  // that costs a run: `ceil(0 / 0)` is `NaN`, `max(1, NaN)` is `NaN`, and a `p < NaN` poll loop
  // runs no iterations at all, so the step fails as un-settled before the first poll.
  if (!poll || !(poll.intervalMs > 0) || !(poll.maxDurationMs > 0)) return undefined
  // At least one poll, always: an executor whose declared window is shorter than one interval is
  // refused at registration, and a window that survived that would otherwise settle the step
  // before the platform ever asked how it was going.
  return {
    intervalMs: poll.intervalMs,
    maxPolls: Math.max(1, Math.ceil(poll.maxDurationMs / poll.intervalMs)),
  }
}
