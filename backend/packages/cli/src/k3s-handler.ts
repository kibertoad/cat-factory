import { ingressHostTemplate, ingressUrlPort } from './k3s-ingress.js'
import { type ResolvedConnection } from './k3s-provision.js'

/**
 * The secret-bundle key the Kubernetes env backend reads the ServiceAccount token from. Mirrors
 * the contracts constant `KUBERNETES_ENV_TOKEN_SECRET_KEY`, kept inline so the CLI stays free of a
 * backend/contract RUNTIME dependency (the unit test validates the built handler against the real
 * `registerEnvironmentHandlerSchema`, so any drift from the contract fails a test).
 */
export const KUBERNETES_ENV_TOKEN_SECRET_KEY = 'apiToken'

/** Default per-PR namespace name template written into the handler (rendered with the PR number). */
export const DEFAULT_NAMESPACE_TEMPLATE = 'cf-env-{{pullNumber}}'

/**
 * The `RegisterEnvironmentHandlerInput` shape for the `local-k3s` engine, mirrored structurally
 * here so the CLI stays free of a backend/contract runtime dependency. `k3s-handler.test.ts`
 * validates a built value against the real `registerEnvironmentHandlerSchema`, so this can't drift
 * from the contract without failing a test.
 *
 * `url.port` carries a non-default host port. It is deliberately NOT folded into `hostTemplate`:
 * the rendered template is also the Ingress `host` a service's manifests declare, and Kubernetes
 * rejects a `host` with a port in it.
 */
export interface K3sHandlerInput {
  provisionType: 'kubernetes'
  config: {
    engine: 'local-k3s'
    kubernetes: {
      label: string
      apiServerUrl: string
      insecureSkipTlsVerify: true
      namespaceTemplate: string
      url: { source: 'ingressTemplate'; hostTemplate: string; port?: number; scheme: 'http' }
    }
  }
  secrets: Record<string, string>
}

/** Human label for the auto-provisioned connection (names the created cluster when there is one). */
export function handlerLabel(connection: ResolvedConnection): string {
  return connection.clusterName ? `Local k3s (${connection.clusterName})` : 'Local k3s'
}

/**
 * Build the `local-k3s` infra handler registration input from a provisioned connection, or `null`
 * when there is nothing honest to register. The minted ServiceAccount token rides ONLY in the
 * write-only `secrets` bundle (never in the config, never in the deep-link). Everything else (the
 * loopback apiserver URL, the skip-TLS flag for a self-signed local apiserver, the per-PR namespace
 * and the nip.io ingress host) is non-secret config. The result is exactly what the
 * Settings → Infrastructure → Local k3s form's Test/Save posts, so the guided flow reuses the #557
 * probe + registration unchanged.
 *
 * `null` is the whole point of the return type. The contract REQUIRES a `url` source, and
 * `ingressTemplate` is the only one the CLI can fill on its own (the status-backed sources name a
 * Service or Ingress that belongs to the operator's manifests), so a cluster whose ingress path the
 * probe did not establish has no handler to build: filling the host template in anyway is how the
 * unserved URL got saved. It used to fall back to the literal template, which was worse than stale
 * on a `--ingress-port 8080` run, naming a port that run had not even asked for.
 */
export function buildK3sHandler(connection: ResolvedConnection): K3sHandlerInput | null {
  const hostTemplate = ingressHostTemplate(connection.ingress)
  if (hostTemplate === null) return null
  const port = ingressUrlPort(connection.ingress)
  return {
    provisionType: 'kubernetes',
    config: {
      engine: 'local-k3s',
      kubernetes: {
        label: handlerLabel(connection),
        apiServerUrl: connection.apiServerUrl,
        insecureSkipTlsVerify: true,
        namespaceTemplate: DEFAULT_NAMESPACE_TEMPLATE,
        url: {
          source: 'ingressTemplate',
          hostTemplate,
          ...(port === null ? {} : { port }),
          // A local ingress controller serves TLS with a self-signed certificate, so the derived
          // environment URL is plain HTTP: the derivation's own default is `https`, which would
          // hand the tester a URL that fails on the certificate rather than on the connection.
          scheme: 'http',
        },
      },
    },
    secrets: { [KUBERNETES_ENV_TOKEN_SECRET_KEY]: connection.apiToken },
  }
}

/**
 * Build the deep-link that opens the SPA's Local k3s connect form pre-filled with the connection's
 * NON-SECRET fields. The ServiceAccount token is deliberately omitted (a secret in a URL would leak
 * into browser history / server logs), so the user pastes it (printed once to the terminal) before
 * running Test → Save. Param names mirror the connect form's fields.
 *
 * The URL params are prefilled ONLY when the ingress probe established that the cluster can serve
 * them, and that is read off the CONNECTION rather than passed in: the withholding used to ride an
 * `{ ingressVerified }` option DEFAULTED to true, so every caller that forgot it (the integration
 * spec among them) re-established the promise this exists to remove. The connect form treats the
 * host template as required for an `ingressTemplate` source, so an operator whose cluster has no
 * ingress path cannot save a URL nothing answers, and the printed summary tells them what to fix or
 * which source to pick instead.
 */
export function buildK3sSetupUrl(spaBaseUrl: string, connection: ResolvedConnection): string {
  const url = new URL(spaBaseUrl)
  const params = url.searchParams
  params.set('infraSetup', 'local-k3s')
  params.set('label', handlerLabel(connection))
  params.set('apiServerUrl', connection.apiServerUrl)
  params.set('namespaceTemplate', DEFAULT_NAMESPACE_TEMPLATE)
  const handler = buildK3sHandler(connection)
  if (handler) {
    const k = handler.config.kubernetes.url
    params.set('hostTemplate', k.hostTemplate)
    params.set('scheme', k.scheme)
    if (k.port !== undefined) params.set('ingressPort', String(k.port))
  }
  if (connection.insecureSkipTlsVerify) params.set('insecureSkipTlsVerify', '1')
  return url.toString()
}
