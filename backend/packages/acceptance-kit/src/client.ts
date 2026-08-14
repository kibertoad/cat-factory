// Driving the deployment through the PUBLISHED client, not hand-rolled HTTP.
//
// A suite built on this kit imports `@cat-factory/sdk` (the same artifact an integrator installs
// from npm) rather than calling `/api/v1` with `fetch`. That is deliberate on two counts: an
// acceptance test that hand-rolls requests proves the routes work and says nothing about whether
// anyone can USE them, and the SDK is generated from the contracts, so a surface change that breaks
// an integration breaks the suite at COMPILE time instead of at 3am against a live cluster.
//
// What this module owns is the two CLIENTS (they differ only in how long a call waits on a
// deployment that is not answering, and the answer differs by what is at stake), the descriptions a
// long wait prints, and the one wait a pass spends its hours in.

import { CatFactoryClient } from '@cat-factory/sdk'
import type { PublicDecisionList, PublicRun } from '@cat-factory/sdk'
import { waitFor } from './deadline.js'
import { isActionable } from './decisions.js'
import { deploymentOutageTolerance } from './deploymentOutage.js'
import type { Journal } from './journal.js'

/** The deployment a suite is pointed at: an origin serving `/api/v1`, and a key bound to a board. */
export type DeploymentTarget = {
  baseUrl: string
  apiKey: string
}

export type ClientOptions = {
  /**
   * Extra headers, re-read on EVERY request.
   *
   * A function rather than a record, and that is forced by what such a header usually is: a
   * per-user credential is not known until a call has already been refused for want of it (`428`),
   * and must then travel on every later request, because answering a decision re-mints the run's
   * activation server-side. The SDK's `headers` option is snapshotted at construction, so this
   * rides the `fetch` seam instead, which keeps ONE place where it is attached: no call site can
   * forget it and none has to hold a copy.
   *
   * Absent ⇒ the plain client, byte for byte.
   */
  headers?: () => Record<string, string>
}

/**
 * How a call that may be refused for want of a PER-USER credential is retried.
 *
 * The seam between this kit and whatever a suite does about such a refusal: prompt an operator at
 * the terminal, read a vault, or refuse outright. The kit never holds the credential and never
 * decides how one is obtained; it only names the calls where the platform can ask for it.
 */
export type CredentialRetry = <T>(reason: string, call: () => Promise<T>) => Promise<T>

/**
 * The default: make the call, once.
 *
 * Named rather than written as `(_, call) => call()` at each site, so the absence of a credential
 * policy reads as a decision in the code rather than as an oversight.
 */
export const passThroughCredentialRetry: CredentialRetry = (_reason, call) => call()

/**
 * How many times a call made DURING a pass may be replayed. See {@link createPassClient}.
 *
 * Sized against a supervisor relaunch rather than picked round. The SDK's backoff is full jitter on
 * a doubling base capped at 8s, so eight attempts average about sixteen seconds and cannot exceed
 * about thirty-two: enough for a kill, a reap and a boot that runs its migrations before it binds.
 * A longer absence is what the poll's grace is for, and the two are deliberately an order of
 * magnitude apart.
 */
const PASS_RETRY_BUDGET = 8

function buildClient(
  target: DeploymentTarget,
  options: ClientOptions,
  maxRetries: number | undefined,
): CatFactoryClient {
  const extraHeaders = options.headers
  return new CatFactoryClient({
    baseUrl: target.baseUrl,
    apiKey: target.apiKey,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(extraHeaders
      ? {
          fetch: ((input, init) =>
            globalThis.fetch(input, {
              ...init,
              headers: { ...(init?.headers as Record<string, string>), ...extraHeaders() },
            })) satisfies typeof globalThis.fetch,
        }
      : {}),
  })
}

/**
 * The client for anything that runs BEFORE a pass has spent something: the preflight, and a cleanup.
 *
 * On the SDK's own retry default, which is the point of it. Every prerequisite reaches the
 * deployment, they run in sequence and none of them bails early (collecting every problem in one
 * report is what a gate is for), so a budget raised here multiplies across a dozen probes. Against
 * the commonest setup failure of all, a deployment that is simply not running, that turns the
 * clearest refusal a suite can produce into minutes of silence before it prints: the exact outcome
 * `probeFailure.ts` exists to prevent, arriving by a different route. Nothing has been created at
 * that point and a re-run costs nothing, so refusing fast is strictly better than sitting through a
 * restart.
 */
export function createClient(
  target: DeploymentTarget,
  options: ClientOptions = {},
): CatFactoryClient {
  return buildClient(target, options, undefined)
}

/**
 * The client a SCENARIO BODY drives, where a restart costs an afternoon rather than a re-run.
 *
 * **This is where a deployment restart is absorbed for every ONE-SHOT call.** The polls have their
 * own tolerance (`deploymentOutage.ts`), but a pass makes dozens of reads between them
 * (`tasks.getRun`, `evidence.getReport`, `services.list`) and a restart landing on one of those
 * throws straight out with no observation, which is the failure the poll tolerance was written for
 * arriving one call to the left. The SDK's OWN rule decides what may be replayed: `GET`/`HEAD`/
 * `DELETE` only, never a `POST`, so answering a decision is still exactly-once.
 *
 * **It replays more than a restart, and that is a trade rather than an oversight.** The SDK's
 * budget is one number over its own retriable set, which is every transport failure plus 429, 502,
 * 503 and 504. So a certificate that expired, a DNS entry that stopped resolving and a 503 naming
 * an unwired capability are each replayed too, and `deploymentOutage.ts` refuses all three by name.
 * The two policies differ because their failure modes do: a poll's tolerance REPLACES what the
 * expiry reports, so waiting through evidence there ends in the wrong message, while a retry here
 * rethrows the SDK's own typed error with its status and request id intact. What it costs is time,
 * and tens of seconds against a budget sized for a pipeline is worth paying to keep an hour of
 * work. Against a preflight, where nothing has been spent yet, it is not, which is why that half
 * runs on {@link createClient}.
 */
