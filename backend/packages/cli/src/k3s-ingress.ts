import { connect } from 'node:net'
import {
  COMMAND_NOT_FOUND,
  COMMAND_TIMED_OUT,
  type Command,
  type HostShell,
  runCommand,
  type ShellResult,
} from './host-shell.js'

/**
 * Whether an environment URL derived from an ingress HOST TEMPLATE can actually be served, which
 * takes two independent things and not one:
 *
 *   1. an ingress CONTROLLER inside the cluster (an `IngressClass` is its observable trace), and
 *   2. a HOST PORT published into it, because every local distribution runs the cluster inside
 *      Docker and forwards only the ports it was asked for at create time.
 *
 * Both were previously assumed. `cat-factory k3s` printed its nip.io host template as wired
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
 * The host the port probe connects to.
 *
 * Loopback directly, rather than a sample hostname, which keeps this probe answering the PORT
 * question alone. That is still the right split, but the reason written here used to be that
 * `nip.io` maps `<anything>.127.0.0.1.nip.io` to loopback, and **that is false**: these resolvers
 * answer from the LEFTMOST four-octet run in a name and read `-` and `.` alike, so a prefix
 * ending in a separator plus digits resolves somewhere else entirely
 * (`cf-env-api-5.127.0.0.1.nip.io` is `5.127.0.0`). Resolving a sample here would therefore prove
 * nothing about the template a workspace actually configures, since the sample and the real
 * namespace differ in exactly the part that decides it.
 *
 * That half belongs to `describeWildcardDnsShift` in `@cat-factory/contracts`, which grades the
 * rendered host and which the environment provider refuses a provision on. See
 * `backend/docs/local-k3s-environments.md`.
 */
const INGRESS_PROBE_HOST = '127.0.0.1'

/**
 * The ingress HOST template, with no port in it. It is deliberately portless: the rendered value
 * is also the Ingress `spec.rules[].host` a service's manifests declare, and Kubernetes rejects a
 * `host` carrying a port. A non-default host port travels as the URL source's own `port` field
 * instead (see {@link ingressUrlPort}).
 *
 * **`{{namespace}}`, never `{{branch}}`**, which is what this used to write. A branch is
 * `cat-factory/<taskId>`: the `/` ends the host and turns everything after it into a PATH, so the
 * URL `http://cat-factory/task_….127.0.0.1.nip.io` names the bare host `cat-factory` and reaches
 * nothing, while an Ingress declaring that `host` is refused by the apiserver outright. The
 * namespace is the one per-PR value the platform has already sanitized to a single RFC1123 label,
 * and it composes cleanly with {@link DEFAULT_NAMESPACE_TEMPLATE}, whose rendered `pr<n>` keeps
 * the name carrying exactly one address (see `backend/docs/local-k3s-environments.md`).
 */
export const INGRESS_HOST_TEMPLATE = '{{namespace}}.127.0.0.1.nip.io'

/** The container port an ingress controller serves plain HTTP on (Traefik `web`, nginx `http`). */
export const INGRESS_CONTAINER_HTTP_PORT = 80

/** What a TCP connect attempt established. `unknown` is NOT `closed`: see {@link classifyIngress}. */
export type PortState = 'open' | 'closed' | 'unknown'

/** Which half of the ingress path is missing. Two halves, two different fixes. */
export type IngressGap = 'controller' | 'hostPort'

/**
 * WHY a probe could not answer. Four causes that need four different things done about them, kept
 * apart rather than folded into one "could not read the cluster": telling an operator with no
 * `kubectl` on PATH to "re-run once the cluster has settled" is advice for a problem they do not
 * have.
 */
type IngressProbeCause =
  | 'kubectl-missing'
  | 'cluster-unreachable'
  | 'cluster-refused'
  | 'unparseable'
  | 'host-port-filtered'

/**
 * What established that the answering host port belongs to THIS cluster.
 *
 * A TCP connect proves only that something listens: an unrelated web server on port 80 answers it
 * exactly as an ingress controller does, which is how a cluster with no published port could be
 * reported as ready. `cluster` means the container runtime confirmed the cluster publishes its
 * controller entrypoint on that host port; `unattributed` means the port answers and the check
 * could not run, which the summary says out loud rather than claiming the stronger fact.
 */
