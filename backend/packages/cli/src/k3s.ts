import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { createNodeShell, type HostShell } from './host-shell.js'
import { createConsoleIo, type Io } from './io.js'
import { type HostState, type Offer, type OfferId, probeHost } from './k3s-probe.js'
import {
  CAT_FACTORY_NAMESPACE,
  provisionCluster,
  ProvisionError,
  type ResolvedConnection,
} from './k3s-provision.js'

/** The k3s command's injectable dependencies (defaults to the real console IO + host shell). */
export interface K3sDeps {
  io?: Io
  shell?: HostShell
}

/** What {@link setupK3s} resolves to (returned for tests + programmatic callers). */
export interface K3sResult {
  state: HostState
  chosen: OfferId
  /** The resolved connection when a provisioning path ran + succeeded (not for `install-k3s`). */
  connection?: ResolvedConnection
}

/** The one-liner k3s install command (needs sudo — printed, never run for the user). */
export const K3S_INSTALL_COMMAND = 'curl -sfL https://get.k3s.io | sh -'

/**
 * `cat-factory k3s` — guided local-cluster setup: probe → offer → provision → hand-off.
 *
 * Probes the host over the {@link HostShell} seam, reports what was found, lets the user pick a
 * setup path, then (for the k3d/kind/existing-cluster paths) provisions the cluster + a
 * least-privilege ServiceAccount and prints the resolved connection values to wire into the
 * Settings → Infrastructure → Local k3s form. `install-k3s` needs sudo, so it is guidance-only
 * (the command is printed, never run). `@clack/prompts` is reached only through {@link Io}.
 */
export async function setupK3s(options: CliOptions, deps: K3sDeps = {}): Promise<K3sResult> {
  const io = deps.io ?? createConsoleIo()
  const shell = deps.shell ?? createNodeShell()

  const preferred = options.k3sRuntime ?? OPTION_DEFAULTS.k3sRuntime

  io.info('\ncat-factory — guided local k3s / k3d setup\n')
  io.info('Probing your machine for a usable Kubernetes cluster…')

  const state = await probeHost(shell, preferred)
  io.info(renderReport(state))

  const chosen = await chooseOffer(state, options, io)

  // The k3s install needs sudo — we only ever print the command, never provision on the user's behalf.
  if (chosen === 'install-k3s') {
    printInstallGuidance(state, io)
    return { state, chosen }
  }

  let connection: ResolvedConnection
  try {
    connection = await provisionCluster(chosen, state, options, { io, shell })
  } catch (err) {
    // A declined confirm or a failed command is an expected, non-fatal outcome — report and stop.
    if (err instanceof ProvisionError) {
      io.warn(err.message)
      return { state, chosen }
    }
    throw err
  }

  printConnectionSummary(connection, io)
  return { state, chosen, connection }
}

/** Render the human-readable findings report from the classified host state. */
function renderReport(state: HostState): string {
  const d = state.detections
  const tool = (name: string, t: { installed: boolean; version?: string }): string =>
    `  ${t.installed ? '✓' : '·'} ${name}${t.installed && t.version ? `  (${t.version})` : t.installed ? '' : '  — not found'}`

  const lines = [
    '',
    'Detected:',
    tool('kubectl', d.kubectl),
    tool('k3d', d.k3d),
    tool('kind', d.kind),
    tool('k3s', d.k3s),
    `  ${d.docker.running ? '✓' : '·'} docker${
      d.docker.running
        ? '  (running)'
        : d.docker.installed
          ? '  — installed but not running'
          : '  — not found'
    }`,
    d.reachableCluster
      ? `  ✓ reachable cluster${d.clusterContext ? `  (context: ${d.clusterContext})` : ''}`
      : '  · no reachable cluster via your kubeconfig',
  ]
  if (d.k3dClusters.length > 0) lines.push(`  • existing k3d clusters: ${d.k3dClusters.join(', ')}`)
  if (d.kindClusters.length > 0)
    lines.push(`  • existing kind clusters: ${d.kindClusters.join(', ')}`)
  return lines.join('\n')
}

/** Pick an offer: `--yes` takes the recommendation; otherwise prompt over the available offers. */
async function chooseOffer(state: HostState, options: CliOptions, io: Io): Promise<OfferId> {
  const available = state.offers.filter((o) => o.available)
  // `install-k3s` is always available, so `available` is never empty.
  if (options.yes || available.length === 1) return state.recommended

  // Surface why an unavailable path is off, so the choice is informed.
  for (const o of state.offers) {
    if (!o.available && o.reason) io.info(`  (unavailable: ${o.label} — ${o.reason})`)
  }

  return io.select(
    'How would you like to set up the cluster?',
    available.map((o) => ({ value: o.id, label: offerLabel(o) })),
    state.recommended,
  )
}

/** Label an offer for the menu, tagging the recommended one. */
function offerLabel(o: Offer): string {
  return o.recommended ? `${o.label}  (recommended)` : o.label
}

/**
 * Print the k3s install guidance. The install needs sudo, so the command is only ever PRINTED —
 * cat-factory never runs it for the user.
 */
function printInstallGuidance(state: HostState, io: Io): void {
  // Don't tell a user who already has k3s to re-install it — point them at starting the service.
  io.info(
    state.detections.k3s.installed
      ? [
          '',
          'k3s is already installed. Start it (needs sudo), e.g.:',
          '',
          '  sudo systemctl start k3s   # or: sudo k3s server',
          '',
          'Then re-run `cat-factory k3s` — it will detect the running cluster and provision the handler.',
        ].join('\n')
      : [
          '',
          'Install k3s (single-node) — run this yourself (needs sudo):',
          '',
          `  ${K3S_INSTALL_COMMAND}`,
          '',
          'Then re-run `cat-factory k3s` — it will detect the new cluster and provision the handler.',
        ].join('\n'),
  )
}

/**
 * Print the resolved connection so the user can wire it into the Settings → Infrastructure →
 * Local k3s form (Test → Save). The apiserver token is shown ONCE here (the user's own local
 * cluster credential, to paste) — it is never written to disk or a log by cat-factory. Slice 3
 * replaces this with a deep-linked, pre-filled form.
 */
function printConnectionSummary(connection: ResolvedConnection, io: Io): void {
  io.info(
    [
      '',
      connection.clusterName
        ? `Cluster "${connection.clusterName}" is ready and wired for cat-factory.`
        : 'The existing cluster is wired for cat-factory.',
      '',
      'Open Settings → Infrastructure → Kubernetes → Local k3s and enter:',
      `  • API server URL:          ${connection.apiServerUrl}`,
      `  • Skip TLS verification:   yes (local self-signed cert)`,
      `  • Namespace template:      cf-env-{{pullNumber}}`,
      `  • Ingress host template:   {{branch}}.127.0.0.1.nip.io`,
      `  • ServiceAccount:          ${CAT_FACTORY_NAMESPACE}/${CAT_FACTORY_NAMESPACE}`,
      '',
      'Then paste this ServiceAccount token into the "API token" field and click Test → Save:',
      '',
      `  ${connection.apiToken}`,
      '',
      'Keep the token private — it grants access to your local cluster.',
    ].join('\n'),
  )
}
