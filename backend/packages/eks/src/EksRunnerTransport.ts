import type { EksRunnerConfig } from '@cat-factory/contracts'
import { KubernetesRunnerTransport } from '@cat-factory/integrations'
import type { SecretResolver } from '@cat-factory/kernel'
import { eksTokenProvider } from './eks-auth.logic.js'

// The AWS EKS runner transport. An EKS cluster's apiserver IS a standard Kubernetes apiserver,
// so this reuses the ENTIRE native Kubernetes per-run-pod transport (pod creation, readiness
// wait, pod-proxy dispatch/poll, eviction handling) VERBATIM — the only difference is auth. It
// injects the async EKS token provider (a SigV4-presigned STS token minted per use from the
// workspace's AWS credentials + `region`/`clusterName`) through the transport's token seam, so
// there is zero duplicated transport logic. An `EksRunnerConfig` is a `KubernetesRunnerConfig`
// plus the AWS `region`/`clusterName`, so it is passed straight to the base class.
export class EksRunnerTransport extends KubernetesRunnerTransport {
  constructor(config: EksRunnerConfig, resolveSecret: SecretResolver) {
    super(config, resolveSecret, eksTokenProvider(config, resolveSecret))
  }
}
