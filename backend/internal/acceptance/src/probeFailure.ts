// What a THROWN prerequisite probe means, and what to do about it.
//
// Every prerequisite in this suite reaches the deployment over HTTP, so a probe fails in one of
// three fundamentally different ways, and the gate used to render all of them as the same sentence.
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
// nothing in the message pointed at. The unauthenticated root reads answer here too, through
// `DeploymentAnswerError`, and their status is worth as much: theirs is the FIRST prerequisite an
// operator reads, and as a plain `Error` it fell through to the unclassified branch and was reported
// as "no HTTP status came back … suspect the check itself" one line under a detail quoting the 404.
//
// **Something answered, and it was not this deployment.** A 2xx whose body is not the JSON the route
// documents is not a refusal and not a transport fault: it is the SPA (which serves a `/health` of
// its own), a login portal, or a gateway intercepting the path. It is also the ONLY answered failure
// that puts the address back in question, which is why it does not share the refusal's remedy.
//
// The gate's whole value is naming WHICH setup mistake a pass hit, so a probe that cannot say which
// one is the gate failing at its own job.
//
// The walk, the classification and the per-cause remedy for the first kind are all kernel's
// (`describeConnectionFailure`), the platform's ONE producer of them and what every "Test
// connection" button in the product already answers through. This module relays that verdict, adds
// the other two kinds, and contributes only what neither can know: that this base URL was typed into
// a `.env` by hand.

import {
  connectionFailureHint,
  describeConnectionFailure,
  errorChainText,
  MAX_LOGGED_ERROR_CHAIN_CHARS,
} from '@cat-factory/kernel'
import type {
  ConnectionFailureCause,
  ConnectionFailureContext,
  ConnectionFailureDescription,
} from '@cat-factory/kernel'
import { CatFactoryApiError, CatFactoryDecodeError, CatFactoryTimeoutError } from '@cat-factory/sdk'
import { DeploymentAnswerError } from './deploymentApi.ts'
import { scrubbed, shellQuoted } from './operatorText.ts'
import type { PrerequisiteVerdict, Remedy } from './preflight.ts'

/**
 * What the SPA-vs-backend mixup looks like from here, which is the one setup mistake neither
 * describer can name: they know a port refused a connection, not that a human chose the port.
 *
 * Both halves of the trap are stated because they fail differently. A base URL naming the SPA's port
 * connects and answers a `/health` of its own (so the probe throws only once something reads the
 * BODY of it); one naming a port nothing serves is the `refused` above. What is common is that the
 * value came from a file rather than from a discovery, so it is the first thing worth re-reading.
 *
 * Exported because three different verdicts have to say this and a paraphrase at each was three
 * copies drifting apart: `deployment-health` relays it for a `/health` that answered the wrong
 * WORD, and both answered-in-the-wrong-shape branches below relay it for one that answered the
 * wrong SHAPE.
 */
