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

/** A single command to run through the {@link HostShell}, optionally with stdin `input`. */
export interface Command {
  cmd: string
  args: string[]
  input?: string
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
 * The least-privilege RBAC the local-k3s environment backend needs, applied via
 * `kubectl apply -f -` (idempotent). It grants the ServiceAccount:
 *   - cluster-wide `namespaces` create/delete (the ephemeral-env backend stands up one per PR),
 *   - the per-PR resource kinds the backend applies (the manifest allow-list), cluster-wide so
 *     they land in whichever per-PR namespace is created,
 *   - `pods` + `pods/proxy` (so the SAME token can also back the Kubernetes runner backend).
 * It deliberately does NOT bind `cluster-admin` (see docs/initiatives/local-k3s-guided-setup.md —
 * "least-privilege RBAC"); the cluster-scoped grant is required because per-PR namespaces don't
 * exist yet when the token is minted. A long-lived token Secret is created (k8s >= 1.24 no longer
 * auto-creates one) and read back rather than a short-lived `kubectl create token`.
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
    resources:
      ['services', 'configmaps', 'secrets', 'serviceaccounts', 'persistentvolumeclaims', 'pods']
    verbs: ['create', 'get', 'list', 'watch', 'patch', 'update', 'delete']
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
  return { cmd: 'k3d', args: ['cluster', 'create', name, '--api-port', String(apiPort)] }
}

/** `kind create cluster --name <name>`. */
export function kindCreateCommand(name: string): Command {
  return { cmd: 'kind', args: ['create', 'cluster', '--name', name] }
}

/** The kubeconfig context name k3d/kind assigns to a cluster it creates. */
export function contextName(runtime: 'k3d' | 'kind', name: string): string {
  return `${runtime}-${name}`
}

/** `kubectl config use-context <ctx>` — point kubectl at the freshly-created cluster. */
export function useContextCommand(ctx: string): Command {
  return { cmd: 'kubectl', args: ['config', 'use-context', ctx] }
}

/** `kubectl apply -f -` with the RBAC manifest on stdin (idempotent). */
export function applyRbacCommand(): Command {
  return { cmd: 'kubectl', args: ['apply', '-f', '-'], input: RBAC_MANIFEST }
}

/** Read the base64 token out of the SA token Secret via jsonpath. */
export function readTokenCommand(): Command {
  return {
    cmd: 'kubectl',
    args: [
      '-n',
      CAT_FACTORY_NAMESPACE,
      'get',
      'secret',
      TOKEN_SECRET_NAME,
      '-o',
      'jsonpath={.data.token}',
    ],
  }
}

/** Read the current context's apiserver URL from the kubeconfig. */
export function readApiServerCommand(): Command {
  return {
    cmd: 'kubectl',
    args: ['config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}'],
  }
}

/** Decode the base64 token the Secret exposes; empty until the token controller populates it. */
export function decodeToken(base64: string): string {
  return Buffer.from(base64.trim(), 'base64').toString('utf8').trim()
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
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Run a command, throwing a {@link ProvisionError} with the captured stderr on a non-zero exit. */
async function runOrThrow(shell: HostShell, command: Command, what: string): Promise<ShellResult> {
  const result = await shell.run(command.cmd, command.args, { input: command.input })
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim()
    throw new ProvisionError(`${what} failed: ${detail || `${command.cmd} exited ${result.code}`}`)
  }
  return result
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
async function readSaToken(deps: ProvisionDeps): Promise<string> {
  const sleep = deps.sleep ?? realSleep
  const attempts = 20
  for (let i = 0; i < attempts; i++) {
    const result = await runOrThrow(
      deps.shell,
      readTokenCommand(),
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
  const clusterName = options.clusterName ?? OPTION_DEFAULTS.k3sClusterName

  let createdName: string | undefined
  if (chosen === 'create-k3d' || chosen === 'create-kind') {
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
      await runOrThrow(shell, create, `Creating the ${runtime} cluster`)
    }
    // Point kubectl at the (possibly pre-existing) cluster so the RBAC + reads target it.
    await runOrThrow(
      shell,
      useContextCommand(contextName(runtime, clusterName)),
      'Selecting the cluster context',
    )
    createdName = clusterName
  }

  await confirmStep(
    io,
    options,
    `Apply the cat-factory ServiceAccount + least-privilege RBAC to the cluster?`,
  )
  io.info('Applying the ServiceAccount + RBAC…')
  await runOrThrow(shell, applyRbacCommand(), 'Applying the RBAC manifest')

  io.info('Minting the ServiceAccount token…')
  const apiToken = await readSaToken(deps)

  const apiServer = await runOrThrow(shell, readApiServerCommand(), 'Reading the apiserver URL')
  const apiServerUrl = apiServer.stdout.trim()
  if (apiServerUrl.length === 0) {
    throw new ProvisionError('Could not read the apiserver URL from your kubeconfig.')
  }

  return {
    engine: 'local-k3s',
    clusterName: createdName,
    apiServerUrl,
    apiToken,
    insecureSkipTlsVerify: true,
  }
}
