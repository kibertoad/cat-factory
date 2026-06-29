import { ValidationError } from '@cat-factory/kernel'
import { assertApiServerUrlSafe, KUBERNETES_TOKEN_KEY } from './kubernetes.logic.js'
import { KubernetesRunnerTransport } from './KubernetesRunnerTransport.js'
// Type-only import of the registry seam so there is no runtime cycle: runner-backends.ts
// imports this const (runtime) and registers it; this file only borrows the interface
// shapes (erased at compile time). All Kubernetes-specific code thus lives in this module.
import type { RunnerBackendProvider } from '../runners/runner-backends.js'

// Built-in: kubernetes runner backend (native per-run pods over the apiserver pod-proxy).
// Defined here, under the kubernetes module, so every Kubernetes symbol is colocated; the
// generic runner-backend registry (`runner-backends.ts`) imports it for side-effect
// registration, exactly as it does the `manifest` built-in.

export const kubernetesRunnerBackend: RunnerBackendProvider = {
  kind: 'kubernetes',
  displayLabel: 'Kubernetes',
  // Structural (`'kubernetes' in config`) narrowing, not `config.kind === 'kubernetes'`: the
  // open contract union now carries a generic `{ kind: string, manifest }` custom member whose
  // `kind` can equal `'kubernetes'`, so a kind-equality check no longer narrows it away. The
  // registry routes by slug, so this backend only ever sees its own config.
  referencedSecretKeys: (config) => ('kubernetes' in config ? [KUBERNETES_TOKEN_KEY] : []),
  connectionMeta: (config) => {
    if (!('kubernetes' in config)) throw new Error('Expected a kubernetes runner config')
    return {
      providerId: 'kubernetes',
      label: config.kubernetes.label,
      baseUrl: config.kubernetes.apiServerUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (!('kubernetes' in config)) return
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
    if (!('kubernetes' in config)) throw new Error('Expected a kubernetes runner config')
    return new KubernetesRunnerTransport(config.kubernetes, ctx.resolveSecret)
  },
  testConnection: (config, ctx) => {
    if (!('kubernetes' in config)) {
      return Promise.resolve({ ok: false, message: 'Expected a kubernetes runner config' })
    }
    return new KubernetesRunnerTransport(config.kubernetes, ctx.resolveSecret).testConnection()
  },
}
