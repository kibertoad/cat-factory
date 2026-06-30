import type { UrlSourceSpec } from './job.js'

// Resolve the environment URL once the manifests are applied. Only the STATUS-backed
// sources reach the harness: each needs a LIVE cluster read (the LoadBalancer / Gateway
// address the apiserver assigns after apply), which only this container can do during the
// async job. `ingressTemplate` is resolved backend-side (no cluster needed) and returns
// null here. Mirrors the native KubernetesEnvironmentProvider's status-URL logic, but
// reads via `kubectl get -o json` instead of raw apiserver fetches.

/** Read JSON from `kubectl get …`; injected so the pure derivation is unit-testable. */
export type KubectlGetJson = (args: string[]) => Promise<unknown>

interface LoadBalancerStatus {
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } }
}

interface GatewayStatus {
  status?: { addresses?: { value?: string }[] }
  spec?: { listeners?: { hostname?: string }[] }
}

interface HttpRoute {
  spec?: { hostnames?: string[]; parentRefs?: { name?: string }[] }
}

interface ListResponse {
  items?: unknown[]
}

/** First LoadBalancer address (ip or hostname) off a Service/Ingress status. */
export function extractLoadBalancerAddress(obj: unknown): string | null {
  const ingress = (obj as LoadBalancerStatus | null)?.status?.loadBalancer?.ingress
  if (!Array.isArray(ingress) || ingress.length === 0) return null
  const first = ingress[0]
  return first?.hostname || first?.ip || null
}

/** First Gateway-API `Gateway` address off its `.status.addresses[]`. */
export function extractGatewayAddress(obj: unknown): string | null {
  const addresses = (obj as GatewayStatus | null)?.status?.addresses
  if (!Array.isArray(addresses) || addresses.length === 0) return null
  return addresses[0]?.value || null
}

/** Compose `scheme://host[:port]` from a resolved host, or null when host is empty. */
export function buildUrl(
  host: string | null,
  scheme: 'http' | 'https' | undefined,
  port?: number,
): string | null {
  if (!host) return null
  const s = scheme ?? 'https'
  return port ? `${s}://${host}:${port}` : `${s}://${host}`
}

function firstItem(obj: unknown): unknown {
  const items = (obj as ListResponse | null)?.items
  return Array.isArray(items) && items.length > 0 ? items[0] : null
}

/**
 * Resolve the live URL for a status-backed source by reading the cluster. Returns null
 * until the address/host is assigned (the backend keeps polling), or for `ingressTemplate`
 * (resolved backend-side).
 */
export async function resolveLiveUrl(
  url: UrlSourceSpec,
  namespace: string,
  getJson: KubectlGetJson,
): Promise<string | null> {
  const ns = ['-n', namespace, '-o', 'json']
  switch (url.source) {
    case 'ingressTemplate':
      return null
    case 'serviceStatus': {
      const obj = await getJson(['get', 'service', url.serviceName, ...ns])
      return buildUrl(extractLoadBalancerAddress(obj), url.scheme, url.port)
    }
    case 'ingressStatus': {
      const obj = url.ingressName
        ? await getJson(['get', 'ingress', url.ingressName, ...ns])
        : firstItem(await getJson(['get', 'ingress', ...ns]))
      return buildUrl(extractLoadBalancerAddress(obj), url.scheme)
    }
    case 'gatewayStatus': {
      const obj = url.gatewayName
        ? await getJson(['get', 'gateway', url.gatewayName, ...ns])
        : firstItem(await getJson(['get', 'gateway', ...ns]))
      // Prefer a listener hostname (a real DNS name) over the raw LB address when present.
      const listenerHost = (obj as GatewayStatus | null)?.spec?.listeners?.find(
        (l) => l.hostname,
      )?.hostname
      return buildUrl(listenerHost || extractGatewayAddress(obj), url.scheme)
    }
    case 'httpRouteStatus': {
      const route = (
        url.httpRouteName
          ? await getJson(['get', 'httproute', url.httpRouteName, ...ns])
          : firstItem(await getJson(['get', 'httproute', ...ns]))
      ) as HttpRoute | null
      // A route hostname is the externally-meaningful host; fall back to the parent
      // Gateway's assigned address when the route declares no hostname.
      const hostname = route?.spec?.hostnames?.[0]
      if (hostname) return buildUrl(hostname, url.scheme)
      const parent = route?.spec?.parentRefs?.[0]?.name
      if (!parent) return null
      const gw = await getJson(['get', 'gateway', parent, ...ns])
      return buildUrl(extractGatewayAddress(gw), url.scheme)
    }
    default:
      return null
  }
}
