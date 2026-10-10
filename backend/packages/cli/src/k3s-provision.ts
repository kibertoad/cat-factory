import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { type Command, type HostShell, runCommand, type ShellResult } from './host-shell.js'
import {
  DEFAULT_INGRESS_PORT,
  INGRESS_CONTAINER_HTTP_PORT,
  INGRESS_SETTLE_WAIT_MS,
  type IngressProbeCluster,
  type IngressReadiness,
  probeIngress,
  type TcpProbe,
} from './k3s-ingress.js'
import { type Io } from './io.js'
import { isLocalMachineHost } from './localHost.js'
import {
  type HostState,
  isRecreateOffer,
  type OfferId,
  RECREATE_OFFERS,
  recreateTargetForContext,
} from './k3s-probe.js'

/** The namespace + ServiceAccount + long-lived token Secret the guided setup creates. */
export const CAT_FACTORY_NAMESPACE = 'cat-factory'
export const SERVICE_ACCOUNT_NAME = 'cat-factory'
const TOKEN_SECRET_NAME = 'cat-factory-token'
/** The apiserver port k3d/kind is asked to publish (the kube default). */
const DEFAULT_API_PORT = 6443

/**
 * Watchdog budget (ms) for `k3d cluster create` / `kind create cluster`. These pull node images on
 * the first run and routinely take 30–90s, so they need far more than the {@link HostShell} default
 * (10s) — otherwise the watchdog SIGKILLs the create mid-flight and the whole create path fails.
 */
export const CLUSTER_CREATE_TIMEOUT_MS = 300_000

/** Watchdog budget (ms) for `k3d/kind cluster delete`, which tears down containers + volumes. */
const CLUSTER_DELETE_TIMEOUT_MS = 120_000

/**
 * The resolved local-k3s connection produced by provisioning: the apiserver URL read from the
 * kubeconfig plus the minted ServiceAccount token. Consumed by the hand-off (slice 3 builds the
 * `kubernetes` handler from it). `insecureSkipTlsVerify` is always true — a local k3s/k3d/kind
 * apiserver self-signs its cert.
 */
export interface ResolvedConnection {
  engine: 'local-k3s'
  /** The provisioned/created cluster name (create paths only; absent for reuse). */
  clusterName?: string
  /** The distribution the cluster was created/recreated with; absent when reusing a context. */
  runtime?: 'k3d' | 'kind'
  apiServerUrl: string
  apiToken: string
  insecureSkipTlsVerify: true
  /**
   * What the ingress probe ESTABLISHED, never what the distribution is assumed to do. Everything
   * downstream that would otherwise promise an ingress-derived environment URL (the printed
   * summary, the connect-form deep link) keys off this.
   */
  ingress: IngressReadiness
  /**
   * The cluster a `--recreate` could name, when there is one: the cluster this run built, or (on
   * the reuse path) the k3d/kind cluster the kubeconfig context resolves to. Absent when no such
   * target exists, and a remedy that would print a recreate has to WITHHOLD it then, because
   * `--recreate` refuses anything it cannot name.
   */
  recreateTarget?: { runtime: 'k3d' | 'kind'; clusterName: string }
}

/** Raised when a provisioning command fails; carries an actionable message (never the token). */
export class ProvisionError extends Error {}

