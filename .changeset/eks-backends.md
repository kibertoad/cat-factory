---
'@cat-factory/eks': minor
'@cat-factory/contracts': minor
'@cat-factory/integrations': minor
'@cat-factory/node-server': minor
---

Add opt-in AWS EKS runner + environment backends as a new standalone package
`@cat-factory/eks`. An EKS cluster's apiserver is a standard Kubernetes apiserver, so the
package reuses the native Kubernetes transport/provider from `@cat-factory/integrations`
verbatim and only supplies the EKS differentiator: a short-lived SigV4-presigned STS (IAM)
apiserver token, minted with WebCrypto (no runtime AWS SDK dependency).

- `@cat-factory/contracts`: new first-class `{ kind: 'eks' }` runner + environment backend
  variants (`eksRunnerConfigSchema` / `eksProvisionConfigSchema`), the shared
  `eksClusterFieldsSchema` (`region` / `clusterName` / optional `stsHost`), and the AWS
  secret-key constants. `'eks'` is now a reserved backend kind.
- `@cat-factory/integrations`: `KubernetesApiClient` gains an optional async token-provider
  seam (behaviour-preserving for the existing Kubernetes backend), and the runner
  transport / environment provider expose it so a different auth scheme can be injected.
- `@cat-factory/node-server`: registers the EKS backends by reference (opt-in; the default
  registries stay AWS-free). EKS is Node/local-only — the Cloudflare Worker can't verify an
  EKS cluster's private CA, so it is intentionally not registered there.
