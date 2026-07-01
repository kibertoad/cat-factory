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
 * Default ingress host template. `nip.io` is a wildcard DNS service that resolves
 * `<anything>.127.0.0.1.nip.io` to loopback with no local DNS setup, so a per-branch env URL works
 * against a local k3s/k3d/kind ingress out of the box.
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
      url: { source: 'ingressTemplate'; hostTemplate: string }
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
 * apiserver self-signs its cert), the per-PR namespace + nip.io ingress host defaults — is
 * non-secret config. The result is exactly what the Settings → Infrastructure → Local k3s form's
 * Test/Save posts, so the guided flow reuses the #557 probe + registration unchanged.
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
        url: { source: 'ingressTemplate', hostTemplate: DEFAULT_INGRESS_HOST_TEMPLATE },
      },
    },
    secrets: { [KUBERNETES_ENV_TOKEN_SECRET_KEY]: connection.apiToken },
  }
}

/**
 * Build the deep-link that opens the SPA's Local k3s connect form pre-filled with the handler's
 * NON-SECRET fields. The ServiceAccount token is deliberately omitted — a secret in a URL would
 * leak into browser history / server logs — so the user pastes it (printed once to the terminal)
 * before running Test → Save. Slice 4 teaches the SPA to read these params; until then the link
 * simply opens the app. Param names mirror the connect form's fields.
 */
export function buildK3sSetupUrl(spaBaseUrl: string, handler: K3sHandlerInput): string {
  const k = handler.config.kubernetes
  const url = new URL(spaBaseUrl)
  const params = url.searchParams
  params.set('infraSetup', 'local-k3s')
  params.set('label', k.label)
  params.set('apiServerUrl', k.apiServerUrl)
  params.set('namespaceTemplate', k.namespaceTemplate)
  params.set('hostTemplate', k.url.hostTemplate)
  if (k.insecureSkipTlsVerify) params.set('insecureSkipTlsVerify', '1')
  return url.toString()
}