/**
 * The reduced-privilege RBAC the local-k3s environment backend needs, applied via
 * `kubectl apply -f -` (idempotent). It grants the ServiceAccount:
 *   - cluster-wide `namespaces` create/delete (the ephemeral-env backend stands up one per PR),
 *   - the per-PR resource kinds the backend applies (the manifest allow-list), cluster-wide so
 *     they land in whichever per-PR namespace is created,
 *   - `pods` + `pods/proxy` (so the SAME token can also back the Kubernetes runner backend).
 * It deliberately does NOT bind `cluster-admin` (see docs/initiatives/local-k3s-guided-setup.md).
 * The cluster-scoped grant is required because per-PR namespaces don't exist yet when the token is
 * minted. A long-lived token Secret is created (k8s >= 1.24 no longer auto-creates one) and read
 * back rather than a short-lived `kubectl create token`.
 *
 * Credential-bearing kinds (`secrets`, `serviceaccounts`) are granted WITHOUT cluster-wide
 * `list`/`watch` — that would let the token enumerate and read every Secret (and thus every other
 * ServiceAccount token) in the cluster, a privilege-escalation path that would make this grant
 * effectively cluster-admin on a single-node cluster. Only single-object create/get/patch/delete
 * (by name) is granted — enough to deploy per-PR app config. (Residual: a `get` on a KNOWN secret
 * name in any namespace is still possible; acceptable for a local dev cluster, and the reason the
 * token must be kept private.)
 */
export const RBAC_MANIFEST = `apiVersion: v1
kind: Namespace
metadata:
  name: ${CAT_FACTORY_NAMESPACE}
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${SERVICE_ACCOUNT_NAME}
  namespace: ${CAT_FACTORY_NAMESPACE}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: cat-factory-env
rules:
  - apiGroups: ['']
    resources: ['namespaces']
    verbs: ['create', 'get', 'list', 'watch', 'delete']
  - apiGroups: ['']
    resources: ['services', 'configmaps', 'persistentvolumeclaims', 'pods']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
  - apiGroups: ['']
    resources: ['secrets', 'serviceaccounts']
    verbs: ['create', 'get', 'patch', 'update', 'delete']
  - apiGroups: ['']
    resources: ['pods/proxy']
    verbs: ['create', 'get']
  - apiGroups: ['apps']
    resources: ['deployments', 'statefulsets', 'replicasets']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
  - apiGroups: ['batch']
    resources: ['jobs']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
  - apiGroups: ['networking.k8s.io']
    resources: ['ingresses']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
  # READ-ONLY, and cluster-scoped because IngressClass is. The environment provider grades a
  # just-applied Ingress against this catalog before it will call a template-derived URL ready:
  # an Ingress naming a class the cluster does not run is accepted by the apiserver, watched by
  # nothing, and its URL never answers. Without this grant the read is refused and the check
  # stands down to the prior behaviour, so the grant is what makes it able to answer at all.
  - apiGroups: ['networking.k8s.io']
    resources: ['ingressclasses']
    verbs: ['get', 'list', 'watch']
  - apiGroups: ['gateway.networking.k8s.io']
    resources: ['gateways', 'httproutes']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cat-factory-env
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cat-factory-env
subjects:
  - kind: ServiceAccount
    name: ${SERVICE_ACCOUNT_NAME}
    namespace: ${CAT_FACTORY_NAMESPACE}
---
apiVersion: v1
kind: Secret
metadata:
  name: ${TOKEN_SECRET_NAME}
  namespace: ${CAT_FACTORY_NAMESPACE}
  annotations:
    kubernetes.io/service-account.name: ${SERVICE_ACCOUNT_NAME}
type: kubernetes.io/service-account-token
`

// ---------------------------------------------------------------------------
// Pure command planners — no shell-out, so they are unit-testable in isolation.
// ---------------------------------------------------------------------------

/**
 * `k3d cluster create <name> --api-port <p> -p <ingress>:80@loadbalancer`.
 *
 * The `-p` is the half that used to be missing, and it can only be supplied HERE: k3d forwards
 * exactly the host ports it was asked for when the load-balancer container was created, and
 * Docker cannot publish a new one onto a running container. A cluster created without it can
 * never serve an ingress-derived URL, however correct the rest of the configuration is.
 *
 * A default k3d cluster DOES bundle an ingress controller (k3s installs Traefik through a
 * HelmChart manifest, verified against k3d 5.7.5 / k3s v1.30.6), so the create path publishes a
 * port and installs nothing.
 */
