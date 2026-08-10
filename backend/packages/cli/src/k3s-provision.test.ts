import { describe, expect, it } from 'vitest'
import { type CliOptions } from './args.js'
import { COMMAND_NOT_FOUND, type HostShell, type ShellResult } from './host-shell.js'
import { type Io } from './io.js'
import { type PortState, type TcpProbe } from './k3s-ingress.js'
import { classifyHost, type HostDetections } from './k3s-probe.js'
import {
  applyRbacCommand,
  CAT_FACTORY_NAMESPACE,
  CLUSTER_CREATE_TIMEOUT_MS,
  clusterDeleteCommand,
  contextName,
  decodeToken,
  k3dCreateCommand,
  kindClusterConfig,
  kindCreateCommand,
  looksLocalCluster,
  normalizeApiServerUrl,
  parseUserNamespaces,
  portCollisionHint,
  ProvisionError,
  provisionCluster,
  RBAC_MANIFEST,
  readApiServerCommand,
  readTokenCommand,
  type ResolvedConnection,
} from './k3s-provision.js'

/** A fake shell that records every invocation and answers from a map (unmapped ⇒ not-found). */
function recordingShell(map: Record<string, Partial<ShellResult>> = {}): HostShell & {
  calls: { cmd: string; args: string[]; input?: string; timeoutMs?: number }[]
} {
  const calls: { cmd: string; args: string[]; input?: string; timeoutMs?: number }[] = []
  return {
    calls,
    run(cmd, args, o) {
      calls.push({ cmd, args, input: o?.input, timeoutMs: o?.timeoutMs })
      const hit = map[[cmd, ...args].join(' ')]
      return Promise.resolve<ShellResult>(
        hit
          ? { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' }
          : { code: COMMAND_NOT_FOUND, stdout: '', stderr: 'not found' },
      )
    },
  }
}

/** A silent Io that auto-confirms — provisioning-executor tests drive confirms via `--yes`/deps. */
function silentIo(confirmAnswer = true): Io {
  return {
    info: () => {},
    warn: () => {},
    question: (_p, d) => Promise.resolve(d ?? ''),
    select: <T extends string>(_p: string, _o: readonly { value: T }[], d: T) => Promise.resolve(d),
    secret: () => Promise.resolve(''),
    confirm: () => Promise.resolve(confirmAnswer),
    openBrowser: () => Promise.resolve(),
  }
}

function detections(over: Partial<HostDetections> = {}): HostDetections {
  return {
    kubectl: { installed: true },
    k3d: { installed: true },
    kind: { installed: true },
    k3s: { installed: false },
    docker: { installed: true, running: true },
    reachableCluster: false,
    k3dClusters: [],
    kindClusters: [],
    ...over,
  }
}

function opts(extra: Partial<CliOptions> = {}): CliOptions {
  return { command: 'k3s', noOpen: false, yes: true, force: false, ...extra }
}

/** A TCP probe with a fixed answer, so the ingress verdict is driven from the test. */
function fakeTcp(state: PortState = 'open'): TcpProbe {
  return { probe: () => Promise.resolve(state) }
}

/** The default `create-k3d` command line, now that a create also publishes the ingress port. */
const K3D_CREATE = 'k3d cluster create cat-factory --api-port 6443 -p 80:80@loadbalancer'

const TOKEN_B64 = Buffer.from('sa-token-value').toString('base64')

/** A `kubectl get ingressclass -o json` payload naming one controller. */
const TRAEFIK_CLASSES = JSON.stringify({
  items: [{ metadata: { name: 'traefik' }, spec: { controller: 'traefik.io/ingress-controller' } }],
})

/**
 * The RBAC-apply / token-read / apiserver-read commands every wiring path issues. Create paths
 * target an explicit `--context`, so the keys carry that suffix; the reuse path operates on the
 * current context (no suffix).
 */
function provisionMap(
  context?: string,
  url = 'https://127.0.0.1:6443',
): Record<string, Partial<ShellResult>> {
  const ctx = context ? ` --context ${context}` : ''
  return {
    [`kubectl apply -f -${ctx}`]: { code: 0, stdout: 'applied' },
    [`kubectl -n cat-factory get secret cat-factory-token -o jsonpath={.data.token}${ctx}`]: {
      code: 0,
      stdout: TOKEN_B64,
    },
    [`kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}${ctx}`]: {
      code: 0,
      stdout: url,
    },
    [`kubectl get ingressclass -o json --request-timeout=5s${ctx}`]: {
      code: 0,
      stdout: TRAEFIK_CLASSES,
    },
  }
}

describe('pure planners', () => {
  it('builds the k3d/kind create commands with a generous create timeout', () => {
    expect(k3dCreateCommand('c')).toEqual({
      cmd: 'k3d',
      args: ['cluster', 'create', 'c', '--api-port', '6443', '-p', '80:80@loadbalancer'],
      timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
    })
    expect(kindCreateCommand('c')).toMatchObject({
      cmd: 'kind',
      args: ['create', 'cluster', '--name', 'c', '--config', '-'],
      timeoutMs: CLUSTER_CREATE_TIMEOUT_MS,
    })
    // Far above the default 10s HostShell watchdog — image pulls take much longer.
    expect(CLUSTER_CREATE_TIMEOUT_MS).toBeGreaterThan(60_000)
    expect(contextName('k3d', 'c')).toBe('k3d-c')
    expect(contextName('kind', 'c')).toBe('kind-c')
  })

  it('publishes the ingress host port at CREATE time, the only time it can be published', () => {
    // Neither k3d's `-p` nor kind's `extraPortMappings` can be added to a running cluster, which
    // is why a create that omits them can never serve an ingress-derived URL.
    expect(k3dCreateCommand('c', 6443, 8080).args).toContain('8080:80@loadbalancer')
    const kindConfig = kindClusterConfig(8080)
    expect(kindConfig).toContain('hostPort: 8080')
    expect(kindConfig).toContain('containerPort: 80')
    // The node label every published kind ingress recipe selects on; also create-time-only.
    expect(kindConfig).toContain('ingress-ready=true')
    // The config rides stdin rather than a temp file, the way the RBAC manifest does.
    expect(kindCreateCommand('c', 8080).input).toBe(kindConfig)
  })

  it('names the port Docker actually refused, rather than assuming the apiserver port', () => {
    const hint = portCollisionHint(8080)
    expect(hint('Bind for 0.0.0.0:8080 failed: port is already allocated')).toContain(
      '--ingress-port',
    )
    // An apiserver-port collision must not be reported as an ingress-port one.
    const apiserver = hint('Bind for 0.0.0.0:6443 failed: port is already allocated')
    expect(apiserver).toContain('6443')
    expect(apiserver).not.toContain('--ingress-port')
    expect(hint('some unrelated failure')).toBe('')
  })

  it('plans the destructive delete per distribution and reads what is on the cluster', () => {
    expect(clusterDeleteCommand('k3d', 'c')).toMatchObject({
      cmd: 'k3d',
      args: ['cluster', 'delete', 'c'],
    })
    expect(clusterDeleteCommand('kind', 'c')).toMatchObject({
      cmd: 'kind',
      args: ['delete', 'cluster', '--name', 'c'],
    })
    // Only namespaces the operator's own work put there: listing `kube-system` as something
    // about to be lost would drown the one line that matters.
    expect(parseUserNamespaces('default\nkube-system\ncf-env-12\ncat-factory\n\nmy-app\n')).toEqual(
      ['cf-env-12', 'my-app'],
    )
  })

  it('feeds the RBAC manifest on stdin and never binds cluster-admin', () => {
    const apply = applyRbacCommand()
    expect(apply.args).toEqual(['apply', '-f', '-'])
    expect(apply.input).toBe(RBAC_MANIFEST)
    expect(RBAC_MANIFEST).not.toContain('cluster-admin')
    expect(RBAC_MANIFEST).toContain(`namespace: ${CAT_FACTORY_NAMESPACE}`)
  })

  it('does not grant cluster-wide list/watch on credential-bearing kinds', () => {
    // secrets + serviceaccounts share a rule with NO list/watch (the token-enumeration vector).
    expect(RBAC_MANIFEST).toContain(
      "resources: ['secrets', 'serviceaccounts']\n    verbs: ['create', 'get', 'patch', 'update', 'delete']",
    )
    // The broad read/write rule (list+watch) must not cover secrets/serviceaccounts.
    expect(RBAC_MANIFEST).not.toMatch(
      /resources: \[[^\]]*'secrets'[^\]]*\]\n\s*verbs:[^\n]*'watch'/,
    )
  })

  it('threads an explicit --context into the kubectl commands when supplied', () => {
    expect(applyRbacCommand('k3d-x').args).toEqual(['apply', '-f', '-', '--context', 'k3d-x'])
    expect(readTokenCommand('k3d-x').args.slice(-2)).toEqual(['--context', 'k3d-x'])
    expect(readApiServerCommand('k3d-x').args.slice(-2)).toEqual(['--context', 'k3d-x'])
  })

  it('reads the token + apiserver via jsonpath and decodes base64', () => {
    expect(readTokenCommand().args).toContain('jsonpath={.data.token}')
    expect(readApiServerCommand().args).toContain('jsonpath={.clusters[0].cluster.server}')
    expect(decodeToken(TOKEN_B64)).toBe('sa-token-value')
    expect(decodeToken('')).toBe('')
  })

  it('normalizes the 0.0.0.0 apiserver bind address to a dialable loopback', () => {
    expect(normalizeApiServerUrl('https://0.0.0.0:6443')).toBe('https://127.0.0.1:6443')
    expect(normalizeApiServerUrl('https://127.0.0.1:6443')).toBe('https://127.0.0.1:6443')
  })

  it('classifies local vs remote clusters for the reuse safety gate', () => {
    expect(looksLocalCluster('k3d-cat-factory', 'https://example.com:6443')).toBe(true)
    expect(looksLocalCluster('minikube', 'https://example.com:6443')).toBe(true)
    expect(looksLocalCluster('prod', 'https://127.0.0.1:6443')).toBe(true)
    expect(looksLocalCluster(undefined, 'https://host.docker.internal:6443')).toBe(true)
    expect(looksLocalCluster('prod', 'https://api.k8s.example.com:6443')).toBe(false)
  })
})

