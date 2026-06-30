import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClusterSpec } from './job.js'

// Render a kubeconfig from the per-job cluster connection (apiserver URL + CA + bearer
// token) so kubectl/helm authenticate exactly as the native REST adapter's
// KubernetesApiClient does. The token never reaches argv — it lives only in this file
// (mode 0600, in an os.tmpdir() dir owned by the unprivileged harness user) and kubectl
// reads it via KUBECONFIG. The native adapter's apiserver-URL SSRF guard runs backend
// side before the job is dispatched, so this only renders what it is handed.

export interface KubeconfigHandle {
  /** Path to the rendered kubeconfig file. */
  path: string
  /** Child-process env with KUBECONFIG pointed at {@link path}. */
  env: NodeJS.ProcessEnv
}

/** A minimal single-context kubeconfig as a JSON object (valid YAML — kubectl reads either). */
function buildKubeconfig(cluster: ClusterSpec): Record<string, unknown> {
  const clusterEntry: Record<string, unknown> = { server: cluster.apiServerUrl }
  if (cluster.insecureSkipTlsVerify) {
    clusterEntry['insecure-skip-tls-verify'] = true
  } else if (cluster.caCertPem) {
    clusterEntry['certificate-authority-data'] = Buffer.from(cluster.caCertPem, 'utf8').toString(
      'base64',
    )
  }
  return {
    apiVersion: 'v1',
    kind: 'Config',
    clusters: [{ name: 'target', cluster: clusterEntry }],
    users: [{ name: 'deployer', user: { token: cluster.token } }],
    contexts: [
      {
        name: 'ctx',
        context: { cluster: 'target', user: 'deployer', namespace: cluster.namespace },
      },
    ],
    'current-context': 'ctx',
  }
}

/** Write the kubeconfig to a private temp file and return its path + the env that uses it. */
export async function writeKubeconfig(cluster: ClusterSpec): Promise<KubeconfigHandle> {
  const dir = await mkdtemp(join(tmpdir(), 'deploy-kubeconfig-'))
  const path = join(dir, 'config')
  await writeFile(path, JSON.stringify(buildKubeconfig(cluster)), 'utf8')
  await chmod(path, 0o600)
  return { path, env: { ...process.env, KUBECONFIG: path } }
}