export function k3dCreateCommand(
  name: string,
  apiPort: number = DEFAULT_API_PORT,
  ingressPort: number = DEFAULT_INGRESS_PORT,
): Command {
  return {
    cmd: 'k3d',
    args: [
      'cluster',
      'create',
      name,
      '--api-port',
      String(apiPort),
      '-p',
      `${ingressPort}:${INGRESS_CONTAINER_HTTP_PORT}@loadbalancer`,
    ],
    timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
  }
}

/**
 * The kind cluster config fed to `kind create cluster --config -`.
 *
 * Both settings are create-time-only and both are needed before any ingress controller can work:
 * `extraPortMappings` is kind's equivalent of k3d's `-p`, and `ingress-ready=true` is the node
 * label every published kind ingress recipe selects on.
 *
 * What this deliberately does NOT do is install a controller. kind, unlike k3d, ships none, and
 * the ways to get one (a third-party manifest fetched from the internet, or the separate
 * `cloud-provider-kind` host process) are both choices about what runs on the operator's machine
 * that a guided setup should not make silently. So the create path lays the irreversible half and
 * the probe then reports the controller as verified-missing with the exact command, which a
 * re-run turns into a verified-ready.
 */
export function kindClusterConfig(ingressPort: number = DEFAULT_INGRESS_PORT): string {
  return `kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    kubeadmConfigPatches:
      - |
        kind: InitConfiguration
        nodeRegistration:
          kubeletExtraArgs:
            node-labels: "ingress-ready=true"
    extraPortMappings:
      - containerPort: ${INGRESS_CONTAINER_HTTP_PORT}
        hostPort: ${ingressPort}
        protocol: TCP
`
}

/** `kind create cluster --name <name> --config -`, with the ingress config on stdin. */
export function kindCreateCommand(
  name: string,
  ingressPort: number = DEFAULT_INGRESS_PORT,
): Command {
  return {
    cmd: 'kind',
    args: ['create', 'cluster', '--name', name, '--config', '-'],
    input: kindClusterConfig(ingressPort),
    timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
  }
}

/**
 * The create command for either distribution, so every caller (the create path, the recreate leg,
 * and the printed guidance) issues the SAME line. The printed one used to be hand-written and had
 * therefore lost the `-p` publish flag, telling an operator to build exactly the cluster whose
 * missing host port the next run then asked them to recreate.
 */
export function clusterCreateCommand(
  runtime: 'k3d' | 'kind',
  name: string,
  ingressPort: number = DEFAULT_INGRESS_PORT,
): Command {
  return runtime === 'kind'
    ? kindCreateCommand(name, ingressPort)
    : k3dCreateCommand(name, DEFAULT_API_PORT, ingressPort)
}

/** `k3d cluster delete <name>` / `kind delete cluster --name <name>`. Destroys the cluster. */
export function clusterDeleteCommand(runtime: 'k3d' | 'kind', name: string): Command {
  return {
    cmd: runtime,
    args: runtime === 'k3d' ? ['cluster', 'delete', name] : ['delete', 'cluster', '--name', name],
    timeoutMs: CLUSTER_DELETE_TIMEOUT_MS,
  }
}

/** Namespaces on the target context, read so a destructive prompt can name what is on it. */
function listNamespacesCommand(context?: string): Command {
  const args = [
    'get',
    'namespaces',
    '-o',
    'jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end}',
    '--request-timeout=5s',
  ]
  return { cmd: 'kubectl', args: context ? [...args, '--context', context] : args }
}

/**
 * Namespaces a cluster did not come with, so "what is about to be lost" names the operator's own
 * workloads rather than the four every cluster has. `cat-factory` is EXCLUDED as system-ish on
 * purpose: it holds only the ServiceAccount this command mints, which a recreate mints again.
 */
const SYSTEM_NAMESPACES = new Set([
  'default',
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'local-path-storage',
  CAT_FACTORY_NAMESPACE,
])

export function parseUserNamespaces(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SYSTEM_NAMESPACES.has(line))
}

/** The kubeconfig context name k3d/kind assigns to a cluster it creates. */
export function contextName(runtime: 'k3d' | 'kind', name: string): string {
  return `${runtime}-${name}`
}

