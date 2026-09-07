import * as v from 'valibot'
import type { BlockType } from './primitives.js'

// ---------------------------------------------------------------------------
// AGENT DRY RUN: what an agent found when it tried to OPERATE a freshly provisioned
// ephemeral environment.
//
// The provisioning self-test answers "does this service's environment stand up". This answers the
// question after it: given the environment, the credentials and the repository, can an agent work
// out what to call, authenticate, and get real work done? That gap is where a pipeline silently
// burns a whole run today: the deploy is green, the tester reaches the environment, and the agent
// then has no idea which endpoint carries the operation or which credential opens it. A dry run
// surfaces it in one diagnostic instead of at the end of a build.
//
// The vocabularies here are CLOSED and PERSISTED (they land on an `environment_test_runs` row and
// on the wire), so both sides read them from this module: the backend coerces a model's reply into
// the report, and the SPA renders each member with its own translated copy. A reader that meets a
// value it does not know renders the raw value rather than nothing (the SPA's `PROBE_FAILURE_KEYS`
// is `te`-guarded for exactly that).
//
// The division of labour is the platform's standing rule: the MODEL judges each operation it
// attempted, and the PLATFORM computes everything derived from those judgements (the counts, the
// verdict). A model is never asked for a verdict it could then grade itself against.
// ---------------------------------------------------------------------------

/** Which surface a dry run drove: HTTP calls, or a browser. */
export const environmentProbeSurfaceSchema = v.picklist(['api', 'ui'])
export type EnvironmentProbeSurface = v.InferOutput<typeof environmentProbeSurfaceSchema>

/**
 * Which surface a service frame's dry run drives, from the frame's own type.
 *
 * A `frontend` frame is a browser job and everything else is a protocol job: there is no third
 * answer to invent, and no frame type where the choice is genuinely ambiguous: `library` and
 * `document` frames have no ephemeral-environment provisioning to test, so a dry run never
 * reaches one. Stated in contracts rather than in the engine because BOTH sides say it to a
 * human: the backend picks the prober, and the SPA's button has to tell the user which one it is
 * about to spend money on.
 */
export function environmentProbeSurfaceFor(type: BlockType): EnvironmentProbeSurface {
  return type === 'frontend' ? 'ui' : 'api'
}

/**
 * Why one attempted operation did not work, or why the agent never got to attempt it.
 *
 * The set is shaped around WHOSE PROBLEM each member is, because that is the whole output of the
 * diagnostic:
 *
 *  - `auth_missing` / `access_unclear` / `endpoint_unknown`: the PLATFORM did not tell the agent
 *    enough. These are the findings this feature exists to surface: nothing is broken in the
 *    service, the run would simply have been spent guessing.
 *  - `auth_rejected` / `bad_request`: the agent knew what to send and the service refused it. A
 *    credential that is present and rejected is a different fix from one that was never supplied,
 *    which is why they are not one member.
 *  - `unreachable` / `timeout` / `server_error`: the ENVIRONMENT is at fault, so the dry run has
 *    found something the provisioning self-test's `ready` verdict did not.
 *  - `tooling_missing`: the container had no HTTP client or browser, so the attempt says nothing
 *    about the environment at all. Its own member for that reason: collapsed into `other` it reads
 *    as a service that failed.
 *  - `other`: anything else, with the agent's own detail carrying the specifics.
 */
export const environmentProbeFailureSchema = v.picklist([
  'auth_missing',
  'auth_rejected',
  'access_unclear',
  'endpoint_unknown',
  'unreachable',
  'timeout',
  'server_error',
  'bad_request',
  'tooling_missing',
  'other',
])
export type EnvironmentProbeFailure = v.InferOutput<typeof environmentProbeFailureSchema>

/** The failure vocabulary as a list, for a reader that has to enumerate it. */
export const ENVIRONMENT_PROBE_FAILURES = environmentProbeFailureSchema.options

/** Whether a value is a currently-known failure kind (derived from the picklist's own options). */
export function isEnvironmentProbeFailure(value: unknown): value is EnvironmentProbeFailure {
  return (
    typeof value === 'string' && (ENVIRONMENT_PROBE_FAILURES as readonly string[]).includes(value)
  )
}

