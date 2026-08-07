import type { WorkflowStep } from 'cloudflare:workers'
import type { Env } from '../env'
import { applyLogSettings, flushIsolateLogs } from '../observability/logSettings'

// The log export's WORKFLOW half, and the reason it needs a half of its own.
//
// `fetch`/`scheduled`/`queue` each serve one invocation and then hand the drain to
// `ctx.waitUntil` after the response (`observability/logExport.ts`). A workflow wake is not
// shaped like that. It runs for as long as the run takes, and it gives its isolate BACK in the
// middle: `step.sleep` and `step.waitForEvent` are hibernation points, and the isolate that
// resumes afterwards is a different one that never saw the buffer. A drain placed only at the
// end of `run()` would therefore export a poll loop's LAST wake and lose every wake before it,
// which for the durable drivers is essentially the whole run.
//
// So a wake is bracketed rather than trailed: settings applied on entry (the isolate may be
// brand new, since workerd instantiates a `WorkflowEntrypoint` in an isolate no other entry
// point has run in), a drain before each durable suspension, and a drain in a `finally` so a
// wake that ends by THROWING still exports the lines explaining why.
//
// The drain is AWAITED rather than handed to `this.ctx.waitUntil`. A workflow's next act after
// the suspension points below is to give the isolate up, so "after this returns" is not a
// moment that reliably arrives; awaiting costs one collector round-trip in front of a sleep
// measured in seconds-to-days, and only for a deployment that opted in. An empty buffer sends
// nothing, so the polls that logged nothing (most of them) pay nothing either.

/**
 * Run one workflow wake with this isolate's log export installed and drained around it.
 *
 * `drive` receives an INSTRUMENTED step: identical to the one workerd passed, except that every
 * durable suspension exports what the wake has logged so far. Drivers must use that step and no
 * other, which is why this hands it over rather than leaving the original in scope.
 */
export async function withWorkflowLogExport<T>(
  env: Env,
  step: WorkflowStep,
  drive: (step: WorkflowStep) => Promise<T>,
): Promise<T> {
  applyLogSettings(env)
  const flush = (): Promise<void> => flushIsolateLogs(env)
  try {
    return await drive(flushingBeforeSuspension(step, flush))
  } finally {
    await flush()
  }
}

/**
 * The step workerd passed, with its three suspending members wrapped to drain first.
 *
 * Built by DELEGATION rather than by inheriting from the real step (`Object.create`): a wrapper
 * on the prototype chain would receive `this` on the un-wrapped members too, so any state the
 * host object writes through `this` would land on the wrapper and be lost with it. Bound
 * delegates keep every call running against the object workerd actually gave us.
 *
 * `sleepUntil` is wrapped though nothing calls it today: an object literal typed as
 * `WorkflowStep` cannot omit it, which is the point. A driver that reaches for it later gets the
 * drain without having to know this file exists.
 */
function flushingBeforeSuspension(step: WorkflowStep, flush: () => Promise<void>): WorkflowStep {
  return {
    // `do` is NOT a suspension: its callback runs in this isolate, and whatever it logged is
    // drained by the next sleep/park or by the `finally` above. Wrapping it would buy a POST
    // per step for lines that are already covered.
    do: step.do.bind(step) as WorkflowStep['do'],
    sleep: async (name, duration) => {
      await flush()
      await step.sleep(name, duration)
    },
    sleepUntil: async (name, timestamp) => {
      await flush()
      await step.sleepUntil(name, timestamp)
    },
    // Cast because `waitForEvent` is generic in its event payload and this wrapper is not: it
    // forwards the payload untouched, so there is nothing for the delegate to be generic OVER,
    // and re-declaring the type parameter here would only restate a constraint the real
    // signature already enforces at every call site.
    waitForEvent: (async (name: string, options: { type: string; timeout?: unknown }) => {
      await flush()
      return (step.waitForEvent as (n: string, o: unknown) => Promise<unknown>)(name, options)
    }) as unknown as WorkflowStep['waitForEvent'],
  }
}