/**
 * Append an explicit `--context <ctx>` when one is supplied, so a command targets a SPECIFIC
 * kubeconfig context instead of mutating (and leaving mutated) the global current-context. Absent
 * ⇒ the command operates on whatever context is already current (used for the reuse path, where
 * the current context IS the target).
 */
function withContext(args: string[], context?: string): string[] {
  return context ? [...args, '--context', context] : args
}

/** `kubectl apply -f -` with the RBAC manifest on stdin (idempotent), targeting `context`. */
export function applyRbacCommand(context?: string): Command {
  return { cmd: 'kubectl', args: withContext(['apply', '-f', '-'], context), input: RBAC_MANIFEST }
}

/** Read the base64 token out of the SA token Secret via jsonpath, targeting `context`. */
export function readTokenCommand(context?: string): Command {
  return {
    cmd: 'kubectl',
    args: withContext(
      [
        '-n',
        CAT_FACTORY_NAMESPACE,
        'get',
        'secret',
        TOKEN_SECRET_NAME,
        '-o',
        'jsonpath={.data.token}',
      ],
      context,
    ),
  }
}

/** Read the target context's apiserver URL from the kubeconfig. */
export function readApiServerCommand(context?: string): Command {
  return {
    cmd: 'kubectl',
    args: withContext(
      ['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'],
      context,
    ),
  }
}

/** Decode the base64 token the Secret exposes; empty until the token controller populates it. */
export function decodeToken(base64: string): string {
  return Buffer.from(base64.trim(), 'base64').toString('utf8').trim()
}

/** kubeconfig context names that unambiguously denote a LOCAL cluster. */
const LOCAL_CONTEXT_PREFIXES = ['k3d-', 'kind-'] as const
const LOCAL_CONTEXT_NAMES = ['minikube', 'docker-desktop', 'orbstack', 'colima', 'rancher-desktop']

/** Normalize the wildcard bind address k3d writes for the apiserver to a dialable loopback host. */
export function normalizeApiServerUrl(url: string): string {
  return url.replace('//0.0.0.0:', '//127.0.0.1:')
}

/**
 * Whether the (context, apiserver URL) pair looks like a LOCAL cluster. Used to refuse silently
 * mutating a remote/production cluster in `--yes` mode: the `use-existing` offer fires for ANY
 * reachable kubeconfig, which may point at a shared cluster. A local-looking context name OR a
 * loopback/Docker-host apiserver is treated as local.
 *
 * The apiserver half is `localHost.ts`'s `isLocalMachineHost`, a pinned copy of kernel's helper
 * of the same name (this package ships with no runtime dependencies, so it cannot import kernel;
 * `localHost.conformity.test.ts` is what stops the two drifting). It replaced a hand-kept host
 * list here: that list and the environment provider's had already separated, and the one missing
 * k3d's `0.0.0.0` silently withheld a behaviour from the default local setup. The mDNS and
 * wildcard-DNS suffixes stay here because they are heuristics about a DEVELOPER'S kubeconfig,
 * not facts about the host.
 */