/** How one attempted operation turned out. */
export const environmentProbeOutcomeSchema = v.picklist(['succeeded', 'failed', 'not_attempted'])
export type EnvironmentProbeOutcome = v.InferOutput<typeof environmentProbeOutcomeSchema>

/**
 * The platform's verdict on a dry run, COMPUTED from the operations the agent reported (see
 * {@link summarizeEnvironmentProbe}) rather than read off the reply.
 *
 *  - `operable`: every attempted operation worked, and at least one of them exercised
 *    authentication.
 *  - `partially_operable`: something worked, but not everything, or nothing that worked was
 *    behind auth. A public healthcheck answering is not evidence that an agent can operate the
 *    service, which is why it cannot earn `operable` on its own.
 *  - `inoperable`: nothing the agent attempted worked, or it never got to attempt anything.
 */
export const environmentProbeVerdictSchema = v.picklist([
  'operable',
  'partially_operable',
  'inoperable',
])
export type EnvironmentProbeVerdict = v.InferOutput<typeof environmentProbeVerdictSchema>

/** One operation the agent attempted against the live environment. */
export const environmentProbeOperationSchema = v.object({
  /** What it was, in the agent's own words ("list projects", "sign in and open the dashboard"). */
  name: v.string(),
  /** How it was performed: `GET /api/v1/projects`, or the UI path it clicked through. */
  target: v.optional(v.string()),
  /**
   * Whether this operation actually exercised authentication. The one field the verdict turns on:
   * a dry run whose only successes are anonymous has not shown that an agent can operate the
   * service, so it never reaches `operable`.
   */
  authenticated: v.boolean(),
  outcome: environmentProbeOutcomeSchema,
  /** Why it did not work. Absent on a success. */
  failure: v.optional(environmentProbeFailureSchema),
  /** The agent's evidence: the status code, the message, what it saw. */
  detail: v.optional(v.string()),
})
export type EnvironmentProbeOperation = v.InferOutput<typeof environmentProbeOperationSchema>

/** Something that stopped the dry run as a whole, rather than one operation. */
export const environmentProbeBlockerSchema = v.object({
  kind: environmentProbeFailureSchema,
  detail: v.string(),
})
export type EnvironmentProbeBlocker = v.InferOutput<typeof environmentProbeBlockerSchema>

/** A dry run's report, as persisted on the run row and rendered by the SPA. */
export const environmentProbeReportSchema = v.object({
  surface: environmentProbeSurfaceSchema,
  /** Platform-computed; never taken from the reply. */
  verdict: environmentProbeVerdictSchema,
  /** The agent's own account of what it did and what it concluded. */
  summary: v.string(),
  /** Every operation it attempted (or explicitly did not), in the order it reported them. */
  operations: v.array(environmentProbeOperationSchema),
  /**
   * What the PLATFORM failed to tell it: a credential it needed and had no reference for, an
   * endpoint it could not discover, a base path it had to guess. The primary product of the
   * diagnostic, since each entry is a thing to fix before a real run spends a step on it.
   */
  missingContext: v.array(v.string()),
  /** Whole-run blockers, distinct from one operation's failure. */
  blockers: v.array(environmentProbeBlockerSchema),
  /** Platform-computed tallies over `operations`. */
  attempted: v.number(),
  succeeded: v.number(),
  /** How many SUCCESSFUL operations exercised authentication. The verdict's deciding count. */
  authenticatedSucceeded: v.number(),
  /**
   * How many reported operations were dropped at the cap, so a reader never takes a truncated
   * list for the whole attempt. Absent means nothing was dropped, which is a different fact from
   * a drop nobody recorded.
   */
  operationsOmitted: v.optional(v.number()),
  /** The model that produced the report. Absent when the dispatch did not say. */
  model: v.optional(v.string()),
})
export type EnvironmentProbeReport = v.InferOutput<typeof environmentProbeReportSchema>

