import type { ProviderRegistry } from '@cat-factory/agents'
import type { Env } from '../env'

// Installation-level model-provider extension point. The Worker library ships the
// base registry (OpenAI, Anthropic, the OpenAI-compatible vendors, Workers AI) but
// stays free of optional/heavier provider SDKs. A deployment "mixes in" extra
// providers — e.g. AWS Bedrock via `@cat-factory/provider-bedrock` — by registering a
// factory at startup:
//
//   import { registerModelRegistry } from '@cat-factory/worker'
//   import { bedrockRegistry } from '@cat-factory/provider-bedrock'
//   registerModelRegistry((env) => bedrockRegistry({ region: env.BEDROCK_REGION }))
//
// Registration is process-wide and read by every `buildContainer(env)` call, so the
// extra providers reach all paths — HTTP requests, the durable Workflow driver, and
// the cron sweeper — not just one entry point. The factory receives the request/binding
// `env` so it can pull credentials/region from the deployment's configuration.

/** Turns the runtime `env` into a {@link ProviderRegistry} to mix in. */
export type ModelRegistryFactory = (env: Env) => ProviderRegistry

const factories: ModelRegistryFactory[] = []

/** Register an extra model-provider registry for this installation. */
export function registerModelRegistry(factory: ModelRegistryFactory): void {
  factories.push(factory)
}

/** Build the registered extra registries for a given `env` (empty when none registered). */
export function resolveExtraRegistries(env: Env): ProviderRegistry[] {
  return factories.map((factory) => factory(env))
}

/** Drop all registered registries. Intended for tests that exercise registration. */
export function clearModelRegistries(): void {
  factories.length = 0
}