export function looksLocalCluster(context: string | undefined, apiServerUrl: string): boolean {
  const ctx = (context ?? '').toLowerCase()
  if (LOCAL_CONTEXT_PREFIXES.some((p) => ctx.startsWith(p))) return true
  if (LOCAL_CONTEXT_NAMES.includes(ctx)) return true
  let host = ''
  try {
    host = new URL(apiServerUrl).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (host && isLocalMachineHost(host)) return true
  return host.endsWith('.local') || host.endsWith('.nip.io')
}

// ---------------------------------------------------------------------------
// Executor — runs the planned commands through the HostShell, behind confirms.
// ---------------------------------------------------------------------------

/** Injectable dependencies for the provisioner (mirrors the k3s-command deps). */
export interface ProvisionDeps {
  shell: HostShell
  io: Io
  /** TCP reachability seam, used to establish that a host ingress port is actually served. */
  tcp: TcpProbe
  /** Delay between token-Secret read attempts (real setTimeout; a no-op in tests). */
  sleep?: (ms: number) => Promise<void>
  /** Clock the ingress settle wait is measured against (default `Date.now`); see `probeIngress`. */
  now?: () => number
  /**
   * How many times to poll the freshly-applied token Secret for a populated `.data.token` before
   * giving up (500ms between attempts). Absent ⇒ {@link DEFAULT_TOKEN_READ_ATTEMPTS} (a snappy
   * fail-fast for an interactive user). The integration suite raises it, since a busy CI cluster's
   * token controller can take longer than the interactive budget to populate the Secret.
   */
  tokenReadAttempts?: number
}

/** Default poll budget for {@link readSaToken}: 20 attempts × 500ms = 10s. */
const DEFAULT_TOKEN_READ_ATTEMPTS = 20

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Run a command, throwing a {@link ProvisionError} with the captured stderr on a non-zero exit. */
async function runOrThrow(
  shell: HostShell,
  command: Command,
  what: string,
  hint?: (detail: string) => string,
): Promise<ShellResult> {
  const result = await shell.run(command.cmd, command.args, {
    input: command.input,
    timeoutMs: command.timeoutMs,
  })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    const base = detail || `${command.cmd} exited ${result.code}`
    throw new ProvisionError(`${what} failed: ${base}${hint ? hint(base) : ''}`)
  }
  return result
}

/**
 * The two shapes Docker names a refused host port in, and both are common:
 *
 *   `Bind for 0.0.0.0:80 failed: port is already allocated`
 *   `... Error starting userland proxy: listen tcp4 0.0.0.0:80: bind: address already in use`
 *
 * Matching only the first left every collision reported through the second reading as "one of the
 * two ports", which is the misattribution the hint exists to remove.
 */
const BOUND_PORT_PATTERNS: readonly RegExp[] = [
  /bind for\s+\S*?:(\d+)/i,
  /listen tcp\d?\s+\S*?:(\d+):\s*bind:/i,
]

/** The host port a Docker failure names as already bound, when it names one. */
export function boundPortFromDetail(detail: string): number | undefined {
  for (const pattern of BOUND_PORT_PATTERNS) {
    const port = Number(pattern.exec(detail)?.[1])
    if (Number.isInteger(port) && port > 0) return port
  }
  return undefined
}

/**
 * An extra hint appended to a create failure that looks like a host-port collision.
 *
 * A create asks for TWO host ports, so the hint READS which one Docker refused out of its own
 * message instead of naming the apiserver port, which it used to do unconditionally and would
 * misattribute an ingress-port collision. Port 80 is taken often enough on Windows and macOS that
 * an opaque `k3d cluster create` failure here is the likely first experience, so the hint names
 * the flag that moves it.
 */
export function portCollisionHint(ingressPort: number): (detail: string) => string {
  return (detail) => {
    if (!/already (allocated|in use)|address already in use|port is already/i.test(detail))
      return ''
    const bound = boundPortFromDetail(detail)
    if (bound === ingressPort) {
      return ` (host port ${ingressPort} is already in use: free it, or re-run with \`--ingress-port <free port>\`)`
    }
    if (bound !== undefined) {
      return ` (host port ${bound} is already in use: free it, or remove the conflicting cluster, then re-run)`
    }
    return ` (a requested host port is already in use, either the apiserver's ${DEFAULT_API_PORT} or the ingress' ${ingressPort}: free it, or re-run with \`--ingress-port <free port>\`)`
  }
}

/** Ask to run a mutating step; `--yes` proceeds without prompting. Declining throws. */
async function confirmStep(io: Io, options: CliOptions, prompt: string): Promise<void> {
  if (options.yes) return
  const ok = await io.confirm(prompt, true)
  if (!ok) throw new ProvisionError('Cancelled — nothing further was changed on your host.')
}

