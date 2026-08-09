import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  type EksConnectionConfig,
  type EksProvisionConfig,
  eksClusterFieldsSchema,
  eksConnectionConfigSchema,
  eksProvisionConfigSchema,
  parseStoredProviderConfig,
} from '@cat-factory/contracts'
import {
  KubernetesApiClient,
  KubernetesEnvironmentProvider,
  kubernetesLogic,
} from '@cat-factory/integrations'
import type {
  EnvironmentManifest,
  KubernetesConnectionConfig,
  ProviderConfigField,
  SecretResolver,
} from '@cat-factory/kernel'
import { eksTokenProvider } from './eks-auth.logic.js'

// The AWS EKS ephemeral-environment provider. An EKS apiserver is a standard Kubernetes
// apiserver, so per-PR namespace creation, server-side manifest apply, deployment-readiness
// polling and LoadBalancer/Ingress/Gateway URL resolution are IDENTICAL — this reuses all of
// `KubernetesEnvironmentProvider` and only overrides the auth seam (`makeClient`) to inject the
// minted EKS IAM token, plus `describeConfig` to surface the AWS credential fields instead of a
// static ServiceAccount token. The parsed config rides the stored manifest's `providerConfig`
// (an `EksProvisionConfig`), so `region`/`clusterName` are present at runtime.
export class EksEnvironmentProvider extends KubernetesEnvironmentProvider {
  /**
   * The EKS SUPERSET of the base config, which is what the base class documents this seam for.
   *
   * Overriding it is load-bearing rather than tidy: the schemas the parse runs are valibot
   * objects, and those DROP entries they do not declare, so inheriting the Kubernetes parse
   * silently returns a config with no `region` / `clusterName` / `stsHost` at all. The failure is
   * a token presigned against `sts.undefined.amazonaws.com`, several layers from the cause.
   */
  protected override parseConfig(manifest: EnvironmentManifest): EksProvisionConfig {
    const raw = manifest.providerConfig
    if (!raw) throw new Error('EKS environment manifest is missing its providerConfig')
    return parseStoredProviderConfig(eksProvisionConfigSchema, raw, 'EKS environment manifest')
  }

  /**
   * Reaching an EKS apiserver takes the AWS coordinates too, because the Bearer token is MINTED
   * against them rather than stored. So the reclaim path's narrow read is widened here by exactly
   * those fields, and no further: the base class's split (build needs the whole config, reclaim
   * needs the connection) survives inheritance instead of being re-collapsed here.
   */
  protected override parseConnection(manifest: EnvironmentManifest): EksConnectionConfig {
    const raw = manifest.providerConfig
    if (!raw) throw new Error('EKS environment manifest is missing its providerConfig')
    return parseStoredProviderConfig(eksConnectionConfigSchema, raw, 'EKS environment manifest')
  }

  protected override makeClient(
    config: KubernetesConnectionConfig,
    resolveSecret: SecretResolver,
  ): KubernetesApiClient {
    // Narrowed by a parse, not an assertion: `config` arrives as whatever the calling path
    // parsed (the full provision config when provisioning, the connection when reclaiming), and
    // both carry the cluster fields — but only re-reading them here says so in a way that fails
    // with the field's name rather than as an unsigned token deep inside the minter.
    const cluster = parseStoredProviderConfig(
      eksClusterFieldsSchema,
      config,
      'EKS environment manifest',
    )
    return new KubernetesApiClient(
      config,
      resolveSecret,
      kubernetesLogic.KUBERNETES_TOKEN_KEY,
      eksTokenProvider(cluster, resolveSecret),
    )
  }

  override describeConfig(): ProviderConfigField[] {
    // EKS authenticates with AWS credentials (used to mint the short-lived apiserver IAM token),
    // not a static ServiceAccount token — so the unconfigured banner clears on these keys.
    return [
      {
        key: EKS_ACCESS_KEY_ID_SECRET_KEY,
        label: 'AWS access key id',
        secret: true,
        required: true,
      },
      {
        key: EKS_SECRET_ACCESS_KEY_SECRET_KEY,
        label: 'AWS secret access key',
        secret: true,
        required: true,
      },
    ]
  }
}
