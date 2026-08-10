import { connect } from 'node:net'
import { type Command, type HostShell } from './host-shell.js'

/**
 * Whether an environment URL derived from an ingress HOST TEMPLATE can actually be served, which
 * takes two independent things and not one:
 *
 *   1. an ingress CONTROLLER inside the cluster (an `IngressClass` is its observable trace), and
 *   2. a HOST PORT published into it, because every local distribution runs the cluster inside
 *      Docker and forwards only the ports it was asked for at create time.
 *
 * Both were previously assumed. `cat-factory k3s` printed `{{branch}}.127.0.0.1.nip.io` as wired
 * on every path, including a reused cluster it had never looked at, and the failure landed at the
 * `tester` step against a URL that answered nothing: environment readiness is WORKLOAD readiness,
 * so provisioning still reported success.
 */

/**
 * Default host port published into the ingress controller's plain-HTTP entrypoint.
 *
 * ONE port is published and it maps to the controller's plain-HTTP entrypoint, so `http` is the
 * scheme that port serves and the only one the CLI can claim. Publishing the TLS entrypoint
 * instead would trade a connection error for a CERTIFICATE error, because a local ingress
 * controller serves a self-signed default cert: a worse version of the failure this module exists
 * to remove, since it surfaces at the tester rather than here.
 */
export const DEFAULT_INGRESS_PORT = 80

/**
 * The host the rendered template resolves to. `nip.io` is wildcard DNS that maps
 * `<anything>.127.0.0.1.nip.io` to loopback with no local DNS setup, so the port probe below
 * targets loopback directly rather than resolving a sample hostname.
 */
export const INGRESS_PROBE_HOST = '127.0.0.1'

/** The container port an ingress controller serves plain HTTP on (Traefik `web`, nginx `http`). */
export const INGRESS_CONTAINER_HTTP_PORT = 80

/** What a TCP connect attempt established. `unknown` is NOT `closed`: see {@link classifyIngress}. */
export type PortState = 'open' | 'closed' | 'unknown'

/** Which half of the ingress path is missing. Two halves, two different fixes. */
export type IngressGap = 'controller' | 'hostPort'

/**
 * The three-state verdict. `unknown` is its own state rather than folded into `missing` for the
 * reason the acceptance suite's `preflight.ts` states: a probe that could not read an answer has
 * not established the negative either, and reporting one as the other sends an operator to fix a
 * cluster that was fine.
 */
export type IngressReadiness =
  | { status: 'ready'; port: number; controller: string }
  | { status: 'missing'; port: number; gaps: readonly IngressGap[] }
  | { status: 'unknown'; port: number; probeFailure: string }

/** The raw facts {@link classifyIngress} reduces. Kept as plain data so the reduction is pure. */
export interface IngressFacts {
  port: number
  /** IngressClass controller names; `null` ⇒ the cluster read failed or was unparseable. */
  controllers: readonly string[] | null
  hostPort: PortState
}

// ---------------------------------------------------------------------------
// Pure planners + reduction — no shell-out, no sockets, so unit-testable alone.
// ---------------------------------------------------------------------------

/** `kubectl get ingressclass -o json`, targeting `context` when one is supplied. */
export function listIngressClassesCommand(context?: string): Command {
  const args = ['get', 'ingressclass', '-o', 'json', '--request-timeout=5s']
  return { cmd: 'kubectl', args: context ? [...args, '--context', context] : args }
}

/**
 * Controller names out of a `kubectl get ingressclass -o json` payload (an `items` list).
 * Returns `null` for anything unparseable, which the reduction reports as `unknown` rather than
 * as an absent controller.
 */
