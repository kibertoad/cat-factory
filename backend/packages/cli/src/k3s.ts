import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { createNodeShell, type HostShell } from './host-shell.js'
import { createConsoleIo, type Io } from './io.js'
import { type HostState, type Offer, type OfferId, probeHost } from './k3s-probe.js'

/** The k3s command's injectable dependencies (defaults to the real console IO + host shell). */
export interface K3sDeps {
  io?: Io
  shell?: HostShell
}

/** What {@link setupK3s} resolves to (returned for tests + programmatic callers). */
export interface K3sResult {
  state: HostState
  chosen: OfferId
}

/** The one-liner k3s install command (needs sudo — printed, never run for the user). */
export const K3S_INSTALL_COMMAND = 'curl -sfL https://get.k3s.io | sh -'

/**
 * `cat-factory k3s` — guided local-cluster setup (slice 1: probe + report + offer).
 *
 * Probes the host over the {@link HostShell} seam, reports what was found, and lets the user pick
 * a setup path. Provisioning + handler wiring land in later slices; this slice stops at the choice
 * and prints the appropriate guidance. `@clack/prompts` is reached only through {@link Io}.
 */
export async function setupK3s(options: CliOptions, deps: K3sDeps = {}): Promise<K3sResult> {
  const io = deps.io ?? createConsoleIo()
  const shell = deps.shell ?? createNodeShell()

  io.info('\ncat-factory — guided local k3s / k3d setup\n')
  io.info('Probing your machine for a usable Kubernetes cluster…')

  const state = await probeHost(shell)
  io.info(renderReport(state))

  const chosen = await chooseOffer(state, options, io)
  printGuidance(chosen, state, options, io)

  return { state, chosen }
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
 * Print the guidance for the chosen path. The k3s install command is only ever PRINTED (it needs
 * sudo). The k3d / existing-cluster paths summarize what the follow-up slice will do — this slice
 * intentionally stops before mutating the host.
 */
function printGuidance(chosen: OfferId, state: HostState, options: CliOptions, io: Io): void {
  if (chosen === 'install-k3s') {
    io.info(
      [
        '',
        'Install k3s (single-node) — run this yourself (needs sudo):',
        '',
        `  ${K3S_INSTALL_COMMAND}`,
        '',
        'Then re-run `cat-factory k3s` — it will detect the new cluster and offer to wire it.',
      ].join('\n'),
    )
    return
  }

  const clusterName = options.clusterName ?? OPTION_DEFAULTS.k3sClusterName
  const summary =
    chosen === 'create-k3d'
      ? `Selected: create a local k3d cluster "${clusterName}".`
      : `Selected: reuse the existing cluster${
          state.detections.clusterContext ? ` (context: ${state.detections.clusterContext})` : ''
        }.`

  io.info(
    [
      '',
      summary,
      '',
      'Next (coming in the follow-up step): cat-factory will',
      chosen === 'create-k3d'
        ? '  - create the k3d cluster and read its apiserver URL'
        : '  - read the apiserver URL from your kubeconfig',
      '  - create a least-privilege ServiceAccount + RBAC and mint a token',
      '  - hand the values to the Settings → Infrastructure → Local k3s form to Test + Save',
      '',
      'Provisioning is not performed in this release — nothing was changed on your host.',
    ].join('\n'),
  )
}
