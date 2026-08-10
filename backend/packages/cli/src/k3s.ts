import { type CliOptions, OPTION_DEFAULTS } from './args.js'
import { buildK3sSetupUrl } from './k3s-handler.js'
import { createNodeShell, type HostShell, renderCommandLine } from './host-shell.js'
import { createConsoleIo, type Io } from './io.js'
import {
  createNodeTcpProbe,
  ingressHostTemplate,
  ingressRemedies,
  type IngressReadiness,
  ingressUrlPort,
  type TcpProbe,
} from './k3s-ingress.js'
import {
  type HostState,
  type Offer,
  type OfferId,
  probeHost,
  recreateOfferFor,
} from './k3s-probe.js'
import {
  CAT_FACTORY_NAMESPACE,
  clusterCreateCommand,
  provisionCluster,
  ProvisionError,
  resolveIngressPort,
  type ResolvedConnection,
  SERVICE_ACCOUNT_NAME,
} from './k3s-provision.js'

/** The k3s command's injectable dependencies (defaults to the real console IO + host shell). */
export interface K3sDeps {
  io?: Io
  shell?: HostShell
  /** TCP reachability seam for the ingress host-port probe. */
  tcp?: TcpProbe
  /** Host platform, injected so the k3s-install guidance is deterministic in tests. */
  platform?: NodeJS.Platform
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
  const tcp = deps.tcp ?? createNodeTcpProbe()
  const platform = deps.platform ?? process.platform

  const preferred = options.k3sRuntime ?? OPTION_DEFAULTS.k3sRuntime
  const clusterName = options.clusterName ?? OPTION_DEFAULTS.k3sClusterName

  io.info('\ncat-factory — guided local k3s / k3d setup\n')
  io.info('Probing your machine for a usable Kubernetes cluster…')

  const state = await probeHost(shell, preferred, platform, clusterName)
  io.info(renderReport(state))

  const chosen = await chooseOffer(state, options, io)

  // The k3s install needs sudo, so we only ever print the command, never provision for the user.
  if (chosen === 'install-k3s') {
    printInstallGuidance(state, io, platform, clusterName, resolveIngressPort(options))
    return { state, chosen }
  }

  let connection: ResolvedConnection
  try {
    connection = await provisionCluster(chosen, state, options, { io, shell, tcp })
  } catch (err) {
    // A declined confirm or a failed command is an expected, non-fatal outcome: report and stop.
    if (err instanceof ProvisionError) {
      io.warn(err.message)
      return { state, chosen }
    }
    throw err
  }

  printConnectionSummary(connection, io)
  printDeployRunnerGuidance(io)
  await handOff(connection, options, io)
  return { state, chosen, connection }
}

/**
 * Guide the SECOND half of a working Kubernetes test environment: the DEPLOY RUNNER. The connection
 * we just provisioned only says WHERE to deploy (the apiserver + namespace); a test environment
 * ALSO needs a runner to actually render + apply its manifests, or standing one up fails with "no
 * deploy runner wired". That runner is a local-backend env var, NOT part of the cluster connection,
 * so a user who wires only the connection hits the failure mid-run. Surface it here, now that it is
 * a one-liner: `LOCAL_DEPLOY_RUNTIME=container` works out of the box (the deploy-harness image is
 * resolved automatically to the version the backend supports, with no image ref to hunt down).
 */
function printDeployRunnerGuidance(io: Io): void {
  io.info(
    [
      '',
      'One more step, the DEPLOY RUNNER. The cluster connection above says WHERE to deploy; a test',
      'environment also needs a runner to render + apply its manifests (kubectl/kustomize/helm), or',
      'standing it up fails with "no deploy runner wired". Enable it in your local backend .env:',
      '',
      '  LOCAL_DEPLOY_RUNTIME=container',
      '',
      'That runs the deploy-harness image one container per job; the image is resolved automatically',
      '(no version to pick). Then restart the backend. Prefer your own host kubectl/kustomize/helm',
      'with no Docker? Use LOCAL_DEPLOY_RUNTIME=native and set LOCAL_DEPLOY_HARNESS_ENTRY instead.',
    ].join('\n'),
  )
}

