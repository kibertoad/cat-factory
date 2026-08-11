// What a THROWN prerequisite probe means, and what to do about it.
//
// Every prerequisite in this suite reaches the deployment over HTTP, and on Node a transport failure
// is a bare `TypeError: fetch failed`. What actually happened (`connect ECONNREFUSED
// 127.0.0.1:8787`, `getaddrinfo ENOTFOUND`, a self-signed certificate) hangs off `.cause`, or off an
// `AggregateError`'s `.errors` when the host resolved to both `::1` and `127.0.0.1`. So the obvious
// `error instanceof Error ? error.message : String(error)` renders the single least informative
// string in the whole chain.
//
// That is what this module exists to stop, and the cost was not hypothetical: a deployment that was
// simply not started reported
//
//     deployment-health: the check threw: fetch failed
//
// under a remedy listing three causes it had not distinguished (not running / base URL naming the
// SPA / a key that is missing, revoked or under-scoped), two of which were about a credential that
// was never sent. The gate's entire value is naming WHICH setup mistake a pass hit, so a probe that
// cannot say which one is the gate failing at its own job.
//
// The walk, the classification and the per-cause remedy are all kernel's
// (`describeConnectionFailure`), the platform's ONE producer of them and what every "Test
// connection" button in the product already answers through. This module RELAYS that verdict and
// adds only what kernel cannot know: that this base URL was typed into a `.env` by hand, and that an
// unclassified throw here is as likely to be an answered-but-refused request as a transport failure.

import { describeConnectionFailure } from '@cat-factory/kernel'
import type { ConnectionFailureCause, ConnectionFailureContext } from '@cat-factory/kernel'
import type { PrerequisiteVerdict, Remedy } from './preflight.ts'

/**
 * What the SPA-vs-backend mixup looks like from here, which is the one setup mistake kernel's hints
 * cannot name: it knows a port refused a connection, not that a human chose the port.
 *
 * Both halves of the trap are stated because they fail differently. A base URL naming the SPA's port
 * connects and answers a `/health` of its own (so the probe never throws and this module never
 * runs); one naming a port nothing serves is the `refused` above. What is common is that the value
 * came from a file rather than from a discovery, so it is the first thing worth re-reading.
 */
function baseUrlSteps(target: string | undefined): readonly string[] {
  const named = target ? `CAT_FACTORY_BASE_URL (${target})` : 'CAT_FACTORY_BASE_URL'
  return [
    `Re-read ${named} in backend/internal/acceptance/.env: it names the BACKEND origin serving ` +
      `/api/v1, not the SPA, and a shell export of the same variable wins over the file.`,
  ]
}

/**
 * The three things an UNCLASSIFIED throw could be, which is honestly all that is known about one.
 *
 * Reached when kernel matched no transport cause, and that covers two different situations on
 * purpose: a transport failure whose code we do not recognise, and a request that was answered and
 * then refused (a 503 from the misconfigured fallback app, a key the deployment rejected, a body the
 * SDK could not parse). The second is why the credential guesses belong HERE and nowhere else: on a
 * classified `refused` no credential was ever sent, so listing them sent an operator to check a key
 * that could not have been involved.
 */
const UNCLASSIFIED_STEPS: readonly string[] = [
  'Nothing in the thrown chain named a transport failure, so this is as likely to be a request ' +
    'that WAS answered and then refused: a 503 from the misconfigured fallback app, a rejected ' +
    'key, or a body the SDK could not parse.',
  'Check, in that order: the deployment is running and past its own config validation, ' +
    'CAT_FACTORY_API_KEY is set and not revoked, and its scope is "Full access".',
]

export type ProbeFailure = {
  /** kernel's machine-readable transport class, or `unknown` when the chain matched none. */
  cause: ConnectionFailureCause
  /** The flattened, scrubbed cause chain: exactly what the runtime reported, innermost cause first. */
  detail: string
  remedy: Remedy
}

/**
 * Describe a thrown probe: the real cause chain, its class, and the remedy for it.
 *
 * The remedy leads with kernel's own hint when the cause is recognised, because that sentence names
 * the target and the action ("Nothing is listening at http://127.0.0.1:8787 … Start it") and a
 * paraphrase here would be a second, staler copy of it. It is the same rule `deployment-health`
 * follows for the backend's per-variable config problems.
 */
export function describeProbeFailure(
  error: unknown,
  probe: ConnectionFailureContext = {},
): ProbeFailure {
  const { cause, detail, hint } = describeConnectionFailure(error, probe)
  const steps = [
    ...(hint ? [hint] : UNCLASSIFIED_STEPS),
    ...baseUrlSteps(probe.target),
    'Fix that, then re-run the suite. Nothing was created, so a re-run starts clean.',
  ]
  return {
    cause,
    detail,
    remedy: {
      steps,
      ...(probe.target
        ? {
            commands: [
              {
                run: `curl -sS '${probe.target}/health'`,
                purpose: 'reach the backend the suite is pointed at, with no credential involved',
              },
            ],
          }
        : {}),
    },
  }
}

/**
 * The `unknown` verdict a thrown probe becomes. See `preflight.ts` rule 2 for why that is its own
 * state rather than an `unsatisfied`: a probe that failed is not evidence about the thing probed.
 *
 * The class rides the summary line because that line is what a reader sees first, on the streamed
 * one-per-prerequisite output where the remedy is not printed at all. It deliberately does not
 * restate "this is a fact about the CHECK": `formatPrerequisiteFailure` prints that verbatim
 * directly above the remedy, and a first step repeating the line above it wastes the step.
 */
export function probeFailureVerdict(
  error: unknown,
  probe: ConnectionFailureContext = {},
): PrerequisiteVerdict {
  const { cause, detail, remedy } = describeProbeFailure(error, probe)
  return {
    status: 'unknown',
    probeFailure:
      cause === 'unknown'
        ? `the check threw: ${detail}`
        : `the probe could not connect (${cause}): ${detail}`,
    remedy,
  }
}
