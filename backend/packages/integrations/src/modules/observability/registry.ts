import { parseDatadogCredentials } from '@cat-factory/contracts'
import { DatadogObservabilityAdapter } from '../datadog/DatadogObservabilityAdapter.js'
import type { ObservabilityProviderRegistry } from './RegistryReleaseHealthProvider.js'

/**
 * The observability providers a facade can serve. Datadog is the only adapter today;
 * adding a vendor is a new entry here (+ its adapter + credential shape) — the gate, the
 * service, the routes and the persistence are all vendor-neutral around it.
 *
 * Each factory validates its decrypted credentials blob at this boundary (rather than
 * blind-casting), so a drifted/corrupted row fails with a clear error here instead of
 * deep inside the vendor client during a live probe.
 */
export const defaultObservabilityRegistry: ObservabilityProviderRegistry = {
  datadog: (credentials, opts) =>
    new DatadogObservabilityAdapter(parseDatadogCredentials(credentials), opts),
}
