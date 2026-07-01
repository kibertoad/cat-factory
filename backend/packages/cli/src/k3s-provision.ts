import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { type HostState, type OfferId } from './k3s-probe.js'

/** The namespace + ServiceAccount + long-lived token Secret the guided setup creates. */
export const CAT_FACTORY_NAMESPACE = 'cat-factory'
export const SERVICE_ACCOUNT_NAME = 'cat-factory'
export const TOKEN_SECRET_NAME = 'cat-factory-token'
/** The apiserver port k3d/kind is asked to publish (the kube default). */
export const DEFAULT_API_PORT = 6443

/**
 * Watchdog budget (ms) for `k3d cluster create` / `kind create cluster`. These pull node images on
 * the first run and routinely take 30–90s, so they need far more than the {@link HostShell} default
 * (10s) — otherwise the watchdog SIGKILLs the create mid-flight and the whole create path fails.
 */
export const CLUSTER_CREATE_TIMEOUT_MS = 300_000

/** A single command to run through the {@link HostShell}, optionally with stdin `input`. */
export interface Command {
  cmd: string
  args: string[]
  input?: string
  /** Per-command watchdog override (ms). Absent ⇒ the {@link HostShell} default applies. */
  timeoutMs?: number
}

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
  apiServerUrl: string
  apiToken: string
  insecureSkipTlsVerify: true
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

/** `k3d cluster create <name> --api-port <port>` — publishes the apiserver on the host port. */
export function k3dCreateCommand(name: string, apiPort: number = DEFAULT_API_PORT): Command {
  return {
    cmd: 'k3d',
    args: ['cluster', 'create', name, '--api-port', String(apiPort)],
    timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
  }
}

/** `kind create cluster --name <name>`. */
export function kindCreateCommand(name: string): Command {
  return {
    cmd: 'kind',
    args: ['create', 'cluster', '--name', name],
    timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
  }
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
/** Hostnames that denote a LOCAL apiserver (loopback / the Docker host alias). */
const LOCAL_API_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'host.docker.internal',
]

/** Normalize the wildcard bind address k3d writes for the apiserver to a dialable loopback host. */
export function normalizeApiServerUrl(url: string): string {
  return url.replace('//0.0.0.0:', '//127.0.0.1:')
}

/**
 * Whether the (context, apiserver URL) pair looks like a LOCAL cluster. Used to refuse silently
 * mutating a remote/production cluster in `--yes` mode: the `use-existing` offer fires for ANY
 * reachable kubeconfig, which may point at a shared cluster. A local-looking context name OR a
 * loopback/Docker-host apiserver is treated as local.
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
  if (LOCAL_API_HOSTS.includes(host)) return true
  return host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.nip.io')
}

// ---------------------------------------------------------------------------
// Executor — runs the planned commands through the HostShell, behind confirms.
// ---------------------------------------------------------------------------

/** Injectable dependencies for the provisioner (mirrors the k3s-command deps). */
export interface ProvisionDeps {
  shell: HostShell
  io: Io
  /** Delay between token-Secret read attempts (real setTimeout; a no-op in tests). */
  sleep?: (ms: number) => Promise<void>
  /**
   * How many times to poll the freshly-applied token Secret for a populated `.data.token` before
   * giving up (500ms between attempts). Absent ⇒ {@link DEFAULT_TOKEN_READ_ATTEMPTS} (a snappy
   * fail-fast for an interactive user). The integration suite raises it, since a busy CI cluster's
   * token controller can take longer than the interactive budget to populate the Secret.
   */
  tokenReadAttempts?: number
}

/** Default poll budget for {@link readSaToken}: 20 attempts × 500ms = 10s. */
export const DEFAULT_TOKEN_READ_ATTEMPTS = 20

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

/** An extra hint appended to a create failure that looks like an apiserver-port collision. */
function portCollisionHint(detail: string): string {
  return /already (allocated|in use)|address already in use|port is already/i.test(detail)
    ? ` (the apiserver port ${DEFAULT_API_PORT} may already be in use — free it, or remove the conflicting cluster, then re-run)`
    : ''
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

/**
 * Provision (or reuse) a local cluster for the chosen offer, create the least-privilege
 * ServiceAccount + RBAC, mint a long-lived token, and read the apiserver URL — returning the
 * resolved `local-k3s` connection. Every MUTATING step (cluster create, RBAC apply) is behind an
 * explicit confirm unless `--yes`. Idempotent: an existing cluster/SA is reused, not duplicated
 * (`kubectl apply` and `k3d/kind` reuse). `install-k3s` is NOT handled here — it is guidance-only.
 */
export async function provisionCluster(
  chosen: Exclude<OfferId, 'install-k3s'>,
  state: HostState,
  options: CliOptions,
  deps: ProvisionDeps,
): Promise<ResolvedConnection> {
  const { io, shell } = deps

  // The kubeconfig context every subsequent command targets. Create paths get an explicit
  // `--context` (so we never mutate the user's global current-context); reuse operates on the
  // already-current context (`undefined`).
  let targetContext: string | undefined
  let createdName: string | undefined
  if (chosen === 'create-k3d' || chosen === 'create-kind') {
    const clusterName = options.clusterName ?? OPTION_DEFAULTS.k3sClusterName
    const runtime = chosen === 'create-kind' ? 'kind' : 'k3d'
    const existing =
      runtime === 'kind' ? state.detections.kindClusters : state.detections.k3dClusters
    if (existing.includes(clusterName)) {
      io.info(`Reusing the existing ${runtime} cluster "${clusterName}".`)
    } else {
      await confirmStep(io, options, `Create a local ${runtime} cluster "${clusterName}"?`)
      io.info(`Creating the ${runtime} cluster "${clusterName}" (this can take a minute)…`)
      const create =
        runtime === 'kind' ? kindCreateCommand(clusterName) : k3dCreateCommand(clusterName)
      await runOrThrow(shell, create, `Creating the ${runtime} cluster`, portCollisionHint)
    }
    targetContext = contextName(runtime, clusterName)
    createdName = clusterName
  } else {
    // use-existing: operate on the current context (its name is what the probe detected).
    targetContext = undefined
  }

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
    ? `the ${chosen === 'create-kind' ? 'kind' : 'k3d'} cluster "${createdName}" (${apiServerUrl})`
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

  return {
    engine: 'local-k3s',
    clusterName: createdName,
    apiServerUrl,
    apiToken,
    insecureSkipTlsVerify: true,
  }
}
