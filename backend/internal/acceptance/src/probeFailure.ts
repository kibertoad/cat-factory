// What a THROWN prerequisite probe means, and what to do about it.
//
// Every prerequisite in this suite reaches the deployment over HTTP, so a probe fails in one of two
// fundamentally different ways, and the gate used to render both as the same sentence.
//
// **It never got an answer.** On Node a transport failure is a bare `TypeError: fetch failed`, and
// what actually happened (`connect ECONNREFUSED 127.0.0.1:8787`, `getaddrinfo ENOTFOUND`, a
// self-signed certificate) hangs off `.cause`, or off an `AggregateError`'s `.errors` when the host
// resolved to both `::1` and `127.0.0.1`. So the obvious `error instanceof Error ? error.message :
// String(error)` renders the single least informative string in the whole chain. The cost was not
// hypothetical: a deployment that was simply not started reported
//
//     deployment-health: the check threw: fetch failed
//
// under a remedy listing three causes it had not distinguished (not running / base URL naming the
// SPA / a key that is missing, revoked or under-scoped), two of which were about a credential that
// was never sent.
//
// **It got an answer, and the answer was a refusal.** The SDK throws a typed `CatFactoryApiError`
// carrying the status, the machine-readable `code` and the `X-Request-Id`, and reading that as
// `error.message` threw all three away: a new prerequisite driving an operation this deployment is
// too OLD to serve reported `the check threw: 404 unknown: HTTP 404`, whose fix (rebuild and restart)
// nothing in the message pointed at.
//
// The gate's whole value is naming WHICH setup mistake a pass hit, so a probe that cannot say which
// one is the gate failing at its own job.
//
// The walk, the classification and the per-cause remedy for the first kind are all kernel's
// (`describeConnectionFailure`), the platform's ONE producer of them and what every "Test
// connection" button in the product already answers through. This module relays that verdict, adds
// the second kind, and contributes only what neither can know: that this base URL was typed into a
// `.env` by hand.

import { describeConnectionFailure, getErrorMessage } from '@cat-factory/kernel'
import type { ConnectionFailureCause, ConnectionFailureContext } from '@cat-factory/kernel'
import { CatFactoryApiError } from '@cat-factory/sdk'
import type { PrerequisiteVerdict, Remedy } from './preflight.ts'

/**
 * What the SPA-vs-backend mixup looks like from here, which is the one setup mistake neither
 * describer can name: they know a port refused a connection, not that a human chose the port.
 *
 * Both halves of the trap are stated because they fail differently. A base URL naming the SPA's port
 * connects and answers a `/health` of its own (so the probe never throws and this module never
 * runs); one naming a port nothing serves is the `refused` above. What is common is that the value
 * came from a file rather than from a discovery, so it is the first thing worth re-reading.
 */
function baseUrlStep(target: string | undefined): string {
  const named = target ? `CAT_FACTORY_BASE_URL (${target})` : 'CAT_FACTORY_BASE_URL'
  return (
    `Re-read ${named} in backend/internal/acceptance/.env: it names the BACKEND origin serving ` +
    `/api/v1, not the SPA, and a shell export of the same variable wins over the file.`
  )
}

/**
 * The three things an UNCLASSIFIED throw could be, which is honestly all that is known about one.
 *
 * Reached when the deployment never answered AND kernel matched no transport cause: an unrecognised
 * transport code, a DNS stack behaving oddly, a bug in the check itself. An answered refusal does not
 * come here, which is why the credential guesses are NOT in this list: they belong to the branch
 * that knows a request was actually made and rejected.
 */
const UNCLASSIFIED_STEPS: readonly string[] = [
  'Nothing in the thrown chain named a transport failure and no HTTP status came back, so this is ' +
    'neither a reachability problem nor a refusal: suspect the check itself, or a proxy answering ' +
    'in a shape neither the SDK nor the connection describer recognises.',
  'Confirm the deployment answers at all with the command below, which takes no credential.',
]

export type ProbeFailure = {
  /**
   * kernel's transport class. `unknown` whenever the deployment ANSWERED, because then nothing about
   * the transport failed: read it together with {@link ProbeFailure.status}, never alone.
   */
  cause: ConnectionFailureCause
  /** The HTTP status, present only when the deployment answered and the answer was a refusal. */
  status?: number
  /** What happened: the flattened, scrubbed cause chain, or the refusal the deployment stated. */
  detail: string
  remedy: Remedy
}

/**
 * The remedy for an ANSWERED refusal, which is a different question from an unreachable host: the
 * deployment is up, so what is wrong is the request, the credential, or the deployment's own age.
 *
 * The 404 branch is the one worth reading twice. A route the deployment does not serve answers
 * Hono's built-in 404, which carries no `{ error: { code } }` envelope, so the SDK fills `code` with
 * `unknown`; a domain 404 from `handleError` carries `not_found`. That difference is the only
 * evidence available that the OPERATION is missing rather than the resource, and it is precisely the
 * shape of a deployment built before the suite that drives it. Both readings are stated, in the
 * order their fixes are cheap to try.
 */