type PortAttribution = 'cluster' | 'unattributed'

/**
 * The three-state verdict. `unknown` is its own state rather than folded into `missing` for the
 * reason the acceptance suite's `preflight.ts` states: a probe that could not read an answer has
 * not established the negative either, and reporting one as the other sends an operator to fix a
 * cluster that was fine.
 */
export type IngressReadiness =
  | { status: 'ready'; port: number; controller: string; attribution: PortAttribution }
  | {
      status: 'missing'
      port: number
      gaps: readonly IngressGap[]
      /**
       * The host port the cluster DOES publish its controller on, when the runtime reported one
       * that is not the requested port. It turns "nothing serves 8080" into "the cluster serves
       * 18080", which is a different (and much shorter) fix.
       */
      publishedOn?: number
    }
  | { status: 'unknown'; port: number; cause: IngressProbeCause; probeFailure: string }

/**
 * The outcome of reading the cluster's `IngressClass` list: the names, or the CAUSE that stopped
 * it. A bare `null` for "no answer" is what collapsed a missing binary, an unreachable apiserver,
 * an RBAC refusal and a garbled payload into one message.
 */
export type IngressClassRead =
  | { ok: true; controllers: readonly string[] }
  | { ok: false; cause: IngressProbeCause; detail: string }

/** Whether the cluster publishes its controller entrypoint on the host, and where. */
export type PortPublication =
  | { checked: true; hostPorts: readonly number[] }
  /** The check could not run (no such container, no Docker, not a Docker-hosted cluster). */
  | { checked: false }

/** The raw facts {@link classifyIngress} reduces. Kept as plain data so the reduction is pure. */
export interface IngressFacts {
  port: number
  classes: IngressClassRead
  hostPort: PortState
  publication: PortPublication
}

// ---------------------------------------------------------------------------
// Pure planners + reduction: no shell-out, no sockets, so unit-testable alone.
// ---------------------------------------------------------------------------

/** `kubectl get ingressclass -o json`, targeting `context` when one is supplied. */
export function listIngressClassesCommand(context?: string): Command {
  const args = ['get', 'ingressclass', '-o', 'json', '--request-timeout=5s']
  return { cmd: 'kubectl', args: context ? [...args, '--context', context] : args }
}

/**
 * `docker port <cluster container>`: every host port the cluster's own container forwards. This is
 * the ONLY check that attributes an answering host port to the cluster rather than to whatever
 * else may be bound there, and it is the same one used by hand to establish that a default k3d
 * create publishes nothing but the apiserver.
 *
 * The container is the one each distribution puts the forward on: k3d's load balancer, kind's
 * control-plane node. The whole table is asked for rather than one port, because a container that
 * forwards NOTHING answers that with an empty success, where naming the port makes the same
 * cluster fail exactly as an unknown container does.
 */
export function publishedPortsCommand(runtime: 'k3d' | 'kind', clusterName: string): Command {
  const container =
    runtime === 'k3d' ? `k3d-${clusterName}-serverlb` : `${clusterName}-control-plane`
  return { cmd: 'docker', args: ['port', container] }
}

/**
 * Host ports mapped to the ingress container port, out of `docker port` output
 * (`80/tcp -> 0.0.0.0:18080`, one mapping per line). Reads the text after the LAST colon so an
 * IPv6 bind address (`[::]:18080`) does not parse as the port.
 */
