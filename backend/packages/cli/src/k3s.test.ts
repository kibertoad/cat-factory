import { describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { type PortState, type TcpProbe } from './k3s-ingress.js'
import { K3S_INSTALL_COMMAND, setupK3s } from './k3s.js'

/**
 * A TCP probe with a fixed answer. Every `setupK3s` test supplies one: the real default opens a
 * socket, and a unit test that reaches the host's port 80 grades the developer's machine.
 */
function fakeTcp(state: PortState = 'open'): TcpProbe {
  return { probe: () => Promise.resolve(state) }
}

/** A fake shell keyed by `` `${cmd} ${args.join(' ')}` ``; unmapped ⇒ command-not-found. */
function scriptShell(map: Record<string, Partial<ShellResult>> = {}): HostShell {
  return {
    run(cmd, args) {
      const hit = map[[cmd, ...args].join(' ')]
      return Promise.resolve<ShellResult>(
        hit
          ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
          : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' },
      )
    },
  }
}

/** Scripted Io that records every info line, returns queued selects, and tracks opened URLs. */
function captureIo(selects: string[] = []): Io & { lines: string[]; opened: string[] } {
  const lines: string[] = []
  const opened: string[] = []
  const sel = [...selects]
  return {
    lines,
    opened,
    info: (m) => {
      lines.push(m)
    },
    warn: (m) => {
      lines.push(m)
    },
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) =>
      Promise.resolve((sel.shift() as T | undefined) ?? d),
    secret: () => Promise.resolve(''),
    confirm: (_p, d) => Promise.resolve(d),
    openBrowser: (url) => {
      opened.push(url)
      return Promise.resolve()
    },
  }
}

function opts(extra: Partial<CliOptions>): CliOptions {
  return { command: 'k3s', noOpen: false, yes: false, force: false, ...extra }
}

const REACHABLE = {
  'kubectl version --output=json --request-timeout=3s': {
    code: 0,
    stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
  },
  'kubectl config current-context': { code: 0, stdout: 'k3d-cat-factory' },
}

/** The provisioning commands (RBAC apply, token read, apiserver read) every wiring path issues. */
const TOKEN_B64 = Buffer.from('tok-abc').toString('base64')

/**
 * Build the provisioning-command map. Create paths carry an explicit `--context`; the reuse path
 * (default `context: undefined`) operates on the current context.
 */
function provisionMap(context?: string): Record<string, Partial<ShellResult>> {
  const ctx = context ? ` --context ${context}` : ''
  return {
    [`kubectl apply -f -${ctx}`]: { code: 0, stdout: 'applied' },
    [`kubectl -n cat-factory get secret cat-factory-token -o jsonpath={.data.token}${ctx}`]: {
      code: 0,
      stdout: TOKEN_B64,
    },
    [`kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}${ctx}`]: {
      code: 0,
      stdout: 'https://127.0.0.1:6443',
    },
    [`kubectl get ingressclass -o json --request-timeout=5s${ctx}`]: {
      code: 0,
      stdout: JSON.stringify({
        items: [{ metadata: { name: 'traefik' }, spec: { controller: 'traefik' } }],
      }),
    },
  }
}

/** The reuse-path provisioning commands (current context, no `--context` suffix). */
const PROVISION = provisionMap()

/**
 * The ingress readiness a healthy k3d/k3s cluster on the default host port reports. `unattributed`
 * because these fixtures name no cluster whose published-port table could be read: the reuse path
 * only gets a nameable cluster when the current context resolves to a DETECTED k3d/kind one.
 */
const READY_INGRESS = {
  status: 'ready',
  port: 80,
  controller: 'traefik',
  attribution: 'unattributed',
}

