// Driving the deployment through the PUBLISHED client, not hand-rolled HTTP.
//
// The suite imports `@cat-factory/sdk` (the same artifact an integrator installs from npm)
// rather than calling `/api/v1` with `fetch`. That is deliberate on two counts: an acceptance
// test that hand-rolls requests proves the routes work and says nothing about whether anyone
// can USE them, and the SDK is generated from the contracts, so a surface change that breaks an
// integration breaks this suite at COMPILE time instead of at 3am against a live cluster.

import { CatFactoryClient } from '@cat-factory/sdk'
import type {
  CreatePublicTask,
  PublicDecisionList,
  PublicIdentity,
  PublicRun,
  PublicService,
  PublicTask,
} from '@cat-factory/sdk'
import type { AcceptanceConfig } from './config.ts'
import { waitFor } from './deadline.ts'
import { isActionable } from './decisions.ts'
import { deploymentOutageTolerance } from './deploymentOutage.ts'
import type { Journal } from './journal.ts'
import type { PersonalUnlock } from './personalUnlock.ts'
import { type PinnedPreset, pinnedModel } from './presets.ts'

export type { PublicDecisionList, PublicIdentity, PublicRun, PublicService }

/**
 * How many times a call made DURING a pass may be replayed. See {@link createPassClient}.
 *
 * Sized against a supervisor relaunch rather than picked round. The SDK's backoff is full jitter on
 * a doubling base capped at 8s, so eight attempts average about sixteen seconds and cannot exceed
 * about thirty-two: enough for a kill, a reap and a boot that runs its migrations before it binds.
 * A longer absence is what the poll's two-minute grace is for, and the two are deliberately an
 * order of magnitude apart.
 */
const PASS_RETRY_BUDGET = 8

function buildClient(
  config: Pick<AcceptanceConfig, 'baseUrl' | 'apiKey'>,
  unlock: PersonalUnlock | undefined,
  maxRetries: number | undefined,
): CatFactoryClient {
  return new CatFactoryClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(unlock
      ? {
          fetch: ((input, init) =>
            globalThis.fetch(input, {
              ...init,
              headers: { ...(init?.headers as Record<string, string>), ...unlock.headers() },
            })) satisfies typeof globalThis.fetch,
        }
      : {}),
  })
}

/**
 * The client for anything that runs BEFORE a pass has spent something: preflight, and `reset`.
 *
 * On the SDK's own retry default, which is the point of it. Every check in `prerequisites.ts`
 * reaches the deployment, they run in sequence and NONE of them bails early (collecting every
 * problem in one report is what the gate is for), so a budget raised here multiplies across a
 * dozen probes. Against the commonest setup failure of all, a deployment that is simply not
 * running, that turns the clearest refusal this suite can produce into minutes of silence before
 * it prints: the exact outcome `probeFailure.ts` exists to prevent, arriving by a different route.
 * Nothing has been created at that point and a re-run costs nothing, so refusing fast is strictly
 * better than sitting through a restart.
 *
 * The password rides through the `fetch` seam rather than the client's `headers` option, and that
 * is forced by what the password IS: `headers` is snapshotted at construction, while this one is
 * not known until a call has already been refused for want of it, and must then travel on EVERY
 * later request (each answered decision re-mints the run's activation server-side). Threading it
 * through the transport keeps a single place where it is attached, so no call site can forget it
 * and none has to hold a copy.
 *
 * Absent unlock ⇒ the plain client, byte for byte: a workspace on a provider API key sends no such
 * header and is never asked for a password.
 *
 * Takes the two fields it addresses rather than the whole config, so a command that holds only the
 * BOARD half (`reset`) drives the same client the scenarios do instead of a second one built beside it.
 */
export function createClient(
  config: Pick<AcceptanceConfig, 'baseUrl' | 'apiKey'>,
  unlock?: PersonalUnlock,
): CatFactoryClient {
  return buildClient(config, unlock, undefined)
}

/**
 * The client a SCENARIO BODY drives, where a restart costs an afternoon rather than a re-run.
 *
 * **This is where a deployment restart is absorbed for every ONE-SHOT call.** The polls have their
 * own tolerance (`deploymentOutage.ts`), but a pass makes dozens of reads between them
 * (`tasks.getRun`, `evidence.getReport`, `services.list`) and a restart landing on one of those
 * threw straight out with no observation, which is the failure the poll tolerance was written for
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
 * work. Against preflight, where nothing has been spent yet, it is not, which is why that half
 * runs on {@link createClient}.
 */
export function createPassClient(
  config: Pick<AcceptanceConfig, 'baseUrl' | 'apiKey'>,
  unlock?: PersonalUnlock,
): CatFactoryClient {
  return buildClient(config, unlock, PASS_RETRY_BUDGET)
}

/**
 * The pinned preset with the catalog row its base model resolves to, or `null` when either is gone.
 *
 * The two list reads that answer "what does this pass actually run on", in ONE place, because the
 * question is asked from two processes that cannot share an answer: the up-front unlock asks it in
 * the main process before any worker exists, and the `model-preset` prerequisite asks a WIDER
 * version of it inside a worker (it needs the whole library to name the alternatives in its
 * refusal). The round trips are therefore not duplication to remove; the join is, and it lives here
 * beside the client rather than in `presets.ts`, which stays pure.
 *
 * Deliberately not `ConfigureClient`'s pair of reads: that port narrows the catalog row to the
 * fields its menu branches on, and the fields the unlock prompt NAMES to an operator (`label`,
 * `provider`) are exactly the ones it drops. Widening a documented port for a second consumer's
 * prose is the wrong direction; both read the same endpoint through the same SDK.
 */