export function parsePublishedHostPorts(stdout: string): number[] {
  const ports = new Set<number>()
  for (const line of stdout.split('\n')) {
    const [containerPort, hostAddress] = line.split('->').map((part) => part.trim())
    if (containerPort !== `${INGRESS_CONTAINER_HTTP_PORT}/tcp` || !hostAddress) continue
    const port = Number(hostAddress.slice(hostAddress.lastIndexOf(':') + 1))
    if (Number.isInteger(port) && port > 0) ports.add(port)
  }
  return [...ports]
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

/** How much of a command's own error output a message carries before it stops being readable. */
const DETAIL_CAP = 300

/** The first line of a failure's output, capped, so a message names the cause it was given. */
function firstDetailLine(result: ShellResult): string {
  const raw = (result.stderr || result.stdout).trim().split('\n')[0]?.trim() ?? ''
  return raw.length > DETAIL_CAP ? `${raw.slice(0, DETAIL_CAP)}…` : raw
}

/**
 * Turn the `kubectl get ingressclass` result into a read outcome that NAMES its cause.
 *
 * The shell already distinguishes a missing binary from a watchdog kill from a real non-zero
 * exit, and the exit carries the apiserver's own words (an RBAC refusal, a bad context). Throwing
 * that away and reporting "could not read the cluster's IngressClasses" is the degrade-quietly
 * failure: four fixes, one message, and a remedy that fits none of them.
 */
export function readIngressClasses(result: ShellResult): IngressClassRead {
  if (result.code === COMMAND_NOT_FOUND) {
    return {
      ok: false,
      cause: 'kubectl-missing',
      detail: 'kubectl is not installed, or not on PATH',
    }
  }
  if (result.code === COMMAND_TIMED_OUT) {
    return {
      ok: false,
      cause: 'cluster-unreachable',
      detail: 'the apiserver did not answer before the probe timed out',
    }
  }
  if (result.code !== 0) {
    return {
      ok: false,
      cause: 'cluster-refused',
      detail: firstDetailLine(result) || `kubectl exited ${result.code}`,
    }
  }
  const controllers = parseIngressClasses(result.stdout)
  if (controllers === null) {
    return {
      ok: false,
      cause: 'unparseable',
      detail: 'kubectl answered with something this could not read as an IngressClass list',
    }
  }
  return { ok: true, controllers }
}

/**
 * Reduce the probed facts to one verdict.
 *
 * An UNREADABLE cluster is `unknown` outright: with no controller list, neither half is settled.
 * An EMPTY list is a definitive `missing`, even when the port probe could not tell, because a
 * cluster with no ingress controller cannot serve the URL whatever the host port does.
 *
 * The PUBLICATION check outranks the socket on the port half, in both directions: a runtime that
 * reports the cluster forwarding no such host port makes an answering socket somebody ELSE'S
 * listener (the case that used to read as ready), and one that reports the forward makes an
 * answering socket attributable to the cluster rather than merely coincident with it.
 */
export function classifyIngress(facts: IngressFacts): IngressReadiness {
  const { port, classes, hostPort, publication } = facts
  if (!classes.ok) {
    return {
      status: 'unknown',
      port,
      cause: classes.cause,
      probeFailure: classes.detail,
    }
  }
  const published = publication.checked ? publication.hostPorts.includes(port) : undefined
  const gaps: IngressGap[] = []
  if (classes.controllers.length === 0) gaps.push('controller')
  if (hostPort === 'closed' || published === false) gaps.push('hostPort')
  if (gaps.length > 0) {
    const elsewhere = publication.checked
      ? publication.hostPorts.find((p) => p !== port)
      : undefined
    return {
      status: 'missing',
      port,
      gaps,
      ...(published === false && elsewhere !== undefined ? { publishedOn: elsewhere } : {}),
    }
  }
  if (hostPort === 'unknown') {
    return {
      status: 'unknown',
      port,
      cause: 'host-port-filtered',
      probeFailure: `nothing answered on host port ${port} and the probe could not tell whether it is closed or filtered`,
    }
  }
  return {
    status: 'ready',
    port,
    controller: classes.controllers[0] ?? 'unknown',
    attribution: published === true ? 'cluster' : 'unattributed',
  }
}

/** Context the remedy lines are rendered from, so each names the operator's actual cluster. */
export interface IngressRemedyContext {
  /** The distribution behind the cluster when it is known: it changes the CONTROLLER remedy. */
  runtime?: 'k3d' | 'kind'
  /**
   * The command that rebuilds the cluster with the port published, when there IS one to give.
   *
   * Absent means no recreate line is printed at all, and that case is real: on the reuse path the
   * cluster may be one this CLI cannot name (a bare k3s service, a shared context), and
   * `--recreate` only ever targets a k3d/kind cluster it can name. Printing it anyway produced a
   * command the CLI itself refuses, which is worse than printing none.
   */
  recreateCommand?: string
}

/**
 * The remedy for each gap, rendered from what the probe just read.
 *
 * A missing HOST PORT has exactly one fix on every local distribution: neither k3d's `-p` nor
 * kind's `extraPortMappings` can be added to a cluster that already exists, so the cluster has to
 * be built again. That is why a recreate is named here rather than a `docker` incantation that
 * does not work.
 */
export function ingressRemedies(
  readiness: IngressReadiness,
  context: IngressRemedyContext = {},
): string[] {
  const { runtime, recreateCommand } = context
  if (readiness.status === 'ready') return []
  if (readiness.status === 'unknown') return [...unknownRemedies(readiness), URL_SOURCE_ALTERNATIVE]

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
      readiness.publishedOn !== undefined
        ? `The cluster publishes its ingress controller on host port ${readiness.publishedOn}, not ${readiness.port}. Re-run with \`--ingress-port ${readiness.publishedOn}\` to use it as it is.`
        : `Nothing on the host serves port ${readiness.port} for this cluster. A published host port cannot be added to an existing k3d/kind cluster, so the cluster has to be created again:`,
    )
    if (readiness.publishedOn === undefined) {
      lines.push(
        recreateCommand
          ? `  ${recreateCommand}`
          : 'This command can only rebuild a k3d/kind cluster it can name, which this is not, so re-create it with the tool that made it, publishing the host port into the ingress controller.',
      )
    }
  }
  lines.push(URL_SOURCE_ALTERNATIVE)
  return lines
}

