// Driving the deployment through the PUBLISHED client, not hand-rolled HTTP.
//
// The suite imports `@cat-factory/sdk` (the same artifact an integrator installs from npm)
// rather than calling `/api/v1` with `fetch`. That is deliberate on two counts: an acceptance
// test that hand-rolls requests proves the routes work and says nothing about whether anyone
// can USE them, and the SDK is generated from the contracts, so a surface change that breaks an
// integration breaks this suite at COMPILE time instead of at 3am against a live cluster.

import { CatFactoryClient } from '@cat-factory/sdk'
import type { PublicDecisionList, PublicIdentity, PublicRun, PublicService } from '@cat-factory/sdk'
import type { AcceptanceConfig } from './config.ts'
import { waitFor } from './deadline.ts'

export type { PublicDecisionList, PublicRun, PublicService }

export function createClient(config: AcceptanceConfig): CatFactoryClient {
  return new CatFactoryClient({ baseUrl: config.baseUrl, apiKey: config.apiKey })
}

/**
 * Check the key before anything is created.
 *
 * Two failures this catches, both of which would otherwise appear much later wearing a
 * misleading face: a key bound to a DIFFERENT workspace than `ACCEPTANCE_WORKSPACE_ID` (every
 * public read then answers 404 for resources the app API is busy creating in the other one,
 * which reads as a broken deployment), and a key below `admin` (spec 01 creates services and
 * spec 03 answers a human gate, so a `write` key gets a third of the way and refuses).
 */
export function assertKeyUsable(identity: PublicIdentity, workspaceId: string): void {
  if (identity.workspaceId !== workspaceId) {
    throw new Error(
      `CAT_FACTORY_API_KEY is bound to workspace ${identity.workspaceId}, but ` +
        `ACCEPTANCE_WORKSPACE_ID is ${workspaceId}. The public API is workspace-scoped and the ` +
        `app-API setup calls are addressed by id, so the two must name the same board.`,
    )
  }
  // The ladder is INCLUSIVE, so this is the rung test the contract asks for, not an equality
  // check: `admin` is the top and is what spec 01 (create a service) and spec 03 (answer the
  // clarity gate, which needs `decide`) between them require.
  if (identity.scope !== 'admin') {
    throw new Error(
      `CAT_FACTORY_API_KEY is scoped '${identity.scope}'. This suite creates services (admin) ` +
        `and answers a parked human gate (decide), so it needs an 'admin' key.`,
    )
  }
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

/** Describe what a run is asking for, for the same audience as `describeRun`. */
export function describeDecisions(decisions: PublicDecisionList): string {
  const answerable = decisions.decisions.map((decision) => decision.kind).join(', ') || 'none'
  const blocked = decisions.unanswerable.map((wait) => wait.reason).join(', ') || 'none'
  return `answerable: [${answerable}], unanswerable: [${blocked}]`
}

export type RunWaitOptions = {
  client: CatFactoryClient
  taskId: string
  budgetMs: number
  /** What ends the wait. Defaults to "terminal", which treats a park as something to keep waiting on. */
  until?: (run: PublicRun) => boolean
  label?: string
}

/**
 * Poll a task's run until `until` holds.
 *
 * Polling rather than the SSE stream, deliberately. The stream is the better channel for a UI
 * and this suite is not one: an hour-long wait over one long-lived connection has to handle
 * reconnects and gap-filling to stay correct, and getting that wrong shows up as a flaky
 * acceptance test, the one failure mode nobody can afford here. A poll re-asks the point read,
 * which is authoritative by construction and carries every step's whole output (the stream
 * clips them; see `truncated` on the run-step contract).
 */
export function waitForRun(options: RunWaitOptions): Promise<PublicRun> {
  const { client, taskId, budgetMs, until = (run) => isTerminal(run.status) } = options
  return waitFor<PublicRun>({
    label: options.label ?? `task ${taskId} to settle`,
    budgetMs,
    probe: async () => {
      const run = await client.tasks.getRun(taskId)
      return until(run) ? { done: true, value: run } : { done: false, state: describeRun(run) }
    },
    onProgress: (state, elapsedMs) => {
      console.log(`  [${Math.round(elapsedMs / 1000)}s] ${state}`)
    },
  })
}

/** Wait until the run is parked on a decision this API can answer, or settles without asking. */
export function waitForDecisionOrSettled(options: {
  client: CatFactoryClient
  taskId: string
  runId: string
  budgetMs: number
}): Promise<{ run: PublicRun; decisions: PublicDecisionList }> {
  const { client, taskId, runId, budgetMs } = options
  return waitFor({
    label: `task ${taskId} to park on an answerable decision or settle`,
    budgetMs,
    probe: async () => {
      const run = await client.tasks.getRun(taskId)
      // Read decisions REGARDLESS of `parked`, as the contract instructs: a `follow-ups` entry
      // is answerable while the run is still working, so gating this read on `status === blocked`
      // would wait out a decision that was already there.
      const decisions = await client.decisions.list(runId)
      const ready = isTerminal(run.status) || decisions.decisions.length > 0
      return ready
        ? { done: true, value: { run, decisions } }
        : { done: false, state: `${describeRun(run)}; ${describeDecisions(decisions)}` }
    },
    onProgress: (state, elapsedMs) => {
      console.log(`  [${Math.round(elapsedMs / 1000)}s] ${state}`)
    },
  })
}

/** Find a service frame by exact title; null when the board has none. */
export async function findServiceByTitle(
  client: CatFactoryClient,
  title: string,
): Promise<PublicService | null> {
  const { services } = await client.services.list()
  return services.find((service) => service.title === title) ?? null
}