/** How much of a model's reply is kept. Every cap here records what it dropped. */
const CAPS = {
  operations: 12,
  name: 160,
  target: 200,
  detail: 800,
  summary: 2000,
  missingContext: 10,
  missingContextEntry: 300,
  blockers: 6,
} as const

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max)} [truncated]` : trimmed
}

function outcomeOf(raw: unknown): EnvironmentProbeOutcome {
  if (raw === 'succeeded' || raw === 'failed' || raw === 'not_attempted') return raw
  // A reply that named no outcome for an operation it listed has told us nothing about it, and
  // `failed` would attribute a fault the agent never claimed. `not_attempted` is the honest
  // reading and keeps the entry out of both tallies.
  return 'not_attempted'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Tally the operations and derive the verdict: the platform's half of the report.
 *
 * `not_attempted` counts towards neither `attempted` nor `succeeded`: an operation the agent
 * declared it could not even try is a FINDING (it carries the failure kind saying why), not a
 * failed call, and counting it as attempted would make "nothing was reachable" read as
 * "everything was tried and failed".
 */
export function summarizeEnvironmentProbe(operations: readonly EnvironmentProbeOperation[]): {
  attempted: number
  succeeded: number
  authenticatedSucceeded: number
  verdict: EnvironmentProbeVerdict
} {
  const attempted = operations.filter((op) => op.outcome !== 'not_attempted').length
  const succeeded = operations.filter((op) => op.outcome === 'succeeded').length
  const authenticatedSucceeded = operations.filter(
    (op) => op.outcome === 'succeeded' && op.authenticated,
  ).length
  const verdict: EnvironmentProbeVerdict =
    succeeded === 0
      ? 'inoperable'
      : succeeded === attempted && authenticatedSucceeded > 0
        ? 'operable'
        : 'partially_operable'
  return { attempted, succeeded, authenticatedSucceeded, verdict }
}

/**
 * Coerce an agent's raw structured reply into an {@link EnvironmentProbeReport}.
 *
 * LENIENT by construction, in the same spirit as the analyst draft's schema: a dry run whose
 * report was half-malformed still holds the finding somebody has to act on, and discarding the
 * whole thing would report "the agent produced nothing" for a run that produced plenty. Every
 * field the reply got wrong degrades to a stated absence rather than to a guess, and every cap
 * records what it dropped.
 *
 * `surface` is supplied by the CALLER, not read from the reply: the platform chose which prober to
 * dispatch, so a model claiming otherwise would be reporting about a run that did not happen.
 */
export function coerceEnvironmentProbeReport(
  raw: unknown,
  context: { surface: EnvironmentProbeSurface; model?: string },
): EnvironmentProbeReport {
  const root = record(raw)
  const rawOperations = array(root.operations)
  const operations: EnvironmentProbeOperation[] = []
  for (const entry of rawOperations.slice(0, CAPS.operations)) {
    const op = record(entry)
    const name = text(op.name, CAPS.name)
    if (!name) continue
    const target = text(op.target, CAPS.target)
    const detail = text(op.detail, CAPS.detail)
    const outcome = outcomeOf(op.outcome)
    const failure = isEnvironmentProbeFailure(op.failure) ? op.failure : undefined
    operations.push({
      name,
      ...(target ? { target } : {}),
      authenticated: op.authenticated === true,
      outcome,
      // A non-success with no recognised kind still has to say SOMETHING about whose problem it
      // was, and `other` is the member that says "the detail carries it".
      ...(outcome === 'succeeded' ? {} : { failure: failure ?? 'other' }),
      ...(detail ? { detail } : {}),
    })
  }
  const blockers: EnvironmentProbeBlocker[] = []
  for (const entry of array(root.blockers).slice(0, CAPS.blockers)) {
    const blocker = record(entry)
    const detail = text(blocker.detail, CAPS.detail)
    if (!detail) continue
    blockers.push({
      kind: isEnvironmentProbeFailure(blocker.kind) ? blocker.kind : 'other',
      detail,
    })
  }
  const missingContext: string[] = []
  for (const entry of array(root.missingContext).slice(0, CAPS.missingContext)) {
    const line = text(entry, CAPS.missingContextEntry)
    if (line) missingContext.push(line)
  }
  const omitted = Math.max(0, rawOperations.length - operations.length)
  return {
    surface: context.surface,
    ...summarizeEnvironmentProbe(operations),
    // An empty summary stays empty rather than being filled with a sentence the model did not
    // write: the SPA renders the operations and the verdict either way, and inventing prose here
    // would make a model that returned nothing look like one that reported.
    summary: text(root.summary, CAPS.summary) ?? '',
    operations,
    missingContext,
    blockers,
    ...(omitted > 0 ? { operationsOmitted: omitted } : {}),
    ...(context.model ? { model: context.model } : {}),
  }
}