export async function readPinnedPreset(
  client: CatFactoryClient,
  presetId: string,
): Promise<PinnedPreset | null> {
  const [{ presets }, { models }] = await Promise.all([
    client.modelPresets.list(),
    client.models.list(),
  ])
  return pinnedModel(presets, models, presetId)
}

/**
 * File a task with the pass's model preset PINNED. The suite's only door onto task creation.
 *
 * One helper rather than the field repeated at each `client.tasks.create` call, because the value
 * of pinning is that EVERY run of a pass runs on the model the pass names, and a site that forgot
 * the field would silently resolve the workspace default instead: a result that reads exactly like
 * the others and was produced by a different model. There are five such sites (two scaffolds, two
 * feature halves, one bug report) and nothing would fail if one of them drifted.
 *
 * Only the model preset is pinned. The RISK POLICY is deliberately left to resolve, because
 * `auto-merge-policy` grades the workspace default and a pin here would make that gate a check on
 * a policy no run of this suite uses.
 */
export function filePinnedTask(
  client: CatFactoryClient,
  config: AcceptanceConfig,
  serviceId: string,
  task: Omit<CreatePublicTask, 'modelPresetId'>,
): Promise<PublicTask> {
  return client.tasks.create(serviceId, { ...task, modelPresetId: config.modelPresetId })
}

/**
 * What is wrong with the key, or null. Checked before anything is created.
 *
 * Two failures this catches, both of which would otherwise appear much later wearing a
 * misleading face: a key bound to a DIFFERENT workspace than `ACCEPTANCE_WORKSPACE_ID` (the pass
 * then creates its repositories and services on that workspace's board while every assertion
 * about THIS one answers 404, which reads as a broken deployment), and a key below `admin`
 * (scenario 01 creates services and scenario 03 answers a human gate, so a `write` key gets a third of
 * the way and refuses).
 *
 * A returned value rather than a throw, because the prerequisite gate reports it as one verdict
 * beside nine others: refusing out of the first probe is what collecting every problem exists to
 * avoid.
 *
 * The `code` is a CLOSED vocabulary rather than decoration on the prose: the two failures have
 * different fixes (one is an environment variable, the other is a token that must be minted
 * again), so `prerequisites.ts` keys its instructions off it and gains a compile error rather
 * than a paraphrase when a third failure is added here.
 */
export type KeyProblem = {
  code: 'workspace-mismatch' | 'insufficient-scope'
  problem: string
}

export function describeKeyProblem(
  identity: PublicIdentity,
  workspaceId: string,
): KeyProblem | null {
  if (identity.workspaceId !== workspaceId) {
    return {
      code: 'workspace-mismatch',
      problem:
        `CAT_FACTORY_API_KEY is bound to workspace ${identity.workspaceId}, but ` +
        `ACCEPTANCE_WORKSPACE_ID is ${workspaceId}. The public API is workspace-scoped and the ` +
        `app-API setup calls are addressed by id, so the two must name the same board.`,
    }
  }
  // The ladder is INCLUSIVE, so this is the rung test the contract asks for, not an equality
  // check: `admin` is the top and is what scenario 01 (create a service) and scenario 03 (answer the
  // clarity gate, which needs `decide`) between them require.
  if (identity.scope !== 'admin') {
    return {
      code: 'insufficient-scope',
      problem:
        `CAT_FACTORY_API_KEY is scoped '${identity.scope}'. This suite creates services (admin) ` +
        `and answers a parked human gate (decide), so it needs an 'admin' key.`,
    }
  }
  return null
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
 * The listed kinds are split by whether the suite may act on one NOW, because that is the
 * distinction a person watching a long wait needs: a `clarity-review` sitting in the in-flight
 * column is the driver folding in answers and is the run working, where the same kind in the
 * answerable column with nothing happening is the suite failing to answer a park.
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
 * Wait until the run is parked on a decision this suite can answer NOW, or settles without asking.
 *
 * Readiness is `isActionable`, never a non-empty list. A listed decision the driver still owns (a
 * clarity review mid-incorporation, a follow-up set whose every item is settled) is the run
 * WORKING, and returning on it would spin this loop against the deployment at full speed for as
 * long as the driver took, answering nothing and pushing writes at a review nobody handed over.
 *
 * Polling rather than the SSE stream, deliberately. The stream is the better channel for a UI
 * and this suite is not one: an hour-long wait over one long-lived connection has to handle
 * reconnects and gap-filling to stay correct, and getting that wrong shows up as a flaky
 * acceptance test, the one failure mode nobody can afford here. A poll re-asks the point read,
 * which is authoritative by construction and carries every step's whole output (the stream
 * clips them; see `truncated` on the run-step contract).
 *
 * **This is the wait that carries the outage tolerance**, because it is where a pass spends its
 * hours and therefore where a long outage lands (see `deploymentOutage.ts`). It is not the only
 * cover: the one-shot calls around it ride the client's raised retry budget, which absorbs a
 * restart on any READ (see {@link createClient}). What neither covers is a restart landing exactly
 * on a write, and deliberately so: replaying `decisions.answer` is not a decision this suite may
 * make on the deployment's behalf.
 */
export function waitForDecisionOrSettled(options: {
  client: CatFactoryClient
  journal: Journal
  taskId: string
  runId: string
  budgetMs: number
}): Promise<{ run: PublicRun; decisions: PublicDecisionList }> {
  const { client, journal, taskId, runId, budgetMs } = options
  return waitFor({
    label: `task ${taskId} to park on an answerable decision or settle`,
    budgetMs,
    tolerate: deploymentOutageTolerance(),
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