/**
 * Read the ServiceAccount token from its Secret, retrying while the token controller populates it.
 * A freshly-applied `kubernetes.io/service-account-token` Secret has an empty `.data.token` for a
 * moment; poll until it's non-empty (or give up with an actionable error).
 */
async function readSaToken(deps: ProvisionDeps, context?: string): Promise<string> {
  const sleep = deps.sleep ?? realSleep
  const attempts = deps.tokenReadAttempts ?? DEFAULT_TOKEN_READ_ATTEMPTS
  for (let i = 0; i < attempts; i++) {
    const result = await runOrThrow(
      deps.shell,
      readTokenCommand(context),
      'Reading the ServiceAccount token',
    )
    const token = decodeToken(result.stdout)
    if (token.length > 0) return token
    if (i < attempts - 1) await sleep(500)
  }
  throw new ProvisionError(
    `The ServiceAccount token Secret "${TOKEN_SECRET_NAME}" never populated. Re-run \`cat-factory k3s\` once the cluster is settled.`,
  )
}

/** The distribution behind a create/recreate offer; `null` for the reuse path. */
function offerRuntime(chosen: OfferId): 'k3d' | 'kind' | null {
  if (chosen === 'create-k3d' || chosen === RECREATE_OFFERS.k3d) return 'k3d'
  if (chosen === 'create-kind' || chosen === RECREATE_OFFERS.kind) return 'kind'
  return null
}

/** The ingress host port a run targets: `--ingress-port`, else {@link DEFAULT_INGRESS_PORT}. */
export function resolveIngressPort(options: CliOptions): number {
  return options.ingressPort ?? DEFAULT_INGRESS_PORT
}

/**
 * Destroy a local cluster and build it again from the CURRENT flags, so a recreate is how you
 * change anything that is fixed at create time (the published ingress port above all, but the
 * apiserver port and the name too).
 *
 * Why this is offered at all rather than documented: these clusters are transient and dropping
 * one is routine. The reasons are open-ended (a wedged cluster, one created by hand with the
 * wrong flags, a k3s version bump, namespaces left behind by failed runs), so it is a general
 * operation, not the remedy attached to any one detected condition.
 *
 * Safety, in the order it is enforced:
 *
 *   - The TARGET is only ever a k3d/kind cluster the CLI can see BY NAME, which is why the
 *     caller resolves `recreate-*` and never `use-existing`. There is no recreate recipe for
 *     "whatever the current context points at", and that context can be a shared cluster.
 *   - What is about to be lost is READ and named (its non-system namespaces) before the prompt,
 *     rather than a generic warning, because a routine operation stays safe only if the prompt
 *     shows the thing being destroyed.
 *   - `--yes` skips the confirmation ONLY because reaching here at all required `--recreate`,
 *     a flag whose entire meaning is "destroy and rebuild". `--yes` on its own can never select
 *     this path: the recreate offers are deliberately absent from the recommendation priority,
 *     so the destructive intent is always stated and never inferred from "don't prompt me".
 */
