import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionContext } from '@cloudflare/workers-types'

// The ambient ExecutionContext of the invocation currently being served, carried on an
// AsyncLocalStorage (available under the `nodejs_compat` flag wrangler.toml already sets).
//
// Why an ambient rather than a threaded parameter: the module-scope cache bag
// (`appCachesHost.ts`) outlives every request, but the background work its loaders start
// (preemptive refreshes, staleness probes) performs I/O, and on Workers I/O is scoped to
// the request that created it, and a promise left detached past its request faults with
// "Cannot perform I/O on behalf of a different request". The adopter therefore has to
// resolve the CURRENT invocation's `ctx` at spawn time; a `ctx` captured at construction
// would belong to whichever invocation happened to build the bag, and a module-scope
// pending-work registry drained by middleware can adopt request B's promise onto request
// A's `waitUntil` when two run concurrently in one isolate. ALS attributes each spawn to
// the invocation that caused it, by construction.

const executionContextStorage = new AsyncLocalStorage<ExecutionContext>()

/**
 * Run one invocation's work with its ExecutionContext ambient. Every Worker entry point
 * (fetch, scheduled, queue) wraps its handling in this; Workflows steps do not (they have
 * no ExecutionContext), which is why readers must tolerate an absent store.
 */
export function runWithExecutionContext<T>(ctx: ExecutionContext, fn: () => T): T {
  return executionContextStorage.run(ctx, fn)
}

/** The current invocation's ExecutionContext, or undefined outside any wrapped entry point. */
export function currentExecutionContext(): ExecutionContext | undefined {
  return executionContextStorage.getStore()
}

/**
 * The current invocation's IDENTITY, for `@cat-factory/caching`'s per-invocation load scoping.
 *
 * It is the same `ExecutionContext` object, read for a different reason: the caching layer
 * never calls it, it only compares it, so that a cache miss can tell "a load already running
 * for THIS invocation" (safe to await) from one running for a concurrent invocation in the
 * same isolate (uncatchably fatal to await). A distinct name because the two uses have
 * different failure modes and a future invocation token that is not the `ctx` would keep this
 * one honest.
 */
export function currentInvocation(): object | undefined {
  return executionContextStorage.getStore()
}
