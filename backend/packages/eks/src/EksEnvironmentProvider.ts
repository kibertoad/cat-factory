import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  type EksProvisionConfig,
} from '@cat-factory/contracts'
import {
  KubernetesApiClient,
  KubernetesEnvironmentProvider,
  kubernetesLogic,
} from '@cat-factory/integrations'
import type {
  KubernetesEnvironmentConfig,
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
  protected override makeClient(
    config: KubernetesEnvironmentConfig,
    resolveSecret: SecretResolver,
  ): KubernetesApiClient {
    const eks = config as EksProvisionConfig
    return new KubernetesApiClient(
      config,
      resolveSecret,
      kubernetesLogic.KUBERNETES_TOKEN_KEY,
      eksTokenProvider(eks, resolveSecret),
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