export function baseUrlStep(target: string | undefined): string {
  const named = target ? `CAT_FACTORY_BASE_URL (${scrubbed(target)})` : 'CAT_FACTORY_BASE_URL'
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
 *
 * The second step is conditional on there BEING a command, rather than a constant promising one: a
 * runner that supplied no probe target carries none, and an instruction to run "the command below"
 * with nothing below it sends a reader hunting for a line that was never printed.
 */
function unclassifiedSteps(reachTarget: string | undefined): readonly string[] {
  return [
    'Nothing in the thrown chain named a transport failure and no HTTP status came back, so this ' +
      'is neither a reachability problem nor a refusal: suspect the check itself, or a proxy ' +
      'answering in a shape neither the SDK nor the connection describer recognises.',
    ...(reachTarget
      ? ['Confirm the deployment answers at all with the command below, which takes no credential.']
      : []),
  ]
}

/**
 * What a thrown probe was, as three DISJOINT states rather than one shape with optional fields.
 *
 * The discriminant is load-bearing and replaced a flat record whose `cause` was overloaded with
 * `unknown` to mean "the deployment answered": a comment was the only thing standing between a
 * reader and treating an answered refusal as a transport verdict, and `summarize` had to re-derive
 * the branch from whether an optional `status` happened to be set.
 *
 * `detail` is what happened, on every member: the flattened, scrubbed cause chain, or the answer
 * itself. It is written out per member rather than intersected over the union, so narrowing on
 * `kind` is the plain read TypeScript is best at (the shape `PrerequisiteVerdict` takes).
 */
export type ProbeFailure =
  /** The deployment answered, and the answer was a refusal. The STATUS is the fact. */
  | { kind: 'answered'; status: number; detail: string; remedy: Remedy }
  /**
   * Something answered, but not in the shape the route documents, so the ORIGIN is the fact and a
   * status would only mislead: a 200 is what the SPA and a login portal both answer.
   */
  | { kind: 'foreign'; detail: string; remedy: Remedy }
  /** No answer arrived at all. `cause` is kernel's transport class, `unknown` when unmatched. */
  | { kind: 'unanswered'; cause: ConnectionFailureCause; detail: string; remedy: Remedy }

/**
 * The remedy for an ANSWERED refusal through `/api/v1`, which is a different question from an
 * unreachable host: the deployment is up, so what is wrong is the request, the credential, or the
 * deployment's own age.
 *
 * The 404 branch is the one worth reading twice. A route the deployment does not serve answers
 * Hono's built-in 404, which carries no `{ error: { code } }` envelope, so the SDK fills `code` with
 * `unknown`; a domain 404 from `handleError` carries `not_found`. That difference is the only
 * evidence available that the OPERATION is missing rather than the resource, and it is precisely the
 * shape of a deployment built before the suite that drives it. Both readings are stated, in the
 * order their fixes are cheap to try.
 */
function apiSteps(error: CatFactoryApiError, target: string | undefined): readonly string[] {
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
        'error detail names; anything else is a fault worth reporting' +
        // Conditional, because `requestIdStep` omits the id when the response carried none, which
        // is what a gateway answering a 502 in the deployment's place does. Promising a line that
        // the next step then does not print is how a remedy loses a reader's trust in the rest.
        (error.requestId ? ' with the request id below.' : '.'),
    ]
  }
  return [
    `The deployment refused with ${error.status} '${error.code}', which this gate has no specific ` +
      `remedy for: the detail above is the deployment's own account of it.`,
  ]
}

/**
 * The remedy for an answered ROOT read (`GET /health`, `GET /auth/config`), which is a different
 * accusation from the same status on `/api/v1`.
 *
 * Both routes are unauthenticated BY DESIGN (a key-authenticated health check cannot describe a
 * deployment too broken to authenticate a key), so no status here is evidence about
 * `CAT_FACTORY_API_KEY`, and saying so is most of the value: the remedy this replaced sent readers
 * to inspect a token that was never sent. What a status DOES narrow is which layer answered, since
 * a cat-factory backend serves both routes on every boot it survives at all.
 */
function rootReadSteps(
  error: DeploymentAnswerError,
  target: string | undefined,
): readonly string[] {
  const request = `${error.method} ${scrubbed(error.url)}`
  const steps = [
    `${request} answered ${error.status}. This read carries no credential by design, so nothing ` +
      `about CAT_FACTORY_API_KEY is implicated: a cat-factory backend serves this route on every ` +
      `boot it survives, so what answered is either not one or is not the layer that would.`,
  ]
  if (error.status === 404) {
    steps.push(
      'A 404 means nothing at that origin serves this path at all. The SPA answers a /health of ' +
        'its own, so this is neither the backend nor the SPA: usually a reverse proxy routing only ' +
        'some paths, or a port serving something else entirely.',
    )
  } else if (error.status === 401 || error.status === 403) {
    steps.push(
      'Something in FRONT of the deployment is demanding a credential this route never requires: ' +
        'an authenticating proxy, an access gateway, or a preview environment behind protection. ' +
        'The suite cannot pass one to it, so the deployment has to be reachable without it.',
    )
  } else if (error.status >= 500) {
    steps.push(
      'Read the deployment log, and the log of anything terminating TLS in front of it. A backend ' +
        'that failed its own config validation still answers this route (with a problem list this ' +
        'gate relays), so a 5xx here is a boot failure or a gateway rather than a misconfiguration.',
    )
  }
  steps.push(baseUrlStep(target))
  return steps
}

