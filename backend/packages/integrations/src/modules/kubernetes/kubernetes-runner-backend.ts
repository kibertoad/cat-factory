import type { ProviderConfigField, RunnerBackendConfig } from '@cat-factory/kernel'
import {
  assertApiServerUrlSafe,
  assertCustomTlsSupported,
  flattenConfigValues,
  KUBERNETES_RUNNER_FORM_FIELDS,
  KUBERNETES_TOKEN_KEY,
} from './kubernetes.logic.js'
import { KubernetesRunnerTransport } from './KubernetesRunnerTransport.js'
// Type-only import of the registry seam so there is no runtime cycle: runner-backends.ts
// imports this const (runtime) and registers it; this file only borrows the interface
// shapes (erased at compile time). All Kubernetes-specific code thus lives in this module.
import type { RunnerBackendProvider } from '../runners/runner-backends.js'

// Built-in: kubernetes runner backend (native per-run pods over the apiserver pod-proxy).
// Defined here, under the kubernetes module, so every Kubernetes symbol is colocated; the
// generic runner-backend registry (`runner-backends.ts`) imports it for side-effect
// registration, exactly as it does the `manifest` built-in.

/** ServiceAccount-token secret field, appended after the shared apiserver fields. */
const KUBERNETES_TOKEN_FIELD: ProviderConfigField = {
  key: KUBERNETES_TOKEN_KEY,
  label: 'ServiceAccount token',
  secret: true,
  required: true,
  help: 'A long-lived (or projected) token for the ServiceAccount the backend calls the apiserver as.',
}

export const kubernetesRunnerBackend: RunnerBackendProvider = {
  kind: 'kubernetes',
  displayLabel: 'Kubernetes',
  // The typed flat connect form the SPA renders generically (so the UI needs no per-kind
  // component). The shared apiserver fields + the ServiceAccount token; the config skeleton
  // the SPA overlays onto is `{ kind: 'kubernetes', kubernetes }`.
  form: {
    fields: () => [...KUBERNETES_RUNNER_FORM_FIELDS, KUBERNETES_TOKEN_FIELD],
    skeleton: () => ({ kind: 'kubernetes', kubernetes: {} }) as RunnerBackendConfig,
    valuesFromConfig: (config) =>
      'kubernetes' in config
        ? flattenConfigValues(
            config.kubernetes as unknown as Record<string, unknown>,
            KUBERNETES_RUNNER_FORM_FIELDS,
          )
        : {},
  },
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
    assertCustomTlsSupported(config.kubernetes, opts)
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