export function parseIngressClasses(stdout: string): string[] | null {
  try {
    const parsed = JSON.parse(stdout) as { items?: unknown }
    if (!Array.isArray(parsed.items)) return null
    return parsed.items
      .map((item) => {
        const spec = (item as { spec?: { controller?: unknown } } | null)?.spec
        const name = (item as { metadata?: { name?: unknown } } | null)?.metadata?.name
        if (typeof spec?.controller === 'string' && spec.controller.length > 0)
          return spec.controller
        return typeof name === 'string' && name.length > 0 ? name : undefined
      })
      .filter((c): c is string => c !== undefined)
  } catch {
    return null
  }
}

/**
 * Reduce the two probed facts to one verdict.
 *
 * An UNREADABLE cluster is `unknown` outright: with no controller list, neither half is settled.
 * An EMPTY list is a definitive `missing`, even when the port probe could not tell, because a
 * cluster with no ingress controller cannot serve the URL whatever the host port does. Only the
 * remaining case (a controller is present and the port is undecided) is `unknown` on the port.
 */
export function classifyIngress(facts: IngressFacts): IngressReadiness {
  const { port, controllers, hostPort } = facts
  if (controllers === null) {
    return {
      status: 'unknown',
      port,
      probeFailure: "could not read the cluster's IngressClasses",
    }
  }
  const gaps: IngressGap[] = []
  if (controllers.length === 0) gaps.push('controller')
  if (hostPort === 'closed') gaps.push('hostPort')
  if (gaps.length > 0) return { status: 'missing', port, gaps }
  if (hostPort === 'unknown') {
    return {
      status: 'unknown',
      port,
      probeFailure: `nothing answered on host port ${port} and the probe could not tell whether it is closed or filtered`,
    }
  }
  return { status: 'ready', port, controller: controllers[0] ?? 'unknown' }
}

/** Context the remedy lines are rendered from, so each names the operator's actual cluster. */
export interface IngressRemedyContext {
  runtime?: 'k3d' | 'kind'
  clusterName?: string
}

/**
 * The remedy for each gap, rendered from what the probe just read.
 *
 * A missing HOST PORT has exactly one fix on every local distribution: neither k3d's `-p` nor
 * kind's `extraPortMappings` can be added to a cluster that already exists, so the cluster has to
 * be built again. That is why `--recreate` is named here rather than a `docker` incantation that
 * does not work.
 */
export function ingressRemedies(
  readiness: IngressReadiness,
  context: IngressRemedyContext = {},
): string[] {
  const { runtime, clusterName } = context
  const recreate = [
    'cat-factory k3s --recreate',
    runtime ? `--runtime ${runtime}` : '',
    clusterName ? `--cluster-name ${clusterName}` : '',
    `--ingress-port ${readiness.port}`,
  ]
    .filter((part) => part.length > 0)
    .join(' ')

  if (readiness.status === 'ready') return []
  if (readiness.status === 'unknown') {
    return [
      'Re-run `cat-factory k3s` once the cluster has settled to probe it again.',
      `Check it by hand: \`kubectl get ingressclass\` and \`curl -sv http://cat-factory-probe.127.0.0.1.nip.io:${readiness.port}/\`.`,
    ]
  }

  const lines: string[] = []
  if (readiness.gaps.includes('controller')) {
    lines.push(
      runtime === 'kind'
        ? 'kind ships no ingress controller. Install one, e.g. `kubectl apply -f https://kind.sigs.k8s.io/examples/ingress/deploy-ingress-nginx.yaml`, then wait for it to be Ready.'
        : 'The cluster has no ingress controller. A default k3d/k3s cluster installs Traefik unless it was created with `--disable=traefik`; install an ingress controller, or build the cluster again without that flag.',
    )
  }
  if (readiness.gaps.includes('hostPort')) {
    lines.push(
      `Nothing on the host serves port ${readiness.port}. A published host port cannot be added to an existing k3d/kind cluster, so the cluster has to be created again:`,
      `  ${recreate}`,
    )
  }
  lines.push(
    'Or leave ingress alone and switch the connect form\'s "Environment URL source" to "Service status", naming the Service your manifests expose.',
  )
  return lines
}

