import type { SubscriptionQuotaRegistry } from './RegistrySubscriptionQuotaProvider.js'

/**
 * The vendors a facade can read REAL subscription quota numbers for. Empty today: the
 * real Claude (`/api/oauth/usage`) + GLM (`/api/monitor/usage/quota/limit`) reads land in
 * Part B2 (an executor-harness image bump returns a quota snapshot on `RunnerJobResult`),
 * so every vendor currently degrades to the modeled window. A facade composes its own
 * registry from this base; a B2 adapter is a new entry here. (Still a plain record — unlike
 * the class-shaped `ObservabilityProviderRegistry` — because it holds no built-ins to
 * pre-load yet; it graduates to the same shape when B2 lands its first adapter.)
 */
export const defaultSubscriptionQuotaRegistry: SubscriptionQuotaRegistry = {}
