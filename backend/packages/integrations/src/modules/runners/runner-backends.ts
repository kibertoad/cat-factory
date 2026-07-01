import type {
  ConnectionTestResult,
  ProviderConfigField,
  RunnerBackendConfig,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY } from '@cat-factory/kernel'
// The native Kubernetes runner backend lives in the kubernetes module (all K8s code
// colocated). Imported here so `defaultRunnerBackendRegistry()` can register it alongside
// the manifest built-in.
import { kubernetesRunnerBackend } from '../kubernetes/kubernetes-runner-backend.js'
import { HttpRunnerPoolProvider } from './HttpRunnerPoolProvider.js'
import { RunnerPoolTransport } from './RunnerPoolTransport.js'
import {
  assertManifestUrlsSafe,
  referencedSecretKeys as manifestSecretKeys,
} from './runners.logic.js'

// The universal "agent runner backend" provider-registry seam. A backend kind
// (`manifest` = BYO HTTP scheduler pool, `kubernetes` = native per-run pods, plus any
// CUSTOM kind) registers a RunnerBackendProvider that maps its config → a RunnerTransport.
// The connection service resolves a workspace's stored `kind` to the registered provider and
// builds the transport. A CUSTOM third-party kind needs only a registry entry — it rides the
// contract's generic manifest member, so NO new config variant and no new
// table/service/controller/UI window.
//
// The registry is an INSTANCE owned by the composition root (`RunnerBackendRegistry`), NOT a
// module-global Map. The app builds it via `defaultRunnerBackendRegistry()` /
// `createBackendRegistries()` and injects it (through `CoreDependencies`) into the connection
// service; a deployment registers a custom backend by reference (`registry.register(provider)`),
// so the old "must share the same module instance to be seen" footgun is gone. Mirrors
// `environment-backends.ts`. See `docs/initiatives/registry-di-migration.md`.
//
// NB: the `ctx.runnerPoolProvider` below is a DIFFERENT seam — a deployment-wide HTTP-pool
// provider the `manifest` backend reuses (its OAuth cache), NOT the custom-kind mechanism. A
// bespoke backend is a registered kind, not an injected `runnerPoolProvider`.

/** Per-call dependencies a provider may need to build/test its transport. */
export interface RunnerBackendContext {
  resolveSecret: SecretResolver
  /** Manifest SSRF policy (the Kubernetes backend does its own apiserver-URL check). */
  urlPolicy?: UrlSafetyPolicy
  /**
   * A shared manifest HTTP provider (its OAuth cache reused), injectable for tests
   * and for native pool adapters. Used by the `manifest` backend only.
   */
  runnerPoolProvider?: RunnerPoolProvider
}

/** Capabilities/policies a backend validates its config against at the write boundary. */
export interface RunnerBackendSafetyOptions {
  /** Manifest SSRF policy. Absent ⇒ strict. */
  urlPolicy?: UrlSafetyPolicy
  /**
   * Whether THIS deployment runtime can honor a backend's custom TLS trust material
   * (a private CA / insecure-skip). The Cloudflare Worker cannot (no undici / no
   * custom-CA fetch), so it sets this `false` and the kubernetes backend rejects such
   * a config up front instead of letting it save and then die at first dispatch.
   * Absent/`true` ⇒ supported (Node/local).
   */
  customTlsSupported?: boolean
}

/**
 * The typed-connect-form seam for a NATIVE runner backend (Kubernetes / EKS): the backend
 * describes its flat form fields so the SPA renders a generic, provider-agnostic form instead
 * of a hardcoded per-kind Vue component (the whole point — the UI stays unaware of which
 * optional backends exist). A backend that rides the generic HTTP manifest (the `manifest`
 * built-in + custom kinds) omits this and uses the manifest form/editor instead.
 *
 * The three pieces are exact inverses so the round-trip is lossless:
 *  - `fields()` — the flat {@link ProviderConfigField}s (params + secrets) the SPA renders.
 *  - `skeleton()` — the empty `{ kind, <payload>: {} }` the SPA overlays field values onto for
 *    a FIRST connect (each non-secret field → the single non-`kind` payload key; each secret →
 *    the write-only bundle). On an EDIT the SPA overlays onto the STORED config instead, so
 *    advanced API-only fields the flat form never renders survive the re-save.
 *  - `valuesFromConfig()` — invert a stored config back to the flat values (keyed by
 *    `fields()[].key`) for prefill.
 */
export interface RunnerBackendForm {
  fields(): ProviderConfigField[]
  skeleton(): RunnerBackendConfig
  valuesFromConfig(config: RunnerBackendConfig): Record<string, string>
}