async function recreateCluster(
  runtime: 'k3d' | 'kind',
  clusterName: string,
  options: CliOptions,
  deps: ProvisionDeps,
): Promise<void> {
  const { io, shell } = deps
  const context = contextName(runtime, clusterName)

  // Best-effort: a cluster too wedged to answer kubectl is exactly one a recreate fixes, so an
  // unreadable namespace list must not block the operation. It is reported as unread rather than
  // rendered as "nothing on it", which would read like an empty cluster.
  const namespaces = await runCommand(shell, listNamespacesCommand(context))
  const lost = namespaces.code === 0 ? parseUserNamespaces(namespaces.stdout) : null
  io.warn(
    [
      `About to DESTROY the ${runtime} cluster "${clusterName}" and everything running on it.`,
      lost === null
        ? '  Its namespaces could not be read, so this cannot list what is on it.'
        : lost.length === 0
          ? '  It holds no namespaces of its own.'
          : `  It holds ${lost.length} namespace(s) of its own: ${lost.join(', ')}`,
      '  This cannot be undone.',
    ].join('\n'),
  )
  await confirmStep(io, options, `Delete and re-create the ${runtime} cluster "${clusterName}"?`)

  io.info(`Deleting the ${runtime} cluster "${clusterName}"…`)
  await runOrThrow(
    shell,
    clusterDeleteCommand(runtime, clusterName),
    `Deleting the ${runtime} cluster`,
  )

  io.info(`Re-creating the ${runtime} cluster "${clusterName}" (this can take a minute)…`)
  const ingressPort = resolveIngressPort(options)
  const create = clusterCreateCommand(runtime, clusterName, ingressPort)
  const result = await runCommand(shell, create)
  if (result.code !== 0) {
    // Deleted-but-not-recreated is worse than either end, so the failure says WHICH state the
    // host is in and how to leave it, rather than reporting only the create's own error.
    const detail = (result.stderr || result.stdout).trim() || `${create.cmd} exited ${result.code}`
    throw new ProvisionError(
      `The ${runtime} cluster "${clusterName}" was DELETED, but re-creating it failed: ${detail}` +
        `${portCollisionHint(ingressPort)(detail)}. Your host now has no cluster by that name. ` +
        `Fix the cause, then run \`cat-factory k3s --runtime ${runtime} --cluster-name ${clusterName} --ingress-port ${ingressPort}\` to create it.`,
    )
  }
}

/**
 * Provision (create, recreate or reuse) a local cluster for the chosen offer, create the
 * least-privilege ServiceAccount + RBAC, mint a long-lived token, read the apiserver URL, and
 * PROBE whether an ingress-derived environment URL can actually be served, returning the resolved
 * `local-k3s` connection. Every MUTATING step (cluster create/delete, RBAC apply) is behind an
 * explicit confirm unless `--yes`. Idempotent apart from `recreate-*`: an existing cluster/SA is
 * reused, not duplicated. `install-k3s` is NOT handled here (guidance-only).
 */
