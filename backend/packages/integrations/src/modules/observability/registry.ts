import { DatadogObservabilityAdapter } from '../datadog/DatadogObservabilityAdapter.js'
import type { DatadogCredentialsShape } from '../datadog/DatadogObservabilityAdapter.js'
import type { ObservabilityProviderRegistry } from './RegistryReleaseHealthProvider.js'

/**
 * The observability providers a facade can serve. Datadog is the only adapter today;
 * adding a vendor is a new entry here (+ its adapter + credential shape) — the gate, the
 * service, the routes and the persistence are all vendor-neutral around it.
 */
export const defaultObservabilityRegistry: ObservabilityProviderRegistry = {
  datadog: (credentials, opts) =>
    new DatadogObservabilityAdapter(credentials as DatadogCredentialsShape, opts),
}