/** The fix that needs no cluster change at all, and therefore applies to every negative verdict. */
const URL_SOURCE_ALTERNATIVE =
  'Or leave ingress alone and switch the connect form\'s "Environment URL source" to "Service status", naming the Service your manifests expose.'

/** One remedy per {@link IngressProbeCause}, because each cause needs a different thing done. */
function unknownRemedies(readiness: Extract<IngressReadiness, { status: 'unknown' }>): string[] {
  const byHand = `Check it by hand: \`kubectl get ingressclass\` and \`curl -sv http://cat-factory-probe.127.0.0.1.nip.io:${readiness.port}/\`.`
  switch (readiness.cause) {
    case 'kubectl-missing':
      return [
        'Install `kubectl` (or put it on PATH) and re-run `cat-factory k3s`: without it nothing can read what the cluster runs.',
      ]
    case 'cluster-unreachable':
      return [
        'The apiserver did not answer. Check the cluster is up and the context points at it (`kubectl cluster-info`), then re-run `cat-factory k3s`.',
        byHand,
      ]
    case 'cluster-refused':
      return [
        `The cluster refused the read: ${readiness.probeFailure}. If that is an RBAC refusal, use a context allowed to list ingressclasses; then re-run \`cat-factory k3s\`.`,
        byHand,
      ]
    case 'unparseable':
      return [`Read it by hand: \`kubectl get ingressclass -o json\`.`]
    case 'host-port-filtered':
      return [
        `Nothing answered on host port ${readiness.port}, and a dropped packet is not a closed port, so this is undecided rather than missing. Check what is bound there (a firewall silently dropping the connection looks the same), then re-run \`cat-factory k3s\`.`,
        byHand,
      ]
    default:
      return refuseUnknownCause(readiness.cause)
  }
}

/**
 * A cause outside {@link IngressProbeCause}. The `never` parameter keeps the switch above total at
 * COMPILE time (a new cause with no remedy stops building) while still refusing a value the union
 * never had, rather than falling off the end and rendering an empty remedy list.
 */
function refuseUnknownCause(cause: never): never {
  throw new Error(`Unhandled ingress probe cause '${String(cause)}'`)
}

/**
 * The `hostTemplate` an `ingressTemplate` URL source should carry for a verified ingress, or
 * `null` when the ingress was not established.
 *
 * Always PORTLESS. The rendered value is the Ingress `host` a service's manifests declare, and
 * Kubernetes rejects a `host` with a port in it, so a non-default port travels as the URL source's
 * own `port` field ({@link ingressUrlPort}) instead of being smuggled into the host string.
 */