/**
 * The `hostTemplate` an `ingressTemplate` URL source should carry for a verified ingress, or
 * `null` when the ingress was not established. A non-default port rides IN the host, because the
 * derivation composes `scheme://host` and has nowhere else to put it.
 */
export function ingressHostTemplate(readiness: IngressReadiness): string | null {
  if (readiness.status !== 'ready') return null
  return readiness.port === DEFAULT_INGRESS_PORT
    ? '{{branch}}.127.0.0.1.nip.io'
    : `{{branch}}.127.0.0.1.nip.io:${readiness.port}`
}

// ---------------------------------------------------------------------------
// Probe — the shell + socket halves, behind injectable seams.
// ---------------------------------------------------------------------------

/**
 * TCP reachability seam, the sibling of {@link HostShell}: the ingress half that no `kubectl`
 * command can answer is whether the HOST forwards a port into the cluster.
 */
export interface TcpProbe {
  /** Never rejects: an unreachable port is a {@link PortState}, not an exception. */
  probe(host: string, port: number, timeoutMs: number): Promise<PortState>
}

/**
 * The real, socket-backed probe.
 *
 * `ECONNREFUSED` is the one error that settles the negative: something answered the SYN with a
 * reset, so nothing is listening. A timeout or any other error leaves it undecided (a firewall
 * drops packets silently), and the reduction above keeps that distinct.
 */
export function createNodeTcpProbe(): TcpProbe {
  return {
    probe(host, port, timeoutMs) {
      return new Promise<PortState>((resolve) => {
        let settled = false
        const finish = (state: PortState): void => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve(state)
        }
        const socket = connect({ host, port })
        socket.setTimeout(timeoutMs)
        socket.on('connect', () => finish('open'))
        socket.on('timeout', () => finish('unknown'))
        socket.on('error', (err: NodeJS.ErrnoException) =>
          finish(err.code === 'ECONNREFUSED' ? 'closed' : 'unknown'),
        )
      })
    },
  }
}

/** Injectable dependencies for {@link probeIngress}. */
export interface IngressProbeDeps {
  shell: HostShell
  tcp: TcpProbe
  /** Delay between attempts (real setTimeout; a no-op in tests). */
  sleep?: (ms: number) => Promise<void>
}

/** How long a freshly created cluster is given to bring its bundled controller up. */
export const INGRESS_SETTLE_WAIT_MS = 90_000

const ATTEMPT_INTERVAL_MS = 2_000
const PORT_PROBE_TIMEOUT_MS = 2_000
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Probe both halves and reduce, retrying while `waitMs` remains.
 *
 * The wait exists because a k3d cluster's bundled Traefik is installed by a Job that completes
 * ~20-30s AFTER `k3d cluster create` returns: probing once, immediately, would report a
 * definitive `missing` for a cluster that is merely still starting, which is the same class of
 * lie as the promise this replaces. A settled cluster answers on the first attempt, so the wait
 * costs nothing on the reuse path, where callers pass 0.
 */
export async function probeIngress(
  deps: IngressProbeDeps,
  options: { context?: string; port: number; waitMs?: number },
): Promise<IngressReadiness> {
  const sleep = deps.sleep ?? realSleep
  const deadline = options.waitMs ?? 0
  let waited = 0
  let last: IngressReadiness
  for (;;) {
    const [classes, hostPort] = await Promise.all([
      deps.shell.run('kubectl', listIngressClassesCommand(options.context).args),
      deps.tcp.probe(INGRESS_PROBE_HOST, options.port, PORT_PROBE_TIMEOUT_MS),
    ])
    last = classifyIngress({
      port: options.port,
      controllers: classes.code === 0 ? parseIngressClasses(classes.stdout) : null,
      hostPort,
    })
    if (last.status === 'ready' || waited >= deadline) return last
    await sleep(ATTEMPT_INTERVAL_MS)
    waited += ATTEMPT_INTERVAL_MS
  }
}
