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
  displayLabel: 'Kubernetes',
  // Serves both the in-cluster `local-k3s` preset and an external `remote-kubernetes`
  // apiserver — the difference is config (the apiserver URL), not a separate backend.
  engines: () => ['local-k3s', 'remote-kubernetes'],
  // Structural (`'kubernetes' in config`) narrowing, not `config.kind === 'kubernetes'`:
  // the open contract union now carries a generic `{ kind: string, manifest }` custom member
  // whose `kind` can equal `'kubernetes'`, so a kind-equality check no longer narrows away
  // that member. The registry routes by slug, so this backend only ever sees its own config.
  referencedSecretKeys: (config) =>
    'kubernetes' in config ? [KUBERNETES_ENV_TOKEN_SECRET_KEY] : [],
  connectionMeta: (config) => {
    if (!('kubernetes' in config)) throw new Error('Expected a kubernetes environment config')
    return {
      providerId: 'kubernetes',
      label: config.kubernetes.label,
      baseUrl: config.kubernetes.apiServerUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (!('kubernetes' in config)) return
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
    if (!('kubernetes' in config)) throw new Error('Expected a kubernetes environment config')
    return kubernetesConfigToManifest(config.kubernetes)
  },
  fromManifest: (manifest) => ({
    kind: 'kubernetes',
    kubernetes: parseKubernetesEnvConfig(manifest),
  }),
  buildProvider: (ctx) => new KubernetesEnvironmentProvider({ urlPolicy: ctx.urlPolicy }),
}