describe('setupK3s', () => {
  it('in --yes mode provisions the recommended offer (reuse existing cluster)', async () => {
    const io = captureIo()
    const { state, chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    expect(state.detections.reachableCluster).toBe(true)
    expect(chosen).toBe('use-existing')
    expect(connection).toEqual({
      engine: 'local-k3s',
      clusterName: undefined,
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'tok-abc',
      insecureSkipTlsVerify: true,
      ingress: READY_INGRESS,
    })
    const out = io.lines.join('\n')
    expect(out).toContain('reachable cluster')
    expect(out).toContain('https://127.0.0.1:6443')
    expect(out).toContain('tok-abc')
  })

  it('presents the ServiceAccount as token PROVENANCE, not as a field of the connect form', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    const summary = io.lines.join('\n')

    // It used to sit in the "enter these into the form" list, where there is no such field: the
    // bearer token carries the identity, so nothing client-side names the ServiceAccount. Someone
    // hunting for the field could only conclude the setup was incomplete.
    const enterList = summary.slice(
      summary.indexOf('Open Settings'),
      summary.indexOf('Then paste this ServiceAccount token'),
    )
    expect(enterList).toContain('API server URL')
    expect(enterList).not.toContain('cat-factory/cat-factory')

    // It is still printed, because it is the coordinate for minting a REPLACEMENT token.
    expect(summary).toContain('cat-factory/cat-factory')
    expect(summary).toContain('kubectl create token cat-factory -n cat-factory')
    // And the paste hazard the whole token-shape check exists for is named where it happens.
    expect(summary).toContain('Paste it as ONE line')
  })

  it('prints the k3s install command (never runs it) when nothing usable is present', async () => {
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({}),
      platform: 'linux',
    })
    expect(chosen).toBe('install-k3s')
    expect(connection).toBeUndefined()
    const out = io.lines.join('\n')
    expect(out).toContain(K3S_INSTALL_COMMAND)
    expect(out).toContain('needs sudo')
  })

  it('steers to the k3d (Docker) path on Windows instead of the Linux install command', async () => {
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({}),
      platform: 'win32',
    })
    expect(chosen).toBe('install-k3s')
    const out = io.lines.join('\n')
    expect(out).not.toContain(K3S_INSTALL_COMMAND) // curl | sh can't run on Windows
    expect(out).toContain('only on Linux')
    // The recipe the CLI hands a human is the one the CLI itself runs, `-p` and all: hand-written,
    // it had lost the publish flag and told the operator to build exactly the cluster whose missing
    // host port the next run would ask them to recreate.
    expect(out).toContain('k3d cluster create cat-factory --api-port 6443 -p 80:80@loadbalancer')
    expect(out).toContain('only be')
    // The install steps are the website's: a reader who hit this message has no checkout to
    // read a repo path from.
    expect(out).toContain('catfactory.ai/deploy/kubernetes-windows.html')
  })

  it('steers to `brew install k3d` on macOS', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({}),
      platform: 'darwin',
    })
    const out = io.lines.join('\n')
    expect(out).not.toContain(K3S_INSTALL_COMMAND)
    expect(out).toContain('brew install k3d')
    expect(out).toContain('macOS')
  })

  it('honors an interactive selection over the recommendation', async () => {
    // Reachable cluster ⇒ recommended is use-existing; user instead picks install-k3s.
    const io = captureIo(['install-k3s'])
    const { chosen } = await setupK3s(opts({}), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell(REACHABLE),
    })
    expect(chosen).toBe('install-k3s')
  })

  it('reports the findings before doing anything', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), { io, tcp: fakeTcp(), shell: scriptShell({}) })
    const out = io.lines.join('\n')
    expect(out).toContain('Detected:')
  })

  it('creates + wires a k3d cluster with the chosen name', async () => {
    const shell = scriptShell({
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      'k3d cluster create my-cluster --api-port 6443 -p 80:80@loadbalancer': { code: 0 },
      ...provisionMap('k3d-my-cluster'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true, clusterName: 'my-cluster' }), {
      io,
      tcp: fakeTcp(),
      shell,
    })
    expect(chosen).toBe('create-k3d')
    expect(connection?.clusterName).toBe('my-cluster')
    expect(connection?.apiToken).toBe('tok-abc')
    expect(io.lines.join('\n')).toContain('my-cluster')
  })

  it('honors --runtime kind and wires the kind cluster', async () => {
    const shell = scriptShell({
      'kind version': { code: 0, stdout: 'kind v0.23.0' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      'kind create cluster --name kd --config -': { code: 0 },
      ...provisionMap('kind-kd'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(
      opts({ yes: true, k3sRuntime: 'kind', clusterName: 'kd' }),
      { io, tcp: fakeTcp(), shell },
    )
    expect(chosen).toBe('create-kind')
    expect(connection?.clusterName).toBe('kd')
  })

  it('guides an already-installed k3s to start (not re-install)', async () => {
    const shell = scriptShell({ 'k3s --version': { code: 0, stdout: 'k3s version v1.30.0+k3s1' } })
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true }), { io, tcp: fakeTcp(), shell })
    expect(chosen).toBe('install-k3s')
    const out = io.lines.join('\n')
    expect(out).toContain('already installed')
    expect(out).not.toContain(K3S_INSTALL_COMMAND)
  })

  it('reuses (does not recreate) a k3d cluster whose name already exists', async () => {
    const shell = scriptShell({
      'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
      'k3d cluster list --output json': { code: 0, stdout: '[{"name":"dupe"}]' },
      'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
      // NOTE: no `k3d cluster create` mapping — reuse must not attempt to create it.
      ...provisionMap('k3d-dupe'),
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true, clusterName: 'dupe' }), {
      io,
      tcp: fakeTcp(),
      shell,
    })
    expect(chosen).toBe('create-k3d')
    expect(connection?.apiServerUrl).toBe('https://127.0.0.1:6443')
    expect(io.lines.join('\n')).toContain('Reusing the existing k3d cluster')
  })

  it('reports (does not throw) when a provisioning command fails', async () => {
    // Reachable cluster ⇒ use-existing path; the apiserver read succeeds but the RBAC apply fails.
    const shell = scriptShell({
      ...REACHABLE,
      ...PROVISION,
      'kubectl apply -f -': { code: 1, stderr: 'forbidden' },
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell,
    })
    expect(chosen).toBe('use-existing')
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('forbidden')
  })

  it('refuses to auto-provision a non-local reachable cluster in --yes mode', async () => {
    const shell = scriptShell({
      'kubectl version --output=json --request-timeout=3s': {
        code: 0,
        stdout: JSON.stringify({ serverVersion: { gitVersion: 'v1.30.0' } }),
      },
      'kubectl config current-context': { code: 0, stdout: 'prod' },
      'kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}': {
        code: 0,
        stdout: 'https://api.k8s.example.com:6443',
      },
    })
    const io = captureIo()
    const { chosen, connection } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell,
    })
    expect(chosen).toBe('use-existing')
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('does not look like a local cluster')
  })

  it('hands off with the pre-filled deep-link and opens it in an interactive run', async () => {
    // Reachable local cluster, interactive (not --yes): select falls back to the recommendation,
    // confirms default to yes, so provisioning succeeds and the hand-off opens the browser.
    const io = captureIo()
    const { connection } = await setupK3s(opts({ appUrl: 'http://localhost:4000' }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    expect(connection).toBeDefined()
    expect(io.opened).toEqual([
      'http://localhost:4000/?infraSetup=local-k3s' +
        '&label=Local+k3s&apiServerUrl=https%3A%2F%2F127.0.0.1%3A6443' +
        '&namespaceTemplate=cf-env-%7B%7BpullNumber%7D%7D' +
        '&hostTemplate=%7B%7Bbranch%7D%7D.127.0.0.1.nip.io&scheme=http&insecureSkipTlsVerify=1',
    ])
    expect(io.lines.join('\n')).toContain('pre-filled Local k3s connect form')
  })

  it('steers the user to enable the deploy runner (the WHAT, separate from the connection)', async () => {
    // A provisioned connection only says WHERE to deploy; the guided flow must also point at the
    // deploy RUNNER so the user does not hit "no deploy runner wired" mid-run. The steered path is
    // the one-line `container` mode (image resolved automatically), with native as the alternative.
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    const out = io.lines.join('\n')
    expect(out).toContain('DEPLOY RUNNER')
    expect(out).toContain('LOCAL_DEPLOY_RUNTIME=container')
    expect(out).toContain('resolved automatically')
    expect(out).toContain('LOCAL_DEPLOY_HARNESS_ENTRY')
  })

  it('prints the deep-link but does not open a browser in --yes / --no-open runs', async () => {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...PROVISION }),
    })
    expect(io.opened).toEqual([])
    expect(io.lines.join('\n')).toContain('infraSetup=local-k3s')
  })

  it('aborts a provisioning path when the user declines a confirm', async () => {
    const io: Io & { lines: string[] } = { ...captureIo(), confirm: () => Promise.resolve(false) }
    const { connection } = await setupK3s(opts({ clusterName: 'dupe' }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({
        'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
        'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
        ...PROVISION,
      }),
    })
    expect(connection).toBeUndefined()
    expect(io.lines.join('\n')).toContain('Cancelled')
  })
})

