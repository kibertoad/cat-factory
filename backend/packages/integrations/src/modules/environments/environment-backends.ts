import type {
  EnvironmentBackendConfig,
  EnvironmentManifest,
  EnvironmentProvider,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
// The native Kubernetes environment backend lives in the kubernetes module (all K8s code
// colocated). Imported here purely to self-register, mirroring the manifest built-in.
import { kubernetesEnvironmentBackend } from '../kubernetes/kubernetes-environment-backend.js'
import { assertManifestUrlsSafe, referencedSecretKeys } from './environments.logic.js'
import { HttpEnvironmentProvider } from './HttpEnvironmentProvider.js'

// The ephemeral-environment backend provider-registry seam. A backend kind
// (`manifest` = generic BYO HTTP management API, `kubernetes` = native per-PR
// namespaces, plus any CUSTOM kind) registers an EnvironmentBackendProvider that maps its
// config → an EnvironmentProvider. The connection service resolves a workspace's stored
// `kind` to the registered backend. A CUSTOM third-party kind needs only a registry entry
// (an import side effect) — it rides the contract's generic manifest member, so NO new
// config variant and no new table/service/controller; its connect form is derived from the
// provider's `describeConfig`/`describeManifestTemplate` (or falls back to the raw manifest
// editor). Mirrors `runner-backends.ts` and the registerGate / model-provider / agent-kind
// seams: built-ins self-register on import; a third-party kind registers for side effect.
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
}

const REGISTRY = new Map<string, EnvironmentBackendProvider>()

/** Register an environment-backend provider (built-ins on import; third-party for side effect). */
export function registerEnvironmentBackend(provider: EnvironmentBackendProvider): void {
  REGISTRY.set(provider.kind, provider)
}

/** The provider for a backend kind, or undefined when unregistered. */
export function environmentBackend(kind: string): EnvironmentBackendProvider | undefined {
  return REGISTRY.get(kind)
}

/** All registered backend kinds (for diagnostics / a UI capabilities list). */
export function registeredEnvironmentBackendKinds(): string[] {
  return [...REGISTRY.keys()]
}

/**
 * Registered backend kinds + display labels, for the workspace snapshot → the SPA's
 * provider-connect backend-kind selector. Always includes the built-ins.
 */
export function environmentBackendKinds(): { kind: string; label: string }[] {
  return [...REGISTRY.values()].map((p) => ({ kind: p.kind, label: p.displayLabel ?? p.kind }))
}

/**
 * The first registered backend whose provider supports agent-based config repair
 * (`describeRepairAgent`) — used by a facade to wire the env-config-repair agent. Built-ins
 * don't support repair, so this is undefined on a stock deployment; a third-party backend
 * that implements it gets the repairer wired. Replaces the old per-deployment injected
 * provider the facade used to scan.
 */
export function findRepairCapableProvider(
  ctx: EnvironmentBackendContext,
): EnvironmentProvider | undefined {
  for (const kind of registeredEnvironmentBackendKinds()) {
    const provider = REGISTRY.get(kind)!.buildProvider(ctx)
    if (typeof provider.describeRepairAgent === 'function') return provider
  }
  return undefined
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
}

// --- Built-in: kubernetes (native per-PR namespaces over the apiserver) --------
// Defined in the kubernetes module (see the import above) so all K8s code is colocated;
// re-exported here so the package's public surface (index.ts) is unchanged.
export { kubernetesEnvironmentBackend }

registerEnvironmentBackend(manifestEnvironmentBackend)
registerEnvironmentBackend(kubernetesEnvironmentBackend)
