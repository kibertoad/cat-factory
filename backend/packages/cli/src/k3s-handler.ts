import { ingressHostTemplate } from './k3s-ingress.js'
import { type ResolvedConnection } from './k3s-provision.js'

/**
 * The secret-bundle key the Kubernetes env backend reads the ServiceAccount token from. Mirrors
 * the contracts constant `KUBERNETES_ENV_TOKEN_SECRET_KEY` — kept inline so the CLI stays free of a
 * backend/contract RUNTIME dependency (the unit test validates the built handler against the real
 * `registerEnvironmentHandlerSchema`, so any drift from the contract fails a test).
 */
export const KUBERNETES_ENV_TOKEN_SECRET_KEY = 'apiToken'

/** Default per-PR namespace name template written into the handler (rendered with the PR number). */
export const DEFAULT_NAMESPACE_TEMPLATE = 'cf-env-{{pullNumber}}'

/**
 * The ingress host template for the default host port. `nip.io` is a wildcard DNS service that
 * resolves `<anything>.127.0.0.1.nip.io` to loopback with no local DNS setup.
 *
 * It used to claim it "works against a local k3s/k3d/kind ingress out of the box", and it does
 * not: loopback resolution is only the DNS half, and the port behind it is served only when the
 * cluster both runs an ingress controller and publishes a host port into it. Neither is
 * assumed any more, so this constant is now the SHAPE of the template and
 * {@link buildK3sHandler} fills it in only from a probe that established both.
 */
export const DEFAULT_INGRESS_HOST_TEMPLATE = '{{branch}}.127.0.0.1.nip.io'

/**
 * The `RegisterEnvironmentHandlerInput` shape for the `local-k3s` engine, mirrored structurally
 * here so the CLI stays free of a backend/contract runtime dependency. `k3s-handler.test.ts`
 * validates a built value against the real `registerEnvironmentHandlerSchema`, so this can't drift
 * from the contract without failing a test.
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
      url: { source: 'ingressTemplate'; hostTemplate: string; scheme: 'http' }
    }
  }
  secrets: Record<string, string>
}

/** Human label for the auto-provisioned connection (names the created cluster when there is one). */
export function handlerLabel(connection: ResolvedConnection): string {
  return connection.clusterName ? `Local k3s (${connection.clusterName})` : 'Local k3s'
}

/**
 * Build the `local-k3s` infra handler registration input from a provisioned connection. The minted
 * ServiceAccount token rides ONLY in the write-only `secrets` bundle (never in the config, never in
 * the deep-link). Everything else — the loopback apiserver URL, the skip-TLS flag (a local k3s
 * apiserver self-signs its cert), the per-PR namespace + nip.io ingress host — is non-secret
 * config. The result is exactly what the Settings → Infrastructure → Local k3s form's Test/Save
 * posts, so the guided flow reuses the #557 probe + registration unchanged.
 *
 * The `url` block is the one part that is CONDITIONAL on what the probe established. The contract
 * requires a source, and `ingressTemplate` is the only one the CLI can fill on its own (the
 * status-backed sources name a Service or Ingress that belongs to the operator's manifests), so
 * the shape stays. What changes is that nothing PRESENTS it as wired when it is not:
 * {@link buildK3sSetupUrl} withholds the prefill, leaving the connect form's required host-template
 * field empty so the operator has to decide rather than saving a URL nothing serves.
 */
export function buildK3sHandler(connection: ResolvedConnection): K3sHandlerInput {
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
          hostTemplate: ingressHostTemplate(connection.ingress) ?? DEFAULT_INGRESS_HOST_TEMPLATE,
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
 * Build the deep-link that opens the SPA's Local k3s connect form pre-filled with the handler's
 * NON-SECRET fields. The ServiceAccount token is deliberately omitted — a secret in a URL would
 * leak into browser history / server logs — so the user pastes it (printed once to the terminal)
 * before running Test → Save. Param names mirror the connect form's fields.
 *
 * The host template is prefilled ONLY when the ingress probe established that the cluster can
 * serve it. Withholding it is the point: the connect form treats the host template as required
 * for an `ingressTemplate` source, so an operator whose cluster has no ingress path cannot save
 * a URL nothing answers, and the printed summary tells them what to fix or which source to pick
 * instead. Prefilling it anyway is exactly how the unserved promise used to reach the form.
 */
export function buildK3sSetupUrl(
  spaBaseUrl: string,
  handler: K3sHandlerInput,
  options: { ingressVerified: boolean } = { ingressVerified: true },
): string {
  const k = handler.config.kubernetes
  const url = new URL(spaBaseUrl)
  const params = url.searchParams
  params.set('infraSetup', 'local-k3s')
  params.set('label', k.label)
  params.set('apiServerUrl', k.apiServerUrl)
  params.set('namespaceTemplate', k.namespaceTemplate)
  if (options.ingressVerified) {
    params.set('hostTemplate', k.url.hostTemplate)
    params.set('scheme', k.url.scheme)
  }
  if (k.insecureSkipTlsVerify) params.set('insecureSkipTlsVerify', '1')
  return url.toString()
}