/**
 * The summary is the operator's instruction sheet, so what it says about the environment URL must
 * be what the probe established and nothing more. It used to print the ingress host template on
 * every path, including a reused cluster it had never looked at.
 */
describe('printed environment-URL guidance', () => {
  /** Run the reuse path with a scripted ingress answer and return everything printed. */
  async function summaryFor(
    ingressClasses: Partial<ShellResult>,
    portState: PortState,
  ): Promise<string> {
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(portState),
      shell: scriptShell({
        ...REACHABLE,
        ...PROVISION,
        'kubectl get ingressclass -o json --request-timeout=5s': ingressClasses,
      }),
    })
    return io.lines.join('\n')
  }

  const ONE_CLASS = {
    code: 0,
    stdout: JSON.stringify({ items: [{ spec: { controller: 'traefik' } }] }),
  }
  const NO_CLASSES = { code: 0, stdout: JSON.stringify({ items: [] }) }

  it('promises the host template only when BOTH halves were verified', async () => {
    const out = await summaryFor(ONE_CLASS, 'open')
    expect(out).toContain('Host template:           {{branch}}.127.0.0.1.nip.io')
    expect(out).toContain('Verified:')
    expect(out).toContain('host port 80 answers')
  })

  it('does not claim the answering port IS the cluster when that was not checked', async () => {
    // A TCP connect cannot tell an ingress controller from any other process on the host port, so
    // the unattributed case says so instead of asserting the stronger fact it did not establish.
    const out = await summaryFor(ONE_CLASS, 'open')
    expect(out).toContain('Not checked')
    expect(out).toContain('check what else is bound there')
  })

  it('states the gap and the fix when the cluster cannot serve one', async () => {
    const out = await summaryFor(NO_CLASSES, 'closed')
    // No template is offered, because offering one is how the unserved URL got saved.
    expect(out).not.toContain('Host template:')
    expect(out).toContain('CANNOT serve an ingress-derived environment URL')
    expect(out).toContain('it runs no ingress controller')
    expect(out).toContain('nothing on the host serves port 80')
    // And the alternative that needs no cluster change at all.
    expect(out).toContain('Service status')
  })

  it('withholds the recreate remedy on a reuse path it could not name a cluster for', async () => {
    // `--recreate` only ever targets a k3d/kind cluster this command can name, so printing it for a
    // cluster it cannot name produced a remedy the CLI itself refuses: the live case the fix is for.
    const out = await summaryFor(NO_CLASSES, 'closed')
    expect(out).not.toContain('--recreate')
    expect(out).toContain('re-create it with the tool that made it')
  })

  it('names the DETECTED cluster in the recreate remedy when the context resolves to one', async () => {
    // The current context is `k3d-cat-factory` AND k3d reports that cluster, so the CLI can both
    // name it and build it again: the remedy becomes a command that actually runs.
    const io = captureIo()
    await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp('closed'),
      shell: scriptShell({
        ...REACHABLE,
        ...PROVISION,
        'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
        'k3d cluster list --output json': { code: 0, stdout: '[{"name":"cat-factory"}]' },
        'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
        'kubectl get ingressclass -o json --request-timeout=5s': NO_CLASSES,
      }),
    })
    expect(io.lines.join('\n')).toContain(
      'cat-factory k3s --recreate --runtime k3d --cluster-name cat-factory --ingress-port 80',
    )
  })

  it('says COULD NOT TELL rather than "missing" when the read failed, and why', async () => {
    // An unreadable cluster has not established the negative either, and reporting it as missing
    // would send an operator to rebuild a cluster that was fine. The CAUSE decides the remedy: an
    // RBAC refusal and a missing binary need different things done.
    const out = await summaryFor({ code: 1, stderr: 'Error from server (Forbidden)' }, 'open')
    expect(out).toContain('Could NOT establish')
    expect(out).toContain('Forbidden')
    expect(out).toContain('allowed to list ingressclasses')
    expect(out).not.toContain('CANNOT serve')
    expect(out).not.toContain('Host template:')
  })

  it('sends a MISSING kubectl at installing it, not at waiting for the cluster', async () => {
    // The four causes used to render one message with one remedy ("re-run once the cluster has
    // settled"), which is advice for a problem an operator with no kubectl does not have.
    const out = await summaryFor({ code: 127, stderr: 'not found' }, 'open')
    expect(out).toContain('Install `kubectl`')
    expect(out).not.toContain('cluster-info')
  })
})