/**
 * The remedy for an answer that came back in nobody's expected shape, from either surface.
 *
 * The distinction this exists to make: a refusal the deployment states arrives in its own error
 * envelope, so a body that is not JSON at all is evidence about WHAT is on that origin rather than
 * about the request. It is the mixup with the highest prior in this suite, and the one an operator
 * is least likely to suspect, because everything they configured is running.
 */
function foreignSteps(target: string | undefined): readonly string[] {
  return [
    'Something answered, and it was not this deployment: the body is not the JSON the route ' +
      'documents. Every refusal a cat-factory backend states comes back in its own error envelope, ' +
      'so this is a fact about the ORIGIN rather than about the request or the credential.',
    'The SPA is the usual answer (it serves a /health of its own and an HTML page for everything ' +
      'else), followed by a login portal, a tunnel splash page, or a gateway that intercepts the ' +
      'path. The detail above holds the first characters of what came back, which normally names it.',
    baseUrlStep(target),
  ]
}

/** An answer in nobody's shape, from either surface: the ORIGIN is what a reader is sent to check. */
function foreignFailure(error: unknown, target: string | undefined): ProbeFailure {
  return {
    kind: 'foreign',
    detail: detailOf(error),
    remedy: buildRemedy(foreignSteps(target), target),
  }
}

/** The request id, which is what joins this failure to the deployment's own log line. */
function requestIdStep(error: CatFactoryApiError): readonly string[] {
  return error.requestId
    ? [`Quote request id ${error.requestId} when reading the deployment log for this call.`]
    : []
}

/**
 * The chain as this suite prints it: scrubbed, and capped at the LOG budget rather than the human
 * one.
 *
 * The two budgets exist because the readers do (kernel documents the split), and this reader is a
 * terminal: an operator reading a failed `beforeAll`, with the deployment's own account of itself in
 * the detail. Under the human cap a 502 whose body ran to a few hundred characters lost its tail,
 * and a root read carries up to 2000 characters of body precisely because a fallback app's problem
 * list and a gateway's error page are where the fix is named.
 */
function detailOf(error: unknown): string {
  return errorChainText(error, MAX_LOGGED_ERROR_CHAIN_CHARS)
}

/**
 * kernel's transport verdict, with the ONE cause it cannot see corrected.
 *
 * The SDK's own deadline arrives as a `CatFactoryTimeoutError` whose abort marker is deliberately
 * NAMED `AbortError` (that is how the transport tells its deadline from a caller's cancellation,
 * which it must never retry), and kernel classifies deepest-first by that name, so a hung or
 * firewalled deployment was reported as `aborted`: "a request superseded or a process shutting
 * down: run the test again". That is the opposite of the truth here, and it withholds the timeout
 * remedy naming the causes that actually produce it, a firewall silently dropping packets and a
 * saturated host. The class is known from the TYPE; the sentence is still kernel's.
 */
function classifyUnanswered(
  error: unknown,
  probe: ConnectionFailureContext,
): ConnectionFailureDescription {
  const described = describeConnectionFailure(error, probe)
  if (!(error instanceof CatFactoryTimeoutError)) return described
  const hint = connectionFailureHint('timeout', probe)
  return { cause: 'timeout', detail: described.detail, ...(hint ? { hint } : {}) }
}