function answeredSteps(error: CatFactoryApiError, target: string | undefined): readonly string[] {
  if (error.status === 404 && error.code === 'unknown') {
    return [
      'The deployment answered 404 with no error envelope, which is what an UNMATCHED ROUTE ' +
        'answers: whatever is on that origin does not serve an operation the check depends on.',
      'That is what a deployment OLDER than this suite looks like. The suite drives `/api/v1` ' +
        'operations declared by the workspace packages it is built against, so one running an ' +
        'earlier build serves none of the newest. Rebuild and restart it: `pnpm build`, then ' +
        'restart the backend.',
      // The one answered failure where the address is still in question, and the reason this branch
      // takes the target at all: the SPA answers an unknown path with exactly this shape, so a base
      // URL naming it is indistinguishable here from a backend one release behind.
      baseUrlStep(target),
      'If the deployment is current and the origin is right, the operation genuinely does not ' +
        'exist and the check is ahead of the API: that is a bug in the suite, not a setup mistake.',
    ]
  }
  if (error.status === 404) {
    return [
      `The deployment refused with 404 '${error.code}', so a resource the check names does not ` +
        `exist, or lies outside this key's workspace (the API does not distinguish the two, by ` +
        `design).`,
      'Check ACCEPTANCE_WORKSPACE_ID against the workspace the key is bound to, which the ' +
        '`api-key` prerequisite reports.',
    ]
  }
  if (error.status === 401 || error.status === 403) {
    return [
      `The deployment rejected the credential with ${error.status} '${error.code}'.`,
      'A token\'s scope is fixed when it is created: mint a new one with scope "Full access" ' +
        '(Integrations, "API access tokens") rather than trying to raise this one, then export it ' +
        'as CAT_FACTORY_API_KEY.',
    ]
  }
  if (error.status >= 500) {
    return [
      `The deployment faulted with ${error.status} '${error.code}', so the fix is in its log ` +
        `rather than in this suite's configuration.`,
      'A 503 is the deployment saying a capability the check needs is not wired, which its own ' +
        'error detail names; anything else is a fault worth reporting with the request id below.',
    ]
  }
  return [
    `The deployment refused with ${error.status} '${error.code}', which this gate has no specific ` +
      `remedy for: the detail above is the deployment's own account of it.`,
  ]
}

/** The request id, which is what joins this failure to the deployment's own log line. */
function requestIdStep(error: CatFactoryApiError): readonly string[] {
  return error.requestId
    ? [`Quote request id ${error.requestId} when reading the deployment log for this call.`]
    : []
}

/**
 * Describe a thrown probe: what happened, its class, and the remedy for it.
 *
 * An SDK error is checked FIRST and never reaches the connection describer, because a refusal the
 * deployment stated is proof the transport worked; classifying it would report a healthy connection
 * as an unrecognised transport failure.
 *
 * For a transport failure the remedy leads with kernel's own hint, because that sentence names the
 * target and the action ("Nothing is listening at http://127.0.0.1:8787 … Start it") and a
 * paraphrase here would be a second, staler copy of it. It is the same rule `deployment-health`
 * follows for the backend's per-variable config problems.
 *
 * Kernel's hints close with "then test again", written for the connect forms they were built for,
 * and the last step here is what names this suite's equivalent of that button. Rewriting the clause
 * would mean string surgery on another module's prose, which is how a relay becomes a copy.
 */
export function describeProbeFailure(
  error: unknown,
  probe: ConnectionFailureContext = {},
): ProbeFailure {
  if (error instanceof CatFactoryApiError) {
    // No base-URL step in general: an answer in our own envelope is proof the origin IS a
    // cat-factory backend, so re-reading the address would send a reader to check the one thing this
    // failure has already settled. `answeredSteps` adds it back for the single 404 that has not.
    return {
      cause: 'unknown',
      status: error.status,
      detail: getErrorMessage(error) || `HTTP ${error.status}`,
      remedy: buildRemedy(
        [...answeredSteps(error, probe.target), ...requestIdStep(error)],
        probe.target,
      ),
    }
  }
  const { cause, detail, hint } = describeConnectionFailure(error, probe)
  return {
    cause,
    detail,
    remedy: buildRemedy(
      [...(hint ? [hint] : UNCLASSIFIED_STEPS), baseUrlStep(probe.target)],
      probe.target,
    ),
  }
}

/**
 * The steps plus the one read-only command worth carrying, which is the half a terminal can do: the
 * unauthenticated root read that also answers for a deployment too broken to authenticate anything.
 */
function buildRemedy(steps: readonly string[], target: string | undefined): Remedy {
  return {
    steps: [
      ...steps,
      'Fix that, then re-run the suite. Nothing was created, so a re-run starts clean.',
    ],
    ...(target
      ? {
          commands: [
            {
              run: `curl -sS '${target}/health'`,
              purpose: 'reach the backend the suite is pointed at, with no credential involved',
            },
          ],
        }
      : {}),
  }
}

/**
 * The `unknown` verdict a thrown probe becomes. See `preflight.ts` rule 2 for why that is its own
 * state rather than an `unsatisfied`: a probe that failed is not evidence about the thing probed.
 *
 * Three summary shapes for three facts that need different fixes, because this line is the only part
 * the streamed one-per-prerequisite output prints and a reader triages from it. It deliberately does
 * not restate "this is a fact about the CHECK": `formatPrerequisiteFailure` prints that verbatim
 * directly above the remedy, and a first step repeating the line above it wastes the step.
 */
export function probeFailureVerdict(
  error: unknown,
  probe: ConnectionFailureContext = {},
): PrerequisiteVerdict {
  const { cause, status, detail, remedy } = describeProbeFailure(error, probe)
  return { status: 'unknown', probeFailure: summarize(cause, status, detail), remedy }
}

function summarize(
  cause: ConnectionFailureCause,
  status: number | undefined,
  detail: string,
): string {
  if (status !== undefined) return `the deployment refused the check: ${detail}`
  if (cause !== 'unknown') return `the probe could not connect (${cause}): ${detail}`
  return `the check threw: ${detail}`
}
