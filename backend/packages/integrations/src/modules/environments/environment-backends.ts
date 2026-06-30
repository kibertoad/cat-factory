import type {
  EnvironmentBackendConfig,
  EnvironmentManifest,
  EnvironmentProvider,
  InfraEngine,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
// The native Kubernetes environment backend lives in the kubernetes module (all K8s code
// colocated). Imported here so `defaultEnvironmentBackendRegistry()` can register it
// alongside the manifest built-in.
import { kubernetesEnvironmentBackend } from '../kubernetes/kubernetes-environment-backend.js'
import { assertManifestUrlsSafe, referencedSecretKeys } from './environments.logic.js'
import { HttpEnvironmentProvider } from './HttpEnvironmentProvider.js'

// The ephemeral-environment backend provider-registry seam. A backend kind
// (`manifest` = generic BYO HTTP management API, `kubernetes` = native per-PR
// namespaces, plus any CUSTOM kind) registers an EnvironmentBackendProvider that maps its
// config → an EnvironmentProvider. The connection service resolves a workspace's stored
// `kind` to the registered backend. A CUSTOM third-party kind needs only a registry entry
// — it rides the contract's generic manifest member, so NO new config variant and no new
// table/service/controller; its connect form is derived from the provider's
// `describeConfig`/`describeManifestTemplate` (or falls back to the raw manifest editor).
//
// The registry is an INSTANCE owned by the composition root (`EnvironmentBackendRegistry`),
// NOT a module-global Map. The app builds it via `defaultEnvironmentBackendRegistry()` /
// `createBackendRegistries()` and injects it (through `CoreDependencies`) into the
// connection service; a deployment registers a custom backend by reference
// (`registry.register(provider)`), so the old "must share the same module instance to be
// seen" footgun is gone. See `docs/initiatives/registry-di-migration.md`.
//
// The stored connection always persists an EnvironmentManifest (the K8s config rides
// its `providerConfig`), so a backend supplies `toManifest`/`fromManifest` to translate
// between the discriminated connect config and that stored shape.

/** Per-call dependencies a backend may need to build its provider. */
export interface EnvironmentBackendContext {
  /** Env URL/host safety policy. Absent ⇒ strict. */
  urlPolicy?: UrlSafetyPolicy
}

/** Capabilities/policies a backend validates its config against at the write boundary. */
export interface EnvironmentBackendSafetyOptions {
  /** Env URL/host SSRF policy. Absent ⇒ strict. */
  urlPolicy?: UrlSafetyPolicy
  /**
   * Whether THIS runtime can honor a backend's custom TLS trust material (a private CA /
   * insecure-skip). The Cloudflare Worker cannot (no undici), so it sets this `false`
   * and the kubernetes backend rejects such a config up front. Absent/`true` ⇒ supported.
   */
  customTlsSupported?: boolean
}

export interface EnvironmentBackendProvider {
  // `string`, not the contract's discriminated `kind`, so a CUSTOM third-party kind can
  // register (the built-ins still use their literals). Pinned explicitly so a future
  // contract re-narrowing can't silently re-lock the registry to the built-in set.
  readonly kind: string
  /**
   * Human label for the connect-form backend selector + the snapshot (an unconnected kind
   * has no stored config to derive a label from). Defaults to `kind` when omitted.
   */
  readonly displayLabel?: string
  /** Every secret-bundle key the config references (validated present at registration). */
  referencedSecretKeys(config: EnvironmentBackendConfig): string[]
  /** Non-secret metadata persisted on the connection row + shown in the UI. */
  connectionMeta(config: EnvironmentBackendConfig): {
    providerId: string
    label: string
    baseUrl: string
  }
  /** Validate the config at the write boundary (SSRF / URL + runtime safety). Throws if unsafe. */
  assertConfigSafe(config: EnvironmentBackendConfig, opts?: EnvironmentBackendSafetyOptions): void
  /** Translate the discriminated connect config into the stored manifest. */
  toManifest(config: EnvironmentBackendConfig): EnvironmentManifest
  /** Reconstruct the discriminated config from a stored manifest (UI prefill). */
  fromManifest(manifest: EnvironmentManifest): EnvironmentBackendConfig
  /** Build the live provider the engine provisions/observes/tears down through. */
  buildProvider(ctx: EnvironmentBackendContext): EnvironmentProvider
  /**
   * The per-type infra engines this backend implements (e.g. the Kubernetes backend
   * serves both `local-k3s` and `remote-kubernetes`; a custom ephemeral-environment backend
   * typically serves `remote-custom`). Drives the per-provision-type handler resolution
   * (`byEngine`) AND the SPA's per-type backend selector (advertised via the snapshot's
   * `environmentBackendKinds[].engines`). REQUIRED: a backend that declares no engine is
   * unreachable as a run target — the type makes that impossible to define by accident.
   */
  engines(): InfraEngine[]
  /**
   * For a `remote-custom` backend: which custom manifest ids it can consume (matched
   * against a service's pinned `manifestId`). Empty/undefined ⇒ accepts any.
   */
  acceptsManifestIds?(): string[]
}

/**
 * The app-owned registry of environment-backend providers, keyed by `kind`. Constructed by
 * the composition root (via {@link defaultEnvironmentBackendRegistry} /
 * `createBackendRegistries`) and injected into the connection service. A deployment teaches
 * the platform a custom backend by holding the same instance and calling {@link register}
 * — registration is by reference, so it never depends on module identity.
 */
export class EnvironmentBackendRegistry {
  private readonly map = new Map<string, EnvironmentBackendProvider>()

  /** Register (or replace by `kind`) a backend provider. Returns `this` for chaining. */
  register(provider: EnvironmentBackendProvider): this {
    this.map.set(provider.kind, provider)
    return this
  }

  /** The provider for a backend kind, or undefined when unregistered. */
  get(kind: string): EnvironmentBackendProvider | undefined {
    return this.map.get(kind)
  }

  /**
   * The registered backend that implements a per-type infra engine
   * (`local-docker`/`local-k3s`/`remote-kubernetes`/`remote-custom`), or undefined when
   * none is registered for it (e.g. `local-docker` only on the local facade). Drives the
   * per-provision-type handler resolution. `none` (infraless) has no backend.
   */
  byEngine(engine: InfraEngine): EnvironmentBackendProvider | undefined {
    if (engine === 'none') return undefined
    for (const provider of this.map.values()) {
      if (provider.engines().includes(engine)) return provider
    }
    return undefined
  }

  /** All registered backend kinds (for diagnostics / a UI capabilities list). */
  kinds(): string[] {
    return [...this.map.keys()]
  }

  /**
   * Registered backend kinds + display labels, for the workspace snapshot → the SPA's
   * provider-connect backend-kind selector. Always includes the built-ins.
   */
  labelled(): { kind: string; label: string; engines: InfraEngine[] }[] {
    return [...this.map.values()].map((p) => ({
      kind: p.kind,
      label: p.displayLabel ?? p.kind,
      engines: p.engines(),
    }))
  }

  /**
   * The first registered backend whose provider supports agent-based config repair
   * (`describeRepairAgent`) — used by a facade to wire the env-config-repair agent. Built-ins
   * don't support repair, so this is undefined on a stock deployment; a third-party backend
   * that implements it gets the repairer wired.
   */
  findRepairCapable(ctx: EnvironmentBackendContext): EnvironmentProvider | undefined {
    for (const provider of this.map.values()) {
      const built = provider.buildProvider(ctx)
      if (typeof built.describeRepairAgent === 'function') return built
    }
    return undefined
  }
}

/** A registry pre-loaded with the built-in `manifest` + `kubernetes` backends. */
export function defaultEnvironmentBackendRegistry(): EnvironmentBackendRegistry {
  return new EnvironmentBackendRegistry()
    .register(manifestEnvironmentBackend)
    .register(kubernetesEnvironmentBackend)
}

// --- Built-in: manifest (the generic BYO HTTP management API) -----------------

export const manifestEnvironmentBackend: EnvironmentBackendProvider = {
  kind: 'manifest',
  displayLabel: 'HTTP manifest',
  referencedSecretKeys: (config) =>
    config.kind === 'manifest' ? referencedSecretKeys(config.manifest) : [],
  connectionMeta: (config) => {
    if (config.kind !== 'manifest') throw new Error('Expected a manifest environment config')
    return {
      providerId: config.manifest.providerId,
      label: config.manifest.label,
      baseUrl: config.manifest.baseUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (config.kind === 'manifest') {
      assertManifestUrlsSafe(config.manifest, opts?.urlPolicy ?? STRICT_URL_SAFETY_POLICY)
    }
  },
  toManifest: (config) => {
    if (config.kind !== 'manifest') throw new Error('Expected a manifest environment config')
    return config.manifest
  },
  fromManifest: (manifest) => ({ kind: 'manifest', manifest }),
  buildProvider: (ctx) =>
    new HttpEnvironmentProvider(ctx.urlPolicy ? { urlPolicy: ctx.urlPolicy } : {}),
  // The generic BYO HTTP management API is the `remote-custom` engine. A deployment that
  // registers a narrower custom backend can override `acceptsManifestIds` to constrain it.
  engines: () => ['remote-custom'],
}

// --- Built-in: kubernetes (native per-PR namespaces over the apiserver) --------
// Defined in the kubernetes module (see the import above) so all K8s code is colocated;
// re-exported here so the package's public surface (index.ts) is unchanged. The built-ins
// are registered into the default registry by `defaultEnvironmentBackendRegistry()` above
// (no module-load side effect).
export { kubernetesEnvironmentBackend }
