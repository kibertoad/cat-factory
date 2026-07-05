import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  EKS_SESSION_TOKEN_SECRET_KEY,
} from '@cat-factory/contracts'
import type { ProviderConfigField } from '@cat-factory/kernel'

// The EKS-specific flat connect-form fields, shared by the runner + environment backends so the
// two can't drift. An EKS config is a Kubernetes config (its shared apiserver fields come from
// `kubernetesLogic.KUBERNETES_RUNNER_FORM_FIELDS`) PLUS these AWS fields: the non-secret
// region/cluster/STS-host used to mint the IAM apiserver token, and the credential secrets that
// ride the write-only bundle. The SPA renders them generically — it never knows EKS exists.

/** Non-secret AWS cluster fields (region + cluster name + optional STS host override). */
export const EKS_CLUSTER_FORM_FIELDS: ProviderConfigField[] = [
  {
    key: 'region',
    label: 'AWS region',
    required: true,
    placeholder: 'us-east-1',
    help: 'The cluster region — the regional STS endpoint + the SigV4 credential scope.',
  },
  {
    key: 'clusterName',
    label: 'EKS cluster name',
    required: true,
    placeholder: 'prod',
    help: 'Bound into the presigned STS token via the signed x-k8s-aws-id header.',
  },
  {
    key: 'stsHost',
    label: 'STS host override',
    placeholder: 'sts.us-east-1.amazonaws.com',
    help: 'Set for a VPC/FIPS/GovCloud STS endpoint. Bare host or host:port; defaults to the regional public endpoint.',
  },
]

/** AWS credential secrets (access key + secret key required, session token optional). */
export const EKS_CREDENTIAL_FORM_FIELDS: ProviderConfigField[] = [
  { key: EKS_ACCESS_KEY_ID_SECRET_KEY, label: 'AWS access key id', secret: true, required: true },
  {
    key: EKS_SECRET_ACCESS_KEY_SECRET_KEY,
    label: 'AWS secret access key',
    secret: true,
    required: true,
  },
  {
    key: EKS_SESSION_TOKEN_SECRET_KEY,
    label: 'AWS session token',
    secret: true,
    help: 'Only for temporary (STS / assume-role) credentials.',
  },
]
