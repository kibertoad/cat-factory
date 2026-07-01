import type { SecretResolver } from '@cat-factory/kernel'
import { KUBERNETES_TOKEN_KEY } from './kubernetes.logic.js'

// Shared kube-apiserver HTTP client. Both the native Kubernetes RUNNER backend
// (per-run pods over the pod-proxy) and the Kubernetes ENVIRONMENT backend (apply
// manifests into a per-PR namespace) talk to the apiserver the same way: a Bearer
// ServiceAccount token + an optional custom-CA / insecure-skip TLS dispatcher. This
// client owns that mechanism so the two transports don't duplicate it.
//
// The undici Agent is loaded lazily (Node only) so the Worker bundle never pulls in
// `undici`; on a runtime without it a custom-CA/insecure config fails clearly. The
// Agent is cached at MODULE scope keyed by the CA/insecure pair (the wiring builds a
// fresh transport on every dispatch/poll resolve, so a per-instance cache would
// create — and abandon — one TLS connection pool per tick, defeating keep-alive).

/** The minimal connection shape both the runner + env K8s configs satisfy. */
export interface KubernetesClientConfig {
  apiServerUrl: string
  caCertPem?: string
  insecureSkipTlsVerify?: boolean
}

/**
 * Resolves the Bearer token used to authenticate to the apiserver. The default source is a
 * static ServiceAccount token read synchronously from the secret bundle, but a backend can
 * inject an ASYNC provider that mints a short-lived token per call — this is the seam the AWS
 * EKS backend (`@cat-factory/eks`) uses to supply a SigV4-presigned STS token (which expires,
 * so it can't be a stored static secret). Keeping this generic and AWS-free lets the whole
 * Kubernetes transport/provider stack be reused verbatim behind a different auth scheme.
 */
export type KubernetesTokenProvider = () => string | Promise<string>

export class KubernetesApiClient {
  constructor(
    private readonly config: KubernetesClientConfig,
    private readonly resolveSecret: SecretResolver,
    /** Secret-bundle key the Bearer token is read from (default `apiToken`). */
    private readonly tokenKey: string = KUBERNETES_TOKEN_KEY,
    /**
     * Optional async token source. When supplied it REPLACES the static `resolveSecret(tokenKey)`
     * lookup (the EKS minting path); when omitted the client behaves exactly as before.
     */
    private readonly tokenProvider?: KubernetesTokenProvider,
  ) {}

  /**
   * A single apiserver request. `body` is JSON-encoded for non-GET/DELETE unless a
   * `contentType` override is supplied (server-side apply uses
   * `application/apply-patch+yaml` with a raw JSON body — JSON is valid YAML, and that
   * media type is accepted by every apiserver ≥1.22). Returns the raw Response so the
   * caller maps status codes (404/409/…) to its own semantics.
   */
  async fetch(
    method: string,
    url: string,
    body: unknown,
    timeoutMs: number,
    contentType?: string,
  ): Promise<Response> {
    const token = this.tokenProvider
      ? await this.tokenProvider()
      : this.resolveSecret(this.tokenKey)
    if (!token) throw new Error(`Missing Kubernetes ServiceAccount token ('${this.tokenKey}')`)
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    }
    let payload: string | undefined
    if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
      payload = typeof body === 'string' ? body : JSON.stringify(body)
      headers['content-type'] = contentType ?? 'application/json'
    }
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    }
    const dispatcher = await this.tlsDispatcher()
    if (dispatcher) init.dispatcher = dispatcher
    return fetch(url, init)
  }

  private async tlsDispatcher(): Promise<unknown> {
    if (!this.config.caCertPem && !this.config.insecureSkipTlsVerify) return undefined
    const key = `${this.config.insecureSkipTlsVerify ? 'insecure' : 'verify'}:${this.config.caCertPem ?? ''}`
    const existing = tlsDispatcherCache.get(key)
    if (existing) return existing
    // Variable specifier so bundlers don't statically resolve `undici`.
    const moduleName = 'undici'
    const undici = (await import(moduleName).catch(() => null)) as {
      Agent: new (opts: unknown) => unknown
    } | null
    if (!undici) {
      throw new Error(
        'Kubernetes custom CA / insecure TLS requires the Node runtime (undici is unavailable).',
      )
    }
    const agent = new undici.Agent({
      connect: {
        ca: this.config.caCertPem,
        rejectUnauthorized: !this.config.insecureSkipTlsVerify,
      },
    })
    tlsDispatcherCache.set(key, agent)
    return agent
  }
}

/** Module-scoped undici Agent cache, keyed by the CA/insecure pair (see tlsDispatcher). */
const tlsDispatcherCache = new Map<string, unknown>()

/** Read a response body defensively, length-capped, for error messages. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return '(no body)'
  }
}
