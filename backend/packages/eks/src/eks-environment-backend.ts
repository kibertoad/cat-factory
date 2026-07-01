import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  type EksProvisionConfig,
} from '@cat-factory/contracts'
import { type EnvironmentBackendProvider, kubernetesLogic } from '@cat-factory/integrations'
import type { EnvironmentManifest } from '@cat-factory/kernel'
import { EksEnvironmentProvider } from './EksEnvironmentProvider.js'

// The AWS EKS ephemeral-environment backend: per-PR namespaces on an EKS cluster, identical to
// the built-in `kubernetes` backend but authenticated with a minted IAM token. Registered by
// reference (opt-in) into the app-owned `EnvironmentBackendRegistry`; resolved by `kind` at
// provision time (`buildFromRecord` → `get('eks')`), so `buildProvider` returns the real
// `EksEnvironmentProvider`.
//
// `engines()` returns `remote-kubernetes` (an EKS cluster IS a remote Kubernetes apiserver).
// The built-in `kubernetes` backend is registered first, so it still wins `byEngine` — this
// backend never shadows it and is reached by explicitly pinning `backendKind: 'eks'`. NOTE:
// surfacing EKS as its OWN first-class engine in the SPA infra-handler selector (so the connect
// flow lowers to `{ kind: 'eks' }` rather than `{ kind: 'kubernetes' }`) needs a dedicated
// `InfraEngine('eks')` threaded through the contract engine union + `handlerConfigToBackendConfig`
// + the SPA forms — a scoped follow-up. The provider itself is fully functional today when
// resolved by kind (direct/API use and the integration suite construct it directly).
export const eksEnvironmentBackend: EnvironmentBackendProvider = {
  kind: 'eks',
  displayLabel: 'AWS EKS',
  engines: () => ['remote-kubernetes'],
  referencedSecretKeys: (config) =>
    'eks' in config ? [EKS_ACCESS_KEY_ID_SECRET_KEY, EKS_SECRET_ACCESS_KEY_SECRET_KEY] : [],
  connectionMeta: (config) => {
    if (!('eks' in config)) throw new Error('Expected an EKS environment config')
    return {
      providerId: 'eks',
      label: config.eks.label,
      baseUrl: config.eks.apiServerUrl,
    }
  },
  assertConfigSafe: (config, opts) => {
    if (!('eks' in config)) return
    kubernetesLogic.assertApiServerUrlSafe(config.eks.apiServerUrl)
    kubernetesLogic.assertCustomTlsSupported(config.eks, opts)
  },
  toManifest: (config) => {
    if (!('eks' in config)) throw new Error('Expected an EKS environment config')
    return toEksManifest(config.eks)
  },
  fromManifest: (manifest) => ({
    kind: 'eks',
    eks: manifest.providerConfig as unknown as EksProvisionConfig,
  }),
  buildProvider: (ctx) => new EksEnvironmentProvider({ urlPolicy: ctx.urlPolicy }),
}

/** Store the EKS provision config on an EnvironmentManifest (the native adapter ignores the HTTP fields). */
function toEksManifest(config: EksProvisionConfig): EnvironmentManifest {
  return {
    providerId: 'eks',
    label: config.label,
    // The apiserver root; NOT manifest-SSRF-checked (a cluster is routinely a private host) —
    // the backend runs `assertApiServerUrlSafe` instead.
    baseUrl: config.apiServerUrl,
    // Inert for the native adapter (which mints an IAM token), but the manifest schema
    // requires an auth + provision + response; supply placeholders.
    auth: { type: 'bearer', secretRef: { key: EKS_ACCESS_KEY_ID_SECRET_KEY } },
    provision: { method: 'POST', pathTemplate: '' },
    response: {},
    ...(config.defaultTtlMs ? { defaultTtlMs: config.defaultTtlMs } : {}),
    providerConfig: config as unknown as Record<string, unknown>,
  }
}
