import type { SecretResolver } from '@cat-factory/kernel'
import { ValidationError } from '@cat-factory/kernel'
import {
  classifyServiceAccountToken,
  isFatalServiceAccountTokenProblem,
} from '@cat-factory/contracts'
import { KUBERNETES_TOKEN_KEY } from './kubernetes.logic.js'

// Shared kube-apiserver HTTP client. Both the native Kubernetes RUNNER backend
// (per-run pods over the pod-proxy) and the Kubernetes ENVIRONMENT backend (apply
// manifests into a per-PR namespace) talk to the apiserver the same way: a Bearer
// ServiceAccount token + an optional custom-CA / insecure-skip TLS dispatcher. This
// client owns that mechanism so the two transports don't duplicate it.
//
// `undici` is a RUNTIME dependency of this package (see {@link loadUndici}), loaded
// lazily through a variable specifier so the Worker bundle never pulls it in. The
// Agent is cached at MODULE scope keyed by the CA/insecure pair (the wiring builds a
// fresh transport on every dispatch/poll resolve, so a per-instance cache would
// create — and abandon — one TLS connection pool per tick, defeating keep-alive).
// The request that USES that Agent is dispatched by undici's own `fetch`, never the
// global one: see {@link KubernetesApiClient.tlsTransport}.

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
    const stored = this.tokenProvider
      ? await this.tokenProvider()
      : this.resolveSecret(this.tokenKey)
    // Trimmed HERE, not just inside the classifier. `classifyServiceAccountToken` judges the
    // TRIMMED value, on the stated premise that surrounding padding is stripped before use, so
    // this is the line that has to make that true. Left untrimmed, a token ending in a newline
    // passed the guard clean and then died in undici as `TypeError: Invalid header value`: the
    // exact failure the guard exists to replace, now with a guard that called the token fine.
    const token = stored?.trim()
    if (!token) throw new Error(`Missing Kubernetes ServiceAccount token ('${this.tokenKey}')`)
    // Refuse a token that cannot become a header BEFORE handing it to `fetch`. This is the one
    // boundary every apiserver call (env + runner, probe + provision) passes through, so it is
    // where the rule belongs. Left to undici the same paste fails as `TypeError: Invalid header
    // value`, with nothing naming the token, let alone the wrapped-terminal copy that caused it.
    // Only the IMPOSSIBLE problem is refused here; the merely-suspicious shapes are the connect
    // form's advisory, because a static-token apiserver's token is legitimately not a JWT.
    const problem = classifyServiceAccountToken(token)
    if (problem && isFatalServiceAccountTokenProblem(problem)) {
      throw new ValidationError(
        `The Kubernetes ServiceAccount token ('${this.tokenKey}') contains a space or line break, ` +
          'which a bearer token never does and an HTTP header cannot carry. It was most likely ' +
          'copied across a wrapped terminal line: re-copy it as a single unbroken line and save it again.',
        { reason: 'service_account_token_whitespace' },
      )
    }
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
    const tls = await this.tlsTransport()
    if (!tls) return fetch(url, init)
    init.dispatcher = tls.dispatcher
    return tls.fetch(url, init)
  }

  /**
   * The transport a custom-CA / insecure-skip config needs: an undici `Agent` carrying the TLS
   * options AND the `fetch` that dispatches through it. Undefined when the config needs neither,
   * in which case the caller uses the global `fetch` and undici is never loaded at all.
   *
   * **The two come from ONE undici instance, and that is the whole point of this method.** Node's
   * global `fetch` is implemented by the undici BUNDLED INTO NODE, and the request handler it
   * builds is that copy's internal shape; passing it a dispatcher from the userland `undici`
   * package makes one undici validate the other's handler. undici 8 dropped the legacy handler
   * interface that Node's bundled undici 7 still emits, so every apiserver call with a CA or a
   * skip-verify configured died before a socket was opened, as `fetch failed: invalid
   * onRequestStart method (UND_ERR_INVALID_ARG)`. That is indistinguishable, on a connect form,
   * from a cluster that is not answering, and it is exactly the config a k3s box needs, so k3s
   * could not be connected at all. undici's own `fetch` builds the handler its own `Agent`
   * expects, so the pair cannot drift again on either side's next major.
   */
  private async tlsTransport(): Promise<
    { fetch: UndiciModule['fetch']; dispatcher: unknown } | undefined
  > {
    if (!this.config.caCertPem && !this.config.insecureSkipTlsVerify) return undefined
    const undici = await loadUndici()
    const key = `${this.config.insecureSkipTlsVerify ? 'insecure' : 'verify'}:${this.config.caCertPem ?? ''}`
    let dispatcher = tlsDispatcherCache.get(key)
    if (!dispatcher) {
      dispatcher = new undici.Agent({
        connect: {
          ca: this.config.caCertPem,
          rejectUnauthorized: !this.config.insecureSkipTlsVerify,
        },
      })
      tlsDispatcherCache.set(key, dispatcher)
    }
    return { fetch: undici.fetch, dispatcher }
  }
}

/** The two undici entry points the custom-TLS path needs, typed structurally (dynamic import). */
interface UndiciModule {
  Agent: new (opts: unknown) => unknown
  fetch: (url: string, init: unknown) => Promise<Response>
}

/**
 * Load the userland `undici`, or throw a failure that names what could not be done and carries
 * WHY as its `cause`.
 *
 * The specifier is a variable so a bundler cannot statically resolve it: the Worker build must not
 * pull `undici` in, and no Worker reaches this line anyway, because the Cloudflare facade sets
 * `customTlsSupported: false` and a custom-TLS config is refused before it becomes a client.
 * Nothing memoises the import because the module loader already does: this is a cache lookup after
 * the first call.
 *
 * **The failure is reported, never guessed at.** `undici` is a runtime dependency of this package,
 * so on Node a load failure means a broken or pruned install; the message this replaced asserted
 * instead that the runtime was not Node, which is the one explanation that is almost always wrong
 * when an operator reads it. The load error rides along as `cause`, so
 * `describeConnectionFailure` renders it (scrubbed) into the detail the connect form shows.
 */
async function loadUndici(): Promise<UndiciModule> {
  const moduleName = 'undici'
  try {
    return (await import(moduleName)) as UndiciModule
  } catch (error) {
    throw new Error(
      // No trailing period: this message is read with the cause appended to it, which is where
      // `describeConnectionFailure` joins the chain with a colon.
      "Kubernetes custom CA / insecure TLS needs the 'undici' package, which this deployment could not load",
      { cause: error },
    )
  }
}

/** Module-scoped undici Agent cache, keyed by the CA/insecure pair (see tlsTransport). */
const tlsDispatcherCache = new Map<string, unknown>()

/** Read a response body defensively, length-capped, for error messages. */
export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return '(no body)'
  }
}
