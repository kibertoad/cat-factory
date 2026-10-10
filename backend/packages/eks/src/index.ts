// Public surface of the opt-in AWS EKS backend package.
//
// An EKS cluster's apiserver is a standard Kubernetes apiserver, so this package REUSES the
// native Kubernetes transport/provider from `@cat-factory/integrations` and only supplies the
// EKS differentiator: a SigV4-presigned STS (IAM) apiserver token minted per use. A deployment
// opts in by registering the two backends BY REFERENCE into the app-owned registries from its
// composition root (the default registries stay AWS-free):
//
//   import { eksRunnerBackend, eksEnvironmentBackend } from '@cat-factory/eks'
//   registries.runnerBackendRegistry.register(eksRunnerBackend)
//   registries.environmentBackendRegistry.register(eksEnvironmentBackend)

export { eksRunnerBackend } from './eks-runner-backend.js'
export { eksEnvironmentBackend } from './eks-environment-backend.js'
export { EksRunnerTransport } from './EksRunnerTransport.js'
export { EksEnvironmentProvider } from './EksEnvironmentProvider.js'
export {
  mintEksToken,
  eksTokenProvider,
  readAwsCredentials,
  type MintEksTokenParams,
  type EksAwsCredentials,
} from './eks-auth.logic.js'
