import type { WorkflowStep } from 'cloudflare:workers'
import type { Env } from '../env'
import { applyLogSettings, flushIsolateLogs } from '../observability/logSettings'

// The log export's WORKFLOW half, and the reason it needs a half of its own.
//
// `fetch`/`scheduled`/`queue` each serve one invocation and then hand the drain to
// `ctx.waitUntil` after the response (`observability/logExport.ts`). A workflow wake is not
// shaped like that. It runs for as long as the run takes, and it gives its isolate BACK in the
// middle. A drain placed only at the end of `run()` would therefore export a poll loop's LAST
// wake and lose every wake before it, which for the durable drivers is essentially the whole run.
//
// Three things hand the isolate back, and all three are wrapped below:
//
//   - `step.sleep` / `step.sleepUntil`, the poll cadence.
//   - `step.waitForEvent`, a park that lasts as long as a human takes to answer.
//   - a `step.do` attempt that THREW. The engine then holds the instance for the step's retry
//     backoff (`STEP_CONFIG` is 5s exponential across three attempts), and an instance can be
//     evicted during it. What that attempt logged on its way to throwing is the diagnostic half
//     of the whole run, so it drains before the error goes back to the engine.
//
// So a wake is bracketed rather than trailed: settings applied on entry (the isolate may be
// brand new, since workerd instantiates a `WorkflowEntrypoint` in an isolate no other entry
// point has run in), a drain in front of each of those waits, and a drain in a `finally` so a
// wake that ends by THROWING still exports the lines explaining why.
//
// The drain is AWAITED rather than handed to `this.ctx.waitUntil`. A workflow's next act after
// each wait below is to give the isolate up, so "after this returns" is not a moment that
// reliably arrives.
//
// Cost, stated rather than assumed, and paid only by a deployment that opted in. An empty buffer
// sends nothing, so the polls and the steps that logged nothing (most of them) pay nothing. A
// non-empty one costs a POST, and up to the exporter's queued-batch cap of them back to back,
// each bounded by its per-POST timeout (both live in `@cat-factory/observability-otel`). So an
// UNREACHABLE collector does not just lose lines, it adds that bound in front of every wait of
// every wake. That is deliberate rather than overlooked: bounding the drain instead would
// abandon precisely the lines this file exists to deliver, and a deployment whose collector
// stopped answering is better off slow and observable than fast and blind.

/**
 * Run one workflow wake with this isolate's log export installed and drained around it.
 *
 * `drive` receives an INSTRUMENTED step: identical to the one workerd passed, except that every
 * durable wait exports what the wake has logged so far. Drivers must use that step and no other,
 * which is why this hands it over rather than leaving the original in scope.
 */
export async function withWorkflowLogExport<T>(
  env: Env,
  step: WorkflowStep,
  drive: (step: WorkflowStep) => Promise<T>,
): Promise<T> {
  applyLogSettings(env)
  const flush = (): Promise<void> => flushIsolateLogs(env)
  try {
    return await drive(flushingBeforeDurableWaits(step, flush))
  } finally {
    await flush()
  }
}

/**
 * The step workerd passed, with every member that can hand the isolate back wrapped to drain
 * first.
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
function flushingBeforeDurableWaits(step: WorkflowStep, flush: () => Promise<void>): WorkflowStep {
  const delegateDo = step.do.bind(step) as (name: string, ...rest: unknown[]) => Promise<unknown>
  return {
    // A SUCCEEDING `do` is not a wait: its callback ran in this isolate and whatever it logged is
    // drained by the next sleep/park or by the `finally` above, so instrumenting the happy path
    // would buy a POST per step for lines already accounted for. A FAILING one is a different
    // event: the engine answers a thrown attempt with the step's retry backoff, which is a
    // durable wait the instance can be evicted during, so the lines saying why it failed have to
    // leave before the error does.
    do: ((name: string, ...rest: unknown[]) => {
      // The callback is the second argument on the plain overload and the third when a
      // `WorkflowStepConfig` is given. Everything else (that config, `rollbackOptions`) is
      // forwarded untouched, so this substitutes exactly the one argument it instruments.
      const at = typeof rest[0] === 'function' ? 0 : 1
      const callback = rest[at] as (ctx: unknown) => Promise<unknown>
      rest[at] = async (ctx: unknown) => {
        try {
          return await callback(ctx)
        } catch (error) {
          await flush()
          throw error
        }
      }
      return delegateDo(name, ...rest)
    }) as unknown as WorkflowStep['do'],
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