export function ingressHostTemplate(
  readiness: Extract<IngressReadiness, { status: 'ready' }>,
): string
export function ingressHostTemplate(readiness: IngressReadiness): string | null
export function ingressHostTemplate(readiness: IngressReadiness): string | null {
  return readiness.status === 'ready' ? INGRESS_HOST_TEMPLATE : null
}

/**
 * The `port` an `ingressTemplate` URL source should carry: the verified host port when it is not
 * the scheme's default, else `null` (the derivation composes `scheme://host` with no port).
 */
export function ingressUrlPort(readiness: IngressReadiness): number | null {
  if (readiness.status !== 'ready') return null
  return readiness.port === DEFAULT_INGRESS_PORT ? null : readiness.port
}

// ---------------------------------------------------------------------------
// Probe: the shell + socket halves, behind injectable seams.
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
  /**
   * The clock the wait is measured against (default `Date.now`). Injected because the budget is
   * WALL CLOCK: charging only the sleeps let each attempt's own cost (a 2s port timeout plus a 5s
   * apiserver request) ride for free, so a documented 90s wait ran for minutes.
   */
  now?: () => number
}

/** How long a freshly created cluster is given to bring its bundled controller up. */
export const INGRESS_SETTLE_WAIT_MS = 90_000

const ATTEMPT_INTERVAL_MS = 2_000
const PORT_PROBE_TIMEOUT_MS = 2_000
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Which cluster the publication check reads, when the CLI can name one. */
export interface IngressProbeCluster {
  runtime: 'k3d' | 'kind'
  clusterName: string
}

/**
 * Probe every half and reduce, retrying while `waitMs` of WALL CLOCK remains.
 *
 * The wait exists because a k3d cluster's bundled Traefik is installed by a Job that completes
 * ~20-30s AFTER `k3d cluster create` returns: probing once, immediately, would report a
 * definitive `missing` for a cluster that is merely still starting, which is the same class of
 * lie as the promise this replaces. A settled cluster answers on the first attempt, so the wait
 * costs nothing on the reuse path, where callers pass 0.
 *
 * The budget covers the attempts as well as the gaps between them, so a run whose every probe is
 * slow gives up on time rather than multiplying the deadline by the cost of an attempt.
 */
export async function probeIngress(
  deps: IngressProbeDeps,
  options: { context?: string; port: number; waitMs?: number; cluster?: IngressProbeCluster },
): Promise<IngressReadiness> {
  const sleep = deps.sleep ?? realSleep
  const now = deps.now ?? Date.now
  const deadline = now() + (options.waitMs ?? 0)
  for (;;) {
    const [classes, hostPort, publication] = await Promise.all([
      runCommand(deps.shell, listIngressClassesCommand(options.context)),
      deps.tcp.probe(INGRESS_PROBE_HOST, options.port, PORT_PROBE_TIMEOUT_MS),
      readPortPublication(deps.shell, options.cluster),
    ])
    const last = classifyIngress({
      port: options.port,
      classes: readIngressClasses(classes),
      hostPort,
      publication,
    })
    if (last.status === 'ready' || now() + ATTEMPT_INTERVAL_MS > deadline) return last
    await sleep(ATTEMPT_INTERVAL_MS)
  }
}

/**
 * Ask the container runtime which host ports the cluster forwards its controller entrypoint to.
 *
 * Any failure is `checked: false`, never "publishes nothing": the container may be named
 * differently (a `--no-lb` k3d cluster has no load balancer at all), Docker may not be the
 * runtime, or there may be no Docker. Reading a failure as a definitive negative would send an
 * operator to rebuild a cluster whose port was fine.
 */
async function readPortPublication(
  shell: HostShell,
  cluster: IngressProbeCluster | undefined,
): Promise<PortPublication> {
  if (!cluster) return { checked: false }
  const result = await runCommand(
    shell,
    publishedPortsCommand(cluster.runtime, cluster.clusterName),
  )
  if (result.code !== 0) return { checked: false }
  return { checked: true, hostPorts: parsePublishedHostPorts(result.stdout) }
}
