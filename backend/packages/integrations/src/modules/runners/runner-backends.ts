import type {
  ConnectionTestResult,
  RunnerBackendConfig,
  RunnerPoolProvider,
  RunnerTransport,
  SecretResolver,
  UrlSafetyPolicy,
} from '@cat-factory/kernel'
import { STRICT_URL_SAFETY_POLICY, ValidationError } from '@cat-factory/kernel'
import { assertApiServerUrlSafe, KUBERNETES_TOKEN_KEY } from '../kubernetes/kubernetes.logic.js'
import { KubernetesRunnerTransport } from '../kubernetes/KubernetesRunnerTransport.js'
import { HttpRunnerPoolProvider } from './HttpRunnerPoolProvider.js'
import { RunnerPoolTransport } from './RunnerPoolTransport.js'
import {
  assertManifestUrlsSafe,
  referencedSecretKeys as manifestSecretKeys,
} from './runners.logic.js'

// The universal "agent runner backend" provider-registry seam. A backend kind
// (`manifest` = BYO HTTP scheduler pool, `kubernetes` = native per-run pods, future
// `nomad`/`eks`/…) registers a RunnerBackendProvider that maps its discriminated
// config → a RunnerTransport. The connection service resolves a workspace's stored
// `kind` to the registered provider and builds the transport — so adding a backend
// is ONE registry entry + a config variant + a UI form, with no new table, service,
// controller, or integration window. Mirrors the registerGate / model-provider
// seams: built-ins self-register on import; a third-party kind registers by
// importing for side effect.

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

export interface RunnerBackendProvider {
  readonly kind: RunnerBackendConfig['kind']
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

const REGISTRY = new Map<string, RunnerBackendProvider>()

/** Register a runner-backend provider (built-ins on import; third-party for side effect). */
export function registerRunnerBackend(provider: RunnerBackendProvider): void {
  REGISTRY.set(provider.kind, provider)
}

/** The provider for a backend kind, or undefined when unregistered. */
export function runnerBackend(kind: string): RunnerBackendProvider | undefined {
  return REGISTRY.get(kind)
}

/** All registered backend kinds (for diagnostics / a UI capabilities list). */
export function registeredRunnerBackendKinds(): string[] {
  return [...REGISTRY.keys()]
}

// --- Built-in: manifest (the original BYO HTTP scheduler pool) ----------------

let sharedHttpProvider: HttpRunnerPoolProvider | undefined
function defaultHttpProvider(urlPolicy?: UrlSafetyPolicy): HttpRunnerPoolProvider {
  return (sharedHttpProvider ??= new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}))
}

export const manifestRunnerBackend: RunnerBackendProvider = {
  kind: 'manifest',
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

export const kubernetesRunnerBackend: RunnerBackendProvider = {
  kind: 'kubernetes',
  referencedSecretKeys: (config) => (config.kind === 'kubernetes' ? [KUBERNETES_TOKEN_KEY] : []),
  connectionMeta: (config) => {
    if (config.kind !== 'kubernetes') throw new Error('Expected a kubernetes runner config')
    return {
      providerId: 'kubernetes',
      label: config.kubernetes.label,
      baseUrl: config.kubernetes.apiServerUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (config.kind !== 'kubernetes') return
    assertApiServerUrlSafe(config.kubernetes.apiServerUrl)
    // Custom TLS trust material is honored only on a runtime with undici (Node/local).
    // Reject it up front on a runtime that can't (the Cloudflare Worker) so the
    // connection can't save and then fail at every dispatch.
    const needsCustomTls =
      !!config.kubernetes.caCertPem || !!config.kubernetes.insecureSkipTlsVerify
    if (needsCustomTls && opts?.customTlsSupported === false) {
      // Caller-input error → ValidationError (422 with the reason), not a plain Error (500).
      throw new ValidationError(
        'This runtime cannot verify a custom CA / skip TLS for the Kubernetes apiserver ' +
          '(it requires the Node runtime). Use a publicly-trusted apiserver certificate, or ' +
          'run this workspace on the Node/local deployment.',
      )
    }
  },
  buildTransport: (config, ctx) => {
    if (config.kind !== 'kubernetes') throw new Error('Expected a kubernetes runner config')
    return new KubernetesRunnerTransport(config.kubernetes, ctx.resolveSecret)
  },
  testConnection: (config, ctx) => {
    if (config.kind !== 'kubernetes') {
      return Promise.resolve({ ok: false, message: 'Expected a kubernetes runner config' })
    }
    return new KubernetesRunnerTransport(config.kubernetes, ctx.resolveSecret).testConnection()
  },
}

registerRunnerBackend(manifestRunnerBackend)
registerRunnerBackend(kubernetesRunnerBackend)
