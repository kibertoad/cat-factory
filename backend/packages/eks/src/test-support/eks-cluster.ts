import type { EksProvisionConfig, EksRunnerConfig } from '@cat-factory/contracts'
import {
  EKS_ACCESS_KEY_ID_SECRET_KEY,
  EKS_SECRET_ACCESS_KEY_SECRET_KEY,
  EKS_SESSION_TOKEN_SECRET_KEY,
} from '@cat-factory/contracts'
import type { SecretResolver } from '@cat-factory/kernel'

// Shared support for the EKS INTEGRATION suites (`*.it.spec.ts`). It reads the live cluster
// connection from `EKS_IT_*` (set by the CI job, which boots a floci-emulated EKS cluster —
// `floci` starts a real k3s container per cluster — creates the cluster via the AWS CLI, and
// exports the apiserver endpoint + CA + AWS test credentials). When the env is absent the
// specs `describe.skip(...)`, so a developer with no cluster — and any non-EKS PR — runs zero
// infra. This mirrors the Kubernetes suite's `test-support/cluster.ts` exactly, differing only
// in that the secret bundle holds AWS credentials (used to mint the IAM apiserver token) rather
// than a static ServiceAccount token, and the apiserver is reached the same way afterwards.

export interface EksClusterEnv {
  /** The EKS cluster apiserver endpoint (from `aws eks describe-cluster`). */
  apiServerUrl: string
  region: string
  clusterName: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** floci's emulated STS host (e.g. `localhost:4566`), or unset for real AWS STS. */
  stsHost?: string
  /** Namespace the runner pods are created in. */
  namespace: string
  /** The mock-harness image (imported into floci's k3s); required only by the runner suite. */
  runnerImage?: string
  /** PEM CA bundle for the apiserver's cert. */
  caCertPem?: string
  /** Skip apiserver TLS verification (emulated/dev clusters only). */
  insecureSkipTlsVerify?: boolean
}

/** Read the cluster connection from `EKS_IT_*`, or null when it isn't configured. */
export function readEksClusterEnv(): EksClusterEnv | null {
  const apiServerUrl = process.env.EKS_IT_APISERVER
  const region = process.env.EKS_IT_REGION
  const clusterName = process.env.EKS_IT_CLUSTER_NAME
  const accessKeyId = process.env.EKS_IT_ACCESS_KEY_ID
  const secretAccessKey = process.env.EKS_IT_SECRET_ACCESS_KEY
  if (!apiServerUrl || !region || !clusterName || !accessKeyId || !secretAccessKey) return null
  const insecure = process.env.EKS_IT_INSECURE === '1' || process.env.EKS_IT_INSECURE === 'true'
  return {
    apiServerUrl,
    region,
    clusterName,
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.EKS_IT_SESSION_TOKEN || undefined,
    stsHost: process.env.EKS_IT_STS_HOST || undefined,
    namespace: process.env.EKS_IT_NAMESPACE ?? 'cat-factory-it',
    runnerImage: process.env.EKS_IT_RUNNER_IMAGE || undefined,
    caCertPem: process.env.EKS_IT_CA_PEM || undefined,
    insecureSkipTlsVerify: insecure || undefined,
  }
}

/** The reason to skip the suite, or null when the cluster env is fully present. */
export function eksSkipReason(
  env: EksClusterEnv | null,
  opts: { needsRunnerImage?: boolean } = {},
): string | null {
  if (!env) {
    return 'set EKS_IT_APISERVER + EKS_IT_REGION + EKS_IT_CLUSTER_NAME + EKS_IT_ACCESS_KEY_ID + EKS_IT_SECRET_ACCESS_KEY to run the EKS integration suite'
  }
  if (!env.caCertPem && !env.insecureSkipTlsVerify) {
    return 'set EKS_IT_CA_PEM (apiserver CA) or EKS_IT_INSECURE=1 to trust the apiserver TLS'
  }
  if (opts.needsRunnerImage && !env.runnerImage) {
    return 'set EKS_IT_RUNNER_IMAGE to the mock-harness image to run the runner suite'
  }
  return null
}

/** A SecretResolver serving the cluster's AWS credentials by their secret-bundle keys. */
export function awsSecretResolver(env: EksClusterEnv): SecretResolver {
  const secrets: Record<string, string> = {
    [EKS_ACCESS_KEY_ID_SECRET_KEY]: env.accessKeyId,
    [EKS_SECRET_ACCESS_KEY_SECRET_KEY]: env.secretAccessKey,
    ...(env.sessionToken ? { [EKS_SESSION_TOKEN_SECRET_KEY]: env.sessionToken } : {}),
  }
  return (key) => secrets[key]
}

/** Build an EksRunnerConfig pointed at the live cluster. */
export function eksRunnerConfig(
  env: EksClusterEnv,
  overrides: Partial<EksRunnerConfig> = {},
): EksRunnerConfig {
  return {
    label: 'floci-eks-it',
    apiServerUrl: env.apiServerUrl,
    namespace: env.namespace,
    image: env.runnerImage ?? 'cat-factory-mock-harness:it',
    region: env.region,
    clusterName: env.clusterName,
    ...(env.stsHost ? { stsHost: env.stsHost } : {}),
    ...(env.caCertPem ? { caCertPem: env.caCertPem } : {}),
    ...(env.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
    ...overrides,
  }
}

/** Build an EksProvisionConfig pointed at the live cluster (k3s ServiceLB URL). */
export function eksEnvConfig(
  env: EksClusterEnv,
  overrides: Partial<EksProvisionConfig> = {},
): EksProvisionConfig {
  return {
    label: 'floci-eks-it',
    apiServerUrl: env.apiServerUrl,
    manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
    url: { source: 'serviceStatus', serviceName: 'web', scheme: 'http', port: 80 },
    region: env.region,
    clusterName: env.clusterName,
    ...(env.stsHost ? { stsHost: env.stsHost } : {}),
    ...(env.caCertPem ? { caCertPem: env.caCertPem } : {}),
    ...(env.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
    ...overrides,
  }
}

/** Poll `fn` tolerating intermediate rejections until `ok`, then return the value (rethrow on timeout). */
export async function waitForResolved<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  { timeoutMs = 120_000, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  let threw = false
  for (;;) {
    try {
      const value = await fn()
      if (ok(value)) return value
    } catch (err) {
      lastError = err
      threw = true
    }
    if (Date.now() >= deadline) {
      if (threw) throw lastError
      throw new Error('waitForResolved timed out before the condition held')
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** A unique-ish suffix for per-test run ids (avoids cross-rerun collisions). */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}
