import { ValidationError } from '@cat-factory/kernel'
import { KUBERNETES_ENV_TOKEN_SECRET_KEY } from '@cat-factory/contracts'
import { assertApiServerUrlSafe } from './kubernetes.logic.js'
import {
  kubernetesConfigToManifest,
  parseKubernetesEnvConfig,
} from './kubernetes-environment.logic.js'
import { KubernetesEnvironmentProvider } from './KubernetesEnvironmentProvider.js'
// Type-only import of the registry seam so there is no runtime cycle (see the runner
// backend file for the same pattern): environment-backends.ts imports this const and
// registers it; this file only borrows the interface shape.
import type { EnvironmentBackendProvider } from '../environments/environment-backends.js'

// Built-in: kubernetes environment backend (native per-PR namespaces over the apiserver).
// Defined here, under the kubernetes module, so every Kubernetes symbol is colocated; the
// generic environment-backend registry imports it for side-effect registration, exactly as
// it does the `manifest` built-in.

export const kubernetesEnvironmentBackend: EnvironmentBackendProvider = {
  kind: 'kubernetes',
  referencedSecretKeys: (config) =>
    config.kind === 'kubernetes' ? [KUBERNETES_ENV_TOKEN_SECRET_KEY] : [],
  connectionMeta: (config) => {
    if (config.kind !== 'kubernetes') throw new Error('Expected a kubernetes environment config')
    return {
      providerId: 'kubernetes',
      label: config.kubernetes.label,
      baseUrl: config.kubernetes.apiServerUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (config.kind !== 'kubernetes') return
    assertApiServerUrlSafe(config.kubernetes.apiServerUrl)
    const needsCustomTls =
      !!config.kubernetes.caCertPem || !!config.kubernetes.insecureSkipTlsVerify
    if (needsCustomTls && opts?.customTlsSupported === false) {
      // Caller-input error (a config this runtime can't honor) → ValidationError (422 with
      // the reason), not a plain Error (a generic 500 the connect form can't surface).
      throw new ValidationError(
        'This runtime cannot verify a custom CA / skip TLS for the Kubernetes apiserver ' +
          '(it requires the Node runtime). Use a publicly-trusted apiserver certificate, or ' +
          'run this workspace on the Node/local deployment.',
      )
    }
  },
  toManifest: (config) => {
    if (config.kind !== 'kubernetes') throw new Error('Expected a kubernetes environment config')
    return kubernetesConfigToManifest(config.kubernetes)
  },
  fromManifest: (manifest) => ({
    kind: 'kubernetes',
    kubernetes: parseKubernetesEnvConfig(manifest),
  }),
  buildProvider: (ctx) => new KubernetesEnvironmentProvider({ urlPolicy: ctx.urlPolicy }),
}