/**
 * Describe a thrown probe: what happened, its class, and the remedy for it.
 *
 * An answered failure is checked FIRST and never reaches the connection describer, because a status
 * the deployment (or something in front of it) put on the wire is proof the transport worked;
 * classifying it would report a healthy connection as an unrecognised transport failure.
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
    // No reachability command and no base-URL step in general: an answer in our own envelope is
    // proof the origin IS a cat-factory backend, so both would send a reader to check the one thing
    // this failure has already settled. `apiSteps` reopens it for the single 404 that has not.
    const reopensAddress = error.status === 404 && error.code === 'unknown'
    return {
      kind: 'answered',
      status: error.status,
      detail: detailOf(error) || `HTTP ${error.status}`,
      remedy: buildRemedy(
        [...apiSteps(error, probe.target), ...requestIdStep(error)],
        reopensAddress ? probe.target : undefined,
      ),
    }
  }
  // Handled in ONE place, exhaustively over the closed `answer` union rather than as two
  // `instanceof …&& answer ===` tests: a third member added there would otherwise fall through to
  // the transport branch below and be reported as a failure that never reached the deployment,
  // which is the worst of the three wrong answers.
  if (error instanceof DeploymentAnswerError) {
    if (error.answer === 'refused') {
      return {
        kind: 'answered',
        status: error.status,
        detail: detailOf(error) || `HTTP ${error.status}`,
        remedy: buildRemedy(rootReadSteps(error, probe.target), probe.target),
      }
    }
    return foreignFailure(error, probe.target)
  }
  // The same state reached from the other surface: a `/api/v1` reply that was not JSON. Neither is a
  // refusal (nothing came back in our envelope) and neither is a transport fault.
  if (error instanceof CatFactoryDecodeError) return foreignFailure(error, probe.target)
  const { cause, detail, hint } = classifyUnanswered(error, probe)
  return {
    kind: 'unanswered',
    cause,
    detail,
    remedy: buildRemedy(
      [...(hint ? [hint] : unclassifiedSteps(probe.target)), baseUrlStep(probe.target)],
      probe.target,
    ),
  }
}

/**
 * The steps plus the one read-only command worth carrying, which is the half a terminal can do: the
 * unauthenticated root read that also answers for a deployment too broken to authenticate anything.
 *
 * `reachTarget` is the address to offer it against, and it is absent for two different reasons that
 * both mean "no command": the runner supplied no probe context, or the failure ALREADY proves the
 * deployment answers, in which case a reachability check tests the one thing that is settled.
 *
 * The closing step is what names this suite's equivalent of the "then test again" kernel's hints end
 * on. It says how to re-run rather than claiming nothing was created: this gate runs in EVERY spec's
 * `beforeAll` so a resumed pass reaches it with services adopted and pull requests open, and telling
 * that operator a re-run starts clean is how they start a second pass that `board-titles` then
 * refuses.
 *
 * It names the ID and never `latest`, which it used to offer as an equivalent. The pointer follows
 * the most recent pass to record a FACT, and this failure is reached from every spec's `beforeAll`,
 * including the first one of a pass that has recorded none: exactly when the two name different
 * passes, and following `latest` there resumes an older half-built one instead.
 */
function buildRemedy(steps: readonly string[], reachTarget: string | undefined): Remedy {
  return {
    steps: [
      ...steps,
      'Fix that, then re-run the suite. A pass that has already created things resumes when ' +
        'ACCEPTANCE_RUN_ID is set to the run id printed above this failure, in the shell or in ' +
        'the `.env`; only a pass that created nothing yet starts clean.',
    ],
    ...(reachTarget
      ? {
          commands: [
            {
              run: `curl -sS ${shellQuoted(`${reachTarget}/health`)}`,
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
 * Four summary shapes for four facts that need different fixes, because this line is the only part
 * the streamed one-per-prerequisite output prints and a reader triages from it. It deliberately does
 * not restate "this is a fact about the CHECK": `formatPrerequisiteFailure` prints that verbatim
 * directly above the remedy, and a first step repeating the line above it wastes the step.
 */
export function probeFailureVerdict(
  error: unknown,
  probe: ConnectionFailureContext = {},
): PrerequisiteVerdict {
  const failure = describeProbeFailure(error, probe)
  return { status: 'unknown', probeFailure: summarize(failure), remedy: failure.remedy }
}

function summarize(failure: ProbeFailure): string {
  if (failure.kind === 'answered') return `the deployment refused the check: ${failure.detail}`
  if (failure.kind === 'foreign') {
    return `something that is not this deployment answered: ${failure.detail}`
  }
  if (failure.cause !== 'unknown') {
    return `the probe could not connect (${failure.cause}): ${failure.detail}`
  }
  return `the check threw: ${failure.detail}`
}
