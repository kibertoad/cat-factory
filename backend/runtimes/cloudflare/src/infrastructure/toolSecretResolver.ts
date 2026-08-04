import type { ToolSecretResolver } from '@cat-factory/kernel'
import type { Env } from './env'

// Installation-level extension point for the CAPABILITY-CREDENTIAL chain: how a registered tool
// server's (MCP) and a generative binary integration's declared credentials are resolved at
// dispatch, and what answers behind the platform's own per-workspace store.
//
// Registration is PROCESS-WIDE and read by every `buildContainer(env)` call, for the reason
// `ai/registries.ts` states about model providers: the Worker builds a container per entry point,
// and an option carried only on `createApp` reaches the fetch path alone. Container agents are
// dispatched by the durable driver (`ExecutionWorkflow` builds its own `buildContainer(this.env)`
// per wake), so a policy threaded through `createApp` would be accepted and then never asked
// anything, which is the exact "documented lever nobody can pull" defect this seam exists to
// remove. A deployment sets it once:
//
//   import { createWorker } from '@cat-factory/worker'
//   export default createWorker({ createToolSecretResolver: (env) => myVaultResolver(env) })
//
// `createWorker` registers the options here on the caller's behalf, so a deployment that uses the
// documented seam needs to know none of this. A deployment assembling its own app from `createApp`
// registers directly.
//
// ONE SLOT holding the whole policy, last write wins, where model registries are a LIST: a
// container has exactly one chain, and its two halves are not independent: a deployment's own
// resolver REPLACES the chain, which leaves no fallback of ours to keep or drop. Two registrations
// are a mistake worth overwriting loudly rather than silently merging into an order nobody chose.
//
// The resolver factory takes the request/binding `env` because a Worker has no ambient
// environment: a deployment's own store is reached through a BINDING (D1, a Secrets Store, a
// service binding), which only exists on `env`. That is why this holds the FACTORY rather than a
// built resolver.

/** Turns the runtime `env` into the {@link ToolSecretResolver} this installation dispatches with. */
export type ToolSecretResolverFactory = (env: Env) => ToolSecretResolver

/** How this installation resolves a registered capability's declared credentials. */
export interface ToolSecretPolicy {
  /**
   * This installation's own resolver. Present ⇒ it REPLACES the platform's chain (the
   * per-workspace store in front of the Worker's configured vars) rather than being wrapped by it.
   */
  createResolver?: ToolSecretResolverFactory
  /**
   * Whether the Worker's own configured vars answer a credential the workspace has NOT stored.
   * Defaults to true, which is what a single-tenant deployment wants: the operator sets the var
   * they already set for everything else.
   *
   * A MULTI-TENANT deployment sets it false. With the fallback on, a workspace that has typed
   * nothing silently authenticates its runs as whoever set the var and bills that vendor account,
   * which is the single-tenant answer the per-workspace store exists to replace.
   *
   * Ignored when {@link createResolver} is set. Whether a HOSTED deployment should default to
   * store-only is a product call, and this default deliberately does not make it.
   */
  environmentFallback?: boolean
}

let registered: ToolSecretPolicy = {}

/** Register this installation's capability-credential policy. */
export function registerToolSecretPolicy(policy: ToolSecretPolicy): void {
  registered = policy
}

/**
 * Build the registered resolver for a given `env`, or undefined when none is registered (the
 * container then composes the platform's own per-workspace store in front of the deployment
 * environment).
 */
export function resolveRegisteredToolSecretResolver(env: Env): ToolSecretResolver | undefined {
  return registered.createResolver?.(env)
}

/**
 * Whether the registered policy keeps the deployment-environment fallback behind the store.
 * Undefined ⇒ nothing was registered, so the composition applies its own default.
 */
export function registeredToolSecretEnvironmentFallback(): boolean | undefined {
  return registered.environmentFallback
}

/** Drop the registration. Intended for tests that exercise registration. */
export function clearToolSecretPolicy(): void {
  registered = {}
}