describe('--recreate', () => {
  const K3D_HOST = {
    'k3d version': { code: 0, stdout: 'k3d version v5.6.0' },
    'docker version --format {{.Server.Version}}': { code: 0, stdout: '27.0.0' },
    'k3d cluster list --output json': { code: 0, stdout: '[{"name":"cat-factory"}]' },
  }

  it('selects the destructive path outright, over the recommendation', async () => {
    const io = captureIo()
    const { chosen } = await setupK3s(opts({ yes: true, recreate: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({
        ...REACHABLE,
        ...K3D_HOST,
        'k3d cluster delete cat-factory': { code: 0 },
        'k3d cluster create cat-factory --api-port 6443 -p 80:80@loadbalancer': { code: 0 },
        ...provisionMap('k3d-cat-factory'),
      }),
    })
    // A reachable cluster would otherwise make `use-existing` the recommendation.
    expect(chosen).toBe('recreate-k3d')
    expect(io.lines.join('\n')).toContain('About to DESTROY')
  })

  it('is never what --yes picks on its own', async () => {
    const io = captureIo()
    const { state, chosen } = await setupK3s(opts({ yes: true }), {
      io,
      tcp: fakeTcp(),
      shell: scriptShell({ ...REACHABLE, ...K3D_HOST, ...PROVISION }),
    })
    // The offer is AVAILABLE (the named cluster exists) and still not recommended: destructive
    // intent has to be stated, never inferred from "don't prompt me".
    expect(state.offers.find((o) => o.id === 'recreate-k3d')?.available).toBe(true)
    expect(state.recommended).not.toBe('recreate-k3d')
    expect(chosen).toBe('use-existing')
  })

  it('refuses rather than falling back when there is no such cluster to recreate', async () => {
    const io = captureIo()
    await expect(
      setupK3s(opts({ yes: true, recreate: true }), {
        io,
        tcp: fakeTcp(),
        shell: scriptShell({ ...REACHABLE, ...PROVISION }),
      }),
    ).rejects.toThrow(/Cannot recreate/)
  })

  it('refuses --runtime k3s outright instead of destroying the k3d cluster', async () => {
    // `K3sRuntime` has three members and only two name a cluster this CLI can rebuild. Resolved by
    // a two-way ternary, `--runtime k3s` folded into the k3d branch and deleted a k3d cluster the
    // operator never named: an unrelated Docker cluster lost to a flag about a host service.
    const io = captureIo()
    const shell = scriptShell({
      ...REACHABLE,
      ...K3D_HOST,
      'k3d cluster delete cat-factory': { code: 0 },
      'k3d cluster create cat-factory --api-port 6443 -p 80:80@loadbalancer': { code: 0 },
      ...provisionMap('k3d-cat-factory'),
    })
    await expect(
      setupK3s(opts({ yes: true, recreate: true, k3sRuntime: 'k3s' }), {
        io,
        tcp: fakeTcp(),
        shell,
      }),
    ).rejects.toThrow(/Cannot recreate a "k3s" cluster/)
    // And nothing was destroyed on the way to the refusal.
    expect(io.lines.join('\n')).not.toContain('About to DESTROY')
  })
})