export function createPassClient(
  target: DeploymentTarget,
  options: ClientOptions = {},
): CatFactoryClient {
  return buildClient(target, options, PASS_RETRY_BUDGET)
}

/** A run status that will not change without someone doing something. */
export function isTerminal(status: PublicRun['status']): boolean {
  return status === 'done' || status === 'failed'
}

/**
 * One line describing where a run currently is.
 *
 * This is what a timed-out wait reports, so it is written for the person reading that message:
 * the step INDEX and kind matter more than the run id they already have, and the subtask counts
 * are the only signal that separates "the coder is working" from "the coder is wedged".
 */
export function describeRun(run: PublicRun): string {
  const step = run.steps[run.currentStep]
  const where = step
    ? `step ${run.currentStep} '${step.agentKind}' ${step.state}` +
      (step.subtasks ? ` (${step.subtasks.completed}/${step.subtasks.total} subtasks)` : '')
    : `step ${run.currentStep} (beyond the ${run.steps.length}-step chain)`
  const pr = run.pullRequest ? `, PR ${run.pullRequest.url}` : ''
  const failure = run.error ? `, error ${run.error.code}: ${run.error.message}` : ''
  return `run ${run.runId} status=${run.status}, ${where}${pr}${failure}`
}

/**
 * Describe what a run is asking for, for the same audience as `describeRun`.
 *
 * The listed kinds are split by whether a suite may act on one NOW, because that is the distinction
 * a person watching a long wait needs: a `clarity-review` sitting in the in-flight column is the
 * driver folding in answers and is the run working, where the same kind in the answerable column
 * with nothing happening is the suite failing to answer a park.
 */
export function describeDecisions(decisions: PublicDecisionList): string {
  const listed = decisions.decisions
  const answerable = listed.filter(isActionable)
  const inFlight = listed.filter((decision) => !isActionable(decision))
  const blocked = decisions.unanswerable.map((wait) => wait.reason).join(', ') || 'none'
  return (
    `answerable: [${kinds(answerable)}], in flight: [${kinds(inFlight)}], ` +
    `unanswerable: [${blocked}]`
  )
}

function kinds(decisions: PublicDecisionList['decisions']): string {
  return decisions.map((decision) => decision.kind).join(', ') || 'none'
}

/**
 * Wait until the run is parked on a decision the suite can answer NOW, or settles without asking.
 *
 * Readiness is `isActionable`, never a non-empty list. A listed decision the driver still owns (a
 * clarity review mid-incorporation, a follow-up set whose every item is settled) is the run
 * WORKING, and returning on it would spin this loop against the deployment at full speed for as
 * long as the driver took, answering nothing and pushing writes at a review nobody handed over.
 *
 * Polling rather than the SSE stream, deliberately. The stream is the better channel for a UI
 * and an acceptance suite is not one: an hour-long wait over one long-lived connection has to
 * handle reconnects and gap-filling to stay correct, and getting that wrong shows up as a flaky
 * acceptance test, the one failure mode nobody can afford here. A poll re-asks the point read,
 * which is authoritative by construction and carries every step's whole output (the stream
 * clips them; see `truncated` on the run-step contract).
 *
 * **This is the wait that carries the outage tolerance**, because it is where a pass spends its
 * hours and therefore where a long outage lands (see `deploymentOutage.ts`). It is not the only
 * cover: the one-shot calls around it ride the client's raised retry budget, which absorbs a
 * restart on any READ (see {@link createPassClient}). What neither covers is a restart landing
 * exactly on a write, and deliberately so: replaying `decisions.answer` is not a decision a suite
 * may make on the deployment's behalf.
 */
export function waitForDecisionOrSettled(options: {
  client: CatFactoryClient
  journal: Journal
  taskId: string
  runId: string
  budgetMs: number
  /** The suite's own "nothing was cleaned up" tail, printed under an expiry. */
  epilogue?: string
}): Promise<{ run: PublicRun; decisions: PublicDecisionList }> {
  const { client, journal, taskId, runId, budgetMs, epilogue } = options
  return waitFor({
    label: `task ${taskId} to park on an answerable decision or settle`,
    budgetMs,
    tolerate: deploymentOutageTolerance(),
    ...(epilogue === undefined ? {} : { epilogue }),
    probe: async () => {
      const run = await client.tasks.getRun(taskId)
      // Read decisions REGARDLESS of `parked`, as the contract instructs: a `follow-ups` entry
      // is answerable while the run is still working, so gating this read on `status === blocked`
      // would wait out a decision that was already there.
      const decisions = await client.decisions.list(runId)
      const ready = isTerminal(run.status) || decisions.decisions.some(isActionable)
      return ready
        ? { done: true, value: { run, decisions } }
        : { done: false, state: `${describeRun(run)}; ${describeDecisions(decisions)}` }
    },
    onProgress: reportObservation(journal),
  })
}

/**
 * Print each observation and append it to the journal.
 *
 * Both channels, because they answer different questions: the console is for whoever is watching
 * the run, and the journal is for the same person an hour later in a different window, which is
 * where "has the coder moved since 14:20" is actually asked.
 */
function reportObservation(journal: Journal): (state: string, elapsedMs: number) => void {
  return (state, elapsedMs) => {
    journal.say('observation', `[${Math.round(elapsedMs / 1000)}s] ${state}`)
  }
}