export async function provisionCluster(
  chosen: Exclude<OfferId, 'install-k3s'>,
  state: HostState,
  options: CliOptions,
  deps: ProvisionDeps,
): Promise<ResolvedConnection> {
  const { io, shell } = deps
  const ingressPort = resolveIngressPort(options)
  const runtime = offerRuntime(chosen)

  // The kubeconfig context every subsequent command targets. Create/recreate paths get an
  // explicit `--context` (so we never mutate the user's global current-context); reuse operates
  // on the already-current context (`undefined`).
  let targetContext: string | undefined
  let createdName: string | undefined
  // A cluster this run BUILT is given time for its BUNDLED controller to install; anything else is
  // probed once, because that answer is already final. `settleWaitFor` is what decides, and the
  // distinction it draws (kind installs no controller, so waiting cannot change kind's verdict) is
  // the difference between a one-read create and one that burns the whole budget by design.
  let ingressWaitMs = 0
  if (runtime !== null) {
    const clusterName = options.clusterName ?? OPTION_DEFAULTS.k3sClusterName
    const existing =
      runtime === 'kind' ? state.detections.kindClusters : state.detections.k3dClusters
    if (isRecreateOffer(chosen)) {
      if (!existing.includes(clusterName)) {
        throw new ProvisionError(
          `There is no ${runtime} cluster named "${clusterName}" to recreate (${runtime} reports: ${existing.join(', ') || 'none'}). Drop --recreate to create it, or name an existing one with --cluster-name.`,
        )
      }
      await recreateCluster(runtime, clusterName, options, deps)
      ingressWaitMs = settleWaitFor(runtime)
    } else if (existing.includes(clusterName)) {
      io.info(`Reusing the existing ${runtime} cluster "${clusterName}".`)
    } else {
      await confirmStep(io, options, `Create a local ${runtime} cluster "${clusterName}"?`)
      io.info(`Creating the ${runtime} cluster "${clusterName}" (this can take a minute)…`)
      await runOrThrow(
        shell,
        clusterCreateCommand(runtime, clusterName, ingressPort),
        `Creating the ${runtime} cluster`,
        portCollisionHint(ingressPort),
      )
      ingressWaitMs = settleWaitFor(runtime)
    }
    targetContext = contextName(runtime, clusterName)
    createdName = clusterName
  } else {
    // use-existing: operate on the current context (its name is what the probe detected).
    targetContext = undefined
  }

  // The cluster whose published host ports can be read, and the one `--recreate` could name: the
  // cluster this run built, or on the reuse path whichever k3d/kind cluster the current context
  // resolves to (`null` for anything else, e.g. a bare k3s service).
  const clusterTarget: IngressProbeCluster | null =
    runtime !== null && createdName !== undefined
      ? { runtime, clusterName: createdName }
      : recreateTargetForContext(state.detections)

  // Read the apiserver URL first (a read-only op): it names the target in the confirm below and
  // gates the reuse path against accidentally mutating a non-local cluster.
  const apiServer = await runOrThrow(
    shell,
    readApiServerCommand(targetContext),
    'Reading the apiserver URL',
  )
  const apiServerUrl = normalizeApiServerUrl(apiServer.stdout.trim())
  if (apiServerUrl.length === 0) {
    throw new ProvisionError('Could not read the apiserver URL from your kubeconfig.')
  }

  const contextLabel = state.detections.clusterContext
  const targetDescription = createdName
    ? `the ${runtime} cluster "${createdName}" (${apiServerUrl})`
    : contextLabel
      ? `context "${contextLabel}" (${apiServerUrl})`
      : `the current cluster (${apiServerUrl})`

  // Refuse to silently mutate a cluster that doesn't look local when running non-interactively —
  // `use-existing` fires for ANY reachable kubeconfig, which could be a shared/remote cluster.
  if (chosen === 'use-existing' && options.yes && !looksLocalCluster(contextLabel, apiServerUrl)) {
    throw new ProvisionError(
      `Refusing to auto-provision in --yes mode: ${targetDescription} does not look like a local cluster. Re-run without --yes to confirm explicitly, or point kubeconfig at a local k3d/kind/k3s cluster.`,
    )
  }

  await confirmStep(
    io,
    options,
    `Apply the cat-factory ServiceAccount + RBAC to ${targetDescription}?`,
  )
  io.info('Applying the ServiceAccount + RBAC…')
  await runOrThrow(shell, applyRbacCommand(targetContext), 'Applying the RBAC manifest')

  io.info('Minting the ServiceAccount token…')
  const apiToken = await readSaToken(deps, targetContext)

  io.info('Checking whether this cluster can serve an ingress-derived environment URL…')
  const ingress = await probeIngress(
    { shell, tcp: deps.tcp, sleep: deps.sleep, now: deps.now },
    {
      context: targetContext,
      port: ingressPort,
      waitMs: ingressWaitMs,
      ...(clusterTarget ? { cluster: clusterTarget } : {}),
    },
  )

  return {
    engine: 'local-k3s',
    clusterName: createdName,
    ...(runtime !== null ? { runtime } : {}),
    apiServerUrl,
    apiToken,
    insecureSkipTlsVerify: true,
    ingress,
    ...(clusterTarget ? { recreateTarget: clusterTarget } : {}),
  }
}

/**
 * How long a freshly built cluster is given before its ingress verdict is final.
 *
 * k3d/k3s install Traefik through a HelmChart Job that completes ~20-30s AFTER the create returns,
 * so judging immediately would report a definitive `missing` for a cluster that is merely still
 * starting. kind installs NO controller (by design, see {@link kindClusterConfig}), so its verdict
 * is final the moment the create returns, and waiting would spend the whole budget re-reading a
 * fact that cannot change.
 */
function settleWaitFor(runtime: 'k3d' | 'kind'): number {
  return runtime === 'kind' ? 0 : INGRESS_SETTLE_WAIT_MS
}
