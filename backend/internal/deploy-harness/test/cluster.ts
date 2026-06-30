import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runCli } from '../src/exec.js'
import type { ClusterSpec } from '../src/job.js'
import { writeKubeconfig } from '../src/kubeconfig.js'
import type { Logger } from '../src/logger.js'

// Shared support for the deploy-harness INTEGRATION suite (`*.it.spec.ts`). It reads the
// live cluster connection from the environment (set by `k3d` locally or the CI `test-k8s`
// job — the SAME `K8S_IT_*` vars the integrations Kubernetes suite uses) and exposes the
// small helpers the spec needs: a `ClusterSpec` builder, a local-git-repo manifest source
// (the harness clones from a URL, so the spec commits manifests into a throwaway repo and
// hands the harness a `file://` URL), a raw kubectl helper for assertions/cleanup, and a
// poller. When the env is absent the spec `describe.skip(...)`s, so a developer with no
// cluster — and any non-Kubernetes PR — runs zero infra.

export interface ClusterEnv {
  /** kube-apiserver root, e.g. `https://127.0.0.1:6443`. */
  apiServerUrl: string
  /** ServiceAccount bearer token with the RBAC the suite needs (namespace + apply + read). */
  token: string
  /** Namespace label hint (the suite creates its own per-test namespaces; this is the seed). */
  namespace: string
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
    caCertPem: process.env.K8S_IT_CA_PEM || undefined,
    insecureSkipTlsVerify: insecure || undefined,
  }
}

/** The reason to skip the suite, or null when the cluster env is fully present. */
export function clusterSkipReason(env: ClusterEnv | null): string | null {
  if (!env) return 'set K8S_IT_APISERVER + K8S_IT_TOKEN to run the deploy-harness integration suite'
  if (!env.caCertPem && !env.insecureSkipTlsVerify) {
    return 'set K8S_IT_CA_PEM (apiserver CA) or K8S_IT_INSECURE=1 to trust the apiserver TLS'
  }
  return null
}

/** Build the harness `ClusterSpec` (the job's `cluster` block) pointed at the live cluster. */
export function buildClusterSpec(env: ClusterEnv, namespace: string): ClusterSpec {
  return {
    apiServerUrl: env.apiServerUrl,
    token: env.token,
    namespace,
    ...(env.caCertPem ? { caCertPem: env.caCertPem } : {}),
    ...(env.insecureSkipTlsVerify ? { insecureSkipTlsVerify: true } : {}),
  }
}

/** A no-op logger so the suite doesn't spam stdout with the harness's per-step JSON lines. */
export const quietLog: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quietLog
  },
}

/** A kubectl bound to the cluster (its own kubeconfig), for arrange/assert/cleanup. */
export interface ClusterKubectl {
  /** Run `kubectl <args>`, resolving stdout (throws on non-zero exit). */
  run(args: string[]): Promise<string>
  /** Run `kubectl <args> -o json` and parse the result. */
  json(args: string[]): Promise<unknown>
  /** Best-effort `kubectl delete namespace <name>` (ignores any failure — cleanup only). */
  deleteNamespaceQuietly(name: string): Promise<void>
}

/** Build a kubectl helper for the cluster (a kubeconfig written once, reused by every call). */
export async function clusterKubectl(env: ClusterEnv): Promise<ClusterKubectl> {
  // The namespace in the kubeconfig context is irrelevant — every call passes `-n` explicitly.
  const kube = await writeKubeconfig(buildClusterSpec(env, env.namespace))
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await runCli('kubectl', args, { env: kube.env, redactSecrets: [env.token] })
    return stdout
  }
  return {
    run,
    async json(args) {
      return JSON.parse(await run([...args, '-o', 'json'])) as unknown
    },
    async deleteNamespaceQuietly(name) {
      try {
        await run(['delete', 'namespace', name, '--ignore-not-found', '--wait=false'])
      } catch {
        // cleanup is best-effort
      }
    },
  }
}

/**
 * Commit `files` into a throwaway git repo and return a `file://` clone URL + branch ref the
 * harness can clone. The harness reads manifests by cloning a URL; a local `file://` repo lets
 * the suite supply manifests offline (no network, no real remote). `file://` is used (not a bare
 * path) so the harness's shallow `git fetch --depth 1` is honored rather than silently ignored.
 */
export async function gitRepoWithManifests(
  files: Record<string, string>,
): Promise<{ cloneUrl: string; ref: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-manifests-'))
  const git = (args: string[]): Promise<unknown> => runCli('git', ['-C', dir, ...args])
  await runCli('git', ['init', '-q', dir])
  // A deterministic branch name regardless of the host git's default-branch setting.
  await git(['checkout', '-q', '-b', 'deploy-test'])
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  await git(['add', '-A'])
  await git([
    '-c',
    'user.email=ci@cat-factory.test',
    '-c',
    'user.name=ci',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'manifests',
  ])
  return {
    cloneUrl: `file://${dir}`,
    ref: 'deploy-test',
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  }
}

/** Poll `fn` until `ok` or the timeout, returning the last value either way. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  ok: (value: T) => boolean,
  { timeoutMs = 150_000, intervalMs = 3_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (ok(value)) return value
    if (Date.now() >= deadline) return value
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** A unique per-test namespace name (avoids cross-test / cross-rerun collisions). */
export function uniqueNamespace(): string {
  return `cf-deploy-it-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}
