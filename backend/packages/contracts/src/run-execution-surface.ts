import * as v from 'valibot'

// ---------------------------------------------------------------------------
// WHERE a step's work is running, and what the platform can therefore see of it.
//
// Two records, one per executor class that has a machine somewhere: the per-run CONTAINER a
// container agent runs in, and the DELEGATION an external executor runs as. They live together
// because a reader asking "what is this step doing and where do I go to look" is asking about
// exactly one of them, and because the pair is where the honesty rule bites hardest: a delegated
// step has no phase, no container id and no reachable address, so a shared shape would have it
// render as a container that reports nothing rather than as work the platform is only watching.
//
// Extracted from `execution.ts` (the file-size ratchet: split, never grow) when the delegation
// record joined the container one.
// ---------------------------------------------------------------------------

/**
 * The lifecycle status of the per-run container backing a container agent step:
 * `starting` (dispatching / cold-booting), `up` (running the agent's job),
 * `errored` (the container failed to start, was evicted, or its job faulted), and
 * `destroyed` (the run's container has been reclaimed). The SPA additionally derives
 * `destroyed` for a finished run's container steps (the container is reclaimed as a
 * unit when the run terminates), so the backend only ever persists the first three.
 */
export const runContainerStatusSchema = v.picklist(['starting', 'up', 'errored', 'destroyed'])
export type RunContainerStatus = v.InferOutput<typeof runContainerStatusSchema>

/**
 * The compact, non-secret projection of the per-run container a container agent step
 * runs in, so a run's details can show WHAT the container is doing and WHERE it lives
 * instead of a step's "spinning up container…" badge vanishing into a blank "working"
 * state once the container is up. Populated by the engine across the dispatch + poll
 * lifecycle of an async (container) step; only ever set on container-backed steps.
 */
export const runContainerSchema = v.object({
  /** The container lifecycle status; see {@link runContainerStatusSchema}. */
  status: runContainerStatusSchema,
  /**
   * The coarse phase the agent's job is in while the container is `up` (`clone` →
   * `agent` → `push`, seeded `starting`), forwarded from the harness. Lets the details
   * distinguish "still preparing the checkout" from "the agent is making calls". Absent
   * until the first poll, or when the runner doesn't report a phase.
   */
  phase: v.optional(v.nullable(v.string())),
  /** Provider container/runner id (Cloudflare DO id, docker container id), when known. */
  id: v.optional(v.nullable(v.string())),
  /** A reachable address for the running container (the local docker host URL), when one exists. */
  url: v.optional(v.nullable(v.string())),
})
export type RunContainer = v.InferOutput<typeof runContainerSchema>

/**
 * The lifecycle of one unit of DELEGATED work: `starting` (the claim is committed, the executor
 * has not answered yet), `running`, the two terminal outcomes, and `cancelled`.
 *
 * `starting` is load-bearing rather than cosmetic. It is written and COMMITTED before the
 * executor's `start` is called, so a replay of the dispatch finds it and polls by correlation
 * instead of starting a second external run: the claim-before-effect rule, which for a delegated
 * step is the difference between one pull request and two.
 */
export const runDelegationStatusSchema = v.picklist([
  'starting',
  'running',
  'done',
  'failed',
  'cancelled',
])
export type RunDelegationStatus = v.InferOutput<typeof runDelegationStatusSchema>

const RUN_DELEGATION_STATUS_SET: ReadonlySet<string> = new Set(runDelegationStatusSchema.options)

/**
 * Whether a stored status is still a member of this build's vocabulary, DERIVED from the picklist
 * so it cannot drift from it.
 *
 * The vocabulary is CLOSED and PERSISTED, which is the pairing that makes an exhaustive
 * `Record<RunDelegationStatus, …>` total against the TYPE and partial against the DATA: retiring a
 * member does not rewrite the rows that hold it, and the reader that meets one first is the step
 * panel whose whole job is to say what happened to the run. Indexed bare, that is `undefined.cls`
 * and a white screen over the one surface with the answer on it.
 *
 * The negative case is RENDERED as the unrecognised value it is, never guessed onto a current
 * member: nothing can know which one was meant, and a status silently re-pointed reports the wrong
 * outcome for external work a person is deciding whether to go and stop.
 */
export function isRunDelegationStatus(value: string): value is RunDelegationStatus {
  return RUN_DELEGATION_STATUS_SET.has(value)
}