/**
 * Hand off the resolved connection to the SPA: print the pre-filled connect-form deep-link and
 * open it (unless `--no-open` / non-interactive `--yes`). The user pastes the token — printed once
 * by {@link printConnectionSummary}, deliberately kept OUT of the URL — then runs Test → Save,
 * reusing the #557 probe + registration. A hands-free `--register` flag is a planned follow-up.
 */
async function handOff(connection: ResolvedConnection, options: CliOptions, io: Io): Promise<void> {
  const spaUrl = options.appUrl ?? OPTION_DEFAULTS.appUrl
  const verified = connection.ingress.status === 'ready'
  const link = buildK3sSetupUrl(spaUrl, connection)
  io.info(
    [
      '',
      verified
        ? 'Open the pre-filled Local k3s connect form (everything except the token is filled in):'
        : 'Open the pre-filled Local k3s connect form (the environment URL is left for you to pick, see above):',
      '',
      `  ${link}`,
    ].join('\n'),
  )
  // Skip the browser spawn for non-interactive/automation runs, or when the user opted out.
  if (options.noOpen || options.yes) return
  await io.openBrowser(link)
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

/**
 * Pick an offer: `--recreate` names one outright, `--yes` takes the recommendation, otherwise
 * prompt over the available offers.
 *
 * `--recreate` is resolved FIRST and never falls back. A destructive request that cannot be
 * honoured must refuse with the reason rather than quietly doing the nearest safe thing: an
 * operator who asked for a fresh cluster and got the old one reused would carry on believing the
 * flags they passed had taken effect. The refusal escapes to `bin.ts` (a non-zero exit) rather
 * than joining the warn-and-carry-on path a DECLINED confirm takes, because those are opposite
 * facts: one is the operator changing their mind, this one is the command unable to obey.
 *
 * The target is resolved through `recreateOfferFor`, which answers `null` for a runtime that HAS no
 * recreate. `--runtime` has three members and only two of them name a cluster this CLI can rebuild,
 * so a two-way ternary silently folded `--runtime k3s` into the k3d branch and destroyed a k3d
 * cluster the operator never named.
 */
async function chooseOffer(state: HostState, options: CliOptions, io: Io): Promise<OfferId> {
  if (options.recreate) {
    const runtime = options.k3sRuntime ?? OPTION_DEFAULTS.k3sRuntime
    const id = recreateOfferFor(runtime)
    if (id === null) {
      throw new ProvisionError(
        `Cannot recreate a "${runtime}" cluster: --recreate deletes and rebuilds a k3d or kind cluster, and k3s is a host service this command never installs or removes. Re-run with --runtime k3d or --runtime kind to target one of those.`,
      )
    }
    const offer = state.offers.find((o) => o.id === id)
    if (!offer?.available) {
      throw new ProvisionError(
        `Cannot recreate: ${offer?.reason ?? 'no such cluster'}. --recreate only ever targets a k3d/kind cluster this command can name and build again.`,
      )
    }
    return id
  }

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
 * Print the k3s install guidance. cat-factory never provisions k3s for the user, so this only ever
 * PRINTS instructions. The copy is platform-aware: k3s is Linux-only, so on Windows/macOS it steers
 * to the k3d (k3s-in-Docker) path rather than a `curl | sh` install that can't run there.
 *
 * The k3d recipe is RENDERED from the same planner the create path runs, never written out here.
 * Hand-written, it had lost the `-p` publish flag, so the one create this CLI hands to a human built
 * exactly the cluster whose missing host port the next run then asked them to recreate. A published
 * host port is create-time-only, which is what makes that omission unrecoverable rather than untidy.
 */
function printInstallGuidance(
  state: HostState,
  io: Io,
  platform: NodeJS.Platform,
  clusterName: string,
  ingressPort: number,
): void {
  // Don't tell a user who already has k3s to re-install it: point them at starting the service.
  if (state.detections.k3s.installed) {
    io.info(
      [
        '',
        'k3s is already installed. Start it (needs sudo), e.g.:',
        '',
        '  sudo systemctl start k3s   # or: sudo k3s server',
        '',
        'Then re-run `cat-factory k3s`: it will detect the running cluster and provision the handler.',
      ].join('\n'),
    )
    return
  }

  // k3s runs only on Linux; on Windows/macOS the supported route is a real k3s cluster inside
  // Docker via k3d, so point there instead of printing a Linux-only install command.
  if (platform !== 'linux') {
    const osName = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform
    const install =
      platform === 'win32'
        ? 'Install k3d (needs Docker Desktop running): https://www.catfactory.ai/deploy/kubernetes-windows.html, then:'
        : 'Install k3d (needs Docker running), e.g. `brew install k3d`, then:'
    io.info(
      [
        '',
        `k3s runs only on Linux, so it can't be installed directly on ${osName}.`,
        'Run a real k3s cluster inside Docker with k3d instead:',
        '',
        `  ${install}`,
        '',
        `  ${renderCommandLine(clusterCreateCommand('k3d', clusterName, ingressPort))}`,
        '',
        `The \`-p\` publishes host port ${ingressPort} into the cluster's ingress controller. It can only be`,
        'set when the cluster is created, so a cluster built without it can never serve an',
        'ingress-derived environment URL without being created again.',
        '',
        'Then re-run `cat-factory k3s`: it will detect the new k3d cluster and provision the handler.',
      ].join('\n'),
    )
    return
  }

  io.info(
    [
      '',
      'Install k3s (single-node). Run this yourself (needs sudo):',
      '',
      `  ${K3S_INSTALL_COMMAND}`,
      '',
      'Then re-run `cat-factory k3s`: it will detect the new cluster and provision the handler.',
    ].join('\n'),
  )
}

/**
 * The environment-URL half of the summary, rendered from the PROBE rather than from a fixed
 * script. This is the line the whole change turns on: it used to state "Ingress host template" +
 * `{{branch}}.127.0.0.1.nip.io` unconditionally, including on a reused cluster the command had
 * never looked at, and an operator who typed it got an environment whose URL answered nothing.
 *
 * Three outcomes, three different things to say, per the degrade-loudly rule: verified working,
 * verified missing (with the fix), and could-not-tell (which is NOT the same as missing, and must
 * not send someone to rebuild a cluster that was fine).
 *
 * The template itself comes from `ingressHostTemplate`, the same function the handler and deep link
 * read. Re-deriving it here (with its own hard-coded default port) is how the printed line and the
 * link it sits above could disagree about the very value the operator is told to type.
 */
function renderUrlSourceLines(connection: ResolvedConnection): string[] {
  const { ingress } = connection
  if (ingress.status === 'ready') {
    const port = ingressUrlPort(ingress)
    return [
      `  • Environment URL source:  Ingress host template`,
      `  • Host template:           ${ingressHostTemplate(ingress)}`,
      ...(port === null ? [] : [`  • Ingress port:            ${port}`]),
      `  • URL scheme:              http`,
      '',
      ...verifiedLines(ingress),
    ]
  }
  const headline =
    ingress.status === 'missing'
      ? `  This cluster CANNOT serve an ingress-derived environment URL (${describeGaps(ingress)}).`
      : `  Could NOT establish whether this cluster serves an ingress-derived environment URL: ${ingress.probeFailure}.`
  return [
    `  • Environment URL source:  leave this for now, see below`,
    '',
    headline,
    '  So the connect form is NOT pre-filled with an ingress host template: entering one would',
    '  give every test environment a URL that resolves to nothing, and the failure would surface',
    '  much later, at the tester step, long after provisioning reported success.',
    ...ingressRemedies(ingress, remedyContext(connection)).map((line) =>
      line.startsWith('  ') ? `  ${line}` : `  - ${line}`,
    ),
  ]
}

/**
 * What the probe established about a READY ingress, claimed no more strongly than it was checked.
 *
 * A TCP connect proves that something listens, not that the cluster's controller is what listens:
 * an unrelated web server on the same host port answers identically. Where the container runtime
 * confirmed the cluster publishes that port, the claim is whole; where it could not be asked, the
 * residual is stated, because an operator who then gets a 404 from the wrong server has no other
 * way to know that is even possible.
 */
function verifiedLines(ingress: Extract<IngressReadiness, { status: 'ready' }>): string[] {
  if (ingress.attribution === 'cluster') {
    return [
      `  Verified: the cluster runs the "${ingress.controller}" ingress controller and publishes host port ${ingress.port} into it.`,
    ]
  }
  return [
    `  Verified: the cluster runs the "${ingress.controller}" ingress controller, and host port ${ingress.port} answers.`,
    `  Not checked: whether the process answering on ${ingress.port} IS this cluster (that read needs a`,
    '  container runtime this could ask). If an environment URL 404s, check what else is bound there.',
  ]
}

/** The remedy context: the distribution for wording, plus a recreate command that would WORK. */
function remedyContext(connection: ResolvedConnection): {
  runtime?: 'k3d' | 'kind'
  recreateCommand?: string
} {
  const target = connection.recreateTarget
  return {
    ...((connection.runtime ?? target?.runtime)
      ? { runtime: connection.runtime ?? target?.runtime }
      : {}),
    ...(target
      ? {
          recreateCommand: `cat-factory k3s --recreate --runtime ${target.runtime} --cluster-name ${target.clusterName} --ingress-port ${connection.ingress.port}`,
        }
      : {}),
  }
}

/** Name the missing halves the way the fix splits: a controller and a published host port. */
function describeGaps(ingress: Extract<IngressReadiness, { status: 'missing' }>): string {
  const parts = ingress.gaps.map((gap) =>
    gap === 'controller'
      ? 'it runs no ingress controller'
      : ingress.publishedOn !== undefined
        ? `it publishes its ingress controller on host port ${ingress.publishedOn}, not ${ingress.port}`
        : `nothing on the host serves port ${ingress.port} for it`,
  )
  return parts.join('; ')
}

/**
 * Print the resolved connection so the user can wire it into the Settings → Infrastructure →
 * Local k3s form (Test → Save), as the fallback for anyone who does not follow the deep-link
 * {@link handOff} prints next. The apiserver token is shown ONCE here (the user's own local
 * cluster credential, to paste); it is never written to disk or a log by cat-factory.
 *
 * The values are split into what the operator TYPES and what merely explains where the token came
 * from. The ServiceAccount used to sit in the first list, which is wrong twice over: there is no
 * such field on the form (the bearer token IS the identity, so the apiserver resolves the
 * ServiceAccount from the token and nothing client-side ever names it), and someone who went
 * looking for the field could only conclude the setup was incomplete. It is still worth printing,
 * because it is the coordinate you need to mint a REPLACEMENT token later, so it is printed as
 * exactly that.
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
      ...renderUrlSourceLines(connection),
      '',
      'Then paste this ServiceAccount token into the "ServiceAccount token" field and click Test → Save:',
      '',
      `  ${connection.apiToken}`,
      '',
      'Paste it as ONE line: a token copied across a wrapped terminal line carries a hidden line',
      'break, which the connect form rejects and no cluster would ever accept.',
      '',
      `The token belongs to ServiceAccount ${CAT_FACTORY_NAMESPACE}/${SERVICE_ACCOUNT_NAME}, which the form`,
      'does not ask for (the token itself carries that identity). You need it only to mint a',
      'replacement, either by re-running `cat-factory k3s` or with:',
      '',
      `  kubectl create token ${SERVICE_ACCOUNT_NAME} -n ${CAT_FACTORY_NAMESPACE} --duration=720h`,
      '',
      'Keep the token private: it grants access to your local cluster.',
    ].join('\n'),
  )
}
