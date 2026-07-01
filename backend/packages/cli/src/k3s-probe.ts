import { COMMAND_NOT_FOUND, type HostShell } from './host-shell.js'

/** Whether a host CLI is installed, and its reported version string when detectable. */
export interface ToolDetection {
  installed: boolean
  version?: string
}

/**
 * The raw facts detected about the host, produced by {@link probeHost} and consumed by the pure
 * {@link classifyHost}. Kept as plain data so classification is unit-testable with no shell.
 */
export interface HostDetections {
  kubectl: ToolDetection
  k3d: ToolDetection
  kind: ToolDetection
  k3s: ToolDetection
  docker: { installed: boolean; running: boolean }
  /** A cluster is reachable via the current kubeconfig (apiserver answered a version request). */
  reachableCluster: boolean
  /** The current kubeconfig context name, when one is set. */
  clusterContext?: string
  /** Names of existing k3d-managed clusters (Docker). */
  k3dClusters: string[]
  /** Names of existing kind-managed clusters (Docker). */
  kindClusters: string[]
}

/** The setup paths the probe can offer. */
export type OfferId = 'use-existing' | 'create-k3d' | 'install-k3s'

/** One offered setup path, with whether it's currently possible + why not. */
export interface Offer {
  id: OfferId
  label: string
  available: boolean
  recommended: boolean
  /** When `available` is false, a short reason the UI can show. */
  reason?: string
}

/** The classified host state: the raw detections plus the offered paths and the recommendation. */
export interface HostState {
  detections: HostDetections
  offers: Offer[]
  recommended: OfferId
}

/** Priority order: prefer reusing a live cluster, then the no-root k3d path, then guided k3s. */
const OFFER_PRIORITY: readonly OfferId[] = ['use-existing', 'create-k3d', 'install-k3s']

/**
 * Classify the host from its detected facts into the offered setup paths. Pure — no IO — so it's
 * the primary unit-test target. `recommended` is the highest-priority AVAILABLE offer.
 */
export function classifyHost(d: HostDetections): HostState {
  const useExisting: Offer = {
    id: 'use-existing',
    label: d.clusterContext
      ? `Use the existing cluster (context: ${d.clusterContext})`
      : 'Use the existing reachable cluster',
    available: d.reachableCluster,
    recommended: false,
    reason: d.reachableCluster ? undefined : 'No cluster is reachable via your kubeconfig',
  }

  const createK3d: Offer = {
    id: 'create-k3d',
    label: 'Create a local k3d cluster (Docker, no root)',
    available: d.docker.running && d.k3d.installed,
    recommended: false,
    reason: !d.docker.installed
      ? 'Docker is not installed'
      : !d.docker.running
        ? 'Docker is not running'
        : !d.k3d.installed
          ? 'k3d is not installed (https://k3d.io)'
          : undefined,
  }

  // Guided k3s install only ever PRINTS a command (needs sudo), so it's always an option.
  const installK3s: Offer = {
    id: 'install-k3s',
    label: 'Show the k3s install command (needs sudo — not run for you)',
    available: true,
    recommended: false,
  }

  const offers: Offer[] = [useExisting, createK3d, installK3s]
  const recommended =
    OFFER_PRIORITY.find((id) => offers.find((o) => o.id === id)?.available) ?? 'install-k3s'
  for (const o of offers) o.recommended = o.id === recommended

  return { detections: d, offers, recommended }
}

/** True when a `run` result indicates the binary exists (it ran, even if the subcommand failed). */
function isInstalled(code: number): boolean {
  return code !== COMMAND_NOT_FOUND
}

/** First non-empty trimmed line of a command's stdout (used for `--version` style output). */
function firstLine(stdout: string): string | undefined {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line && line.length > 0 ? line : undefined
}

/** Parse `k3d cluster list --output json` (an array of `{ name }`) into cluster names. */
export function parseK3dClusters(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((c) =>
        typeof c === 'object' && c !== null ? (c as { name?: unknown }).name : undefined,
      )
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
  } catch {
    return []
  }
}

/** Parse `kind get clusters` (newline-separated names; a "No kind clusters" note ⇒ empty). */
export function parseKindClusters(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.toLowerCase().startsWith('no kind clusters'))
}

/** Detect whether a `kubectl version --output=json` payload reports a reachable apiserver. */
export function hasServerVersion(stdout: string): boolean {
  try {
    const parsed = JSON.parse(stdout) as { serverVersion?: unknown }
    return typeof parsed.serverVersion === 'object' && parsed.serverVersion !== null
  } catch {
    return false
  }
}

/**
 * Probe the host over the {@link HostShell} seam and classify it. Runs each tool's detection
 * command, treats {@link COMMAND_NOT_FOUND} as "not installed", and folds the results through the
 * pure {@link classifyHost}. Tested with a scripted fake shell.
 */
export async function probeHost(shell: HostShell): Promise<HostState> {
  const [
    kubectlVersion,
    kubectlContext,
    k3dVersion,
    k3dList,
    kindVersion,
    kindList,
    k3sVersion,
    dockerVersion,
  ] = await Promise.all([
    shell.run('kubectl', ['version', '--output=json']),
    shell.run('kubectl', ['config', 'current-context']),
    shell.run('k3d', ['version']),
    shell.run('k3d', ['cluster', 'list', '--output', 'json']),
    shell.run('kind', ['version']),
    shell.run('kind', ['get', 'clusters']),
    shell.run('k3s', ['--version']),
    shell.run('docker', ['version', '--format', '{{.Server.Version}}']),
  ])

  const context = kubectlContext.code === 0 ? firstLine(kubectlContext.stdout) : undefined

  const detections: HostDetections = {
    kubectl: {
      installed: isInstalled(kubectlVersion.code),
      version: firstLine(kubectlVersion.stdout),
    },
    k3d: { installed: isInstalled(k3dVersion.code), version: firstLine(k3dVersion.stdout) },
    kind: { installed: isInstalled(kindVersion.code), version: firstLine(kindVersion.stdout) },
    k3s: { installed: isInstalled(k3sVersion.code), version: firstLine(k3sVersion.stdout) },
    docker: {
      installed: isInstalled(dockerVersion.code),
      running: dockerVersion.code === 0 && firstLine(dockerVersion.stdout) !== undefined,
    },
    reachableCluster: kubectlVersion.code === 0 && hasServerVersion(kubectlVersion.stdout),
    clusterContext: context,
    k3dClusters: k3dList.code === 0 ? parseK3dClusters(k3dList.stdout) : [],
    kindClusters: kindList.code === 0 ? parseKindClusters(kindList.stdout) : [],
  }

  return classifyHost(detections)
}