describe('provisionCluster', () => {
  const deps = (shell: HostShell, io: Io = silentIo(), tcp: TcpProbe = fakeTcp()) => ({
    shell,
    io,
    tcp,
    sleep: () => Promise.resolve(),
  })

  it('reuse-existing: applies RBAC + reads token/URL, no cluster create', async () => {
    const shell = recordingShell(provisionMap())
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-x' }))
    const conn = await provisionCluster('use-existing', state, opts(), deps(shell))
    expect(conn).toEqual<ResolvedConnection>({
      engine: 'local-k3s',
      clusterName: undefined,
      apiServerUrl: 'https://127.0.0.1:6443',
      apiToken: 'sa-token-value',
      insecureSkipTlsVerify: true,
      ingress: { status: 'ready', port: 80, controller: 'traefik.io/ingress-controller' },
    })
    expect(shell.calls.some((c) => c.cmd === 'k3d')).toBe(false)
    expect(shell.calls.some((c) => c.args.join(' ').includes('apply -f -'))).toBe(true)
    // Never mutates the global current-context.
    expect(shell.calls.some((c) => c.args.join(' ').includes('use-context'))).toBe(false)
  })

  it('create-k3d: creates the cluster (with a create timeout), targets it via --context', async () => {
    const shell = recordingShell({
      [K3D_CREATE]: { code: 0 },
      ...provisionMap('k3d-cat-factory'),
    })
    const conn = await provisionCluster(
      'create-k3d',
      classifyHost(detections()),
      opts(),
      deps(shell),
    )
    expect(conn.clusterName).toBe('cat-factory')
    expect(conn.runtime).toBe('k3d')
    const seq = shell.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
    expect(seq).toContain(K3D_CREATE)
    // No global context switch — every kubectl command carries --context instead.
    expect(seq.some((s) => s.includes('use-context'))).toBe(false)
    expect(seq).toContain('kubectl apply -f - --context k3d-cat-factory')
    // The create ran under the generous watchdog, not the 10s default.
    const createCall = shell.calls.find((c) => c.cmd === 'k3d')
    expect(createCall?.timeoutMs).toBe(CLUSTER_CREATE_TIMEOUT_MS)
  })

  it('reports the ingress as VERIFIED only when both halves answered', async () => {
    const shell = recordingShell(provisionMap())
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-x' }))
    const conn = await provisionCluster('use-existing', state, opts(), deps(shell))
    expect(conn.ingress).toEqual({
      status: 'ready',
      port: 80,
      controller: 'traefik.io/ingress-controller',
    })
    // The probe is a REAL read of the reused cluster, not an assumption about the distribution.
    expect(shell.calls.some((c) => c.args.join(' ').includes('get ingressclass -o json'))).toBe(
      true,
    )
  })

  it('reports a reused cluster with no ingress path as MISSING, naming both halves', async () => {
    // The live-box case the whole change is about: a cluster reachable enough to take the RBAC,
    // with no ingress controller and no host port into one.
    const shell = recordingShell({
      ...provisionMap(),
      'kubectl get ingressclass -o json --request-timeout=5s': {
        code: 0,
        stdout: JSON.stringify({ items: [] }),
      },
    })
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-x' }))
    const conn = await provisionCluster(
      'use-existing',
      state,
      opts(),
      deps(shell, silentIo(), fakeTcp('closed')),
    )
    expect(conn.ingress).toEqual({ status: 'missing', port: 80, gaps: ['controller', 'hostPort'] })
  })

  it('recreate-k3d: deletes then re-creates with the CURRENT flags', async () => {
    const create = 'k3d cluster create cat-factory --api-port 6443 -p 8080:80@loadbalancer'
    const shell = recordingShell({
      'k3d cluster delete cat-factory': { code: 0 },
      [create]: { code: 0 },
      'kubectl get namespaces -o jsonpath={range .items[*]}{.metadata.name}{"\\n"}{end} --request-timeout=5s --context k3d-cat-factory':
        { code: 0, stdout: 'default\ncf-env-9\n' },
      ...provisionMap('k3d-cat-factory'),
    })
    const state = classifyHost(
      detections({ k3dClusters: ['cat-factory'] }),
      'k3d',
      'linux',
      'cat-factory',
    )
    await provisionCluster('recreate-k3d', state, opts({ ingressPort: 8080 }), deps(shell))
    const seq = shell.calls.map((c) => `${c.cmd} ${c.args.join(' ')}`)
    // Delete BEFORE create, and the re-create carries the flags this run was given.
    expect(seq.indexOf('k3d cluster delete cat-factory')).toBeLessThan(seq.indexOf(create))
    // What is about to be lost is READ from the cluster, not warned about generically.
    expect(shell.calls.some((c) => c.args.includes('namespaces'))).toBe(true)
  })

  it('recreate: a create that fails AFTER the delete says the cluster is gone', async () => {
    // Deleted-but-not-recreated is worse than either end, so the error must name which state the
    // host is in rather than only relaying the create's own failure.
    const shell = recordingShell({
      'k3d cluster delete cat-factory': { code: 0 },
      'k3d cluster create cat-factory --api-port 6443 -p 80:80@loadbalancer': {
        code: 1,
        stderr: 'Bind for 0.0.0.0:80 failed: port is already allocated',
      },
    })
    const state = classifyHost(
      detections({ k3dClusters: ['cat-factory'] }),
      'k3d',
      'linux',
      'cat-factory',
    )
    await expect(provisionCluster('recreate-k3d', state, opts(), deps(shell))).rejects.toThrow(
      /was DELETED, but re-creating it failed[\s\S]*no cluster by that name/,
    )
  })

  it('recreate: refuses a cluster name the runtime does not report', async () => {
    const shell = recordingShell(provisionMap('k3d-cat-factory'))
    await expect(
      provisionCluster('recreate-k3d', classifyHost(detections()), opts(), deps(shell)),
    ).rejects.toThrow(/no k3d cluster named "cat-factory" to recreate/i)
    expect(shell.calls.some((c) => c.args.includes('delete'))).toBe(false)
  })

  it('recreate: an interactive DECLINE destroys nothing', async () => {
    const shell = recordingShell({ 'k3d cluster delete cat-factory': { code: 0 } })
    const state = classifyHost(
      detections({ k3dClusters: ['cat-factory'] }),
      'k3d',
      'linux',
      'cat-factory',
    )
    await expect(
      provisionCluster('recreate-k3d', state, opts({ yes: false }), deps(shell, silentIo(false))),
    ).rejects.toThrow(ProvisionError)
    expect(shell.calls.some((c) => c.args.includes('delete'))).toBe(false)
  })

  it('create-k3d: reuses an existing cluster (no create call)', async () => {
    const shell = recordingShell(provisionMap('k3d-cat-factory'))
    const state = classifyHost(detections({ k3dClusters: ['cat-factory'] }))
    await provisionCluster('create-k3d', state, opts(), deps(shell))
    expect(shell.calls.some((c) => c.args.includes('create'))).toBe(false)
  })

  it('surfaces a port-collision hint when the create fails on the apiserver port', async () => {
    const shell = recordingShell({
      [K3D_CREATE]: {
        code: 1,
        stderr: 'Bind for 0.0.0.0:6443 failed: port is already allocated',
      },
    })
    await expect(
      provisionCluster('create-k3d', classifyHost(detections()), opts(), deps(shell)),
    ).rejects.toThrow(/host port 6443 is already in use/)
  })

  it('retries the token read until the Secret populates', async () => {
    let n = 0
    const map = provisionMap()
    const shell: HostShell = {
      run(cmd, args) {
        const key = [cmd, ...args].join(' ')
        if (key.includes('get secret')) {
          n++
          return Promise.resolve({ code: 0, stdout: n < 3 ? '' : TOKEN_B64, stderr: '' })
        }
        const hit = map[key]
        return Promise.resolve({ code: hit?.code ?? 0, stdout: hit?.stdout ?? '', stderr: '' })
      },
    }
    const conn = await provisionCluster(
      'use-existing',
      classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-x' })),
      opts(),
      deps(shell),
    )
    expect(conn.apiToken).toBe('sa-token-value')
    expect(n).toBe(3)
  })

  it('throws ProvisionError with the stderr when a command fails', async () => {
    const shell = recordingShell({
      ...provisionMap(),
      'kubectl apply -f -': { code: 1, stderr: 'forbidden: rbac' },
    })
    await expect(
      provisionCluster(
        'use-existing',
        classifyHost(detections({ reachableCluster: true, clusterContext: 'k3d-x' })),
        opts(),
        deps(shell),
      ),
    ).rejects.toThrow(/forbidden: rbac/)
  })

  it('refuses to auto-provision a non-local cluster in --yes mode', async () => {
    const shell = recordingShell(provisionMap(undefined, 'https://api.k8s.example.com:6443'))
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'prod' }))
    await expect(
      provisionCluster('use-existing', state, opts({ yes: true }), deps(shell)),
    ).rejects.toThrow(/does not look like a local cluster/)
    // Nothing was applied before the refusal.
    expect(shell.calls.some((c) => c.args.join(' ').includes('apply -f -'))).toBe(false)
  })

  it('provisions a non-local cluster only after an explicit interactive confirm', async () => {
    const shell = recordingShell(provisionMap(undefined, 'https://api.k8s.example.com:6443'))
    const state = classifyHost(detections({ reachableCluster: true, clusterContext: 'prod' }))
    const conn = await provisionCluster(
      'use-existing',
      state,
      opts({ yes: false }),
      deps(shell, silentIo(true)),
    )
    expect(conn.apiServerUrl).toBe('https://api.k8s.example.com:6443')
    expect(shell.calls.some((c) => c.args.join(' ').includes('apply -f -'))).toBe(true)
  })

  it('throws ProvisionError when a confirm is declined (interactive)', async () => {
    const shell = recordingShell(provisionMap('k3d-cat-factory'))
    await expect(
      provisionCluster(
        'create-k3d',
        classifyHost(detections()),
        opts({ yes: false }),
        deps(shell, silentIo(false)),
      ),
    ).rejects.toThrow(ProvisionError)
    // Declined before any create command ran.
    expect(shell.calls.some((c) => c.cmd === 'k3d')).toBe(false)
  })
})
