import type {
  KubernetesEnvironmentConfig,
  KubernetesRunnerConfig,
  SecretResolver,
} from '@cat-factory/kernel'
import { KubernetesApiClient } from '../KubernetesApiClient.js'
import { podUrl } from '../kubernetes.logic.js'
import { namespaceUrl } from '../kubernetes-environment.logic.js'

// Shared support for the Kubernetes INTEGRATION suites (`*.it.spec.ts`). It reads the live
// cluster connection from the environment (set by `k3d` locally or the CI job), builds the
// real backend configs + a token resolver, and exposes the small raw-apiserver helpers the
// specs use for arrange/cleanup. When the env is absent the specs `describe.skip(...)`, so a
// developer with no cluster — and any non-Kubernetes PR — runs zero infra.

export interface ClusterEnv {
  /** kube-apiserver root, e.g. `https://127.0.0.1:6443`. */
  apiServerUrl: string
  /** ServiceAccount bearer token with the RBAC the suites need. */
  token: string
  /** Namespace the runner pods are created in. */
  namespace: string
  /** The mock-harness image (`k3d image import`ed); required only by the runner suite. */
  runnerImage?: string
  /** PEM CA bundle for the apiserver's (self-signed) cert. */
  caCertPem?: string
  /** Skip apiserver TLS verification (dev clusters only). */
  insecureSkipTlsVerify?: boolean
}

/** Read the cluster connection from `K8S_IT_*`, or null when it isn't configured. */
export function readClusterEnv(): ClusterEnv | null {
  const apiServerUrl = process.env.K8S_IT_APISERVER
  const token = process.env.K8S_IT_TOKEN
  if (!apiServerUrl || !token) return null
  const insecure = process.env.K8S_IT_INSECURE === '1' || process.env.K8S_IT_INSECURE === 'true'
  return {
    apiServerUrl,
    token,
    namespace: process.env.K8S_IT_NAMESPACE ?? 'cat-factory-it',
    runnerImage: process.env.K8S_IT_RUNNER_IMAGE || undefined,
    caCertPem: process.env.K8S_IT_CA_PEM || undefined,
    insecureSkipTlsVerify: insecure || undefined,
  }
}

/** The reason to skip the suite, or null when the cluster env is fully present. */
export function clusterSkipReason(
  env: ClusterEnv | null,
  opts: { needsRunnerImage?: boolean } = {},
): string | null {
  if (!env) return 'set K8S_IT_APISERVER + K8S_IT_TOKEN to run the Kubernetes integration suite'
  if (!env.caCertPem && !env.insecureSkipTlsVerify) {
    return 'set K8S_IT_CA_PEM (apiserver CA) or K8S_IT_INSECURE=1 to trust the apiserver TLS'
  }
  if (opts.needsRunnerImage && !env.runnerImage) {
    return 'set K8S_IT_RUNNER_IMAGE to the imported mock-harness image to run the runner suite'
  }
  return null
}

/** A SecretResolver that always returns the cluster's bearer token (the only secret read). */
export function tokenResolver(env: ClusterEnv): SecretResolver {
  return () => env.token
}

/** Build a KubernetesRunnerConfig pointed at the live cluster. */
export function runnerConfig(
  env: ClusterEnv,
  overrides: Partial<KubernetesRunnerConfig> = {},
): KubernetesRunnerConfig {
  return {
    label: 'k3d-it',
    apiServerUrl: env.apiServerUrl,
    namespace: env.namespace,
    image: env.runnerImage ?? 'cat-factory-mock-harness:it',
    ...(env.caCertPem ? { caCertPem: env.caCertPem } : {}),
    ...(env.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
    ...overrides,
  }
}

/** Build a KubernetesEnvironmentConfig pointed at the live cluster (k3s ServiceLB URL). */
export function envConfig(
  env: ClusterEnv,
  overrides: Partial<KubernetesEnvironmentConfig> = {},
): KubernetesEnvironmentConfig {
  return {
    label: 'k3d-it',
    apiServerUrl: env.apiServerUrl,
    manifestSource: { type: 'colocated', path: 'k8s/app.yaml' },
    url: { source: 'serviceStatus', serviceName: 'web', scheme: 'http', port: 80 },
    ...(env.caCertPem ? { caCertPem: env.caCertPem } : {}),
    ...(env.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
    ...overrides,
  }
}

/** A raw apiserver client for arrange/cleanup (namespace-agnostic). */
export function rawClient(env: ClusterEnv): KubernetesApiClient {
  return new KubernetesApiClient(
    {
      apiServerUrl: env.apiServerUrl,
      caCertPem: env.caCertPem,
      insecureSkipTlsVerify: env.insecureSkipTlsVerify,
    },
    () => env.token,
  )
}

/** Best-effort delete of a namespace (ignores any failure — cleanup only). */
export async function deleteNamespaceQuietly(env: ClusterEnv, name: string): Promise<void> {
  try {
    await rawClient(env).fetch('DELETE', namespaceUrl(envConfig(env), name), undefined, 30_000)
  } catch {
    // cleanup is best-effort
  }
}

/** Best-effort delete of a runner pod by name (ignores any failure — cleanup only). */
export async function deletePodQuietly(env: ClusterEnv, name: string): Promise<void> {
  try {
    await rawClient(env).fetch('DELETE', podUrl(runnerConfig(env), name), undefined, 30_000)
  } catch {
    // cleanup is best-effort
  }
}

/** Poll `fn` until `ok` or the timeout, returning the last value either way. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  { timeoutMs = 120_000, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** A unique-ish suffix for per-test namespaces / run ids (avoids cross-rerun collisions). */
export function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}
