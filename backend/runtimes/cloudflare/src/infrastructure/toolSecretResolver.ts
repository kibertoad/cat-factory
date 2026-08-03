import type { ToolSecretResolver } from '@cat-factory/kernel'
import type { Env } from './env'

// Installation-level extension point for the CAPABILITY-CREDENTIAL resolver: the port that
// supplies a registered tool server's (MCP) and a generative binary integration's declared
// credentials at dispatch.
//
// Registration is PROCESS-WIDE and read by every `buildContainer(env)` call, for the reason
// `ai/registries.ts` states about model providers: the Worker builds a container per entry point,
// and an option carried only on `createApp` reaches the fetch path alone. Container agents are
// dispatched by the durable driver (`ExecutionWorkflow` builds its own `buildContainer(this.env)`
// per wake), so a resolver threaded through `createApp` would be accepted and then never asked
// anything, which is the exact "documented lever nobody can pull" defect this seam exists to
// remove. A deployment sets it once:
//
//   import { createWorker } from '@cat-factory/worker'
//   export default createWorker({ createToolSecretResolver: (env) => myVaultResolver(env) })
//
// `createWorker` registers the option here on the caller's behalf, so a deployment that uses the
// documented seam needs to know none of this. A deployment assembling its own app from `createApp`
// registers directly.
//
// ONE SLOT, last write wins, where model registries are a LIST: a container has exactly one
// `resolveToolSecrets`, and a deployment's own resolver REPLACES the platform's chain rather than
// composing with it (see `container-executor-deps.ts`). Two registrations are a mistake worth
// overwriting loudly rather than silently merging into an order nobody chose.
//
// The factory takes the request/binding `env` because a Worker has no ambient environment: a
// deployment's own store is reached through a BINDING (D1, a Secrets Store, a service binding),
// which only exists on `env`. That is also why this holds the FACTORY rather than a built
// resolver.

/** Turns the runtime `env` into the {@link ToolSecretResolver} this installation dispatches with. */
export type ToolSecretResolverFactory = (env: Env) => ToolSecretResolver

let registered: ToolSecretResolverFactory | undefined

/** Register this installation's capability-credential resolver factory. */
export function registerToolSecretResolverFactory(factory: ToolSecretResolverFactory): void {
  registered = factory
}

/**
 * Build the registered resolver for a given `env`, or undefined when none is registered (the
 * container then composes the platform's own per-workspace store in front of the deployment
 * environment).
 */
export function resolveRegisteredToolSecretResolver(env: Env): ToolSecretResolver | undefined {
  return registered?.(env)
}

/** Drop the registration. Intended for tests that exercise registration. */
export function clearToolSecretResolverFactory(): void {
  registered = undefined
}
