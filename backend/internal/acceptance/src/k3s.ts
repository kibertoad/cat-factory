// The k3s ephemeral-environment wiring: the two halves the platform keeps deliberately apart.
//
// cat-factory splits a per-PR environment into an ENGINE (the workspace's infra handler: which
// apiserver, which credentials, how a URL is derived) and a SOURCE (each service's own
// `provisioning`: where its manifests live). See `backend/docs/per-service-provisioning.md`. The
// suite has to supply both, and they are built here rather than inline in a spec so the pair
// stays readable as a pair.
//
// **`raw`, not `kustomize`, is load-bearing.** A `raw` manifest source is applied synchronously
// over the apiserver REST client the backend already speaks, so this suite needs no deploy
// runner at all. A `kustomize` overlay must be rendered by the container-backed deploy adapter,
// which would add `LOCAL_DEPLOY_RUNTIME=container` plus a pullable deploy image to the setup:
// real product surface, but a second thing to get wrong before the first assertion runs. The
// suite covers the leaner path and says so; `backend/docs/local-k3s-environments.md` owns the
// other one.

import type { InfraHandlerConfig, ServiceProvisioning } from '@cat-factory/contracts'
import type { ClusterConfig } from './config.ts'

/**
 * The in-repo directory the bootstrapped services put their manifests in.
 *
 * It appears in exactly two places (here, and in the bootstrap instructions that ask the agent
 * to author them, `instructions.ts`), and they must agree, because the failure mode when they
 * do not is a `deployer` step reporting an empty manifest source, which reads like a broken
 * cluster rather than a mismatched path. Both read this constant.
 */
export const MANIFEST_DIR = 'deploy/k8s'

/** The secret-bundle key the Kubernetes env backend reads its ServiceAccount token from. */
const TOKEN_SECRET_KEY = 'apiToken'

/**
 * The workspace-level engine connection.
 *
 * `insecureSkipTlsVerify` is offered because k3s self-signs and a throwaway local cluster is
 * exactly the case the field documents itself for; a CA PEM is preferred and wins when both are
 * supplied, so an operator who pasted one is never silently downgraded.
 */
export function buildK3sHandlerConfig(cluster: ClusterConfig): InfraHandlerConfig {
  return {
    engine: 'local-k3s',
    kubernetes: {
      label: 'Acceptance k3s',
      apiServerUrl: cluster.apiServerUrl,
      ...(cluster.caCertPem
        ? { caCertPem: cluster.caCertPem }
        : { insecureSkipTlsVerify: cluster.insecureSkipTlsVerify }),
      namespaceTemplate: cluster.namespaceTemplate,
      url: { source: 'ingressTemplate', hostTemplate: cluster.ingressHostTemplate, scheme: 'http' },
      // 45 minutes. The sweeper's backstop only, not the normal exit: the `disposer` step
      // reclaims the namespace as the run settles, and spec 02 asserts it did. A TTL that fired
      // first would tear the environment down under the assertion and report a teardown the run
      // did not perform.
      defaultTtlMs: 45 * 60 * 1000,
      labels: { 'cat-factory.ai/acceptance': 'true' },
    },
  }
}

/** The secret bundle that rides the handler registration. Never logged; never echoed back. */
export function buildK3sSecrets(cluster: ClusterConfig): Record<string, string> {
  return { [TOKEN_SECRET_KEY]: cluster.apiToken }
}

/** The per-service half: manifests colocated in the service's own repo, read at the PR head. */
export function buildServiceProvisioning(): ServiceProvisioning {
  return {
    type: 'kubernetes',
    manifestSource: { type: 'colocated', path: MANIFEST_DIR, renderer: 'raw' },
  }
}

/**
 * The environment URL a namespace will answer on, for a spec that wants to state the expectation
 * before the run produces it.
 *
 * Renders the same `{{namespace}}` hole the backend renders, and ONLY that one: the other
 * provision vars (`{{branch}}`, `{{pullNumber}}`) are not known to this suite before a run opens
 * its pull request, so a template using them is reported as unrenderable rather than guessed at.
 */
export function renderEnvironmentHost(hostTemplate: string, namespace: string): string | null {
  const rendered = hostTemplate.replaceAll('{{namespace}}', namespace)
  return rendered.includes('{{') ? null : rendered
}

/**
 * The FIXED tail of an ingress host template: everything after the last `}}`.
 *
 * What a spec can honestly assert about a provisioned environment's URL. The namespace and
 * pull-request number in the template are values the RUN chose, which this suite cannot predict
 * and has no business pinning; the domain it configured is the part that proves the URL came from
 * the k3s wiring under test rather than from some other environment backend.
 */
export function hostSuffix(hostTemplate: string): string {
  const lastHole = hostTemplate.lastIndexOf('}}')
  return lastHole === -1 ? hostTemplate : hostTemplate.slice(lastHole + 2)
}