/** One attempt at the external work: when it started, what it was, and where to read about it. */
export const runDelegationAttemptSchema = v.object({
  startedAt: v.number(),
  externalId: v.optional(v.nullable(v.string())),
  url: v.optional(v.nullable(v.string())),
  /** How the attempt ended, in the executor's own words. Absent while it is still running. */
  outcome: v.optional(v.nullable(v.string())),
})
export type RunDelegationAttempt = v.InferOutput<typeof runDelegationAttemptSchema>

/**
 * The DELEGATION record: the compact, non-secret projection of the external work a delegated step
 * dispatched, and the delegated sibling of {@link runContainerSchema}.
 *
 * Its own field rather than a fourth `runContainerStatus` value, because nothing about it is a
 * container: there is no phase, no id, no reachable address, and the one affordance that matters
 * (a link to the executor's own logs) has no counterpart there. Sharing the field would also make
 * every existing container reader (the board badge, the reclaim path, the SPA's derived
 * `destroyed`) silently speak for runs whose containers are somebody else's.
 *
 * The attempt LOG is kept across a re-run on purpose: the previous attempt's logs are the evidence
 * for why the step is being re-run, and the platform holds nothing else about it.
 */
export const runDelegationSchema = v.object({
  /** The registered `DelegatedExecutorDefinition.id` this work was dispatched to. */
  executor: v.string(),
  status: runDelegationStatusSchema,
  /**
   * The key the executor was asked to make its own run recoverable by, and the step's `jobId` at
   * the moment of the claim.
   *
   * Persisted rather than re-derived because it is what tells the poll site WHICH job is in flight
   * on this step. A helper re-dispatch (a fixer round) overwrites `jobId` with a container job's,
   * and a cadence or a route read off a stale delegation record would then address the wrong
   * thing entirely.
   */
  correlationKey: v.string(),
  /**
   * The poll cadence this run was dispatched under, copied from the executor's declaration at the
   * claim.
   *
   * On the RECORD rather than looked up per poll because anything the poll needs must be on the
   * step: the durable driver rebuilds everything from it, in another process, and the driver's own
   * park loop has no registry in scope at all. Copying also means an in-flight run keeps the
   * cadence it started under when a deployment re-tunes its executor, which is the honest answer
   * for work already running somewhere else.
   */
  poll: v.object({ intervalMs: v.number(), maxDurationMs: v.number() }),
  /** The executor's own id for the work. Absent between the claim and the executor's answer. */
  externalId: v.optional(v.nullable(v.string())),
  /** Where a human watches it. The primary affordance on the step card. */
  url: v.optional(v.nullable(v.string())),
  /** A coarse phase in the executor's own vocabulary, when it reports one. */
  phase: v.optional(v.nullable(v.string())),
  /**
   * The branch pair this dispatch handed the executor, persisted because the POLL needs it and
   * cannot derive it: the work branch is named from the BLOCK, and a poll rebuilds its handle from
   * the step and the run alone. An executor reading what its workflow produced would otherwise
   * guess, and the wrong branch means the wrong pull request recorded on this block.
   */
  branches: v.optional(v.nullable(v.object({ base: v.string(), work: v.string() }))),
  /**
   * The repository the work TARGETS, persisted beside the branches and for the same reason: the
   * poll rebuilds its handle from the step, and the executor's own configured repository is
   * routinely a different one (an automation repo holding the workflow, dispatching against many
   * product repos). Without it, an executor reading back what it produced looks in the wrong place
   * and reports every run as having produced nothing.
   */
  repo: v.optional(v.nullable(v.object({ owner: v.string(), name: v.string() }))),
  /**
   * The branch the external work actually LANDED on, as the executor reported it at settlement.
   *
   * Distinct from `branches.work`, which is what the dispatch ASKED for: this is what came back,
   * and it is the whole product of a step whose executor pushes without opening a pull request (a
   * seed-only step, or a policy of letting a later step open the PR). Absent means the executor
   * reported none, which for a run that opened a pull request is the ordinary case.
   */
  branch: v.optional(v.nullable(v.string())),
  /** Every attempt on this step, oldest first. A re-run APPENDS; it never clears. */
  attempts: v.array(runDelegationAttemptSchema),
  /**
   * One line of context the platform could not otherwise state: how an id was recovered, or that
   * a cancelled run's executor declares no `cancel` and the external work is still alive. Never a
   * credential.
   */
  note: v.optional(v.nullable(v.string())),
})
export type RunDelegation = v.InferOutput<typeof runDelegationSchema>
