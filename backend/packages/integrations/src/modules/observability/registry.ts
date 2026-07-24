import { parseDatadogCredentials } from '@cat-factory/contracts'
import type { ObservabilityProviderKind } from '@cat-factory/kernel'
import { DatadogObservabilityAdapter } from '../datadog/DatadogObservabilityAdapter.js'
import type { ObservabilityAdapterFactory } from './RegistryReleaseHealthProvider.js'

/**
 * The app-owned registry of observability-provider adapter factories, keyed by vendor
 * `kind`. Constructed by the composition root (via {@link defaultObservabilityRegistry})
 * and injected into `RegistryReleaseHealthProvider`; a deployment teaches the platform a new
 * vendor by holding the same instance and calling {@link register} — registration is by
 * reference, so it never depends on module identity. Mirrors the other app-owned registries
 * (`RunnerBackendRegistry`, `EnvironmentBackendRegistry`, …). See
 * `backend/docs/adr/0028-registry-di.md`.
 */
export class ObservabilityProviderRegistry {
  private readonly map = new Map<ObservabilityProviderKind, ObservabilityAdapterFactory>()

  /** Register (or replace by `kind`) an adapter factory. Returns `this` for chaining. */
  register(kind: ObservabilityProviderKind, factory: ObservabilityAdapterFactory): this {
    this.map.set(kind, factory)
    return this
  }

  /** The adapter factory for a vendor kind, or undefined when unregistered. */
  get(kind: ObservabilityProviderKind): ObservabilityAdapterFactory | undefined {
    return this.map.get(kind)
  }

  /** All registered vendor kinds (for diagnostics / a UI capabilities list). */
  kinds(): ObservabilityProviderKind[] {
    return [...this.map.keys()]
  }
}

/**
 * A registry pre-loaded with the built-in observability providers. Datadog is the only
 * adapter today; adding a vendor is a new `.register(...)` here (+ its adapter + credential
 * shape) — the gate, the service, the routes and the persistence are all vendor-neutral
 * around it.
 *
 * Each factory validates its decrypted credentials blob at this boundary (rather than
 * blind-casting), so a drifted/corrupted row fails with a clear error here instead of
 * deep inside the vendor client during a live probe.
 */
export function defaultObservabilityRegistry(): ObservabilityProviderRegistry {
  return new ObservabilityProviderRegistry().register(
    'datadog',
    (credentials, opts) =>
      new DatadogObservabilityAdapter(parseDatadogCredentials(credentials), opts),
  )
}
