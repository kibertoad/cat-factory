import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
} from '@cat-factory/contracts'
import { kubernetesLogic, type RunnerBackendProvider } from '@cat-factory/integrations'
import { EksRunnerTransport } from './EksRunnerTransport.js'

// The AWS EKS runner backend: native per-run pods on an EKS cluster over the apiserver
// pod-proxy, exactly like the built-in `kubernetes` backend but authenticated with a minted
// IAM token instead of a static ServiceAccount token. Registered by reference (opt-in) into the
// app-owned `RunnerBackendRegistry` from a facade's composition root — the default registry
// stays AWS-free (see `@cat-factory/integrations` `createBackendRegistries`).
//
// Routing is by `kind`, so this backend only ever sees its own `{ kind: 'eks', eks }` config;
// the structural `'eks' in config` narrowing (not `config.kind === 'eks'`) is used because the
// open contract union also carries a generic custom member whose `kind` could equal `'eks'`.
export const eksRunnerBackend: RunnerBackendProvider = {
  kind: 'eks',
  displayLabel: 'AWS EKS',
  referencedSecretKeys: (config) =>
    'eks' in config ? [EKS_ACCESS_KEY_ID_SECRET_KEY, EKS_SECRET_ACCESS_KEY_SECRET_KEY] : [],
  connectionMeta: (config) => {
    if (!('eks' in config)) throw new Error('Expected an EKS runner config')
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
  buildTransport: (config, ctx) => {
    if (!('eks' in config)) throw new Error('Expected an EKS runner config')
    return new EksRunnerTransport(config.eks, ctx.resolveSecret)
  },
  testConnection: (config, ctx) => {
    if (!('eks' in config)) {
      return Promise.resolve({ ok: false, message: 'Expected an EKS runner config' })
    }
    return new EksRunnerTransport(config.eks, ctx.resolveSecret).testConnection()
  },
}