export interface RunnerBackendProvider {
  // `string`, not the contract's discriminated `kind`, so a CUSTOM third-party kind can
  // register. Pinned explicitly so a future contract re-narrowing can't re-lock the registry.
  readonly kind: string
  /**
   * Human label for the connect-form backend selector + the snapshot (an unconnected kind
   * has no stored config to derive a label from). Defaults to `kind` when omitted.
   */
  readonly displayLabel?: string
  /**
   * A native backend's typed flat-form descriptor (see {@link RunnerBackendForm}). Present ⇒
   * the SPA renders the generic descriptor-driven form; absent ⇒ the manifest form/editor.
   */
  readonly form?: RunnerBackendForm
  /** Every secret-bundle key the config references (validated present at registration). */
  referencedSecretKeys(config: RunnerBackendConfig): string[]
  /** Non-secret metadata persisted on the connection row + shown in the UI. */
  connectionMeta(config: RunnerBackendConfig): {
    providerId: string
    label: string
    baseUrl: string
  }
  /** Validate the config at the write boundary (SSRF / URL + runtime safety). Throws if unsafe. */
  assertConfigSafe(config: RunnerBackendConfig, opts?: RunnerBackendSafetyOptions): void
  /** Build the live transport the execution engine dispatches/polls/releases through. */
  buildTransport(config: RunnerBackendConfig, ctx: RunnerBackendContext): RunnerTransport
  /** Probe the backend without persisting anything. */
  testConnection(
    config: RunnerBackendConfig,
    ctx: RunnerBackendContext,
  ): Promise<ConnectionTestResult>
}

/**
 * The app-owned registry of runner-backend providers, keyed by `kind`. Constructed by the
 * composition root (via {@link defaultRunnerBackendRegistry} / `createBackendRegistries`)
 * and injected into the connection service. A deployment teaches the platform a custom
 * backend by holding the same instance and calling {@link register} — registration is by
 * reference, so it never depends on module identity.
 */
export class RunnerBackendRegistry {
  private readonly map = new Map<string, RunnerBackendProvider>()

  /** Register (or replace by `kind`) a backend provider. Returns `this` for chaining. */
  register(provider: RunnerBackendProvider): this {
    this.map.set(provider.kind, provider)
    return this
  }

  /** The provider for a backend kind, or undefined when unregistered. */
  get(kind: string): RunnerBackendProvider | undefined {
    return this.map.get(kind)
  }

  /** All registered backend kinds (for diagnostics / a UI capabilities list). */
  kinds(): string[] {
    return [...this.map.keys()]
  }

  /**
   * Registered backend kinds + display labels, for the workspace snapshot → the SPA's
   * provider-connect backend-kind selector. Always includes the built-ins.
   */
  labelled(): { kind: string; label: string }[] {
    return [...this.map.values()].map((p) => ({ kind: p.kind, label: p.displayLabel ?? p.kind }))
  }
}

/** A registry pre-loaded with the built-in `manifest` + `kubernetes` backends. */
export function defaultRunnerBackendRegistry(): RunnerBackendRegistry {
  return new RunnerBackendRegistry()
    .register(manifestRunnerBackend)
    .register(kubernetesRunnerBackend)
}

// --- Built-in: manifest (the original BYO HTTP scheduler pool) ----------------

let sharedHttpProvider: HttpRunnerPoolProvider | undefined
function defaultHttpProvider(urlPolicy?: UrlSafetyPolicy): HttpRunnerPoolProvider {
  return (sharedHttpProvider ??= new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}))
}

export const manifestRunnerBackend: RunnerBackendProvider = {
  kind: 'manifest',
  displayLabel: 'HTTP manifest pool',
  referencedSecretKeys: (config) =>
    config.kind === 'manifest' ? manifestSecretKeys(config.manifest) : [],
  connectionMeta: (config) => {
    if (config.kind !== 'manifest') throw new Error('Expected a manifest runner config')
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
  buildTransport: (config, ctx) => {
    if (config.kind !== 'manifest') throw new Error('Expected a manifest runner config')
    const provider = ctx.runnerPoolProvider ?? defaultHttpProvider(ctx.urlPolicy)
    return new RunnerPoolTransport(provider, config.manifest, ctx.resolveSecret)
  },
  testConnection: (config, ctx) => {
    if (config.kind !== 'manifest') {
      return Promise.resolve({ ok: false, message: 'Expected a manifest runner config' })
    }
    const provider = ctx.runnerPoolProvider ?? defaultHttpProvider(ctx.urlPolicy)
    return (
      provider.testConnection?.({
        manifest: config.manifest,
        config: {},
        resolveSecret: ctx.resolveSecret,
      }) ?? Promise.resolve({ ok: true, message: 'This pool provider has no connection test.' })
    )
  },
}

// --- Built-in: kubernetes (native per-run pods over the apiserver pod-proxy) ---
// Defined in the kubernetes module (see the import above) so all K8s code is colocated;
// re-exported here so the package's public surface (index.ts) is unchanged. The built-ins
// are registered into the default registry by `defaultRunnerBackendRegistry()` above (no
// module-load side effect).
export { kubernetesRunnerBackend }
